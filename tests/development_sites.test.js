import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker, { getCanonicalStats } from "../worker.js";
import { validBoundary, renderSiteOutline, validateSiteBatch, renderDevelopmentSiteCard } from "../development_sites.js";

const boundary = { type: "Polygon", coordinates: [[[-122.3, 47.6], [-122.299, 47.6], [-122.299, 47.601], [-122.3, 47.6]]] };
const fetchedAt = "2026-11-01T15:00:00.000Z";
function site(id = "DV0025961", overrides = {}) {
  return { site_id: id, status: "ACTIVE", lot_sqft: 5000, geometry: boundary, source_updated_at: null, ...overrides };
}
function payload(ids = ["DV0025961"], sites = [site()]) {
  return { requested_ids: ids, sites, complete: true, fetched_at: fetchedAt };
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migration_entity_graph.sql", import.meta.url), "utf8"));
  db.exec("DELETE FROM permits; DELETE FROM contractors; DELETE FROM ingest_logs");
  const insert = db.prepare("INSERT INTO permits (permit_number, address, parcel_number, value, status, issued_date, type) VALUES (?, ?, ?, ?, 'active', '2026-01-01', 'residential')");
  insert.run("P-1", "1 MAIN ST", " dv0025961 ", 10000);
  insert.run("P-2", "2 MAIN ST", "DV0025961", 20000);
  insert.run("P-3", "3 MAIN ST", null, 30000);
  const wrap = (sql, binds = []) => ({
    sql, binds, bind: (...params) => wrap(sql, params),
    all: async () => ({ results: db.prepare(sql).all(...binds) }),
    first: async () => db.prepare(sql).get(...binds) ?? null,
    run: async () => ({ success: true, meta: db.prepare(sql).run(...binds) }),
  });
  const env = { INGEST_API_TOKEN: "test-ingest", DB: {
    prepare: sql => wrap(sql),
    batch: async statements => {
      db.exec("BEGIN");
      try {
        const results = statements.map(statement => ({ success: true, meta: db.prepare(statement.sql).run(...statement.binds) }));
        db.exec("COMMIT");
        return results;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } };
  const fetch = async (path, options = {}) => {
    const pending = [];
    const response = await worker.fetch(new Request(`https://buildingseattle.com${path}`, options), env, { waitUntil: p => pending.push(p) });
    await Promise.allSettled(pending);
    return response;
  };
  const ingest = (data = payload(), token = "test-ingest") => fetch("/ingest/development-sites/batch", { method: "POST", headers: { "Content-Type": "application/json", "X-Ingest-Token": token }, body: JSON.stringify(data) });
  return { db, env, fetch, ingest };
}

test("matched site data preserves permit grain, pagination, values and raw references", async () => {
  const { db, fetch, ingest } = fixture();
  try {
    assert.equal((await ingest()).status, 200);
    assert.equal((await ingest()).status, 200); // Retry cannot duplicate a site.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM development_sites").get().n, 1);
    const body = await (await fetch("/api/permits")).json();
    assert.equal(body.total, 3);
    assert.equal(body.results.length, 3);
    const matched = body.results.find(p => p.permit_number === "P-1");
    assert.equal(matched.parcel_number, " dv0025961 ");
    assert.equal(matched.development_site_id, "DV0025961");
    assert.equal(matched.development_site_sqft, 5000);
    assert.equal(matched.development_site_source_updated_at, null);
    assert.equal(matched.development_site_geometry_url, "https://buildingseattle.com/api/development-sites/DV0025961/geometry");
    assert.equal("development_site_has_geometry" in matched, false);
    assert.equal("boundary_geojson" in matched, false);
    assert.equal(body.results.filter(p => p.development_site_id).length, 2);
    assert.equal(body.results.find(p => p.permit_number === "P-3").development_site_sqft, null);
    assert.equal(body.results.reduce((sum, p) => sum + p.value, 0), 60000);
    const page = await (await fetch("/api/permits?per_page=1&page=2")).json();
    assert.equal(page.total, 3);
    assert.equal(page.results.length, 1);
  } finally { db.close(); }
});

test("geometry is a separate live Feature with provenance, nullable source date and 404 behavior", async () => {
  const { db, fetch, ingest } = fixture();
  try {
    await ingest();
    const response = await fetch("/api/development-sites/dv0025961/geometry");
    assert.equal(response.headers.get("Content-Type"), "application/geo+json");
    const feature = await response.json();
    assert.equal(feature.type, "Feature");
    assert.deepEqual(feature.geometry, boundary);
    assert.equal(feature.properties.development_site_source_updated_at, null);
    assert.equal(feature.properties.development_site_fetched_at, fetchedAt);
    assert.match(feature.properties.source_url, /Development_Sites/);
    assert.equal((await fetch("/api/development-sites/DV9999999/geometry")).status, 404);
    await ingest(payload(["DV0025961"], [site("DV0025961", { geometry: null, lot_sqft: null })]));
    assert.equal((await fetch("/api/development-sites/DV0025961/geometry")).status, 404);
    const api = await (await fetch("/api/permits?q=P-1")).json();
    assert.equal(api.results[0].development_site_id, "DV0025961");
    assert.equal(api.results[0].development_site_geometry_url, null);
  } finally { db.close(); }
});

test("reconciliation requires auth and a complete, consistent requested-ID scope", async () => {
  const { db, ingest } = fixture();
  try {
    assert.equal((await ingest(payload(), "incorrect")).status, 401);
    for (const bad of [
      { ...payload(), complete: false }, { ...payload(), sites: null },
      payload(["DV0025961", " dv0025961 "]), payload(["DV0025961"], [site(), site()]),
      payload(["DV0025961"], [site("DV9999999")]),
    ]) assert.equal((await ingest(bad)).status, 400);
    await ingest();
    await ingest(payload(["DV9999999"], []));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM development_sites").get().n, 1, "out-of-scope cached rows survive");
    await ingest(payload(["DV0025961"], []));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM development_sites").get().n, 0, "complete absence removes only the requested cache row");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM permits").get().n, 3);
  } finally { db.close(); }
});

test("a late failure rolls back earlier upserts AND deletions in real SQLite", async () => {
  const { db, ingest } = fixture();
  try {
    await ingest(payload(["DV0025961", "DV9999999"], [site(), site("DV9999999")]));
    db.exec("CREATE TRIGGER fail_site_log BEFORE INSERT ON ingest_logs WHEN NEW.run_type = 'development_sites' BEGIN SELECT RAISE(ABORT, 'forced late failure'); END");
    const response = await ingest(payload(["DV0025961", "DV9999999"], [site("DV0025961", { lot_sqft: 9000 })]));
    assert.equal(response.status, 500);
    assert.equal(db.prepare("SELECT lot_sqft FROM development_sites WHERE site_id = 'DV0025961'").get().lot_sqft, 5000);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM development_sites").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ingest_logs").get().n, 1);
  } finally { db.close(); }
});

test("site refresh does not advance permit freshness or replace newer site records", async () => {
  const { db, env, ingest } = fixture();
  try {
    db.exec("INSERT INTO ingest_logs (run_type, source, status, end_time) VALUES ('scheduled', 'test', 'success', '2026-10-01 13:00:00')");
    await ingest();
    assert.equal((await getCanonicalStats(env)).last_ingest_at, "2026-10-01 13:00:00");
    const older = { ...payload(["DV0025961"], []), fetched_at: "2026-10-01T00:00:00.000Z" };
    await ingest(older);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM development_sites").get().n, 1);
  } finally { db.close(); }
});

test("permit pages render the outline and unavailable state, and MCP inherits fields", async () => {
  const { db, fetch, ingest } = fixture();
  try {
    await ingest();
    const html = await (await fetch("/permits/P-1")).text();
    assert.match(html, /5,000 sq ft/);
    assert.match(html, /Property reference/);
    assert.match(html, /Development-site boundary for DV0025961/);
    assert.match(html, /maps.google.com\/maps/);
    const unmatched = await (await fetch("/permits/P-3")).text();
    assert.match(unmatched, /Development-site information unavailable/);
    const response = await fetch("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_permits", arguments: { q: "P-1" } } }) });
    const result = await response.json();
    assert.equal(result.result.structuredContent.results[0].development_site_sqft, 5000);
  } finally { db.close(); }
});

test("outlines preserve multipart polygons and holes and reject unusable coordinates", () => {
  const outer = boundary.coordinates[0];
  const hole = [[-122.2998, 47.6001], [-122.2996, 47.6001], [-122.2996, 47.6002], [-122.2998, 47.6001]];
  const multi = { type: "MultiPolygon", coordinates: [[outer, hole], [outer.map(([x,y]) => [x + .002, y])]] };
  const svg = renderSiteOutline(multi, "DV0025961");
  assert.equal((svg.match(/<path /g) || []).length, 2);
  assert.equal((svg.match(/ Z/g) || []).length, 3);
  assert.match(svg, /fill-rule="evenodd"/);
  assert.doesNotMatch(svg, /NaN|Infinity/);
  for (const geometry of [null, { type: "Point", coordinates: [0, 0] }, { type: "Polygon", coordinates: [[[1, 2], [1, 2], [1, 2], [1, 2]]] }]) {
    assert.equal(validBoundary(geometry), false);
    assert.equal(renderSiteOutline(geometry, "X"), "");
  }
  assert.throws(() => validateSiteBatch(payload(["DV0025961"], [site("DV0025961", { geometry: { type: "Polygon", coordinates: [["<script>"]] } })])));
  const escaped = renderDevelopmentSiteCard({ development_site_id: "X", development_site_status: "<script>alert(1)</script>" });
  assert.doesNotMatch(escaped, /<script>/);
});

test("public rollout gate keeps enrichment hidden while the authenticated backfill works", async () => {
  const { db, env, ingest, fetch } = fixture();
  try {
    env.DEVELOPMENT_SITES_PUBLIC = "false";
    assert.equal((await ingest()).status, 200);
    let response = await (await fetch("/api/permits")).json();
    assert.equal("development_site_id" in response.results[0], false);
    assert.equal((await fetch("/api/development-sites/DV0025961/geometry")).status, 404);
    const html = await (await fetch("/permits/P-1")).text();
    assert.doesNotMatch(html, /Development-site boundary for/);
    env.DEVELOPMENT_SITES_PUBLIC = "true";
    response = await (await fetch("/api/permits")).json();
    assert.equal(response.results.filter(p => p.development_site_id).length, 2);
  } finally { db.close(); }
});
