import assert from "node:assert/strict";
import test from "node:test";

import {
  entityHubItemCount,
  expectedSchemaType,
  htmlMetadata,
  pngDimensions,
  schemaTypes,
  summarizeHistory,
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
  assert.equal(expectedSchemaType("/neighborhood/example"), null);
});

test("pngDimensions validates the PNG signature and reads IHDR dimensions", () => {
  const pngHeader = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 4, 176, 0, 0, 2, 118,
  ]);
  assert.deepEqual(pngDimensions(pngHeader), { width: 1200, height: 630 });
  assert.equal(pngDimensions(Uint8Array.from([1, 2, 3])), null);
});
