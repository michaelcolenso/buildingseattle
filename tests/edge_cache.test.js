import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.js";
import {
  allowedHtmlCacheParams,
  dataDay,
  edgeCacheControl,
  edgeHtmlTtl,
  hardenAdminResponse,
  htmlCacheKeyUrl,
  htmlCacheVersion,
  isAdminPath,
  isNoindexResponse,
  pageCacheTtl,
} from "../edge_cache.js";

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const opts = { version: "v10", day: "2026-11-27" };

test("cache keys keep only the params a route reads, sorted, and drop tracking params", () => {
  const a = htmlCacheKeyUrl("https://buildingseattle.com/permits?type=residential&utm_source=x&page=2&fbclid=abc&gclid=1&cb=9", opts);
  const b = htmlCacheKeyUrl("https://buildingseattle.com/permits?page=2&type=residential", opts);
  assert.equal(a.url, b.url);
  assert.equal(a.url, "https://buildingseattle.com/permits?page=2&type=residential&__bsv=v10&__bsd=2026-11-27");
  assert.equal(a.droppedParams, true);
  assert.equal(b.droppedParams, false);

  // Entity pages read no params at all.
  const entity = htmlCacheKeyUrl("https://buildingseattle.com/address/1-main-st-seattle-wa?utm_medium=email&x=1", opts);
  assert.equal(entity.url, "https://buildingseattle.com/address/1-main-st-seattle-wa?__bsv=v10&__bsd=2026-11-27");
  assert.equal(entity.droppedParams, true);

  // Each hub keeps its own filters only.
  assert.deepEqual(allowedHtmlCacheParams("/projects/"), ["page", "sort", "view", "min_value"]);
  const hub = htmlCacheKeyUrl("https://buildingseattle.com/contractors?sort=value&page=3&view=active", opts);
  assert.equal(hub.url, "https://buildingseattle.com/contractors?page=3&sort=value&__bsv=v10&__bsd=2026-11-27");
  assert.equal(hub.droppedParams, true, "view is not a contractors-hub param");

  // A caller cannot pick the version or day.
  const forged = htmlCacheKeyUrl("https://buildingseattle.com/?__bsv=old&__bsd=1999-01-01", opts);
  assert.equal(forged.url, "https://buildingseattle.com/?__bsv=v10&__bsd=2026-11-27");
});

test("cache version follows the deployed Worker version and the development-sites flag", () => {
  assert.equal(htmlCacheVersion("v10", {}, true), "v10");
  assert.equal(htmlCacheVersion("v10", {}, false), "v10-sites-off");
  assert.equal(
    htmlCacheVersion("v10", { CF_VERSION_METADATA: { id: "1a2b3c4d-5e6f-7a8b-9c0d-112233445566" } }, true),
    "v10-1a2b3c4d-5e6",
  );
});

test("the data day rolls over at 14:00 UTC, after the daily ingest", () => {
  assert.equal(dataDay(new Date("2026-11-27T13:59:59Z")), "2026-11-26");
  assert.equal(dataDay(new Date("2026-11-27T14:00:00Z")), "2026-11-27");
  assert.equal(dataDay(new Date("2026-11-28T03:00:00Z")), "2026-11-27");
});

test("TTLs: long-lived pages get a day at the edge, short ones an hour, uncacheable ones none", () => {
  assert.equal(pageCacheTtl("public, max-age=3600"), 3600);
  assert.equal(pageCacheTtl("no-store"), 0);
  assert.equal(pageCacheTtl("private, max-age=60"), 0);
  assert.equal(pageCacheTtl("no-cache"), 0);
  assert.equal(edgeHtmlTtl(3600), 86400);
  assert.equal(edgeHtmlTtl(300), 3600);
  assert.equal(edgeHtmlTtl(0), 0);
  assert.equal(edgeCacheControl(3600), "public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600");
  assert.equal(edgeCacheControl(300), "public, max-age=300, s-maxage=3600, stale-while-revalidate=3600");
});

test("noindex detection reads the robots header and the head's robots meta only", () => {
  const h = (value) => new Headers(value ? { "X-Robots-Tag": value } : {});
  assert.equal(isNoindexResponse(h("noindex"), "<html>"), true);
  assert.equal(isNoindexResponse(h(), '<head><meta name="robots" content="noindex,follow"></head>'), true);
  assert.equal(isNoindexResponse(h(), '<head><meta content="noindex" name="robots"></head>'), true);
  assert.equal(isNoindexResponse(h(), '<head><meta name="robots" content="index,follow,max-image-preview:large"></head><body>noindex</body>'), false);
});

function memoryCache() {
  const store = new Map();
  return {
    store,
    default: {
      async match(request) {
        const value = store.get(request.url);
        return value ? value.clone() : undefined;
      },
      async put(request, response) {
        store.set(request.url, response.clone());
      },
    },
  };
}

// Empty D1: every query returns no rows; inserts succeed.
function emptyEnv(extra = {}) {
  return {
    ...extra,
    DB: {
      prepare() {
        const statement = {
          bind: () => statement,
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
          raw: async () => [],
        };
        return statement;
      },
      batch: async () => [],
    },
  };
}

async function withCaches(fn) {
  const original = globalThis.caches;
  const caches = memoryCache();
  globalThis.caches = caches;
  try {
    return await fn(caches.store);
  } finally {
    if (original === undefined) delete globalThis.caches;
    else globalThis.caches = original;
  }
}

const ctx = () => ({ waitUntil() {} });
const get = (path) => new Request(`https://buildingseattle.com${path}`, { headers: { "User-Agent": BROWSER } });

test("a tracking-tagged URL is served the warm copy but never stored under its own render", async () => {
  await withCaches(async (store) => {
    const env = emptyEnv();
    const tagged = await worker.fetch(get("/about?utm_source=newsletter"), env, ctx());
    assert.equal(tagged.status, 200);
    assert.equal(store.size, 0, "a page rendered from a tagged URL is not stored");

    const clean = await worker.fetch(get("/about"), env, ctx());
    assert.equal(clean.status, 200);
    assert.equal(store.size, 1);
    assert.match(clean.headers.get("Cache-Control") || "", /s-maxage=86400, stale-while-revalidate=3600/);

    const [key] = store.keys();
    assert.doesNotMatch(key, /utm_/);
    const again = await worker.fetch(get("/about?utm_source=x&fbclid=y&random=123"), env, ctx());
    assert.equal(await again.text(), await (await store.get(key)).clone().text(), "tagged URL hits the warm copy");
    assert.equal(store.size, 1);
  });
});

test("noindex pages (including empty-data pages after a DB error) and errors are never stored", async () => {
  await withCaches(async (store) => {
    const env = emptyEnv();
    // With no permits the browser renders the noindex "0 permits" page.
    const empty = await worker.fetch(get("/permits"), env, ctx());
    assert.equal(empty.status, 200);
    assert.match(await empty.text(), /<meta name="robots" content="noindex/);
    assert.equal(store.size, 0, "noindex page not cached");

    const missing = await worker.fetch(get("/no-such-page"), env, ctx());
    assert.equal(missing.status, 404);
    assert.equal(store.size, 0, "404 not cached");

    const failing = {
      DB: { prepare() { throw new Error("D1_ERROR: overloaded"); } },
    };
    const broken = await worker.fetch(get("/neighborhood/ballard"), failing, ctx());
    assert.equal(store.size, 0, `D1 failure page (status ${broken.status}) not cached`);
  });
});

test("admin responses are private, no-store, noindex and carry no CORS headers", async () => {
  const env = emptyEnv({ ADMIN_API_TOKEN: "test-admin-token" });
  const admin = (path, init = {}) =>
    new Request(`https://buildingseattle.com${path}`, {
      ...init,
      headers: { "X-Admin-Token": "test-admin-token", ...(init.headers || {}) },
    });
  const cases = [
    await worker.fetch(admin("/admin/entity-report"), env, ctx()),
    await worker.fetch(admin("/api/admin/stats"), env, ctx()),
    await worker.fetch(admin("/api/admin/analytics?days=7"), env, ctx()),
    await worker.fetch(new Request("https://buildingseattle.com/admin"), env, ctx()),
    await worker.fetch(new Request("https://buildingseattle.com/admin/entity-report", { method: "OPTIONS" }), env, ctx()),
  ];
  assert.equal(cases[0].status, 200);
  assert.equal(cases[3].status, 401);
  for (const response of cases) {
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    assert.match(response.headers.get("X-Robots-Tag") || "", /noindex/);
  }

  // Public API responses keep their CORS header.
  const api = await worker.fetch(new Request("https://buildingseattle.com/api/stats"), env, ctx());
  assert.equal(api.headers.get("Access-Control-Allow-Origin"), "*");
});

test("isAdminPath and hardenAdminResponse", () => {
  for (const path of ["/admin", "/admin/build-graph", "/api/admin/stats", "/api/admin"]) assert.equal(isAdminPath(path), true, path);
  for (const path of ["/administrators", "/api/permits", "/"]) assert.equal(isAdminPath(path), false, path);
  const hardened = hardenAdminResponse(
    new Response("{}", { status: 201, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } }),
  );
  assert.equal(hardened.status, 201);
  assert.equal(hardened.headers.get("Cache-Control"), "private, no-store");
  assert.equal(hardened.headers.has("Access-Control-Allow-Origin"), false);
});
