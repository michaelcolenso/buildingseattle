import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { runScheduledIngest } from "../worker.js";

// End-to-end scheduled ingest against a real SQLite database (production
// schema + entity graph migration) and a fake Socrata endpoint that evaluates
// the keyset queries sdci_feed.js builds. Audit C1/A2, C2, C4, C5, C7.

function openDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const file of ["../schema.sql", "../migration_entity_graph.sql"]) {
    db.exec(readFileSync(new URL(file, import.meta.url), "utf8"));
  }
  db.exec("DELETE FROM permits; DELETE FROM contractors; DELETE FROM ingest_logs;");
  return db;
}

// D1-shaped wrapper; batch() returns per-statement meta.changes like D1.
function createEnv(db) {
  const wrap = (sql, binds = []) => ({
    sql,
    binds,
    bind: (...next) => wrap(sql, next),
    all: async () => ({ results: db.prepare(sql).all(...binds) }),
    first: async () => db.prepare(sql).get(...binds) ?? null,
    run: async () => {
      const result = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
  });
  return {
    DB: {
      prepare: (sql) => wrap(sql),
      batch: async (statements) => {
        db.exec("BEGIN");
        try {
          const results = statements.map((s) => {
            const r = db.prepare(s.sql).run(...s.binds);
            return { success: true, meta: { changes: Number(r.changes) } };
          });
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
}

function feedRow(n, fields = {}) {
  return {
    permitnum: `${7000000 + n}-CN`,
    permitclass: "Single Family/Duplex",
    statuscurrent: "Issued",
    originaladdress1: `${100 + n} MAIN ST`,
    originalcity: "SEATTLE",
    originalstate: "WA",
    originalzip: "98103",
    latitude: "47.680",
    longitude: "-122.390",
    applieddate: "2025-06-01T00:00:00.000",
    issueddate: "2025-07-01T00:00:00.000",
    estprojectcost: "100000",
    description: "Construct addition to single family residence",
    ":updated_at": "2026-01-01T00:00:00.000Z",
    ...fields,
  };
}

// Minimal SoQL evaluator for exactly the query shapes sdci_feed.js emits.
function fakeSocrata(rows, { failFirst = 0 } = {}) {
  const calls = [];
  let failures = failFirst;
  const fetchImpl = async (url) => {
    const params = new URL(url).searchParams;
    const where = params.get("$where") || "";
    const order = params.get("$order");
    const limit = Number(params.get("$limit"));
    calls.push({ where, order, limit });
    if (failures > 0) {
      failures--;
      return { ok: false, status: 503, text: async () => "busy", json: async () => ({}) };
    }
    const floor = where.match(/applieddate >= '([^']+)'/)?.[1];
    const resume = where.match(/\(:updated_at > '([^']+)' OR \(:updated_at = '[^']+' AND permitnum > '([^']*)'\)\)/);
    const since = resume ? null : where.match(/:updated_at > '([^']+)'/)?.[1];
    const after = order === "permitnum" ? where.match(/permitnum > '([^']*)'/)?.[1] : null;
    let result = rows.filter((row) => !floor || row.applieddate >= floor);
    if (resume) {
      const [, t, p] = resume;
      result = result.filter((row) => row[":updated_at"] > t || (row[":updated_at"] === t && row.permitnum > p));
    } else if (since) {
      result = result.filter((row) => row[":updated_at"] > since);
    }
    if (after != null) result = result.filter((row) => row.permitnum > after);
    const key = order === "permitnum" ? (row) => row.permitnum : (row) => `${row[":updated_at"]}|${row.permitnum}`;
    result.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const page = result.slice(0, limit);
    return { ok: true, status: 200, json: async () => page.map((row) => ({ ...row })), text: async () => "" };
  };
  return { fetchImpl, calls };
}

function seedPermit(db, fields) {
  const row = {
    address: "1 Test St, Seattle, WA",
    status: "active",
    type: "residential",
    value: 1000,
    applied_date: "2025-01-01",
    updated_at: "2026-05-01 00:00:00",
    ...fields,
  };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO permits (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((c) => row[c]),
  );
}

function logRun(db, runType, startTime, cursor = null) {
  db.prepare(
    `INSERT INTO ingest_logs (run_type, source, status, start_time, end_time, cursor)
     VALUES (?, 'seattle_open_data', 'success', ?, ?, ?)`,
  ).run(runType, startTime, startTime, cursor);
}

const permit = (db, number) => db.prepare("SELECT * FROM permits WHERE permit_number = ?").get(number);
const NOW = new Date("2026-11-28T13:00:00Z");
const fast = { sleep: async () => {}, now: NOW };

test("a permit outside the newest-5,000 window still gets its status updated", async () => {
  const db = openDatabase();
  // The oldest application in the catalog, last written in May.
  seedPermit(db, { permit_number: "6900000-CN", applied_date: "2024-05-15", status: "active", address: "9 OLD ST, Seattle, WA" });
  // 5,000 newer applications in the feed, none changed since the last run.
  const rows = Array.from({ length: 5000 }, (_, n) => feedRow(n + 1, { applieddate: "2026-02-15T00:00:00.000" }));
  // The old permit was completed yesterday.
  rows.push(feedRow(0, {
    permitnum: "6900000-CN",
    originaladdress1: "9 OLD ST",
    applieddate: "2024-05-15T00:00:00.000",
    statuscurrent: "Completed",
    completeddate: "2026-11-27T00:00:00.000",
    ":updated_at": "2026-11-28T02:00:00.000Z",
  }));
  logRun(db, "scheduled", "2026-11-27 13:00:00");
  logRun(db, "full_sweep", "2026-11-26 13:00:00"); // sweep not due
  const feed = fakeSocrata(rows);

  const summary = await runScheduledIngest(createEnv(db), { ...fast, fetchImpl: feed.fetchImpl });

  const updated = permit(db, "6900000-CN");
  assert.equal(updated.status, "completed");
  assert.equal(updated.status_raw, "Completed");
  assert.equal(updated.completed_date, "2026-11-27");
  assert.deepEqual(
    db.prepare("SELECT previous_status, new_status FROM permit_status_changes WHERE permit_number = '6900000-CN'").all().map((r) => ({ ...r })),
    [{ previous_status: "active", new_status: "completed" }],
  );
  // Only the changed record was pulled: the watermark is the last run's start minus 2 h.
  assert.equal(feed.calls.length, 1);
  assert.match(feed.calls[0].where, /:updated_at > '2026-11-27T11:00:00.000Z'/);
  assert.equal(summary.updated, 1);
  assert.equal(summary.incremental.complete, true);
});

test("unchanged rows keep updated_at; changed rows move it; lat/lng/zip are stored", async () => {
  const db = openDatabase();
  const rows = [feedRow(1), feedRow(2)];
  const feed = fakeSocrata(rows);
  logRun(db, "full_sweep", "2026-11-26 13:00:00");
  const env = createEnv(db);

  const first = await runScheduledIngest(env, { ...fast, fetchImpl: feed.fetchImpl });
  assert.equal(first.added, 2);
  const stored = permit(db, "7000001-CN");
  assert.equal(stored.lat, 47.68);
  assert.equal(stored.lng, -122.39);
  assert.equal(stored.zip, "98103");
  assert.equal(stored.source_updated_at, "2026-01-01T00:00:00.000Z");
  const address = db.prepare("SELECT a.* FROM addresses a JOIN permits p ON p.address_id = a.id WHERE p.permit_number = '7000001-CN'").get();
  assert.equal(address.lat, 47.68);
  assert.equal(address.zip, "98103");

  db.exec("UPDATE permits SET updated_at = '2026-05-01 00:00:00'");
  db.exec("DELETE FROM ingest_logs WHERE run_type = 'scheduled'");
  // Same records again (e.g. Socrata re-stamped them) plus one real change.
  rows[0][":updated_at"] = "2026-11-28T01:00:00.000Z";
  rows[1][":updated_at"] = "2026-11-28T01:00:00.000Z";
  rows[1].estprojectcost = "250000";

  const second = await runScheduledIngest(env, { ...fast, fetchImpl: feed.fetchImpl });
  assert.equal(second.unchanged, 1);
  assert.equal(second.updated, 1);
  assert.equal(permit(db, "7000001-CN").updated_at, "2026-05-01 00:00:00", "an unchanged row is not rewritten");
  assert.notEqual(permit(db, "7000002-CN").updated_at, "2026-05-01 00:00:00");
  assert.equal(permit(db, "7000002-CN").value, 250000);
  const log = db.prepare("SELECT records_updated, records_unchanged FROM ingest_logs WHERE run_type = 'scheduled' ORDER BY id DESC").get();
  assert.deepEqual({ ...log }, { records_updated: 1, records_unchanged: 1 });
});

test("a run that hits its page cap stores a cursor and the next run resumes from it", async () => {
  const db = openDatabase();
  const rows = Array.from({ length: 5 }, (_, n) => feedRow(n + 1, { ":updated_at": `2026-11-28T0${n}:00:00.000Z` }));
  logRun(db, "scheduled", "2026-11-27 13:00:00");
  logRun(db, "full_sweep", "2026-11-26 13:00:00");
  const feed = fakeSocrata(rows);
  const env = createEnv(db);
  const limits = { pageSize: 2, maxPagesPerRun: 2, sweepReservedPages: 0, mappingGuardMinRows: 1000 };

  const first = await runScheduledIngest(env, { ...fast, fetchImpl: feed.fetchImpl, limits });
  assert.equal(first.added, 4);
  assert.equal(first.incremental.complete, false);
  const cursor = JSON.parse(db.prepare("SELECT cursor FROM ingest_logs WHERE run_type = 'scheduled' ORDER BY id DESC").get().cursor);
  assert.deepEqual(cursor, { updated_at: "2026-11-28T03:00:00.000Z", permitnum: "7000004-CN" });

  const second = await runScheduledIngest(env, { ...fast, fetchImpl: feed.fetchImpl, limits });
  assert.equal(second.added, 1);
  assert.equal(second.incremental.complete, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM permits").get().n, 5);
  assert.equal(db.prepare("SELECT cursor FROM ingest_logs WHERE run_type = 'scheduled' ORDER BY id DESC").get().cursor, null);
});

test("the weekly full sweep reaches permits the incremental pull never sees, without remap alerts", async () => {
  const db = openDatabase();
  // Written before status_raw existed, with the old substring mapping.
  seedPermit(db, { permit_number: "7000001-CN", status: "completed", address: "101 MAIN ST, Seattle, WA" }); // was "Application Completed"
  seedPermit(db, { permit_number: "7000002-CN", status: "active", address: "102 MAIN ST, Seattle, WA" }); // really completed now
  seedPermit(db, { permit_number: "7000003-CN", status: "new", address: "103 MAIN ST, Seattle, WA" }); // was "Withdrawn"
  const rows = [
    feedRow(1, { statuscurrent: "Application Completed", ":updated_at": "2025-01-01T00:00:00.000Z" }),
    feedRow(2, { statuscurrent: "Completed", ":updated_at": "2025-01-01T00:00:00.000Z" }),
    feedRow(3, { statuscurrent: "Withdrawn", ":updated_at": "2025-01-01T00:00:00.000Z" }),
  ];
  logRun(db, "scheduled", "2026-11-27 13:00:00"); // nothing changed since -> incremental is empty
  const feed = fakeSocrata(rows);

  const summary = await runScheduledIngest(createEnv(db), { ...fast, fetchImpl: feed.fetchImpl });

  assert.equal(summary.sweep.complete, true);
  assert.equal(permit(db, "7000001-CN").status, "pending");
  assert.equal(permit(db, "7000002-CN").status, "completed");
  assert.equal(permit(db, "7000003-CN").status, "cancelled");
  // Only the real change becomes an alertable status change.
  assert.deepEqual(
    db.prepare("SELECT permit_number, previous_status, new_status FROM permit_status_changes").all().map((r) => ({ ...r })),
    [{ permit_number: "7000002-CN", previous_status: "active", new_status: "completed" }],
  );
  assert.ok(feed.calls.some((call) => call.order === "permitnum"), "sweep paginates on permitnum");
  assert.ok(feed.calls.every((call) => call.where.startsWith("applieddate >= '2025-01-01T00:00:00.000'")), "coverage floor = earliest permit in D1");
  const sweepLog = db.prepare("SELECT status, cursor, records_updated FROM ingest_logs WHERE run_type = 'full_sweep'").get();
  assert.deepEqual({ ...sweepLog }, { status: "success", cursor: null, records_updated: 3 });
});

test("transient Socrata errors are retried", async () => {
  const db = openDatabase();
  logRun(db, "full_sweep", "2026-11-26 13:00:00");
  const feed = fakeSocrata([feedRow(1)], { failFirst: 2 });
  const summary = await runScheduledIngest(createEnv(db), { ...fast, fetchImpl: feed.fetchImpl });
  assert.equal(summary.added, 1);
  assert.equal(feed.calls.length, 3);
});

test("a feed page missing :updated_at fails the run loudly and writes nothing", async () => {
  const db = openDatabase();
  logRun(db, "full_sweep", "2026-11-26 13:00:00");
  const broken = feedRow(1);
  delete broken[":updated_at"];
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [broken], text: async () => "" });
  await assert.rejects(runScheduledIngest(createEnv(db), { ...fast, fetchImpl }), /Schema guard/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM permits").get().n, 0);
  const log = db.prepare("SELECT status, error_message FROM ingest_logs WHERE run_type = 'scheduled'").get();
  assert.equal(log.status, "error");
  assert.match(log.error_message, /Schema guard/);
});

test("a city-only address creates no address or project entity", async () => {
  const db = openDatabase();
  logRun(db, "full_sweep", "2026-11-26 13:00:00");
  const feed = fakeSocrata([feedRow(1, { originaladdress1: undefined }), feedRow(2, { originaladdress1: "" })]);
  await runScheduledIngest(createEnv(db), { ...fast, fetchImpl: feed.fetchImpl });
  assert.equal(permit(db, "7000001-CN").address, "SEATTLE, WA");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM permits WHERE address_id IS NULL AND project_id IS NULL").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM addresses").get().n, 0);
  assert.equal(db.prepare("SELECT status FROM ingest_logs WHERE run_type = 'entity_graph'").get().status, "success");
});
