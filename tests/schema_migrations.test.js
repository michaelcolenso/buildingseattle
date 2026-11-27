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

test("every migration is idempotent (safe to re-run)", () => {
  const db = new DatabaseSync(":memory:");
  for (const name of migrationFiles()) db.exec(read(`migrations/${name}`));
  for (const name of migrationFiles()) db.exec(read(`migrations/${name}`));
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
