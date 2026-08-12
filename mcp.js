const PROTOCOL_VERSION = "2025-06-18";

export const MCP_TOOLS = [
  {
    name: "search_permits",
    title: "Search Seattle permits",
    description: "Search Seattle construction permits with optional filters and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        neighborhood: { type: "string", description: "Seattle neighborhood name." },
        type: { type: "string", description: "Permit type." },
        status: { type: "string", description: "Permit status." },
        q: { type: "string", description: "Text to find in permit numbers, addresses, descriptions, neighborhoods, or contractor names." },
        page: { type: "integer", minimum: 1, default: 1 },
        per_page: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "list_contractors",
    title: "List top Seattle contractors",
    description: "List the top Seattle contractors ranked by active project count.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "get_stats",
    title: "Get Seattle construction statistics",
    description: "Get aggregate Seattle permit, contractor, and project-value statistics.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

function jsonRpcResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function error(id, code, message, status = 200) {
  return jsonRpcResponse({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
}

function validArguments(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (name !== "search_permits") return Object.keys(args).length === 0;
  const allowed = new Set(["neighborhood", "type", "status", "q", "page", "per_page"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  for (const key of ["neighborhood", "type", "status", "q"]) {
    if (args[key] !== undefined && typeof args[key] !== "string") return false;
  }
  if (args.page !== undefined && (!Number.isInteger(args.page) || args.page < 1)) return false;
  if (args.per_page !== undefined && (!Number.isInteger(args.per_page) || args.per_page < 1 || args.per_page > 100)) return false;
  return true;
}

export async function handleMcpRequest(request, executeTool) {
  if (request.method === "GET") {
    return new Response("Building Seattle MCP endpoint. Send JSON-RPC requests with POST.\n", {
      status: 405,
      headers: { Allow: "POST", "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return error(null, -32600, "Content-Type must be application/json", 415);
  }

  let message;
  try {
    message = await request.json();
  } catch {
    return error(null, -32700, "Parse error", 400);
  }
  if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return error(message?.id, -32600, "Invalid Request", 400);
  }

  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
    return new Response(null, { status: 202 });
  }
  if (message.id === undefined) return new Response(null, { status: 202 });

  if (message.method === "initialize") {
    return jsonRpcResponse({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "building-seattle", title: "Building Seattle", version: "1.0.0" },
        instructions: "Use these read-only tools to research Seattle construction permits and contractors.",
      },
    });
  }
  if (message.method === "ping") return jsonRpcResponse({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "tools/list") {
    return jsonRpcResponse({ jsonrpc: "2.0", id: message.id, result: { tools: MCP_TOOLS } });
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (!MCP_TOOLS.some((tool) => tool.name === name)) return error(message.id, -32602, `Unknown tool: ${name || "(missing)"}`);
    if (!validArguments(name, args)) return error(message.id, -32602, "Invalid tool arguments");
    try {
      const data = await executeTool(name, args);
      return jsonRpcResponse({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data },
      });
    } catch (cause) {
      return jsonRpcResponse({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `Building Seattle API error: ${cause.message}` }], isError: true },
      });
    }
  }
  return error(message.id, -32601, "Method not found");
}
