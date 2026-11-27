-- 0001_hot_query_indexes.sql: indexes for the hottest public queries
-- (audit F8), plus the dedupe index production never received (audit B2).
--
-- All statements are additive and idempotent. The permits table is ~16k rows,
-- so each index builds in well under a second on D1.

-- /permits, /api/permits and MCP search_permits list with
-- `ORDER BY p.issued_date DESC LIMIT ? OFFSET ?`. Without an index SQLite
-- scans the whole table and sorts it in a temp B-tree on every request.
CREATE INDEX IF NOT EXISTS idx_permits_issued_date ON permits(issued_date DESC);

-- The same list filtered by ?type=, ?neighborhood= or ?status=: the equality
-- column first, then the sort column, so the filter and the ORDER BY are both
-- served by one index.
CREATE INDEX IF NOT EXISTS idx_permits_type_issued_date ON permits(type, issued_date DESC);
CREATE INDEX IF NOT EXISTS idx_permits_neighborhood_issued_date ON permits(neighborhood, issued_date DESC);
CREATE INDEX IF NOT EXISTS idx_permits_status_issued_date ON permits(status, issued_date DESC);

-- The entity-graph rebuild lock and the "latest rebuild" checks look up
-- ingest_logs by run_type and status, newest first.
CREATE INDEX IF NOT EXISTS idx_ingest_logs_run_type_status_start ON ingest_logs(run_type, status, start_time);

-- Basis Reset discovery dedupe. Defined in the legacy
-- migration_basis_reset_discovery.sql but never applied to production, so
-- the only dedupe was an app-level SELECT that can race
-- (basis_reset_routes.js). Production had 0 duplicate
-- (source_url, event_type, event_date) groups on 2026-11-27, so this
-- succeeds there.
CREATE UNIQUE INDEX IF NOT EXISTS idx_basis_reset_events_source_unique
ON basis_reset_events(source_url, event_type, event_date);
