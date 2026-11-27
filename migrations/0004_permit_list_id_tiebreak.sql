-- 0004_permit_list_id_tiebreak.sql: give the permit-list indexes the id
-- tiebreak the queries sort by (review N10).
--
-- /api/permits orders by `p.issued_date DESC, p.id DESC` (a stable order for
-- pagination). 0001's indexes end at issued_date, and SQLite's implicit rowid
-- suffix is ascending, so every page still sorted the id term in a temp
-- B-tree. These replace them: each also serves the /permits page and MCP,
-- which order by `issued_date DESC` alone.
--
-- Apply with `npx wrangler d1 migrations apply buildingseattle --remote`
-- (docs/deploy-runbook.md), never `d1 execute --file`. Additive and
-- idempotent; the permits table is ~16k rows, so each index builds in well
-- under a second.

CREATE INDEX IF NOT EXISTS idx_permits_issued_date_id ON permits(issued_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_permits_type_issued_date_id ON permits(type, issued_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_permits_neighborhood_issued_date_id ON permits(neighborhood, issued_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_permits_status_issued_date_id ON permits(status, issued_date DESC, id DESC);

-- The 0001 indexes are prefixes of the ones above: drop them so each permit
-- write maintains one index per list shape, not two.
DROP INDEX IF EXISTS idx_permits_issued_date;
DROP INDEX IF EXISTS idx_permits_type_issued_date;
DROP INDEX IF EXISTS idx_permits_neighborhood_issued_date;
DROP INDEX IF EXISTS idx_permits_status_issued_date;
