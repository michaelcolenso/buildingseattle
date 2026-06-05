import assert from "node:assert/strict";
import test from "node:test";

import {
  makeSlug,
  dedupeSlug,
  parseAddress,
  normalizeOrgName,
  guessOrgType,
  scorePair,
  clusterPermits,
  projectNameFor,
  buildEntityGraph,
} from "../entity_graph.js";

test("makeSlug lowercases, strips punctuation and collapses whitespace", () => {
  assert.equal(makeSlug("  Smith & Sons, LLC!! "), "smith-sons-llc");
  assert.equal(makeSlug("6737 6th AVE NW, Seattle, WA"), "6737-6th-ave-nw-seattle-wa");
});

test("dedupeSlug appends numeric suffixes on collision", () => {
  const taken = new Set();
  assert.equal(dedupeSlug("acme", taken), "acme");
  assert.equal(dedupeSlug("acme", taken), "acme-2");
  assert.equal(dedupeSlug("acme", taken), "acme-3");
});

test("parseAddress extracts street, city, state, zip and a stable normalized key", () => {
  const a = parseAddress("3703 14TH AVE S, SEATTLE, WA 98108");
  assert.equal(a.city, "SEATTLE");
  assert.equal(a.state, "WA");
  assert.equal(a.zip, "98108");
  const b = parseAddress("3703 14th Ave S, Seattle, WA");
  // case variants normalize to the same dedup key
  assert.equal(a.normalized_address, b.normalized_address);
});

test("guessOrgType distinguishes organizations from people", () => {
  assert.equal(guessOrgType("Pacific Northwest Builders LLC"), "organization");
  assert.equal(guessOrgType("Seattle Construction Group"), "organization");
  assert.equal(guessOrgType("Jane Smith"), "person");
  assert.equal(normalizeOrgName(" jane  smith "), "JANE SMITH");
});

test("scorePair clusters same-address permits that are close in time and type", () => {
  const a = { type: "residential", description: "Construct new townhouse", issued_date: "2026-01-01", contractor_name: "Acme" };
  const b = { type: "residential", description: "Construct new townhouse building", issued_date: "2026-03-01", contractor_name: "Acme" };
  assert.ok(scorePair(a, b) >= 70);

  const far = { type: "demolition", description: "Demolish structure", issued_date: "2016-01-01" };
  assert.ok(scorePair(a, far) < 70);
});

test("clusterPermits separates unrelated activity at the same address", () => {
  const permits = [
    { id: 1, type: "residential", description: "Construct new townhouse", issued_date: "2026-01-01", contractor_name: "Acme" },
    { id: 2, type: "residential", description: "Construct new townhouse phase 2", issued_date: "2026-02-15", contractor_name: "Acme" },
    { id: 3, type: "demolition", description: "Demolish old shed", issued_date: "2010-06-01" },
  ];
  const clusters = clusterPermits(permits);
  assert.equal(clusters.length, 2);
});

test("projectNameFor picks a descriptive prefix", () => {
  assert.match(projectNameFor([{ description: "Tenant improvement for office" }], "401 5th Ave"), /^Tenant improvement at 401 5th Ave/);
  assert.match(projectNameFor([{ description: "Construct new building" }], "1301 Second Ave"), /^New construction at 1301 Second Ave/);
  assert.match(projectNameFor([{ description: "routine work" }], "900 Pine St"), /^Construction activity at 900 Pine St/);
});

test("buildEntityGraph preserves previously-minted slugs", () => {
  const permits = [
    { id: 1, address: "100 Main St, Seattle, WA", type: "commercial", description: "x", issued_date: "2026-01-01", contractor_name: "Acme Builders LLC" },
  ];
  const a1 = parseAddress("100 Main St, Seattle, WA").normalized_address;
  const g = buildEntityGraph(permits, {
    addressSlugByNorm: new Map([[a1, "legacy-address-slug"]]),
    orgSlugByNorm: new Map([[normalizeOrgName("Acme Builders LLC"), "legacy-org-slug"]]),
  });
  assert.equal(g.addresses[0].slug, "legacy-address-slug");
  assert.equal(g.peopleOrgs[0].slug, "legacy-org-slug");
});

test("buildEntityGraph produces a connected graph from permit rows", () => {
  const permits = [
    {
      id: 1,
      address: "2201 Westlake Ave, Seattle, WA",
      neighborhood: "South Lake Union",
      type: "commercial",
      value: 5000000,
      description: "Tenant improvement for retail",
      issued_date: "2026-01-10",
      contractor_name: "Seattle Construction Group",
      owner_name: "Westlake Holdings LLC",
    },
    {
      id: 2,
      address: "2201 WESTLAKE AVE, SEATTLE, WA",
      neighborhood: "South Lake Union",
      type: "commercial",
      value: 1200000,
      description: "Tenant improvement phase 2",
      issued_date: "2026-03-01",
      contractor_name: "Seattle Construction Group",
    },
    {
      id: 3,
      address: "900 Pine St, Seattle, WA",
      neighborhood: "Downtown",
      type: "residential",
      value: 800000,
      description: "Electrical upgrade",
      issued_date: "2026-02-01",
      contractor_name: "Emerald City Electric",
    },
  ];

  const g = buildEntityGraph(permits);

  // Two distinct addresses (case variants merge).
  assert.equal(g.addresses.length, 2);
  // Permits 1 & 2 share an address and cluster into one project.
  assert.equal(g.permitAddress.get(1), g.permitAddress.get(2));
  assert.equal(g.permitProject.get(1), g.permitProject.get(2));
  assert.notEqual(g.permitProject.get(1), g.permitProject.get(3));
  // people_orgs include the contractors and the owner.
  const names = g.peopleOrgs.map((o) => o.name).sort();
  assert.ok(names.includes("Seattle Construction Group"));
  assert.ok(names.includes("Westlake Holdings LLC"));
  // Neighborhoods derived.
  assert.equal(g.neighborhoods.length, 2);
  // Every permit is assigned to a project (no orphans in the model).
  assert.equal(g.permitProject.size, 3);
  // Project for the Westlake address totals both permits' values.
  const westlakeProject = g.projects.find((p) => p.permitIds.includes(1));
  assert.equal(westlakeProject.total_estimated_value, 6200000);
  assert.match(westlakeProject.name, /Westlake Ave/);
});
