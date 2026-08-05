import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildEntityHubQuery, buildEntityHubState } from "../worker.js";
import { ENTITY_HUBS } from "../entity_hubs.js";

// The mocked-DB hub tests never execute SQL, so a query that is valid text but
// invalid SQLite (ambiguous columns, missing tables) shipped silently and left
// the hub empty and noindexed. Run every hub query against the real schema.
function schemaDatabase() {
  const db = new DatabaseSync(":memory:");
  // Production is schema.sql plus the entity-graph migration, which is what
  // adds permits.address_id / permits.project_id. Apply both.
  for (const file of ["../schema.sql", "../migration_entity_graph.sql"]) {
    db.exec(readFileSync(new URL(file, import.meta.url), "utf8"));
  }
  return db;
}

test("every entity hub query executes against the shipped schema", () => {
  const db = schemaDatabase();
  for (const type of Object.keys(ENTITY_HUBS)) {
    for (const sort of Object.keys(ENTITY_HUBS[type].sortOptions)) {
      const state = buildEntityHubState(type, new Request(`http://example.com/${type}?sort=${sort}`));
      const query = buildEntityHubQuery(type, state);
      assert.doesNotThrow(
        () => db.prepare(query.sql).all(...query.binds),
        `${type} hub query (sort=${sort}) is not valid against schema.sql`,
      );
    }
  }
  db.close();
});

test("entity hub filter combinations stay valid SQL", () => {
  const db = schemaDatabase();
  const cases = [
    ["contractors", "?activity=active&neighborhood=Ballard&permit_type=Construction&min_value=1000000"],
    ["addresses", "?activity=recent90&min_permits=5&min_value=500000"],
    ["addresses", "?activity=recent365"],
    ["projects", "?view=active"],
    ["projects", "?view=recent&page=3"],
    ["neighborhoods", "?sort=recent"],
  ];
  for (const [type, search] of cases) {
    const state = buildEntityHubState(type, new Request(`http://example.com/${type}${search}`));
    const query = buildEntityHubQuery(type, state);
    assert.doesNotThrow(
      () => db.prepare(query.sql).all(...query.binds),
      `${type} hub query (${search}) is not valid against schema.sql`,
    );
  }
  db.close();
});
