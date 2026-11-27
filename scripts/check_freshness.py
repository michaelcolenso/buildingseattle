#!/usr/bin/env python3
"""Fail when production permit data has gone stale (stdlib only).

Reads the public, read-only /api/stats endpoint and exits 1 when either

  latest_record_date  newest issued/applied date in the permits table, or
  last_ingest_at      end time of the last successful permit ingest

is older than its threshold, or missing, or when

  last_feed_status    status of the latest scheduled base-feed run

is 'degraded': the Worker saw a full-dataset-replace pattern on the SDCI feed
and fell back to newest-first reads (permits outside the newest pages then
refresh only in the weekly sweep). Set FRESHNESS_ALLOW_DEGRADED=1 to report it
without failing once you have confirmed SDCI publishes by full replace. Run
daily by .github/workflows/data-freshness.yml, which opens an issue on failure.

Environment (all optional):
  BUILDINGSEATTLE_URL             site base URL (default https://buildingseattle.com)
  FRESHNESS_MAX_RECORD_AGE_DAYS   default 4 (permits are filed on weekdays,
                                  so a 3-day weekend alone reaches 3 days)
  FRESHNESS_MAX_INGEST_AGE_HOURS  default 36 (the Worker cron runs daily)

Note: /api/stats `last_ingest_at` counts any successful non-graph,
non-development-site ingest, including `permit_enrichment` runs, so it can
hide a dead base-feed cron for a while; the record-date check catches that.
"""

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "https://buildingseattle.com"
DEFAULT_MAX_RECORD_AGE_DAYS = 4
DEFAULT_MAX_INGEST_AGE_HOURS = 36
USER_AGENT = "buildingseattle-freshness/1.0 (+https://buildingseattle.com)"


def parse_timestamp(value):
    """Parse a D1/ISO date or timestamp to an aware UTC datetime, or None."""
    if not value or not isinstance(value, str):
        return None
    text = value.strip().replace("Z", "+00:00")
    if len(text) == 10:
        text += "T00:00:00+00:00"
    text = text.replace(" ", "T", 1)
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)  # D1 CURRENT_TIMESTAMP is UTC
    return parsed.astimezone(dt.timezone.utc)


def evaluate(stats, now, max_record_age_days=DEFAULT_MAX_RECORD_AGE_DAYS,
             max_ingest_age_hours=DEFAULT_MAX_INGEST_AGE_HOURS, allow_degraded=False):
    """Return (ok, lines) for a /api/stats payload at time `now`."""
    lines, ok = [], True
    checks = (
        ("latest_record_date", dt.timedelta(days=max_record_age_days),
         f"{max_record_age_days} days", "newest permit issued/applied date"),
        ("last_ingest_at", dt.timedelta(hours=max_ingest_age_hours),
         f"{max_ingest_age_hours} hours", "last successful ingest"),
    )
    for field, limit, limit_label, label in checks:
        raw = stats.get(field) if isinstance(stats, dict) else None
        when = parse_timestamp(raw)
        if when is None:
            ok = False
            lines.append(f"FAIL {label}: /api/stats {field} is missing or unparseable ({raw!r})")
            continue
        age = now - when
        hours = age.total_seconds() / 3600
        status = "ok  " if age <= limit else "FAIL"
        if age > limit:
            ok = False
        lines.append(f"{status} {label}: {raw} ({hours:.1f} h old, limit {limit_label})")
    feed_status = stats.get("last_feed_status") if isinstance(stats, dict) else None
    if feed_status == "degraded":
        if allow_degraded:
            lines.append("warn base-feed run: degraded (full-replace pattern; FRESHNESS_ALLOW_DEGRADED=1)")
        else:
            ok = False
            lines.append("FAIL base-feed run: degraded (the SDCI feed looks fully replaced; see ingest_logs.error_message)")
    return ok, lines


def fetch_stats(base_url):
    req = urllib.request.Request(f"{base_url.rstrip('/')}/api/stats",
                                 headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def env_number(name, default, cast):
    raw = (os.environ.get(name) or "").strip()
    return cast(raw) if raw else default


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base-url", default=os.environ.get("BUILDINGSEATTLE_URL") or DEFAULT_BASE_URL)
    parser.add_argument("--max-record-age-days", type=float,
                        default=env_number("FRESHNESS_MAX_RECORD_AGE_DAYS", DEFAULT_MAX_RECORD_AGE_DAYS, float))
    parser.add_argument("--max-ingest-age-hours", type=float,
                        default=env_number("FRESHNESS_MAX_INGEST_AGE_HOURS", DEFAULT_MAX_INGEST_AGE_HOURS, float))
    parser.add_argument("--allow-degraded", action="store_true",
                        default=(os.environ.get("FRESHNESS_ALLOW_DEGRADED") or "").strip() == "1")
    args = parser.parse_args(argv)

    try:
        stats = fetch_stats(args.base_url)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"FAIL could not read {args.base_url}/api/stats: {exc}")
        return 1
    ok, lines = evaluate(stats, dt.datetime.now(dt.timezone.utc),
                         args.max_record_age_days, args.max_ingest_age_hours, args.allow_degraded)
    print(f"Data freshness for {args.base_url} (permits: {stats.get('permits', '?')})")
    for line in lines:
        print(line)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
