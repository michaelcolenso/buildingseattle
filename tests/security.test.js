import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker, { sendPendingPermitAlerts } from "../worker.js";
import { themeBootScript } from "../brand_ui.js";
import {
  ALERT_EMAIL_DAILY_LIMIT,
  ALERT_IP_HOURLY_LIMIT,
  ANON_API_MAX_PAGE,
  ANON_API_MAX_PER_PAGE,
  LEAD_IP_HOURLY_LIMIT,
  THEME_BOOT_SCRIPT_SHA256,
  consumeD1RateLimit,
  turnstileEnabled,
  isCrossSiteRequest,
  parseIntegerParam,
  sha256Hex,
  timingSafeEqualString,
} from "../security.js";

// Audit fixes A1, A3, A4, A7, A8, A11, A12, A15, A16, A18, A21, B3, F2, F10,
// F11, exercised through the real worker.fetch on SQLite (schema.sql, every
// migration, and migrations/0002_security_hardening.sql) behind a D1 shim.

const ADMIN_TOKEN = "test-admin-token";
const API_KEY = "test-api-key-123";
const SITE = "https://buildingseattle.com";

function openDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const migrations = readdirSync(new URL("..", import.meta.url))
    .filter((name) => /^migration_.*\.sql$/.test(name))
    .sort()
    .map((name) => `../${name}`);
  migrations.push("../migrations/0002_security_hardening.sql");
  for (const file of migrations) {
    const sql = readFileSync(new URL(file, import.meta.url), "utf8");
    // Older migrations re-add columns schema.sql already has; apply each
    // statement on its own and skip only those duplicates.
    for (const statement of sql.split(/;\s*(?:\n|$)/)) {
      if (!statement.replace(/--.*$/gm, "").trim()) continue;
      try {
        db.exec(statement);
      } catch (error) {
        if (!/duplicate column|already exists/i.test(error.message)) throw new Error(`${file}: ${error.message}`);
      }
    }
  }
  db.exec("DELETE FROM permits; DELETE FROM contractors;");
  const insert = db.prepare(
    "INSERT INTO permits (permit_number, address, neighborhood, type, value, status, description, detailed_description, issued_date, parcel_number) VALUES (?, ?, 'Ballard', 'residential', ?, 'active', 'New house', 'Long enriched text', ?, '123')",
  );
  for (let i = 1; i <= 120; i++) {
    insert.run(`P-${i}`, `${i} Main St, Seattle, WA`, 1000 * i, `2026-01-${String((i % 28) + 1).padStart(2, "0")}`);
  }
  return db;
}

// D1-shaped wrapper. Every call yields to the event loop first, the way a
// network round trip to D1 would, so overlapping runs really interleave.
function createEnv(db, extra = {}) {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const wrap = (sql, binds = []) => ({
    sql,
    binds,
    bind: (...next) => wrap(sql, next),
    all: async () => {
      await tick();
      return { results: db.prepare(sql).all(...binds) };
    },
    first: async () => {
      await tick();
      return db.prepare(sql).get(...binds) ?? null;
    },
    run: async () => {
      await tick();
      const result = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
  });
  const sentEmails = [];
  return {
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    INGEST_API_TOKEN: "test-ingest-token",
    sentEmails,
    EMAIL: {
      async send(message) {
        await tick();
        sentEmails.push(structuredClone(message));
        return { messageId: `m-${sentEmails.length}` };
      },
    },
    DB: {
      prepare: (sql) => wrap(sql),
      batch: async (batch) => {
        db.exec("BEGIN");
        try {
          const results = batch.map((statement) => ({ success: true, meta: db.prepare(statement.sql).run(...statement.binds) }));
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    ...extra,
  };
}

function ctx() {
  const promises = [];
  return { promises, waitUntil: (promise) => promises.push(promise) };
}

async function call(env, path, init = {}) {
  const context = ctx();
  const response = await worker.fetch(new Request(`${SITE}${path}`, init), env, context);
  await Promise.allSettled(context.promises);
  return response;
}

function subscribe(env, body, headers = {}) {
  return call(env, "/alerts/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SITE, "CF-Connecting-IP": "203.0.113.7", ...headers },
    body: JSON.stringify(body),
  });
}

function tokenFrom(email, pattern) {
  const match = email.text.match(pattern);
  return match ? new URL(match[0]).searchParams.get("token") : null;
}

async function confirm(env, token, headers = {}) {
  return call(env, "/alerts/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ token }).toString(),
  });
}

async function subscribeAndConfirm(env, db, permit = "P-1", email = "reader@example.com") {
  assert.equal((await subscribe(env, { email, permit_number: permit })).status, 202);
  const token = tokenFrom(env.sentEmails.at(-1), /https:\/\/\S+\/alerts\/confirm\?token=\S+/);
  assert.equal((await confirm(env, token)).status, 200);
  return db.prepare("SELECT * FROM permit_alert_subscriptions WHERE email = ? AND permit_number = ?").get(email, permit);
}

// --- A1 / B3 / F10: alert sign-up abuse ------------------------------------

test("repeated sign-ups for one address and permit send one confirmation (cooldown)", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  for (let i = 0; i < 5; i++) {
    const response = await subscribe(env, { email: "victim@example.com", permit_number: "P-1" });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { success: true, status: "pending_confirmation" });
  }
  assert.equal(env.sentEmails.length, 1);
});

test("one address gets at most the daily cap of confirmations across permits", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  const statuses = [];
  let overCap = null;
  for (let i = 1; i <= ALERT_EMAIL_DAILY_LIMIT + 3; i++) {
    const response = await subscribe(env, { email: "victim@example.com", permit_number: `P-${i}` }, { "CF-Connecting-IP": `198.51.100.${i}` });
    statuses.push(response.status);
    if (response.status === 429) overCap = { body: await response.json(), retryAfter: response.headers.get("Retry-After") };
  }
  assert.equal(env.sentEmails.length, ALERT_EMAIL_DAILY_LIMIT);
  assert.deepEqual(statuses, [...Array(ALERT_EMAIL_DAILY_LIMIT).fill(202), 429, 429, 429]);
  // Over the cap the person is told why, instead of a 202 for an email that never comes (S2).
  assert.match(overCap.body.error, /already been sent \d+ alert confirmations today.*try again tomorrow/);
  assert.equal(overCap.retryAfter, "86400");
});

test("one IP is throttled after the hourly limit (D1 fallback limiter)", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  const statuses = [];
  for (let i = 1; i <= ALERT_IP_HOURLY_LIMIT + 2; i++) {
    statuses.push((await subscribe(env, { email: `user${i}@example.com`, permit_number: "P-1" })).status);
  }
  assert.deepEqual(statuses.slice(0, ALERT_IP_HOURLY_LIMIT), Array(ALERT_IP_HOURLY_LIMIT).fill(202));
  assert.deepEqual(statuses.slice(ALERT_IP_HOURLY_LIMIT), [429, 429]);
  assert.equal(env.sentEmails.length, ALERT_IP_HOURLY_LIMIT);
  // Bucket keys are hashed; no raw IP is stored.
  const keys = db.prepare("SELECT bucket_key FROM request_rate_limits").all().map((row) => row.bucket_key);
  assert.ok(keys.length > 0);
  assert.ok(keys.every((key) => !key.includes("203.0.113.7") && !key.includes("@")));
});

test("the hourly cap still applies when the per-minute binding allows every request (S2)", async () => {
  const db = openDatabase();
  const env = createEnv(db, { ALERTS_RATE_LIMITER: { limit: async () => ({ success: true }) } });
  const statuses = [];
  for (let i = 1; i <= ALERT_IP_HOURLY_LIMIT + 2; i++) {
    statuses.push((await subscribe(env, { email: `user${i}@example.com`, permit_number: "P-1" })).status);
  }
  assert.deepEqual(statuses, [...Array(ALERT_IP_HOURLY_LIMIT).fill(202), 429, 429]);
});

test("a D1 counter outage fails closed with a 503, not a 'too many requests' (S2)", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (/request_rate_limits/.test(sql)) throw new Error("D1_ERROR: unavailable");
    return prepare(sql);
  };
  const response = await subscribe(env, { email: "a@example.com", permit_number: "P-1" });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /temporarily unavailable/);
  assert.equal(env.sentEmails.length, 0);
});

test("the Workers Rate Limiting binding is used when configured", async () => {
  const db = openDatabase();
  const seen = [];
  const env = createEnv(db, {
    ALERTS_RATE_LIMITER: {
      async limit({ key }) {
        seen.push(key);
        return { success: seen.length <= 1 };
      },
    },
  });
  assert.equal((await subscribe(env, { email: "a@example.com", permit_number: "P-1" })).status, 202);
  assert.equal((await subscribe(env, { email: "b@example.com", permit_number: "P-1" })).status, 429);
  assert.match(seen[0], /^alerts:ip:[0-9a-f]{32}$/);
});

test("sign-up refuses cross-site browsers, non-JSON bodies and CORS preflights", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  const crossSite = await subscribe(env, { email: "a@example.com", permit_number: "P-1" }, { Origin: "https://evil.example" });
  assert.equal(crossSite.status, 403);
  const fetchSite = await subscribe(env, { email: "a@example.com", permit_number: "P-1" }, { Origin: "", "Sec-Fetch-Site": "cross-site" });
  assert.equal(fetchSite.status, 403);
  const textPlain = await call(env, "/alerts/subscribe", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: SITE },
    body: JSON.stringify({ email: "a@example.com", permit_number: "P-1" }),
  });
  assert.equal(textPlain.status, 415);
  const preflight = await call(env, "/alerts/subscribe", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), null);
  const ok = await subscribe(env, { email: "a@example.com", permit_number: "P-1" });
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(env.sentEmails.length, 1);
});

test("an active subscriber gets the same answer as a new one and no email (A12)", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  await subscribeAndConfirm(env, db);
  const before = env.sentEmails.length;
  const response = await subscribe(env, { email: "reader@example.com", permit_number: "P-1" });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { success: true, status: "pending_confirmation" });
  assert.equal(env.sentEmails.length, before);
});

test("unsubscribed pairs and suppressed addresses are never re-mailed", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  const subscription = await subscribeAndConfirm(env, db);
  const unsubscribed = await call(env, `/alerts/unsubscribe?token=${subscription.unsubscribe_token}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  assert.equal(unsubscribed.status, 200);
  const sentBefore = env.sentEmails.length;
  assert.equal((await subscribe(env, { email: "reader@example.com", permit_number: "P-1" })).status, 202);
  assert.equal(env.sentEmails.length, sentBefore, "unsubscribed pair is not re-opened without verification");

  // "Didn't ask for this?" link in a confirmation suppresses the address.
  await subscribe(env, { email: "target@example.com", permit_number: "P-2" }, { "CF-Connecting-IP": "198.51.100.9" });
  const blockLink = env.sentEmails.at(-1).text.match(/https:\/\/\S+\/alerts\/unsubscribe\?token=\S+&scope=all/)[0];
  const page = await call(env, new URL(blockLink).pathname + new URL(blockLink).search);
  assert.match(await page.text(), /Stop all Building Seattle email to this address/);
  const blocked = await call(env, "/alerts/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: new URL(blockLink).searchParams.get("token"), scope: "all" }).toString(),
  });
  assert.equal(blocked.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alert_email_suppressions WHERE email = 'target@example.com'").get().n, 1);
  const count = env.sentEmails.length;
  assert.equal((await subscribe(env, { email: "target@example.com", permit_number: "P-3" }, { "CF-Connecting-IP": "198.51.100.9" })).status, 202);
  assert.equal(env.sentEmails.length, count);
});

test("Turnstile is enforced only when both keys are set", async () => {
  const db = openDatabase();
  const env = createEnv(db, { TURNSTILE_SECRET_KEY: "secret", TURNSTILE_SITE_KEY: "site-key-1" });
  const realFetch = globalThis.fetch;
  const verifications = [];
  globalThis.fetch = async (url, init) => {
    verifications.push({ url: String(url), response: init.body.get("response") });
    return new Response(JSON.stringify({ success: init.body.get("response") === "good-token" }), { status: 200 });
  };
  try {
    assert.equal((await subscribe(env, { email: "a@example.com", permit_number: "P-1" })).status, 403);
    assert.equal((await subscribe(env, { email: "a@example.com", permit_number: "P-1", turnstile_token: "bad" })).status, 403);
    assert.equal((await subscribe(env, { email: "a@example.com", permit_number: "P-1", turnstile_token: "good-token" })).status, 202);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(env.sentEmails.length, 1);
  assert.equal(verifications.at(-1).url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
});

test("one Turnstile key alone turns Turnstile off instead of refusing every sign-up (S3)", async () => {
  const db = openDatabase();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const secretOnly = createEnv(db, { TURNSTILE_SECRET_KEY: "secret" });
    assert.equal(turnstileEnabled(secretOnly), false);
    assert.equal((await subscribe(secretOnly, { email: "a@example.com", permit_number: "P-1" })).status, 202);
    assert.equal(secretOnly.sentEmails.length, 1);
    const siteOnly = createEnv(db, { TURNSTILE_SITE_KEY: "site-key-1" });
    assert.equal(turnstileEnabled(siteOnly), false);
    assert.doesNotMatch(await (await call(siteOnly, "/permits/P-1")).text(), /cf-turnstile/);
    assert.equal(turnstileEnabled({ TURNSTILE_SITE_KEY: "a", TURNSTILE_SECRET_KEY: "b" }), true);
    assert.equal(turnstileEnabled({}), false);
  } finally {
    console.warn = warn;
  }
});

test("the permit page renders the Turnstile widget only when both keys are set", async () => {
  const db = openDatabase();
  const plain = await (await call(createEnv(db), "/permits/P-1")).text();
  assert.doesNotMatch(plain, /cf-turnstile|challenges\.cloudflare\.com/);
  const withKey = await (await call(createEnv(db, { TURNSTILE_SITE_KEY: "site-key-1", TURNSTILE_SECRET_KEY: "secret" }), "/permits/P-1")).text();
  assert.match(withKey, /class="cf-turnstile" data-sitekey="site-key-1"/);
  assert.match(withKey, /<script src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js" async defer><\/script>/);
});

// --- A11 / A12: confirm and unsubscribe -------------------------------------

test("GET confirm only renders a POST button; cross-site POSTs are refused", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  await subscribe(env, { email: "reader@example.com", permit_number: "P-1" });
  const token = tokenFrom(env.sentEmails[0], /https:\/\/\S+\/alerts\/confirm\?token=\S+/);
  const page = await call(env, `/alerts/confirm?token=${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<form method="post" action="\/alerts\/confirm"/);
  const status = () => db.prepare("SELECT status FROM permit_alert_subscriptions").get().status;
  assert.equal(status(), "pending");
  assert.equal((await confirm(env, token, { Origin: "https://evil.example" })).status, 403);
  assert.equal(status(), "pending");
  assert.equal((await confirm(env, token, { Origin: SITE })).status, 200);
  assert.equal(status(), "active");
  assert.equal((await confirm(env, token)).status, 404, "a used token cannot confirm twice");
});

test("pending confirmation links expire", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  await subscribe(env, { email: "reader@example.com", permit_number: "P-1" });
  const token = tokenFrom(env.sentEmails[0], /https:\/\/\S+\/alerts\/confirm\?token=\S+/);
  db.exec("UPDATE permit_alert_subscriptions SET confirmation_sent_at = datetime('now', '-8 days')");
  assert.equal((await call(env, `/alerts/confirm?token=${token}`)).status, 404);
  assert.equal((await confirm(env, token)).status, 404);
  assert.equal(db.prepare("SELECT status FROM permit_alert_subscriptions").get().status, "pending");
});

test("GET unsubscribe shows a button; RFC 8058 one-click POST still works", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  const subscription = await subscribeAndConfirm(env, db);
  const page = await call(env, `/alerts/unsubscribe?token=${subscription.unsubscribe_token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<form method="post" action="\/alerts\/unsubscribe\?token=/);
  assert.equal(db.prepare("SELECT status FROM permit_alert_subscriptions").get().status, "active");

  const oneClick = await call(env, `/alerts/unsubscribe?token=${subscription.unsubscribe_token}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  assert.equal(oneClick.status, 200);
  assert.equal(db.prepare("SELECT status FROM permit_alert_subscriptions").get().status, "unsubscribed");
});

// --- A3: duplicate alerts --------------------------------------------------

test("overlapping alert runs send each status change once", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  await subscribeAndConfirm(env, db);
  db.exec("INSERT INTO permit_status_changes (permit_number, previous_status, new_status) VALUES ('P-1', 'active', 'completed')");
  const before = env.sentEmails.length;
  const runs = await Promise.all([sendPendingPermitAlerts(env), sendPendingPermitAlerts(env), sendPendingPermitAlerts(env)]);
  assert.equal(env.sentEmails.length, before + 1);
  assert.equal(runs.reduce((sum, run) => sum + run.sent, 0), 1);
  const alert = env.sentEmails.at(-1);
  assert.match(alert.subject, /P-1 changed to completed/);
  assert.equal(alert.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.equal((await sendPendingPermitAlerts(env)).sent, 0);
  assert.equal(db.prepare("SELECT status FROM permit_alert_deliveries").get().status, "sent");
});

test("a failed alert send releases its claim for the next run", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  await subscribeAndConfirm(env, db);
  db.exec("INSERT INTO permit_status_changes (permit_number, previous_status, new_status) VALUES ('P-1', 'active', 'expired')");
  const realSend = env.EMAIL.send;
  env.EMAIL.send = async () => {
    throw new Error("mail down");
  };
  assert.deepEqual(await sendPendingPermitAlerts(env), { sent: 0, failed: 1, skipped: 0 });
  env.EMAIL.send = realSend;
  assert.equal((await sendPendingPermitAlerts(env)).sent, 1);
});

// --- A4: bad input ---------------------------------------------------------

test("bad input answers 400/404 with generic text, never a raw error", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  const cases = [
    ["/permits?page=abc", 400],
    ["/permits?page=-1", 400],
    ["/permits/%E0%A4%A", 400],
    ["/contractor/%E0%A4%A", 400],
    ["/address/%ZZ", 400],
    ["/project/%ZZ", 400],
    ["/neighborhood/%ZZ", 400],
    ["/api/development-sites/%ZZ/geometry", 400],
    ["/sitemaps/constructor.xml", 404],
    ["/sitemaps/__proto__.xml", 404],
    ["/sitemaps/hasOwnProperty-1.xml", 404],
    ["/api/basis-reset?limit=abc", 400],
    ["/api/permits?page=abc", 400],
    ["/api/permits?per_page=1e3", 400],
    [`/api/permits?q=${"x".repeat(101)}`, 400],
    [`/permits?q=${"x".repeat(101)}`, 400],
  ];
  for (const [path, status] of cases) {
    const response = await call(env, path);
    const body = await response.text();
    assert.equal(response.status, status, path);
    assert.doesNotMatch(body, /no such column|URI malformed|TypeError|datatype mismatch|NaN|details/i, path);
  }
  const analytics = await call(env, "/api/admin/analytics?days=abc", { headers: { "X-Admin-Token": ADMIN_TOKEN } });
  assert.equal(analytics.status, 400);
});

test("an unexpected failure is logged and answered with a generic 500", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  env.DB.prepare = () => {
    throw new Error("D1_ERROR: no such table: secret_internal_table");
  };
  const realError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const response = await call(env, "/api/permits");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Internal Server Error" });
  } finally {
    console.error = realError;
  }
  assert.ok(logged.some((line) => line.includes("secret_internal_table")), "detail stays in the server log");
});

// --- A7 / F2: public API tiers ---------------------------------------------

test("anonymous /api/permits is a capped, slim, noindexed sample", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  const response = await call(env, "/api/permits?per_page=100");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex");
  const body = await response.json();
  assert.equal(body.access, "anonymous");
  assert.equal(body.per_page, ANON_API_MAX_PER_PAGE);
  assert.equal(body.results.length, ANON_API_MAX_PER_PAGE);
  assert.equal("detailed_description" in body.results[0], false);
  assert.equal("parcel_number" in body.results[0], false);
  assert.equal("contractor_email" in body.results[0], false);
  assert.ok(body.results[0].permit_number);
  assert.equal((await call(env, `/api/permits?page=${ANON_API_MAX_PAGE + 1}`)).status, 403);
});

test("an API key from env.API_KEYS or the api_keys table unlocks full rows and depth", async () => {
  const db = openDatabase();
  const stored = "stored-key-456";
  db.prepare("INSERT INTO api_keys (key_hash, label) VALUES (?, 'test')").run(await sha256Hex(stored));
  db.prepare("INSERT INTO api_keys (key_hash, label, revoked_at) VALUES (?, 'old', datetime('now'))").run(await sha256Hex("revoked-key"));
  const env = createEnv(db, { API_KEYS: `other-key, ${API_KEY}` });

  const keyed = await call(env, "/api/permits?per_page=100&page=1", { headers: { "X-API-Key": API_KEY } });
  const body = await keyed.json();
  assert.equal(body.access, "key");
  assert.equal(body.results.length, 100);
  assert.equal(body.results[0].detailed_description, "Long enriched text");
  assert.match(keyed.headers.get("Cache-Control"), /private/);

  const deep = await call(env, `/api/permits?per_page=10&page=${ANON_API_MAX_PAGE + 1}`, { headers: { Authorization: `Bearer ${stored}` } });
  assert.equal(deep.status, 200);
  assert.equal((await deep.json()).results.length, 10);

  assert.equal((await call(env, "/api/permits", { headers: { "X-API-Key": "wrong" } })).status, 401);
  assert.equal((await call(env, "/api/permits", { headers: { "X-API-Key": "revoked-key" } })).status, 401);
});

test("the API rate-limit binding returns 429 per tier", async () => {
  const db = openDatabase();
  const keys = [];
  const env = createEnv(db, {
    API_KEYS: API_KEY,
    API_RATE_LIMITER: { limit: async ({ key }) => (keys.push(key), { success: false }) },
    API_KEY_RATE_LIMITER: { limit: async ({ key }) => (keys.push(key), { success: true }) },
  });
  const anonymous = await call(env, "/api/stats");
  assert.equal(anonymous.status, 429);
  assert.equal(anonymous.headers.get("Retry-After"), "60");
  assert.equal((await call(env, "/api/permits", { headers: { "X-API-Key": API_KEY } })).status, 200);
  assert.equal((await call(env, "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 429);
  assert.match(keys[1], /^api:env:[0-9a-f]{12}$/);
});

// --- F11 / A15: MCP --------------------------------------------------------

function mcpCall(env, args, headers = {}) {
  return call(env, "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_permits", arguments: args } }),
  });
}

test("MCP search_permits is sample-sized without a key and full with one", async () => {
  const db = openDatabase();
  const env = createEnv(db, { API_KEYS: API_KEY });
  const anonymous = await (await mcpCall(env, { per_page: 100 })).json();
  assert.equal(anonymous.result.structuredContent.results.length, ANON_API_MAX_PER_PAGE);
  assert.equal("detailed_description" in anonymous.result.structuredContent.results[0], false);
  assert.match(anonymous.result.content.at(-1).text, /buildingseattle\.com\/data/);
  assert.equal(anonymous.result._meta["buildingseattle.com/attribution"].access, "anonymous");

  const tooDeep = await (await mcpCall(env, { page: ANON_API_MAX_PAGE + 1 })).json();
  assert.equal(tooDeep.result.isError, true);
  assert.match(tooDeep.result.content[0].text, /first 10 pages/);

  const keyed = await (await mcpCall(env, { per_page: 100 }, { "X-API-Key": API_KEY })).json();
  assert.equal(keyed.result.structuredContent.results.length, 100);
  assert.equal(keyed.result.structuredContent.results[0].detailed_description, "Long enriched text");
});

test("/api/contractors and MCP list_contractors hide phone and email from anonymous callers (N11)", async () => {
  const db = openDatabase();
  db.prepare("INSERT INTO contractors (id, name, slug, phone, email, website) VALUES (1, 'Acme', 'acme', '206-555-0100', 'hi@acme.example', 'https://acme.example')").run();
  db.exec("UPDATE permits SET contractor_id = 1 WHERE permit_number IN ('P-1', 'P-2')");
  const env = createEnv(db, { API_KEYS: API_KEY });

  const anonymous = await call(env, "/api/contractors");
  const [row] = await anonymous.json();
  assert.equal(row.name, "Acme");
  assert.equal(row.active_projects, 2);
  assert.equal(row.website, "https://acme.example");
  assert.equal("phone" in row, false);
  assert.equal("email" in row, false);
  assert.match(anonymous.headers.get("Cache-Control"), /public/);
  assert.match(anonymous.headers.get("Vary") || "", /X-API-Key/);

  const keyed = await call(env, "/api/contractors", { headers: { "X-API-Key": API_KEY } });
  const [full] = await keyed.json();
  assert.equal(full.phone, "206-555-0100");
  assert.equal(full.email, "hi@acme.example");
  assert.equal(keyed.headers.get("Cache-Control"), "private, no-store");

  const mcp = (headers = {}) =>
    call(env, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_contractors", arguments: {} } }),
    }).then((response) => response.json());
  assert.doesNotMatch(JSON.stringify((await mcp()).result), /206-555-0100|hi@acme\.example/);
  assert.match(JSON.stringify((await mcp({ "X-API-Key": API_KEY })).result), /hi@acme\.example/);
});

test("MCP refuses foreign browser Origins and echoes allowed ones", async () => {
  const db = openDatabase();
  const env = createEnv(db, { MCP_ALLOWED_ORIGINS: "https://inspector.example" });
  const foreign = await mcpCall(env, {}, { Origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  const allowed = await mcpCall(env, {}, { Origin: "https://inspector.example" });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://inspector.example");
  const serverSide = await mcpCall(env, {});
  assert.equal(serverSide.status, 200);
  assert.equal(serverSide.headers.get("Access-Control-Allow-Origin"), null);
});

// --- A8: leads ---------------------------------------------------------------

function lead(env, body, headers = {}) {
  return call(env, "/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SITE, "CF-Connecting-IP": "192.0.2.5", ...headers },
    body: JSON.stringify(body),
  });
}

test("/leads caps field lengths, refuses cross-site posts and throttles per IP", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  const valid = { email: "buyer@example.com", company: "Acme", interest: "Data" };
  assert.equal((await lead(env, { ...valid, company: "x".repeat(201) })).status, 400);
  assert.equal((await lead(env, valid, { Origin: "https://evil.example" })).status, 403);
  // The rejected oversize post above already counted against this IP.
  const statuses = [];
  for (let i = 1; i < LEAD_IP_HOURLY_LIMIT; i++) statuses.push((await lead(env, { ...valid, email: `b${i}@example.com` })).status);
  assert.deepEqual(statuses, Array(LEAD_IP_HOURLY_LIMIT - 1).fill(200));
  assert.equal((await lead(env, valid)).status, 429);
  const ok = await lead(env, valid, { "CF-Connecting-IP": "192.0.2.99" });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), null);
});

// --- A16 / A21: auth helpers -------------------------------------------------

test("timingSafeEqualString compares digests regardless of length", async () => {
  assert.equal(await timingSafeEqualString("abc", "abc"), true);
  assert.equal(await timingSafeEqualString("abc", "abcd"), false);
  assert.equal(await timingSafeEqualString("", "abc"), false);
  assert.equal(await timingSafeEqualString(null, "abc"), false);
  const source = readFileSync(new URL("../security.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export async function timingSafeEqualString"), source.indexOf("/** Cloudflare sets"));
  assert.doesNotMatch(body, /\.length !==/);
});

test("admin POSTs need the token header and a same-site Origin", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  const crossSite = await call(env, "/admin/build-graph", {
    method: "POST",
    headers: { "X-Admin-Token": ADMIN_TOKEN, Origin: "https://evil.example" },
  });
  assert.equal(crossSite.status, 403);
  const accessOnly = await call(env, "/admin/build-graph", {
    method: "POST",
    headers: { "CF-Access-Jwt-Assertion": "a.b.c" },
  });
  assert.equal(accessOnly.status, 401);
  const queryToken = await call(env, `/admin/build-graph?token=${ADMIN_TOKEN}`, { method: "POST" });
  assert.equal(queryToken.status, 401);
});

test("helper parsing and origin rules", () => {
  assert.deepEqual(parseIntegerParam(null, { fallback: 1 }), { ok: true, value: 1 });
  assert.deepEqual(parseIntegerParam("abc", { fallback: 1 }), { ok: false });
  assert.deepEqual(parseIntegerParam("0", { fallback: 1 }), { ok: false });
  assert.deepEqual(parseIntegerParam("500", { fallback: 1, max: 100 }), { ok: true, value: 100 });
  const request = (headers) => new Request(`${SITE}/x`, { method: "POST", headers });
  assert.equal(isCrossSiteRequest(request({})), false);
  assert.equal(isCrossSiteRequest(request({ Origin: SITE })), false);
  assert.equal(isCrossSiteRequest(request({ Origin: "null" })), true);
  assert.equal(isCrossSiteRequest(request({ "Sec-Fetch-Site": "cross-site" })), true);
});

test("the D1 limiter counts per fixed window", async () => {
  const db = openDatabase();
  const env = createEnv(db);
  const now = Date.UTC(2026, 10, 27, 12, 0, 0);
  assert.equal(await consumeD1RateLimit(env, "k", 2, 60, now), true);
  assert.equal(await consumeD1RateLimit(env, "k", 2, 60, now + 1000), true);
  assert.equal(await consumeD1RateLimit(env, "k", 2, 60, now + 2000), false);
  assert.equal(await consumeD1RateLimit(env, "k", 2, 60, now + 61000), true);
});

// --- A18: CSP ----------------------------------------------------------------

test("the CSP is report-only until CSP_ENFORCE=1 (S4)", async () => {
  const db = openDatabase();
  const reportOnly = await call(createEnv(db), "/about");
  assert.equal(reportOnly.headers.get("Content-Security-Policy"), null);
  const policy = reportOnly.headers.get("Content-Security-Policy-Report-Only");
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /report-uri \/csp-report/);
  const enforced = await call(createEnv(db, { CSP_ENFORCE: "1" }), "/about");
  assert.equal(enforced.headers.get("Content-Security-Policy"), policy);
  assert.equal(enforced.headers.get("Content-Security-Policy-Report-Only"), null);
  const notQuite = await call(createEnv(db, { CSP_ENFORCE: "true" }), "/about");
  assert.equal(notQuite.headers.get("Content-Security-Policy"), null, "only the exact value 1 enforces");
});

test("/csp-report logs a trimmed violation and answers 204", async () => {
  const db = openDatabase();
  const warn = console.warn;
  const lines = [];
  console.warn = (line) => lines.push(String(line));
  try {
    const response = await call(createEnv(db), "/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: JSON.stringify({ "csp-report": { "document-uri": "https://buildingseattle.com/", "violated-directive": "script-src", "blocked-uri": "https://ajax.cloudflare.com/rocket-loader.min.js" } }),
    });
    assert.equal(response.status, 204);
    const garbage = await call(createEnv(db), "/csp-report", { method: "POST", body: "not json" });
    assert.equal(garbage.status, 204);
  } finally {
    console.warn = warn;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /CSP violation: .*script-src.*rocket-loader/);
});

test("CSP forbids inline script except the hashed theme boot script", async () => {
  const body = themeBootScript().replace(/^<script>/, "").replace(/<\/script>$/, "");
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("base64");
  assert.equal(THEME_BOOT_SCRIPT_SHA256, `sha256-${digest}`, "update THEME_BOOT_SCRIPT_SHA256 in security.js");

  const db = openDatabase();
  const env = createEnv(db);
  const paths = ["/", "/permits", "/permits/P-1", "/about", "/data", "/api-docs", "/insights", "/methodology", "/contractors", "/neighborhoods", "/nope-404"];
  for (const path of paths) {
    const response = await call(env, path);
    const csp = response.headers.get("Content-Security-Policy-Report-Only");
    const scriptSrc = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("script-src "));
    assert.doesNotMatch(scriptSrc, /unsafe-inline/);
    assert.match(csp, /script-src-attr 'none'/);
    const html = await response.text();
    assert.doesNotMatch(html, /<[^>]+\son(click|submit|keydown|load|error|change|input)=/i, `${path} has an inline handler`);
    for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      const attrs = match[1] || "";
      if (/\bsrc=/.test(attrs) || /application\/ld\+json/.test(attrs)) continue;
      const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[2]))).toString("base64");
      assert.ok(csp.includes(`'sha256-${hash}'`), `${path} has an inline script the CSP does not allow`);
    }
  }
});
