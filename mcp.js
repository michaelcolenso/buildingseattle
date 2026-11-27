import { ANON_API_MAX_PAGE, ANON_API_MAX_PER_PAGE, allowedOrigins } from "./security.js";

const PROTOCOL_VERSION = "2025-06-18";
const DATASET_URL = "https://buildingseattle.com/data";
const ATTRIBUTION = {
  source: "Building Seattle (buildingseattle.com), from City of Seattle SDCI open data",
  license: "Seattle open data; Building Seattle enrichment for reference use",
  full_dataset: DATASET_URL,
};

export const MCP_TOOLS = [
  {
    name: "search_permits",
    title: "Search Seattle permits",
    description: `Search Seattle construction permits with optional filters and pagination. Without an API key, results are a sample: up to ${ANON_API_MAX_PER_PAGE} summary rows per page and the first ${ANON_API_MAX_PAGE} pages. Send an X-API-Key header for full rows, or see ${DATASET_URL} for the complete dataset.`,
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

// CORS is granted only to an allowed Origin, echoed back (A15).
function jsonRpcResponse(payload, status = 200, responseOrigin = null) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
  };
  if (responseOrigin) {
    headers["Access-Control-Allow-Origin"] = responseOrigin;
    headers.Vary = "Origin";
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

function errorResponse(id, code, message, status = 200, responseOrigin = null) {
  return jsonRpcResponse({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status, responseOrigin);
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

/**
 * Streamable-HTTP MCP endpoint. `options.allowedOrigins` (comma list) extends
 * the site's own origins; a browser request from any other Origin is refused
 * (MCP spec: servers must validate Origin to stop DNS-rebinding attacks).
 * Requests without an Origin (server-side clients) are allowed.
 */
export async function handleMcpRequest(request, executeTool, options = {}) {
  const origin = request.headers.get("Origin");
  let responseOrigin = null;
  if (origin) {
    if (!allowedOrigins(request, options.allowedOrigins).has(origin)) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Origin not allowed" } }), {
        status: 403,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    responseOrigin = origin;
  }
  const keyed = options.access?.tier === "key";
  const respond = (payload, status = 200) => jsonRpcResponse(payload, status, responseOrigin);
  const error = (id, code, message, status = 200) => errorResponse(id, code, message, status, responseOrigin);

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
    return respond({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "building-seattle", title: "Building Seattle", version: "1.0.0" },
        instructions: keyed
          ? "Use these read-only tools to research Seattle construction permits and contractors."
          : `Use these read-only tools to research Seattle construction permits and contractors. Without an API key, search_permits returns a sample (${ANON_API_MAX_PER_PAGE} summary rows per page, first ${ANON_API_MAX_PAGE} pages); the full dataset is at ${DATASET_URL}.`,
      },
    });
  }
  if (message.method === "ping") return respond({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "tools/list") {
    return respond({ jsonrpc: "2.0", id: message.id, result: { tools: MCP_TOOLS } });
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (!MCP_TOOLS.some((tool) => tool.name === name)) return error(message.id, -32602, `Unknown tool: ${name || "(missing)"}`);
    if (!validArguments(name, args)) return error(message.id, -32602, "Invalid tool arguments");
    try {
      const data = await executeTool(name, args);
      const note = keyed
        ? `Source: ${ATTRIBUTION.source}.`
        : `Source: ${ATTRIBUTION.source}. Sample results; full dataset: ${DATASET_URL}`;
      return respond({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            { type: "text", text: JSON.stringify(data, null, 2) },
            { type: "text", text: note },
          ],
          structuredContent: data,
          _meta: { "buildingseattle.com/attribution": { ...ATTRIBUTION, access: keyed ? "key" : "anonymous" } },
        },
      });
    } catch (cause) {
      // Only messages marked safe (our own validation text) reach the client.
      if (!cause?.expose) console.error(`MCP tool ${name} failed:`, cause?.stack || cause);
      const text = cause?.expose ? cause.message : "The tool failed. Try again later.";
      return respond({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `Building Seattle API error: ${text}` }], isError: true },
      });
    }
  }
  return error(message.id, -32601, "Method not found");
}
