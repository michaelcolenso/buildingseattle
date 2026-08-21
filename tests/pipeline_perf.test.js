import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  htmlCacheTtl,
  isHtmlCacheablePath,
  summarizeAduTimeline,
} from "../worker.js";

function createCtx() {
  const promises = [];
  return {
    promises,
    waitUntil(promise) {
      promises.push(Promise.resolve(promise));
    },
  };
}

// DB mock that answers the pipeline page's queries by SQL marker. Anything
// unhandled throws so accidental new queries fail loudly in tests.
function createPipelineEnv() {
  const prepareCalls = { count: 0 };
  const DB = {
    prepare(sql) {
      prepareCalls.count += 1;
      let params = [];
      const statement = {
        bind(...values) {
          params = values;
          return statement;
        },
        async all() {
          if (sql.includes("pipeline:adu-stage")) {
            return {
              results: [
                { adu_type: "ADU", cnt: 10, applied: 10, issued: 8, completed: 5 },
                { adu_type: "DADU", cnt: 7, applied: 7, issued: 6, completed: 3 },
              ],
            };
          }
          if (sql.includes("pipeline:adu-days")) {
            return {
              results: [
                { adu_type: "ADU", d: 10 },
                { adu_type: "ADU", d: 20 },
                { adu_type: "ADU", d: 30 },
                { adu_type: "DADU", d: 40 },
                { adu_type: "DADU", d: 60 },
              ],
            };
          }
          if (sql.includes("pipeline:adu-completed-days")) {
            return {
              results: [
                { adu_type: "ADU", d: 100 },
                { adu_type: "DADU", d: 200 },
              ],
            };
          }
          if (sql.includes("pipeline:adu-by-year")) {
            return {
              results: [
                { adu_type: "ADU", yr: "2024", cnt: 4, avg_days: 80 },
                { adu_type: "DADU", yr: "2024", cnt: 5, avg_days: 90 },
                { adu_type: "ADU", yr: "2025", cnt: 6, avg_days: 120 },
              ],
            };
          }
          if (sql.includes("pipeline:adu-recent")) {
            return {
              results: [
                {
                  permit_number: "ADU-2026-0001",
                  address: "1234 FAKE AVE, SEATTLE, WA",
                  adu_type: "DADU",
                  address_slug: "1234-fake-ave-seattle-wa",
                  display_address: "1234 FAKE AVE, Seattle, WA",
                },
              ],
            };
          }
          if (sql.includes("GROUP BY label ORDER BY cnt DESC LIMIT 8")) {
            return { results: [{ label: "residential", cnt: 50, avg_days: 45 }] };
          }
          if (sql.includes("AS d") && sql.includes("WHERE applied_date IS NOT NULL") && !sql.includes("adu_type")) {
            return { results: [{ d: 30 }, { d: 45 }] };
          }
          if (sql.includes("AS d") && sql.includes("completed_date") && !sql.includes("adu_type")) {
            return { results: [{ d: 60 }, { d: 90 }] };
          }
          throw new Error(`Unhandled all() query: ${sql.slice(0, 160)}`);
        },
        async first() {
          if (sql.includes("COUNT(*) AS total") && sql.includes("SUM(CASE WHEN applied_date")) {
            return { total: 100, applied: 80, issued: 60, completed: 40 };
          }
          throw new Error(`Unhandled first() query: ${sql.slice(0, 160)}`);
        },
        async run() {
          throw new Error("Unexpected write in read-only pipeline test");
        },
      };
      return statement;
    },
  };
  return { DB, prepareCalls };
}

// Minimal env for rendering a permit detail page (cache integration test).
function createPermitEnv() {
  const prepareCalls = { count: 0 };
  const permit = {
    permit_number: "PERM123",
    address: "407 Stewart St, Seattle, WA",
    neighborhood: "Downtown",
    type: "commercial",
    value: 62000000,
    status: "active",
    description: "Tower renovation",
    applied_date: "2026-01-05",
    issued_date: "2026-03-10",
    contractor_name: "Seattle Construction Group",
    contractor_slug: "seattle-construction-group",
    contractor_specialty: "General Contractor",
    contractor_license: "SCG123",
    address_slug: "407-stewart-st-seattle-wa",
    display_address: "407 Stewart St, Seattle, WA",
  };
  return {
    DB: {
      prepare(sql) {
        prepareCalls.count += 1;
        let params = [];
        const statement = {
          bind(...values) {
            params = values;
            return statement;
          },
          async all() {
            if (sql.includes("WHERE p.permit_number = ?")) {
              return { results: params[0] === permit.permit_number ? [{ ...permit }] : [] };
            }
            throw new Error(`Unhandled all() query: ${sql.slice(0, 120)}`);
          },
          async first() {
            throw new Error(`Unhandled first() query: ${sql.slice(0, 120)}`);
          },
          async run() {
            // page_views insert: swallowed by logPageView's try/catch
            throw new Error("read-only test env");
          },
        };
        return statement;
      },
    },
    prepareCalls,
  };
}

test("isHtmlCacheablePath allows public pages and excludes dynamic/asset routes", () => {
  assert.equal(isHtmlCacheablePath("/"), true);
  assert.equal(isHtmlCacheablePath("/permits/7126462-CN"), true);
  assert.equal(isHtmlCacheablePath("/address/1707-sunset-ave-sw-seattle-wa"), true);
  assert.equal(isHtmlCacheablePath("/insights/pipeline"), true);
  assert.equal(isHtmlCacheablePath("/permits?page=2&neighborhood=Ballard"), true);
  assert.equal(isHtmlCacheablePath("/api/pipeline"), false);
  assert.equal(isHtmlCacheablePath("/admin"), false);
  assert.equal(isHtmlCacheablePath("/ingest/permit/batch"), false);
  assert.equal(isHtmlCacheablePath("/alerts/subscribe"), false);
  assert.equal(isHtmlCacheablePath("/social/permit.png"), false);
  assert.equal(isHtmlCacheablePath("/favicon.ico"), false);
  assert.equal(isHtmlCacheablePath("/sitemap.xml"), false);
  assert.equal(isHtmlCacheablePath("/robots.txt"), false);
});

test("htmlCacheTtl honors the page's own max-age and clamps", () => {
  assert.equal(htmlCacheTtl(new Response(null, { headers: { "Cache-Control": "public, max-age=3600" } })), 3600);
  assert.equal(htmlCacheTtl(new Response(null, { headers: { "Cache-Control": "public, max-age=300" } })), 300);
  assert.equal(htmlCacheTtl(new Response(null, { headers: { "Cache-Control": "no-store" } })), 3600);
  assert.equal(htmlCacheTtl(new Response(null, { headers: { "Cache-Control": "public, max-age=999999" } })), 86400);
  assert.equal(htmlCacheTtl(new Response(null, { headers: { "Cache-Control": "public, max-age=5" } })), 60);
});

test("summarizeAduTimeline buckets ADU/DADU stages and durations", () => {
  const summary = summarizeAduTimeline({
    stageRows: [
      { adu_type: "ADU", cnt: 10, applied: 10, issued: 8, completed: 5 },
      { adu_type: "DADU", cnt: 7, applied: 7, issued: 6, completed: 3 },
    ],
    dayRows: [
      { adu_type: "ADU", d: 10 },
      { adu_type: "ADU", d: 20 },
      { adu_type: "ADU", d: 30 },
      { adu_type: "DADU", d: 40 },
      { adu_type: "DADU", d: 60 },
    ],
    completedDayRows: [
      { adu_type: "ADU", d: 100 },
      { adu_type: "DADU", d: 200 },
    ],
    byYearRows: [
      { adu_type: "ADU", yr: "2024", cnt: 4, avg_days: 80 },
      { adu_type: "DADU", yr: "2024", cnt: 5, avg_days: 90 },
    ],
    recentRows: [{ permit_number: "ADU-1", adu_type: "DADU", address_slug: "x-ave", display_address: "X Ave" }],
  });

  assert.equal(summary.ADU.count, 10);
  assert.equal(summary.ADU.applied, 10);
  assert.equal(summary.ADU.issued, 8);
  assert.equal(summary.ADU.completed, 5);
  assert.equal(summary.ADU.issue_rate, 80);
  assert.equal(summary.ADU.completion_rate, 63);
  assert.deepEqual(summary.ADU.applied_to_issued, { count: 3, mean: 20, median: 20, p90: 28 });
  assert.deepEqual(summary.DADU.applied_to_issued, { count: 2, mean: 50, median: 50, p90: 58 });
  assert.equal(summary.ADU.issued_to_completed.median, 100);
  assert.equal(summary.by_year.length, 2);
  assert.deepEqual(summary.by_year[0], { adu_type: "ADU", year: "2024", count: 4, avg_days: 80 });
  assert.equal(summary.recent[0].address_slug, "x-ave");
});

test("/insights/pipeline renders ADU timeline title, meta, H1, FAQ and internal links", async () => {
  const env = createPipelineEnv();
  const response = await worker.fetch(new Request("https://buildingseattle.com/insights/pipeline"), env, createCtx());
  assert.equal(response.status, 200);
  const html = await response.text();

  // Title / meta / H1 directly answer the rising query
  assert.match(html, /<title>Seattle ADU Permit Timeline: How Long It Takes, Step by Step<\/title>/);
  assert.match(
    html,
    /<meta name="description" content="How long does an ADU or DADU permit take in Seattle\?/,
  );
  assert.match(html, /<link rel="canonical" href="https:\/\/buildingseattle\.com\/insights\/pipeline">/);
  const h1s = html.match(/<h1[^>]*>.*?<\/h1>/g) || [];
  assert.equal(h1s.length, 1, "exactly one H1");
  assert.match(h1s[0], /How long does an ADU permit take in Seattle\?/);

  // Data-grounded stage explanation with real numbers from the mock
  assert.match(html, /ADU median to issue/);
  assert.match(html, /Median application-to-issuance time across 3 issued ADU and 2 issued DADU permits/);
  assert.match(html, /Median 20 days after application for ADUs and 50 days for DADUs/);
  assert.match(html, /80% of applied ADU permits and 86% of applied DADU permits reach issuance/);
  assert.match(html, /Average application → issuance time by year/);

  // Internal links to ADU-classified permit and address pages
  assert.match(html, /href="\/permits\/ADU-2026-0001"/);
  assert.match(html, /href="\/address\/1234-fake-ave-seattle-wa"/);

  // Structured data: Dataset + data-grounded FAQ + BreadcrumbList
  assert.match(html, /"@type":"FAQPage"/);
  assert.match(html, /"How long does an ADU permit take in Seattle\?"/);
  assert.match(html, /median time from application to issuance is 20 days/);
  assert.match(html, /"@type":"BreadcrumbList"/);

  // No template leakage
  assert.ok(!html.includes("undefined"), "no undefined leakage");
  assert.ok(!html.includes("NaN"), "no NaN leakage");
});

test("template-wide HTML edge cache: warm second fetch skips the render's D1 work", async () => {
  const originalCaches = globalThis.caches;
  const store = new Map();
  globalThis.caches = {
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
  try {
    const env = createPermitEnv();
    const request = () => new Request("https://buildingseattle.com/permits/PERM123");

    const first = await worker.fetch(request(), env, createCtx());
    const firstHtml = await first.text();
    assert.equal(first.status, 200);
    const callsAfterFirst = env.prepareCalls.count;
    assert.ok(callsAfterFirst > 1, "first fetch actually queried D1");
    assert.equal(store.size, 1, "fresh page stored in the edge cache");
    const [key] = store.keys();
    assert.ok(key.includes("__bsv=v2"), `cache key is versioned, got ${key}`);
    assert.match(first.headers.get("Cache-Control") || "", /s-maxage=3600/);

    const second = await worker.fetch(request(), env, createCtx());
    const secondHtml = await second.text();
    assert.equal(second.status, 200);
    assert.equal(secondHtml, firstHtml, "cache hit returns the identical page");
    // On a hit the only D1 statement is the page-view insert (which fails and
    // is swallowed) — the permit query and render never run again.
    assert.ok(
      env.prepareCalls.count - callsAfterFirst <= 1,
      `cache hit skipped render D1 work (delta ${env.prepareCalls.count - callsAfterFirst})`,
    );
  } finally {
    if (originalCaches === undefined) {
      delete globalThis.caches;
    } else {
      globalThis.caches = originalCaches;
    }
  }
});
