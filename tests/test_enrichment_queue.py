"""The daily enrichment queue SQL (scripts/enrichment_queue.py) on real SQLite."""

import importlib.util
import sqlite3
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("enrichment_queue", REPO_ROOT / "scripts" / "enrichment_queue.py")
queue = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queue)


@pytest.fixture
def db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript((REPO_ROOT / "schema.sql").read_text())
    conn.execute("DELETE FROM permits")
    conn.execute("DELETE FROM permit_status_changes")
    yield conn
    conn.close()


def add_permit(db, number, status="active", parcel=None, enriched_days_ago=None, issued="2026-11-01"):
    enriched = None
    if enriched_days_ago is not None:
        enriched = db.execute("SELECT datetime('now', ?)", (f"-{enriched_days_ago} days",)).fetchone()[0]
    db.execute(
        "INSERT INTO permits (permit_number, address, status, parcel_number, last_enriched_at, issued_date) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (number, f"{number} MAIN ST", status, parcel, enriched, issued),
    )


def add_status_change(db, number, days_ago):
    db.execute(
        "INSERT INTO permit_status_changes (permit_number, previous_status, new_status, changed_at) "
        "VALUES (?, 'active', 'completed', datetime('now', ?))",
        (number, f"-{days_ago} days"),
    )


def rows(db, sql):
    return [dict(row) for row in db.execute(sql)]


def test_new_queue_takes_never_enriched_first_and_retries_misses_weekly(db):
    add_permit(db, "NEW-OLD", issued="2026-01-01")
    add_permit(db, "NEW-RECENT", issued="2026-11-20")
    add_permit(db, "MISS-YESTERDAY", enriched_days_ago=1)  # probed, no parcel: wait
    add_permit(db, "MISS-LAST-MONTH", enriched_days_ago=30)  # due for a retry
    add_permit(db, "DONE", parcel="DV1", enriched_days_ago=1)
    got = [r["permit_number"] for r in rows(db, queue.new_permits_sql(10))]
    assert got == ["NEW-RECENT", "NEW-OLD", "MISS-LAST-MONTH"]
    assert [r["permit_number"] for r in rows(db, queue.new_permits_sql(1))] == ["NEW-RECENT"]


def test_stale_queue_prefers_status_changes_then_oldest_open(db):
    add_permit(db, "OPEN-FRESH", parcel="DV1", enriched_days_ago=5)
    add_permit(db, "OPEN-60", parcel="DV2", enriched_days_ago=60)
    add_permit(db, "OPEN-90", parcel="DV3", enriched_days_ago=90)
    add_permit(db, "CLOSED-90", status="completed", parcel="DV4", enriched_days_ago=90)
    add_permit(db, "CHANGED", status="completed", parcel="DV5", enriched_days_ago=3)
    add_status_change(db, "CHANGED", days_ago=1)  # after its last enrichment
    add_permit(db, "CHANGED-BEFORE", parcel="DV6", enriched_days_ago=3)
    add_status_change(db, "CHANGED-BEFORE", days_ago=10)  # already re-enriched since
    add_permit(db, "NO-PARCEL", enriched_days_ago=90)  # belongs to the new queue

    got = rows(db, queue.stale_permits_sql(10, 30))
    assert [r["permit_number"] for r in got] == ["CHANGED", "OPEN-90", "OPEN-60"]
    assert [r["status_changed"] for r in got] == [1, 0, 0]
    # Bounded per run.
    assert [r["permit_number"] for r in rows(db, queue.stale_permits_sql(2, 30))] == ["CHANGED", "OPEN-90"]
    assert rows(db, queue.stale_permits_sql(0, 30)) == []


def test_merge_targets_dedupes_in_order():
    merged = queue.merge_targets(
        [{"permit_number": "A"}, {"permit_number": "B"}, {"permit_number": None}],
        [{"permit_number": "B", "status_changed": 1}, {"permit_number": "C"}],
    )
    assert merged == ["A", "B", "C"]


def test_queue_sql_rejects_negative_bounds():
    with pytest.raises(ValueError):
        queue.new_permits_sql(-1)
    with pytest.raises(ValueError):
        queue.stale_permits_sql(10, -5)


def test_enrich_script_uses_queue_and_apex_default():
    source = (REPO_ROOT / "scripts" / "enrich_unenriched.py").read_text()
    assert ".workers.dev\"" not in source and "aged-morning" not in source
    assert 'DEFAULT_WORKER_URL = "https://buildingseattle.com"' in source
    assert "stale_permits_sql" in source and "new_permits_sql" in source
