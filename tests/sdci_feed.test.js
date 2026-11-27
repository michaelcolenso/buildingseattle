import assert from "node:assert/strict";
import test from "node:test";

import {
  assertFeedPage,
  assertMappingHealth,
  buildFeedQuery,
  cursorAfterPage,
  decodeCursor,
  encodeCursor,
  FEED_LIMITS,
  fetchFeedPage,
  planFeedRun,
  SDCI_SELECT_FIELDS,
  watermarkFromLogTime,
} from "../sdci_feed.js";

const quiet = { warn() {} };

test("incremental query filters on :updated_at and keyset-orders on :updated_at, permitnum", () => {
  const q = buildFeedQuery({ mode: "incremental", since: "2026-11-27T11:00:00.000Z", floor: "2024-05-15", pageSize: 1000 });
  assert.equal(q.get("$where"), "applieddate >= '2024-05-15T00:00:00.000' AND :updated_at > '2026-11-27T11:00:00.000Z'");
  assert.equal(q.get("$order"), ":updated_at, permitnum");
  assert.equal(q.get("$limit"), "1000");
  assert.equal(q.get("$offset"), null, "keyset pagination, never $offset");
  assert.ok(q.get("$select").split(",").includes(":updated_at"));
  assert.deepEqual(q.get("$select").split(","), SDCI_SELECT_FIELDS);
});

test("incremental cursor resumes strictly after the last row, ties broken by permitnum", () => {
  const q = buildFeedQuery({
    mode: "incremental",
    cursor: { updated_at: "2026-11-27T12:00:00.000Z", permitnum: "7000123-CN" },
    floor: "2024-05-15",
  });
  assert.match(
    q.get("$where"),
    /\(:updated_at > '2026-11-27T12:00:00.000Z' OR \(:updated_at = '2026-11-27T12:00:00.000Z' AND permitnum > '7000123-CN'\)\)$/,
  );
});

test("sweep query keyset-paginates on permitnum inside the coverage window", () => {
  assert.equal(buildFeedQuery({ mode: "sweep", floor: "2024-05-15" }).get("$where"), "applieddate >= '2024-05-15T00:00:00.000'");
  const q = buildFeedQuery({ mode: "sweep", cursor: { permitnum: "70'01" }, floor: "2024-05-15" });
  assert.equal(q.get("$where"), "applieddate >= '2024-05-15T00:00:00.000' AND permitnum > '70''01'");
  assert.equal(q.get("$order"), "permitnum");
});

test("query builder rejects values that are not timestamps or dates", () => {
  assert.throws(() => buildFeedQuery({ mode: "incremental", since: "x' OR 1=1 --", floor: "2024-05-15" }), /Invalid Socrata timestamp/);
  assert.throws(() => buildFeedQuery({ mode: "sweep", floor: "2024-05-15' OR '1" }), /Invalid coverage floor/);
  assert.throws(() => buildFeedQuery({ mode: "nope" }), /Unknown feed mode/);
});

test("watermark is the log start time minus the overlap, as UTC ISO", () => {
  assert.equal(watermarkFromLogTime("2026-11-27 13:00:00", 120), "2026-11-27T11:00:00.000Z");
  assert.equal(watermarkFromLogTime(null), null);
  assert.equal(watermarkFromLogTime("garbage"), null);
});

test("cursors round-trip and follow the last row of a page", () => {
  const page = [
    { permitnum: "A", ":updated_at": "2026-01-01T00:00:00.000Z" },
    { permitnum: "B", ":updated_at": "2026-01-02T00:00:00.000Z" },
  ];
  assert.deepEqual(cursorAfterPage("incremental", page), { updated_at: "2026-01-02T00:00:00.000Z", permitnum: "B" });
  assert.deepEqual(cursorAfterPage("sweep", page), { permitnum: "B" });
  assert.deepEqual(decodeCursor(encodeCursor({ permitnum: "B" })), { permitnum: "B" });
  assert.equal(decodeCursor("not json"), null);
  assert.equal(encodeCursor(null), null);
});

test("planFeedRun: watermark, resume, and a weekly sweep", () => {
  const now = new Date("2026-11-28T13:00:00Z");
  const fresh = planFeedRun({ now });
  assert.equal(fresh.incremental.since, null, "first run ever pulls the whole window");
  assert.ok(fresh.sweep && fresh.sweep.cursor === null, "no sweep yet -> start one");
  assert.equal(fresh.incremental.maxPages + fresh.sweep.maxPages, FEED_LIMITS.maxPagesPerRun);

  const daily = planFeedRun({
    now,
    lastIncremental: { start_time: "2026-11-27 13:00:00", cursor: null },
    lastSweep: { start_time: "2026-11-25 13:00:00", cursor: null },
  });
  assert.equal(daily.incremental.since, "2026-11-27T11:00:00.000Z");
  assert.equal(daily.sweep, null, "sweep finished three days ago");
  assert.equal(daily.incremental.maxPages, FEED_LIMITS.maxPagesPerRun);

  const resumed = planFeedRun({
    now,
    lastIncremental: { start_time: "2026-11-27 13:00:00", cursor: encodeCursor({ updated_at: "2026-11-27T09:00:00.000Z", permitnum: "X" }) },
    lastSweep: { start_time: "2026-11-27 13:01:00", cursor: encodeCursor({ permitnum: "7100000-CN" }) },
  });
  assert.deepEqual(resumed.incremental.cursor, { updated_at: "2026-11-27T09:00:00.000Z", permitnum: "X" });
  assert.deepEqual(resumed.sweep.cursor, { permitnum: "7100000-CN" });

  const weekly = planFeedRun({ now, lastIncremental: null, lastSweep: { start_time: "2026-11-21 13:00:00", cursor: null } });
  assert.ok(weekly.sweep && weekly.sweep.cursor === null, "seven days later a new sweep starts");
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

test("fetchFeedPage retries transient failures with exponential backoff", async () => {
  const replies = [() => { throw new Error("socket hang up"); }, () => response(503, "busy"), () => response(200, [{ permitnum: "A" }])];
  const sleeps = [];
  const page = await fetchFeedPage("https://example.test", {
    fetchImpl: async () => replies.shift()(),
    sleep: async (ms) => sleeps.push(ms),
    attempts: 3,
    backoffMs: 100,
    log: quiet,
  });
  assert.deepEqual(page, [{ permitnum: "A" }]);
  assert.deepEqual(sleeps, [100, 200]);
});

test("fetchFeedPage gives up after the last attempt", async () => {
  let calls = 0;
  await assert.rejects(
    fetchFeedPage("https://example.test", {
      fetchImpl: async () => { calls++; return response(502, "bad gateway"); },
      sleep: async () => {},
      attempts: 3,
      log: quiet,
    }),
    /returned 502/,
  );
  assert.equal(calls, 3);
});

test("fetchFeedPage fails at once, loudly, when Socrata rejects the query (schema change)", async () => {
  let calls = 0;
  await assert.rejects(
    fetchFeedPage("https://example.test", {
      fetchImpl: async () => { calls++; return response(400, "No such column: statuscurrent"); },
      sleep: async () => {},
      log: quiet,
    }),
    /Schema guard: Socrata rejected the query.*No such column/,
  );
  assert.equal(calls, 1);
});

test("assertFeedPage catches missing keys and vanished columns", () => {
  const row = (n) => ({
    permitnum: `P${n}`, ":updated_at": "2026-01-01T00:00:00.000Z", permitclass: "Multifamily",
    statuscurrent: "Issued", originaladdress1: "1 Main", applieddate: "2025-01-01", latitude: "47.6", longitude: "-122.3",
  });
  assert.doesNotThrow(() => assertFeedPage([row(1)]));
  assert.throws(() => assertFeedPage([{ permitnum: "P1" }]), /have no :updated_at/);
  const renamed = Array.from({ length: 60 }, (_, n) => {
    const { statuscurrent, ...rest } = row(n);
    return { ...rest, status_current: statuscurrent };
  });
  assert.throws(() => assertFeedPage(renamed), /no row in a 60-row feed page has statuscurrent/);
  // A small page may legitimately lack a sparse field.
  assert.doesNotThrow(() => assertFeedPage(renamed.slice(0, 10)));
});

test("assertMappingHealth fails a batch where classification collapses", () => {
  const ok = Array.from({ length: 200 }, () => ({ type: "residential", neighborhood: "Ballard" }));
  assert.doesNotThrow(() => assertMappingHealth(ok));
  const badType = ok.map((p, i) => (i < 11 ? { ...p, type: "other" } : p));
  assert.throws(() => assertMappingHealth(badType), /type "other"/);
  const badHood = ok.map((p, i) => (i < 11 ? { ...p, neighborhood: "Other" } : p));
  assert.throws(() => assertMappingHealth(badHood), /neighborhood "Other"/);
  assert.doesNotThrow(() => assertMappingHealth(badHood.slice(0, 50)), "small batches are not judged");
});
