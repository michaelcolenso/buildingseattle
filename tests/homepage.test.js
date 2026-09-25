import assert from "node:assert/strict";
import test from "node:test";
import worker, { htmlCacheTtl, isHtmlCacheablePath } from "../worker.js";

function createEnv() {
  const queries = [];
  const env = {
    _queries: queries,
    DB: {
      prepare(sql) {
        queries.push(sql);
        return {
          bind() { return this; },
          async first() {
            if (sql.includes("homepage:canonical-stats")) {
              return {
                permits: 12,
                active_permits: 7,
                contractors: 2,
                active_contractors: 2,
                total_value: 12500000,
                latest_record_date: "2026-08-23",
              };
            }
            if (sql.includes("homepage:last-ingest")) return { end_time: "2026-08-24 08:15:00" };
            if (sql.includes("api:mean-permit-value")) return { avg_value: 1041666.67 };
            throw new Error(`Unhandled first query: ${sql}`);
          },
          async all() {
            if (sql.includes("homepage:what-changed")) {
              return { results: [{ id: 1, permit_number: "P-1", previous_status: "pending", new_status: "active", changed_at: "2026-08-24 07:00:00", address: '<script>alert("x")</script> 1 Main St', neighborhood: "Downtown", type: "commercial", value: 400000 }] };
            }
            if (sql.includes("homepage:active-addresses")) return { results: [{ label: "1 Main St", active_permits: 4, total_value: 900000 }] };
            if (sql.includes("homepage:contractors-30d")) return { results: [{ label: "Build Co", slug: "build-co", permits: 3, total_value: 1200000 }] };
            if (sql.includes("homepage:neighborhoods-30d")) return { results: [{ label: "Ballard", permits: 5, total_value: 2000000 }] };
            if (sql.includes("api:active-contractors")) return { results: [{ id: 1, name: "Build Co", slug: "build-co", active_projects: 3 }] };
            throw new Error(`Unhandled all query: ${sql}`);
          },
          async run() {
            return {};
          },
        };
      },
    },
  };
  return env;
}

function ctx() { return { waitUntil() {} }; }

test("homepage is task-first and uses mechanically correct data labels", async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request("https://buildingseattle.com/"), env, ctx());
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Seattle construction permits, projects &amp; contractor activity/);
  assert.match(html, /<form class="search-form" action="\/permits" method="get" role="search">/);
  assert.match(html, /name="q" type="search"/);
  assert.match(html, />7<\/strong><span>active permits/);
  assert.match(html, />2<\/strong><span>contractors linked to permits/);
  assert.match(html, /\$12\.5M<\/strong><span>declared permit value/);
  assert.match(html, /Scheduled daily ingest/);
  assert.match(html, /Last successful ingest/);
  assert.match(html, /Latest permit event/);
  assert.match(html, /What changed/);
  assert.match(html, /PENDING → ACTIVE/);
  assert.match(html, /Contractors with new active work/);
  assert.match(html, /past 30 days/);
  assert.match(html, /Find prospective work/);
  assert.match(html, /Built from Seattle public records/);
  assert.match(html, /What does “permit value” mean\?/);
  assert.match(html, /Get the changes that matter/);

  assert.doesNotMatch(html, /updated hourly/i);
  assert.doesNotMatch(html, /real-time market intelligence/i);
  assert.doesNotMatch(html, /Get Early Access/i);
  assert.doesNotMatch(html, /View Live Data/i);
  assert.doesNotMatch(html, /Permit Value Radar/i);
  assert.doesNotMatch(html, /<script>alert\("x"\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/i);
});

test("homepage ships complete social metadata, a skip link, and no orphaned /about", async () => {
  const response = await worker.fetch(new Request("https://buildingseattle.com/"), createEnv(), ctx());
  const html = await response.text();

  assert.match(html, /<meta property="og:image" content="https:\/\/buildingseattle\.com\/social\/insight\.png">/);
  assert.match(html, /<meta property="og:image:width" content="1200">/);
  assert.match(html, /<meta property="og:image:height" content="630">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<meta name="twitter:image" content="https:\/\/buildingseattle\.com\/social\/insight\.png">/);
  assert.match(html, /<a class="skip-link" href="#main-content">Skip to content<\/a>/);
  assert.match(html, /<main id="main-content">/);
  // Footer coverage: the public pages the monitor treats as required links.
  for (const href of ["/about", "/permits", "/contractors", "/neighborhoods", "/projects", "/addresses", "/insights", "/data", "/methodology", "/api-docs"]) {
    assert.ok(html.includes(`href="${href}"`), `homepage should link to ${href}`);
  }
});

test("homepage includes mobile/accessibility protections and has no JS-dependent primary action", async () => {
  const response = await worker.fetch(new Request("https://buildingseattle.com/"), createEnv(), ctx());
  const html = await response.text();
  assert.match(html, /@media\(max-width:360px\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /aria-label="Current database metrics"/);
  assert.match(html, /<label for="home-search">/);
  assert.doesNotMatch(html, /onclick=/);
});

test("homepage is edge-cacheable and advertises discovery resources", async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request("https://buildingseattle.com/"), env, ctx());

  // "/" must be cacheable like every other public HTML page, and the TTL the
  // edge cache would apply comes from the page's own max-age.
  assert.equal(isHtmlCacheablePath("/"), true);
  assert.equal(htmlCacheTtl(response), 300);
  assert.match(response.headers.get("Cache-Control") || "", /max-age=300/);
  assert.match(response.headers.get("Cache-Control") || "", /s-maxage=300/);

  // The homepage previously missed the RFC 8288 discovery links that every
  // other worker-rendered page sends.
  const link = response.headers.get("Link") || "";
  assert.match(link, /rel="sitemap"/);
  assert.match(link, /rel="llms-txt"/);
});

test("GET /api/stats uses linked-contractor semantics and exposes freshness", async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request("https://buildingseattle.com/api/stats"), env, ctx());
  const payload = await response.json();

  assert.equal(payload.permits, 12);
  assert.equal(payload.active_permits, 7);
  assert.equal(payload.contractors, 2);
  assert.equal(payload.active_contractors, 2);
  assert.equal(payload.total_value, 12500000);
  assert.equal(payload.latest_record_date, "2026-08-23");
  assert.equal(payload.last_ingest_at, "2026-08-24 08:15:00");
  const statsSql = env._queries.find((sql) => sql.includes("homepage:canonical-stats"));
  assert.match(statsSql, /COUNT\(DISTINCT CASE WHEN contractor_id IS NOT NULL THEN contractor_id END\)/);
  assert.match(statsSql, /lower\(COALESCE\(status,''\)\) = 'active'/);
});

test("GET /api/contractors returns only contractors with active work by SQL contract", async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request("https://buildingseattle.com/api/contractors"), env, ctx());
  const payload = await response.json();
  assert.deepEqual(payload.map((row) => row.active_projects), [3]);

  const sql = env._queries.find((query) => query.includes("api:active-contractors"));
  assert.match(sql, /JOIN permits p/);
  assert.match(sql, /lower\(COALESCE\(p\.status,''\)\) = 'active'/);
  assert.match(sql, /HAVING COUNT\(p\.id\) > 0/);
});

test("root markdown representation carries the same data semantics", async () => {
  const response = await worker.fetch(
    new Request("https://buildingseattle.com/", { headers: { Accept: "text/markdown" } }),
    createEnv(),
    ctx(),
  );
  const markdown = await response.text();
  assert.match(response.headers.get("Content-Type") || "", /text\/markdown/);
  assert.match(markdown, /7 active permits/);
  assert.match(markdown, /2 contractors linked to permits/);
  assert.match(markdown, /\$12\.5M declared permit value/);
  assert.match(markdown, /PENDING → ACTIVE/);
  assert.match(markdown, /Permit values are declared values, not verified total project costs/);
});

test("new responses include security and caching headers", async () => {
  for (const path of ["/", "/api/stats", "/api/contractors"]) {
    const response = await worker.fetch(new Request(`https://buildingseattle.com${path}`), createEnv(), ctx());
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
    assert.match(response.headers.get("Strict-Transport-Security") || "", /max-age=/);
    assert.match(response.headers.get("Cache-Control") || "", /s-maxage=300/);
  }
});

test("non-home routes and www canonicalization continue through the existing worker", async () => {
  const normal = await worker.fetch(new Request("https://buildingseattle.com/robots.txt"), createEnv(), ctx());
  assert.equal(normal.status, 200);
  assert.match(await normal.text(), /User-agent:/i);
  const www = await worker.fetch(new Request("https://www.buildingseattle.com/"), createEnv(), ctx());
  assert.equal(www.status, 301);
});
