import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker from "../worker.js";
import { PERMIT_UPSERT_COLUMNS, PERMIT_UPSERT_SQL, PERMIT_WATERMARK_SQL, permitUpsertBinds, permitWatermarkBinds, zipOrNull } from "../permit_upsert.js";

// The shared permit upsert (audit C5, C8, C16) on real SQLite.

function openDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const file of ["../schema.sql"]) {
    db.exec(readFileSync(new URL(file, import.meta.url), "utf8"));
  }
  db.exec("DELETE FROM permits; DELETE FROM contractors; DELETE FROM ingest_logs;");
  return db;
}

const base = {
  permit_number: "7000001-CN",
  address: "100 MAIN ST, Seattle, WA",
  neighborhood: "Ballard",
  type: "residential",
  value: 100000,
  description: "Construct addition",
  applied_date: "2025-06-01",
  status_raw: "Issued",
  latitude: "47.68",
  longitude: "-122.39",
  zip_code: "98107-1234",
  source_updated_at: "2026-11-01T00:00:00.000Z",
};

function upsert(db, permit, { contractorId = null, status = "active" } = {}) {
  return Number(db.prepare(PERMIT_UPSERT_SQL).run(...permitUpsertBinds(permit, { contractorId, status })).changes);
}

const row = (db) => db.prepare("SELECT * FROM permits WHERE permit_number = '7000001-CN'").get();

test("binds line up with the column list and accept scraper aliases", () => {
  const binds = permitUpsertBinds(base, { status: "active" });
  assert.equal(binds.length, PERMIT_UPSERT_COLUMNS.length);
  const byName = Object.fromEntries(PERMIT_UPSERT_COLUMNS.map((c, i) => [c, binds[i]]));
  assert.equal(byName.lat, 47.68);
  assert.equal(byName.lng, -122.39);
  assert.equal(byName.zip, "98107");
  assert.equal(byName.status, "active");
  assert.equal(zipOrNull("WA"), null);
  assert.ok(PERMIT_UPSERT_COLUMNS.length <= 100, "D1 bound-parameter limit");
});

test("an identical re-ingest writes nothing and keeps updated_at", () => {
  const db = openDatabase();
  assert.equal(upsert(db, base), 1);
  db.exec("UPDATE permits SET updated_at = '2026-05-01 00:00:00'");
  assert.equal(upsert(db, base), 0);
  assert.equal(upsert(db, { ...base, source_updated_at: "2026-11-02T00:00:00.000Z" }), 0, "a new stamp alone is not a change");
  assert.equal(row(db).updated_at, "2026-05-01 00:00:00");
  assert.equal(upsert(db, { ...base, value: 200000, source_updated_at: "2026-11-03T00:00:00.000Z" }), 1);
  assert.notEqual(row(db).updated_at, "2026-05-01 00:00:00");
  assert.equal(row(db).source_updated_at, "2026-11-03T00:00:00.000Z");
});

test("a stale or unstamped record cannot overwrite a fresher feed row", () => {
  const db = openDatabase();
  upsert(db, { ...base, status_raw: "Completed" }, { status: "completed" });
  // Older Socrata stamp (a stale JSONL export).
  assert.equal(upsert(db, { ...base, source_updated_at: "2026-10-01T00:00:00.000Z" }, { status: "active" }), 0);
  // Legacy JSONL without any stamp.
  const { source_updated_at: _drop, ...legacy } = base;
  assert.equal(upsert(db, legacy, { status: "active" }), 0);
  assert.equal(row(db).status, "completed");
  // A row never stamped by the feed still accepts unstamped writes.
  db.exec("UPDATE permits SET source_updated_at = NULL");
  assert.equal(upsert(db, legacy, { status: "active" }), 1);
  assert.equal(row(db).status, "active");
});

test("enrichment-owned links and fields survive a feed re-ingest", () => {
  const db = openDatabase();
  db.exec("INSERT INTO contractors (id, name, slug) VALUES (50, 'Licensed Co', 'licensed-co'), (51, 'Feed Name', 'feed-name')");
  upsert(db, base);
  db.exec("UPDATE permits SET contractor_id = 50, contractor_source = 'wa_lni_license', parcel_number = 'P1', lat = 47.5");
  upsert(db, { ...base, value: 1, latitude: null, longitude: null, source_updated_at: "2026-11-05T00:00:00.000Z" }, { contractorId: 51 });
  const stored = row(db);
  assert.equal(stored.contractor_id, 50, "L&I-linked contractor is kept");
  assert.equal(stored.parcel_number, "P1");
  assert.equal(stored.lat, 47.5, "a missing coordinate does not clear a stored one");
});

test("the scheduled contractor upsert no longer renames curated contractors (C16)", async () => {
  const db = openDatabase();
  db.exec("INSERT INTO contractors (name, slug, specialty) VALUES ('ACME BUILDERS LLC (L&I)', 'acme-builders-llc', 'General Contractor')");
  const sql = readFileSync(new URL("../worker.js", import.meta.url), "utf8")
    .match(/INSERT INTO contractors \(name, slug, specialty\)\s+VALUES \(\?, \?, \?\)\s+ON CONFLICT\(slug\) DO UPDATE SET[\s\S]*?WHERE contractors\.specialty IS NULL AND excluded\.specialty IS NOT NULL/)[0];
  db.prepare(sql).run("Acme Builders LLC", "acme-builders-llc", "Multifamily");
  const stored = db.prepare("SELECT name, specialty FROM contractors WHERE slug = 'acme-builders-llc'").get();
  assert.deepEqual({ ...stored }, { name: "ACME BUILDERS LLC (L&I)", specialty: "General Contractor" });
});

test("the feed-fields migration applies to the pre-audit schema", () => {
  const db = new DatabaseSync(":memory:");
  // schema.sql = migrations 0000..0003 in order; drop the 0003 block to get the pre-audit schema.
  const fullSchema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const legacySchema = fullSchema.slice(0, fullSchema.indexOf("-- Permit feed fields (migrations/0003_permit_feed_fields.sql)."));
  db.exec(legacySchema);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('permits') WHERE name = 'status_raw'").get().n, 0);
  db.exec(readFileSync(new URL("../migrations/0003_permit_feed_fields.sql", import.meta.url), "utf8"));
  const permitCols = db.prepare("SELECT name FROM pragma_table_info('permits')").all().map((r) => r.name);
  const logCols = db.prepare("SELECT name FROM pragma_table_info('ingest_logs')").all().map((r) => r.name);
  assert.ok(permitCols.includes("status_raw") && permitCols.includes("source_updated_at"));
  assert.ok(logCols.includes("cursor") && logCols.includes("records_unchanged"));
});

test("/api/permits pages are stable when issued_date ties or is NULL (C11)", async () => {
  const db = openDatabase();
  const insert = db.prepare("INSERT INTO permits (permit_number, address, issued_date) VALUES (?, 'x', ?)");
  for (let i = 0; i < 30; i++) insert.run(`P${i}`, i % 3 === 0 ? null : "2026-01-01");
  const wrap = (sql, binds = []) => ({
    bind: (...next) => wrap(sql, next),
    all: async () => ({ results: db.prepare(sql).all(...binds) }),
    first: async () => db.prepare(sql).get(...binds) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...binds).changes) } }),
  });
  const env = { DB: { prepare: (sql) => wrap(sql) } };
  const seen = [];
  for (let page = 1; page <= 3; page++) {
    const response = await worker.fetch(new Request(`https://buildingseattle.com/api/permits?per_page=10&page=${page}`), env, { waitUntil() {} });
    seen.push(...(await response.json()).results.map((r) => r.permit_number));
  }
  assert.equal(new Set(seen).size, 30);
});

test("an unchanged newer record still advances the watermark, so a stale record between them is refused", () => {
  const db = openDatabase();
  const write = (permit) => {
    const changes = upsert(db, permit);
    db.prepare(PERMIT_WATERMARK_SQL).run(...permitWatermarkBinds(permit));
    return changes;
  };
  write({ ...base, value: 100000, source_updated_at: "2026-11-01T00:00:00.000Z" });
  db.exec("UPDATE permits SET updated_at = '2026-05-01 00:00:00'");
  assert.equal(write({ ...base, value: 100000, source_updated_at: "2026-11-03T00:00:00.000Z" }), 0);
  assert.equal(row(db).source_updated_at, "2026-11-03T00:00:00.000Z");
  assert.equal(row(db).updated_at, "2026-05-01 00:00:00", "metadata-only bump keeps updated_at");
  assert.equal(write({ ...base, value: 50, source_updated_at: "2026-11-02T00:00:00.000Z" }), 0);
  assert.equal(row(db).value, 100000, "stale record refused");
  assert.equal(row(db).source_updated_at, "2026-11-03T00:00:00.000Z", "watermark never moves back");
  write({ ...base, value: 50, source_updated_at: null });
  assert.equal(row(db).value, 100000, "unstamped record cannot roll a stamped row back");
});
