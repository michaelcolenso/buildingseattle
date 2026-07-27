import assert from "node:assert/strict";
import test from "node:test";

import { htmlMetadata, xmlLocations } from "../scripts/check_seo_health.mjs";

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
