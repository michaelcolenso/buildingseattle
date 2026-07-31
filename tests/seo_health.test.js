import assert from "node:assert/strict";
import test from "node:test";

import {
  entityHubItemCount,
  htmlMetadata,
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
