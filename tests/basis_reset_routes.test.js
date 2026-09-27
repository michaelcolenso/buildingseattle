import test from "node:test";
import assert from "node:assert/strict";
import { resolveBasisResetTarget } from "../basis_reset_routes.js";

function envWith(rows = {}) {
  return {
    DB: {
      prepare(sql) {
        let params = [];
        return {
          bind(...values) { params = values; return this; },
          async first() {
            if (sql.includes("FROM projects")) return rows.project || null;
            if (sql.includes("FROM addresses WHERE id")) return rows.addressById || null;
            if (sql.includes("UPPER(normalized_address)")) return rows.addressByText || null;
            return null;
          },
        };
      },
    },
  };
}

test("resolves an explicit project before falling back to address", async () => {
  const target = await resolveBasisResetTarget(envWith({
    project: { project_id: 8, address_id: 4, name: "Ready Site", display_address: "100 Pine St" },
  }), { project_id: 8, address: "wrong address" });
  assert.equal(target.project_id, 8);
  assert.equal(target.address_id, 4);
});

test("resolves an existing entity-graph address from text", async () => {
  const target = await resolveBasisResetTarget(envWith({
    addressByText: { address_id: 12, display_address: "600 Stewart St, Seattle, WA" },
  }), { address: "600 Stewart St, Seattle, WA" });
  assert.equal(target.address_id, 12);
});

test("returns null for unmatched properties instead of creating a parallel identity", async () => {
  assert.equal(await resolveBasisResetTarget(envWith(), { address: "not in graph" }), null);
});
