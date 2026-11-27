import assert from "node:assert/strict";
import test from "node:test";

import { handleMcpRequest } from "../mcp.js";

function request(body, headers = { "Content-Type": "application/json" }) {
  return new Request("https://buildingseattle.com/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}

test("MCP initializes with tools capability", async () => {
  const response = await handleMcpRequest(request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  const payload = await response.json();
  assert.equal(payload.result.protocolVersion, "2025-06-18");
  assert.deepEqual(payload.result.capabilities, { tools: { listChanged: false } });
});

test("MCP lists the Building Seattle tools", async () => {
  const response = await handleMcpRequest(request({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  const payload = await response.json();
  assert.deepEqual(payload.result.tools.map((tool) => tool.name), ["search_permits", "list_contractors", "get_stats"]);
  assert.ok(payload.result.tools.every((tool) => tool.annotations.readOnlyHint));
});

test("MCP calls a tool and returns text plus structured content", async () => {
  const calls = [];
  const data = { total: 1, results: [{ permit_number: "PERM123" }] };
  const response = await handleMcpRequest(
    request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_permits", arguments: { q: "tower", per_page: 5 } } }),
    async (...args) => { calls.push(args); return data; },
  );
  const payload = await response.json();
  assert.deepEqual(calls, [["search_permits", { q: "tower", per_page: 5 }]]);
  assert.deepEqual(payload.result.structuredContent, data);
  assert.match(payload.result.content[0].text, /PERM123/);
});

test("MCP rejects invalid tool arguments", async () => {
  const response = await handleMcpRequest(
    request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_permits", arguments: { per_page: 101 } } }),
    async () => assert.fail("tool should not run"),
  );
  assert.equal((await response.json()).error.code, -32602);
});

test("MCP accepts initialized notifications without a response body", async () => {
  const response = await handleMcpRequest(request({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
});

test("MCP refuses a foreign browser Origin and allows configured ones (A15)", async () => {
  const foreign = await handleMcpRequest(
    request({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { "Content-Type": "application/json", Origin: "https://evil.example" }),
  );
  assert.equal(foreign.status, 403);
  const own = await handleMcpRequest(
    request({ jsonrpc: "2.0", id: 6, method: "tools/list" }, { "Content-Type": "application/json", Origin: "https://buildingseattle.com" }),
  );
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("Access-Control-Allow-Origin"), "https://buildingseattle.com");
  const configured = await handleMcpRequest(
    request({ jsonrpc: "2.0", id: 7, method: "ping" }, { "Content-Type": "application/json", Origin: "https://inspector.example" }),
    undefined,
    { allowedOrigins: "https://inspector.example" },
  );
  assert.equal(configured.headers.get("Access-Control-Allow-Origin"), "https://inspector.example");
});

test("MCP tool failures never echo internal error text (A4)", async () => {
  const realError = console.error;
  console.error = () => {};
  try {
    const response = await handleMcpRequest(
      request({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "get_stats", arguments: {} } }),
      async () => { throw new Error("D1_ERROR: no such column: secret_col"); },
    );
    const payload = await response.json();
    assert.equal(payload.result.isError, true);
    assert.doesNotMatch(payload.result.content[0].text, /secret_col|D1_ERROR/);
  } finally {
    console.error = realError;
  }
  const exposed = await handleMcpRequest(
    request({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_stats", arguments: {} } }),
    async () => { throw Object.assign(new Error("Anonymous access is limited"), { expose: true }); },
  );
  assert.match((await exposed.json()).result.content[0].text, /Anonymous access is limited/);
});

test("MCP results carry attribution and, without a key, the dataset link (F11)", async () => {
  const anonymous = await handleMcpRequest(
    request({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "get_stats", arguments: {} } }),
    async () => ({ permits: 1 }),
  );
  const payload = await anonymous.json();
  assert.equal(payload.result._meta["buildingseattle.com/attribution"].access, "anonymous");
  assert.match(payload.result.content.at(-1).text, /buildingseattle\.com\/data/);
  const init = await (await handleMcpRequest(request({ jsonrpc: "2.0", id: 11, method: "initialize", params: {} }))).json();
  assert.match(init.result.instructions, /sample/);
  const keyed = await handleMcpRequest(
    request({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "get_stats", arguments: {} } }),
    async () => ({ permits: 1 }),
    { access: { tier: "key", keyId: "env:x" } },
  );
  assert.equal((await keyed.json()).result._meta["buildingseattle.com/attribution"].access, "key");
});
