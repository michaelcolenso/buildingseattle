"""scripts/check_freshness.py: the public /api/stats staleness check."""

import datetime as dt
import importlib.util
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("check_freshness", REPO_ROOT / "scripts" / "check_freshness.py")
freshness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(freshness)

NOW = dt.datetime(2026, 11, 27, 16, 0, tzinfo=dt.timezone.utc)


def test_fresh_stats_pass():
    ok, lines = freshness.evaluate(
        {"latest_record_date": "2026-11-25", "last_ingest_at": "2026-11-27 13:02:11"}, NOW)
    assert ok, lines
    assert all(line.startswith("ok") for line in lines)


def test_old_record_date_fails():
    ok, lines = freshness.evaluate(
        {"latest_record_date": "2026-11-20", "last_ingest_at": "2026-11-27T13:02:11.000Z"}, NOW)
    assert not ok
    assert lines[0].startswith("FAIL newest permit")


def test_old_ingest_fails():
    ok, lines = freshness.evaluate(
        {"latest_record_date": "2026-11-26", "last_ingest_at": "2026-11-25 13:00:00"}, NOW)
    assert not ok
    assert lines[1].startswith("FAIL last successful ingest")


def test_missing_fields_fail():
    ok, lines = freshness.evaluate({"permits": 10}, NOW)
    assert not ok
    assert all("missing" in line for line in lines)
    ok, _ = freshness.evaluate(None, NOW)
    assert not ok


def test_thresholds_are_configurable():
    stats = {"latest_record_date": "2026-11-21", "last_ingest_at": "2026-11-27 13:00:00"}
    assert not freshness.evaluate(stats, NOW)[0]
    assert freshness.evaluate(stats, NOW, max_record_age_days=7)[0]


def test_main_reads_api_stats_from_configured_base(monkeypatch, capsys):
    seen = []

    def fake_fetch(base_url):
        seen.append(base_url)
        return {"permits": 5, "latest_record_date": "2026-01-01", "last_ingest_at": "2026-01-01 00:00:00"}

    monkeypatch.setattr(freshness, "fetch_stats", fake_fetch)
    monkeypatch.setenv("BUILDINGSEATTLE_URL", "https://example.test")
    assert freshness.main([]) == 1
    assert seen == ["https://example.test"]
    assert "FAIL" in capsys.readouterr().out


def test_parse_timestamp_formats():
    assert freshness.parse_timestamp("2026-11-25") == dt.datetime(2026, 11, 25, tzinfo=dt.timezone.utc)
    assert freshness.parse_timestamp("2026-11-27 13:02:11").hour == 13
    assert freshness.parse_timestamp("not a date") is None
