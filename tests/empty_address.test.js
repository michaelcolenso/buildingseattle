import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.js";

// An address row with no permits left on it has nothing to publish, so the
// route answers 410 instead of a crawlable 200 + noindex -- but only while the
// permit -> address links are intact. If the database cannot say (a read
// failed, or permits are still waiting to be linked) the route answers 503 so
// a valid page is never reported to a crawler as gone.

const addressRow = {
  id: 5,
  slug: "1-empty-ave-seattle-wa",
  display_address: "1 Empty Ave, Seattle, WA",
  normalized_address: "1 EMPTY AVE",
};

// `faults` makes a named read throw like a D1 error; `pending` is the answer to
// "is any permit still waiting to be linked to an address?".
function createAddressEnv(permits, { pending = 0, lastRebuild = null, faults = [] } = {}) {
  const queries = [];
  const fault = (sql) => {
    for (const marker of faults) if (sql.includes(marker)) throw new Error(`D1_ERROR: ${marker}`);
  };
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
            fault(sql);
            if (sql.includes("FROM addresses WHERE slug")) return addressRow;
            if (sql.includes("EXISTS(SELECT 1 FROM permits WHERE address_id IS NULL)")) return { pending, last_rebuild: lastRebuild };
            if (sql.includes("FROM neighborhoods n JOIN address_neighborhoods an")) return null;
            return null;
          },
          async all() {
            fault(sql);
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

async function fetchAddress(env) {
  return worker.fetch(new Request("https://buildingseattle.com/address/1-empty-ave-seattle-wa"), env, createCtx());
}

function assertTemporarilyUnavailable(response) {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "3600");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
}

test("an address with no permits answers 503, not 410, while permits are waiting to be linked", async () => {
  const response = await fetchAddress(createAddressEnv([], { pending: 1 }));
  const html = await response.text();

  assertTemporarilyUnavailable(response);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(html, /no permits on record/);
});

test("an address with no permits answers 503, not 410, after a rebuild that did not finish cleanly", async () => {
  for (const lastRebuild of ["error", "partial"]) {
    assertTemporarilyUnavailable(await fetchAddress(createAddressEnv([], { lastRebuild })));
  }
});

test("an address with no permits is 410 when the latest rebuild succeeded or none is logged", async () => {
  for (const lastRebuild of ["success", null]) {
    const response = await fetchAddress(createAddressEnv([], { lastRebuild }));
    assert.equal(response.status, 410);
  }
});

test("an address whose permit read fails answers 503, not 410", async () => {
  const response = await fetchAddress(createAddressEnv([], { faults: ["FROM permits p LEFT JOIN contractors c"] }));
  assertTemporarilyUnavailable(response);
});

test("an address whose integrity check fails answers 503, not 410", async () => {
  const response = await fetchAddress(createAddressEnv([], { faults: ["EXISTS(SELECT 1 FROM permits WHERE address_id IS NULL)"] }));
  assertTemporarilyUnavailable(response);
});

test("an address lookup that fails answers 503, not 404", async () => {
  const response = await fetchAddress(createAddressEnv([], { faults: ["FROM addresses WHERE slug"] }));
  assertTemporarilyUnavailable(response);
});

test("a slug that does not exist is still a 404", async () => {
  const env = createAddressEnv([]);
  const realPrepare = env.DB.prepare;
  env.DB.prepare = (query) => {
    const statement = realPrepare(query);
    const first = statement.first;
    statement.first = async () => (query.includes("FROM addresses WHERE slug") ? null : first());
    return statement;
  };
  const response = await fetchAddress(env);
  assert.equal(response.status, 404);
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
