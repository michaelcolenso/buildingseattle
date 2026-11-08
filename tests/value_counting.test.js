import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { countedTotal, countedValueSql, countedValues } from "../value_counting.js";
import { buildEntityGraph } from "../entity_graph.js";

// 4747 30th Ave NE pattern: one MUP valuation on every demolition permit.
const fixtures = [
  { id: 1, permit_number: "7009320-DM", address_id: 10, value: 129000000 },
  { id: 2, permit_number: "7009657-DM", address_id: 10, value: 129000000 },
  { id: 3, permit_number: "7009658-DM", address_id: 10, value: 129000000 },
  // A demolition that copies a construction permit's value at the same address.
  { id: 4, permit_number: "7100001-CN", address_id: 20, value: 13000000 },
  { id: 5, permit_number: "7100002-DM", address_id: 20, value: 13000000 },
  // Townhouses: identical construction values are separate buildings, all counted.
  { id: 6, permit_number: "7200001-CN", address_id: 30, value: 450000 },
  { id: 7, permit_number: "7200002-CN", address_id: 30, value: 450000 },
  // Same value at a different address is unrelated.
  { id: 8, permit_number: "7300001-DM", address_id: 40, value: 129000000 },
  // A demolition with its own value, and edge cases.
  { id: 9, permit_number: "7400001-DM", address_id: 50, value: 25000 },
  { id: 10, permit_number: "7500001-DM", address_id: null, value: 5000 },
  { id: 11, permit_number: "7500002-DM", address_id: null, value: 5000 },
  { id: 12, permit_number: "7600001-DM", address_id: 60, value: null },
];

const expected = new Map([
  [1, 129000000], [2, 0], [3, 0],
  [4, 13000000], [5, 0],
  [6, 450000], [7, 450000],
  [8, 129000000],
  [9, 25000],
  [10, 5000], [11, 5000],
  [12, 0],
]);

test("countedValues counts a repeated demolition valuation once per address", () => {
  assert.deepEqual(countedValues(fixtures), expected);
  assert.equal(countedTotal(fixtures), 129000000 + 13000000 + 900000 + 129000000 + 25000 + 10000);
});

test("countedValueSql matches countedValues in SQLite", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE permits (id INTEGER PRIMARY KEY, permit_number TEXT, address_id INTEGER, value REAL)");
  const insert = db.prepare("INSERT INTO permits (id, permit_number, address_id, value) VALUES (?, ?, ?, ?)");
  for (const p of fixtures) insert.run(p.id, p.permit_number, p.address_id, p.value);

  const rows = db.prepare(`SELECT p.id, ${countedValueSql("p")} AS counted FROM permits p ORDER BY p.id`).all();
  assert.deepEqual(new Map(rows.map((r) => [r.id, r.counted])), expected);

  // Unaliased form, as used by queries that read FROM permits directly.
  const total = db.prepare(`SELECT SUM(${countedValueSql("permits")}) AS t FROM permits`).get().t;
  assert.equal(total, countedTotal(fixtures));
});

test("project totals in the entity graph count repeated demolition valuations once", () => {
  const permits = [1, 2, 3].map((i) => ({
    id: i,
    permit_number: `700932${i}-DM`,
    address: "4747 30TH AVE NE, SEATTLE, WA",
    type: "demolition",
    value: 129000000,
    status: "active",
    description: `Master Use Permit Demolition of student housing apartment (Bldg. ${i}), per plan`,
    issued_date: `2025-10-0${i}`,
  }));
  const graph = buildEntityGraph(permits);
  const totals = graph.projects.map((p) => p.total_estimated_value);
  assert.equal(Math.max(...totals), 129000000);
  assert.equal(totals.reduce((a, b) => a + b, 0), 129000000);
});
