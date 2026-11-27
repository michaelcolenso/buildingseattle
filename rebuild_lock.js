// Single-flight guard for the entity-graph rebuild (audit A14).
//
// The daily cron and POST /admin/build-graph can overlap, and two rebuilds
// diffing and relinking the same tables at once is a needless risk. A rebuild
// claims the run by inserting its `running` row in ingest_logs, and the insert
// only happens when no other entity_graph row is `running` and younger than
// ENTITY_GRAPH_LOCK_MINUTES. It is one statement, so two callers cannot both
// pass the check.
//
// A run that dies without recording its outcome leaves its row `running`
// (which the empty-address guard relies on). That stale marker blocks new runs
// only until it is ENTITY_GRAPH_LOCK_MINUTES old; an admin can override sooner
// with POST /admin/build-graph?force=1.

export const ENTITY_GRAPH_LOCK_MINUTES = 30;
export const ENTITY_GRAPH_LOCKED_CODE = "ENTITY_GRAPH_REBUILD_LOCKED";

// ingest_logs stamps are "YYYY-MM-DD HH:MM:SS" UTC.
export function ingestStamp(date) {
  return date.toISOString().replace("T", " ").split(".")[0];
}

export function entityGraphLockCutoff(now = new Date(), minutes = ENTITY_GRAPH_LOCK_MINUTES) {
  return ingestStamp(new Date(now.getTime() - minutes * 60000));
}

// Insert the `running` marker unless another rebuild holds the lock.
// Returns { locked: true } or { locked: false, logId }.
export async function claimEntityGraphRebuild(db, { source, now = new Date(), force = false, lockMinutes = ENTITY_GRAPH_LOCK_MINUTES }) {
  const stamp = ingestStamp(now);
  const result = force
    ? await db
        .prepare(
          `INSERT INTO ingest_logs (run_type, source, status, records_added, records_updated, start_time, end_time)
           VALUES ('entity_graph', ?, 'running', 0, 0, ?, ?)`,
        )
        .bind(source, stamp, stamp)
        .run()
    : await db
        .prepare(
          `INSERT INTO ingest_logs (run_type, source, status, records_added, records_updated, start_time, end_time)
           SELECT 'entity_graph', ?, 'running', 0, 0, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM ingest_logs
             WHERE run_type = 'entity_graph' AND status = 'running' AND start_time >= ?
           )`,
        )
        .bind(source, stamp, stamp, entityGraphLockCutoff(now, lockMinutes))
        .run();
  const changes = Number(result?.meta?.changes ?? 1);
  if (changes === 0) return { locked: true };
  return { locked: false, logId: result?.meta?.last_row_id ?? null };
}

export function entityGraphRebuildLockedError() {
  const error = new Error(
    `entity graph rebuild already running (a 'running' row younger than ${ENTITY_GRAPH_LOCK_MINUTES} minutes); not starting another`,
  );
  error.code = ENTITY_GRAPH_LOCKED_CODE;
  return error;
}
