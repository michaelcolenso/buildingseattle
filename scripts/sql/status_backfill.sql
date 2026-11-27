-- Recompute permits.status from permits.status_raw with the map in
-- data/sdci_mappings.json (audit C2). Generated from sdci_mappings.js
-- statusFromRawSql(); tests/sdci_mappings.test.js fails if it drifts from the map.
--
-- Production today has NO raw status stored (status_raw is new in
-- 0003_permit_feed_fields.sql), so on day one this updates nothing.
-- The first full sweep (starts on the first scheduled run after deploy, then
-- weekly) re-reads every permit in the coverage window, stores status_raw and
-- writes the exact-match status; the scheduled ingest suppresses alert emails
-- for rows whose status changed only because the mapping changed.
-- Run this file after a future edit of status_map, once status_raw is filled:
--   npx wrangler d1 execute buildingseattle --remote --file scripts/sql/status_backfill.sql
-- It writes no permit_status_changes rows (a remap is not a status change).
UPDATE permits
SET status = CASE lower(trim(status_raw))
    WHEN '' THEN 'new'
    WHEN 'initiated' THEN 'new'
    WHEN 'ready for intake' THEN 'new'
    WHEN 'application completed' THEN 'pending'
    WHEN 'reviews in process' THEN 'pending'
    WHEN 'reviews completed' THEN 'pending'
    WHEN 'corrections required' THEN 'pending'
    WHEN 'corrections submitted' THEN 'pending'
    WHEN 'awaiting information' THEN 'pending'
    WHEN 'additional info requested' THEN 'pending'
    WHEN 'ready for issuance' THEN 'pending'
    WHEN 'issued' THEN 'active'
    WHEN 'phase issued' THEN 'active'
    WHEN 'completed' THEN 'completed'
    WHEN 'inspections completed' THEN 'completed'
    WHEN 'approved to occupy' THEN 'completed'
    WHEN 'expired' THEN 'expired'
    WHEN 'withdrawn' THEN 'cancelled'
    WHEN 'canceled' THEN 'cancelled'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE 'pending'
  END,
    updated_at = CURRENT_TIMESTAMP
WHERE status_raw IS NOT NULL
  AND status IS NOT CASE lower(trim(status_raw))
    WHEN '' THEN 'new'
    WHEN 'initiated' THEN 'new'
    WHEN 'ready for intake' THEN 'new'
    WHEN 'application completed' THEN 'pending'
    WHEN 'reviews in process' THEN 'pending'
    WHEN 'reviews completed' THEN 'pending'
    WHEN 'corrections required' THEN 'pending'
    WHEN 'corrections submitted' THEN 'pending'
    WHEN 'awaiting information' THEN 'pending'
    WHEN 'additional info requested' THEN 'pending'
    WHEN 'ready for issuance' THEN 'pending'
    WHEN 'issued' THEN 'active'
    WHEN 'phase issued' THEN 'active'
    WHEN 'completed' THEN 'completed'
    WHEN 'inspections completed' THEN 'completed'
    WHEN 'approved to occupy' THEN 'completed'
    WHEN 'expired' THEN 'expired'
    WHEN 'withdrawn' THEN 'cancelled'
    WHEN 'canceled' THEN 'cancelled'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE 'pending'
  END;
