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
  for (const file of ["../schema.sql"]) {
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
    const newest = order?.match(/^(\w+) DESC, permitnum DESC$/)?.[1] || null;
    calls.push({ where, order, limit, mode: newest ? "newest" : order === "permitnum" ? "sweep" : "incremental" });
    if (failures > 0) {
      failures--;
      return { ok: false, status: 503, text: async () => "busy", json: async () => ({}) };
    }
    const floor = where.match(/applieddate >= '([^']+)'/)?.[1];
    let result = rows.filter((row) => !floor || row.applieddate >= floor);
    let key;
    if (newest) {
      if (where.includes(`${newest} IS NOT NULL`)) result = result.filter((row) => row[newest]);
      const before = where.match(new RegExp(`\\(${newest} < '([^']+)' OR \\(${newest} = '[^']+' AND permitnum < '([^']*)'\\)\\)`));
      if (before) {
        const [, t, p] = before;
        result = result.filter((row) => row[newest] < t || (row[newest] === t && row.permitnum < p));
      }
      key = (row) => `${row[newest]}|${row.permitnum}`;
      result.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
    } else {
      const resume = where.match(/\(:updated_at > '([^']+)' OR \(:updated_at = '[^']+' AND permitnum > '([^']*)'\)\)/);
      const since = resume ? null : where.match(/:updated_at > '([^']+)'/)?.[1];
      const after = order === "permitnum" ? where.match(/permitnum > '([^']*)'/)?.[1] : null;
      if (resume) {
        const [, t, p] = resume;
        result = result.filter((row) => row[":updated_at"] > t || (row[":updated_at"] === t && row.permitnum > p));
      } else if (since) {
        result = result.filter((row) => row[":updated_at"] > since);
      }
      if (after != null) result = result.filter((row) => row.permitnum > after);
      key = order === "permitnum" ? (row) => row.permitnum : (row) => `${row[":updated_at"]}|${row.permitnum}`;
      result.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    }
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
  // The incremental pull read only the changed record: the watermark is the
  // last run's start minus 2 h. The run also read one newest-first page per
  // date field (review B2).
  const incrementalCalls = feed.calls.filter((call) => call.mode === "incremental");
  assert.equal(incrementalCalls.length, 1);
  assert.match(incrementalCalls[0].where, /:updated_at > '2026-11-27T11:00:00.000Z'/);
  assert.deepEqual(feed.calls.filter((call) => call.mode === "newest").map((call) => call.order), [
    "applieddate DESC, permitnum DESC",
    "issueddate DESC, permitnum DESC",
  ]);
  assert.equal(summary.newest.pages, 2);
  assert.equal(summary.degraded, false);
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

test("an unchanged re-stamped row still advances source_updated_at; counts stay 'unchanged'", async () => {
  const db = openDatabase();
  const rows = [feedRow(1)];
  const feed = fakeSocrata(rows);
  logRun(db, "full_sweep", "2026-11-26 13:00:00");
  const env = createEnv(db);
  await runScheduledIngest(env, { ...fast, fetchImpl: feed.fetchImpl });
  db.exec("UPDATE permits SET updated_at = '2026-05-01 00:00:00'");
  db.exec("DELETE FROM ingest_logs WHERE run_type = 'scheduled'");
  rows[0][":updated_at"] = "2026-11-28T01:00:00.000Z";
  const second = await runScheduledIngest(env, { ...fast, fetchImpl: feed.fetchImpl });
  assert.equal(second.unchanged, 1);
  assert.equal(second.updated, 0);
  const stored = permit(db, "7000001-CN");
  assert.equal(stored.source_updated_at, "2026-11-28T01:00:00.000Z");
  assert.equal(stored.updated_at, "2026-05-01 00:00:00");
});

test("a new permit links to a contractor whose stored name differs only in punctuation", async () => {
  const db = openDatabase();
  db.exec("INSERT INTO contractors (name, slug) VALUES ('ACME BUILDERS, LLC', 'acme-builders-llc')");
  const feed = fakeSocrata([feedRow(1, { contractorcompanyname: "Acme Builders LLC" })]);
  logRun(db, "full_sweep", "2026-11-26 13:00:00");
  await runScheduledIngest(createEnv(db), { ...fast, fetchImpl: feed.fetchImpl });
  const contractor = db.prepare("SELECT id, name FROM contractors WHERE slug = 'acme-builders-llc'").get();
  assert.equal(contractor.name, "ACME BUILDERS, LLC", "curated name kept");
  assert.equal(permit(db, "7000001-CN").contractor_id, contractor.id);
});

test("a run that hits its page cap stores a cursor and the next run resumes from it", async () => {
  const db = openDatabase();
  const rows = Array.from({ length: 5 }, (_, n) => feedRow(n + 1, { ":updated_at": `2026-11-28T0${n}:00:00.000Z` }));
  logRun(db, "scheduled", "2026-11-27 13:00:00");
  logRun(db, "full_sweep", "2026-11-26 13:00:00");
  const feed = fakeSocrata(rows);
  const env = createEnv(db);
  const limits = { pageSize: 2, maxPagesPerRun: 2, sweepReservedPages: 0, newestPages: 0, mappingGuardMinRows: 1000 };

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

  // No newest-first pages here: with three rows they would read everything
  // before the sweep does.
  const summary = await runScheduledIngest(createEnv(db), { ...fast, fetchImpl: feed.fetchImpl, limits: { newestPages: 0 } });

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
  // Two failures, then the same query succeeds; then the rest of the run.
  assert.equal(feed.calls.length, 5);
  assert.ok(feed.calls.slice(0, 3).every((call) => call.where === feed.calls[0].where && call.order === feed.calls[0].order));
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

test("a full dataset replace is logged 'degraded' and new permits still land the same day (B2)", async () => {
  const db = openDatabase();
  // Yesterday's run stopped inside yesterday's replace bucket.
  logRun(db, "scheduled", "2026-11-27 13:00:00", JSON.stringify({ updated_at: "2026-11-27T06:00:00.000Z", permitnum: "7000500-CN" }));
  logRun(db, "full_sweep", "2026-11-26 13:00:00"); // sweep not due
  // Overnight SDCI replaced the whole dataset: every row has one new stamp.
  const stamp = "2026-11-28T06:00:00.000Z";
  const rows = Array.from({ length: 60 }, (_, n) =>
    feedRow(n + 1, { applieddate: `2025-${String((n % 12) + 1).padStart(2, "0")}-01T00:00:00.000`, ":updated_at": stamp }),
  );
  // Filed yesterday, with the highest applied date but a mid-range permit number.
  rows.push(feedRow(0, { permitnum: "7000030-NEW", applieddate: "2026-11-27T00:00:00.000", statuscurrent: "Application Accepted", ":updated_at": stamp }));
  // Applied long ago, issued yesterday.
  rows.push(feedRow(0, { permitnum: "7000031-ISS", applieddate: "2024-06-01T00:00:00.000", issueddate: "2026-11-27T00:00:00.000", ":updated_at": stamp }));
  const feed = fakeSocrata(rows);
  const limits = { pageSize: 10, maxPagesPerRun: 5, replaceGuardMinRows: 10, mappingGuardMinRows: 1000 };

  const summary = await runScheduledIngest(createEnv(db), { ...fast, fetchImpl: feed.fetchImpl, limits });

  assert.equal(summary.degraded, true);
  assert.ok(permit(db, "7000030-NEW"), "the newest application landed without waiting for the sweep");
  assert.ok(permit(db, "7000031-ISS"), "the newest issuance landed without waiting for the sweep");
  const log = db.prepare("SELECT status, cursor, error_message FROM ingest_logs WHERE run_type = 'scheduled' ORDER BY id DESC").get();
  assert.equal(log.status, "degraded");
  assert.equal(log.cursor, null, "no cursor into a bucket that will be restamped tomorrow");
  assert.match(log.error_message, /full dataset replace/);
  // One incremental page only; the rest of its budget went newest-first,
  // continuing below the first applieddate page (keyset, no repeats).
  const modes = feed.calls.map((call) => call.mode);
  assert.deepEqual(modes, ["newest", "newest", "incremental", "newest", "newest"]);
  assert.match(feed.calls[3].where, /applieddate < '/);
  assert.ok(feed.calls.length <= limits.maxPagesPerRun);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM permits").get().n, 41, "4 distinct pages of 10 + the issued permit");

  // /api/stats and the homepage treat the degraded run as an ingest, and say so.
  const { getCanonicalStats } = await import("../worker.js");
  const stats = await getCanonicalStats(createEnv(db));
  assert.ok(stats.last_ingest_at);
  assert.equal(stats.last_feed_status, "degraded");

  // The next run plans from the degraded run (watermark), not from the old cursor.
  const next = fakeSocrata(rows);
  await runScheduledIngest(createEnv(db), { ...fast, now: new Date("2026-11-29T13:00:00Z"), fetchImpl: next.fetchImpl, limits });
  const incremental = next.calls.find((call) => call.mode === "incremental");
  assert.match(incremental.where, /:updated_at > '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z'$/);
  assert.doesNotMatch(incremental.where, /permitnum >/);
});

test("ordinary daily churn is not mistaken for a replace", async () => {
  const db = openDatabase();
  logRun(db, "scheduled", "2026-11-27 13:00:00");
  logRun(db, "full_sweep", "2026-11-26 13:00:00");
  const rows = Array.from({ length: 30 }, (_, n) =>
    feedRow(n + 1, { ":updated_at": `2026-11-28T${String(n % 12).padStart(2, "0")}:${String(n).padStart(2, "0")}:00.000Z` }),
  );
  const feed = fakeSocrata(rows);
  const limits = { pageSize: 10, maxPagesPerRun: 8, replaceGuardMinRows: 10, mappingGuardMinRows: 1000 };
  const summary = await runScheduledIngest(createEnv(db), { ...fast, fetchImpl: feed.fetchImpl, limits });
  assert.equal(summary.degraded, false);
  assert.equal(summary.incremental.complete, true);
  assert.equal(db.prepare("SELECT status FROM ingest_logs WHERE run_type = 'scheduled' ORDER BY id DESC").get().status, "success");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM permits").get().n, 30);
});

test("the scheduled ingest sends env.SOCRATA_APP_TOKEN as X-App-Token (N13)", async () => {
  const db = openDatabase();
  logRun(db, "full_sweep", "2026-11-26 13:00:00");
  const feed = fakeSocrata([feedRow(1)]);
  const headers = [];
  const fetchImpl = async (url, init) => { headers.push(init?.headers || {}); return feed.fetchImpl(url); };
  const env = { ...createEnv(db), SOCRATA_APP_TOKEN: "app-token" };
  await runScheduledIngest(env, { ...fast, fetchImpl });
  assert.ok(headers.length > 0);
  assert.ok(headers.every((h) => h["X-App-Token"] === "app-token"));
});
