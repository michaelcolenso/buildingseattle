import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.js";

function ctx() { return { waitUntil() {} }; }
function emptyEnv() {
  return {
    DB: {
      prepare() {
        return { bind() { return this; }, async first() { return null; }, async all() { return { results: [] }; }, async run() { return {}; } };
      },
    },
  };
}

test("GET /alerts is a real landing page explaining per-permit alerts (audit E5)", async () => {
  const response = await worker.fetch(new Request("https://buildingseattle.com/alerts"), emptyEnv(), ctx());
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<h1>Seattle permit status alerts<\/h1>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/buildingseattle\.com\/alerts">/);
  assert.match(html, /<meta name="robots" content="index,follow/);
  assert.match(html, /one-click unsubscribe/i);
  assert.match(html, /<form class="bs-search" action="\/permits" method="get"/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /utm_campaign=alerts_page/);
  // The subscription endpoints are unchanged: POST /alerts is not this page.
  const post = await worker.fetch(new Request("https://buildingseattle.com/alerts", { method: "POST" }), emptyEnv(), ctx());
  assert.equal(post.status, 404);
});

test("GET /privacy lists what is collected and links the existing contact address (audit F10)", async () => {
  const response = await worker.fetch(new Request("https://buildingseattle.com/privacy"), emptyEnv(), ctx());
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<title>Privacy Notice \| Building Seattle<\/title>/);
  for (const phrase of [/Permit alert subscriptions/, /Forms/, /Server logs and analytics/, /Cloudflare Web Analytics/, /does not use cookies/, /Gumroad/, /Google Maps/]) {
    assert.match(html, phrase);
  }
  assert.match(html, /href="mailto:alerts@buildingseattle\.com"/);
  const mailtos = [...html.matchAll(/mailto:([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(mailtos)], ["alerts@buildingseattle.com"]);
});

test("every shared footer links privacy and alerts (audit F10/E5)", async () => {
  for (const path of ["/privacy", "/alerts", "/about", "/data", "/methodology", "/contractors"]) {
    const response = await worker.fetch(new Request(`https://buildingseattle.com${path}`), emptyEnv(), ctx());
    const html = await response.text();
    const footer = html.match(/<footer class="global-footer">[\s\S]*?<\/footer>/)?.[0] || "";
    assert.match(footer, /href="\/privacy"/, `${path} footer privacy link`);
    assert.match(footer, /href="\/alerts"/, `${path} footer alerts link`);
  }
});

test("/about states City of Seattle scope and a real contact link (audit E12)", async () => {
  const response = await worker.fetch(new Request("https://buildingseattle.com/about"), emptyEnv(), ctx());
  const html = await response.text();
  assert.doesNotMatch(html, /across the Seattle metro|spanning from historical records|reach out via the site/i);
  assert.match(html, /does not cover the rest of King County/);
  assert.match(html, /City of Seattle/);
  assert.match(html, /applications dated May 15, 2024 to November 6, 2026/);
  assert.match(html, /href="mailto:alerts@buildingseattle\.com"/);
});

// Routes each query to canned rows by a distinctive SQL fragment. Unmatched
// queries return nothing, which every entity page tolerates.
function routedEnv(routes) {
  const pick = (sql) => routes.find(([needle]) => sql.includes(needle))?.[1];
  return {
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async first() { const v = pick(sql); return Array.isArray(v) ? v[0] ?? null : v ?? null; },
          async all() { const v = pick(sql); return { results: Array.isArray(v) ? v : v ? [v] : [] }; },
          async run() { return {}; },
        };
      },
    },
  };
}

const openPermit = { id: 1, permit_number: "P-OPEN", type: "residential", status: "active", value: 50000, applied_date: "2026-03-02", issued_date: "2026-03-20", address_id: 7 };
const donePermit = { id: 2, permit_number: "P-DONE", type: "commercial", status: "completed", value: 25000, applied_date: "2026-03-01", completed_date: "2026-03-28", address_id: 7 };

test("neighborhood pages: data-driven meta, labelled rows, view-all links and CTAs (audit E5/E15/E17/E18/E19/G9)", async () => {
  const env = routedEnv([
    ["FROM neighborhoods WHERE slug", { id: 3, name: "Ballard", slug: "ballard" }],
    ["COUNT(DISTINCT p.id) AS permits", { permits: 1276, total_value: 5200000 }],
    ["pp.role = 'contractor'", [{ name: "ACME\\BUILD LLC", slug: "acme-build-llc", cnt: 1 }]],
    ["FROM addresses a JOIN address_neighborhoods", [{ slug: "100-pine-st", display_address: "100 PINE ST, SEATTLE, WA", permits: 2 }]],
    ["FROM projects pr", []],
    ["ORDER BY COALESCE(p.issued_date, p.applied_date) DESC LIMIT 15", [openPermit, donePermit]],
  ]);
  const html = await (await worker.fetch(new Request("https://buildingseattle.com/neighborhood/ballard"), env, ctx())).text();
  assert.match(html, /<title>Ballard Building Permits, Seattle \| Building Seattle<\/title>/);
  assert.match(html, /<meta name="description" content="1,276 building permits in Ballard, Seattle worth \$5\.2M in counted value, latest Mar 28, 2026\./);
  assert.match(html, /bs-metric__value">1,276</);
  assert.match(html, /<td>Residential Construction<\/td>/);
  assert.match(html, /bs-status[^>]*>[^<]*Active/);
  assert.match(html, /Acme\/Build LLC<\/a> <span[^>]*>· 1 permit<\/span>/);
  assert.match(html, /100 Pine St, Seattle, WA<\/a> <span[^>]*>· 2 permits<\/span>/);
  assert.match(html, /href="\/permits\?neighborhood=Ballard">All 1,276 permits in Ballard/);
  assert.match(html, /href="\/contractors\?neighborhood=Ballard"/);
  assert.match(html, /href="\/addresses\?neighborhood=Ballard"/);
  assert.doesNotMatch(html, /Active projects|No active projects yet/);
  assert.match(html, /href="\/permits\/P-OPEN#permit-alerts"/);
  assert.match(html, /utm_content=neighborhood/);
});

test("address pages: parent breadcrumb, no placeholder cards, single-month span, labelled roles (audit E5/E15/E16/E21/G13)", async () => {
  const env = routedEnv([
    ["FROM addresses WHERE slug", { id: 7, slug: "1-main-st", display_address: "1 MAIN ST, SEATTLE, WA" }],
    ["FROM neighborhoods n JOIN address_neighborhoods", { id: 3, name: "Ballard", slug: "ballard" }],
    ["FROM permit_participants pp", [{ name: "JANE DOE", slug: "jane-doe", role: "owner", cnt: 1 }]],
    ["WHERE p.address_id = ? ORDER BY", [openPermit, donePermit]],
  ]);
  const html = await (await worker.fetch(new Request("https://buildingseattle.com/address/1-main-st"), env, ctx())).text();
  assert.match(html, /<nav aria-label="breadcrumb"[^>]*><a href="\/"[^>]*>Home<\/a>[^]*?href="\/addresses"[^>]*>Addresses<\/a>[^]*?href="\/neighborhood\/ballard"/);
  assert.match(html, /"name":"Addresses","item":"https:\/\/buildingseattle\.com\/addresses"/);
  assert.match(html, /Permit activity at this address dates to March 2026/);
  assert.doesNotMatch(html, /spans from|No inferred projects yet|No participants on record|explore nearby/);
  assert.match(html, /<span class="pill"[^>]*>Owner<\/span>/);
  assert.match(html, /Jane Doe<\/a>/);
  assert.match(html, /href="\/permits\/P-OPEN#permit-alerts"/);
  assert.match(html, /utm_content=address/);
});

test("project pages use the site brand and a data-driven description (audit E19/G9)", async () => {
  const env = routedEnv([
    ["FROM projects pr LEFT JOIN addresses", { id: 9, slug: "two-step", name: "Two-step remodel", address_id: null, confidence_score: 80, first_seen_date: "2026-03-01", latest_activity_date: "2026-05-02" }],
    ["FROM project_permits jp", [openPermit, { ...donePermit, address_id: 8 }]],
  ]);
  const html = await (await worker.fetch(new Request("https://buildingseattle.com/project/two-step"), env, ctx())).text();
  assert.match(html, /<title>Two-step remodel \| Building Seattle<\/title>/);
  assert.doesNotMatch(html, /Seattle Construction Activity/);
  assert.match(html, /<meta name="description" content="2 Seattle building permits grouped as one project, \$75K counted value, March 2026 to May 2026\./);
  assert.match(html, /href="\/projects"[^>]*>Projects<\/a>/);
  assert.match(html, /match confidence 80\/100/);
  assert.match(html, /utm_content=project/);
});

test("people/org contractor pages: display name, role labels, Contractors parent (audit E16/E19/G8/G9)", async () => {
  const env = routedEnv([
    ["FROM contractors WHERE slug", null],
    ["FROM people_orgs WHERE slug", { id: 4, slug: "belotti", name: "BELOTTI MCHUGH DSN\\\\CNST SR LLC", type_guess: "organization" }],
    ["SELECT DISTINCT role FROM permit_participants", [{ role: "contractor" }, { role: "applicant" }]],
    ["COUNT(DISTINCT p.id) AS permit_count", { permit_count: 2, active_count: 1 }],
    ["SUM(counted)", { total: 75000 }],
    ["ORDER BY COALESCE(p.issued_date, p.applied_date) DESC LIMIT 50", [openPermit, donePermit]],
  ]);
  const html = await (await worker.fetch(new Request("https://buildingseattle.com/contractor/belotti"), env, ctx())).text();
  assert.match(html, /<title>Belotti Mchugh Dsn\/Cnst Sr LLC: Seattle Permits \| Building Seattle<\/title>/);
  assert.doesNotMatch(html, /\\/);
  assert.match(html, /Organization · Contractor, Applicant/);
  assert.match(html, /<meta name="description" content="Belotti Mchugh Dsn\/Cnst Sr LLC: 2 Seattle building permits as contractor, applicant, 1 active, \$75K counted value\./);
  assert.match(html, /href="\/contractors"[^>]*>Contractors<\/a>/);
  assert.doesNotMatch(html, /No inferred projects yet|No neighborhood data/);
  assert.match(html, /utm_content=contractor/);
});

test("curated contractor pages: no backslashes, Contractors parent, labelled rows, no empty speed tiles (audit E15/E17/G8)", async () => {
  const env = routedEnv([
    ["FROM contractors WHERE slug", { id: 5, slug: "belotti", name: "BELOTTI MCHUGH DSN\\\\CNST SR LLC", specialty: "General Contractor" }],
    ["AVG(JulianDay", { total_count: 12, active_count: 1, completed_count: 1 }],
    ["GROUP BY neighborhood", [{ neighborhood: "Capitol Hill", count: 2, total_value: 1 }]],
    ["GROUP BY type", [{ type: "commercial", count: 2 }]],
    ["SELECT * FROM permits WHERE contractor_id", [{ ...openPermit, address: "1 MAIN ST, SEATTLE, WA" }]],
  ]);
  const html = await (await worker.fetch(new Request("https://buildingseattle.com/contractor/belotti"), env, ctx())).text();
  assert.doesNotMatch(html, /\\/);
  assert.match(html, /<h1[^>]*>Belotti Mchugh Dsn\/Cnst Sr LLC<\/h1>/);
  assert.match(html, /href="\/contractors"[^>]*>Contractors<\/a>/);
  assert.match(html, /"name":"Contractors"/);
  assert.match(html, /Residential Construction &bull; \$50,000 &bull; Active &bull; Permit P-OPEN/);
  assert.match(html, /href="\/neighborhood\/capitol-hill"/);
  assert.match(html, /Commercial Construction &middot; 2/);
  assert.doesNotMatch(html, /Build Speed|Permit Speed/);
  assert.match(html, /Search permits for Belotti Mchugh Dsn\/Cnst Sr LLC/);
  assert.match(html, /utm_content=contractor/);
});

test("contractor hub cards show a readable type and pluralized counts (audit E16/E18)", async () => {
  const env = routedEnv([
    ["seo-hub:contractors", [
      { slug: "one", label: "ONE PERSON", detail: "person", permit_count: 1, total_value: 0 },
      { slug: "big", label: "BIG\\BUILD LLC", detail: "organization", permit_count: 1276, total_value: 5000 },
    ]],
  ]);
  const html = await (await worker.fetch(new Request("https://buildingseattle.com/contractors"), env, ctx())).text();
  assert.match(html, /One Person<\/a><\/h2>\s*<p[^>]*>Contractor \(individual\)<\/p>[\s\S]*?<span>1 permit<\/span>/);
  assert.match(html, /Big\/Build LLC<\/a><\/h2>\s*<p[^>]*>Contractor<\/p>[\s\S]*?<span>1,276 permits<\/span>/);
  assert.doesNotMatch(html, />organization<|>person</);
});

test("plan-review histogram always sums to the 'based on N' count, fractional days included (audit G7)", async () => {
  const { summarizePlanReview } = await import("../worker.js");
  const s = summarizePlanReview([0, 30, 30.5, 60.2, 90.9, 180.4, 365.5, 400]);
  assert.equal(s.count, 8);
  assert.equal(s.histogram.reduce((sum, b) => sum + b.count, 0), s.count);
  assert.deepEqual(s.histogram.map((b) => b.count), [2, 1, 1, 1, 1, 2]);
});

test("plan-review cycle figures share the reviewed population (audit G7)", async () => {
  const seen = [];
  const env = {
    DB: {
      prepare(sql) {
        seen.push(sql);
        return {
          bind() { return this; },
          async all() {
            if (sql.includes("SELECT total_days_plan_review AS d")) return { results: [{ d: 10 }, { d: 20 }, { d: 40 }] };
            if (sql.includes("AS cycles")) return { results: [{ cycles: 1, cnt: 1 }, { cycles: 10, cnt: 1 }] };
            if (sql.includes("COALESCE(NULLIF(type,''),'unknown')")) return { results: [{ label: "commercial", cnt: 1, avg_days: 1 }] };
            return { results: [] };
          },
          async first() { return { avg_cycles: 2, avg_corrections: 12 }; },
          async run() { return {}; },
        };
      },
    },
  };
  const html = await (await worker.fetch(new Request("https://buildingseattle.com/insights/plan-review"), env, ctx())).text();
  for (const sql of seen.filter((q) => /number_review_cycles\) AS avg_cycles, AVG\(days_out|AS cycles, COUNT/.test(q))) {
    assert.match(sql, /total_days_plan_review IS NOT NULL/);
  }
  assert.match(html, /Based on 3 permits with recorded/);
  assert.match(html, /2 of the 3 reviewed permits also report a cycle count/);
  assert.match(html, /10\+ cycles/);
  assert.match(html, /Commercial Construction/);
  assert.match(html, /1 day<span class="pr-sub"> · 1 permit/);
});

test("permit browser filters and cards use human labels (audit E17)", async () => {
  const env = routedEnv([
    ["SELECT DISTINCT type FROM permits", [{ type: "residential" }]],
    ["SELECT DISTINCT status FROM permits", [{ status: "in_review" }]],
    ["SELECT COUNT(*) as total", { total: 1 }],
    ["SELECT p.*, c.name as contractor_name", [{ ...openPermit, address: "1 MAIN ST, SEATTLE, WA", contractor_name: "ACME\\BUILD LLC", contractor_slug: "acme", issued_date: "2026-03-20" }]],
  ]);
  const html = await (await worker.fetch(new Request("https://buildingseattle.com/permits"), env, ctx())).text();
  assert.match(html, /<option value="residential">Residential Construction<\/option>/);
  assert.match(html, /<option value="in_review">In review<\/option>/);
  assert.match(html, /1 Main St, Seattle, WA<\/a>/);
  assert.match(html, />Acme\/Build LLC<\/a>/);
  assert.match(html, /Mar 20, 2026/);
});
