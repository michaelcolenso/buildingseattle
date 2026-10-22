import csv
import http.server
import importlib.util
import json
import stat
import threading
from pathlib import Path

import pytest

MODULE = Path(__file__).resolve().parents[1] / "scripts" / "seo_investigation" / "url_inspection.py"
spec = importlib.util.spec_from_file_location("url_inspection", MODULE)
ui = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(ui)


def test_read_urls_text_dedupes_and_expands_paths(tmp_path):
    f = tmp_path / "u.txt"
    f.write_text("/address/a\nhttps://x.test/permit/1\n/address/a\n\n")
    assert ui.read_urls(f, base="https://x.test/") == ["https://x.test/address/a", "https://x.test/permit/1"]


def test_read_urls_csv_with_path_column(tmp_path):
    f = tmp_path / "u.csv"
    f.write_text("p,bucket,arm\n/address/a,nf404,nudge\n/address/b,nf404,natural\n")
    assert ui.read_urls(f, base="https://x.test") == ["https://x.test/address/a", "https://x.test/address/b"]


def test_read_urls_csv_with_url_column_needs_no_base(tmp_path):
    f = tmp_path / "u.csv"
    f.write_text("url,x\nhttps://x.test/a,1\n")
    assert ui.read_urls(f) == ["https://x.test/a"]


def test_read_urls_path_without_base_is_an_error(tmp_path):
    f = tmp_path / "u.txt"
    f.write_text("/address/a\n")
    with pytest.raises(SystemExit):
        ui.read_urls(f)


def test_flatten_maps_index_status_and_tolerates_missing_fields():
    body = {
        "inspectionResult": {
            "indexStatusResult": {
                "verdict": "PASS",
                "coverageState": "Submitted and indexed",
                "lastCrawlTime": "2026-10-20T01:02:03Z",
                "googleCanonical": "https://x.test/a",
                "sitemap": ["https://x.test/s1.xml", "https://x.test/s2.xml"],
            }
        }
    }
    row = ui.flatten("https://x.test/a", 200, body)
    assert row["verdict"] == "PASS"
    assert row["coverageState"] == "Submitted and indexed"
    assert row["sitemap"] == "https://x.test/s1.xml|https://x.test/s2.xml"
    assert row["userCanonical"] == ""
    assert set(row) == set(ui.FIELDS)
    empty = ui.flatten("https://x.test/b", 400, None, "bad")
    assert empty["verdict"] == "" and empty["error"] == "bad"


def test_token_file_is_private(tmp_path):
    path = tmp_path / "t.json"
    ui._write_token(path, {"refresh_token": "r"})
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert json.loads(path.read_text()) == {"refresh_token": "r"}


class _Stub:
    """Local stand-in for the inspect endpoint: scripted per-URL responses."""

    def __init__(self, script):
        self.script = script  # inspectionUrl -> list of (status, body) consumed in order
        self.calls = []
        self.auth = []
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                stub.auth.append(self.headers["Authorization"])
                assert payload["siteUrl"] == "sc-domain:x.test"
                url = payload["inspectionUrl"]
                stub.calls.append(url)
                status, body = stub.script[url].pop(0)
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/inspect"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _ok(state):
    return 200, {"inspectionResult": {"indexStatusResult": {"verdict": "PASS", "coverageState": state}}}


def _quota():
    return 429, {"error": {"code": 429, "message": "Quota exceeded", "errors": [{"reason": "rateLimitExceeded"}]}}


@pytest.fixture
def stub_env(monkeypatch):
    monkeypatch.setattr(ui.time, "sleep", lambda s: None)
    created = []

    def make(script):
        stub = _Stub(script)
        created.append(stub)
        monkeypatch.setattr(ui, "INSPECT_URL", stub.url)
        return stub

    yield make
    for stub in created:
        stub.close()


def _rows(path):
    with open(path, newline="") as fh:
        return list(csv.DictReader(fh))


def test_run_writes_rows_retries_5xx_and_records_hard_errors(tmp_path, stub_env):
    stub = stub_env({
        "https://x.test/a": [_ok("Submitted and indexed")],
        "https://x.test/b": [(503, {"error": {"message": "backend"}}), _ok("Crawled - currently not indexed")],
        "https://x.test/c": [(400, {"error": {"code": 400, "message": "not under property"}})],
    })
    out = tmp_path / "o.csv"
    counts, stopped = ui.run("sc-domain:x.test", ["https://x.test/a", "https://x.test/b", "https://x.test/c"],
                             out, lambda: "tok", limit=10, pause=0)
    rows = {r["url"]: r for r in _rows(out)}
    assert stopped == ""
    assert rows["https://x.test/a"]["coverageState"] == "Submitted and indexed"
    assert rows["https://x.test/b"]["coverageState"] == "Crawled - currently not indexed"
    assert rows["https://x.test/c"]["http_status"] == "400" and "not under property" in rows["https://x.test/c"]["error"]
    assert stub.calls.count("https://x.test/b") == 2


def test_run_stops_on_quota_keeps_results_and_resumes_without_repeating(tmp_path, stub_env):
    urls = ["https://x.test/a", "https://x.test/b", "https://x.test/c"]
    stub = stub_env({
        "https://x.test/a": [_ok("Submitted and indexed")],
        "https://x.test/b": [_quota()],
        "https://x.test/c": [],
    })
    out = tmp_path / "o.csv"
    _, stopped = ui.run("sc-domain:x.test", urls, out, lambda: "tok", limit=10, pause=0)
    assert "429" in stopped
    assert [r["url"] for r in _rows(out)] == ["https://x.test/a"]
    assert "https://x.test/c" not in stub.calls, "no calls after the quota stop"

    # next day: only the unanswered URLs are requested
    stub.script["https://x.test/b"] = [_ok("URL is unknown to Google")]
    stub.script["https://x.test/c"] = [_ok("Discovered - currently not indexed")]
    stub.calls.clear()
    _, stopped = ui.run("sc-domain:x.test", urls, out, lambda: "tok", limit=10, pause=0)
    assert stopped == ""
    assert stub.calls == ["https://x.test/b", "https://x.test/c"]
    assert [r["url"] for r in _rows(out)] == urls


def test_run_retries_urls_that_errored_last_time(tmp_path, stub_env):
    stub = stub_env({"https://x.test/a": [(400, {"error": {"message": "nope"}}), _ok("Submitted and indexed")]})
    out = tmp_path / "o.csv"
    ui.run("sc-domain:x.test", ["https://x.test/a"], out, lambda: "tok", limit=5, pause=0)
    ui.run("sc-domain:x.test", ["https://x.test/a"], out, lambda: "tok", limit=5, pause=0)
    assert stub.calls == ["https://x.test/a", "https://x.test/a"]
    assert ui.answered_urls(out) == {"https://x.test/a"}


def test_limit_caps_inspections_per_run(tmp_path, stub_env):
    stub = stub_env({f"https://x.test/{i}": [_ok("Submitted and indexed")] for i in range(5)})
    out = tmp_path / "o.csv"
    ui.run("sc-domain:x.test", [f"https://x.test/{i}" for i in range(5)], out, lambda: "tok", limit=2, pause=0)
    assert len(stub.calls) == 2


def test_read_urls_single_column_csv_header_is_not_a_url(tmp_path):
    for header in ("url", "p"):
        f = tmp_path / f"{header}.csv"
        f.write_text(f"{header}\n/address/a\nhttps://x.test/b\n")
        assert ui.read_urls(f, base="https://x.test") == ["https://x.test/address/a", "https://x.test/b"]


def test_read_urls_quoted_header_and_case(tmp_path):
    f = tmp_path / "u.csv"
    f.write_text('"URL",note\nhttps://x.test/a,"a, b"\n')
    assert ui.read_urls(f) == ["https://x.test/a"]


def test_read_urls_plain_list_starting_with_a_url_is_text(tmp_path):
    f = tmp_path / "u.txt"
    f.write_text("https://x.test/a,b\nhttps://x.test/c\n")
    assert ui.read_urls(f) == ["https://x.test/a,b", "https://x.test/c"]


@pytest.mark.parametrize(
    "code,reasons,message,expected",
    [
        (429, ["rateLimitExceeded"], "Too many requests", True),
        (402, ["dailyLimitExceeded402"], "budget", True),
        (403, ["dailyLimitExceeded"], "Daily Limit Exceeded", True),
        (403, ["rateLimitExceeded"], "Rate Limit Exceeded", True),
        (403, ["userRateLimitExceeded"], "User Rate Limit Exceeded", True),
        (403, ["quotaExceeded"], "Quota exceeded", True),
        (403, [], "Quota exceeded for quota metric", True),
        (403, ["forbidden"], "The caller does not have permission", False),
        (403, ["accessNotConfigured"], "API has not been used in project", False),
        (400, ["invalidParameter"], "not under property", False),
        (404, ["notFound"], "gone", False),
    ],
)
def test_is_quota_response(code, reasons, message, expected):
    assert ui.is_quota_response(code, reasons, message) is expected


def test_run_stops_on_documented_403_quota_reason(tmp_path, stub_env):
    stub = stub_env({
        "https://x.test/a": [_ok("Submitted and indexed")],
        "https://x.test/b": [(403, {"error": {"code": 403, "message": "Rate Limit Exceeded",
                                              "errors": [{"reason": "rateLimitExceeded"}]}})],
        "https://x.test/c": [],
    })
    out = tmp_path / "o.csv"
    _, stopped = ui.run("sc-domain:x.test", ["https://x.test/a", "https://x.test/b", "https://x.test/c"],
                        out, lambda: "tok", limit=10, pause=0)
    assert "403" in stopped
    assert "https://x.test/c" not in stub.calls


def test_run_stops_after_repeated_auth_failures(tmp_path, stub_env):
    forbidden = (403, {"error": {"code": 403, "message": "User does not have sufficient permission",
                                 "errors": [{"reason": "forbidden"}]}})
    urls = [f"https://x.test/{i}" for i in range(10)]
    stub = stub_env({u: [forbidden] for u in urls})
    out = tmp_path / "o.csv"
    _, stopped = ui.run("sc-domain:x.test", urls, out, lambda: "tok", limit=10, pause=0)
    assert "consecutive HTTP 403" in stopped
    assert len(stub.calls) == ui.MAX_AUTH_FAILURES


def test_isolated_403_does_not_stop_the_run(tmp_path, stub_env):
    forbidden = (403, {"error": {"code": 403, "message": "no", "errors": [{"reason": "forbidden"}]}})
    stub = stub_env({
        "https://x.test/a": [forbidden],
        "https://x.test/b": [_ok("Submitted and indexed")],
    })
    out = tmp_path / "o.csv"
    _, stopped = ui.run("sc-domain:x.test", ["https://x.test/a", "https://x.test/b"], out, lambda: "tok", limit=10, pause=0)
    assert stopped == ""
    assert stub.calls == ["https://x.test/a", "https://x.test/b"]


# --------------------------------------------------------------------------
# token handling (Google endpoints replaced by fakes)
# --------------------------------------------------------------------------

import time as _time
import urllib.error as _urlerr


def _client_file(tmp_path):
    f = tmp_path / "client_secret.json"
    f.write_text(json.dumps({"installed": {"client_id": "cid", "client_secret": "sec"}}))
    return f


def _saved(tmp_path, **kw):
    f = tmp_path / "tok.json"
    f.write_text(json.dumps(kw))
    return f


def test_valid_cached_token_makes_no_calls(tmp_path, monkeypatch):
    tok = _saved(tmp_path, access_token="a", refresh_token="r", expires_at=_time.time() + 3000)
    monkeypatch.setattr(ui, "_post_form", lambda *a, **k: pytest.fail("no network expected"))
    monkeypatch.setattr(ui, "interactive_login", lambda *a, **k: pytest.fail("no login expected"))
    assert ui.access_token(_client_file(tmp_path), tok) == "a"


def test_expired_token_is_refreshed_silently_and_keeps_refresh_token(tmp_path, monkeypatch):
    tok = _saved(tmp_path, access_token="old", refresh_token="r", expires_at=0)
    seen = {}

    def fake_post(url, data):
        seen.update(data)
        return {"access_token": "new", "expires_in": 3600}

    monkeypatch.setattr(ui, "_post_form", fake_post)
    monkeypatch.setattr(ui, "interactive_login", lambda *a, **k: pytest.fail("no login expected"))
    assert ui.access_token(_client_file(tmp_path), tok) == "new"
    assert seen["grant_type"] == "refresh_token" and seen["client_secret"] == "sec"
    assert json.loads(tok.read_text())["refresh_token"] == "r"


def test_revoked_refresh_token_triggers_login_and_is_not_reused(tmp_path, monkeypatch, capsys):
    tok = _saved(tmp_path, access_token="old", refresh_token="dead", expires_at=0)

    def fake_post(url, data):
        raise _urlerr.HTTPError(url, 400, "invalid_grant", {}, None)

    monkeypatch.setattr(ui, "_post_form", fake_post)
    monkeypatch.setattr(ui, "interactive_login", lambda *a, **k: {"access_token": "fresh", "expires_in": 3600})
    assert ui.access_token(_client_file(tmp_path), tok) == "fresh"
    assert json.loads(tok.read_text()).get("refresh_token") is None
    assert "signing in again" in capsys.readouterr().err


def test_google_5xx_on_refresh_is_raised_not_turned_into_a_login(tmp_path, monkeypatch):
    tok = _saved(tmp_path, access_token="old", refresh_token="r", expires_at=0)

    def fake_post(url, data):
        raise _urlerr.HTTPError(url, 503, "unavailable", {}, None)

    monkeypatch.setattr(ui, "_post_form", fake_post)
    monkeypatch.setattr(ui, "interactive_login", lambda *a, **k: pytest.fail("no login expected"))
    with pytest.raises(_urlerr.HTTPError):
        ui.access_token(_client_file(tmp_path), tok)


def test_login_without_refresh_token_warns(tmp_path, monkeypatch, capsys):
    tok = tmp_path / "tok.json"
    monkeypatch.setattr(ui, "interactive_login", lambda *a, **k: {"access_token": "fresh", "expires_in": 3600})
    assert ui.access_token(_client_file(tmp_path), tok) == "fresh"
    assert "no refresh token" in capsys.readouterr().err


def test_login_with_refresh_token_stores_it_quietly(tmp_path, monkeypatch, capsys):
    tok = tmp_path / "tok.json"
    monkeypatch.setattr(
        ui, "interactive_login", lambda *a, **k: {"access_token": "fresh", "refresh_token": "r2", "expires_in": 3600}
    )
    ui.access_token(_client_file(tmp_path), tok)
    assert json.loads(tok.read_text())["refresh_token"] == "r2"
    assert capsys.readouterr().err == ""


def test_401_refreshes_the_cached_token_once_and_retries_the_url(tmp_path, stub_env):
    unauthorized = (401, {"error": {"code": 401, "message": "Invalid Credentials", "errors": [{"reason": "authError"}]}})
    stub = stub_env({"https://x.test/a": [unauthorized, _ok("Submitted and indexed")]})
    forced = []

    def token_fn(force=False):
        forced.append(force)
        return "fresh" if force else "stale"

    out = tmp_path / "o.csv"
    _, stopped = ui.run("sc-domain:x.test", ["https://x.test/a"], out, token_fn, limit=5, pause=0)
    assert stopped == ""
    assert stub.auth == ["Bearer stale", "Bearer fresh"]
    assert forced == [False, True]
    assert _rows(out)[0]["coverageState"] == "Submitted and indexed"


def test_access_token_force_ignores_a_still_valid_cached_token(tmp_path, monkeypatch):
    tok = _saved(tmp_path, access_token="cached", refresh_token="r", expires_at=_time.time() + 3000)
    monkeypatch.setattr(ui, "_post_form", lambda url, data: {"access_token": "renewed", "expires_in": 3600})
    monkeypatch.setattr(ui, "interactive_login", lambda *a, **k: pytest.fail("no login expected"))
    assert ui.access_token(_client_file(tmp_path), tok) == "cached"
    assert ui.access_token(_client_file(tmp_path), tok, force=True) == "renewed"


def test_run_writes_the_header_into_an_empty_preexisting_output_file(tmp_path, stub_env):
    stub_env({"https://x.test/a": [_ok("Submitted and indexed")]})
    out = tmp_path / "o.csv"
    out.write_text("")
    ui.run("sc-domain:x.test", ["https://x.test/a"], out, lambda force=False: "tok", limit=5, pause=0)
    assert [r["url"] for r in _rows(out)] == ["https://x.test/a"]
    assert ui.answered_urls(out) == {"https://x.test/a"}


@pytest.mark.parametrize("flags", [["--limit", "-1"], ["--limit", "0"], ["--limit", "2001"], ["--pause", "-0.5"]])
def test_main_rejects_out_of_range_limits_before_any_sign_in(flags, monkeypatch):
    monkeypatch.setattr(ui, "access_token", lambda *a, **k: pytest.fail("must not sign in"))
    with pytest.raises(SystemExit):
        ui.main(["--site", "sc-domain:x.test", "--urls", "unused.txt", *flags])


def test_run_with_a_negative_limit_inspects_nothing(tmp_path, stub_env):
    stub = stub_env({"https://x.test/a": [_ok("Submitted and indexed")], "https://x.test/b": [_ok("Submitted and indexed")]})
    ui.run("sc-domain:x.test", ["https://x.test/a", "https://x.test/b"], tmp_path / "o.csv", lambda force=False: "tok", limit=-1, pause=0)
    assert stub.calls == []


def test_input_problems_fail_before_any_sign_in(tmp_path, monkeypatch):
    monkeypatch.setattr(ui, "access_token", lambda *a, **k: pytest.fail("must not sign in"))
    base = ["--site", "sc-domain:x.test"]
    empty = tmp_path / "empty.txt"
    empty.write_text("\n")
    paths = tmp_path / "paths.txt"
    paths.write_text("/address/a\n")
    for argv in (
        base,                                                  # no --urls
        base + ["--urls", str(tmp_path / "missing.txt")],      # unreadable file
        base + ["--urls", str(empty)],                         # no URLs in it
        base + ["--urls", str(paths)],                         # paths without --base
    ):
        with pytest.raises(SystemExit):
            ui.main(argv)


def test_auth_only_does_not_need_urls(tmp_path, monkeypatch):
    called = []
    monkeypatch.setattr(ui, "access_token", lambda *a, **k: called.append(1) or "tok")
    assert ui.main(["--site", "sc-domain:x.test", "--auth-only"]) == 0
    assert called == [1]
