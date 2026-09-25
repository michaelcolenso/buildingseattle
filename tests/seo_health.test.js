import assert from "node:assert/strict";
import test from "node:test";

import {
  decodedTitleLength,
  entityHubItemCount,
  expectedSchemaType,
  htmlMetadata,
  pngDimensions,
  schemaTypes,
  summarizeHistory,
  titleBudget,
  xmlLocations,
} from "../scripts/check_seo_health.mjs";

test("xmlLocations extracts and decodes sitemap locations", () => {
  assert.deepEqual(
    xmlLocations("<urlset><url><loc>https://buildingseattle.com/a&amp;b</loc></url></urlset>"),
    ["https://buildingseattle.com/a&b"],
  );
});

test("htmlMetadata extracts crawl directives and valid JSON-LD blocks", () => {
  const metadata = htmlMetadata(`<!doctype html>
    <html><head>
      <title>Seattle permits</title>
      <meta name="description" content="Public permit activity">
      <meta name="robots" content="index,follow">
      <link rel="canonical" href="https://buildingseattle.com/permits">
      <script type="application/ld+json">{"@type":"CollectionPage"}</script>
    </head><body><a href="/projects">Projects</a></body></html>`);

  assert.equal(metadata.title, "Seattle permits");
  assert.equal(metadata.description, "Public permit activity");
  assert.equal(metadata.robots, "index,follow");
  assert.equal(metadata.canonical, "https://buildingseattle.com/permits");
  assert.deepEqual(metadata.jsonLd, ['{"@type":"CollectionPage"}']);
  assert.deepEqual(metadata.links, ["/projects"]);
});

test("entityHubItemCount reads ItemList counts without trusting invalid JSON-LD", () => {
  assert.equal(entityHubItemCount([
    "not-json",
    JSON.stringify({ "@graph": [{ "@type": "CollectionPage" }, { "@type": "ItemList", numberOfItems: 48 }] }),
  ]), 48);
  assert.equal(entityHubItemCount([JSON.stringify({ "@type": "CollectionPage" })]), null);
});

test("summarizeHistory compares the current run with the most recent result", () => {
  const trend = summarizeHistory([
    { generated_at: "2026-07-29T00:00:00.000Z", summary: { checks: 120, failed: 1 } },
    { generated_at: "2026-07-30T00:00:00.000Z", summary: { checks: 125, failed: 3 } },
  ], { summary: { checks: 130, failed: 2 } });

  assert.deepEqual(trend, {
    previous_generated_at: "2026-07-30T00:00:00.000Z",
    failed_delta: -1,
    checks_delta: 5,
  });
});

test("schemaTypes recursively finds semantic page types", () => {
  assert.deepEqual(schemaTypes([
    JSON.stringify({
      "@graph": [
        { "@type": "Report", about: { "@type": "Place" } },
        { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem" }] },
      ],
    }),
  ]), ["Report", "Place", "BreadcrumbList", "ListItem"]);
});

test("expectedSchemaType defines representative production page contracts", () => {
  assert.equal(expectedSchemaType("/"), "WebSite");
  assert.equal(expectedSchemaType("/projects"), "CollectionPage");
  assert.equal(expectedSchemaType("/permits/123"), "Report");
  assert.equal(expectedSchemaType("/contractor/example"), "LocalBusiness");
  assert.equal(expectedSchemaType("/address/example"), "Place");
  assert.equal(expectedSchemaType("/project/example"), "CreativeWork");
  assert.equal(expectedSchemaType("/neighborhood/example"), "CollectionPage");
  assert.equal(expectedSchemaType("/insights"), "CollectionPage");
  assert.equal(expectedSchemaType("/insights/plan-review"), "Dataset");
  assert.equal(expectedSchemaType("/insights/network"), "Dataset");
  assert.equal(expectedSchemaType("/about"), "AboutPage");
  assert.equal(expectedSchemaType("/methodology"), "AboutPage");
  assert.equal(expectedSchemaType("/data"), "Dataset");
  assert.equal(expectedSchemaType("/api-docs"), "TechArticle");
  assert.equal(expectedSchemaType("/not-a-real-route"), null);
});

test("titleBudget keeps address titles inside SERP truncation while allowing permit detail titles", () => {
  assert.equal(titleBudget("/address/10-e-allison-st-seattle-wa"), 62);
  assert.equal(titleBudget("/neighborhood/beacon-hill"), 70);
  assert.equal(titleBudget("/permits/6641818-CN"), 92);
  assert.ok(titleBudget("/address/example") < titleBudget("/permits/example"));
});

test("decodedTitleLength measures rendered text rather than HTML entities", () => {
  assert.equal(decodedTitleLength("Seattle Construction Permits &amp; Projects — Building Seattle"), 58);
  const raw = "A &amp; B &#39;quoted&#39;";
  const rendered = "A & B 'quoted'";
  assert.equal(decodedTitleLength(raw), rendered.length);
  assert.ok(decodedTitleLength(raw) < raw.length);
});

test("pngDimensions reads width and height from the IHDR chunk", () => {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x04, 0xb0,
    0x00, 0x00, 0x02, 0x76,
  ]);
  assert.deepEqual(pngDimensions(png), { width: 1200, height: 630 });
});

test("pngDimensions rejects truncated and non-PNG payloads", () => {
  assert.equal(pngDimensions(new Uint8Array(10)), null);
  assert.equal(pngDimensions(new Uint8Array(new Array(24).fill(0x41))), null);
  assert.equal(pngDimensions(undefined), null);
});
