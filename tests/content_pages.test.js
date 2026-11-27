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
