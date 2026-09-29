import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.js";

// An address row with no permits left on it has nothing to publish, so the
// route answers 410 instead of a crawlable 200 + noindex.

const addressRow = {
  id: 5,
  slug: "1-empty-ave-seattle-wa",
  display_address: "1 Empty Ave, Seattle, WA",
  normalized_address: "1 EMPTY AVE",
};

function createAddressEnv(permits) {
  const queries = [];
  return {
    queries,
    DB: {
      prepare(query) {
        const sql = query.replace(/\s+/g, " ").trim();
        queries.push(sql);
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            if (sql.includes("FROM addresses WHERE slug")) return addressRow;
            if (sql.includes("FROM neighborhoods n JOIN address_neighborhoods an")) return null;
            return null;
          },
          async all() {
            if (sql.includes("FROM permits p LEFT JOIN contractors c")) return { results: permits };
            return { results: [] };
          },
          async run() {
            return {};
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

test("an address with no permits on record returns 410", async () => {
  const env = createAddressEnv([]);
  const response = await worker.fetch(
    new Request("https://buildingseattle.com/address/1-empty-ave-seattle-wa"),
    env,
    createCtx(),
  );
  const html = await response.text();

  assert.equal(response.status, 410);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(html, /rel="canonical"/);
  assert.match(html, /410/);
});

test("an address with permits still renders the indexable property page", async () => {
  const env = createAddressEnv([
    {
      id: 100,
      permit_number: "1000001-CN",
      address: "1 EMPTY AVE",
      address_id: 5,
      status: "active",
      type: "residential",
      value: 25000,
      issued_date: "2026-02-01",
      description: "Alterations",
    },
  ]);
  const response = await worker.fetch(
    new Request("https://buildingseattle.com/address/1-empty-ave-seattle-wa"),
    env,
    createCtx(),
  );
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<meta name="robots" content="index,follow,max-image-preview:large">/);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/buildingseattle\.com\/address\/1-empty-ave-seattle-wa">/,
  );
});
