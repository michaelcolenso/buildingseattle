import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  detectNeighborhood,
  legacyMapPermitStatus,
  mapPermitStatus,
  mapSdciStatus,
  NEIGHBORHOOD_BOUNDS,
  SDCI_MAPPINGS,
  statusFromRawSql,
} from "../sdci_mappings.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/sdci_mapping_cases.json", import.meta.url), "utf8"));
const area = ([, minLat, maxLat, minLng, maxLng]) => (maxLat - minLat) * (maxLng - minLng);

test("status map is an exact match on the whole SDCI value (shared fixture)", () => {
  for (const [raw, expected] of cases.statuses) {
    assert.equal(mapPermitStatus(raw), expected, `status ${JSON.stringify(raw)}`);
  }
});

test("Application Completed is no longer 'completed'; Withdrawn and friends no longer 'new'", () => {
  // The old substring cascade, kept only to recognise remaps, shows the bugs.
  assert.equal(legacyMapPermitStatus("Application Completed"), "completed");
  assert.equal(legacyMapPermitStatus("Withdrawn"), "new");
  assert.equal(legacyMapPermitStatus("Corrections Required"), "new");
  assert.equal(mapPermitStatus("Application Completed"), "pending");
  assert.equal(mapPermitStatus("Withdrawn"), "cancelled");
  assert.equal(mapPermitStatus("Corrections Required"), "pending");
});

test("unknown statuses are flagged so the ingest can log them", () => {
  assert.deepEqual(mapSdciStatus("Issued"), { status: "active", known: true });
  assert.deepEqual(mapSdciStatus("Brand New Status"), { status: "pending", known: false });
});

test("neighborhood points resolve as expected (shared fixture)", () => {
  for (const [lat, lng, expected] of cases.points) {
    assert.equal(detectNeighborhood(lat, lng), expected, `point ${lat},${lng}`);
  }
});

test("neighborhood boxes are listed smallest first", () => {
  for (let i = 1; i < NEIGHBORHOOD_BOUNDS.length; i++) {
    assert.ok(
      area(NEIGHBORHOOD_BOUNDS[i]) >= area(NEIGHBORHOOD_BOUNDS[i - 1]) - 1e-12,
      `${NEIGHBORHOOD_BOUNDS[i][0]} must not precede a smaller box`,
    );
  }
});

test("every neighborhood box can be assigned (none is fully shadowed)", () => {
  const unreachable = [];
  for (const box of NEIGHBORHOOD_BOUNDS) {
    const [name, minLat, maxLat, minLng, maxLng] = box;
    let reached = false;
    for (let i = 0; i <= 20 && !reached; i++) {
      for (let j = 0; j <= 20 && !reached; j++) {
        const lat = minLat + ((maxLat - minLat) * i) / 20;
        const lng = minLng + ((maxLng - minLng) * j) / 20;
        reached = detectNeighborhood(lat, lng) === name;
      }
    }
    if (!reached) unreachable.push(name);
  }
  assert.deepEqual(unreachable, []);
  assert.equal(new Set(NEIGHBORHOOD_BOUNDS.map(([name]) => name)).size, NEIGHBORHOOD_BOUNDS.length);
});

test("the status backfill SQL is generated from the map and recomputes statuses in SQLite", () => {
  const committed = readFileSync(new URL("../scripts/sql/status_backfill.sql", import.meta.url), "utf8");
  const expr = statusFromRawSql("status_raw");
  assert.ok(committed.includes(`SET status = ${expr},`), "backfill SET clause matches data/sdci_mappings.json");
  assert.ok(committed.includes(`AND status IS NOT ${expr};`), "backfill WHERE clause matches data/sdci_mappings.json");

  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE permits (id INTEGER PRIMARY KEY, status TEXT, status_raw TEXT, updated_at TEXT)");
  const insert = db.prepare("INSERT INTO permits (status, status_raw, updated_at) VALUES (?, ?, 'old')");
  for (const [raw] of cases.statuses) insert.run("completed", raw);
  db.exec(committed);
  const rows = db.prepare("SELECT status, status_raw, updated_at FROM permits ORDER BY id").all();
  rows.forEach((row, index) => {
    const [raw, expected] = cases.statuses[index];
    if (raw === null) {
      assert.equal(row.status, "completed", "rows without a raw status are left alone");
      assert.equal(row.updated_at, "old");
    } else {
      // SQL folds case/trims but does not collapse inner whitespace; the fixture has none.
      assert.equal(row.status, expected, `backfill ${JSON.stringify(raw)}`);
      assert.equal(row.updated_at === "old", expected === "completed", "only changed rows are touched");
    }
  });
});

test("the JSON file documents its own resolution rule", () => {
  assert.ok(SDCI_MAPPINGS._comment.join(" ").includes("smallest area first"));
  assert.equal(SDCI_MAPPINGS.unknown_status, "pending");
});
