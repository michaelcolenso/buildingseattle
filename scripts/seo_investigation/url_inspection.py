#!/usr/bin/env python3
"""Search Console URL Inspection API runner (stdlib only, runs on your machine).

Gets Google's own per-URL index verdict, which the bulk export and the Coverage
exports do not give: indexed or not, Google's chosen canonical, last crawl time,
page-fetch state. Needed for the day-28 readout of the recrawl test in
docs/index-selection-investigation-2026-10-22.md (section 6).

One-time setup
  1. Google Cloud project -> enable "Google Search Console API".
  2. APIs & Services -> Credentials -> OAuth client ID, type Desktop app
     (Google Auth Platform -> Clients). Download its JSON.
  3. Save that JSON as .seo_data/client_secret.json (gitignored). It holds the client
     secret: do not paste it into chat, a ticket, or a commit.
  4. The Google account you sign in with must be an owner or full user of the
     Search Console property named in --site.

Usage
  python3 scripts/seo_investigation/url_inspection.py --site sc-domain:buildingseattle.com \\
      --urls cohort.csv --base https://buildingseattle.com

  --urls takes a text file (one URL or path per line) or a CSV with a `url` or `p`
  (path) column. Results are appended to --out (default .seo_data/url_inspection.csv);
  a re-run skips URLs already answered, so a long list can be spread over several days.

Limits (Google): 2,000 inspections per site per day, 600 per minute. The default
--limit of 1900 and 0.25 s pacing stay under both. The script stops, and keeps what
it has, on a quota response (HTTP 402/429, or 403 with a documented quota or rate-limit
reason) and after 5 consecutive 401/403 responses (setup problem: API not enabled, or
the account lacks access to --site).

The first run opens a browser for consent (read-only scope) and stores a refresh token
in .seo_data/gsc_token.json (mode 600). Nothing is sent anywhere except Google.
"""

import argparse
import base64
import csv
import hashlib
import http.server
import json
import os
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
MAX_AUTH_FAILURES = 5

DATA_DIR = Path(".seo_data")
DEFAULT_CLIENT = DATA_DIR / "client_secret.json"
DEFAULT_TOKEN = DATA_DIR / "gsc_token.json"
DEFAULT_OUT = DATA_DIR / "url_inspection.csv"

FIELDS = [
    "url", "inspected_at", "http_status", "verdict", "coverageState", "indexingState",
    "robotsTxtState", "pageFetchState", "lastCrawlTime", "googleCanonical", "userCanonical",
    "crawledAs", "sitemap", "error",
]


# --------------------------------------------------------------------------
# input / output
# --------------------------------------------------------------------------

def read_urls(path, base=None):
    """URLs from a text file or a CSV with a `url` or `p` column; order kept, duplicates dropped."""
    text = Path(path).read_text(encoding="utf-8-sig")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    values = []
    # A CSV is recognised by its header naming a `url` or `p` column, which also
    # covers a one-column file; a bare URL or path is never called "url" or "p".
    header = next(csv.reader(lines[:1]), []) if lines else []
    if {c.strip().lower() for c in header} & {"url", "p"}:
        for row in csv.DictReader(lines):
            row = {(k or "").strip().lower(): v for k, v in row.items()}
            values.append((row.get("url") or row.get("p") or "").strip())
    else:
        values = [ln.strip() for ln in lines]
    seen, urls = set(), []
    for value in values:
        if not value:
            continue
        if value.startswith("/"):
            if not base:
                raise SystemExit(f"{value!r} is a path; pass --base https://your-host")
            value = base.rstrip("/") + value
        if value not in seen:
            seen.add(value)
            urls.append(value)
    return urls


def answered_urls(out_path):
    """URLs already in the output file with a real answer (errors are retried)."""
    done = set()
    if Path(out_path).exists():
        with open(out_path, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                if row.get("http_status") == "200" and row.get("url"):
                    done.add(row["url"])
    return done


def flatten(url, status, body, error=""):
    """One output row from an API response body."""
    index = ((body or {}).get("inspectionResult") or {}).get("indexStatusResult") or {}
    return {
        "url": url,
        "inspected_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "http_status": status,
        "verdict": index.get("verdict", ""),
        "coverageState": index.get("coverageState", ""),
        "indexingState": index.get("indexingState", ""),
        "robotsTxtState": index.get("robotsTxtState", ""),
        "pageFetchState": index.get("pageFetchState", ""),
        "lastCrawlTime": index.get("lastCrawlTime", ""),
        "googleCanonical": index.get("googleCanonical", ""),
        "userCanonical": index.get("userCanonical", ""),
        "crawledAs": index.get("crawledAs", ""),
        "sitemap": "|".join(index.get("sitemap", []) or []),
        "error": error,
    }


# --------------------------------------------------------------------------
# OAuth (installed-app loopback flow with PKCE)
# --------------------------------------------------------------------------

def load_client(path):
    cfg = json.loads(Path(path).read_text())
    block = cfg.get("installed") or cfg.get("web") or cfg
    if not block.get("client_id"):
        raise SystemExit(f"{path}: no client_id found; download the Desktop app OAuth client JSON")
    return block["client_id"], block.get("client_secret")


def _post_form(url, data):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(), method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _write_token(path, token):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(token, fh)
    os.chmod(path, 0o600)


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def interactive_login(client_id, client_secret):
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    port = _free_port()
    redirect = f"http://127.0.0.1:{port}"
    got = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            got.update({k: v[0] for k, v in q.items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"Authorized. You can close this tab and return to the terminal.")

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.handle_request, daemon=True).start()
    url = AUTH_URL + "?" + urllib.parse.urlencode({
        "response_type": "code", "client_id": client_id, "redirect_uri": redirect, "scope": SCOPE,
        "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
    })
    print("Opening a browser for Google sign-in. If nothing opens, visit:\n" + url, file=sys.stderr)
    webbrowser.open(url)
    deadline = time.time() + 300
    while not got and time.time() < deadline:
        time.sleep(0.2)
    server.server_close()
    if got.get("state") != state or "code" not in got:
        raise SystemExit(f"Authorization failed or timed out: {got.get('error', 'no code returned')}")
    data = {
        "grant_type": "authorization_code", "code": got["code"], "code_verifier": verifier,
        "redirect_uri": redirect, "client_id": client_id,
    }
    if client_secret:
        data["client_secret"] = client_secret
    return _post_form(TOKEN_URL, data)


def access_token(client_path, token_path, force=False):
    """A valid access token, refreshing or running the browser login as needed.

    force=True ignores the cached access token (Google can invalidate one before its expiry)."""
    client_id, client_secret = load_client(client_path)
    saved = json.loads(Path(token_path).read_text()) if Path(token_path).exists() else {}
    if not force and saved.get("access_token") and saved.get("expires_at", 0) > time.time() + 60:
        return saved["access_token"]
    if saved.get("refresh_token"):
        data = {"grant_type": "refresh_token", "refresh_token": saved["refresh_token"], "client_id": client_id}
        if client_secret:
            data["client_secret"] = client_secret
        try:
            fresh = _post_form(TOKEN_URL, data)
            saved.update(access_token=fresh["access_token"], expires_at=time.time() + int(fresh.get("expires_in", 3600)))
            _write_token(token_path, saved)
            return saved["access_token"]
        except urllib.error.HTTPError as exc:
            if exc.code not in (400, 401):
                raise  # Google-side hiccup: do not throw away a working login
            print("Saved login no longer works; signing in again.", file=sys.stderr)
            saved = {}  # the revoked refresh token must not be carried into the new login
    fresh = interactive_login(client_id, client_secret)
    saved = {
        "access_token": fresh["access_token"],
        "refresh_token": fresh.get("refresh_token") or saved.get("refresh_token"),
        "expires_at": time.time() + int(fresh.get("expires_in", 3600)),
    }
    _write_token(token_path, saved)
    if not saved["refresh_token"]:
        # Google documents that installed apps always get one, so this is unexpected; the run
        # still works, but a browser sign-in will be needed again once this token expires.
        print("Warning: Google returned no refresh token; you will be asked to sign in again in about an hour.",
              file=sys.stderr)
    return saved["access_token"]


# --------------------------------------------------------------------------
# inspection
# --------------------------------------------------------------------------

class QuotaStop(Exception):
    pass


# Reason strings Google documents for quota / rate-limit responses
# (https://developers.google.com/webmaster-tools/v1/errors), lower-cased.
QUOTA_REASONS = {
    "dailylimitexceeded", "dailylimitexceeded402", "dailylimitexceededunreg", "quotaexceeded",
    "quotaexceeded402", "ratelimitexceeded", "ratelimitexceededunreg", "userratelimitexceeded",
    "userratelimitexceededunreg", "limitexceeded", "servinglimitexceeded", "concurrentlimitexceeded",
    "variabletermlimitexceeded", "variabletermexpireddailyexceeded",
}


def is_quota_response(code, reasons, message):
    """True when the API is refusing for quota/rate reasons, so continuing only wastes calls."""
    if code in (402, 429):
        return True
    named = {str(r).lower() for r in reasons}
    return code == 403 and (bool(named & QUOTA_REASONS) or "rate limit" in message.lower() or "quota" in message.lower())


def inspect_one(token, site, url, retries=3):
    """(http_status, body, error). Raises QuotaStop on a quota response."""
    payload = json.dumps({"inspectionUrl": url, "siteUrl": site, "languageCode": "en-US"}).encode()
    for attempt in range(retries + 1):
        req = urllib.request.Request(
            INSPECT_URL, data=payload, method="POST",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status, json.loads(resp.read()), ""
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                err = json.loads(raw).get("error", {})
            except ValueError:
                err = {}
            message = err.get("message") or raw[:200]
            reasons = [e.get("reason", "") for e in err.get("errors", []) if isinstance(e, dict)]
            if is_quota_response(exc.code, reasons, message):
                raise QuotaStop(f"HTTP {exc.code}: {message}")
            if exc.code >= 500 and attempt < retries:
                time.sleep(2 ** (attempt + 1))
                continue
            return exc.code, None, message
        except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
            if attempt < retries:
                time.sleep(2 ** (attempt + 1))
                continue
            return 0, None, f"network error: {exc}"
    return 0, None, "unreachable"


def run(site, urls, out_path, token_fn, limit, pause):
    done = answered_urls(out_path)
    todo = [u for u in urls if u not in done][:max(0, limit)]  # a negative slice would drop from the end
    print(f"{len(urls)} urls, {len(done)} already answered, inspecting {len(todo)} (limit {limit})", file=sys.stderr)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    new_file = not Path(out_path).exists() or Path(out_path).stat().st_size == 0
    counts, stopped, auth_failures = {}, "", 0
    with open(out_path, "a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        if new_file:
            writer.writeheader()
        for i, url in enumerate(todo, 1):
            try:
                status, body, error = inspect_one(token_fn(), site, url)
                if status == 401:
                    # the cached access token may have been invalidated before its recorded
                    # expiry: refresh it once and retry this URL before counting a failure
                    status, body, error = inspect_one(token_fn(force=True), site, url)
            except QuotaStop as exc:
                stopped = str(exc)
                break
            row = flatten(url, status, body, error)
            writer.writerow(row)
            fh.flush()
            # 401/403 on every URL means setup (API not enabled, account lacks access to
            # --site), not a per-URL problem: stop instead of writing hundreds of error rows.
            auth_failures = auth_failures + 1 if status in (401, 403) else 0
            if auth_failures >= MAX_AUTH_FAILURES:
                stopped = f"{auth_failures} consecutive HTTP {status} responses ({error}); check API enablement and property access"
                break
            key = row["coverageState"] or row["error"][:60] or f"HTTP {status}"
            counts[key] = counts.get(key, 0) + 1
            if i % 50 == 0:
                print(f"  {i}/{len(todo)}", file=sys.stderr)
            time.sleep(pause)
    return counts, stopped


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--site", required=True, help="property as in Search Console: sc-domain:example.com or https://example.com/")
    ap.add_argument("--urls", help="text/CSV file of URLs or paths (see module docstring)")
    ap.add_argument("--base", help="origin used to expand paths, e.g. https://buildingseattle.com")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--limit", type=int, default=1900, help="max inspections this run (daily quota is 2000)")
    ap.add_argument("--pause", type=float, default=0.25, help="seconds between calls (quota is 600/min)")
    ap.add_argument("--client", default=str(DEFAULT_CLIENT))
    ap.add_argument("--token", default=str(DEFAULT_TOKEN))
    ap.add_argument("--auth-only", action="store_true", help="sign in, store the token, and exit")
    args = ap.parse_args(argv)

    if not 1 <= args.limit <= 2000:
        raise SystemExit("--limit must be between 1 and 2000 (the per-site daily quota)")
    if args.pause < 0:
        raise SystemExit("--pause cannot be negative")
    token_fn = lambda force=False: access_token(args.client, args.token, force)  # re-checked per call: tokens last ~1 hour
    token_fn()
    if args.auth_only:
        print("Signed in; token stored.", file=sys.stderr)
        return 0
    if not args.urls:
        raise SystemExit("--urls is required unless --auth-only")
    counts, stopped = run(args.site, read_urls(args.urls, args.base), args.out, token_fn, args.limit, args.pause)
    print("\nBy coverageState / error:", file=sys.stderr)
    for key, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {n:5d}  {key}", file=sys.stderr)
    if stopped:
        print(f"\nStopped: {stopped}. Answered URLs are skipped on the next run.", file=sys.stderr)
    print(f"Results: {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
