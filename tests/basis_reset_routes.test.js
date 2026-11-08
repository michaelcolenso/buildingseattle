import test from "node:test";
import assert from "node:assert/strict";
import { renderBasisResetRadarBody, resolveBasisResetTarget } from "../basis_reset_routes.js";

test("radar body uses the site card classes and does not emit a standalone document", () => {
  const html = renderBasisResetRadarBody([{
    event_type: "permit_ready_sale",
    event_date: "2026-09-25",
    display_address: "1412 23RD AVE, SEATTLE, WA",
    address_slug: "1412-23rd-ave-seattle-wa",
    opportunity_score: 37,
    reset_pct: null,
    prior_basis: null,
    asking_price: 9000000,
    reset_score: 20,
    readiness_score: 29,
    signal_score: 91,
    source_url: "https://platform.reverecre.com/project/93f09c8e",
    source_name: "LightBox",
  }]);
  assert.match(html, /class="bs-card"/);
  assert.match(html, /class="ent-link" href="\/address\/1412-23rd-ave-seattle-wa"/);
  assert.match(html, /Basis unknown/);
  assert.match(html, />37</);
  assert.doesNotMatch(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /font-family:Arial/);
  assert.equal(renderBasisResetRadarBody([]), expectEmpty());
});

function expectEmpty() {
  return `<p style="color:var(--text-muted)">No basis-reset events have been scored yet.</p>`;
}

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
