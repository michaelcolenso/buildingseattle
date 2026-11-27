import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

// Deploy configuration that a dashboard toggle cannot hold (each deploy
// re-applies wrangler.toml). Review S8.

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("wrangler.toml turns off the workers.dev mirror and preview URLs (S8)", () => {
  const toml = read("wrangler.toml");
  // Top-level keys: before the first [section].
  const topLevel = toml.split(/^\[/m)[0];
  assert.match(topLevel, /^workers_dev\s*=\s*false\s*$/m);
  assert.match(topLevel, /^preview_urls\s*=\s*false\s*$/m);
});

function walk(dir, out = []) {
  for (const name of readdirSync(new URL(dir, root))) {
    if ([".git", "node_modules", "__pycache__", "legacy", ".seo_data"].includes(name)) continue;
    const path = `${dir}${name}`;
    if (statSync(new URL(path, root)).isDirectory()) walk(`${path}/`, out);
    else if (/\.(js|mjs|py|ya?ml|sh|toml|json)$/.test(name)) out.push(path);
  }
  return out;
}

test("no script, workflow or config calls a workers.dev host (S8)", () => {
  const files = [...walk(".github/"), ...walk("scripts/"), ...walk("tests/").filter((f) => !f.endsWith("wrangler_config.test.js"))];
  for (const file of readdirSync(root)) {
    if (/\.(js|mjs|py|toml|json)$/.test(file)) files.push(file);
  }
  for (const file of files) {
    assert.doesNotMatch(read(file), /https?:\/\/[a-z0-9.-]+\.workers\.dev/i, `${file} calls a workers.dev host`);
  }
});
