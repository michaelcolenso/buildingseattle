import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

// schema.sql is the full current schema; migrations/ is how production gets
// there. They must describe the same database, or a fresh environment built
// from schema.sql drifts from production again (audit B2/F17).

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

function migrationFiles() {
  // Same discovery rule wrangler uses (`migrations/*.sql`, not recursive), so
  // migrations/legacy/ is never applied.
  return readdirSync(new URL("migrations/", root))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function describe(db) {
  const objects = db
    .prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all()
    .map((row) => ({ ...row }));
  const tables = objects.filter((o) => o.type === "table").map((o) => o.name);
  const columns = Object.fromEntries(
    tables.map((table) => [
      table,
      db.prepare("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?)").all(table).map((row) => ({ ...row })),
    ]),
  );
  const indexes = Object.fromEntries(
    tables.map((table) => [
      table,
      db
        .prepare("SELECT name, \"unique\", origin, partial FROM pragma_index_list(?) ORDER BY name")
        .all(table)
        .map((index) => ({
          ...index,
          columns: db.prepare("SELECT name, desc FROM pragma_index_xinfo(?) WHERE key = 1").all(index.name).map((row) => ({ ...row })),
        })),
    ]),
  );
  const foreignKeys = Object.fromEntries(
    tables.map((table) => [
      table,
      db.prepare("SELECT \"table\", \"from\", \"to\" FROM pragma_foreign_key_list(?)").all(table).map((row) => ({ ...row })),
    ]),
  );
  return { objects, columns, indexes, foreignKeys };
}

test("migration files follow wrangler's NNNN_name.sql convention and start with the baseline", () => {
  const files = migrationFiles();
  assert.equal(files[0], "0000_baseline.sql");
  files.forEach((name, index) => {
    assert.match(name, /^\d{4}_[a-z0-9_]+\.sql$/, `${name} is not NNNN_snake_case.sql`);
    assert.equal(Number(name.slice(0, 4)), index, `${name} is out of sequence`);
  });
});

// SQLite has no ADD COLUMN IF NOT EXISTS, so a column-adding statement can only run once.
// wrangler records applied files in d1_migrations and never re-runs them; everything else
// (tables, indexes, triggers) must still be safe to run twice.
const withoutAddColumn = (sql) => sql.replace(/^ALTER TABLE \w+ ADD COLUMN [^;]+;\s*$/gm, "");

test("every migration is idempotent (safe to re-run)", () => {
  const db = new DatabaseSync(":memory:");
  for (const name of migrationFiles()) db.exec(read(`migrations/${name}`));
  for (const name of migrationFiles()) db.exec(withoutAddColumn(read(`migrations/${name}`)));
  db.close();
});

test("schema.sql equals the baseline plus every numbered migration", () => {
  const migrated = new DatabaseSync(":memory:");
  for (const name of migrationFiles()) migrated.exec(read(`migrations/${name}`));
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(read("schema.sql"));
  assert.deepEqual(describe(fresh), describe(migrated));
  migrated.close();
  fresh.close();
});

test("schema.sql carries no seed rows (demo data must never reach production)", () => {
  const sql = read("schema.sql").replace(/--.*$/gm, "");
  assert.doesNotMatch(sql, /\bINSERT\b/i);
  const db = new DatabaseSync(":memory:");
  db.exec(read("schema.sql"));
  for (const table of ["permits", "contractors", "leads"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} is seeded`);
  }
  db.close();
});

test("wrangler.toml points the D1 binding at migrations/", () => {
  const toml = read("wrangler.toml");
  assert.match(toml, /\[\[d1_databases\]\][\s\S]*?migrations_dir\s*=\s*"migrations"/);
});

test("the permit list queries are served by an index, with no full scan or temp sort (F8, N10)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(read("schema.sql"));
  // /permits and MCP sort by issued_date; /api/permits adds the id tiebreak.
  const list = (where, order) =>
    `SELECT p.*, c.name FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id LEFT JOIN addresses a ON a.id = p.address_id ${where} ORDER BY ${order} LIMIT 50 OFFSET 0`;
  for (const order of ["p.issued_date DESC", "p.issued_date DESC, p.id DESC"]) {
    for (const [where, args] of [
      ["WHERE 1=1", []],
      ["WHERE 1=1 AND p.type = ?", ["residential"]],
      ["WHERE 1=1 AND p.neighborhood = ?", ["Ballard"]],
      ["WHERE 1=1 AND p.status = ?", ["active"]],
    ]) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${list(where, order)}`).all(...args).map((row) => row.detail).join(" | ");
      assert.match(plan, /USING INDEX idx_permits_\w*issued_date/, `${where} ${order}: ${plan}`);
      assert.doesNotMatch(plan, /TEMP B-TREE/, `${where} ${order}: ${plan}`);
    }
  }
  db.close();
});

test("migration headers never tell anyone to apply them with d1 execute --file (S1)", () => {
  for (const name of migrationFiles()) {
    for (const line of read(`migrations/${name}`).split("\n")) {
      if (!/execute\b.*--file/.test(line)) continue;
      // The only allowed mention is the warning against it.
      assert.match(line, /\bNever\b|\bnever\b/, `${name}: "${line.trim()}"`);
    }
  }
});

test("no numbered migration adds an index that duplicates an existing one (S1)", () => {
  // The baseline mirrors production as-is (it has its own historical
  // duplicates); every index added after it must cover new columns.
  const db = new DatabaseSync(":memory:");
  const keys = () => {
    const out = new Map();
    for (const [table, list] of Object.entries(describe(db).indexes)) {
      for (const index of list) out.set(index.name, `${table}:${index.partial}:${JSON.stringify(index.columns)}`);
    }
    return out;
  };
  for (const name of migrationFiles()) {
    const before = keys();
    db.exec(read(`migrations/${name}`));
    if (name === "0000_baseline.sql") continue;
    const existing = new Map([...before].map(([index, key]) => [key, index]));
    for (const [index, key] of keys()) {
      if (before.has(index)) continue;
      assert.ok(!existing.has(key), `${name}: ${index} duplicates ${existing.get(key)}`);
      existing.set(key, index);
    }
  }
  db.close();
});

test("deploy docs apply migrations before the merge, and the runbook lists every migration (B1)", () => {
  // A push to main deploys, and the new code fails on an unmigrated database,
  // so the documented order must be: bookmark, bootstrap, apply, verify, merge.
  const claude = read("CLAUDE.md");
  assert.doesNotMatch(claude, /after this change is merged and deployed/);
  assert.match(claude, /bootstrap: run it BEFORE merging/);

  const runbook = read("docs/deploy-runbook.md");
  const at = (text) => {
    const index = runbook.indexOf(text);
    assert.ok(index >= 0, `runbook mentions ${text}`);
    return index;
  };
  const bookmark = at("d1 time-travel info buildingseattle");
  const dupCheck = at("FROM basis_reset_events GROUP BY 1,2,3 HAVING COUNT(*) > 1");
  const bootstrap = at("INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0000_baseline.sql')");
  const apply = at("d1 migrations apply buildingseattle --remote");
  const merge = at("## Merge");
  assert.ok(bookmark < dupCheck && dupCheck < bootstrap && bootstrap < apply && apply < merge);
  at("--no-data");

  // Every numbered migration after the baseline is named in the verify step.
  for (const name of migrationFiles().filter((f) => !f.startsWith("0000_"))) {
    assert.ok(runbook.includes(name), `runbook's verify step names ${name}`);
  }
});
