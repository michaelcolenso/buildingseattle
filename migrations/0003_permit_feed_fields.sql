-- Audit C1/C2/C4/C5/C8 (data pipeline). Apply BEFORE merging/deploying the
-- worker that ships sdci_feed.js / permit_upsert.js (the new upsert writes these
-- columns), with
--   npx wrangler d1 migrations apply buildingseattle --remote
-- (see docs/deploy-runbook.md). Never apply it with `d1 execute --file`: that
-- skips the d1_migrations record, and SQLite's ADD COLUMN cannot run twice, so
-- the next `migrations apply` would fail with "duplicate column name" and block
-- every later migration.
--
-- permits.lat / lng / zip already exist (migration_entity_graph.sql); the
-- ingest now fills them from the feed's latitude / longitude / originalzip.

-- SDCI statuscurrent exactly as the feed sent it, so the stored status can be
-- recomputed when data/sdci_mappings.json changes (C2).
ALTER TABLE permits ADD COLUMN status_raw TEXT;

-- Socrata :updated_at of the record last written; an older record (e.g. a stale
-- scraper JSONL) can no longer overwrite a fresher row (C8).
ALTER TABLE permits ADD COLUMN source_updated_at TEXT;

-- Resume point of a scheduled / full_sweep run that hit its page cap (C1), and
-- rows that matched a stored permit but changed nothing (C5).
ALTER TABLE ingest_logs ADD COLUMN cursor TEXT;
ALTER TABLE ingest_logs ADD COLUMN records_unchanged INTEGER DEFAULT 0;

-- The (run_type, status, start_time) lookups that latestFeedRun / the rebuild
-- lock need are served by 0001's idx_ingest_logs_run_type_status_start.
