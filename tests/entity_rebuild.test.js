import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker from "../worker.js";

// The nightly entity-graph rebuild must never open a window in which a valid
// address/project page has no permits behind it (that window answered 410 for
// pages that were fine), and must say so loudly when it cannot finish.
//
// These tests run the real rebuild against a real SQLite database (the
// production schema plus the entity-graph migration) through a small D1 shim.

const ADMIN_TOKEN = "test-admin-token";

function openDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const file of ["../schema.sql", "../migration_entity_graph.sql"]) {
    db.exec(readFileSync(new URL(file, import.meta.url), "utf8"));
  }
  db.exec("DELETE FROM permits; DELETE FROM contractors; DELETE FROM ingest_logs;");
  return db;
}

// D1-shaped wrapper. `hooks.beforeStatement(sql)` may throw to simulate a D1
// failure; `hooks.afterBatch(db)` runs after every committed batch.
function createEnv(db, hooks = {}) {
  const statements = [];
  const wrap = (sql, binds = []) => ({
    sql,
    binds,
    bind: (...next) => wrap(sql, next),
    all: async () => {
      statements.push(sql);
      hooks.beforeStatement?.(sql);
      return { results: db.prepare(sql).all(...binds) };
    },
    first: async () => {
      statements.push(sql);
      hooks.beforeStatement?.(sql);
      return db.prepare(sql).get(...binds) ?? null;
    },
    run: async () => {
      statements.push(sql);
      hooks.beforeStatement?.(sql);
      const result = db.prepare(sql).run(...binds);
      return { meta: { changes: Number(result.changes) } };
    },
  });
  return {
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    statements,
    DB: {
      prepare: (sql) => wrap(sql),
      batch: async (batch) => {
        db.exec("BEGIN");
        try {
          for (const statement of batch) {
            statements.push(statement.sql);
            hooks.beforeStatement?.(statement.sql);
            db.prepare(statement.sql).run(...statement.binds);
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        hooks.afterBatch?.(db);
        return batch.map(() => ({ success: true }));
      },
    },
  };
}

let nextPermit = 1;
function addPermit(db, fields) {
  const n = nextPermit++;
  const row = {
    permit_number: `${6000000 + n}-CN`,
    status: "active",
    type: "residential",
    value: 10000 + n,
    issued_date: "2026-01-15",
    description: "Alteration of existing building",
    ...fields,
  };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO permits (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((column) => row[column]),
  );
  return Number(db.prepare("SELECT id FROM permits WHERE permit_number = ?").get(row.permit_number).id);
}

function seedPermits(db) {
  return {
    a1: addPermit(db, { address: "100 PINE ST, SEATTLE, WA", neighborhood: "Downtown", description: "Tenant improvement to suite 200" }),
    a2: addPermit(db, { address: "100 PINE ST, SEATTLE, WA", neighborhood: "Downtown", description: "Tenant improvement to suite 300", issued_date: "2026-02-10" }),
    a3: addPermit(db, { address: "100 PINE ST, SEATTLE, WA", neighborhood: "Downtown", type: "demolition", description: "Demolish rear shed", issued_date: "2014-05-01" }),
    b1: addPermit(db, { address: "200 OAK AVE, SEATTLE, WA", neighborhood: "Ballard", description: "Addition to single family residence" }),
    c1: addPermit(db, { address: "300 ELM WAY, SEATTLE, WA", neighborhood: "Fremont", description: "Electrical service upgrade" }),
  };
}

const q = (db, sql, ...binds) => db.prepare(sql).get(...binds);
const rows = (db, sql, ...binds) => db.prepare(sql).all(...binds);

function snapshot(db) {
  return {
    addresses: rows(db, "SELECT id, slug, normalized_address FROM addresses ORDER BY id"),
    projects: rows(db, "SELECT id, slug, address_id FROM projects ORDER BY id"),
    orgs: rows(db, "SELECT id, slug FROM people_orgs ORDER BY id"),
    neighborhoods: rows(db, "SELECT id, slug FROM neighborhoods ORDER BY id"),
    links: rows(db, "SELECT id, address_id, project_id FROM permits ORDER BY id"),
  };
}

async function rebuild(env) {
  const response = await worker.fetch(
    new Request("https://buildingseattle.com/admin/build-graph", {
      method: "POST",
      headers: { "X-Admin-Token": ADMIN_TOKEN },
    }),
    env,
    { waitUntil() {} },
  );
  return { status: response.status, body: await response.json() };
}

// Every permit points at an address and project row that exists.
function assertFullyLinked(db) {
  assert.equal(q(db, "SELECT COUNT(*) AS n FROM permits WHERE address_id IS NULL OR project_id IS NULL").n, 0);
  assert.equal(
    q(db, "SELECT COUNT(*) AS n FROM permits p LEFT JOIN addresses a ON a.id = p.address_id WHERE a.id IS NULL").n,
    0,
  );
  assert.equal(
    q(db, "SELECT COUNT(*) AS n FROM permits p LEFT JOIN projects pr ON pr.id = p.project_id WHERE pr.id IS NULL").n,
    0,
  );
}

test("first rebuild links every permit and reports a clean result", async () => {
  const db = openDatabase();
  seedPermits(db);
  const { status, body } = await rebuild(createEnv(db));

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.permits, 5);
  assert.equal(body.expected_linked, 5);
  assert.equal(body.linked, 5);
  assert.equal(body.unlinked, 0);
  assert.equal(body.project_unlinked, 0);
  assert.equal(body.addresses, 3);
  assert.equal(q(db, "SELECT COUNT(*) AS n FROM addresses").n, 3);
  assertFullyLinked(db);

  const log = q(db, "SELECT run_type, source, status FROM ingest_logs ORDER BY id DESC LIMIT 1");
  assert.deepEqual({ ...log }, { run_type: "entity_graph", source: "admin", status: "success" });
});

test("a second rebuild with no data change writes nothing and keeps every id and slug", async () => {
  const db = openDatabase();
  seedPermits(db);
  await rebuild(createEnv(db));
  const before = snapshot(db);

  const env = createEnv(db);
  const { body } = await rebuild(env);

  assert.deepEqual(snapshot(db), before);
  assert.equal(body.ok, true);
  assert.equal(body.changes.permits_relinked, 0);
  for (const table of ["addresses", "people_orgs", "projects", "neighborhoods"]) {
    assert.deepEqual(body.changes[table], { added: 0, updated: 0, removed: 0 }, table);
  }
  for (const [table, delta] of Object.entries(body.changes.join_rows)) {
    assert.deepEqual(delta, { added: 0, removed: 0 }, table);
  }
  // Nothing but reads and the log row.
  const writes = env.statements.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && !/ingest_logs/.test(sql));
  assert.deepEqual(writes, []);
});

test("the rebuild never deletes or NULLs links before replacements exist", async () => {
  const db = openDatabase();
  const ids = seedPermits(db);
  await rebuild(createEnv(db));

  // New permit at an existing address, one permit moves to another address,
  // one address disappears entirely.
  addPermit(db, { address: "200 OAK AVE, SEATTLE, WA", neighborhood: "Ballard", description: "Addition, phase two" });
  db.prepare("UPDATE permits SET address = ? WHERE id = ?").run("400 MAPLE CT, SEATTLE, WA", ids.a2);
  db.prepare("DELETE FROM permits WHERE id = ?").run(ids.c1);

  const linkedBefore = new Set(rows(db, "SELECT id FROM permits WHERE address_id IS NOT NULL").map((r) => r.id));
  const sawDestructiveSql = [];
  const env = createEnv(db, {
    beforeStatement(sql) {
      if (/SET address_id = NULL|DELETE FROM (project_permits|permit_participants|project_participants|address_neighborhoods)\s*$/i.test(sql)) {
        sawDestructiveSql.push(sql);
      }
    },
    // After every committed batch, each previously linked permit still points
    // at an address and a project row that exists: pages never see a gap.
    afterBatch(database) {
      const broken = database
        .prepare(
          `SELECT p.id FROM permits p
           LEFT JOIN addresses a ON a.id = p.address_id
           LEFT JOIN projects pr ON pr.id = p.project_id
           WHERE p.address_id IS NOT NULL AND (a.id IS NULL OR pr.id IS NULL)`,
        )
        .all();
      assert.deepEqual(broken, [], "dangling link after batch");
      const unlinked = database
        .prepare("SELECT id FROM permits WHERE address_id IS NULL")
        .all()
        .map((r) => r.id)
        .filter((id) => linkedBefore.has(id));
      assert.deepEqual(unlinked, [], "a linked permit was unlinked mid-rebuild");
    },
  });
  const { body } = await rebuild(env);

  assert.deepEqual(sawDestructiveSql, []);
  assert.equal(body.ok, true);
  assert.equal(body.changes.addresses.removed, 1, "300 Elm Way has no permits left");
  assertFullyLinked(db);
  assert.equal(q(db, "SELECT COUNT(*) AS n FROM addresses WHERE normalized_address LIKE '300 ELM%'").n, 0);
});

test("a D1 failure mid-rebuild leaves the previous graph serving and the next run heals it", async () => {
  const db = openDatabase();
  seedPermits(db);
  await rebuild(createEnv(db));
  const before = snapshot(db);

  addPermit(db, { address: "500 CEDAR LN, SEATTLE, WA", neighborhood: "Ballard", description: "New single family residence" });

  let relinkStatements = 0;
  const failing = createEnv(db, {
    beforeStatement(sql) {
      if (/^\s*UPDATE permits SET address_id/i.test(sql)) {
        relinkStatements += 1;
        throw new Error("D1_ERROR: simulated mid-rebuild failure");
      }
    },
  });
  const failed = await rebuild(failing);

  assert.equal(relinkStatements, 1);
  assert.equal(failed.status, 500);
  assert.equal(failed.body.ok, false);
  assert.match(failed.body.error, /simulated mid-rebuild failure/);

  // Everything that was linked before is still linked to the same rows.
  const after = snapshot(db);
  for (const link of before.links) {
    assert.deepEqual(after.links.find((l) => l.id === link.id), link);
  }
  for (const address of before.addresses) {
    assert.ok(after.addresses.some((a) => a.id === address.id && a.slug === address.slug));
  }
  const failureLog = q(db, "SELECT status, error_message FROM ingest_logs ORDER BY id DESC LIMIT 1");
  assert.equal(failureLog.status, "error");
  assert.match(failureLog.error_message, /simulated mid-rebuild failure/);

  // The next run finishes the job.
  const healed = await rebuild(createEnv(db));
  assert.equal(healed.body.ok, true);
  assert.equal(healed.body.unlinked, 0);
  assertFullyLinked(db);
  for (const address of before.addresses) {
    assert.ok(snapshot(db).addresses.some((a) => a.id === address.id && a.slug === address.slug), "ids and slugs stable");
  }
});

test("a rebuild that cannot link every permit reports partial, not success", async () => {
  const db = openDatabase();
  seedPermits(db);
  // Silently drop the relink statements: the batch "succeeds" but permits stay unlinked.
  const env = createEnv(db);
  const realBatch = env.DB.batch;
  env.DB.batch = async (batch) =>
    realBatch(batch.filter((statement) => !/^\s*UPDATE permits SET address_id/i.test(statement.sql)));
  const { status, body } = await rebuild(env);

  assert.equal(status, 500);
  assert.equal(body.ok, false);
  assert.equal(body.expected_linked, 5);
  assert.equal(body.linked, 0);
  assert.equal(body.unlinked, 5);
  const log = q(db, "SELECT status, error_message FROM ingest_logs ORDER BY id DESC LIMIT 1");
  assert.equal(log.status, "partial");
  assert.match(log.error_message, /5 of 5 permits unlinked/);
});

test("a permit ingested mid-rebuild is flagged as outside the snapshot and linked by the next run", async () => {
  const db = openDatabase();
  seedPermits(db);
  let ingested = false;
  const env = createEnv(db, {
    afterBatch(database) {
      if (ingested) return;
      ingested = true;
      // what /ingest/permit does: insert a permit and leave it unlinked
      addPermit(database, { address: "600 SPRUCE DR, SEATTLE, WA", description: "New permit mid-run" });
    },
  });
  const { body } = await rebuild(env);

  assert.equal(body.permits, 5, "the snapshot was read before the ingest");
  assert.equal(body.ok, true, "every snapshot permit is linked");
  assert.equal(body.snapshot_stale, true, "the permit count moved during the run");
  assert.equal(q(db, "SELECT COUNT(*) AS n FROM permits WHERE address_id IS NULL").n, 1);

  const next = await rebuild(createEnv(db));
  assert.equal(next.body.permits, 6);
  assert.equal(next.body.snapshot_stale, false);
  assertFullyLinked(db);
});

test("an empty permits read does not delete the graph", async () => {
  const db = openDatabase();
  seedPermits(db);
  await rebuild(createEnv(db));
  const before = snapshot(db);

  const env = createEnv(db);
  const realPrepare = env.DB.prepare;
  env.DB.prepare = (sql) =>
    /FROM permits p\s+LEFT JOIN contractors c/i.test(sql)
      ? { all: async () => ({ results: [] }), bind: () => ({ all: async () => ({ results: [] }) }) }
      : realPrepare(sql);
  const { status, body } = await rebuild(env);

  assert.equal(status, 500);
  assert.match(body.error, /empty permits table/);
  assert.deepEqual(snapshot(db), before);
});

test("project slugs survive a change to the project's name and cluster", async () => {
  const db = openDatabase();
  const ids = seedPermits(db);
  await rebuild(createEnv(db));
  const slugOf = (permitId) =>
    q(db, "SELECT pr.slug FROM permits p JOIN projects pr ON pr.id = p.project_id WHERE p.id = ?", permitId).slug;
  const tenantSlug = slugOf(ids.a1);
  assert.equal(tenantSlug, slugOf(ids.a2), "the two tenant-improvement permits share a project");
  assert.match(tenantSlug, /^tenant-improvement-at-/);
  const projectId = q(db, "SELECT project_id FROM permits WHERE id = ?", ids.a1).project_id;

  // The wording of the permits changes, so the generated name no longer says
  // "tenant improvement". The URL must not follow it.
  db.prepare("UPDATE permits SET description = 'Interior work, suites 200 and 300' WHERE id IN (?, ?)").run(ids.a1, ids.a2);
  const { body } = await rebuild(createEnv(db));

  assert.equal(body.ok, true);
  assert.equal(slugOf(ids.a1), tenantSlug);
  assert.equal(q(db, "SELECT project_id FROM permits WHERE id = ?", ids.a1).project_id, projectId, "same project row");
  assert.notEqual(
    q(db, "SELECT name FROM projects WHERE id = ?", projectId).name.toLowerCase().startsWith("tenant improvement"),
    true,
    "the name did change; only the slug is pinned",
  );
});

test("a project keeps its slug when permits were unlinked by an earlier failed run", async () => {
  const db = openDatabase();
  const ids = seedPermits(db);
  await rebuild(createEnv(db));
  const slug = q(db, "SELECT pr.slug FROM permits p JOIN projects pr ON pr.id = p.project_id WHERE p.id = ?", ids.a1).slug;

  // State a destructive run leaves behind: links gone, join table still has the
  // pairs. The permits' wording also changed, so the generated name differs.
  db.exec("UPDATE permits SET address_id = NULL, project_id = NULL");
  db.prepare("UPDATE permits SET description = 'Interior work, suites 200 and 300' WHERE id IN (?, ?)").run(ids.a1, ids.a2);
  const { body } = await rebuild(createEnv(db));

  assert.equal(body.ok, true);
  assert.equal(
    q(db, "SELECT pr.slug FROM permits p JOIN projects pr ON pr.id = p.project_id WHERE p.id = ?", ids.a1).slug,
    slug,
  );
  assertFullyLinked(db);
});

test("/admin/entity-report exposes integrity counters and the last rebuild status", async () => {
  const db = openDatabase();
  seedPermits(db);
  const env = createEnv(db);
  await rebuild(env);
  db.exec("UPDATE permits SET address_id = NULL WHERE id = (SELECT MIN(id) FROM permits)");

  const response = await worker.fetch(
    new Request("https://buildingseattle.com/admin/entity-report", { headers: { "X-Admin-Token": ADMIN_TOKEN } }),
    env,
    { waitUntil() {} },
  );
  const report = await response.json();

  assert.equal(report.integrity.permits_without_address, 1);
  assert.equal(report.integrity.permits_with_dangling_address, 0);
  assert.equal(report.integrity.ok, false);
  assert.equal(report.integrity.last_rebuild.status, "success");
});
