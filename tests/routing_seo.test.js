import assert from "node:assert/strict";
import test from "node:test";

import worker, { canonicalRequestPath } from "../worker.js";

// Route-level SEO rules that need no database: URL normalization, status codes
// for out-of-range pages, and crawler headers on machine-readable responses.

const BASE = "https://buildingseattle.com";
const ctx = { waitUntil() {} };

function emptyEnv() {
  const statement = {
    bind: () => statement,
    all: async () => ({ results: [] }),
    first: async () => null,
    run: async () => ({}),
  };
  return { DB: { prepare: () => statement } };
}

test("canonicalRequestPath strips trailing slashes and folds case on page routes only", () => {
  const cases = [
    ["/", "/"],
    ["//", "/"],
    ["/contractors/", "/contractors"],
    ["/Contractors", "/contractors"],
    ["/insights/plan-review/", "/insights/plan-review"],
    ["/address/100-Main-St-Seattle-WA/", "/address/100-main-st-seattle-wa"],
    ["/project/X", "/project/x"],
    ["/permits/", "/permits"],
    ["/permits/1234567-cn", "/permits/1234567-CN"],
    ["/PERMITS/1234567-cn", "/permits/1234567-CN"],
    ["/permits/1234567-CN", "/permits/1234567-CN"],
    // Shapes we cannot vouch for are left exactly as requested.
    ["/permits/Perm123", "/permits/Perm123"],
    ["/brand/fonts/IBMPlexSans-Regular.woff2", "/brand/fonts/IBMPlexSans-Regular.woff2"],
    ["/409508639a064e738971e5aa92be599e.txt", "/409508639a064e738971e5aa92be599e.txt"],
  ];
  for (const [input, expected] of cases) assert.equal(canonicalRequestPath(input), expected, input);
});

test("trailing-slash and mixed-case URLs 301 to the canonical URL, keeping the query", async () => {
  for (const [path, location] of [
    ["/contractors/?page=2", "/contractors?page=2"],
    ["/address/100-MAIN-ST-seattle-wa/", "/address/100-main-st-seattle-wa"],
    ["/permits/7000101-cn", "/permits/7000101-CN"],
    ["/About/", "/about"],
  ]) {
    const response = await worker.fetch(new Request(`${BASE}${path}`), emptyEnv(), ctx);
    assert.equal(response.status, 301, path);
    assert.equal(response.headers.get("Location"), `${BASE}${location}`, path);
  }
});

test("URL normalization never redirects a POST", async () => {
  const response = await worker.fetch(new Request(`${BASE}/alerts/subscribe/`, { method: "POST" }), emptyEnv(), ctx);
  assert.notEqual(response.status, 301);
});

function permitBrowserEnv(total) {
  const statement = {
    bind: () => statement,
    all: async () => ({ results: [] }),
    first: async () => ({ total }),
    run: async () => ({}),
  };
  return { DB: { prepare: () => statement } };
}

test("/permits?page=N past the last page is a 404; the last page still renders", async () => {
  // 120 permits at 50 per page is three pages.
  const last = await worker.fetch(new Request(`${BASE}/permits?page=3`), permitBrowserEnv(120), ctx);
  const lastHtml = await last.text();
  assert.equal(last.status, 200);
  assert.match(lastHtml, /<title>[^<]*— Page 3<\/title>/);
  assert.match(lastHtml, /<link rel="canonical" href="https:\/\/buildingseattle\.com\/permits\?page=3">/);

  const beyond = await worker.fetch(new Request(`${BASE}/permits?page=4`), permitBrowserEnv(120), ctx);
  assert.equal(beyond.status, 404);
  assert.match(await beyond.text(), /<meta name="robots" content="noindex">/);
  const filteredBeyond = await worker.fetch(new Request(`${BASE}/permits?type=commercial&page=9`), permitBrowserEnv(120), ctx);
  assert.equal(filteredBeyond.status, 404);
});
