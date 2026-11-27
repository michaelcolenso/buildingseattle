import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

import worker from "../worker.js";
import {
  ANALYTICS_MAX_DAYS,
  clampAnalyticsDays,
  isLikelyBot,
  PAGE_VIEW_RETENTION_CRON,
  pageViewSampleRate,
  pageViewTemplatePath,
  prunePageViews,
  recordPageView,
  retentionCutoff,
  shouldLogPageView,
} from "../page_views.js";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const BOTS = [
  "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
  "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
  "Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/131.0.6778.204 Safari/537.36",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
  "curl/8.4.0",
  "python-requests/2.31.0",
  "Go-http-client/1.1",
  "UptimeRobot/2.0",
  "",
];

function request(path, ua, extra = {}) {
  const headers = ua === undefined ? {} : { "User-Agent": ua };
  return new Request(`https://buildingseattle.com${path}`, { headers: { ...headers, ...(extra.headers || {}) } });
}

test("known bots, crawlers, scripted clients and empty UAs are not logged; browsers are", () => {
  for (const ua of BOTS) assert.equal(isLikelyBot(ua), true, `expected bot: ${ua || "(empty)"}`);
  for (const ua of [CHROME, SAFARI_IOS, "Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"]) {
    assert.equal(isLikelyBot(ua), false, `expected human: ${ua}`);
  }
  assert.equal(shouldLogPageView(request("/", BOTS[0]), {}), false);
  assert.equal(shouldLogPageView(request("/", CHROME), {}), true);
});

test("sampling rate comes from PAGE_VIEW_SAMPLE_RATE, clamped, default 1, 0 disables", () => {
  assert.equal(pageViewSampleRate({}), 1);
  assert.equal(pageViewSampleRate({ PAGE_VIEW_SAMPLE_RATE: "0.25" }), 0.25);
  assert.equal(pageViewSampleRate({ PAGE_VIEW_SAMPLE_RATE: "7" }), 1);
  assert.equal(pageViewSampleRate({ PAGE_VIEW_SAMPLE_RATE: "-1" }), 0);
  assert.equal(pageViewSampleRate({ PAGE_VIEW_SAMPLE_RATE: "junk" }), 1);
  const human = request("/", CHROME);
  assert.equal(shouldLogPageView(human, { PAGE_VIEW_SAMPLE_RATE: "0" }), false);
  assert.equal(shouldLogPageView(human, { PAGE_VIEW_SAMPLE_RATE: "0.25" }, () => 0.1), true);
  assert.equal(shouldLogPageView(human, { PAGE_VIEW_SAMPLE_RATE: "0.25" }, () => 0.9), false);
});

test("recordPageView truncates referrer/UA and never throws", async () => {
  const bound = [];
  const env = {
    DB: { prepare: () => ({ bind: (...args) => { bound.push(args); return { run: async () => ({}) }; } }) },
  };
  const longUa = `${CHROME} ${"x".repeat(2000)}`;
  const req = request("/data", longUa, { headers: { Referer: `https://example.com/${"r".repeat(2000)}` } });
  assert.equal(await recordPageView(req, env, "/data"), true);
  const [path, referrer, ua] = bound[0];
  assert.equal(path, "/data");
  assert.equal(referrer.length, 300);
  assert.equal(ua.length, 300);

  const broken = { DB: { prepare: () => { throw new Error("D1 down"); } } };
  assert.equal(await recordPageView(request("/", CHROME), broken, "/"), false);
  assert.equal(await recordPageView(request("/", BOTS[0]), env, "/"), false);
  assert.equal(bound.length, 1, "bot request wrote nothing");
});

test("a bot request through the worker writes no page_views row; a browser request does", async () => {
  const inserts = [];
  const env = {
    DB: {
      prepare(sql) {
        const statement = {
          bind: (...args) => { statement.args = args; return statement; },
          run: async () => { if (/INSERT INTO page_views/.test(sql)) inserts.push(statement.args); return {}; },
          first: async () => null,
          all: async () => ({ results: [] }),
        };
        return statement;
      },
    },
  };
  const ctx = { waits: [], waitUntil(p) { this.waits.push(p); } };
  await worker.fetch(request("/about", BOTS[0]), env, ctx);
  await Promise.all(ctx.waits);
  assert.equal(inserts.length, 0);
  await worker.fetch(request("/about", CHROME), env, ctx);
  await Promise.all(ctx.waits);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][0], "/about");
});

test("cache hits log the same route template a miss logs", () => {
  assert.equal(pageViewTemplatePath("/permits/7126462-CN"), "/permits/:id");
  assert.equal(pageViewTemplatePath("/address/1707-sunset-ave-sw-seattle-wa"), "/address/:slug");
  assert.equal(pageViewTemplatePath("/contractor/acme"), "/contractor/:slug");
  assert.equal(pageViewTemplatePath("/project/x"), "/project/:slug");
  assert.equal(pageViewTemplatePath("/neighborhood/ballard"), "/neighborhood/:slug");
  assert.equal(pageViewTemplatePath("/permits"), "/permits");
  assert.equal(pageViewTemplatePath("/about/"), "/about");
  assert.equal(pageViewTemplatePath("/"), "/");
});

function pageViewsDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return db;
}

// Minimal D1 shim over node:sqlite that records each statement.
function d1(db, log = []) {
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...values) { args = values; return stmt; },
        async run() {
          log.push(sql);
          const info = db.prepare(sql).run(...args);
          return { meta: { changes: Number(info.changes) } };
        },
      };
      return stmt;
    },
  };
}

test("retention deletes only rows older than 90 days, in bounded batches", async () => {
  const db = pageViewsDb();
  const insert = db.prepare("INSERT INTO page_views (path, created_at) VALUES (?, ?)");
  const now = new Date("2026-11-27T13:00:00Z");
  for (let i = 0; i < 23; i += 1) insert.run(`/old/${i}`, "2026-06-01 00:00:00");
  insert.run("/edge-old", "2026-08-29 12:59:59");
  insert.run("/edge-kept", "2026-08-29 13:00:00");
  for (let i = 0; i < 5; i += 1) insert.run(`/new/${i}`, "2026-11-20 00:00:00");

  assert.equal(retentionCutoff(now), "2026-08-29 13:00:00");

  const log = [];
  const first = await prunePageViews(d1(db, log), { now, batchSize: 5, maxBatches: 3 });
  assert.deepEqual({ deleted: first.deleted, batches: first.batches, complete: first.complete }, { deleted: 15, batches: 3, complete: false });
  assert.equal(log.length, 3, "never more than maxBatches statements per run");
  assert.ok(log.every((sql) => /LIMIT \?/.test(sql)), "every delete is bounded");

  const second = await prunePageViews(d1(db), { now, batchSize: 5, maxBatches: 3 });
  assert.equal(second.deleted, 9);
  assert.equal(second.complete, true, "stops once nothing old is left");
  const left = db.prepare("SELECT path FROM page_views ORDER BY id").all().map((row) => row.path);
  assert.deepEqual(left, ["/edge-kept", "/new/0", "/new/1", "/new/2", "/new/3", "/new/4"]);

  const plan = db
    .prepare("EXPLAIN QUERY PLAN SELECT id FROM page_views WHERE created_at < ? ORDER BY created_at LIMIT ?")
    .all("2026-08-29 13:00:00", 5)
    .map((row) => row.detail)
    .join(" | ");
  assert.match(plan, /idx_page_views_created_at/, "batches walk the created_at index, not the table");
  db.close();
});

test("the daily cron runs page_views retention alongside the ingest", async () => {
  const deletes = [];
  const env = {
    DB: {
      prepare(sql) {
        const statement = {
          bind: () => statement,
          run: async () => { if (/DELETE FROM page_views/.test(sql)) deletes.push(sql); return { meta: { changes: 0 } }; },
          first: async () => null,
          all: async () => ({ results: [] }),
        };
        return statement;
      },
    },
  };
  const waits = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("no network in tests"); };
  const originalError = console.error;
  console.error = () => {};
  try {
    await worker.scheduled({ cron: PAGE_VIEW_RETENTION_CRON }, env, { waitUntil(p) { waits.push(p); } });
    await Promise.allSettled(waits);
    assert.equal(deletes.length, 1, "one bounded delete ran (and stopped: nothing to prune)");
    // The ingest trigger never runs retention (S7).
    await worker.scheduled({ cron: "0 13 * * *" }, env, { waitUntil(p) { waits.push(p); } });
    await Promise.allSettled(waits);
    assert.equal(deletes.length, 1, "the ingest cron does not prune page_views");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("wrangler.toml has the ingest cron and the separate retention cron (S7)", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const crons = JSON.parse(toml.match(/^crons\s*=\s*(\[[^\]]*\])/m)[1]);
  assert.deepEqual(crons, ["0 13 * * *", PAGE_VIEW_RETENTION_CRON]);
  const [minute, hour] = PAGE_VIEW_RETENTION_CRON.split(" ").map(Number);
  assert.ok(Math.abs(hour * 60 + minute - 13 * 60) >= 120, "retention runs well away from the 13:00 UTC ingest");
});

test("/api/admin/analytics clamps days to 1..30", async () => {
  assert.equal(clampAnalyticsDays(undefined), 7);
  assert.equal(clampAnalyticsDays("3650"), ANALYTICS_MAX_DAYS);
  assert.equal(clampAnalyticsDays("0"), 1);
  assert.equal(clampAnalyticsDays("-5"), 1);
  assert.equal(clampAnalyticsDays("abc"), 7);

  const binds = [];
  const env = {
    ADMIN_API_TOKEN: "test-admin-token",
    DB: {
      prepare() {
        const statement = {
          bind: (...args) => { binds.push(args[0]); return statement; },
          all: async () => ({ results: [{ total: 0 }] }),
          run: async () => ({}),
        };
        return statement;
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://buildingseattle.com/api/admin/analytics?days=100000", { headers: { "X-Admin-Token": "test-admin-token" } }),
    env,
    { waitUntil() {} },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.days, 30);
  const since = new Date(binds[0]);
  const ageDays = (Date.now() - since.getTime()) / 86400000;
  assert.ok(ageDays <= 31, `query window is at most 30 days (got ${ageDays.toFixed(1)})`);
});
