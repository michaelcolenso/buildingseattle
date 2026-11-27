"""Which permits the daily enrichment job should probe (stdlib only).

Two queues, both read from production D1 by scripts/enrich_unenriched.py:

1. New: permits with no parcel number that were never enriched, or whose
   last probe found no parcel more than `miss_retry_days` ago. A permanent
   miss is retried on that cadence instead of every day.
2. Stale: enriched permits whose SDCI detail fields (record_status_detail,
   expires_date, inspection flags) have probably moved: the base status
   changed after the last enrichment, or the permit is still open and was
   last enriched more than `stale_days` ago. Bounded by `stale_limit` per
   run and rotated oldest-first, so every open permit is revisited in turn.

The SQL is plain SQLite, so tests run it against an in-memory database.
"""

# Base-feed statuses whose SDCI detail is not expected to change any more.
# Lower-cased; includes spellings the status mapping may produce.
CLOSED_STATUSES = ("completed", "expired", "canceled", "cancelled", "withdrawn", "closed")

DEFAULT_STALE_DAYS = 30
DEFAULT_STALE_LIMIT = 100
DEFAULT_MISS_RETRY_DAYS = 7


def _positive_int(value, name):
    number = int(value)
    if number < 0:
        raise ValueError(f"{name} must be >= 0")
    return number


def new_permits_sql(limit, miss_retry_days=DEFAULT_MISS_RETRY_DAYS):
    """Never-enriched permits first, then old misses, newest issued first."""
    limit = _positive_int(limit, "limit")
    days = _positive_int(miss_retry_days, "miss_retry_days")
    return (
        "SELECT permit_number FROM permits "
        "WHERE permit_number IS NOT NULL AND parcel_number IS NULL "
        f"AND (last_enriched_at IS NULL OR last_enriched_at < datetime('now', '-{days} days')) "
        "ORDER BY (last_enriched_at IS NULL) DESC, issued_date DESC NULLS LAST, permit_number "
        f"LIMIT {limit}"
    )


def stale_permits_sql(stale_limit=DEFAULT_STALE_LIMIT, stale_days=DEFAULT_STALE_DAYS):
    """Enriched permits due for a re-probe; status changes first, then oldest."""
    limit = _positive_int(stale_limit, "stale_limit")
    days = _positive_int(stale_days, "stale_days")
    closed = ", ".join(f"'{status}'" for status in CLOSED_STATUSES)
    changed = (
        "EXISTS (SELECT 1 FROM permit_status_changes sc "
        "WHERE sc.permit_number = p.permit_number AND sc.changed_at > p.last_enriched_at)"
    )
    return (
        f"SELECT p.permit_number, CASE WHEN {changed} THEN 1 ELSE 0 END AS status_changed "
        "FROM permits p "
        "WHERE p.permit_number IS NOT NULL AND p.parcel_number IS NOT NULL "
        "AND p.last_enriched_at IS NOT NULL "
        f"AND ({changed} OR (lower(COALESCE(p.status, '')) NOT IN ({closed}) "
        f"AND p.last_enriched_at < datetime('now', '-{days} days'))) "
        "ORDER BY status_changed DESC, p.last_enriched_at ASC, p.permit_number "
        f"LIMIT {limit}"
    )


def merge_targets(new_rows, stale_rows):
    """Ordered, de-duplicated permit numbers: new first, then stale."""
    targets, seen = [], set()
    for row in list(new_rows) + list(stale_rows):
        permit_number = row.get("permit_number")
        if permit_number and permit_number not in seen:
            seen.add(permit_number)
            targets.append(permit_number)
    return targets
