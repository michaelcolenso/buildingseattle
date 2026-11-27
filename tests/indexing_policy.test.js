import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker, { buildEntityHubQuery, buildEntityHubState } from "../worker.js";
import {
  MULTI_PERMIT_PROJECT_SQL,
  PROJECT_SUBSET_NOINDEX_MAX_PERMITS,
  isPlaceholderAddress,
  isPlaceholderNeighborhood,
  projectPagePolicy,
  realAddressSql,
  realNeighborhoodSql,
} from "../entity_hubs.js";

// Which entity URLs are published is decided in one place (entity_hubs.js)
// and read by the page templates, the sitemaps and the hubs. These tests run
// the real worker against a real SQLite database (production schema plus the
// entity-graph migrations) and hold the three to each other: every sitemapped
// URL answers 200, index, self-canonical; every thin or junk entity is noindex
// and absent from the sitemap and hubs; a failed read is a 503, never a cached
// 200 noindex or a false 404.

const BASE = "https://buildingseattle.com";

function openDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const file of [
    "../schema.sql",
    "../migration_entity_graph.sql",
    "../migration_development_sites.sql",
    "../migration_basis_reset_radar.sql",
    "../migration_basis_reset_discovery.sql",
  ]) {
    db.exec(readFileSync(new URL(file, import.meta.url), "utf8"));
  }
  db.exec("DELETE FROM permits; DELETE FROM contractors; DELETE FROM ingest_logs;");
  return db;
}

// Addresses 1-4, neighborhoods, people/orgs and curated contractors that each
// exercise one publishing rule. Comments name the expected outcome.
function seededDatabase() {
  const db = openDatabase();
  db.exec(`
    INSERT INTO addresses (id, slug, normalized_address, display_address) VALUES
      (1, '100-main-st-seattle-wa', '100 MAIN ST, SEATTLE, WA', '100 MAIN ST, Seattle, WA'),   -- 3 permits: indexed
      (2, '200-pine-st-seattle-wa', '200 PINE ST, SEATTLE, WA', '200 PINE ST, Seattle, WA'),   -- 1 permit: noindex
      (3, 'seattle-seattle-wa', 'SEATTLE, SEATTLE, WA', 'Seattle, Seattle, WA'),               -- city-only bucket: noindex
      (4, '400-oak-st-seattle-wa', '400 OAK ST, SEATTLE, WA', '400 OAK ST, Seattle, WA');      -- 5 permits: indexed
    INSERT INTO neighborhoods (id, slug, name) VALUES
      (1, 'ballard', 'Ballard'),
      (2, 'other-seattle', 'Other Seattle'),   -- geocoder fallback: noindex
      (3, 'emptyville', 'Emptyville');         -- no permits left: 410
    INSERT INTO address_neighborhoods (address_id, neighborhood_id) VALUES (1, 1), (2, 1), (4, 1), (3, 2);
    INSERT INTO contractors (id, name, slug) VALUES
      (10, 'ACME CONSTRUCTION INC', 'acme-construction'),  -- curated, has permits: indexed
      (11, 'DORMANT CO', 'dormant-co');                    -- curated, no permits: noindex
    INSERT INTO permits (id, permit_number, address, address_id, neighborhood, status, type, value, issued_date, contractor_id) VALUES
      (101, '7000101-CN', '100 MAIN ST', 1, 'Ballard', 'active', 'residential', 100000, '2025-01-01', NULL),
      (102, '7000102-CN', '100 MAIN ST', 1, 'Ballard', 'active', 'residential', 100000, '2025-02-01', NULL),
      (103, '7000103-CN', '100 MAIN ST', 1, 'Ballard', 'active', 'residential', 100000, '2025-03-01', NULL),
      (201, '7000201-CN', '200 PINE ST', 2, 'Ballard', 'active', 'residential', 50000, '2025-01-05', NULL),
      (301, '7000301-CN', 'Seattle, WA', 3, 'Other Seattle', 'active', 'commercial', 10, '2025-01-01', NULL),
      (302, '7000302-CN', 'Seattle, WA', 3, 'Other Seattle', 'active', 'commercial', 10, '2025-01-02', NULL),
      (303, '7000303-CN', 'Seattle, WA', 3, 'Other Seattle', 'active', 'commercial', 10, '2025-01-03', NULL),
      (401, '7000401-CN', '400 OAK ST', 4, 'Ballard', 'active', 'residential', 900000, '2024-05-01', NULL),
      (402, '7000402-CN', '400 OAK ST', 4, 'Ballard', 'active', 'residential', 900000, '2025-05-01', NULL),
      (403, '7000403-CN', '400 OAK ST', 4, 'Ballard', 'active', 'residential', 900000, '2026-05-01', 10),
      (404, '7000404-CN', '400 OAK ST', 4, 'Ballard', 'active', 'residential', 300000, '2026-06-01', NULL),
      (405, '7000405-CN', '400 OAK ST', 4, 'Ballard', 'active', 'residential', 300000, '2026-07-01', NULL);
    INSERT INTO projects (id, slug, address_id, name, confidence_score) VALUES
      (1, 'new-construction-at-100-main-st', 1, 'New construction at 100 MAIN ST', 80),  -- whole address: 301
      (2, 'addition-at-200-pine-st', 2, 'Addition at 200 PINE ST', 50),                 -- one permit: 301
      (3, 'new-construction-at-400-oak-st', 4, 'New construction at 400 OAK ST', 80),   -- 3 of 5: indexed
      (4, 'new-construction-at-400-oak-st-2', 4, 'New construction at 400 OAK ST', 70); -- 2 of 5: noindex
    UPDATE permits SET project_id = 1 WHERE id IN (101, 102, 103);
    UPDATE permits SET project_id = 2 WHERE id = 201;
    UPDATE permits SET project_id = 3 WHERE id IN (401, 402, 403);
    UPDATE permits SET project_id = 4 WHERE id IN (404, 405);
    INSERT INTO project_permits (project_id, permit_id) VALUES
      (1, 101), (1, 102), (1, 103), (2, 201), (3, 401), (3, 402), (3, 403), (4, 404), (4, 405),
      (1, 999); -- dangling link to a deleted permit: must not keep project 1 listed
    INSERT INTO people_orgs (id, slug, name, normalized_name, type_guess) VALUES
      (1, 'acme-builders-llc', 'ACME BUILDERS LLC', 'ACME BUILDERS LLC', 'organization'),           -- contractor role: indexed
      (2, 'jane-q-owner', 'JANE Q OWNER', 'JANE Q OWNER', 'person'),                               -- owner only: noindex
      (3, 'acme-construction-inc', 'ACME CONSTRUCTION INC', 'ACME CONSTRUCTION INC', 'organization'); -- curated twin: canonical
    INSERT INTO permit_participants (permit_id, people_org_id, role) VALUES
      (101, 1, 'contractor'), (401, 1, 'contractor'), (201, 2, 'owner'), (402, 3, 'contractor');
  `);
  return db;
}

// D1-shaped wrapper; `faults` lists SQL fragments whose statements throw like a
// D1 error.
function createEnv(db, { faults = [] } = {}) {
  const fault = (sql) => {
    for (const marker of faults) if (sql.includes(marker)) throw new Error(`D1_ERROR: ${marker}`);
  };
  const wrap = (sql, binds = []) => ({
    bind: (...next) => wrap(sql, next),
    all: async () => {
      fault(sql);
      return { results: db.prepare(sql).all(...binds) };
    },
    first: async () => {
      fault(sql);
      return db.prepare(sql).get(...binds) ?? null;
    },
    run: async () => {
      fault(sql);
      db.prepare(sql).run(...binds);
      return { meta: {} };
    },
  });
  return { DB: { prepare: (sql) => wrap(sql) } };
}

const ctx = { waitUntil() {} };

async function get(env, path) {
  const response = await worker.fetch(new Request(`${BASE}${path}`), env, ctx);
  const html = await response.text();
  const robots = html.match(/<meta name="robots" content="([^"]+)">/)?.[1] || null;
  const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)?.[1] || null;
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] || null;
  return { response, html, robots, canonical, title, status: response.status };
}

function isIndexedSelf(page, path) {
  return page.status === 200 && /^index/.test(page.robots || "") && page.canonical === `${BASE}${path}`;
}

async function sitemapUrls(env) {
  const index = await get(env, "/sitemap.xml");
  const children = [...index.html.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const urls = [];
  for (const child of children) {
    const page = await get(env, new URL(child).pathname);
    assert.equal(page.status, 200, child);
    urls.push(...[...page.html.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
  }
  return urls.map((url) => new URL(url).pathname);
}

const NOT_PUBLISHED = [
  "/address/200-pine-st-seattle-wa",
  "/address/seattle-seattle-wa",
  "/neighborhood/other-seattle",
  "/project/new-construction-at-100-main-st",
  "/project/addition-at-200-pine-st",
  "/project/new-construction-at-400-oak-st-2",
  "/contractor/jane-q-owner",
  "/contractor/acme-construction-inc",
  "/contractor/dormant-co",
];
const PUBLISHED = [
  "/address/100-main-st-seattle-wa",
  "/address/400-oak-st-seattle-wa",
  "/neighborhood/ballard",
  "/project/new-construction-at-400-oak-st",
  "/contractor/acme-builders-llc",
  "/contractor/acme-construction",
];

test("every sitemapped entity URL answers 200, index, self-canonical, and thin or junk ones are left out", async () => {
  const env = createEnv(seededDatabase());
  const urls = await sitemapUrls(env);
  const entityUrls = urls.filter((path) => /^\/(address|project|neighborhood|contractor|permits)\//.test(path));
  assert.ok(entityUrls.length > 0);
  for (const path of entityUrls) {
    const page = await get(env, path);
    assert.ok(isIndexedSelf(page, path), `${path} is sitemapped but answers ${page.status} ${page.robots} ${page.canonical}`);
  }
  for (const path of PUBLISHED) assert.ok(urls.includes(path), `${path} should be sitemapped`);
  for (const path of NOT_PUBLISHED) {
    assert.ok(!urls.includes(path), `${path} should not be sitemapped`);
    const page = await get(env, path);
    assert.ok(!isIndexedSelf(page, path), `${path} is not sitemapped but is an indexable self-canonical page`);
  }
});

test("thin and junk entity pages stay reachable but are noindex,follow", async () => {
  const env = createEnv(seededDatabase());
  for (const path of [
    "/address/200-pine-st-seattle-wa",
    "/address/seattle-seattle-wa",
    "/neighborhood/other-seattle",
    "/project/new-construction-at-400-oak-st-2",
    "/contractor/jane-q-owner",
    "/contractor/dormant-co",
  ]) {
    const page = await get(env, path);
    assert.equal(page.status, 200, path);
    assert.equal(page.robots, "noindex,follow", path);
    assert.equal(page.canonical, `${BASE}${path}`, path);
  }
});

test("redirected projects 301 to their address, even with a dangling project_permits row", async () => {
  const env = createEnv(seededDatabase());
  for (const [path, target] of [
    ["/project/new-construction-at-100-main-st", "/address/100-main-st-seattle-wa"],
    ["/project/addition-at-200-pine-st", "/address/200-pine-st-seattle-wa"],
  ]) {
    const page = await get(env, path);
    assert.equal(page.status, 301, path);
    assert.equal(page.response.headers.get("Location"), `${BASE}${target}`);
  }
});

test("an org page that duplicates a curated contractor points its canonical at the curated slug", async () => {
  const page = await get(createEnv(seededDatabase()), "/contractor/acme-construction-inc");
  assert.equal(page.status, 200);
  assert.equal(page.canonical, `${BASE}/contractor/acme-construction`);
});

test("projects that share a generated name get distinct titles", async () => {
  const db = seededDatabase();
  // Make the twin indexable too (3 of 6 permits) so both titles are in play.
  db.exec(`INSERT INTO permits (id, permit_number, address, address_id, status, issued_date, project_id)
           VALUES (406, '7000406-CN', '400 OAK ST', 4, 'active', '2026-08-01', 4);
           INSERT INTO project_permits (project_id, permit_id) VALUES (4, 406);`);
  const env = createEnv(db);
  const a = await get(env, "/project/new-construction-at-400-oak-st");
  const b = await get(env, "/project/new-construction-at-400-oak-st-2");
  assert.equal(a.robots.startsWith("index"), true);
  assert.equal(b.robots.startsWith("index"), true);
  assert.notEqual(a.title, b.title);
  assert.match(a.title, /Permit 7000401-CN/);
  assert.match(b.title, /Permit 7000404-CN/);
  const description = (page) => page.html.match(/<meta name="description" content="([^"]+)">/)[1];
  assert.notEqual(description(a), description(b));
});

test("entity routes answer 503, never a 404 or a 200 noindex, when a lookup fails", async () => {
  const cases = [
    ["/project/new-construction-at-400-oak-st", "FROM projects pr LEFT JOIN addresses a"],
    ["/project/new-construction-at-400-oak-st", "FROM project_permits jp JOIN permits p"],
    ["/neighborhood/ballard", "SELECT * FROM neighborhoods WHERE slug"],
    ["/neighborhood/ballard", "COUNT(DISTINCT p.id) AS permits"],
    ["/neighborhood/ballard", "ORDER BY COALESCE(p.issued_date, p.applied_date) DESC LIMIT 15"],
    ["/contractor/acme-builders-llc", "SELECT * FROM people_orgs WHERE slug"],
    ["/contractor/acme-builders-llc", "AS has_role"],
    ["/contractor/acme-builders-llc", "ORDER BY COALESCE(p.issued_date, p.applied_date) DESC LIMIT 50"],
    ["/contractor/acme-construction", "SELECT * FROM contractors WHERE slug"],
    ["/contractor/acme-construction", "AVG(JulianDay(issued_date)"],
    ["/address/100-main-st-seattle-wa", "FROM addresses WHERE slug"],
    ["/projects", "seo-hub:projects"],
    ["/addresses", "seo-hub:addresses"],
    ["/neighborhoods", "seo-hub:neighborhoods"],
    ["/contractors", "seo-hub:contractors"],
  ];
  for (const [path, fault] of cases) {
    const page = await get(createEnv(seededDatabase(), { faults: [fault] }), path);
    assert.equal(page.status, 503, `${path} with failing ${fault}`);
    assert.equal(page.response.headers.get("Cache-Control"), "no-store");
    assert.equal(page.response.headers.get("Retry-After"), "3600");
  }
});

test("an unknown entity slug is 404 only while the entity graph is settled", async () => {
  const db = seededDatabase();
  const env = createEnv(db);
  for (const path of ["/project/nope", "/neighborhood/nope", "/contractor/nope", "/address/nope"]) {
    assert.equal((await get(env, path)).status, 404, path);
  }
  db.exec(`INSERT INTO ingest_logs (source, run_type, status, start_time) VALUES ('test', 'entity_graph', 'running', '2026-11-27 13:00:00')`);
  for (const path of ["/project/nope", "/neighborhood/nope", "/contractor/nope", "/address/nope"]) {
    const page = await get(env, path);
    assert.equal(page.status, 503, path);
    assert.equal(page.response.headers.get("Cache-Control"), "no-store");
  }
  // A failing integrity check is not "settled" either.
  const page = await get(createEnv(db, { faults: ["run_type = 'entity_graph'"] }), "/project/nope");
  assert.equal(page.status, 503);
});

test("an entity row with no permits left is 410 when the graph is settled and 503 otherwise", async () => {
  const db = seededDatabase();
  assert.equal((await get(createEnv(db), "/neighborhood/emptyville")).status, 410);
  db.exec("INSERT INTO permits (id, permit_number, address) VALUES (900, '7000900-CN', '9 UNLINKED AVE')");
  assert.equal((await get(createEnv(db), "/neighborhood/emptyville")).status, 503);
});

test("paginated hubs past the last page are 404, and each page has its own title", async () => {
  const env = createEnv(seededDatabase());
  assert.equal((await get(env, "/addresses?page=2")).status, 404);
  assert.equal((await get(env, "/projects?page=9")).status, 404);
  const db = seededDatabase();
  // 49 addresses with two permits each fill page 1 and spill onto page 2.
  for (let i = 0; i < 49; i += 1) {
    db.exec(`INSERT INTO addresses (id, slug, normalized_address, display_address)
             VALUES (${1000 + i}, 'addr-${i}', '${i + 1} TEST ST, SEATTLE, WA', '${i + 1} TEST ST, Seattle, WA');
             INSERT INTO permits (permit_number, address, address_id, status) VALUES
               ('8${i}01-CN', 'x', ${1000 + i}, 'active'), ('8${i}02-CN', 'x', ${1000 + i}, 'active');`);
  }
  const paged = createEnv(db);
  const one = await get(paged, "/addresses");
  const two = await get(paged, "/addresses?page=2");
  assert.equal(two.status, 200);
  assert.notEqual(one.title, two.title);
  assert.match(two.title, /— Page 2/);
  assert.equal(two.canonical, `${BASE}/addresses?page=2`);
  assert.match(two.robots, /^index/);
  assert.equal((await get(paged, "/addresses?page=3")).status, 404);
});

test("hubs leave out single-permit addresses, the city-only bucket and placeholder neighborhoods", () => {
  const db = seededDatabase();
  const slugs = (type) => {
    const query = buildEntityHubQuery(type, buildEntityHubState(type, new Request(`${BASE}/${type}`)));
    return db.prepare(query.sql).all(...query.binds).map((row) => row.slug).sort();
  };
  assert.deepEqual(slugs("addresses"), ["100-main-st-seattle-wa", "400-oak-st-seattle-wa"]);
  assert.deepEqual(slugs("neighborhoods"), ["ballard"]);
  assert.deepEqual(slugs("projects"), ["new-construction-at-400-oak-st"]);
});

test("placeholder predicates agree in SQL and JS", () => {
  const db = new DatabaseSync(":memory:");
  const addresses = [
    { normalized_address: "SEATTLE, SEATTLE, WA", city: "Seattle" },
    { normalized_address: "UNKNOWN LOCATION, SEATTLE, WA", city: "Seattle" },
    { normalized_address: "100 MAIN ST, SEATTLE, WA", city: "Seattle" },
    { normalized_address: "SEATTLE", city: null },
    { normalized_address: "BALLARD WAREHOUSE DISTRICT, SEATTLE, WA", city: "Seattle" },
    { normalized_address: "SHORELINE, SHORELINE, WA", city: "Shoreline" },
  ];
  for (const address of addresses) {
    const sqlReal = db.prepare(`SELECT ${realAddressSql("a")} AS real FROM (SELECT ? AS normalized_address, ? AS city) a`)
      .get(address.normalized_address, address.city).real;
    assert.equal(Boolean(sqlReal), !isPlaceholderAddress(address), address.normalized_address);
  }
  for (const name of ["Other Seattle", "other", " Other ", "", null, "Ballard", "Seattle", "Unknown"]) {
    const sqlReal = db.prepare(`SELECT ${realNeighborhoodSql("?")} AS real`).get(name).real;
    assert.equal(Boolean(sqlReal), !isPlaceholderNeighborhood(name), String(name));
  }
});

// Seeded pseudo-random graph: some projects span addresses, some permits have
// no address, some addresses have stray unprojected permits, some links
// dangle. The SQL predicate (what is listed and sitemapped) must agree with
// the page (what answers 200, index, self-canonical) on every project.
function randomGraph(seed, { addresses = 120 } = {}) {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const db = openDatabase();
  const rows = [];
  let permitId = 1;
  let projectId = 1;
  for (let a = 1; a <= addresses; a += 1) {
    rows.push(`INSERT INTO addresses (id, slug, normalized_address, display_address) VALUES (${a}, 'a-${a}', '${a} ST, SEATTLE, WA', '${a} ST');`);
    const clusters = 1 + Math.floor(rand() * 3);
    for (let c = 0; c < clusters; c += 1) {
      const projectAddress = rand() < 0.03 ? "NULL" : a;
      const size = 1 + Math.floor(rand() * 4);
      rows.push(`INSERT INTO projects (id, slug, address_id, name) VALUES (${projectId}, 'p-${projectId}', ${projectAddress}, 'Project ${projectId}');`);
      for (let k = 0; k < size; k += 1) {
        const roll = rand();
        const permitAddress = roll < 0.04 ? "NULL" : roll < 0.08 ? 1 + Math.floor(rand() * addresses) : a;
        rows.push(`INSERT INTO permits (id, permit_number, address, address_id, project_id, status) VALUES (${permitId}, '${permitId}-CN', 'x', ${permitAddress}, ${projectId}, 'active');`);
        rows.push(`INSERT INTO project_permits (project_id, permit_id) VALUES (${projectId}, ${permitId});`);
        permitId += 1;
      }
      if (rand() < 0.05) rows.push(`INSERT INTO project_permits (project_id, permit_id) VALUES (${projectId}, ${900000 + projectId});`);
      projectId += 1;
    }
    if (rand() < 0.1) {
      rows.push(`INSERT INTO permits (id, permit_number, address, address_id, status) VALUES (${permitId}, '${permitId}-CN', 'x', ${a}, 'active');`);
      permitId += 1;
    }
  }
  // Addresses referenced by a permit but outside the loop do not exist; keep
  // every address id real so the page and SQL see the same address rows.
  db.exec(rows.join("\n"));
  return { db, projectCount: projectId - 1 };
}

test("the SQL project predicate and the project page agree on every project of a random graph", async () => {
  for (const seed of [7, 42, 2026]) {
    const { db, projectCount } = randomGraph(seed);
    const listed = new Set(
      db.prepare(`SELECT pr.slug FROM projects pr WHERE ${MULTI_PERMIT_PROJECT_SQL}`).all().map((row) => row.slug),
    );
    const env = createEnv(db);
    let indexed = 0;
    for (let id = 1; id <= projectCount; id += 1) {
      const path = `/project/p-${id}`;
      const page = await get(env, path);
      assert.ok([200, 301, 410].includes(page.status), `${path} answered ${page.status}`);
      const pageIndexed = isIndexedSelf(page, path);
      if (pageIndexed) indexed += 1;
      assert.equal(listed.has(`p-${id}`), pageIndexed, `seed ${seed} ${path}: listed=${listed.has(`p-${id}`)} page=${page.status} ${page.robots} ${page.canonical}`);
    }
    assert.ok(indexed > 0, "the graph has some indexable projects");
    assert.ok(indexed < projectCount, "and some that are not");
  }
});

test("projectPagePolicy encodes the subset threshold", () => {
  const at = (n, addressId = 1) => Array.from({ length: n }, (_, i) => ({ id: i, address_id: addressId }));
  const policy = (n, count) => projectPagePolicy({ permits: at(n), addressId: 1, addressSlug: "a", addressPermitCount: count }).action;
  assert.equal(policy(1, 1), "redirect");
  assert.equal(policy(2, 2), "redirect");
  assert.equal(policy(PROJECT_SUBSET_NOINDEX_MAX_PERMITS, 5), "noindex");
  assert.equal(policy(PROJECT_SUBSET_NOINDEX_MAX_PERMITS + 1, 5), "index");
  assert.equal(projectPagePolicy({ permits: [...at(1), ...at(1, 2)], addressId: 1, addressSlug: "a" }).action, "index");
});

function seedBasisReset(db) {
  db.exec(`
    INSERT INTO basis_reset_events (id, address_id, project_id, event_type, event_date, prior_basis, current_basis, source_url) VALUES
      (1, 4, 3, 'sale', '2026-01-01', 2000000, 1500000, 'https://example.com/a'),  -- indexed project
      (2, 2, 2, 'sale', '2026-01-02', 900000, 600000, 'https://example.com/b'),    -- project redirects to its address
      (3, 4, 4, 'listing', '2026-01-03', 800000, 700000, 'https://example.com/c'); -- noindex subset project
    INSERT INTO basis_reset_scores (address_id, project_id, latest_event_id, reset_pct, reset_score, readiness_score, signal_score, opportunity_score) VALUES
      (4, 3, 1, 25, 60, 60, 60, 90),
      (2, 2, 2, 33, 70, 50, 50, 80),
      (4, 4, 3, 12, 40, 40, 40, 70);
  `);
  return db;
}

test("Basis Reset links only indexable project pages; others link the address (D11)", async () => {
  const page = await get(createEnv(seedBasisReset(seededDatabase())), "/insights/basis-reset");
  assert.equal(page.status, 200);
  assert.match(page.robots, /^index/);
  const hrefs = [...page.html.matchAll(/class="ent-link" href="(\/(?:project|address)\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, [
    "/project/new-construction-at-400-oak-st",
    "/address/200-pine-st-seattle-wa",
    "/address/400-oak-st-seattle-wa",
  ]);
  const env = createEnv(seedBasisReset(seededDatabase()));
  for (const href of hrefs) assert.equal((await get(env, href)).status, 200, href);
});

test("an empty Basis Reset Radar is noindex and left out of the sitemap; a scored one is listed (E9)", async () => {
  const empty = createEnv(seededDatabase());
  const emptyPage = await get(empty, "/insights/basis-reset");
  assert.equal(emptyPage.status, 200);
  assert.equal(emptyPage.robots, "noindex,follow");
  assert.doesNotMatch((await get(empty, "/sitemaps/static.xml")).html, /insights\/basis-reset/);

  const scored = createEnv(seedBasisReset(seededDatabase()));
  assert.match((await get(scored, "/sitemaps/static.xml")).html, /<loc>https:\/\/buildingseattle\.com\/insights\/basis-reset<\/loc>/);

  const failing = createEnv(seedBasisReset(seededDatabase()), { faults: ["SELECT 1 AS present FROM basis_reset_scores"] });
  const fallback = await get(failing, "/sitemaps/static.xml");
  assert.equal(fallback.status, 200);
  assert.doesNotMatch(fallback.html, /insights\/basis-reset/);
});

test("permit pages link only neighborhood pages the graph built, never placeholder or derived slugs (E10)", async () => {
  const db = seededDatabase();
  // Free-text neighborhood with no graph page behind it.
  db.exec(`
    INSERT INTO addresses (id, slug, normalized_address, display_address) VALUES (5, '500-elm-st-seattle-wa', '500 ELM ST, SEATTLE, WA', '500 ELM ST, Seattle, WA');
    INSERT INTO permits (id, permit_number, address, address_id, neighborhood, status, type) VALUES
      (501, '7000501-CN', '500 ELM ST', 5, 'Lower Queen Anne', 'active', 'residential');
  `);
  const env = createEnv(db);
  const neighborhoodLinks = async (number) =>
    [...(await get(env, `/permits/${number}`)).html.matchAll(/href="(\/neighborhood\/[^"]+)"/g)].map((m) => m[1]);

  assert.deepEqual(await neighborhoodLinks("7000101-CN"), ["/neighborhood/ballard"]);
  assert.equal((await get(env, "/neighborhood/ballard")).status, 200);
  assert.deepEqual(await neighborhoodLinks("7000301-CN"), [], "Other Seattle is not linked");
  assert.deepEqual(await neighborhoodLinks("7000501-CN"), [], "no graph neighborhood, no link");
  assert.equal((await get(env, "/neighborhood/lower-queen-anne")).status, 404);
});
