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
