import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker, { buildEntityHubQuery, buildEntityHubState } from "../worker.js";
import { developmentSiteColumns, developmentSiteJoin } from "../development_sites.js";

// A cluster of one permit is not a project: it repeats the record the address
// page already publishes. Nor is a cluster holding every permit at its address
// and nothing else. These tests pin the two halves of that rule — the
// duplicate redirects to the property page, and every project listing
// (sitemap, hub, address page, permit page) only surfaces real projects.

const workerSource = readFileSync(new URL("../worker.js", import.meta.url), "utf8");

function multiPermitPredicate() {
  const match = workerSource.match(/const MULTI_PERMIT_PROJECT_SQL =\s*"([^"]+)";/);
  assert.ok(match, "MULTI_PERMIT_PROJECT_SQL is declared in worker.js");
  return match[1];
}

// Every query written as `${MULTI_PERMIT_PROJECT_SQL}` in the worker, with the
// predicate substituted, so the tests run the shipped SQL rather than a copy.
function queriesEmbeddingPredicate() {
  const token = "${MULTI_PERMIT_PROJECT_SQL}";
  const parts = workerSource.split(token);
  const queries = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    const before = parts[index];
    const after = parts[index + 1];
    const open = before.lastIndexOf("`");
    const close = after.indexOf("`");
    assert.ok(open !== -1 && close !== -1, `query ${index} is a template literal`);
    queries.push((before.slice(open + 1) + multiPermitPredicate() + after.slice(0, close))
      .replaceAll("${developmentSiteColumns()}", developmentSiteColumns())
      .replaceAll("${developmentSiteJoin()}", developmentSiteJoin()));
  }
  return queries;
}

function seededDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`
    INSERT INTO addresses (id, slug, display_address, normalized_address)
      VALUES (1, '1-single-ave-seattle-wa', '1 Single Ave', '1 SINGLE AVE'),
             (2, '2-double-ave-seattle-wa', '2 Double Ave', '2 DOUBLE AVE'),
             (3, '3-whole-ave-seattle-wa', '3 Whole Ave', '3 WHOLE AVE');
    INSERT INTO projects (id, slug, address_id, name, confidence_score)
      VALUES (10, 'single-permit-cluster', 1, 'Single permit cluster', 50),
             (11, 'two-permit-project', 2, 'Two permit project', 85),
             (12, 'whole-address-cluster', 3, 'Whole address cluster', 80);
    INSERT INTO permits (id, permit_number, address, address_id, project_id, status, issued_date)
      VALUES (100, '1000001-CN', '1 SINGLE AVE', 1, 10, 'active', '2026-01-01'),
             (101, '1000002-CN', '2 DOUBLE AVE', 2, 11, 'active', '2026-01-02'),
             (102, '1000003-CN', '2 DOUBLE AVE', 2, 11, 'active', '2026-01-03'),
             (103, '1000004-CN', '2 DOUBLE AVE', 2, NULL, 'active', '2026-01-04'),
             (104, '1000005-CN', '3 WHOLE AVE', 3, 12, 'active', '2026-01-05'),
             (105, '1000006-CN', '3 WHOLE AVE', 3, 12, 'active', '2026-01-06');
    INSERT INTO project_permits (project_id, permit_id)
      VALUES (10, 100), (11, 101), (11, 102), (12, 104), (12, 105);
  `);
  return db;
}

function createProjectEnv(permits, addressPermitTotal = permits.length + 1) {
  return {
    DB: {
      prepare(query) {
        const sql = query.replace(/\s+/g, " ").trim();
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            if (sql.includes("FROM projects pr LEFT JOIN addresses a")) {
              return {
                id: 10,
                slug: "single-permit-cluster",
                name: "Addition at 1 Single Ave",
                address_id: 1,
                address_slug: "1-single-ave-seattle-wa",
                display_address: "1 Single Ave, Seattle, WA",
                confidence_score: 50,
                total_estimated_value: 5000,
                description_summary: "Add a dormer.",
              };
            }
            if (sql.includes("FROM neighborhoods n")) return null;
            if (sql.includes("SELECT COUNT(*) AS total FROM permits WHERE address_id = ?")) {
              if (addressPermitTotal instanceof Error) throw addressPermitTotal;
              return { total: addressPermitTotal };
            }
            throw new Error(`unexpected first() query: ${sql}`);
          },
          async all() {
            if (sql.includes("FROM project_permits jp JOIN permits p")) return { results: permits };
            if (sql.includes("FROM project_participants pp")) return { results: [] };
            throw new Error(`unexpected all() query: ${sql}`);
          },
        };
        return statement;
      },
    },
  };
}

function createCtx() {
  return { waitUntil() {} };
}

async function fetchProject(permits, addressPermitTotal) {
  const response = await worker.fetch(
    new Request("https://buildingseattle.com/project/single-permit-cluster"),
    createProjectEnv(permits, addressPermitTotal),
    createCtx(),
  );
  return { response, html: await response.text() };
}

const onePermit = [{ id: 100, permit_number: "1000001-CN", status: "active", type: "residential", address_id: 1 }];
const twoPermits = [
  ...onePermit,
  { id: 101, permit_number: "1000002-CN", status: "active", type: "residential", address_id: 1 },
];

test("a one-permit project redirects to its address page", async () => {
  const { response, html } = await fetchProject(onePermit);

  assert.equal(response.status, 301);
  assert.equal(response.headers.get("Location"), "https://buildingseattle.com/address/1-single-ave-seattle-wa");
  // Not pinned forever: the URL is a real page again once a second permit joins.
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
  assert.equal(html, "");
});

test("a one-permit project whose permit is not linked to that address stays a page", async () => {
  // The address page is only certain to render when the permit is linked to
  // it; otherwise keep the canonicalized page rather than redirect blind.
  for (const permit of [{ ...onePermit[0], address_id: 2 }, { ...onePermit[0], address_id: null }]) {
    const { response, html } = await fetchProject([permit]);

    assert.equal(response.status, 200);
    assert.match(
      html,
      /<link rel="canonical" href="https:\/\/buildingseattle\.com\/address\/1-single-ave-seattle-wa">/,
    );
    assert.match(html, /<meta name="robots" content="index,follow,max-image-preview:large">/);
  }
});

test("a project whose permits cannot be read is not redirected", async () => {
  const { response } = await fetchProject([]);

  assert.notEqual(response.status, 301);
  assert.equal(response.headers.get("Location"), null);
});

test("a multi-permit project keeps a self-referencing canonical", async () => {
  const { response, html } = await fetchProject(twoPermits);

  assert.equal(response.status, 200);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/buildingseattle\.com\/project\/single-permit-cluster">/,
  );
  assert.match(html, /<meta name="robots" content="index,follow,max-image-preview:large">/);
});

test("a multi-permit project holding every permit at its address redirects there", async () => {
  const { response, html } = await fetchProject(twoPermits, 2);

  assert.equal(response.status, 301);
  assert.equal(response.headers.get("Location"), "https://buildingseattle.com/address/1-single-ave-seattle-wa");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
  assert.equal(html, "");
});

test("a whole-address project stays a page when the address count cannot be read", async () => {
  const { response } = await fetchProject(twoPermits, new Error("D1 unavailable"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Location"), null);
});

test("a multi-permit project spanning another address stays a page", async () => {
  const spanning = [twoPermits[0], { ...twoPermits[1], address_id: 2 }];
  const { response, html } = await fetchProject(spanning, 2);

  assert.equal(response.status, 200);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/buildingseattle\.com\/project\/single-permit-cluster">/,
  );
});

test("project listings and the project sitemap skip single-permit clusters", () => {
  const db = seededDatabase();
  const queries = queriesEmbeddingPredicate();
  assert.ok(queries.length >= 5, `expected the predicate in worker queries, saw ${queries.length}`);

  for (const sql of queries) {
    const placeholders = (sql.match(/\?/g) || []).length;
    const rows = db.prepare(sql).all(...Array.from({ length: placeholders }, () => 2));
    const slugs = rows.map((row) => row.slug ?? row.permit_number);
    assert.ok(
      !slugs.includes("single-permit-cluster"),
      `single-permit cluster leaked into: ${sql.trim().slice(0, 80)}`,
    );
    assert.ok(
      !slugs.includes("whole-address-cluster"),
      `whole-address cluster leaked into: ${sql.trim().slice(0, 80)}`,
    );
  }

  // The property page still lists the real project on the same address.
  const addressProjects = queries.find((sql) => sql.includes("pr.address_id = ?"));
  assert.ok(addressProjects, "the address page project query carries the predicate");
  assert.deepEqual(
    db.prepare(addressProjects).all(2).map((row) => row.slug),
    ["two-permit-project"],
  );

  const withPredicate = (sql) => sql.replaceAll("${MULTI_PERMIT_PROJECT_SQL}", multiPermitPredicate());
  const sitemapRows = withPredicate(workerSource.split("/* sitemap:rows:projects */")[1].split("`")[0]);
  const sitemapStats = withPredicate(workerSource.split("/* sitemap:stats:projects */")[1].split("`")[0]);
  assert.deepEqual(
    db.prepare(sitemapRows).all(50, 0).map((row) => row.slug),
    ["two-permit-project"],
  );
  assert.equal(db.prepare(sitemapStats).all()[0].total, 1);

  db.close();
});

test("the /projects hub only lists multi-permit groups", () => {
  const db = seededDatabase();
  const query = buildEntityHubQuery("projects", buildEntityHubState("projects", new Request("https://buildingseattle.com/projects")));
  assert.match(query.sql, /> 1/);
  const rows = db.prepare(query.sql).all(...query.binds);
  assert.deepEqual(rows.map((row) => row.slug), ["two-permit-project"]);
  db.close();
});
