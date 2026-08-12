// Cloudflare Worker - Fixed Version

import {
  buildEntityGraph,
  parseAddress,
  makeSlug,
  guessOrgType,
  normalizeOrgName,
} from "./entity_graph.js";
import {
  ADU_CLASSIFICATION_VERSION,
  ADU_DADU_SQL,
  ADU_MATCH_SQL,
  ADU_NORMALIZED_TEXT_SQL,
  classifyAduPermit,
} from "./adu.js";
import { ENTITY_HUBS } from "./entity_hubs.js";
import { handleMcpRequest, MCP_TOOLS } from "./mcp.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Ingest-Token",
};
const INGEST_TOKEN_HEADER = "X-Ingest-Token";
const BASE_URL = "https://buildingseattle.com";
const ADMIN_TOKEN_HEADER = "X-Admin-Token";
const ALERT_EMAIL_FROM = "alerts@buildingseattle.com";
const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self' https://cloudflareinsights.com https://*.cloudflareinsights.com",
    "frame-src https://maps.google.com https://www.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; "),
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const secure = (response) => withSecurityHeaders(response);

    if (request.method === "OPTIONS") {
      return secure(new Response(null, { headers: corsHeaders }));
    }

    try {
      if (url.hostname === "www.buildingseattle.com") {
        url.hostname = "buildingseattle.com";
        return secure(Response.redirect(url.toString(), 301));
      }

      if (path === "/" || path === "") {
        ctx.waitUntil(logPageView(request, env, "/"));
        return secure(await handleRoot(request, env));
      }

      if (path === "/admin") {
        const authError = requireAdminAuth(request, env);
        if (authError) return secure(authError);
        return secure(await renderAdminDashboard(request, env));
      }

      if (path === "/leads" && request.method === "POST") {
        return secure(await handleLeadCapture(request, env));
      }

      if (path === "/leads/batch" && request.method === "POST") {
        return secure(await handleLeadBatch(request, env));
      }

      if (path === "/alerts/subscribe" && request.method === "POST") {
        return secure(await handleAlertSubscription(request, env));
      }

      if (path === "/alerts/confirm" && request.method === "GET") {
        return secure(await handleAlertConfirmation(request, env));
      }

      if (path === "/alerts/unsubscribe" && (request.method === "GET" || request.method === "POST")) {
        return secure(await handleAlertUnsubscribe(request, env));
      }

      if (path === "/api/permits") {
        return secure(await getPermits(request, env));
      }

      if (path === "/mcp") {
        return secure(await handleMcpRequest(request, (name, args) => executeMcpTool(name, args, env, request.url)));
      }

      if (path === "/permits" || path === "/permits/") {
        ctx.waitUntil(logPageView(request, env, "/permits"));
        return secure(await renderPermitBrowser(request, env));
      }

      if (path.startsWith("/permits/")) {
        const permitNumber = decodeURIComponent(path.split("/permits/")[1] || "");
        if (permitNumber) {
          ctx.waitUntil(logPageView(request, env, "/permits/:id"));
          return secure(await renderPermitDetail(permitNumber, env, request));
        }
      }

      if (path === "/api/contractors") {
        return secure(await getContractors(request, env));
      }

      if (path === "/api/stats") {
        return secure(await getStats(env));
      }

      if (path === "/api/status-changes") {
        return secure(await getStatusChanges(request, env));
      }

      if (path === "/api/plan-review") {
        return secure(await getPlanReviewStats(env));
      }

      if (path === "/api/pipeline") {
        return secure(await getPipelineStats(env));
      }

      if (path === "/api/housing") {
        return secure(await getHousingStats(env));
      }

      if (path === "/api/adu-dadu") {
        return secure(await getAduDaduStats(env));
      }

      if (path === "/api/map") {
        return secure(await getMapStats(env));
      }

      if (path === "/api/contractor-scorecards") {
        return secure(await getContractorScorecardStats(env));
      }

      if (path === "/api/network") {
        return secure(await getNetworkStats(env));
      }

      if (path === "/insights" || path === "/insights/") {
        ctx.waitUntil(logPageView(request, env, "/insights"));
        return secure(await renderInsightsIndex(env));
      }

      if (path === "/insights/plan-review") {
        ctx.waitUntil(logPageView(request, env, "/insights/plan-review"));
        return secure(await renderPlanReviewPage(env));
      }

      if (path === "/insights/pipeline") {
        ctx.waitUntil(logPageView(request, env, "/insights/pipeline"));
        return secure(await renderPipelinePage(env));
      }

      if (path === "/insights/housing") {
        ctx.waitUntil(logPageView(request, env, "/insights/housing"));
        return secure(await renderHousingPage(env));
      }

      if (path === "/insights/adu-dadu") {
        ctx.waitUntil(logPageView(request, env, "/insights/adu-dadu"));
        return secure(await renderAduDaduPage(env));
      }

      if (path === "/insights/commercial-projects") {
        ctx.waitUntil(logPageView(request, env, "/insights/commercial-projects"));
        return secure(await renderMarketSegmentPage(env, "commercial"));
      }

      if (path === "/insights/multifamily-pipeline") {
        ctx.waitUntil(logPageView(request, env, "/insights/multifamily-pipeline"));
        return secure(await renderMarketSegmentPage(env, "multifamily"));
      }

      if (path === "/insights/tenant-improvements") {
        ctx.waitUntil(logPageView(request, env, "/insights/tenant-improvements"));
        return secure(await renderMarketSegmentPage(env, "tenant-improvements"));
      }

      if (path === "/insights/map") {
        ctx.waitUntil(logPageView(request, env, "/insights/map"));
        return secure(await renderMapPage(env));
      }

      if (path === "/insights/contractors") {
        ctx.waitUntil(logPageView(request, env, "/insights/contractors"));
        return secure(await renderContractorsPage(env));
      }

      if (path === "/insights/network") {
        ctx.waitUntil(logPageView(request, env, "/insights/network"));
        return secure(await renderNetworkPage(env));
      }

      if (["/contractors", "/neighborhoods", "/projects", "/addresses"].includes(path)) {
        ctx.waitUntil(logPageView(request, env, path));
        return secure(await renderEntityHubPage(path.slice(1), env, request));
      }

      if (path === "/about" || path === "/about/") {
        ctx.waitUntil(logPageView(request, env, "/about"));
        return secure(renderAboutPage());
      }

      if (path === "/methodology" || path === "/methodology/") {
        ctx.waitUntil(logPageView(request, env, "/methodology"));
        return secure(await renderMethodologyPage(env));
      }

      if (path === "/data" || path === "/data/") {
        ctx.waitUntil(logPageView(request, env, "/data"));
        return secure(await renderDataPage(env));
      }

      if (path === "/api/admin/stats") {
        const authError = requireAdminAuth(request, env);
        if (authError) return secure(authError);
        const stats = await getAdminStats(env);
        return secure(
          new Response(JSON.stringify(stats), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }),
        );
      }

      if (path === "/api/admin/analytics") {
        const authError = requireAdminAuth(request, env);
        if (authError) return secure(authError);
        const days = parseInt(url.searchParams.get("days") || "7", 10);
        const since = new Date();
        since.setDate(since.getDate() - days);
        const sinceStr = since.toISOString().split("T")[0];

        const [{ results: totals }, { results: pages }, { results: daily }] = await Promise.all([
          env.DB.prepare(`SELECT COUNT(*) as total FROM page_views WHERE created_at >= ?`).bind(sinceStr).all(),
          env.DB.prepare(
            `SELECT path, COUNT(*) as views FROM page_views WHERE created_at >= ? GROUP BY path ORDER BY views DESC LIMIT 10`,
          )
            .bind(sinceStr)
            .all(),
          env.DB.prepare(
            `SELECT date(created_at) as day, COUNT(*) as views FROM page_views WHERE created_at >= ? GROUP BY day ORDER BY day DESC`,
          )
            .bind(sinceStr)
            .all(),
        ]);

        return secure(
          new Response(JSON.stringify({ days, total: totals[0]?.total || 0, top_pages: pages, daily: daily }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }),
        );
      }

      if (path.startsWith("/contractor/")) {
        const slug = decodeURIComponent(path.split("/contractor/")[1] || "");
        ctx.waitUntil(logPageView(request, env, "/contractor/:slug"));
        return secure(await renderContractorPage(slug, env, request));
      }

      if (path.startsWith("/address/")) {
        const slug = decodeURIComponent(path.split("/address/")[1] || "");
        ctx.waitUntil(logPageView(request, env, "/address/:slug"));
        return secure(await renderAddressPage(slug, env, request));
      }

      if (path.startsWith("/project/")) {
        const slug = decodeURIComponent(path.split("/project/")[1] || "");
        ctx.waitUntil(logPageView(request, env, "/project/:slug"));
        return secure(await renderProjectPage(slug, env, request));
      }

      if (path.startsWith("/neighborhood/")) {
        const slug = decodeURIComponent(path.split("/neighborhood/")[1] || "");
        ctx.waitUntil(logPageView(request, env, "/neighborhood/:slug"));
        return secure(await renderNeighborhoodPage(slug, env, request));
      }

      if (path === "/admin/build-graph" && request.method === "POST") {
        const authError = requireAdminAuth(request, env);
        if (authError) return secure(authError);
        const result = await rebuildEntityGraph(env);
        return secure(jsonResponse(result));
      }

      if (path === "/admin/entity-report") {
        const authError = requireAdminAuth(request, env);
        if (authError) return secure(authError);
        const report = await entityGraphReport(env);
        return secure(jsonResponse(report));
      }

      if (path === "/ingest/permit" && request.method === "POST") {
        const authError = await requireIngestAuth(request, env);
        if (authError) {
          return secure(authError);
        }
        const response = await ingestPermit(request, env);
        ctx.waitUntil(sendPendingPermitAlerts(env));
        return secure(response);
      }

      if (path === "/ingest/permit/batch" && request.method === "POST") {
        const authError = await requireIngestAuth(request, env);
        if (authError) {
          return secure(authError);
        }
        const response = await ingestPermitBatch(request, env);
        ctx.waitUntil(sendPendingPermitAlerts(env));
        return secure(response);
      }

      if (path === "/ingest/permit/enrichment/batch" && request.method === "POST") {
        const authError = await requireIngestAuth(request, env);
        if (authError) {
          return secure(authError);
        }
        return secure(await ingestPermitEnrichmentBatch(request, env));
      }

      if (path === "/ingest/contractor" && request.method === "POST") {
        const authError = await requireIngestAuth(request, env);
        if (authError) {
          return secure(authError);
        }
        return secure(await ingestContractor(request, env));
      }

      if (path === "/ingest/contractor/batch" && request.method === "POST") {
        const authError = await requireIngestAuth(request, env);
        if (authError) {
          return secure(authError);
        }
        return secure(await ingestContractorBatch(request, env));
      }

      if (path === "/ingest/refresh" && request.method === "POST") {
        const authError = await requireIngestAuth(request, env);
        if (authError) {
          return secure(authError);
        }
        return secure(await replaceIngestData(request, env));
      }

      if (path === "/api/user") {
        return secure(await checkAuth(request, env));
      }

      if (path === "/og-image.png") {
        return secure(renderOgImage());
      }

      const socialImageMatch = path.match(/^\/social\/(permit|contractor|project|address|neighborhood|insight)\.png$/);
      if (socialImageMatch) {
        return secure(renderSocialImage(socialImageMatch[1]));
      }

      if (path === "/favicon.ico" || path === "/icons/icon-32.png") {
        return secure(renderAppIcon(32));
      }

      if (path === "/icons/icon-192.png") {
        return secure(renderAppIcon(192));
      }

      if (path === "/icons/icon-512.png") {
        return secure(renderAppIcon(512));
      }

      if (path === "/site.webmanifest") {
        return secure(renderWebManifest());
      }

      if (path === "/robots.txt") {
        return secure(renderRobotsTxt());
      }

      if (path === "/sitemap.xml") {
        return secure(await renderSitemapXml(env, request));
      }

      if (path.startsWith("/sitemaps/")) {
        return secure(await renderChildSitemapXml(path, env, request));
      }

      if (path === "/409508639a064e738971e5aa92be599e.txt") {
        return new Response("409508639a064e738971e5aa92be599e", {
          headers: { "Content-Type": "text/plain" },
        });
      }

      if (path === "/.well-known/api-catalog") {
        return secure(renderApiCatalog());
      }

      if (path === "/openapi.json") {
        return secure(renderOpenApiSpec());
      }

      if (path === "/api-docs") {
        return secure(renderApiDocs());
      }

      if (path === "/.well-known/mcp/server-card.json") {
        return secure(renderMcpServerCard());
      }

      if (path === "/.well-known/agent-skills/index.json") {
        return secure(await renderAgentSkillsIndex());
      }

      return secure(render404());
    } catch (error) {
      console.error("Worker error:", error);
      return secure(
        new Response(
          JSON.stringify({
            error: "Internal Server Error",
            details: error.message,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        ),
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledIngest(env));
  },
};

const DISCOVERY_LINKS = [
  `<${BASE_URL}/.well-known/api-catalog>; rel="api-catalog"`,
  `<${BASE_URL}/openapi.json>; rel="service-desc"; type="application/json"`,
  `<${BASE_URL}/api-docs>; rel="service-doc"; type="text/html"`,
  `<${BASE_URL}/sitemap.xml>; rel="sitemap"; type="application/xml"`,
].join(", ");

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  // Advertise agent-discovery resources on every response (RFC 8288).
  headers.append("Link", DISCOVERY_LINKS);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function timeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  const intervals = [
    { label: "year", seconds: 31536000 },
    { label: "month", seconds: 2592000 },
    { label: "day", seconds: 86400 },
    { label: "hour", seconds: 3600 },
    { label: "minute", seconds: 60 },
  ];
  for (const interval of intervals) {
    const count = Math.floor(seconds / interval.seconds);
    if (count >= 1) return `${count} ${interval.label}${count > 1 ? "s" : ""} ago`;
  }
  return "Just now";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateMetaDescription(value, maxLength = 165) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const candidate = text.slice(0, maxLength - 1);
  const lastSpace = candidate.lastIndexOf(" ");
  const shortened = lastSpace >= Math.floor(maxLength * 0.7) ? candidate.slice(0, lastSpace) : candidate;
  return shortened.replace(/[,:;.!?\s]+$/, "") + "…";
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function normalizeStoredStatus(status) {
  const value = String(status || "").trim();
  return value || "new";
}

function intOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function cleanFeedText(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (!text || ["n/a", "none", "null"].includes(text.toLowerCase())) {
    return null;
  }
  return text;
}

function buildAduReclassificationStatement(env, permitNumbers) {
  const uniquePermitNumbers = [...new Set(permitNumbers.filter(Boolean))];
  if (!uniquePermitNumbers.length) return null;
  const placeholders = uniquePermitNumbers.map(() => "?").join(",");
  return env.DB.prepare(
    `/* adu-materialize:reclassify */
     WITH normalized AS (
       SELECT id, ${ADU_NORMALIZED_TEXT_SQL} AS adu_search_text
       FROM permits
       WHERE permit_number IN (${placeholders})
     ),
     classified AS (
       SELECT id,
              CASE
                WHEN ${ADU_DADU_SQL} THEN 'DADU'
                WHEN ${ADU_MATCH_SQL} THEN 'ADU'
                ELSE NULL
              END AS adu_type
       FROM normalized
     )
     UPDATE permits
     SET adu_type = (SELECT classified.adu_type FROM classified WHERE classified.id = permits.id),
         adu_classification_version = ${ADU_CLASSIFICATION_VERSION}
     WHERE id IN (SELECT id FROM classified)`,
  ).bind(...uniquePermitNumbers);
}

// Upserts permits by permit_number while preserving enrichment-only columns
// (parcel_number, contractor_license, review_level, inspections, owner_name,
// last_enriched_at, etc.). Only base-feed columns are overwritten; contractor_id
// and applicant_name use COALESCE so a null from the feed does not clear an
// enrichment-supplied value.
const PERMIT_UPSERT_SQL = `
  INSERT INTO permits (
    permit_number, contractor_id, applicant_name, address, neighborhood,
    type, value, status, description, housing_units,
    applied_date, issued_date, completed_date,
    housing_units_added, housing_units_removed, housing_category,
    dwelling_unit_type, zoning, parent_permit_number, related_mup,
    number_review_cycles, total_days_plan_review, days_out_corrections,
    plan_review_complete_date, ready_to_issue_date
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(permit_number) DO UPDATE SET
    contractor_id = COALESCE(excluded.contractor_id, permits.contractor_id),
    applicant_name = COALESCE(excluded.applicant_name, permits.applicant_name),
    address = excluded.address,
    neighborhood = excluded.neighborhood,
    type = excluded.type,
    value = excluded.value,
    status = excluded.status,
    description = excluded.description,
    housing_units = excluded.housing_units,
    applied_date = excluded.applied_date,
    issued_date = excluded.issued_date,
    completed_date = excluded.completed_date,
    housing_units_added = excluded.housing_units_added,
    housing_units_removed = excluded.housing_units_removed,
    housing_category = excluded.housing_category,
    dwelling_unit_type = excluded.dwelling_unit_type,
    zoning = excluded.zoning,
    parent_permit_number = excluded.parent_permit_number,
    related_mup = excluded.related_mup,
    number_review_cycles = excluded.number_review_cycles,
    total_days_plan_review = excluded.total_days_plan_review,
    days_out_corrections = excluded.days_out_corrections,
    plan_review_complete_date = excluded.plan_review_complete_date,
    ready_to_issue_date = excluded.ready_to_issue_date,
    updated_at = CURRENT_TIMESTAMP
`;

function dateOrNull(value) {
  if (!value) {
    return null;
  }
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const [, month, day, year] = match;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

async function logPageView(request, env, path) {
  try {
    const country = request.cf?.country || "";
    const referrer = request.headers.get("referer") || "";
    const ua = request.headers.get("user-agent") || "";
    await env.DB.prepare(`INSERT INTO page_views (path, referrer, user_agent, country) VALUES (?, ?, ?, ?)`)
      .bind(path, referrer, ua, country)
      .run();
  } catch (e) {
    // Silently fail — analytics should never break the site
  }
}

function renderPagination(url, page, totalPages, total, shown, offset) {
  const qs = new URLSearchParams(url.search);
  const makeLink = (p) => {
    qs.set("page", String(p));
    return url.pathname + "?" + qs.toString();
  };
  const start = total === 0 ? 0 : offset + 1;
  const end = offset + shown;
  let html = `<div class="pagination" style="display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:1.5rem 0;border-top:1px solid var(--border);flex-wrap:wrap;">`;
  html += `<div style="font-size:0.875rem;color:var(--text-muted);">Showing ${start}-${end} of ${total}</div>`;
  html += `<div style="display:flex;gap:0.5rem;align-items:center;">`;
  if (page > 1) {
    html += `<a href="${makeLink(page - 1)}" style="padding:0.5rem 1rem;border-radius:0.5rem;border:1px solid var(--border);color:var(--text);text-decoration:none;font-size:0.875rem;font-weight:600;background:var(--surface);">&larr; Prev</a>`;
  }
  html += `<span style="font-size:0.875rem;color:var(--text-muted);padding:0 0.5rem;">Page ${page} of ${totalPages}</span>`;
  if (page < totalPages) {
    html += `<a href="${makeLink(page + 1)}" style="padding:0.5rem 1rem;border-radius:0.5rem;border:1px solid var(--border);color:var(--text);text-decoration:none;font-size:0.875rem;font-weight:600;background:var(--surface);">Next &rarr;</a>`;
  }
  html += `</div></div>`;
  return html;
}

function unauthorizedResponse(message, status = 401) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function requireAdminAuth(request, env) {
  if (request.headers.get("CF-Access-Jwt-Assertion")) {
    return null;
  }

  const configuredToken = env.ADMIN_API_TOKEN;
  if (configuredToken && request.headers.get(ADMIN_TOKEN_HEADER) === configuredToken) {
    return null;
  }

  return unauthorizedResponse("Unauthorized admin request");
}

async function timingSafeEqualString(provided, expected) {
  if (!provided || !expected) {
    return false;
  }
  const encoder = new TextEncoder();
  const providedBytes = encoder.encode(provided);
  const expectedBytes = encoder.encode(expected);
  if (providedBytes.length !== expectedBytes.length) {
    return false;
  }
  const providedDigest = await crypto.subtle.digest("SHA-256", providedBytes);
  const expectedDigest = await crypto.subtle.digest("SHA-256", expectedBytes);
  const providedHash = new Uint8Array(providedDigest);
  const expectedHash = new Uint8Array(expectedDigest);
  let diff = 0;
  for (let i = 0; i < providedHash.length; i++) {
    diff |= providedHash[i] ^ expectedHash[i];
  }
  return diff === 0;
}

async function requireIngestAuth(request, env) {
  if (!env.INGEST_API_TOKEN) {
    return unauthorizedResponse("Ingest auth is not configured", 500);
  }

  const providedToken = request.headers.get(INGEST_TOKEN_HEADER);
  if (!(await timingSafeEqualString(providedToken, env.INGEST_API_TOKEN))) {
    return unauthorizedResponse("Unauthorized ingest request");
  }

  return null;
}

function renderDesignTokens() {
  return `<style>
      :root {
        --primary: #0f172a;
        --accent: #3b82f6;
        --accent-hover: #2563eb;
        --bg: #ffffff;
        --bg-alt: #f8fafc;
        --surface: #ffffff;
        --text: #1e293b;
        --text-muted: #64748b;
        --text-subtle: #94a3b8;
        --border: #e2e8f0;
        --success: #10b981;
        --warn: #f59e0b;
        --danger: #ef4444;
        --steel: #475569;
        --radius-sm: 0.5rem;
        --radius-md: 0.75rem;
        --radius-lg: 1rem;
        --shadow-sm: 0 1px 3px rgba(0,0,0,0.08);
        --shadow-md: 0 14px 45px rgba(15,23,42,0.06);
        --shadow-lg: 0 22px 60px rgba(15,23,42,0.14);
        --container-max: 1200px;
      }
      .global-nav { position: fixed; top: 0; left: 0; right: 0; background: rgba(255,255,255,0.9); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); z-index: 50; }
      .global-nav-row { height: 4rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
      .global-nav .logo { font-weight: 800; font-size: 1.25rem; color: var(--primary); text-decoration: none; display: flex; align-items: center; gap: 0.5rem; }
      .global-nav .logo-icon { width: 2rem; height: 2rem; background: linear-gradient(135deg, var(--accent), var(--accent-hover)); border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 1rem; }
      .global-nav-links { display: none; gap: 1.75rem; align-items: center; }
      .global-nav-links a { color: var(--text-muted); text-decoration: none; font-weight: 500; font-size: 0.875rem; }
      .global-nav-links a:hover, .global-nav-links a.active { color: var(--accent); }
      .global-nav-hamburger { display: block; background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--primary); padding: 0.25rem; }
      @media (min-width: 768px) {
        .global-nav-links { display: flex; }
        .global-nav-hamburger { display: none; }
      }
      @media (max-width: 767px) {
        .global-nav-links.open { display: flex; position: absolute; top: 4rem; right: 1rem; background: rgba(255,255,255,0.95); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 0.5rem 1rem; flex-direction: column; min-width: 180px; box-shadow: var(--shadow-sm); backdrop-filter: blur(12px); }
      }
      .global-nav-spacer { height: 4rem; }
      .global-footer { background: var(--bg-alt); border-top: 1px solid var(--border); padding: 3rem 0; color: var(--text-muted); font-size: 0.875rem; margin-top: 4rem; }
      .global-footer-row { display: flex; flex-direction: column; gap: 1rem; align-items: center; text-align: center; max-width: var(--container-max); margin: 0 auto; padding: 0 1.5rem; }
      @media (min-width: 768px) { .global-footer-row { flex-direction: row; justify-content: space-between; text-align: left; } }
      .global-footer a { color: var(--text-muted); text-decoration: none; }
      .global-footer a:hover { color: var(--accent); }
    </style>`;
}

function renderNav(activePage) {
  const link = (href, label, key) => `<a href="${href}"${key === activePage ? ' class="active"' : ""}>${label}</a>`;
  return `<nav class="global-nav" id="global-nav">
      <div class="container global-nav-row">
        <a href="/" class="logo"><span class="logo-icon">B</span>Building Seattle</a>
        <button class="global-nav-hamburger" onclick="document.querySelector('#global-nav .global-nav-links').classList.toggle('open')" aria-label="Menu">&#9776;</button>
        <div class="global-nav-links">
          ${link("/", "Home", "home")}
          ${link("/permits", "Browse Permits", "permits")}
          ${link("/neighborhoods", "Explore", "explore")}
          ${link("/insights/plan-review", "Insights", "insights")}
          ${link("/data", "Data", "data")}
          ${link("/api/permits", "API", "api")}
        </div>
      </div>
    </nav>`;
}

function renderFooter() {
  return `<footer class="global-footer">
      <div class="global-footer-row">
        <div>Building Seattle &mdash; Seattle construction intelligence</div>
        <div><a href="/contractors">Contractors</a> &middot; <a href="/neighborhoods">Neighborhoods</a> &middot; <a href="/projects">Projects</a> &middot; <a href="/addresses">Addresses</a> &middot; <a href="/data">Dataset</a> &middot; <a href="/methodology">Methodology</a></div>
      </div>
    </footer>`;
}

// Server-rendered homepage modules backed by the entity graph: top addresses,
// top contractors, neighborhoods, and latest activity. Renders nothing until
// the graph has been built at least once.
function renderHomeGraphSection({ topAddresses, topGraphContractors, topNeighborhoods, latestActivity }) {
  const money = (n) => {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? `$${Math.round(v).toLocaleString()}` : "—";
  };
  const dateShort = (d) => {
    if (!d) return "";
    const dt = new Date(d);
    return Number.isNaN(dt.getTime()) ? "" : dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const addrItems = (topAddresses || [])
    .map(
      (a) => `<li class="list-item" onclick="location.href='/address/${encodeURIComponent(a.slug)}'">
        <div><div class="list-item-title">${escapeHtml(a.display_address)}</div><div class="list-item-meta">${money(a.total_value)} total value</div></div>
        <span class="badge badge-blue">${a.permits}</span></li>`,
    )
    .join("");

  const contractorItems = (topGraphContractors || [])
    .map(
      (c) => `<li class="list-item" onclick="location.href='/contractor/${encodeURIComponent(c.slug)}'">
        <div><div class="list-item-title">${escapeHtml(c.name)}</div><div class="list-item-meta">${c.permits} permits</div></div>
        <span class="badge badge-green">View</span></li>`,
    )
    .join("");

  const activityItems = (latestActivity || [])
    .map((p) => {
      const href = p.addr_slug ? `/address/${encodeURIComponent(p.addr_slug)}` : `/permits/${encodeURIComponent(p.permit_number)}`;
      return `<li class="list-item" onclick="location.href='${href}'">
        <div><div class="list-item-title">${escapeHtml(p.display_address || p.permit_number)}</div><div class="list-item-meta">${escapeHtml(p.type || "permit")} · ${money(p.value)} · ${escapeHtml(dateShort(p.issued_date || p.applied_date))}</div></div>
        <span class="badge badge-blue">${escapeHtml(p.status || "new")}</span></li>`;
    })
    .join("");

  const neighborhoodChips = (topNeighborhoods || [])
    .map(
      (n) => `<a href="/neighborhood/${encodeURIComponent(n.slug)}" style="display:inline-flex;align-items:center;gap:0.4rem;padding:0.4rem 0.85rem;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--text);text-decoration:none;font-size:0.85rem;font-weight:600;">${escapeHtml(n.name)} <span style="color:var(--text-muted);font-weight:500;">${n.addresses}</span></a>`,
    )
    .join("");

  // Only render panels that have data, skip empty ones
  const panels = [
    addrItems && `<div class="data-panel">
                    <div class="panel-header"><h3>Top Addresses</h3></div>
                    <div class="panel-content"><ul style="list-style:none;margin:0;padding:0;">${addrItems}</ul></div>
                </div>`,
    contractorItems && `<div class="data-panel">
                    <div class="panel-header"><h3>Top Contractors</h3></div>
                    <div class="panel-content"><ul style="list-style:none;margin:0;padding:0;">${contractorItems}</ul></div>
                </div>`,
    activityItems && `<div class="data-panel">
                    <div class="panel-header"><h3>Latest Activity</h3><div class="live-indicator"><div class="pulse"></div>LIVE</div></div>
                    <div class="panel-content"><ul style="list-style:none;margin:0;padding:0;">${activityItems}</ul></div>
                </div>`,
    neighborhoodChips && `<div class="data-panel">
                    <div class="panel-header"><h3>Neighborhoods</h3></div>
                    <div class="panel-content"><div style="display:flex;flex-wrap:wrap;gap:0.5rem;">${neighborhoodChips}</div></div>
                </div>`,
  ].filter(Boolean);

  if (panels.length === 0) return "";

  return `<section class="live-data" id="graph" style="background:var(--bg-alt);">
        <div class="container">
            <div class="section-header">
                <h2>Explore the construction graph</h2>
                <p>Permits rolled up into properties, projects, contractors, and neighborhoods.</p>
            </div>
            <div class="data-grid">
                ${panels.join("\n                ")}
            </div>
        </div>
    </section>`;
}

async function handleRoot(request, env) {
  const canonical = BASE_URL + "/";
  const lastRun = await env.DB.prepare(
    `SELECT end_time FROM ingest_logs WHERE status = 'success' ORDER BY end_time DESC LIMIT 1`,
  ).first();
  const lastUpdated = lastRun?.end_time ? timeAgo(new Date(lastRun.end_time)) : "Recently";

  if (wantsMarkdown(request)) {
    return markdownResponse(request, homeMarkdown(lastUpdated));
  }

  // Entity-graph modules for the homepage (gracefully empty before first build).
  const [topAddresses, topGraphContractors, topNeighborhoods, latestActivity] = await Promise.all([
    safeAll(
      env,
      `SELECT a.slug, a.display_address, COUNT(p.id) AS permits, COALESCE(SUM(p.value),0) AS total_value
       FROM addresses a JOIN permits p ON p.address_id = a.id
       GROUP BY a.id ORDER BY permits DESC, total_value DESC LIMIT 8`,
    ),
    safeAll(
      env,
      `SELECT o.name, o.slug, COUNT(*) AS permits FROM people_orgs o
       JOIN permit_participants pp ON pp.people_org_id = o.id AND pp.role = 'contractor'
       GROUP BY o.id ORDER BY permits DESC LIMIT 8`,
    ),
    safeAll(
      env,
      `SELECT n.name, n.slug, COUNT(DISTINCT an.address_id) AS addresses
       FROM neighborhoods n JOIN address_neighborhoods an ON an.neighborhood_id = n.id
       GROUP BY n.id ORDER BY addresses DESC LIMIT 12`,
    ),
    safeAll(
      env,
      `SELECT p.permit_number, p.type, p.value, p.status, p.issued_date, p.applied_date,
              a.slug AS addr_slug, a.display_address
       FROM permits p LEFT JOIN addresses a ON a.id = p.address_id
       ORDER BY COALESCE(p.issued_date, p.applied_date) DESC LIMIT 8`,
    ),
  ]);

  const graphSection = renderHomeGraphSection({ topAddresses, topGraphContractors, topNeighborhoods, latestActivity });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Seattle Construction Permits & Project Data | Building Seattle</title>
    <meta name="description" content="Track Seattle construction: search permits, contractor profiles, project values, and neighborhood activity. Find active building projects and development leads faster.">
    <meta name="robots" content="index,follow,max-image-preview:large">
    <link rel="canonical" href="${canonical}">
    <meta property="og:title" content="Seattle Construction Permits & Project Data | Building Seattle">
    <meta property="og:description" content="Track Seattle construction: search permits, contractor profiles, project values, and neighborhood activity. Find active building projects and development leads faster.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${canonical}">
    <meta name="twitter:card" content="summary_large_image">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
	    <meta name="twitter:image" content="${BASE_URL}/og-image.png">
	    <link rel="icon" href="/favicon.ico" sizes="32x32" type="image/png">
	    <link rel="manifest" href="/site.webmanifest">
    ${renderDesignTokens()}
    <style>
        :root { --primary: #0f172a; --accent: #3b82f6; --bg: #ffffff; --bg-alt: #f8fafc; --text: #1e293b; --text-muted: #64748b; --border: #e2e8f0; --steel: #475569; --amber: #f59e0b; --success: #10b981; --danger: #ef4444; --shadow: 0 22px 60px rgba(15,23,42,0.14); }
        @media (prefers-color-scheme: dark) { :root { --primary: #f8fafc; --bg: #0f172a; --bg-alt: #1e293b; --text: #e2e8f0; --text-muted: #94a3b8; --border: #334155; } }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
        .container { max-width: 1200px; margin: 0 auto; padding: 0 1.5rem; }
        .btn { display: inline-flex; align-items: center; justify-content: center; padding: 0.75rem 1.5rem; border-radius: 0.5rem; font-weight: 600; text-decoration: none; transition: all 0.2s; border: none; cursor: pointer; font-size: 0.875rem; }
        .btn-primary { background: var(--accent); color: white; }
        .btn-primary:hover { background: #2563eb; transform: translateY(-1px); }
        .hero { padding-top: 8rem; padding-bottom: 4rem; position: relative; overflow: hidden; min-height: 760px; display: flex; align-items: center; }
        .hero::before { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: linear-gradient(180deg, rgba(15,23,42,0.25) 0%, rgba(15,23,42,0.6) 100%); z-index: 1; pointer-events: none; }
        .hero::after { content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none; opacity: 0.22; background-image: linear-gradient(rgba(255,255,255,0.18) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.14) 1px, transparent 1px); background-size: 72px 72px; mask-image: linear-gradient(90deg, transparent, #000 18%, #000 78%, transparent); }
        #skyline { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; }
        .hero .container { position: relative; z-index: 2; }
        .hero h1, .hero .stat-value { color: #ffffff; text-shadow: 0 2px 20px rgba(0,0,0,0.4); }
        .hero p, .hero .stat-label { color: rgba(255,255,255,0.8); text-shadow: 0 1px 10px rgba(0,0,0,0.3); }
        .hero-stats { border-top-color: rgba(255,255,255,0.15); }
        .hero-badge { display: inline-flex; align-items: center; gap: 0.5rem; background: rgba(59,130,246,0.2); color: #93c5fd; padding: 0.5rem 1rem; border-radius: 9999px; font-size: 0.875rem; font-weight: 600; margin-bottom: 1.5rem; border: 1px solid rgba(59,130,246,0.35); backdrop-filter: blur(8px); }
        .hero .btn-secondary { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.9); border-color: rgba(255,255,255,0.2); backdrop-filter: blur(8px); }
        .hero .btn-secondary:hover { background: rgba(255,255,255,0.18); }
        .hero-grid { display: grid; grid-template-columns: 1fr; gap: 3rem; align-items: center; }
        @media (min-width: 1024px) { .hero-grid { grid-template-columns: 1fr 1fr; } }
        .hero h1 { font-size: 3rem; line-height: 1.1; font-weight: 800; margin-bottom: 1.5rem; letter-spacing: -0.02em; }
        @media (min-width: 768px) { .hero h1 { font-size: 4rem; } }
        .hero p { font-size: 1.25rem; margin-bottom: 2rem; max-width: 620px; }
        .hero-proof { display: grid; grid-template-columns: 1fr; gap: 0.75rem; margin: 1.5rem 0 0; max-width: 680px; }
        .proof-item { display: flex; gap: 0.65rem; align-items: flex-start; padding: 0.85rem 1rem; border: 1px solid rgba(255,255,255,0.16); background: rgba(15,23,42,0.38); color: rgba(255,255,255,0.86); backdrop-filter: blur(10px); }
        .proof-item strong { display: block; color: #fff; font-size: 0.9rem; line-height: 1.25; }
        .proof-item span { display: block; color: rgba(255,255,255,0.72); font-size: 0.78rem; margin-top: 0.15rem; }
        @media (min-width: 768px) { .hero-proof { grid-template-columns: repeat(3, 1fr); } }
        .ops-strip { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 1.25rem 0 2rem; }
        .ops-chip { display: inline-flex; align-items: center; gap: 0.5rem; min-height: 2.25rem; padding: 0.45rem 0.7rem; border: 1px solid rgba(255,255,255,0.18); background: rgba(15,23,42,0.42); color: rgba(255,255,255,0.86); backdrop-filter: blur(10px); font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
        .ops-dot { width: 0.5rem; height: 0.5rem; border-radius: 999px; background: var(--success); box-shadow: 0 0 0 0 rgba(16,185,129,0.45); animation: radarPulse 1.8s infinite; }
        @keyframes radarPulse { 70% { box-shadow: 0 0 0 9px rgba(16,185,129,0); } 100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); } }
        .hero-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.85rem; margin-top: 3rem; padding-top: 0; border-top: 0; }
        .stat-tile { position: relative; min-height: 112px; padding: 1rem; background: rgba(15,23,42,0.5); border: 1px solid rgba(255,255,255,0.16); box-shadow: 0 16px 50px rgba(2,6,23,0.22); backdrop-filter: blur(12px); overflow: hidden; }
        .stat-tile::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 3px; background: linear-gradient(90deg, var(--success), var(--accent), var(--amber)); transform-origin: left; transform: scaleX(var(--load, 0.18)); transition: transform 900ms cubic-bezier(.16,1,.3,1); }
        .stat-kicker { color: rgba(255,255,255,0.58); font-size: 0.68rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.35rem; }
        .stat-value { font-size: 2rem; font-weight: 800; color: var(--primary); }
        .stat-label { font-size: 0.875rem; color: var(--text-muted); margin-top: 0.25rem; }
        .stat-delta { margin-top: 0.5rem; color: rgba(255,255,255,0.68); font-size: 0.72rem; font-weight: 650; }
        .section-header { text-align: center; max-width: 600px; margin: 0 auto 4rem; }
        .section-header h2 { font-size: 2.5rem; font-weight: 800; color: var(--primary); margin-bottom: 1rem; }
        .section-header p { color: var(--text-muted); font-size: 1.125rem; }
        .live-data { padding: 6rem 0; background: var(--bg); }
        .data-grid { display: grid; grid-template-columns: 1fr; gap: 2rem; margin-top: 3rem; }
        .seo-grid { display: grid; grid-template-columns: 1fr; gap: 1.25rem; margin-top: 2.5rem; }
        @media (min-width: 768px) { .seo-grid { grid-template-columns: repeat(3, 1fr); } }
        .seo-card { background: var(--bg); border: 1px solid var(--border); border-radius: 1rem; padding: 1.5rem; box-shadow: 0 8px 30px rgba(15,23,42,0.04); }
        .seo-card h3 { color: var(--primary); font-size: 1.05rem; margin-bottom: 0.65rem; }
        .seo-card p { color: var(--text-muted); font-size: 0.95rem; margin-bottom: 1rem; }
        .seo-card a { color: var(--accent); font-weight: 700; text-decoration: none; }
        .seo-card a:hover { text-decoration: underline; }
        .faq-list { max-width: 880px; margin: 2.5rem auto 0; display: grid; gap: 1rem; }
        .faq-item { background: var(--bg); border: 1px solid var(--border); border-radius: 1rem; padding: 1.25rem 1.5rem; }
        .faq-item h3 { color: var(--primary); font-size: 1rem; margin-bottom: 0.45rem; }
        .faq-item p { color: var(--text-muted); margin: 0; }
        @media (min-width: 768px) { .data-grid { grid-template-columns: repeat(2, 1fr); } }
        .data-panel { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 0.75rem; overflow: hidden; box-shadow: 0 14px 45px rgba(15,23,42,0.06); }
        .panel-header { padding: 1.5rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
        .panel-header h3 { font-weight: 700; display: flex; align-items: center; gap: 0.5rem; }
        .live-indicator { display: flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; font-weight: 600; color: #10b981; }
        .pulse { width: 8px; height: 8px; background: #10b981; border-radius: 50%; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .panel-content { padding: 1.5rem; }
        .ops-panel-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.65rem; padding: 0 1.5rem 1.35rem; border-bottom: 1px solid var(--border); }
        .summary-cell { min-height: 76px; padding: 0.75rem; border: 1px solid var(--border); background: var(--bg); }
        .summary-value { font-size: 1.2rem; font-weight: 850; color: var(--primary); line-height: 1.1; }
        .summary-label { margin-top: 0.35rem; color: var(--text-muted); font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
        .density-map { display: grid; grid-template-columns: repeat(12, 1fr); gap: 4px; padding: 1.25rem 1.5rem 0; }
        .density-cell { height: 18px; background: color-mix(in srgb, var(--accent) calc(var(--heat) * 1%), var(--border)); border: 1px solid color-mix(in srgb, var(--accent) calc(var(--heat) * 0.8%), transparent); transform: scaleY(0.35); transform-origin: bottom; animation: growCell 760ms cubic-bezier(.16,1,.3,1) forwards; animation-delay: calc(var(--i) * 24ms); }
        @keyframes growCell { to { transform: scaleY(1); } }
        .list-item { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; margin: 0 -0.75rem; border-radius: 0.5rem; cursor: pointer; transition: all 0.2s ease; border-bottom: 1px solid var(--border); }
        .list-item:last-child { border-bottom: none; }
        .list-item:hover { background: rgba(59, 130, 246, 0.05); transform: translateX(4px); }
        .list-item-title { font-weight: 600; font-size: 0.875rem; color: var(--text); }
        .list-item-meta { font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem; }
        .badge { font-size: 0.75rem; padding: 0.25rem 0.75rem; border-radius: 9999px; font-weight: 600; }
        .badge-blue { background: rgba(59,130,246,0.1); color: var(--accent); }
        .badge-green { background: rgba(16,185,129,0.1); color: #10b981; }
        .cta { padding: 6rem 0; background: var(--primary); color: white; position: relative; overflow: hidden; }

        .cta-content { position: relative; z-index: 1; text-align: center; max-width: 700px; margin: 0 auto; }
        .cta h2 { font-size: 3rem; font-weight: 800; margin-bottom: 1.5rem; }
        .cta p { font-size: 1.25rem; opacity: 0.9; margin-bottom: 2rem; }
        .btn-white { background: white; color: var(--primary); font-size: 1rem; padding: 1rem 2rem; }
        .btn-white:hover { background: rgba(255,255,255,0.9); transform: translateY(-2px); }
        .loading { padding: 2rem; text-align: center; color: var(--text-muted); }
        .skeleton-stack { display: grid; gap: 0.85rem; }
        .skeleton-row { height: 54px; border-radius: 0.5rem; background: linear-gradient(90deg, color-mix(in srgb, var(--border), transparent 20%), color-mix(in srgb, var(--bg), var(--border) 28%), color-mix(in srgb, var(--border), transparent 20%)); background-size: 240% 100%; animation: skeletonSweep 1.35s infinite; }
        @keyframes skeletonSweep { to { background-position: -240% 0; } }
        .error { padding: 2rem; text-align: center; color: #ef4444; }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; backdrop-filter: blur(4px); align-items: center; justify-content: center; }
        .modal.active { display: flex; }
        .modal-content { background: var(--bg); padding: 2rem; border-radius: 1rem; width: 90%; max-width: 500px; position: relative; box-shadow: var(--shadow-lg); animation: slideUp 0.3s ease-out; }
        @keyframes slideUp { from { transform: translateY(50px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .modal-close { position: absolute; top: 1rem; right: 1rem; background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted); }
        .form-group { margin-bottom: 1.25rem; }
        .form-group label { display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; color: var(--primary); }
        .form-group input, .form-group select { width: 100%; padding: 0.75rem; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--bg); color: var(--text); font-size: 1rem; transition: border-color 0.2s; }
        .form-group input:focus, .form-group select:focus { outline: none; border-color: var(--accent); }
        .loader { display: inline-block; width: 20px; height: 20px; border: 3px solid rgba(255,255,255,.3); border-radius: 50%; border-top-color: white; animation: spin 1s ease-in-out infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .hidden { display: none; }
        @media (max-width: 767px) {
          .hero { min-height: 690px; padding-top: 7rem; }
          .hero-stats, .ops-panel-summary { grid-template-columns: 1fr; }
          .stat-tile { min-height: 92px; }
          .density-map { grid-template-columns: repeat(6, 1fr); }
        }
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: 0.001ms !important; }
        }
    </style>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Building Seattle","url":"https://buildingseattle.com","logo":"https://buildingseattle.com/og-image.png","description":"Real-time Seattle construction permits, contractor profiles, and development opportunities."},{"@type":"WebSite","name":"Building Seattle","url":"https://buildingseattle.com","potentialAction":{"@type":"SearchAction","target":"https://buildingseattle.com/permits?q={search_term_string}","query-input":"required name=search_term_string"}},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What can I search on Building Seattle?","acceptedAnswer":{"@type":"Answer","text":"Browse Seattle construction permits by address, neighborhood, permit type, status, contractor, project value, and recent activity."}},{"@type":"Question","name":"Where does the permit data come from?","acceptedAnswer":{"@type":"Answer","text":"Building Seattle aggregates public Seattle Department of Construction and Inspections permit records and enriches them into property, contractor, and neighborhood views."}},{"@type":"Question","name":"How does Building Seattle help with construction lead generation?","acceptedAnswer":{"@type":"Answer","text":"The site highlights active permits, contractors, project values, addresses, and neighborhoods so teams can prioritize outreach and market research."}}]},{"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://buildingseattle.com/"}]}]}</script>
</head>
<body>
    ${renderNav("home")}

    <section class="hero">
        <canvas id="skyline"></canvas>
        <div class="container">
            <div class="hero-grid">
                <div class="hero-content">
                    <div class="hero-badge"><span class="ops-dot"></span><span>Now tracking live permits</span></div>
                    <h1>Construction intelligence for the Seattle metro</h1>
                    <p>Search live Seattle construction permits, compare contractor activity, and spot new development leads by address, neighborhood, permit type, status, and project value.</p>
                    <div class="ops-strip">
                        <div class="ops-chip"><span class="ops-dot"></span><span>Seattle DCI feed</span></div>
                        <div class="ops-chip">Daily ingest</div>
                        <div class="ops-chip">Permit value radar</div>
                    </div>
                    <div class="hero-proof" aria-label="Building Seattle use cases">
                        <div class="proof-item"><div aria-hidden="true">⌕</div><div><strong>Find projects earlier</strong><span>Monitor applications, issued permits, and status changes.</span></div></div>
                        <div class="proof-item"><div aria-hidden="true">▦</div><div><strong>Research any property</strong><span>Jump from permits to addresses, projects, and neighborhoods.</span></div></div>
                        <div class="proof-item"><div aria-hidden="true">↗</div><div><strong>Prioritize outreach</strong><span>Use value, type, and contractor signals to qualify leads.</span></div></div>
                    </div>
                    <div style="display:flex;gap:1rem;flex-wrap:wrap;">
                        <a class="btn btn-primary" href="/permits">Browse Live Permits</a>
                        <button class="btn" style="background:var(--bg-alt);color:var(--text);border:1px solid var(--border);" onclick="document.getElementById('data').scrollIntoView({behavior:'smooth'})">View Live Data</button>
                    </div>
                    <div class="hero-stats" id="hero-stats">
                        <div class="stat-tile"><div class="stat-kicker">Permits</div><div class="stat-value">—</div><div class="stat-label">Loading</div><div class="stat-delta">Waiting for D1</div></div>
                        <div class="stat-tile"><div class="stat-kicker">Contractors</div><div class="stat-value">—</div><div class="stat-label">Loading</div><div class="stat-delta">Resolving links</div></div>
                        <div class="stat-tile"><div class="stat-kicker">Pipeline</div><div class="stat-value">$—</div><div class="stat-label">Loading</div><div class="stat-delta">Summing project value</div></div>
                    </div>
                </div>
            </div>
        </div>
    </section>

    <section style="padding:4rem 0;background:var(--bg-alt);border-top:1px solid var(--border);border-bottom:1px solid var(--border);">
        <div class="container" style="max-width:800px;">
            <h2 style="font-size:2rem;font-weight:800;color:var(--primary);margin-bottom:1.5rem;">Seattle Construction Market Activity</h2>
            <p style="color:var(--text-muted);font-size:1.125rem;line-height:1.8;margin-bottom:1rem;">
                Building Seattle tracks construction permits across the Seattle metro area — from commercial towers in South Lake Union to residential renovations in Ballard and Capitol Hill. Every permit issued by the Seattle Department of Construction and Inspections is collected, organized, and made searchable so you can track who's building what, where, and with whom.
            </p>
            <p style="color:var(--text-muted);font-size:1.125rem;line-height:1.8;margin-bottom:1rem;">
                The Seattle construction market covers everything from tenant improvements and new residential construction to major commercial projects and demolitions. Whether you're a contractor scoping new work, a developer tracking competition, or a property owner researching permit timelines, Building Seattle gives you the real-time market intelligence you need.
            </p>
            <p style="color:var(--text-muted);font-size:1.125rem;line-height:1.8;">
                Browse thousands of active permits by neighborhood, contractor, or project type. Monitor permit valuations, track review timelines, and discover which contractors are winning work in Seattle's most active development areas.
            </p>
        </div>
    </section>

    <section class="live-data" id="data">
        <div class="container">
            <div class="section-header">
                <h2>Live market data</h2>
                <p>Permits and contractors updated hourly from public records. <span style="color:var(--text-muted);font-size:0.875rem;">Updated ${lastUpdated}</span></p>
            </div>
            <div class="data-grid" id="data-panels">
                <div class="data-panel">
                    <div class="panel-header"><h3>Latest Permits</h3><div class="live-indicator"><div class="pulse"></div>LIVE</div></div>
                    <div class="ops-panel-summary" id="permit-summary">
                        <div class="summary-cell"><div class="summary-value">—</div><div class="summary-label">Latest active</div></div>
                        <div class="summary-cell"><div class="summary-value">—</div><div class="summary-label">Latest pending</div></div>
                        <div class="summary-cell"><div class="summary-value">—</div><div class="summary-label">Avg value</div></div>
                    </div>
                    <div class="density-map" id="permit-density" aria-label="Permit density by recent record"></div>
                    <div class="panel-content"><div class="skeleton-stack"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div></div>
                </div>
                <div class="data-panel">
                    <div class="panel-header"><h3>Top Contractors</h3><div class="live-indicator"><div class="pulse"></div>LIVE</div></div>
                    <div class="ops-panel-summary" id="contractor-summary">
                        <div class="summary-cell"><div class="summary-value">—</div><div class="summary-label">Shown</div></div>
                        <div class="summary-cell"><div class="summary-value">—</div><div class="summary-label">With active work</div></div>
                        <div class="summary-cell"><div class="summary-value">—</div><div class="summary-label">Top workload</div></div>
                    </div>
                    <div class="panel-content"><div class="skeleton-stack"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div></div>
                </div>
            </div>
        </div>
    </section>

    ${graphSection}
,
    <section class="live-data" id="use-cases" style="background:var(--bg-alt);">
        <div class="container">
            <div class="section-header">
                <h2>Built for Seattle permit research and lead generation</h2>
                <p>Building Seattle turns public records into crawlable, searchable pages that help owners, contractors, developers, and real estate teams understand what is being built.</p>
            </div>
            <div class="seo-grid">
                <article class="seo-card"><h3>For contractors and suppliers</h3><p>Discover active building permits, remodels, additions, and high-value projects before competitors find them manually.</p><a href="/permits">Search Seattle permits</a></article>
                <article class="seo-card"><h3>For developers and investors</h3><p>Track neighborhood development activity, project values, permit velocity, and active addresses across Seattle.</p><a href="/insights/pipeline">View pipeline insights</a></article>
                <article class="seo-card"><h3>For market researchers</h3><p>Use contractor profiles, public API access, and structured permit pages to monitor the Seattle construction market.</p><a href="/api-docs">Explore the API</a></article>
            </div>
            <div class="faq-list" aria-label="Seattle permit data FAQ">
                <div class="faq-item"><h3>What can I search on Building Seattle?</h3><p>You can browse Seattle construction permits by address, neighborhood, permit type, status, contractor, project value, and recent activity.</p></div>
                <div class="faq-item"><h3>Where does the permit data come from?</h3><p>The site aggregates public Seattle Department of Construction and Inspections permit records and enriches them into property, contractor, and neighborhood views.</p></div>
                <div class="faq-item"><h3>How does this help with SEO and traffic?</h3><p>Each crawlable permit, contractor, address, project, neighborhood, and insight page creates internal links around high-intent Seattle construction search terms.</p></div>
            </div>
        </div>
    </section>

    <section class="cta">
        <div class="container">
            <div class="cta-content">
                <h2>Explore active work before your competitors do</h2>
                <a class="btn btn-white" href="/permits">Browse Permits</a>
            </div>
        </div>
    </section>

    ${renderFooter()}

    <script>
        var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	        function compactNumber(value) {
	            if (!value) return '0';
            if (value >= 1000000000) return '$' + (value / 1000000000).toFixed(1) + 'B';
            if (value >= 1000000) return '$' + (value / 1000000).toFixed(0) + 'M';
            if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
	            return String(value);
	        }

	        function escapeText(value) {
	            return String(value == null ? '' : value)
	                .replace(/&/g, '&amp;')
	                .replace(/</g, '&lt;')
	                .replace(/>/g, '&gt;')
	                .replace(/"/g, '&quot;')
	                .replace(/'/g, '&#39;');
	        }

        function animateTextNumber(el, target, formatter) {
            if (!el) return;
            formatter = formatter || function(v) { return Math.round(v).toLocaleString(); };
            if (reduceMotion) {
                el.textContent = formatter(target);
                return;
            }
            var start = performance.now();
            var duration = 950;
            function frame(now) {
                var t = Math.min(1, (now - start) / duration);
                var eased = 1 - Math.pow(1 - t, 4);
                el.textContent = formatter(target * eased);
                if (t < 1) requestAnimationFrame(frame);
            }
            requestAnimationFrame(frame);
        }

        function setHeroStats(stats) {
            var totalValue = stats.total_value || 0;
            var tiles = document.querySelectorAll('#hero-stats .stat-tile');
            if (!tiles.length) return;
            tiles[0].style.setProperty('--load', '1');
            tiles[1].style.setProperty('--load', '0.74');
            tiles[2].style.setProperty('--load', '0.92');
            tiles[0].innerHTML = '<div class="stat-kicker">Permits</div><div class="stat-value" data-count="permits">0</div><div class="stat-label">Total permits</div><div class="stat-delta">' + (stats.active_permits || 0).toLocaleString() + ' active right now</div>';
            tiles[1].innerHTML = '<div class="stat-kicker">Contractors</div><div class="stat-value" data-count="contractors">0</div><div class="stat-label">Tracked firms</div><div class="stat-delta">Linked to live permits</div>';
            tiles[2].innerHTML = '<div class="stat-kicker">Pipeline</div><div class="stat-value" data-count="value">$0</div><div class="stat-label">Project value</div><div class="stat-delta">Average ' + compactNumber(stats.avg_value || 0) + ' per permit</div>';
            animateTextNumber(document.querySelector('[data-count="permits"]'), stats.permits || 0);
            animateTextNumber(document.querySelector('[data-count="contractors"]'), stats.contractors || 0);
            animateTextNumber(document.querySelector('[data-count="value"]'), totalValue, compactNumber);
        }

        function normalizePermitPayload(payload) {
            if (Array.isArray(payload)) return payload;
            if (payload && Array.isArray(payload.results)) return payload.results;
            return [];
        }

        function updatePermitSummary(permits) {
            var active = 0, pending = 0, totalValue = 0;
            for (var i = 0; i < permits.length; i++) {
                if (permits[i].status === 'active') active++;
                if (permits[i].status === 'pending') pending++;
                totalValue += permits[i].value || 0;
            }
            var avg = permits.length ? totalValue / permits.length : 0;
            document.getElementById('permit-summary').innerHTML =
                '<div class="summary-cell"><div class="summary-value">' + active.toLocaleString() + '</div><div class="summary-label">Latest active</div></div>' +
                '<div class="summary-cell"><div class="summary-value">' + pending.toLocaleString() + '</div><div class="summary-label">Latest pending</div></div>' +
                '<div class="summary-cell"><div class="summary-value">' + compactNumber(avg) + '</div><div class="summary-label">Avg value</div></div>';

            var density = document.getElementById('permit-density');
            var sample = permits.slice(0, 36);
            var maxValue = sample.reduce(function(max, p) { return Math.max(max, p.value || 0); }, 1);
            density.innerHTML = sample.map(function(p, index) {
                var heat = Math.max(18, Math.round(((p.value || 0) / maxValue) * 100));
	                return '<div class="density-cell" title="' + escapeText(p.neighborhood || 'Seattle') + ' · ' + compactNumber(p.value || 0) + '" style="--heat:' + heat + ';--i:' + index + '"></div>';
            }).join('');
        }

	        window.__permitsPromise = fetch('/api/permits')
	            .then(function(r) { return r.json(); })
	            .then(function(payload) {
	                var permits = normalizePermitPayload(payload);
                window.__permitsData = permits;

                // Latest permits panel
                var panel = document.querySelectorAll('#data-panels .data-panel')[0].querySelector('.panel-content');
                var recent = permits.slice(0, 6);
                updatePermitSummary(permits);
                var panelHtml = '';
                for (var i = 0; i < recent.length; i++) {
                    var p = recent[i];
                    var address = p.address ? p.address.split(',')[0] : 'Unknown';
                    var type = p.type || 'Project';
                    var value = (p.value || 0).toLocaleString();
                    var status = p.status || 'New';
                    var badgeClass = status === 'active' ? 'green' : 'blue';
                    panelHtml += '<div class="list-item" style="cursor: pointer; animation: slideUp 420ms cubic-bezier(.16,1,.3,1) both; animation-delay:' + (i * 45) + 'ms" onclick="window.location=&grave;/permits/' + encodeURIComponent(p.permit_number) + '&grave;">';
	                    panelHtml += '<div><div class="list-item-title">' + escapeText(address) + '</div>';
	                    panelHtml += '<div class="list-item-meta">' + escapeText(type) + ' &bull; $' + value + '</div></div>';
	                    panelHtml += '<span class="badge badge-' + badgeClass + '">' + escapeText(status) + '</span></div>';
                }
	                panel.innerHTML = panelHtml;
	                return permits;
	            })
	            .catch(function(e) {
	                var panel = document.querySelectorAll('#data-panels .data-panel')[0].querySelector('.panel-content');
	                if (panel) panel.innerHTML = '<div class="error">Error loading permits</div>';
	                return [];
	            });

        fetch('/api/stats')
            .then(function(r) { return r.json(); })
            .then(function(stats) {
                setHeroStats(stats);
            });

        fetch('/api/contractors')
            .then(function(r) { return r.json(); })
            .then(function(contractors) {
                var panel = document.querySelectorAll('#data-panels .data-panel')[1].querySelector('.panel-content');
                var topContractors = contractors.slice(0, 6);

                if (topContractors.length === 0) {
                    panel.innerHTML = '<div class="loading">No contractors found</div>';
                    return;
                }

                var html = '';
                var activeContractors = 0;
                var topWorkload = 0;
                for (var s = 0; s < contractors.length; s++) {
                    if ((contractors[s].active_projects || 0) > 0) activeContractors++;
                    topWorkload = Math.max(topWorkload, contractors[s].active_projects || 0);
                }
                document.getElementById('contractor-summary').innerHTML =
                    '<div class="summary-cell"><div class="summary-value">' + contractors.length.toLocaleString() + '</div><div class="summary-label">Shown</div></div>' +
                    '<div class="summary-cell"><div class="summary-value">' + activeContractors.toLocaleString() + '</div><div class="summary-label">With active work</div></div>' +
                    '<div class="summary-cell"><div class="summary-value">' + topWorkload.toLocaleString() + '</div><div class="summary-label">Top workload</div></div>';
                for (var i = 0; i < topContractors.length; i++) {
                    var c = topContractors[i];
                    html += '<div class="list-item" style="cursor: pointer; animation: slideUp 420ms cubic-bezier(.16,1,.3,1) both; animation-delay:' + (i * 45) + 'ms" onclick="window.location=&grave;/contractor/' + encodeURIComponent(c.slug) + '&grave;">';
	                    html += '<div><div class="list-item-title">' + escapeText(c.name) + '</div>';
	                    html += '<div class="list-item-meta">' + escapeText(c.specialty || 'Contractor') + ' &bull; ' + (c.active_projects || 0) + ' active projects</div></div>';
                    html += '<span class="badge badge-green">Active</span></div>';
                }
                panel.innerHTML = html;
            })
            .catch(function(e) {
                var panel = document.querySelectorAll('#data-panels .data-panel')[1].querySelector('.panel-content');
                panel.innerHTML = '<div class="error">Error loading contractors</div>';
            });
    </script>

    <script>
    (function(){
      var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var canvas = document.getElementById('skyline');
      if (!canvas) return;
      var ctx = canvas.getContext('2d');
      var width, height, dpr, time = 0, lastTime = 0;
      var buildings = [], cranes = [], particles = [], stars = [];
      var mouseX = 0, mouseY = 0, targetMouseX = 0, targetMouseY = 0;
      var animId;
      var BUILDING_COLORS = ['#0f172a','#1e293b','#334155'];

      function resize(){
        dpr = Math.min(window.devicePixelRatio, 2);
        width = canvas.offsetWidth; height = canvas.offsetHeight;
        canvas.width = width * dpr; canvas.height = height * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      function Building(x, w, targetH, zonePermits){
        this.x = x; this.w = w; this.targetH = targetH; this.currentH = 0;
        this.permits = zonePermits || []; this.windows = [];
        this.growSpeed = prefersReducedMotion ? 100 : 1.5 + Math.random() * 2.5;
        this.pulsePhase = Math.random() * Math.PI * 2;
        this.beaconActive = this.permits.some(function(p){ return (p.value || 0) > 5000000; });
        var cols = Math.max(1, Math.floor(this.w / 10));
        var rows = Math.max(1, Math.floor(this.targetH / 14));
        for (var r = 2; r < rows - 1; r++){
          for (var c = 1; c < cols - 1; c++){
            if (Math.random() > 0.25){
              var status = this.permits.length > 0 ? this.permits[Math.floor(Math.random() * this.permits.length)].status : 'new';
              this.windows.push({ cx: 3 + c * 10, cy: 3 + r * 14, on: Math.random() > 0.35, status: status });
            }
          }
        }
      }
      Building.prototype.update = function(dt){
        if (this.currentH < this.targetH){
          this.currentH += this.growSpeed * (dt / 16);
          if (this.currentH > this.targetH) this.currentH = this.targetH;
        }
      };
      Building.prototype.draw = function(ctx, parallaxX){
        var x = this.x + parallaxX;
        var y = height - 80 - this.currentH;
        var colorIdx = Math.floor((this.x / width) * BUILDING_COLORS.length) % BUILDING_COLORS.length;
        ctx.fillStyle = BUILDING_COLORS[colorIdx];
        ctx.fillRect(x, y, this.w, this.currentH);
        ctx.fillStyle = '#020617';
        ctx.fillRect(x - 1, y - 3, this.w + 2, 3);
        if (this.currentH > 30){
          var pulse = prefersReducedMotion ? 1 : Math.sin(time * 0.002 + this.pulsePhase) * 0.25 + 0.75;
          for (var i = 0; i < this.windows.length; i++){
            var win = this.windows[i];
            if (win.cy > this.currentH - 5) continue;
            var wx = x + win.cx, wy = y + win.cy;
            if (win.status === 'active'){
              ctx.fillStyle = 'rgba(16,185,129,' + pulse + ')';
              ctx.shadowColor = 'rgba(16,185,129,0.5)'; ctx.shadowBlur = 6;
            } else if (win.status === 'new'){
              ctx.fillStyle = 'rgba(59,130,246,' + pulse + ')';
              ctx.shadowColor = 'rgba(59,130,246,0.4)'; ctx.shadowBlur = 4;
            } else {
              ctx.fillStyle = win.on ? '#fbbf24' : '#1e293b';
              ctx.shadowBlur = 0;
            }
            ctx.fillRect(wx, wy, 5, 7);
            ctx.shadowBlur = 0;
          }
        }
        if (this.beaconActive && this.currentH >= this.targetH * 0.95){
          var beaconPulse = prefersReducedMotion ? 0.8 : Math.sin(time * 0.004) * 0.4 + 0.6;
          ctx.fillStyle = 'rgba(239,68,68,' + beaconPulse + ')';
          ctx.shadowColor = '#ef4444'; ctx.shadowBlur = 16;
          ctx.beginPath(); ctx.arc(x + this.w / 2, y - 6, 3, 0, Math.PI * 2); ctx.fill();
          ctx.shadowBlur = 0;
        }
      };

      function Crane(x, baseY){
        this.x = x; this.baseY = baseY;
        this.height = 100 + Math.random() * 60;
        this.armLength = 60 + Math.random() * 50;
        this.armAngle = 0;
        this.swingSpeed = 0.0003 + Math.random() * 0.0007;
        this.swingAmp = 0.08 + Math.random() * 0.12;
        this.cableLength = 25 + Math.random() * 35;
      }
      Crane.prototype.update = function(){
        this.armAngle = Math.sin(time * this.swingSpeed) * this.swingAmp;
      };
      Crane.prototype.draw = function(ctx, parallaxX){
        var bx = this.x + parallaxX, by = this.baseY;
        var topX = bx, topY = by - this.height;
        ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(topX, topY); ctx.stroke();
        var cjLen = this.armLength * 0.25;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(topX, topY);
        ctx.lineTo(topX - cjLen * Math.cos(this.armAngle), topY - cjLen * Math.sin(this.armAngle));
        ctx.stroke();
        var jibEndX = topX + this.armLength * Math.cos(this.armAngle);
        var jibEndY = topY + this.armLength * Math.sin(this.armAngle);
        ctx.beginPath(); ctx.moveTo(topX, topY); ctx.lineTo(jibEndX, jibEndY); ctx.stroke();
        var loadY = jibEndY + this.cableLength + Math.sin(time * 0.001) * 3;
        ctx.lineWidth = 1; ctx.strokeStyle = '#475569';
        ctx.beginPath(); ctx.moveTo(jibEndX, jibEndY); ctx.lineTo(jibEndX, loadY); ctx.stroke();
        ctx.fillStyle = '#334155'; ctx.fillRect(jibEndX - 5, loadY, 10, 8);
      };

      function Particle(x, y){
        this.x = x; this.y = y;
        this.vx = (Math.random() - 0.5) * 3;
        this.vy = -Math.random() * 4 - 1;
        this.life = 1;
        this.decay = 0.008 + Math.random() * 0.015;
        this.size = 1.5 + Math.random() * 2.5;
        this.color = ['#fbbf24','#3b82f6','#10b981','#f472b6'][Math.floor(Math.random() * 4)];
      }
      Particle.prototype.update = function(){ this.x += this.vx; this.y += this.vy; this.vy += 0.04; this.life -= this.decay; };
      Particle.prototype.draw = function(ctx){ ctx.globalAlpha = this.life; ctx.fillStyle = this.color; ctx.beginPath(); ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; };

      function drawSky(){
        var grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, '#020617'); grad.addColorStop(0.5, '#1e293b');
        grad.addColorStop(0.85, '#3f1810'); grad.addColorStop(1, '#7c2d12');
        ctx.fillStyle = grad; ctx.fillRect(0, 0, width, height);
        for (var i = 0; i < stars.length; i++){
          var s = stars[i];
          var twinkle = prefersReducedMotion ? 0.7 : Math.sin(time * 0.001 + s.phase) * 0.4 + 0.6;
          ctx.fillStyle = 'rgba(255,255,255,' + (twinkle * s.brightness) + ')';
          ctx.beginPath(); ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2); ctx.fill();
        }
      }
      function drawMountains(parx){
        ctx.fillStyle = '#020617';
        ctx.beginPath(); ctx.moveTo(0, height - 60);
        for (var x = 0; x <= width; x += 40){
          var h = 25 + Math.sin(x * 0.008) * 15 + Math.sin(x * 0.003 + 1) * 30 + Math.cos(x * 0.015) * 10;
          ctx.lineTo(x + parx * 0.15, height - 60 - h);
        }
        ctx.lineTo(width, height); ctx.lineTo(0, height); ctx.fill();
      }
      function drawFog(){
        var grad = ctx.createLinearGradient(0, height - 100, 0, height);
        grad.addColorStop(0, 'rgba(248,250,252,0)');
        grad.addColorStop(0.4, 'rgba(248,250,252,0.15)');
        grad.addColorStop(1, 'rgba(248,250,252,0.5)');
        ctx.fillStyle = grad; ctx.fillRect(0, height - 100, width, 100);
      }
      function generateSkyline(permits){
        buildings = []; cranes = []; stars = [];
        for (var i = 0; i < 120; i++){
          stars.push({ x: Math.random() * width, y: Math.random() * height * 0.55, size: Math.random() * 1.5 + 0.3, brightness: Math.random() * 0.5 + 0.3, phase: Math.random() * Math.PI * 2 });
        }
        if (!permits || permits.length === 0){
          var count = Math.floor(width / 50);
          for (var i = 0; i < count; i++) buildings.push(new Building(i * 55 + 15, 25 + Math.random() * 45, 40 + Math.random() * 200, []));
        } else {
          var groups = {};
          for (var i = 0; i < permits.length; i++){
            var p = permits[i]; var n = p.neighborhood || 'Seattle';
            if (!groups[n]) groups[n] = []; groups[n].push(p);
          }
          var names = Object.keys(groups);
          var zoneW = width / Math.max(names.length, 6);
          for (var zi = 0; zi < names.length; zi++){
            var nPermits = groups[names[zi]];
            var totalValue = 0;
            for (var i = 0; i < nPermits.length; i++) totalValue += (nPermits[i].value || 0);
            var avgValue = totalValue / nPermits.length;
            var bCount = 1 + Math.floor(Math.random() * 2);
            for (var b = 0; b < bCount; b++){
              var w = 35 + Math.random() * 50;
              var x = zi * zoneW + b * (zoneW / bCount) + 8;
              var h = 50 + (avgValue / 1000000) * 25 + Math.random() * 60;
              buildings.push(new Building(x, w, Math.min(h, height * 0.55), nPermits));
            }
          }
        }
        var tallBuildings = [];
        for (var i = 0; i < buildings.length; i++) if (buildings[i].targetH > 120) tallBuildings.push(buildings[i]);
        tallBuildings = tallBuildings.slice(0, 4);
        for (var i = 0; i < tallBuildings.length; i++) cranes.push(new Crane(tallBuildings[i].x + tallBuildings[i].w / 2, height - 80));
        if (!prefersReducedMotion){
          for (var i = 0; i < 25; i++) particles.push(new Particle(width / 2 + (Math.random() - 0.5) * 300, height - 120));
        }
      }
      function render(timestamp){
        var dt = Math.min(timestamp - lastTime, 50); lastTime = timestamp; time = timestamp;
        targetMouseX += (mouseX - targetMouseX) * 0.04;
        targetMouseY += (mouseY - targetMouseY) * 0.04;
        var parallaxX = (targetMouseX / width - 0.5) * 30;
        ctx.clearRect(0, 0, width, height);
        drawSky(); drawMountains(parallaxX);
        for (var i = 0; i < buildings.length; i++){ buildings[i].update(dt); buildings[i].draw(ctx, parallaxX * 0.4); }
        for (var i = 0; i < cranes.length; i++){ cranes[i].update(); cranes[i].draw(ctx, parallaxX * 0.6); }
        var newParticles = [];
        for (var i = 0; i < particles.length; i++){ particles[i].update(); particles[i].draw(ctx); if (particles[i].life > 0) newParticles.push(particles[i]); }
        particles = newParticles;
        drawFog();
        animId = requestAnimationFrame(render);
      }
      window.addEventListener('resize', resize);
      document.addEventListener('mousemove', function(e){ mouseX = e.clientX; mouseY = e.clientY; });
      resize();
      function normalizePermitPayload(payload) {
        if (Array.isArray(payload)) return payload;
        if (payload && Array.isArray(payload.results)) return payload.results;
        return [];
      }
	      (window.__permitsPromise || fetch('/api/permits').then(function(r){ return r.json(); }).then(normalizePermitPayload))
	        .then(function(permits){ generateSkyline(permits); })
	        .catch(function(){ generateSkyline([]); });
      animId = requestAnimationFrame(render);
    })();
    </script>

    <div id="leadModal" class="modal" role="dialog" aria-modal="true" aria-labelledby="leadModalTitle" aria-describedby="leadModalDescription">
        <div class="modal-content">
            <button class="modal-close" onclick="closeModal()" aria-label="Close dialog">&times;</button>
            <h3 id="leadModalTitle" style="margin-bottom:0.5rem;">Get Early Access</h3>
            <p id="leadModalDescription" style="color:var(--text-muted);margin-bottom:1.5rem;font-size:0.9rem;">Join 200+ contractors and suppliers tracking Seattle's construction market.</p>
            <form id="leadForm" onsubmit="submitLead(event)">
                <div class="form-group">
                    <label for="lead-email">Email *</label>
                    <input id="lead-email" type="email" name="email" required placeholder="you@company.com">
                </div>
                <div class="form-group">
                    <label for="lead-company">Company Name *</label>
                    <input id="lead-company" type="text" name="company" required placeholder="Your Company">
                </div>
                <div class="form-group">
                    <label for="lead-interest">Interest Type *</label>
                    <select id="lead-interest" name="interest" required>
                        <option value="">Select...</option>
                        <option value="contractor">General Contractor</option>
                        <option value="subcontractor">Subcontractor</option>
                        <option value="supplier">Material Supplier</option>
                        <option value="service">Professional Services</option>
                        <option value="investor">Investor/Developer</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="lead-neighborhoods">Target Neighborhoods (optional)</label>
                    <input id="lead-neighborhoods" type="text" name="neighborhoods" placeholder="e.g., Capitol Hill, Ballard, Downtown">
                </div>
                <button type="submit" class="btn btn-primary" style="width:100%;">
                    <span id="submitText">Join Waitlist</span>
                    <span id="submitLoader" class="loader hidden"></span>
                </button>
            </form>
            <div id="formSuccess" class="hidden" style="text-align:center;padding:2rem;">
                <div style="font-size:3rem;margin-bottom:1rem;">&#10003;</div>
                <h4>You're on the list!</h4>
                <p style="color:var(--text-muted);">We'll reach out within 24 hours with access credentials.</p>
            </div>
        </div>
    </div>

    <script>
        function openModal() { document.getElementById('leadModal').classList.add('active'); var field = document.getElementById('lead-email'); if (field) field.focus(); }
        function closeModal() { document.getElementById('leadModal').classList.remove('active'); }
        document.getElementById('leadModal').addEventListener('click', function(e) { if (e.target === e.currentTarget) closeModal(); });
        document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });

        async function submitLead(e) {
            e.preventDefault();
            var form = e.target;
            var submitBtn = form.querySelector('button[type="submit"]');
            var loader = document.getElementById('submitLoader');
            var text = document.getElementById('submitText');
            text.classList.add('hidden');
            loader.classList.remove('hidden');
            submitBtn.disabled = true;
            var data = {
                email: form.email.value,
                company: form.company.value,
                interest: form.interest.value,
                neighborhoods: form.neighborhoods.value,
                source: 'homepage_modal',
                userAgent: navigator.userAgent
            };
            try {
                var response = await fetch('/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
                if (response.ok) {
                    form.style.display = 'none';
                    document.getElementById('formSuccess').classList.remove('hidden');
                } else {
                    throw new Error('Submission failed');
                }
            } catch (err) {
                alert('Error submitting form. Please try again.');
                text.classList.remove('hidden');
                loader.classList.add('hidden');
                submitBtn.disabled = false;
            }
        }
    </script>
    ${renderWebMcpScript()}
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" } });
}

async function handleLeadCapture(request, env) {
  const data = await request.json();

  if (!data.email || !data.company || !data.interest) {
    return new Response(JSON.stringify({ error: "Missing required fields" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const stmt = env.DB.prepare(`
        INSERT INTO leads (email, company, interest, neighborhoods, source, user_agent, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);

  await stmt
    .bind(
      data.email,
      data.company,
      data.interest,
      data.neighborhoods || null,
      data.source || "website",
      data.userAgent || null,
    )
    .run();

  return new Response(JSON.stringify({ success: true, id: crypto.randomUUID() }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleLeadBatch(request, env) {
  const { items } = await request.json();
  const results = [];

  for (const data of items) {
    try {
      const stmt = env.DB.prepare(`
                INSERT OR IGNORE INTO leads (email, company, interest, neighborhoods, source, created_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
            `);
      await stmt
        .bind(data.email, data.company, data.interest, data.neighborhoods || null, data.source || "batch")
        .run();
      results.push({ email: data.email, status: "success" });
    } catch (e) {
      results.push({ email: data.email, status: "error", error: e.message });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleAlertSubscription(request, env) {
  if (!env.EMAIL) {
    return alertJsonResponse({ error: "Permit alerts are temporarily unavailable" }, 503);
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return alertJsonResponse({ error: "Invalid JSON" }, 400);
  }

  const email = String(data.email || "").trim().toLowerCase();
  const permitNumber = String(data.permit_number || "").trim();
  if (!isValidEmail(email) || !permitNumber) {
    return alertJsonResponse({ error: "A valid email and permit number are required" }, 400);
  }

  const permit = await env.DB.prepare(
    "SELECT permit_number, address, status FROM permits WHERE permit_number = ?",
  )
    .bind(permitNumber)
    .first();
  if (!permit) {
    return alertJsonResponse({ error: "Permit not found" }, 404);
  }

  const existing = await env.DB.prepare(`
    SELECT *
    FROM permit_alert_subscriptions
    WHERE lower(email) = ? AND permit_number = ?
  `)
    .bind(email, permitNumber)
    .first();
  if (existing?.status === "active") {
    return alertJsonResponse({ success: true, status: "active" });
  }

  const confirmationToken = createAlertToken();
  const confirmationTokenHash = await hashAlertToken(confirmationToken);
  const unsubscribeToken = createAlertToken();

  await env.DB.prepare(`
    INSERT INTO permit_alert_subscriptions (
      email,
      permit_number,
      status,
      confirmation_token_hash,
      unsubscribe_token,
      confirmation_sent_at,
      created_at,
      updated_at
    )
    VALUES (?, ?, 'pending', ?, ?, datetime('now'), datetime('now'), datetime('now'))
    ON CONFLICT(email, permit_number) DO UPDATE SET
      status = 'pending',
      confirmation_token_hash = excluded.confirmation_token_hash,
      unsubscribe_token = excluded.unsubscribe_token,
      confirmation_sent_at = datetime('now'),
      confirmed_at = NULL,
      unsubscribed_at = NULL,
      updated_at = datetime('now')
  `)
    .bind(email, permitNumber, confirmationTokenHash, unsubscribeToken)
    .run();

  const confirmationUrl = `${BASE_URL}/alerts/confirm?token=${encodeURIComponent(confirmationToken)}`;
  try {
    await env.EMAIL.send({
      from: ALERT_EMAIL_FROM,
      to: email,
      subject: `Confirm permit alerts for ${permitNumber}`,
      text: [
        "Confirm your Building Seattle permit alert.",
        "",
        `${permitNumber}: ${permit.address || "Seattle permit"}`,
        `Current status: ${normalizeStoredStatus(permit.status)}`,
        "",
        `Confirm: ${confirmationUrl}`,
        "",
        "You will receive email only when this permit's recorded status changes.",
      ].join("\n"),
      html: `
        <h1>Confirm your permit alert</h1>
        <p><strong>${escapeHtml(permitNumber)}</strong>: ${escapeHtml(permit.address || "Seattle permit")}</p>
        <p>Current status: ${escapeHtml(normalizeStoredStatus(permit.status))}</p>
        <p><a href="${escapeHtml(confirmationUrl)}">Confirm permit alerts</a></p>
        <p>You will receive email only when this permit's recorded status changes.</p>
      `,
    });
  } catch (error) {
    await env.DB.prepare(`
      DELETE FROM permit_alert_subscriptions
      WHERE email = ?
        AND permit_number = ?
        AND confirmation_token_hash = ?
        AND status = 'pending'
    `)
      .bind(email, permitNumber, confirmationTokenHash)
      .run();
    console.error("Permit alert confirmation email failed:", error);
    return alertJsonResponse({ error: "Confirmation email could not be sent" }, 503);
  }

  return alertJsonResponse({ success: true, status: "pending_confirmation" }, 202);
}

async function handleAlertConfirmation(request, env) {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!token) {
    return renderAlertResult("Invalid confirmation link", "This confirmation link is missing its token.", 400);
  }

  const tokenHash = await hashAlertToken(token);
  const subscription = await env.DB.prepare(`
    SELECT *
    FROM permit_alert_subscriptions
    WHERE confirmation_token_hash = ? AND status = 'pending'
  `)
    .bind(tokenHash)
    .first();
  if (!subscription) {
    return renderAlertResult(
      "Confirmation link expired",
      "This link has already been used or is no longer valid. Return to the permit page to request a new one.",
      404,
    );
  }

  await env.DB.prepare(`
    UPDATE permit_alert_subscriptions
    SET
      status = 'active',
      confirmation_token_hash = NULL,
      confirmed_at = datetime('now'),
      unsubscribed_at = NULL,
      last_notified_change_id = (
        SELECT COALESCE(MAX(id), 0)
        FROM permit_status_changes
        WHERE permit_number = permit_alert_subscriptions.permit_number
      ),
      updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `)
    .bind(subscription.id)
    .run();

  return renderAlertResult(
    "Permit alert confirmed",
    `You will receive an email when permit ${subscription.permit_number} changes status.`,
  );
}

async function handleAlertUnsubscribe(request, env) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const subscription = token
    ? await env.DB.prepare(`
      SELECT *
      FROM permit_alert_subscriptions
      WHERE unsubscribe_token = ?
    `)
        .bind(token)
        .first()
    : null;

  if (!subscription) {
    return renderAlertResult("Invalid unsubscribe link", "This unsubscribe link is not valid.", 404);
  }

  await env.DB.prepare(`
    UPDATE permit_alert_subscriptions
    SET
      status = 'unsubscribed',
      confirmation_token_hash = NULL,
      unsubscribed_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `)
    .bind(subscription.id)
    .run();

  return renderAlertResult(
    "Permit alert stopped",
    `You will no longer receive status alerts for permit ${subscription.permit_number}.`,
  );
}

async function sendPendingPermitAlerts(env) {
  if (!env.EMAIL) {
    console.warn("Permit alert delivery skipped because the EMAIL binding is unavailable.");
    return { sent: 0, failed: 0 };
  }

  const { results } = await env.DB.prepare(`
    SELECT
      s.id AS subscription_id,
      s.email,
      s.permit_number,
      s.unsubscribe_token,
      sc.id AS change_id,
      sc.previous_status,
      sc.new_status,
      sc.changed_at,
      p.address
    FROM permit_alert_subscriptions s
    JOIN permit_status_changes sc
      ON sc.permit_number = s.permit_number
      AND sc.id > COALESCE(s.last_notified_change_id, 0)
    LEFT JOIN permits p ON p.permit_number = s.permit_number
    WHERE s.status = 'active'
    ORDER BY sc.id ASC
  `).all();

  let sent = 0;
  let failed = 0;
  for (const change of results || []) {
    const permitUrl = `${BASE_URL}/permits/${encodeURIComponent(change.permit_number)}`;
    const unsubscribeUrl = `${BASE_URL}/alerts/unsubscribe?token=${encodeURIComponent(change.unsubscribe_token)}`;
    const previousStatus = normalizeStoredStatus(change.previous_status);
    const newStatus = normalizeStoredStatus(change.new_status);

    try {
      await env.EMAIL.send({
        from: ALERT_EMAIL_FROM,
        to: change.email,
        subject: `Permit ${change.permit_number} changed to ${newStatus}`,
        text: [
          `Permit ${change.permit_number} changed status.`,
          "",
          `${previousStatus} -> ${newStatus}`,
          change.address || "Seattle permit",
          "",
          `View permit: ${permitUrl}`,
          `Unsubscribe from this permit: ${unsubscribeUrl}`,
        ].join("\n"),
        html: `
          <h1>Permit status changed</h1>
          <p><strong>${escapeHtml(change.permit_number)}</strong>: ${escapeHtml(change.address || "Seattle permit")}</p>
          <p>${escapeHtml(previousStatus)} &rarr; <strong>${escapeHtml(newStatus)}</strong></p>
          <p><a href="${escapeHtml(permitUrl)}">View permit details</a></p>
          <p><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe from this permit</a></p>
        `,
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });

      await env.DB.prepare(`
        UPDATE permit_alert_subscriptions
        SET
          last_notified_change_id = ?,
          last_notified_at = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `)
        .bind(change.change_id, change.changed_at, change.subscription_id)
        .run();
      sent++;
    } catch (error) {
      failed++;
      console.error(`Permit alert delivery failed for subscription ${change.subscription_id}:`, error);
    }
  }

  return { sent, failed };
}

function isValidEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function createAlertToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashAlertToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function alertJsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function renderAlertResult(title, message, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(title)} | Building Seattle</title>
  ${renderDesignTokens()}
</head>
<body>
  ${renderNav()}
  <div class="global-nav-spacer"></div>
  <main class="container" style="padding-top:4rem;padding-bottom:6rem;max-width:720px;">
    <h1 style="font-size:2rem;margin-bottom:1rem;color:var(--primary);">${escapeHtml(title)}</h1>
    <p style="color:var(--text-muted);font-size:1.05rem;margin-bottom:2rem;">${escapeHtml(message)}</p>
    <a href="/permits" style="color:var(--accent);font-weight:650;text-decoration:none;">Browse Seattle permits &rarr;</a>
  </main>
  ${renderFooter()}
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function getPermits(request, env) {
  const url = new URL(request.url);
  const permitNumber = url.searchParams.get("permit");
  const neighborhood = url.searchParams.get("neighborhood");
  const type = url.searchParams.get("type");
  const status = url.searchParams.get("status");
  const q = url.searchParams.get("q");
  const requestedPage = Number.parseInt(url.searchParams.get("page") || "1", 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 1000) : 1;
  const requestedPerPage = parseInt(url.searchParams.get("per_page") || "50", 10);
  const perPage = Math.max(1, Math.min(100, Number.isFinite(requestedPerPage) ? requestedPerPage : 50));
  const offset = (page - 1) * perPage;

  if (permitNumber) {
    return Response.redirect(new URL(`/permits/${encodeURIComponent(permitNumber)}`, url), 302);
  }

  let where = "WHERE 1=1";
  const params = [];

  if (neighborhood) {
    where += " AND p.neighborhood = ?";
    params.push(neighborhood);
  }
  if (type) {
    where += " AND p.type = ?";
    params.push(type);
  }
  if (status) {
    where += " AND p.status = ?";
    params.push(status);
  }
  if (q) {
    const like = "%" + q + "%";
    where +=
      " AND (p.address LIKE ? OR p.description LIKE ? OR p.permit_number LIKE ? OR p.neighborhood LIKE ? OR c.name LIKE ?)";
    params.push(like, like, like, like, like);
  }

  const listQuery = `SELECT p.*, c.name as contractor_name, c.slug as contractor_slug, c.specialty as contractor_specialty, c.phone as contractor_phone, c.email as contractor_email FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id ${where} ORDER BY p.issued_date DESC LIMIT ${perPage} OFFSET ${offset}`;
  const countQuery = `SELECT COUNT(*) as total FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id ${where}`;

  const [{ results }, { total }] = await Promise.all([
    env.DB.prepare(listQuery)
      .bind(...params)
      .all(),
    env.DB.prepare(countQuery)
      .bind(...params)
      .first(),
  ]);

  return new Response(JSON.stringify({ total, page, per_page: perPage, results: (results || []).slice(0, perPage) }), {
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
  });
}

async function getRecentStatusChanges(env, limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  try {
    const { results } = await env.DB.prepare(
      `
      SELECT
        sc.id,
        sc.permit_number,
        sc.previous_status,
        sc.new_status,
        sc.changed_at,
        p.address,
        p.neighborhood,
        p.type,
        p.value,
        p.issued_date,
        c.name as contractor_name,
        c.slug as contractor_slug
      FROM permit_status_changes sc
      LEFT JOIN permits p ON p.permit_number = sc.permit_number
      LEFT JOIN contractors c ON p.contractor_id = c.id
      ORDER BY sc.changed_at DESC, sc.id DESC
      LIMIT ${safeLimit}
    `,
    ).all();

    return results || [];
  } catch (error) {
    console.warn("Status change feed unavailable:", error.message);
    return [];
  }
}

async function getStatusChanges(request, env) {
  const url = new URL(request.url);
  const changes = await getRecentStatusChanges(env, url.searchParams.get("limit") || 20);

  return new Response(JSON.stringify({ total: changes.length, results: changes }), {
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
  });
}

function renderStatusChangeCards(changes) {
  if (!changes.length) {
    return '<div class="empty">No status changes have been recorded yet. Future ingests will populate this feed when a permit moves between statuses.</div>';
  }

  return changes
    .map((change) => {
      const changedAt = change.changed_at ? timeAgo(new Date(change.changed_at)) : "Recently";
      const previousStatus = escapeHtml(normalizeStoredStatus(change.previous_status));
      const newStatus = escapeHtml(normalizeStoredStatus(change.new_status));
      const address = escapeHtml(change.address || "Unknown address");
      const neighborhood = escapeHtml(change.neighborhood || "Seattle");
      const permitNumber = escapeHtml(change.permit_number);
      const type = escapeHtml(change.type || "General");
      const value = change.value ? `$${Number(change.value).toLocaleString()}` : "Value pending";

      return `<article class="change-card">
        <div>
          <div class="change-title"><a href="/permits/${encodeURIComponent(change.permit_number)}">${address}</a></div>
          <div class="change-meta">Permit ${permitNumber} &bull; ${neighborhood} &bull; ${type} &bull; ${value}</div>
        </div>
        <div class="change-status">
          <span class="status-pill muted">${previousStatus}</span>
          <span class="change-arrow">&rarr;</span>
          <span class="status-pill">${newStatus}</span>
          <span class="change-time">${escapeHtml(changedAt)}</span>
        </div>
      </article>`;
    })
    .join("");
}

async function renderPermitBrowser(request, env) {
  const url = new URL(request.url);
  const neighborhood = url.searchParams.get("neighborhood");
  const type = url.searchParams.get("type");
  const status = url.searchParams.get("status");
  const q = url.searchParams.get("q");
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const perPage = 50;
  const offset = (page - 1) * perPage;

  let where = "WHERE 1=1";
  const params = [];

  if (neighborhood) {
    where += " AND p.neighborhood = ?";
    params.push(neighborhood);
  }
  if (type) {
    where += " AND p.type = ?";
    params.push(type);
  }
  if (status) {
    where += " AND p.status = ?";
    params.push(status);
  }
  if (q) {
    const like = "%" + q + "%";
    where +=
      " AND (p.address LIKE ? OR p.description LIKE ? OR p.permit_number LIKE ? OR p.neighborhood LIKE ? OR c.name LIKE ?)";
    params.push(like, like, like, like, like);
  }

  const listQuery = `SELECT p.*, c.name as contractor_name, c.slug as contractor_slug, c.specialty as contractor_specialty FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id ${where} ORDER BY p.issued_date DESC LIMIT ${perPage} OFFSET ${offset}`;
  const countQuery = `SELECT COUNT(*) as total FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id ${where}`;

  const [
    { results: permits },
    { results: neighborhoods },
    { results: types },
    { results: statuses },
    { total: totalRaw },
    lastRun,
    recentStatusChanges,
  ] = await Promise.all([
    env.DB.prepare(listQuery)
      .bind(...params)
      .all(),
    env.DB.prepare(
      `SELECT DISTINCT neighborhood FROM permits WHERE neighborhood IS NOT NULL AND neighborhood != '' ORDER BY neighborhood ASC`,
    ).all(),
    env.DB.prepare(`SELECT DISTINCT type FROM permits WHERE type IS NOT NULL AND type != '' ORDER BY type ASC`).all(),
    env.DB.prepare(
      `SELECT DISTINCT status FROM permits WHERE status IS NOT NULL AND status != '' ORDER BY status ASC`,
    ).all(),
    env.DB.prepare(countQuery)
      .bind(...params)
      .first(),
    env.DB.prepare(`SELECT end_time FROM ingest_logs WHERE status = 'success' ORDER BY end_time DESC LIMIT 1`).first(),
    getRecentStatusChanges(env, 8),
  ]);
  const total = totalRaw || 0;
  const totalPages = Math.ceil(total / perPage);
  const lastUpdated = lastRun?.end_time ? timeAgo(new Date(lastRun.end_time)) : "Recently";

  if (wantsMarkdown(request)) {
    return markdownResponse(
      request,
      permitBrowserMarkdown({ permits, total, page, totalPages, neighborhood, type, status, q }),
    );
  }

  const neighborhoodOptions = neighborhoods
    .map(
      (item) =>
        `<option value="${escapeHtml(item.neighborhood)}"${item.neighborhood === neighborhood ? " selected" : ""}>${escapeHtml(item.neighborhood)}</option>`,
    )
    .join("");
  const typeOptions = types
    .map(
      (item) =>
        `<option value="${escapeHtml(item.type)}"${item.type === type ? " selected" : ""}>${escapeHtml(item.type)}</option>`,
    )
    .join("");
  const statusOptions = statuses
    .map(
      (item) =>
        `<option value="${escapeHtml(item.status)}"${item.status === status ? " selected" : ""}>${escapeHtml(item.status.charAt(0).toUpperCase() + item.status.slice(1))}</option>`,
    )
    .join("");
  const activeFilterDesc =
    [q ? `search: "${q}"` : null, neighborhood, type, status].filter(Boolean).join(", ") || "All permits";
  const approvedPermitParams = new Set(["page", "neighborhood", "type", "status", "q"]);
  const hasUnknownPermitParams = [...url.searchParams.keys()].some((key) => !approvedPermitParams.has(key));
  const rawPermitPage = url.searchParams.get("page");
  const hasInvalidPermitPage = rawPermitPage !== null && rawPermitPage !== String(page);
  const hasPermitFilters = Boolean(
    q || neighborhood || type || status || hasUnknownPermitParams || hasInvalidPermitPage,
  );
  const permitCanonical =
    !hasPermitFilters && page > 1 ? `${BASE_URL}/permits?page=${page}` : `${BASE_URL}/permits`;
  const recentChangeCards = renderStatusChangeCards(recentStatusChanges);
  const cards = permits
    .map((permit) => {
      const value = permit.value ? `$${Number(permit.value).toLocaleString()}` : "Value pending";
      const issued = permit.issued_date
        ? new Date(permit.issued_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "Date pending";
      const contractor = permit.contractor_slug
        ? `<a href="/contractor/${encodeURIComponent(permit.contractor_slug)}" style="color:var(--accent);text-decoration:none;font-weight:600;">${escapeHtml(permit.contractor_name || "View contractor")}</a>`
        : `<span style="color:var(--text-muted);">Contractor not linked yet</span>`;
      const address = escapeHtml(permit.address || "Unknown address");
      const permitNumber = escapeHtml(permit.permit_number);
      const neighborhoodLabel = escapeHtml(permit.neighborhood || "Seattle");
      const typeLabel = escapeHtml(permit.type || "General");
      const statusLabel = escapeHtml(permit.status || "new");
      const description = escapeHtml(permit.description || "No project description available yet.");

      return `<article class="permit-card">
        <div class="permit-card-top">
          <div>
            <div class="permit-address"><a href="/permits/${encodeURIComponent(permit.permit_number)}">${address}</a></div>
            <div class="permit-meta">${neighborhoodLabel} &bull; ${typeLabel} &bull; ${issued}</div>
          </div>
          <span class="status-pill">${statusLabel}</span>
        </div>
        <p class="permit-description">${description}</p>
        <div class="permit-footer">
          <div>
            <div class="permit-value">${value}</div>
            <div class="permit-number">Permit ${permitNumber}</div>
          </div>
          <div class="permit-contractor">${contractor}</div>
        </div>
      </article>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Browse Seattle Construction Permits | Building Seattle</title>
    <meta name="description" content="Browse active Seattle construction permits by neighborhood and permit type. Real-time intelligence for the Greater Seattle metro area.">
    <meta name="robots" content="${hasPermitFilters || total === 0 ? "noindex,follow" : "index,follow,max-image-preview:large"}">
    <link rel="canonical" href="${permitCanonical}">
    <meta property="og:title" content="Browse Seattle Construction Permits | Building Seattle">
    <meta property="og:description" content="Browse active Seattle construction permits by neighborhood and permit type.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${permitCanonical}">
    <meta name="twitter:card" content="summary">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
	    <meta property="og:image:width" content="1200">
	    <meta property="og:image:height" content="630">
	    <meta name="twitter:image" content="${BASE_URL}/og-image.png">
	    <link rel="icon" href="/favicon.ico" sizes="32x32" type="image/png">
	    <link rel="manifest" href="/site.webmanifest">
	    ${renderDesignTokens()}
	    <style>
        * { box-sizing: border-box; }
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-alt); color: var(--text); }
        .container { max-width: var(--container-max); margin: 0 auto; padding: 0 1.5rem; }
        .hero { padding: 3.5rem 0 2rem; }
        .hero h1 { margin: 0 0 0.75rem; font-size: clamp(2rem, 4vw, 3.25rem); line-height: 1.05; }
        .hero p { margin: 0; max-width: 720px; color: var(--text-muted); font-size: 1.05rem; }
        .filters { background: var(--surface); border: 1px solid var(--border); border-radius: 1rem; padding: 1rem; display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin: 2rem 0; }
	        label { display: block; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-bottom: 0.4rem; }
	        select, button, .secondary-link { width: 100%; border-radius: 0.75rem; border: 1px solid var(--border); padding: 0.8rem 0.9rem; font: inherit; }
	        button { background: var(--accent); color: white; font-weight: 700; cursor: pointer; border-color: var(--accent); }
	        .secondary-link { background: transparent; color: var(--text); text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
        .results-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1rem; }
        .results-head p { margin: 0; color: var(--text-muted); }
        .status-changes { margin: 0 0 2rem; }
        .status-changes-header { display: flex; justify-content: space-between; gap: 1rem; align-items: end; margin-bottom: 1rem; }
        .status-changes-header h2 { margin: 0; }
        .status-changes-header p { margin: 0.35rem 0 0; color: var(--text-muted); }
        .change-list { display: grid; gap: 0.75rem; }
        .change-card { background: var(--surface); border: 1px solid var(--border); border-radius: 1rem; padding: 1rem; display: flex; justify-content: space-between; align-items: center; gap: 1rem; box-shadow: 0 8px 30px rgba(15, 23, 42, 0.04); }
        .change-title a { color: var(--primary); text-decoration: none; font-size: 1rem; font-weight: 800; }
        .change-meta, .change-time { color: var(--text-muted); font-size: 0.85rem; }
        .change-status { display: flex; align-items: center; justify-content: flex-end; gap: 0.45rem; flex-wrap: wrap; min-width: 260px; }
        .change-arrow { color: var(--text-muted); font-weight: 800; }
        .permits { display: grid; gap: 1rem; padding-bottom: 3rem; }
        .permit-card { background: var(--surface); border: 1px solid var(--border); border-radius: 1rem; padding: 1.25rem; box-shadow: 0 8px 30px rgba(15, 23, 42, 0.04); }
        .permit-card-top, .permit-footer { display: flex; justify-content: space-between; align-items: start; gap: 1rem; }
        .permit-address a { color: var(--primary); text-decoration: none; font-size: 1.1rem; font-weight: 800; }
        .permit-meta, .permit-number, .permit-description { color: var(--text-muted); }
        .permit-description { margin: 0.85rem 0 1rem; line-height: 1.6; }
        .permit-value { font-size: 1.35rem; font-weight: 800; color: var(--primary); }
        .status-pill { background: rgba(37,99,235,0.12); color: var(--accent); border-radius: 999px; padding: 0.35rem 0.7rem; text-transform: capitalize; font-size: 0.8rem; font-weight: 700; }
        .status-pill.muted { background: rgba(100,116,139,0.12); color: var(--text-muted); }
        .empty { background: var(--surface); border: 1px dashed var(--border); border-radius: 1rem; padding: 2rem; text-align: center; color: var(--text-muted); }
        @media (max-width: 720px) {
          .permit-card-top, .permit-footer, .results-head, .status-changes-header, .change-card { flex-direction: column; align-items: stretch; }
          .change-status { justify-content: flex-start; min-width: 0; }
        }
    </style>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://buildingseattle.com/"},{"@type":"ListItem","position":2,"name":"Permits","item":"https://buildingseattle.com/permits"}]}</script>
</head>
<body>
    ${renderNav("permits")}
    <div class="global-nav-spacer"></div>
    <div class="container" style="padding-top:1.25rem;">
        <nav aria-label="breadcrumb" style="font-size:0.8125rem;color:var(--text-muted);">
            <a href="/" style="color:var(--text-muted);text-decoration:none;">Home</a> <span style="margin:0 0.4rem;">/</span> <span style="color:var(--text);font-weight:600;">Permits</span>
        </nav>
    </div>
    <main class="container">
        <section class="hero">
            <h1>Browse Seattle permits</h1>
            <p>Filter the live permit stream by neighborhood and permit type, then drill into the projects that matter to your team.</p>
        </section>
        <form class="filters" action="/permits" method="GET">
            <div>
                <label for="q">Search</label>
                <input type="text" id="q" name="q" value="${escapeHtml(q || "")}" placeholder="Address, permit #, contractor..." style="width:100%;border-radius:0.75rem;border:1px solid var(--border);padding:0.8rem 0.9rem;font:inherit;">
            </div>
            <div>
                <label for="neighborhood">Neighborhood</label>
                <select id="neighborhood" name="neighborhood">
                    <option value="">All neighborhoods</option>
                    ${neighborhoodOptions}
                </select>
            </div>
            <div>
                <label for="type">Permit Type</label>
                <select id="type" name="type">
                    <option value="">All permit types</option>
                    ${typeOptions}
                </select>
            </div>
            <div>
                <label for="status">Status</label>
                <select id="status" name="status">
                    <option value="">All statuses</option>
                    ${statusOptions}
                </select>
            </div>
            <div>
                <label>&nbsp;</label>
                <button type="submit">Apply Filters</button>
            </div>
            <div>
                <label>&nbsp;</label>
                <a class="secondary-link" href="/permits">Clear</a>
            </div>
        </form>
        <div class="results-head">
            <h2 style="margin:0;">${escapeHtml(activeFilterDesc)}</h2>
            <p>Updated ${lastUpdated}</p>
        </div>
        <section class="status-changes" aria-labelledby="status-changes-heading">
            <div class="status-changes-header">
                <div>
                    <h2 id="status-changes-heading">Recently changed status</h2>
                    <p>Permits that moved between statuses during the latest ingests.</p>
                </div>
                <a class="secondary-link" style="width:auto;padding:0.65rem 0.9rem;" href="/api/status-changes">JSON</a>
            </div>
            <div class="change-list">
                ${recentChangeCards}
            </div>
        </section>
        <section class="permits">
            ${cards || '<div class="empty">No permits matched these filters yet.</div>'}
        </section>
        ${totalPages > 1 ? renderPagination(url, page, totalPages, total, permits.length, offset) : ""}
    </main>
    ${renderFooter()}
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=600" },
  });
}

// Renders a permit's review journey as a stepped timeline card (pure: takes a
// permit row, returns an HTML string, or "" when there is nothing to show).
// Mirrors Seattle DCI's "Construction Permit Timeline" using fields we already
// store: total_days_plan_review is the headline "Plan Review Days, Total", and
// "City control" is that total minus the days the applicant held the permit for
// corrections (days_out_corrections) — matching SDCI's own methodology.
export function renderPermitTimeline(permit) {
  const fmtDate = (d) =>
    d
      ? new Date(d).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        })
      : null;
  const num = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const status = String(permit.status || "").toLowerCase();
  const applied = fmtDate(permit.applied_date);
  const reviewsDone = fmtDate(permit.plan_review_complete_date);
  const readyToIssue = fmtDate(permit.ready_to_issue_date);
  const issued = fmtDate(permit.issued_date);
  const completed = fmtDate(permit.completed_date);
  const expires = fmtDate(permit.expires_date);

  const totalDays = num(permit.total_days_plan_review);
  const corrections = num(permit.days_out_corrections);
  const cycles = num(permit.number_review_cycles);
  const cityDays =
    totalDays !== null && corrections !== null && totalDays - corrections >= 0 ? totalDays - corrections : null;

  const hasReview = totalDays !== null || corrections !== null || cycles !== null;
  const hasAnyDate = !!(applied || reviewsDone || readyToIssue || issued || completed || expires);
  if (!hasReview && !hasAnyDate) return "";

  // Milestone nodes in chronological order; "reached" controls the fill color.
  // "Reviews Done" / "Ready to Issue" are optional and only shown when SDCI has
  // supplied the date, so the bar stays clean for permits that lack them.
  const reviewDetail =
    cycles !== null ? `${cycles} cycle${cycles === 1 ? "" : "s"}` : applied && !issued ? "In progress" : null;
  const nodes = [
    { label: "Applied", detail: applied, reached: !!applied },
    { label: "In Review", detail: reviewDetail, reached: !!applied },
    ...(reviewsDone ? [{ label: "Reviews Done", detail: reviewsDone, reached: true }] : []),
    ...(readyToIssue ? [{ label: "Ready to Issue", detail: readyToIssue, reached: true }] : []),
    { label: "Issued", detail: issued, reached: !!issued },
    { label: "Completed", detail: completed, reached: !!completed },
    { label: "Expires", detail: expires, reached: !!expires },
  ];
  const nodesHtml = nodes
    .map((n) => {
      const detail = n.detail
        ? `<div class="timeline-date">${escapeHtml(n.detail)}</div>`
        : `<div class="timeline-date muted">&mdash;</div>`;
      return `<div class="timeline-node${n.reached ? " reached" : ""}"><div class="timeline-dot"></div><div class="timeline-label">${escapeHtml(
        n.label,
      )}</div>${detail}</div>`;
    })
    .join('<div class="timeline-bar"></div>');

  // Metrics strip — only cells that actually have data (like enrichmentFields).
  const metrics = [
    ["Plan Review Days — Total", totalDays],
    ["Plan Review Days — City Control", cityDays],
    ["Days in Applicant Control", corrections],
    ["Review Cycles", cycles],
  ].filter(([, v]) => v !== null);
  const metricsHtml = metrics.length
    ? `<div class="timeline-metrics">${metrics
        .map(
          ([label, v]) =>
            `<div class="timeline-metric"><div class="timeline-metric-value">${v.toLocaleString()}</div><div class="timeline-metric-label">${escapeHtml(
              label,
            )}</div></div>`,
        )
        .join("")}</div>`
    : "";

  // Conservative "next step" hint derived from status/dates (we do not have
  // per-cycle City-vs-applicant ownership, so wording stays modest).
  let nextStep = null;
  if (completed || status === "completed") nextStep = "All reviews complete — permit closed out.";
  else if (issued || status === "active") nextStep = "Permit issued — construction underway.";
  else if (readyToIssue) nextStep = "Plan review complete — ready to issue, awaiting final fees/issuance.";
  else if (applied) nextStep = "In City review — awaiting the next action.";
  const nextStepHtml = nextStep
    ? `<div class="timeline-next"><span class="timeline-next-label">Next step</span>${escapeHtml(nextStep)}</div>`
    : "";

  return `
                <div class="card card-full timeline-card">
                    <style>
                      .timeline{display:flex;flex-wrap:wrap;align-items:flex-start;gap:0.25rem;margin-top:1rem}
                      .timeline-node{display:flex;flex-direction:column;align-items:center;text-align:center;flex:1 1 90px;min-width:78px}
                      .timeline-bar{flex:1 1 18px;min-width:14px;height:2px;background:var(--border);margin-top:7px}
                      .timeline-dot{width:16px;height:16px;border-radius:50%;background:var(--bg-alt);border:2px solid var(--border)}
                      .timeline-node.reached .timeline-dot{background:var(--accent);border-color:var(--accent)}
                      .timeline-label{font-size:0.72rem;font-weight:700;margin-top:0.45rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.03em}
                      .timeline-node.reached .timeline-label{color:var(--primary)}
                      .timeline-date{font-size:0.8rem;color:var(--text);margin-top:0.15rem}
                      .timeline-date.muted{color:var(--text-muted)}
                      .timeline-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1rem;margin-top:1.5rem}
                      .timeline-metric{background:var(--bg-alt);border:1px solid var(--border);border-radius:0.5rem;padding:0.85rem 1rem;text-align:center}
                      .timeline-metric-value{font-size:1.5rem;font-weight:800;color:var(--accent);line-height:1.1}
                      .timeline-metric-label{font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-top:0.3rem}
                      .timeline-next{margin-top:1.25rem;font-size:0.9rem;color:var(--text)}
                      .timeline-next-label{display:inline-block;font-weight:700;color:var(--primary);margin-right:0.5rem;text-transform:uppercase;font-size:0.68rem;letter-spacing:0.05em}
                      .timeline-foot{margin-top:1rem;font-size:0.72rem;color:var(--text-muted);line-height:1.5}
                    </style>
                    <div class="card-label">Construction Permit Timeline</div>
                    <div class="timeline">${nodesHtml}</div>
                    ${metricsHtml}
                    ${nextStepHtml}
                    <div class="timeline-foot">Plan-review data from Seattle DCI. &ldquo;City control&rdquo; is total plan-review days minus the days the applicant held the permit for corrections.</div>
                </div>`;
}

async function renderPermitDetail(permitNumber, env, request) {
  const canonical = BASE_URL + "/permits/" + encodeURIComponent(permitNumber);
  // Prefer the entity-graph-enriched query; fall back gracefully if the graph
  // tables have not been migrated yet so permit pages never break.
  let results;
  try {
    ({ results } = await env.DB.prepare(
      `
    SELECT p.*,
           c.name as contractor_name,
           c.slug as contractor_slug,
           c.specialty as contractor_specialty,
           c.phone as contractor_phone,
           c.email as contractor_email,
           c.website as contractor_website,
           c.address as contractor_address,
           a.slug as address_slug,
           a.display_address as address_display,
           pr.slug as project_slug,
           pr.name as project_name
    FROM permits p
    LEFT JOIN contractors c ON p.contractor_id = c.id
    LEFT JOIN addresses a ON a.id = p.address_id
    LEFT JOIN projects pr ON pr.id = p.project_id
    WHERE p.permit_number = ?
  `,
    )
      .bind(permitNumber)
      .all());
  } catch {
    ({ results } = await env.DB.prepare(
      `
    SELECT p.*,
           c.name as contractor_name,
           c.slug as contractor_slug,
           c.specialty as contractor_specialty,
           c.phone as contractor_phone,
           c.email as contractor_email,
           c.website as contractor_website,
           c.address as contractor_address
    FROM permits p
    LEFT JOIN contractors c ON p.contractor_id = c.id
    WHERE p.permit_number = ?
  `,
    )
      .bind(permitNumber)
      .all());
  }

  if (results.length === 0) {
    return render404({
      heading: "Permit not found",
      message: `No permit matches "${permitNumber}". It may have been removed from the Seattle DCI feed or the number could be mistyped.`,
    });
  }

  const permit = results[0];

  // Derive neighborhood from address if it's "Other"
  let neighborhood = permit.neighborhood;
  if (!neighborhood || neighborhood === "Other") {
    const address = (permit.address || "").toLowerCase();
    // Downtown is roughly 1st-6th Ave between Yesler and Denny, without directional suffix
    const downtownAves = address.match(/\b([1-6])(st|nd|rd|th)\s+ave\b/);
    if (
      address.includes("downtown") ||
      address.includes("stewart") ||
      address.includes("pike") ||
      address.includes("pine") ||
      (downtownAves &&
        !address.includes("ave n") &&
        !address.includes("ave s") &&
        !address.includes("ave e") &&
        !address.includes("ave w"))
    ) {
      neighborhood = "Downtown";
    } else if (address.includes("ballard")) {
      neighborhood = "Ballard";
    } else if (address.includes("capitol hill")) {
      neighborhood = "Capitol Hill";
    } else if (address.includes("queen anne")) {
      neighborhood = "Queen Anne";
    } else if (address.includes("fremont")) {
      neighborhood = "Fremont";
    } else if (address.includes("wallingford")) {
      neighborhood = "Wallingford";
    } else if (address.includes("georgetown")) {
      neighborhood = "Georgetown";
    } else if (
      address.includes("south lake union") ||
      address.includes("slu") ||
      address.includes("dexter") ||
      address.includes("westlake")
    ) {
      neighborhood = "South Lake Union";
    } else if (address.includes("central district") || address.includes("23rd")) {
      neighborhood = "Central District";
    } else if (
      address.includes("ravenna") ||
      address.includes("ave ne") ||
      address.includes("2nd ave ne") ||
      address.includes("3rd ave ne") ||
      address.includes("25th ave ne")
    ) {
      neighborhood = "Ravenna";
    } else if (address.includes("university district") || address.includes("udistrict") || address.includes("ave ne")) {
      neighborhood = "University District";
    } else if (address.includes("green lake")) {
      neighborhood = "Green Lake";
    } else if (address.includes("magnolia")) {
      neighborhood = "Magnolia";
    } else if (address.includes("west seattle")) {
      neighborhood = "West Seattle";
    } else if (address.includes("columbia city")) {
      neighborhood = "Columbia City";
    } else if (address.includes("rainier")) {
      neighborhood = "Rainier Valley";
    } else if (
      address.includes("beacon hill") ||
      address.includes("beacon ave") ||
      address.includes("mcclellan") ||
      address.includes("holly") ||
      (address.includes("ave s") && address.match(/\b(1[0-9]|20)(st|nd|rd|th)\s+ave\s+s\b/))
    ) {
      neighborhood = "Beacon Hill";
    } else if (address.includes("first hill")) {
      neighborhood = "First Hill";
    } else if (address.includes("belltown")) {
      neighborhood = "Belltown";
    } else if (address.includes("leschi")) {
      neighborhood = "Leschi";
    } else if (address.includes("madrona")) {
      neighborhood = "Madrona";
    } else if (address.includes("sodo") || address.includes("s.odo")) {
      neighborhood = "SoDo";
    } else if (address.includes("beacon hill")) {
      neighborhood = "Beacon Hill";
    } else if (address.includes("international district") || address.includes("chinatown")) {
      neighborhood = "International District";
    } else {
      neighborhood = "Seattle";
    }
  }

  // Format permit type
  const typeMap = {
    commercial: "Commercial Construction",
    residential: "Residential Construction",
    industrial: "Industrial Construction",
    demolition: "Demolition",
    other: "General Construction",
    new: "New Construction",
    alteration: "Alteration/Repair",
    repair: "Repair",
  };
  const issuedDate = permit.issued_date
    ? new Date(permit.issued_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "N/A";

  const statusColors = {
    active: "#10b981",
    pending: "#f59e0b",
    completed: "#3b82f6",
    new: "#8b5cf6",
  };
  const statusColor = statusColors[permit.status] || "#64748b";
  const officialDetailUrl = safeHttpUrl(permit.permit_detail_url);
  const peopleCards = [
    permit.owner_name
      ? `
	                <div class="card">
	                    <div class="card-label">Property Owner</div>
	                    <div class="card-value">${escapeHtml(permit.owner_name)}</div>
	                    ${permit.owner_address ? `<div style="font-size: 0.875rem; color: var(--text-muted); margin-top: 0.25rem;">${escapeHtml(permit.owner_address)}</div>` : ""}
	                </div>
	      `
      : "",
    permit.applicant_name
      ? `
	                <div class="card">
	                    <div class="card-label">Applicant</div>
	                    <div class="card-value">${escapeHtml(permit.applicant_name)}</div>
	                </div>
      `
      : "",
    permit.architect_name
      ? `
	                <div class="card">
	                    <div class="card-label">Architect</div>
	                    <div class="card-value">${escapeHtml(permit.architect_name)}</div>
	                </div>
      `
      : "",
  ]
    .filter(Boolean)
    .join("");
  const enrichmentFields = [
    ["Work performed by", permit.work_performed_by],
    ["Contractor license", permit.contractor_license],
    ["Zoning", permit.zoning],
    ["Housing category", permit.housing_category],
    ["Dwelling type", permit.dwelling_unit_type],
    ["Review level", permit.review_level],
    ["Primary use", permit.primary_property_use],
    ["Parcel", permit.parcel_number],
    ["Parent permit", permit.parent_permit_number],
    ["Related land-use permit", permit.related_mup],
    ["Review cycles", permit.number_review_cycles],
    ["Plan review days", permit.total_days_plan_review],
    ["Days in corrections", permit.days_out_corrections],
    [
      "Expires",
      permit.expires_date
        ? new Date(permit.expires_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
        : null,
    ],
    ["Existing units", permit.housing_units_existing],
    ["Units added", permit.housing_units_added],
    ["Units removed", permit.housing_units_removed],
    ["Sleeping rooms", permit.sleeping_rooms],
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");
  const enrichmentCards = enrichmentFields.length
    ? `
                <div class="card card-full">
                    <div class="card-label">Permit Intelligence</div>
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1rem;margin-top:0.75rem;">
                        ${enrichmentFields
                          .map(
                            ([label, value]) => `
                        <div>
                            <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${label}</div>
                            <div style="font-size:1rem;font-weight:650;color:var(--primary);">${escapeHtml(value)}</div>
                        </div>`,
                          )
                          .join("")}
                    </div>
	                    ${officialDetailUrl ? `<div style="margin-top:1rem;"><a href="${escapeHtml(officialDetailUrl)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-weight:650;">Open official SDCI detail &rarr;</a></div>` : ""}
                </div>
      `
    : "";
  const primaryLeadLabel = "Email Me Permit Updates";
  const timelineCard = renderPermitTimeline(permit);

  const permitType =
    typeMap[(permit.type || "").toLowerCase()] ||
    (permit.type ? permit.type.charAt(0).toUpperCase() + permit.type.slice(1).toLowerCase() : "General Construction");
  const valueFormatted = permit.value ? `$${parseInt(permit.value).toLocaleString()}` : "N/A";
  const permitDescForMeta = permit.description ? ` ${String(permit.description).trim().replace(/\.$/, "")}.` : "";
  const metaDesc = truncateMetaDescription(`See ${permit.address || "Seattle"}: a ${permitType} project in ${neighborhood}. Value: ${valueFormatted}. Status: ${permit.status || "under review"}.${permitDescForMeta}${permit.contractor_name ? ` Contractor: ${permit.contractor_name}.` : ""}`);
  const safePermitNumber = escapeHtml(permit.permit_number);
  const serializedPermitNumber = JSON.stringify(String(permit.permit_number)).replace(/</g, "\\u003c");
  const safeAddress = escapeHtml(permit.address || "Unknown Address");
  const safeNeighborhood = escapeHtml(neighborhood);
  const safePermitType = escapeHtml(permitType);
  const safeStatus = escapeHtml(permit.status || "Unknown");
  const safeMetaDesc = escapeHtml(metaDesc);
  const safeTitleAddress = escapeHtml(permit.address || "Seattle");
  const safeDescription = escapeHtml(
    permit.detailed_description || permit.description || "No description available for this permit.",
  );
  const mapsQuery = encodeURIComponent(permit.address || "Seattle, WA");
  const permitJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Report",
        name: `Seattle construction permit ${permit.permit_number}`,
        headline: `${permitType} permit at ${permit.address || "Seattle"}`,
        description: metaDesc,
        url: canonical,
        identifier: permit.permit_number,
        dateCreated: dateOrNull(permit.applied_date) || undefined,
        datePublished: dateOrNull(permit.issued_date) || undefined,
        dateModified: dateOrNull(permit.updated_at || permit.last_enriched_at) || undefined,
        spatialCoverage: {
          "@type": "Place",
          name: permit.address || neighborhood || "Seattle, Washington",
          address: permit.address
            ? { "@type": "PostalAddress", streetAddress: permit.address, addressLocality: "Seattle", addressRegion: "WA" }
            : undefined,
        },
        about: [permitType, permit.status, neighborhood].filter(Boolean),
        isBasedOn: safeHttpUrl(permit.permit_detail_url || permit.source_url || permit.url) || "https://www.seattle.gov/sdci",
        provider: { "@type": "Organization", name: "Seattle Department of Construction and Inspections" },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Permits", item: `${BASE_URL}/permits` },
          { "@type": "ListItem", position: 3, name: `Permit ${permit.permit_number}`, item: canonical },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");

  // Links up into the entity graph (address / project / contractor / neighborhood).
  const neighborhoodSlug = permit.neighborhood ? makeSlug(permit.neighborhood) : makeSlug(neighborhood);
  const entityLinks = [
    permit.address_slug
      ? `<a href="/address/${encodeURIComponent(permit.address_slug)}" style="color:var(--accent);text-decoration:none;font-weight:600;">${escapeHtml(permit.address_display || permit.address)}</a> <span style="color:var(--text-muted);font-size:0.8rem;">Property</span>`
      : "",
    permit.project_slug
      ? `<a href="/project/${encodeURIComponent(permit.project_slug)}" style="color:var(--accent);text-decoration:none;font-weight:600;">${escapeHtml(permit.project_name)}</a> <span style="color:var(--text-muted);font-size:0.8rem;">Project</span>`
      : "",
    permit.contractor_slug
      ? `<a href="/contractor/${encodeURIComponent(permit.contractor_slug)}" style="color:var(--accent);text-decoration:none;font-weight:600;">${escapeHtml(permit.contractor_name)}</a> <span style="color:var(--text-muted);font-size:0.8rem;">Contractor</span>`
      : "",
    neighborhoodSlug
      ? `<a href="/neighborhood/${encodeURIComponent(neighborhoodSlug)}" style="color:var(--accent);text-decoration:none;font-weight:600;">${safeNeighborhood}</a> <span style="color:var(--text-muted);font-size:0.8rem;">Neighborhood</span>`
      : "",
  ].filter(Boolean);
  const entityLinksCard = entityLinks.length
    ? `<div class="card card-full">
                    <div class="card-label">Explore This Record</div>
                    <div style="display:flex;flex-wrap:wrap;gap:1.5rem;margin-top:0.5rem;">
                        ${entityLinks.map((l) => `<div>${l}</div>`).join("")}
                    </div>
                </div>`
    : "";

  if (wantsMarkdown(request)) {
    return markdownResponse(
      request,
      permitDetailMarkdown(permit, { neighborhood, permitType, valueFormatted, issuedDate, canonical }),
    );
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
	    <title>${safeTitleAddress} — ${safePermitType} (${safeStatus}) | Building Seattle</title>
	    <meta name="description" content="${safeMetaDesc}">
	    <meta name="robots" content="index,follow,max-image-preview:large">
	    <link rel="canonical" href="${canonical}">
	    <meta property="og:title" content="${safeTitleAddress} — ${safePermitType} (${safeStatus}) | Building Seattle">
	    <meta property="og:description" content="${safeMetaDesc}">
    <meta property="og:type" content="article">
    <meta property="og:url" content="${canonical}">
    <meta name="twitter:card" content="summary_large_image">
    <meta property="og:image" content="${BASE_URL}/social/permit.png">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:alt" content="${safeTitleAddress} | Building Seattle">
    <meta property="og:image:width" content="1200">
	    <meta property="og:image:height" content="630">
	    <meta name="twitter:image" content="${BASE_URL}/social/permit.png">
	    <link rel="icon" href="/favicon.ico" sizes="32x32" type="image/png">
	    <link rel="manifest" href="/site.webmanifest">
    ${renderDesignTokens()}
    <style>
        :root {
            --primary: #0f172a;
            --accent: #3b82f6;
            --accent-hover: #2563eb;
            --success: #10b981;
            --warning: #f59e0b;
            --bg: #ffffff;
            --bg-alt: #f8fafc;
            --text: #1e293b;
            --text-muted: #64748b;
            --border: #e2e8f0;
            --shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
            --shadow-lg: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
        }
        @media (prefers-color-scheme: dark) {
            :root {
                --primary: #f8fafc;
                --bg: #0f172a;
                --bg-alt: #1e293b;
                --text: #e2e8f0;
                --text-muted: #94a3b8;
                --border: #334155;
            }
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: var(--bg);
            color: var(--text);
            line-height: 1.6;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 0 1.5rem; }

        /* Main Content */
	        main { padding-top: 1.5rem; padding-bottom: 4rem; }

        /* Permit Header */
        .permit-header {
            background: var(--bg-alt);
            border: 1px solid var(--border);
            border-radius: 1rem;
            padding: 2rem;
            margin-bottom: 2rem;
        }
        .permit-number {
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 0.875rem;
            color: var(--text-muted);
            margin-bottom: 0.5rem;
        }
        .permit-title {
            font-size: 2rem;
            font-weight: 800;
            color: var(--primary);
            margin-bottom: 1rem;
            line-height: 1.2;
        }
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.5rem 1rem;
            border-radius: 9999px;
            font-size: 0.875rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: currentColor;
        }

        /* Grid Layout */
        .detail-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 1.5rem;
        }
        @media (min-width: 768px) {
            .detail-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (min-width: 1024px) {
            .detail-grid { grid-template-columns: repeat(3, 1fr); }
        }

        /* Cards */
        .card {
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 0.75rem;
            padding: 1.5rem;
            transition: all 0.2s;
        }
        .card:hover {
            box-shadow: var(--shadow);
            border-color: var(--accent);
        }
        .card-full {
            grid-column: 1 / -1;
        }
        @media (min-width: 1024px) {
            .card-full { grid-column: 1 / -1; }
        }
        .card-label {
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--text-muted);
            margin-bottom: 0.5rem;
        }
        .card-value {
            font-size: 1.125rem;
            font-weight: 600;
            color: var(--primary);
        }
        .card-value.large {
            font-size: 1.5rem;
            font-weight: 700;
        }

        /* Description Card */
        .description-card {
            background: var(--bg-alt);
            border-left: 4px solid var(--accent);
        }
        .description-text {
            font-size: 1rem;
            line-height: 1.7;
            color: var(--text);
        }

        /* Map Placeholder */
        .map-card {
            min-height: 300px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, var(--bg-alt) 0%, var(--border) 100%);
            position: relative;
            overflow: hidden;
        }
        .map-placeholder {
            text-align: center;
            color: var(--text-muted);
        }
        .map-icon {
            font-size: 3rem;
            margin-bottom: 1rem;
            opacity: 0.5;
        }

        /* Action Buttons */
        .actions {
            display: flex;
            gap: 1rem;
            margin-top: 2rem;
            flex-wrap: wrap;
        }
        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            padding: 0.875rem 1.5rem;
            border-radius: 0.5rem;
            font-weight: 600;
            font-size: 0.875rem;
            text-decoration: none;
            transition: all 0.2s;
            border: none;
            cursor: pointer;
        }
        .btn-primary {
            background: var(--accent);
            color: white;
        }
        .btn-primary:hover {
            background: var(--accent-hover);
            transform: translateY(-1px);
        }
        .btn-secondary {
            background: var(--bg-alt);
            color: var(--text);
            border: 1px solid var(--border);
        }
        .btn-secondary:hover {
            background: var(--border);
        }

        /* Footer */
	        footer {
	            background: var(--bg-alt);
	            border-top: 1px solid var(--border);
	            padding: 2rem 0;
	            text-align: center;
	            color: var(--text-muted);
	            font-size: 0.875rem;
	        }
	        .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; backdrop-filter: blur(4px); align-items: center; justify-content: center; }
	        .modal.active { display: flex; }
	        .modal-content { background: var(--bg); padding: 2rem; border-radius: 1rem; width: min(90vw, 500px); position: relative; box-shadow: var(--shadow-lg); }
	        .modal-close { position: absolute; top: 1rem; right: 1rem; background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted); }
	        .form-group { margin-bottom: 1.25rem; }
	        .form-group label { display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; color: var(--primary); }
	        .form-group input, .form-group select { width: 100%; padding: 0.75rem; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--bg); color: var(--text); font-size: 1rem; }
	        .hidden { display: none; }
	    </style>
	    <script type="application/ld+json">${permitJsonLd}</script>
</head>
<body>
    ${renderNav("permits")}
	    <div class="container" style="padding-top:5.25rem;">
        <nav aria-label="breadcrumb" style="font-size:0.8125rem;color:var(--text-muted);">
	            <a href="/" style="color:var(--text-muted);text-decoration:none;">Home</a> <span style="margin:0 0.4rem;">/</span> <a href="/permits" style="color:var(--text-muted);text-decoration:none;">Permits</a> <span style="margin:0 0.4rem;">/</span> <span style="color:var(--text);font-weight:600;">Permit ${safePermitNumber}</span>
        </nav>
    </div>

    <main>
        <div class="container">
            <div class="permit-header">
	                <div class="permit-number">PERMIT #${safePermitNumber}</div>
	                <h1 class="permit-title">${safeAddress}</h1>
	                <span class="status-badge" style="background: ${statusColor}20; color: ${statusColor};">
	                    <span class="status-dot"></span>
	                    ${safeStatus}
                </span>
            </div>
            <div class="detail-grid">
                <h2 class="card-full" style="font-size:1.5rem;font-weight:700;margin:1.5rem 0 0;color:var(--primary);grid-column:1/-1;">Permit Timeline &amp; Status</h2>
                ${timelineCard}
                ${entityLinksCard}
                <h2 class="card-full" style="font-size:1.5rem;font-weight:700;margin:1.5rem 0 0;color:var(--primary);grid-column:1/-1;">Project Overview</h2>
                <div class="card">
                    <div class="card-label">Project Details</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:0.75rem;">
                        <div><div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Value</div><div style="font-size:1.25rem;font-weight:800;color:var(--primary);">${valueFormatted}</div></div>
	                        <div><div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Type</div><div style="font-size:1rem;font-weight:600;color:var(--primary);">${safePermitType}</div></div>
	                        <div><div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Issued</div><div style="font-size:1rem;font-weight:600;color:var(--primary);">${issuedDate}</div></div>
	                        <div><div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Location</div><div style="font-size:1rem;font-weight:600;color:var(--primary);">${safeNeighborhood}</div></div>
                    </div>
                </div>

                <h2 class="card-full" style="font-size:1.5rem;font-weight:700;margin:1.5rem 0 0;color:var(--primary);grid-column:1/-1;">Contractor Information</h2>
                <div class="card">
                    <div class="card-label">Contractor</div>
                    ${
                      permit.contractor_slug
                        ? `
	                        <a class="card-value" style="display:block;color:var(--accent);margin-top:0.5rem;text-decoration:none;" href="/contractor/${encodeURIComponent(permit.contractor_slug)}">${escapeHtml(permit.contractor_name || "View Contractor")}</a>
	                        ${permit.contractor_specialty ? `<div style="font-size: 0.875rem; color: var(--text-muted); margin-top: 0.25rem;">${escapeHtml(permit.contractor_specialty)}</div>` : ""}
	                        ${permit.contractor_license ? `<div style="font-size: 0.8125rem; color: var(--text-muted); margin-top: 0.25rem;">License ${escapeHtml(permit.contractor_license)}</div>` : ""}
	                        ${permit.contractor_phone ? `<div style="font-size: 0.8125rem; color: var(--text-muted); margin-top: 0.25rem;">${escapeHtml(permit.contractor_phone)}</div>` : ""}
	                        ${permit.contractor_email ? `<div style="font-size: 0.8125rem; color: var(--text-muted); margin-top: 0.25rem;">${escapeHtml(permit.contractor_email)}</div>` : ""}
                    `
                        : `
	                        <div class="card-value" style="color: var(--text-muted); margin-top: 0.5rem;">${permit.work_performed_by === "Owner/Lessee" ? "Owner/Lessee" : "Not published by SDCI"}</div>
	                        ${permit.contractor_license ? `<div style="font-size: 0.8125rem; color: var(--text-muted); margin-top: 0.25rem;">License ${escapeHtml(permit.contractor_license)}</div>` : ""}
                    `
                    }
                    ${peopleCards}
                </div>

                <h2 class="card-full" style="font-size:1.5rem;font-weight:700;margin:1.5rem 0 0;color:var(--primary);grid-column:1/-1;">Location &amp; Map</h2>
                <div class="card" style="padding: 0; overflow: hidden;">
	                    <iframe width="100%" height="300" style="border: 0; display: block;" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade" src="https://maps.google.com/maps?q=${mapsQuery}&t=&z=17&ie=UTF8&iwloc=&output=embed"></iframe>
                    <div style="padding: 0.75rem 1rem; background: var(--bg-alt); border-top: 1px solid var(--border); display: flex; gap: 1rem; justify-content: center;">
	                        <a href="https://www.google.com/maps/search/?api=1&query=${mapsQuery}" target="_blank" rel="noopener" style="font-size: 0.8125rem; color: var(--accent); text-decoration: none; font-weight: 500;">Google Maps &rarr;</a>
	                        <a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${mapsQuery}" target="_blank" rel="noopener" style="font-size: 0.8125rem; color: var(--accent); text-decoration: none; font-weight: 500;">Street View &rarr;</a>
                    </div>
                </div>

                <div class="card card-full description-card">
                    <div class="card-label">Project Description</div>
	                    <div class="description-text">${safeDescription}</div>
                </div>
                <h2 class="card-full" style="font-size:1.5rem;font-weight:700;margin:1.5rem 0 0;color:var(--primary);grid-column:1/-1;">Additional Details</h2>
                ${enrichmentCards}
            </div>

            <div class="actions">
                <button class="btn btn-primary" onclick="openModal()">${primaryLeadLabel}</button>
                ${
                  permit.contractor_slug
                    ? `<a href="/contractor/${encodeURIComponent(permit.contractor_slug)}" class="btn btn-secondary">View Contractor</a>`
                    : `<a href="https://www.google.com/maps/search/?api=1&query=${mapsQuery}" target="_blank" rel="noopener" class="btn btn-secondary">Open Map</a>`
                }
            </div>
            </div>
        </div>
    </main>

    <div id="leadModal" class="modal" role="dialog" aria-modal="true" aria-labelledby="leadModalTitle" aria-describedby="leadModalDescription">
        <div class="modal-content">
            <button class="modal-close" onclick="closeModal()" aria-label="Close dialog">&times;</button>
            <h3 id="leadModalTitle" style="margin-bottom:0.5rem;">${primaryLeadLabel}</h3>
            <p id="leadModalDescription" style="color:var(--text-muted);margin-bottom:1.5rem;font-size:0.9rem;">Get an email when permit ${safePermitNumber} changes status.</p>
            <form id="leadForm" onsubmit="submitLead(event)">
                <div class="form-group">
                    <label for="lead-email">Email *</label>
                    <input id="lead-email" type="email" name="email" required autocomplete="email" placeholder="you@example.com">
                </div>
                <button type="submit" class="btn btn-primary" style="width:100%;">
                    <span id="submitText">Email Me Status Changes</span>
                    <span id="submitLoader" class="loader hidden"></span>
                </button>
            </form>
            <div id="formSuccess" class="hidden" style="text-align:center;padding:2rem;">
                <div style="font-size:3rem;margin-bottom:1rem;">&#10003;</div>
                <h4>Check your inbox to confirm</h4>
                <p style="color:var(--text-muted);">The alert starts after you confirm your email address.</p>
            </div>
        </div>
    </div>

    ${renderFooter()}
    <script>
        function openModal() { document.getElementById('leadModal').classList.add('active'); var field = document.getElementById('lead-email'); if (field) field.focus(); }
        function closeModal() { document.getElementById('leadModal').classList.remove('active'); }
        document.getElementById('leadModal').addEventListener('click', function(e) { if (e.target === e.currentTarget) closeModal(); });
        document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });

        async function submitLead(e) {
            e.preventDefault();
            var form = e.target;
            var submitBtn = form.querySelector('button[type="submit"]');
            var loader = document.getElementById('submitLoader');
            var text = document.getElementById('submitText');
            text.classList.add('hidden');
            loader.classList.remove('hidden');
            submitBtn.disabled = true;
            var data = {
                email: form.email.value,
                permit_number: ${serializedPermitNumber}
            };
            try {
                var response = await fetch('/alerts/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
                if (response.ok) {
                    form.style.display = 'none';
                    document.getElementById('formSuccess').classList.remove('hidden');
                } else {
                    var result = await response.json().catch(function() { return {}; });
                    throw new Error(result.error || 'Submission failed');
                }
            } catch (err) {
                alert(err.message || 'Error submitting form. Please try again.');
                text.classList.remove('hidden');
                loader.classList.add('hidden');
                submitBtn.disabled = false;
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" },
  });
}

async function getContractors(request, env) {
  const { results } = await env.DB.prepare(
    `
        SELECT c.*, COUNT(p.id) as active_projects 
        FROM contractors c
        LEFT JOIN permits p ON c.id = p.contractor_id AND p.status = 'active'
        GROUP BY c.id
        ORDER BY active_projects DESC
        LIMIT 20
    `,
  ).all();

  return new Response(JSON.stringify(results), {
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

async function getStats(env) {
  const [leads, permits, contractors, permitAggs] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as count FROM leads").first(),
    env.DB.prepare("SELECT COUNT(*) as count FROM permits").first(),
    env.DB.prepare("SELECT COUNT(*) as count FROM contractors").first(),
    env.DB.prepare(
      `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(value) as total_value,
        AVG(value) as avg_value
      FROM permits
    `,
    ).first(),
  ]);

  return new Response(
    JSON.stringify({
      leads: leads.count,
      permits: permits.count,
      contractors: contractors.count,
      active_permits: permitAggs.active || 0,
      total_value: permitAggs.total_value || 0,
      avg_value: permitAggs.avg_value || 0,
      timestamp: new Date().toISOString(),
    }),
    {
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
    },
  );
}

async function getAdminStats(env) {
  const [lastRun, growth24h, neighborhoods, performance, counts] = await Promise.all([
    env.DB.prepare("SELECT * FROM ingest_logs ORDER BY start_time DESC LIMIT 1").first(),
    env.DB.prepare(
      "SELECT SUM(records_added) as added FROM ingest_logs WHERE start_time > datetime('now', '-1 day')",
    ).first(),
    env.DB.prepare(
      `
      SELECT neighborhood, COUNT(*) as count 
      FROM permits 
      WHERE created_at > datetime('now', '-7 days')
      GROUP BY neighborhood 
      ORDER BY count DESC LIMIT 5
    `,
    ).all(),
    env.DB.prepare(
      `
      SELECT 
        AVG(strftime('%s', end_time) - strftime('%s', start_time)) as avg_duration,
        COUNT(CASE WHEN status = 'success' THEN 1 END) * 100.0 / COUNT(*) as success_rate
      FROM ingest_logs
    `,
    ).first(),
    env.DB.prepare(
      `
      SELECT 
        (SELECT COUNT(*) FROM permits) as permits,
        (SELECT COUNT(*) FROM contractors) as contractors,
        (SELECT COUNT(*) FROM leads) as leads
    `,
    ).first(),
  ]);

  return {
    last_run: lastRun,
    growth_24h: growth24h?.added || 0,
    hotspots: neighborhoods.results,
    performance: performance,
    total_counts: counts,
  };
}

async function renderAdminDashboard(request, env) {
  const stats = await getAdminStats(env);
  const [logs, leads] = await Promise.all([
    env.DB.prepare("SELECT * FROM ingest_logs ORDER BY start_time DESC LIMIT 20").all(),
    env.DB.prepare("SELECT * FROM leads ORDER BY created_at DESC LIMIT 50").all(),
  ]);

  const logRows = logs.results
    .map(
      (log) => `
	    <tr style="border-bottom: 1px solid var(--border);">
	      <td style="padding: 0.75rem;">${escapeHtml(log.start_time)}</td>
	      <td style="padding: 0.75rem; font-weight: 600;">${escapeHtml(log.run_type)}</td>
	      <td style="padding: 0.75rem;">
	        <span class="badge" style="background: ${log.status === "success" ? "#10b98120; color: #10b981" : "#ef444420; color: #ef4444"}">
	          ${escapeHtml(log.status)}
	        </span>
	      </td>
	      <td style="padding: 0.75rem;">+${Number(log.records_added || 0).toLocaleString()}</td>
	      <td style="padding: 0.75rem; font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(log.error_message || "None")}</td>
	    </tr>
	  `,
    )
    .join("");

  const leadRows =
    leads.results.length === 0
      ? '<tr><td colspan="6" style="padding: 2rem; text-align: center; color: var(--text-muted);">No leads captured yet.</td></tr>'
      : leads.results
          .map(
            (lead) => `
	    <tr style="border-bottom: 1px solid var(--border);">
	      <td style="padding: 0.75rem;">${escapeHtml(lead.created_at)}</td>
	      <td style="padding: 0.75rem; font-weight: 600;">${escapeHtml(lead.email)}</td>
	      <td style="padding: 0.75rem;">${escapeHtml(lead.company)}</td>
	      <td style="padding: 0.75rem;"><span class="badge" style="background: #eff6ff; color: #3b82f6;">${escapeHtml(lead.interest)}</span></td>
	      <td style="padding: 0.75rem; font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(lead.neighborhoods || "-")}</td>
	      <td style="padding: 0.75rem; font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(lead.source)}</td>
	    </tr>
	  `,
          )
          .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="robots" content="noindex, nofollow">
    <title>Admin Dashboard | Building Seattle</title>
    ${renderDesignTokens()}
    <style>
        body { margin: 0; background: var(--bg-alt); color: var(--text); }
        main { padding: 2rem 0; }
        h1, h2 { color: var(--primary); }
        h1 { font-size: 1.75rem; margin: 0 0 1.5rem; }
        h2 { font-size: 1.25rem; margin: 2rem 0 1rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
        .card { background: var(--surface); padding: 1.5rem; border-radius: var(--radius-md); border: 1px solid var(--border); box-shadow: var(--shadow-sm); }
        .label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: var(--text-muted); margin-bottom: 0.5rem; display: block; letter-spacing: 0.04em; }
        .value { font-size: 1.5rem; font-weight: 800; color: var(--primary); }
        .badge { padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.75rem; font-weight: 700; }
        table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--border); margin-bottom: 2rem; }
        th { text-align: left; padding: 1rem; background: var(--bg-alt); font-size: 0.875rem; color: var(--text-muted); }
    </style>
</head>
<body>
    ${renderNav()}
    <div class="global-nav-spacer"></div>
    <main>
      <div class="container">
          <h1>System Health</h1>
          <div class="grid">
              <div class="card"><span class="label">Last Run</span><div class="value">${stats.last_run?.status || "N/A"}</div></div>
              <div class="card"><span class="label">24h Growth</span><div class="value">+${stats.growth_24h}</div></div>
              <div class="card"><span class="label">Total Permits</span><div class="value">${stats.total_counts.permits}</div></div>
              <div class="card"><span class="label">Success Rate</span><div class="value">${Math.round(stats.performance?.success_rate || 0)}%</div></div>
          </div>

          <h2>Leads (${leads.results.length})</h2>
          <table>
              <thead><tr><th>Time</th><th>Email</th><th>Company</th><th>Interest</th><th>Neighborhoods</th><th>Source</th></tr></thead>
              <tbody>${leadRows}</tbody>
          </table>

          <h2>Recent Ingest Logs</h2>
          <table>
              <thead><tr><th>Time</th><th>Type</th><th>Status</th><th>Added</th><th>Errors</th></tr></thead>
              <tbody>${logRows}</tbody>
          </table>
      </div>
    </main>
    ${renderFooter()}
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

async function renderContractorPage(slug, env, request) {
  const canonical = BASE_URL + "/contractor/" + encodeURIComponent(slug);
  const contractor = await env.DB.prepare("SELECT * FROM contractors WHERE slug = ?").bind(slug).first();

  if (!contractor) {
    // Fall back to the people_orgs-backed page so /contractor/:slug resolves the
    // whole entity graph (owners, applicants, architects, and feed contractors).
    return renderOrgContractorPage(slug, env, request);
  }

  const [permits, metrics, marketFocus, projectTypes] = await Promise.all([
    env.DB.prepare("SELECT * FROM permits WHERE contractor_id = ? ORDER BY issued_date DESC LIMIT 10")
      .bind(contractor.id)
      .all(),
    env.DB.prepare(
      `
      SELECT
        AVG(JulianDay(issued_date) - JulianDay(applied_date)) as avg_permit_days,
        AVG(JulianDay(completed_date) - JulianDay(issued_date)) as avg_build_days,
        AVG(number_review_cycles) as avg_review_cycles,
        AVG(total_days_plan_review) as avg_plan_review_days,
        AVG(days_out_corrections) as avg_corrections_days,
        SUM(COALESCE(housing_units_added, 0)) as units_added,
        SUM(COALESCE(housing_units_removed, 0)) as units_removed,
        COUNT(*) as total_count,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count
      FROM permits
      WHERE contractor_id = ?
    `,
    )
      .bind(contractor.id)
      .first()
      .catch(() => ({
        avg_permit_days: null,
        avg_build_days: null,
        avg_review_cycles: null,
        avg_plan_review_days: null,
        avg_corrections_days: null,
        units_added: 0,
        units_removed: 0,
        total_count: 0,
        active_count: 0,
        completed_count: 0,
      })),
    env.DB.prepare(
      `
      SELECT neighborhood, COUNT(*) as count, SUM(value) as total_value
      FROM permits 
      WHERE contractor_id = ? AND neighborhood IS NOT NULL
      GROUP BY neighborhood 
      ORDER BY count DESC 
      LIMIT 3
    `,
    )
      .bind(contractor.id)
      .all(),
    env.DB.prepare(
      `
      SELECT type, COUNT(*) as count
      FROM permits 
      WHERE contractor_id = ? AND type IS NOT NULL
      GROUP BY type 
      ORDER BY count DESC
    `,
    )
      .bind(contractor.id)
      .all(),
  ]);

  // Entity-graph rollups (gracefully empty if the graph has not been built yet).
  const [graphAddresses, graphProjects] = await Promise.all([
    safeAll(
      env,
      `SELECT a.slug, a.display_address, COUNT(p.id) AS permits, COALESCE(SUM(p.value),0) AS total_value
       FROM permits p JOIN addresses a ON a.id = p.address_id
       WHERE p.contractor_id = ? GROUP BY a.id ORDER BY permits DESC LIMIT 12`,
      [contractor.id],
    ),
    safeAll(
      env,
      `SELECT DISTINCT pr.slug, pr.name, pr.latest_activity_date, pr.total_estimated_value
       FROM permits p JOIN projects pr ON pr.id = p.project_id
       WHERE p.contractor_id = ? ORDER BY pr.latest_activity_date DESC LIMIT 12`,
      [contractor.id],
    ),
  ]);

  const permitDays = metrics.avg_permit_days ? Math.round(metrics.avg_permit_days) : "—";
  const buildDays = metrics.avg_build_days ? Math.round(metrics.avg_build_days) : "—";
  const activeProjects = metrics.active_count || 0;
  const completionRate = metrics.total_count ? Math.round((metrics.completed_count / metrics.total_count) * 100) : 0;
  const reviewCycles = metrics.avg_review_cycles != null ? metrics.avg_review_cycles.toFixed(1) : "—";
  const planReviewDays = metrics.avg_plan_review_days != null ? Math.round(metrics.avg_plan_review_days) : "—";
  const correctionsDays = metrics.avg_corrections_days != null ? Math.round(metrics.avg_corrections_days) : "—";
  const netHousingUnits = (metrics.units_added || 0) - (metrics.units_removed || 0);

  if (wantsMarkdown(request)) {
    return markdownResponse(
      request,
      contractorMarkdown(contractor, { permits: permits.results || [], activeProjects, completionRate, canonical }),
    );
  }

  const licenseStatusRaw = contractor.license_status ? String(contractor.license_status).trim() : "";
  const licenseStatusUpper = licenseStatusRaw.toUpperCase();
  const licenseBadgeColor =
    licenseStatusUpper === "ACTIVE" ? "#10b981" : licenseStatusUpper === "EXPIRED" ? "#ef4444" : "#64748b";
  const insuranceFormatted =
    Number.isFinite(Number(contractor.insurance_amount)) && Number(contractor.insurance_amount) > 0
      ? `$${Number(contractor.insurance_amount).toLocaleString()}`
      : null;
  const insuranceExpiry = contractor.insurance_expires_date
    ? new Date(contractor.insurance_expires_date).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;
  const hasCredentials = Boolean(contractor.license_number || contractor.ubi || insuranceFormatted);
  const credentialsCard = hasCredentials
    ? `<div class="card">
	          <h3 style="margin-top:0">WA L&amp;I Credentials</h3>
	          ${
              licenseStatusRaw
                ? `<div style="display:inline-block;padding:0.25rem 0.75rem;border-radius:999px;background:${licenseBadgeColor};color:#fff;font-size:0.75rem;font-weight:700;letter-spacing:0.05em;margin-bottom:1rem">${escapeHtml(licenseStatusUpper)}</div>`
                : ""
            }
	          ${contractor.license_number ? `<p style="margin:0.5rem 0;font-size:0.9375rem"><span style="color:#64748b">License</span> <span style="font-weight:600;font-family:monospace">${escapeHtml(contractor.license_number)}</span></p>` : ""}
	          ${contractor.ubi ? `<p style="margin:0.5rem 0;font-size:0.9375rem"><span style="color:#64748b">UBI</span> <span style="font-weight:600;font-family:monospace">${escapeHtml(contractor.ubi)}</span></p>` : ""}
	          ${insuranceFormatted ? `<p style="margin:0.5rem 0;font-size:0.9375rem"><span style="color:#64748b">Insurance</span> <span style="font-weight:600">${escapeHtml(insuranceFormatted)}</span>${insuranceExpiry ? ` <span style="color:#94a3b8;font-size:0.8125rem">(through ${escapeHtml(insuranceExpiry)})</span>` : ""}</p>` : ""}
	          <p style="margin:1rem 0 0;font-size:0.75rem;color:#94a3b8">Verified via WA Labor &amp; Industries</p>
	        </div>`
    : "";
  const safeContractorName = escapeHtml(contractor.name);
  const safeContractorSpecialty = escapeHtml(contractor.specialty || "Contractor");
  const safeContractorDescription = escapeHtml(contractor.description || "Seattle area construction professional");
  const safeContractorMetaDescription = escapeHtml(
    `${contractor.name}: ${contractor.specialty || "Construction"} contractor in Seattle, WA. ${permits.results.length} permits, ${activeProjects} active. Permit timelines, review cycles & project history.`,
  );
  const contractorWebsite = safeHttpUrl(contractor.website);
  const contractorJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "LocalBusiness",
        name: contractor.name,
        description: contractor.specialty || "Construction contractor in Seattle",
        url: `${BASE_URL}/contractor/${encodeURIComponent(slug)}`,
        address: {
          "@type": "PostalAddress",
          addressLocality: "Seattle",
          addressRegion: "WA",
          addressCountry: "US",
        },
        knowsAbout: contractor.specialty || "Construction",
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Permits", item: `${BASE_URL}/permits` },
          {
            "@type": "ListItem",
            position: 3,
            name: contractor.name,
            item: `${BASE_URL}/contractor/${encodeURIComponent(slug)}`,
          },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
	    <title>${safeContractorName} — ${safeContractorSpecialty} | Seattle | Building Seattle</title>
	    <meta name="description" content="${safeContractorMetaDescription}">
	    <meta name="robots" content="index,follow,max-image-preview:large">
	    <link rel="canonical" href="${canonical}">
	    <meta property="og:title" content="${safeContractorName} — ${safeContractorSpecialty} | Seattle | Building Seattle">
	    <meta property="og:description" content="${safeContractorMetaDescription}">
    <meta property="og:type" content="profile">
    <meta property="og:url" content="${canonical}">
    <meta name="twitter:card" content="summary_large_image">
    <meta property="og:image" content="${BASE_URL}/social/contractor.png">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:alt" content="${safeContractorName} | Building Seattle">
	    <meta property="og:image:width" content="1200">
	    <meta property="og:image:height" content="630">
	    <meta name="twitter:image" content="${BASE_URL}/social/contractor.png">
	    <link rel="icon" href="/favicon.ico" sizes="32x32" type="image/png">
	    <link rel="manifest" href="/site.webmanifest">
    ${renderDesignTokens()}
    <style>
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;background:var(--bg-alt);color:var(--text)}
        .container{max-width:var(--container-max);margin:0 auto;padding:0 1.5rem}
        .seo-hero{background:linear-gradient(135deg,var(--primary) 0%,#1e293b 100%);color:white;padding:6rem 0 3rem;margin-top:4rem}
        .grid{display:grid;grid-template-columns:2fr 1fr;gap:3rem}
        .card{background:var(--surface);border-radius:var(--radius-lg);padding:2rem;box-shadow:var(--shadow-md);margin-bottom:2rem}
        .metric{text-align:center;padding:1.5rem;background:var(--bg-alt);border-radius:var(--radius-sm);border:1px solid var(--border)}
        .btn{background:var(--accent);color:white;padding:0.75rem 1.5rem;border-radius:var(--radius-sm);text-decoration:none;display:inline-flex;align-items:center;justify-content:center;font-weight:600;font-size:0.875rem;transition:background 0.2s}
        .btn:hover{background:var(--accent-hover)}
        @media(max-width:768px){.grid{grid-template-columns:1fr}}
    </style>
	    <script type="application/ld+json">${contractorJsonLd}</script>
</head>
<body>
    ${renderNav()}

    <div class="seo-hero">
        <div class="container">
            <nav aria-label="breadcrumb" style="font-size:0.8125rem;color:#94a3b8;margin-bottom:1rem;">
	                <a href="/" style="color:#94a3b8;text-decoration:none;">Home</a> <span style="margin:0 0.4rem;">/</span> <a href="/permits" style="color:#94a3b8;text-decoration:none;">Permits</a> <span style="margin:0 0.4rem;">/</span> <span style="color:#ffffff;font-weight:600;">${safeContractorName}</span>
            </nav>
            <div style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:2rem;">
                <div style="max-width:600px">
	                    <div style="color:#94a3b8;font-size:0.875rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem">${safeContractorSpecialty}</div>
	                    <h1 style="font-size:3rem;font-weight:800;margin:0 0 1rem 0">${safeContractorName}</h1>
	                    <p style="font-size:1.25rem;color:#94a3b8;margin:0">${safeContractorDescription}</p>
                </div>
                <div style="display:flex; gap:1.5rem;">
                    <div style="text-align:right">
                        <div style="font-size:0.75rem; color:#94a3b8; text-transform:uppercase; margin-bottom:0.25rem">Permit Speed</div>
                        <div style="font-size:1.5rem; font-weight:700;">${permitDays} <span style="font-size:0.875rem; font-weight:400; color:#94a3b8">days</span></div>
                    </div>
                    <div style="text-align:right">
                        <div style="font-size:0.75rem; color:#94a3b8; text-transform:uppercase; margin-bottom:0.25rem">Build Speed</div>
                        <div style="font-size:1.5rem; font-weight:700;">${buildDays} <span style="font-size:0.875rem; font-weight:400; color:#94a3b8">days</span></div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div class="container" style="padding:3rem 1.5rem">
        <div class="grid">
            <div>
                <div class="card">
                    <h2>About ${safeContractorName}</h2>
                    <p style="font-size:1rem;line-height:1.8;color:var(--text-muted);margin:0 0 1rem 0;">
                        ${safeContractorName} is ${contractor.specialty ? `a ${escapeHtml(contractor.specialty)}` : "a construction"} contractor operating in Seattle, Washington. 
                        Based on Seattle DCI permit records, this contractor has been involved in ${permits.results.length} permit${permits.results.length !== 1 ? "s" : ""} 
                        across Seattle's neighborhoods${activeProjects > 0 ? `, with ${activeProjects} currently active` : ""}. 
                        ${metrics.total_count > 0 ? `Permits by this contractor average ${permitDays} days from application to issuance, with an average of ${reviewCycles} review cycle${reviewCycles === "1.0" ? "" : "s"}.` : ""}
                    </p>
                    <p style="font-size:1rem;line-height:1.8;color:var(--text-muted);margin:0;">
                        ${contractor.description 
                          ? escapeHtml(contractor.description) 
                          : `Track ${contractor.name}'s Seattle construction projects including permit valuations, review timelines, and building activity across the city. Contractors listed on Building Seattle are drawn from public SDCI permit data and may include general contractors, subcontractors, and specialty trades.`}
                    </p>
                </div>
                <div class="card">
                    <h2>Projects (${permits.results.length})</h2>
                    ${permits.results
                      .map(
                        (p) => `
                        <div style="padding:1rem 0;border-bottom:1px solid #e2e8f0">
	                            <div style="font-weight:700"><a href="/permits/${encodeURIComponent(p.permit_number)}" style="color:inherit;text-decoration:none">${escapeHtml(p.address)}</a></div>
	                            <div style="font-size:0.875rem;color:#64748b">${escapeHtml(p.type || "Unknown")} &bull; $${(p.value || 0).toLocaleString()} &bull; ${escapeHtml(p.status)}</div>
                        </div>
                    `,
                      )
                      .join("")}
                </div>
                ${
                  graphAddresses.length || graphProjects.length
                    ? `<div class="card">
                    <h3 style="margin-top:0">Addresses &amp; Projects</h3>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-top:1rem;">
                      <div>
                        <div style="font-size:0.8rem;color:#64748b;margin-bottom:0.5rem;font-weight:600;">Addresses worked on</div>
                        ${
                          graphAddresses.length
                            ? graphAddresses
                                .map(
                                  (a) =>
                                    `<div style="margin-bottom:0.4rem;font-size:0.9rem;"><a href="/address/${encodeURIComponent(a.slug)}" style="color:#3b82f6;text-decoration:none;">${escapeHtml(a.display_address)}</a> <span style="color:#94a3b8;font-size:0.8rem;">· ${a.permits}</span></div>`,
                                )
                                .join("")
                            : '<div style="color:#94a3b8;font-size:0.85rem;">—</div>'
                        }
                      </div>
                      <div>
                        <div style="font-size:0.8rem;color:#64748b;margin-bottom:0.5rem;font-weight:600;">Inferred projects</div>
                        ${
                          graphProjects.length
                            ? graphProjects
                                .map(
                                  (pr) =>
                                    `<div style="margin-bottom:0.4rem;font-size:0.9rem;"><a href="/project/${encodeURIComponent(pr.slug)}" style="color:#3b82f6;text-decoration:none;">${escapeHtml(pr.name)}</a></div>`,
                                )
                                .join("")
                            : '<div style="color:#94a3b8;font-size:0.85rem;">—</div>'
                        }
                      </div>
                    </div>
                </div>`
                    : ""
                }
            </div>
            <div>
                ${credentialsCard}
                <div class="card">
                    <h3>Market Specialization</h3>
                    <div style="margin-top:1.5rem">
                        <div style="font-size:0.875rem; color:#64748b; margin-bottom:0.75rem">Top Neighborhoods</div>
                        ${marketFocus.results
                          .map(
                            (f) => `
                            <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem; font-size:0.9375rem">
	                                <span style="font-weight:600">${escapeHtml(f.neighborhood)}</span>
                                <span style="color:#64748b">${f.count} projects</span>
                            </div>
                        `,
                          )
                          .join("")}
                    </div>
                    <div style="margin-top:1.5rem; padding-top:1.5rem; border-top:1px solid #e2e8f0">
                        <div style="font-size:0.875rem; color:#64748b; margin-bottom:0.75rem">Project Composition</div>
                        <div style="display:flex; flex-wrap:wrap; gap:0.5rem">
                            ${projectTypes.results
                              .map(
                                (t) => `
	                                <span style="background:#eff6ff; color:#3b82f6; padding:0.25rem 0.75rem; border-radius:999px; font-size:0.75rem; font-weight:600; text-transform:capitalize">${escapeHtml(t.type)}</span>
                            `,
                              )
                              .join("")}
                        </div>
                    </div>
                </div>

                <div class="card" style="position:sticky;top:6rem">
                    <h3>Efficiency Metrics</h3>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem; margin:1.5rem 0">
                        <div class="metric">
                            <div style="font-size:1.5rem;font-weight:800;color:#3b82f6">${completionRate}%</div>
                            <div style="font-size:0.75rem;color:#64748b">Completion Rate</div>
                        </div>
                        <div class="metric">
                            <div style="font-size:1.5rem;font-weight:800;color:#3b82f6">${activeProjects}</div>
                            <div style="font-size:0.75rem;color:#64748b">Active Projects</div>
                        </div>
                        <div class="metric">
                            <div style="font-size:1.5rem;font-weight:800;color:#3b82f6">${reviewCycles}</div>
                            <div style="font-size:0.75rem;color:#64748b">Avg Review Cycles</div>
                        </div>
                        <div class="metric">
                            <div style="font-size:1.5rem;font-weight:800;color:#3b82f6">${planReviewDays}</div>
                            <div style="font-size:0.75rem;color:#64748b">Plan-Review Days</div>
                        </div>
                        <div class="metric">
                            <div style="font-size:1.5rem;font-weight:800;color:#3b82f6">${correctionsDays}</div>
                            <div style="font-size:0.75rem;color:#64748b">Days in Corrections</div>
                        </div>
                        <div class="metric">
                            <div style="font-size:1.5rem;font-weight:800;color:${netHousingUnits > 0 ? "#10b981" : netHousingUnits < 0 ? "#ef4444" : "#3b82f6"}">${netHousingUnits > 0 ? "+" : ""}${netHousingUnits}</div>
                            <div style="font-size:0.75rem;color:#64748b">Net Housing Units</div>
                        </div>
                    </div>

                    <div style="padding-top:1rem; border-top:1px solid #e2e8f0">
	                        ${contractor.phone ? `<p style="margin:0.5rem 0">Phone <span style="font-weight:500">${escapeHtml(contractor.phone)}</span></p>` : ""}
	                        ${contractor.email ? `<p style="margin:0.5rem 0">Email <span style="font-weight:500">${escapeHtml(contractor.email)}</span></p>` : ""}
	                        ${contractorWebsite ? `<p style="margin:0.5rem 0">Web <a href="${escapeHtml(contractorWebsite)}" target="_blank" rel="noopener" style="color:#3b82f6; text-decoration:none">${escapeHtml(contractorWebsite.replace("https://", "").replace("http://", ""))}</a></p>` : ""}
                    </div>
                </div>
            </div>
        </div>
    </div>
    ${renderFooter()}
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" } });
}

// ===========================================================================
// Entity graph: persistence + reporting
// ===========================================================================

const ENTITY_PERMIT_SELECT = `
  SELECT p.id, p.permit_number, p.address, p.neighborhood, p.type, p.value,
         p.status, p.description, p.detailed_description, p.applied_date,
         p.issued_date, p.completed_date, p.owner_name, p.applicant_name,
         p.architect_name, p.lat, p.lng, p.zip,
         c.name AS contractor_name
  FROM permits p
  LEFT JOIN contractors c ON p.contractor_id = c.id
  ORDER BY p.id
`;

async function runEntityBatch(env, statements) {
  const CHUNK = 50;
  for (let i = 0; i < statements.length; i += CHUNK) {
    await env.DB.batch(statements.slice(i, i + CHUNK));
  }
}

// Full rebuild of the derived entity graph from the permits table. Idempotent;
// safe to call after imports or on a schedule. Returns summary counts.
async function rebuildEntityGraph(env) {
  const { results: permits } = await env.DB.prepare(ENTITY_PERMIT_SELECT).all();
  const P = (sql) => env.DB.prepare(sql);

  // Preserve already-minted address/org slugs (keyed by their stable normalized
  // form) so existing entity URLs never change across rebuilds.
  const prevAddrRows = await safeAll(env, "SELECT normalized_address, slug FROM addresses");
  const prevOrgRows = await safeAll(env, "SELECT normalized_name, slug FROM people_orgs");
  const graph = buildEntityGraph(permits || [], {
    addressSlugByNorm: new Map(prevAddrRows.map((r) => [r.normalized_address, r.slug])),
    orgSlugByNorm: new Map(prevOrgRows.map((r) => [r.normalized_name, r.slug])),
  });

  // Clear derived tables and reset permit links (single transaction).
  await env.DB.batch([
    // Older production schemas enforce permits.address_id as a foreign key.
    // Clear those links before deleting the referenced graph rows.
    P("UPDATE permits SET address_id = NULL, project_id = NULL"),
    P("DELETE FROM project_permits"),
    P("DELETE FROM permit_participants"),
    P("DELETE FROM project_participants"),
    P("DELETE FROM address_neighborhoods"),
    P("DELETE FROM projects"),
    P("DELETE FROM neighborhoods"),
    P("DELETE FROM addresses"),
    P("DELETE FROM people_orgs"),
  ]);

  // addresses
  await runEntityBatch(
    env,
    graph.addresses.map((a) =>
      P(
        `INSERT INTO addresses (slug, normalized_address, display_address, city, state, zip, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(a.slug, a.normalized_address, a.display_address, a.city, a.state, a.zip, a.lat, a.lng),
    ),
  );
  const addrRows = (await P("SELECT id, normalized_address FROM addresses").all()).results;
  const addrIdByNorm = new Map(addrRows.map((r) => [r.normalized_address, r.id]));
  const addrIdByTmp = new Map(graph.addresses.map((a) => [a.tmpId, addrIdByNorm.get(a.normalized_address)]));

  // people_orgs
  await runEntityBatch(
    env,
    graph.peopleOrgs.map((o) =>
      P(`INSERT INTO people_orgs (slug, name, normalized_name, type_guess) VALUES (?, ?, ?, ?)`).bind(
        o.slug,
        o.name,
        o.normalized_name,
        o.type_guess,
      ),
    ),
  );
  const orgRows = (await P("SELECT id, normalized_name FROM people_orgs").all()).results;
  const orgIdByNorm = new Map(orgRows.map((r) => [r.normalized_name, r.id]));
  const orgIdByTmp = new Map(graph.peopleOrgs.map((o) => [o.tmpId, orgIdByNorm.get(o.normalized_name)]));

  // projects
  await runEntityBatch(
    env,
    graph.projects.map((p) =>
      P(
        `INSERT INTO projects (slug, address_id, name, description_summary, confidence_score, first_seen_date, latest_activity_date, total_estimated_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        p.slug,
        addrIdByTmp.get(p.addressTmpId) ?? null,
        p.name,
        p.description_summary,
        p.confidence_score,
        p.first_seen_date,
        p.latest_activity_date,
        p.total_estimated_value,
      ),
    ),
  );
  const projRows = (await P("SELECT id, slug FROM projects").all()).results;
  const projIdBySlug = new Map(projRows.map((r) => [r.slug, r.id]));
  const projIdByTmp = new Map(graph.projects.map((p) => [p.tmpId, projIdBySlug.get(p.slug)]));

  // neighborhoods
  await runEntityBatch(
    env,
    graph.neighborhoods.map((n) => P(`INSERT INTO neighborhoods (slug, name) VALUES (?, ?)`).bind(n.slug, n.name)),
  );
  const nbRows = (await P("SELECT id, slug FROM neighborhoods").all()).results;
  const nbIdBySlug = new Map(nbRows.map((r) => [r.slug, r.id]));
  const nbIdByTmp = new Map(graph.neighborhoods.map((n) => [n.tmpId, nbIdBySlug.get(n.slug)]));

  // join tables
  await runEntityBatch(
    env,
    graph.projects.flatMap((p) =>
      p.permitIds.map((pid) =>
        P(`INSERT OR IGNORE INTO project_permits (project_id, permit_id) VALUES (?, ?)`).bind(
          projIdBySlug.get(p.slug),
          pid,
        ),
      ),
    ),
  );
  await runEntityBatch(
    env,
    graph.permitParticipants.map((pp) =>
      P(`INSERT OR IGNORE INTO permit_participants (permit_id, people_org_id, role) VALUES (?, ?, ?)`).bind(
        pp.permit_id,
        orgIdByTmp.get(pp.orgTmpId),
        pp.role,
      ),
    ),
  );
  await runEntityBatch(
    env,
    graph.projectParticipants.map((pp) =>
      P(`INSERT OR IGNORE INTO project_participants (project_id, people_org_id, role) VALUES (?, ?, ?)`).bind(
        projIdByTmp.get(pp.projectTmpId),
        orgIdByTmp.get(pp.orgTmpId),
        pp.role,
      ),
    ),
  );
  await runEntityBatch(
    env,
    graph.addressNeighborhoods.map((an) =>
      P(`INSERT OR IGNORE INTO address_neighborhoods (address_id, neighborhood_id) VALUES (?, ?)`).bind(
        addrIdByTmp.get(an.addressTmpId),
        nbIdByTmp.get(an.nbTmpId),
      ),
    ),
  );

  // link permits back to their address + project
  const permitUpdates = [];
  for (const [permitId, addrTmp] of graph.permitAddress) {
    const projTmp = graph.permitProject.get(permitId);
    permitUpdates.push(
      P(`UPDATE permits SET address_id = ?, project_id = ? WHERE id = ?`).bind(
        addrIdByTmp.get(addrTmp) ?? null,
        projTmp != null ? projIdByTmp.get(projTmp) ?? null : null,
        permitId,
      ),
    );
  }
  await runEntityBatch(env, permitUpdates);

  return {
    ok: true,
    permits: permits.length,
    addresses: graph.addresses.length,
    people_orgs: graph.peopleOrgs.length,
    projects: graph.projects.length,
    permit_participants: graph.permitParticipants.length,
    neighborhoods: graph.neighborhoods.length,
  };
}

// Validation report: entity counts, orphans, and top lists. Returns plain JSON.
async function entityGraphReport(env) {
  const one = async (sql) => {
    try {
      return (await env.DB.prepare(sql).first()) || {};
    } catch {
      return {};
    }
  };
  const many = async (sql) => {
    try {
      return (await env.DB.prepare(sql).all()).results || [];
    } catch {
      return [];
    }
  };

  const [
    addresses,
    peopleOrgs,
    projects,
    permits,
    assigned,
    orphans,
    neighborhoods,
    topAddresses,
    topContractors,
    pagesByType,
  ] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM addresses`),
    one(`SELECT COUNT(*) AS n FROM people_orgs`),
    one(`SELECT COUNT(*) AS n FROM projects`),
    one(`SELECT COUNT(*) AS n FROM permits`),
    one(`SELECT COUNT(*) AS n FROM permits WHERE project_id IS NOT NULL`),
    one(`SELECT COUNT(*) AS n FROM permits WHERE project_id IS NULL`),
    one(`SELECT COUNT(*) AS n FROM neighborhoods`),
    many(
      `SELECT a.display_address, a.slug, COUNT(p.id) AS permits, COALESCE(SUM(p.value),0) AS total_value
       FROM addresses a JOIN permits p ON p.address_id = a.id
       GROUP BY a.id ORDER BY permits DESC, total_value DESC LIMIT 20`,
    ),
    many(
      `SELECT o.name, o.slug, COUNT(pp.permit_id) AS permits
       FROM people_orgs o JOIN permit_participants pp ON pp.people_org_id = o.id AND pp.role = 'contractor'
       GROUP BY o.id ORDER BY permits DESC LIMIT 20`,
    ),
    one(`SELECT (SELECT COUNT(*) FROM addresses) AS address_pages,
                (SELECT COUNT(*) FROM projects) AS project_pages,
                (SELECT COUNT(*) FROM people_orgs) AS contractor_pages,
                (SELECT COUNT(*) FROM neighborhoods) AS neighborhood_pages,
                (SELECT COUNT(*) FROM permits) AS permit_pages`),
  ]);

  const sitemapUrlCount =
    2 +
    (Number(permits.n) || 0) +
    (Number(addresses.n) || 0) +
    (Number(projects.n) || 0) +
    (Number(peopleOrgs.n) || 0) +
    (Number(neighborhoods.n) || 0);

  return {
    generated_at: new Date().toISOString(),
    counts: {
      addresses: Number(addresses.n) || 0,
      people_orgs: Number(peopleOrgs.n) || 0,
      projects: Number(projects.n) || 0,
      permits: Number(permits.n) || 0,
      permits_assigned_to_projects: Number(assigned.n) || 0,
      orphan_permits: Number(orphans.n) || 0,
      neighborhoods: Number(neighborhoods.n) || 0,
    },
    pages_by_type: pagesByType,
    sitemap_url_count: sitemapUrlCount,
    top_addresses_by_permit_count: topAddresses,
    top_contractors_by_permit_count: topContractors,
  };
}

// ===========================================================================
// Entity pages: addresses, projects, neighborhoods, people/orgs
// ===========================================================================

function entMoney(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? `$${Math.round(v).toLocaleString()}` : "N/A";
}

function entDate(d) {
  if (!d) return "N/A";
  const dt = new Date(d);
  return Number.isNaN(dt.getTime())
    ? String(d)
    : dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function entStreet(displayAddress) {
  return String(displayAddress || "").split(",")[0].trim() || String(displayAddress || "");
}

function entStyles() {
  return `<style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;background:var(--bg-alt);color:var(--text);line-height:1.6}
    .container{max-width:var(--container-max);margin:0 auto;padding:0 1.5rem}
    .ent-grid{display:grid;grid-template-columns:2fr 1fr;gap:2.5rem;align-items:start}
    @media(max-width:860px){.ent-grid{grid-template-columns:1fr}}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:1.75rem;box-shadow:var(--shadow-sm);margin-bottom:1.75rem}
    .card h2{font-size:1.25rem;margin:0 0 1rem}
    .card h3{font-size:1rem;margin:0 0 0.75rem}
    .metric{text-align:center;padding:1rem;background:var(--bg-alt);border-radius:var(--radius-sm);border:1px solid var(--border)}
    .stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:0.85rem;margin:1rem 0}
    .ent-list{list-style:none;margin:0;padding:0}
    .ent-list li{padding:0.75rem 0;border-bottom:1px solid var(--border)}
    .ent-list li:last-child{border-bottom:none}
    a.ent-link{color:var(--accent);text-decoration:none;font-weight:600}
    a.ent-link:hover{text-decoration:underline}
    table.ent{width:100%;border-collapse:collapse;font-size:0.875rem}
    table.ent th{text-align:left;color:var(--text-muted);font-weight:600;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;padding:0.5rem 0.75rem;border-bottom:1px solid var(--border)}
    table.ent td{padding:0.6rem 0.75rem;border-bottom:1px solid var(--border);vertical-align:top}
    .pill{display:inline-block;padding:0.15rem 0.6rem;border-radius:999px;font-size:0.7rem;font-weight:700;background:#eff6ff;color:#3b82f6;text-transform:capitalize}
    .ent-hero{margin-bottom:1.5rem}
    .ent-hero h1{font-size:2rem;font-weight:800;margin:0 0 0.5rem;color:var(--primary)}
    .ent-kicker{color:var(--text-muted);font-size:0.8rem;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:0.4rem}
  </style>`;
}

function entBreadcrumb(items) {
  const parts = items
    .map((it) =>
      it.href
        ? `<a href="${escapeHtml(it.href)}" style="color:var(--text-muted);text-decoration:none;">${escapeHtml(it.label)}</a>`
        : `<span style="color:var(--text);font-weight:600;">${escapeHtml(it.label)}</span>`,
    )
    .join(' <span style="margin:0 0.4rem;color:var(--text-subtle);">/</span> ');
  return `<nav aria-label="breadcrumb" style="font-size:0.8125rem;margin-bottom:1.5rem;">${parts}</nav>`;
}

function entStat(label, value) {
  return `<div class="metric"><div style="font-size:1.4rem;font-weight:800;color:var(--primary);">${value}</div><div style="font-size:0.72rem;color:var(--text-muted);margin-top:0.25rem;">${escapeHtml(label)}</div></div>`;
}

// Aggregates plan-review metrics across a project's clustered permits into a
// summary card (pure). Returns "" when no permit carries review data so the
// project page is unchanged for projects without it.
export function renderProjectReviewSummary(permits) {
  const rows = Array.isArray(permits) ? permits : [];
  const num = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  let totalDays = 0;
  let corrections = 0;
  let cycles = 0;
  let hasDays = false;
  let hasCorr = false;
  let hasCycles = false;
  let firstApplied = null;
  let lastDone = null;
  for (const p of rows) {
    const td = num(p.total_days_plan_review);
    if (td !== null) {
      totalDays += td;
      hasDays = true;
    }
    const dc = num(p.days_out_corrections);
    if (dc !== null) {
      corrections += dc;
      hasCorr = true;
    }
    const cy = num(p.number_review_cycles);
    if (cy !== null) {
      cycles += cy;
      hasCycles = true;
    }
    if (p.applied_date) {
      const d = new Date(p.applied_date);
      if (!Number.isNaN(d.getTime()) && (!firstApplied || d < firstApplied)) firstApplied = d;
    }
    for (const f of [p.completed_date, p.issued_date]) {
      if (!f) continue;
      const d = new Date(f);
      if (!Number.isNaN(d.getTime()) && (!lastDone || d > lastDone)) lastDone = d;
    }
  }
  if (!hasDays && !hasCorr && !hasCycles) return "";

  const cityDays = hasDays && hasCorr && totalDays - corrections >= 0 ? totalDays - corrections : null;
  const stats = [];
  if (firstApplied && lastDone) stats.push(entStat("Review span", `${entDate(firstApplied)} &rarr; ${entDate(lastDone)}`));
  if (hasDays) stats.push(entStat("Plan review days (total)", totalDays.toLocaleString()));
  if (cityDays !== null) stats.push(entStat("City control days", cityDays.toLocaleString()));
  if (hasCorr) stats.push(entStat("Applicant correction days", corrections.toLocaleString()));
  if (hasCycles) stats.push(entStat("Review cycles", cycles.toLocaleString()));

  return `
        <div class="card">
          <h2>Review timeline</h2>
          <div class="stat-row">${stats.join("")}</div>
          <p style="font-size:0.8rem;color:var(--text-muted);margin:0;">Plan-review metrics aggregated across this project's permits, from Seattle DCI. "City control days" is total plan-review days minus the days applicants held permits for corrections.</p>
        </div>`;
}

function renderEntityDoc({ title, description, canonical, jsonLd, noindex, ogType = "website", body, activeNav = "permits" }) {
  const metaDescription = truncateMetaDescription(description);
  const socialImage = `${BASE_URL}/social/${socialImageForCanonical(canonical)}.png`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(metaDescription)}">
    <meta name="robots" content="${noindex ? "noindex,follow" : "index,follow,max-image-preview:large"}">
    <link rel="canonical" href="${escapeHtml(canonical)}">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(metaDescription)}">
    <meta property="og:type" content="${ogType}">
    <meta property="og:url" content="${escapeHtml(canonical)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta property="og:image" content="${socialImage}">
    <meta property="og:image:secure_url" content="${socialImage}">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${escapeHtml(title)}">
    <meta name="twitter:image" content="${socialImage}">
    <meta name="twitter:image:alt" content="${escapeHtml(title)}">
    <link rel="icon" href="/favicon.ico" sizes="32x32" type="image/png">
    <link rel="manifest" href="/site.webmanifest">
    ${renderDesignTokens()}
    ${entStyles()}
    ${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ""}
</head>
<body>
    ${renderNav(activeNav)}
    <div class="global-nav-spacer"></div>
    <main class="container" style="padding:2rem 1.5rem 4rem;">
        ${body}
    </main>
    ${renderFooter()}
</body>
</html>`;
}

// Render a linked table of permit evidence rows.
function entPermitRows(permits) {
  if (!permits || permits.length === 0) {
    return `<p style="color:var(--text-muted);">No permits on record.</p>`;
  }
  const rows = permits
    .map(
      (p) => `<tr>
        <td><a class="ent-link" href="/permits/${encodeURIComponent(p.permit_number)}">${escapeHtml(p.permit_number)}</a></td>
        <td>${escapeHtml(p.type || "—")}</td>
        <td>${entMoney(p.value)}</td>
        <td><span class="pill">${escapeHtml(p.status || "—")}</span></td>
        <td>${entDate(p.issued_date || p.applied_date)}</td>
      </tr>`,
    )
    .join("");
  return `<table class="ent"><thead><tr><th>Permit</th><th>Type</th><th>Value</th><th>Status</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function latestPermitActivity(permits) {
  return (permits || [])
    .flatMap((permit) => [permit.updated_at, permit.issued_date, permit.applied_date, permit.created_at])
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

const ENTITY_HUB_PAGE_SIZE = 48;
const ACTIVE_PERMIT_SQL =
  "lower(COALESCE(p.status, '')) IN ('active', 'pending', 'new', 'in review', 'under review')";
export { buildEntityHubQuery, buildEntityHubState };

function boundedHubChoice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function buildEntityHubState(type, request) {
  const config = ENTITY_HUBS[type];
  const url = new URL(request.url);
  const rawPage = url.searchParams.get("page");
  const parsedPage = Number.parseInt(rawPage || "1", 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? Math.min(parsedPage, 1000) : 1;
  const sort = boundedHubChoice(url.searchParams.get("sort"), Object.keys(config.sortOptions), config.defaultSort);
  const activityOptions = type === "contractors"
    ? ["all", "active"]
    : type === "addresses"
      ? ["all", "recent90", "recent365"]
      : ["all"];
  const activity = boundedHubChoice(url.searchParams.get("activity"), activityOptions, "all");
  const view = type === "projects"
    ? boundedHubChoice(url.searchParams.get("view"), ["all", "active", "recent"], "all")
    : "all";
  const permitType = type === "contractors" ? String(url.searchParams.get("permit_type") || "").trim().slice(0, 80) : "";
  const neighborhood = ["contractors", "addresses"].includes(type)
    ? String(url.searchParams.get("neighborhood") || "").trim().slice(0, 80)
    : "";
  const minValue = boundedHubChoice(url.searchParams.get("min_value"), ["", "100000", "500000", "1000000", "5000000"], "");
  const minPermits = type === "addresses"
    ? boundedHubChoice(url.searchParams.get("min_permits"), ["", "2", "5", "10"], "")
    : "";
  const hasNonPaginationParams = [...url.searchParams.keys()].some((key) => key !== "page");
  const hasInvalidPage = rawPage !== null && rawPage !== String(page);
  const hasFilters = hasNonPaginationParams || hasInvalidPage;
  return { url, page, sort, activity, view, permitType, neighborhood, minValue, minPermits, hasFilters };
}

function buildEntityHubQuery(type, state) {
  const config = ENTITY_HUBS[type];
  const where = [];
  const havingParts = [];
  const binds = [];
  if (state.neighborhood) {
    where.push("p.neighborhood = ?");
    binds.push(state.neighborhood);
  }
  if (state.permitType) {
    where.push("p.type = ?");
    binds.push(state.permitType);
  }
  if (state.activity === "active" || state.view === "active") where.push(ACTIVE_PERMIT_SQL);
  if (state.activity === "recent90" || state.activity === "recent365") {
    const days = state.activity === "recent90" ? 90 : 365;
    where.push(`date(COALESCE(p.issued_date, p.applied_date, p.created_at)) >= date('now', '-${days} days')`);
  }
  if (state.view === "recent") {
    where.push("date(COALESCE(p.issued_date, p.applied_date, p.created_at)) >= date('now', '-365 days')");
  }
  if (state.minValue) {
    havingParts.push("COALESCE(SUM(p.value), 0) >= ?");
    binds.push(Number(state.minValue));
  }
  if (state.minPermits) {
    havingParts.push("COUNT(DISTINCT p.id) >= ?");
    binds.push(Number(state.minPermits));
  }
  const offset = (state.page - 1) * ENTITY_HUB_PAGE_SIZE;
  return {
    sql: `${config.selectSql}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ${config.groupSql}
      ${havingParts.length ? `HAVING ${havingParts.join(" AND ")}` : ""}
      ORDER BY ${config.sortOptions[state.sort]}, ${config.tiebreakSql} ASC
      LIMIT ${ENTITY_HUB_PAGE_SIZE + 1} OFFSET ${offset}`,
    binds,
  };
}

function hubUrl(type, state, page) {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (state.sort !== ENTITY_HUBS[type].defaultSort) params.set("sort", state.sort);
  if (state.activity !== "all") params.set("activity", state.activity);
  if (state.view !== "all") params.set("view", state.view);
  if (state.permitType) params.set("permit_type", state.permitType);
  if (state.neighborhood) params.set("neighborhood", state.neighborhood);
  if (state.minValue) params.set("min_value", state.minValue);
  if (state.minPermits) params.set("min_permits", state.minPermits);
  const query = params.toString();
  return `/${type}${query ? `?${query}` : ""}`;
}

function renderEntityHubFilters(type, state) {
  const selected = (actual, expected) => actual === expected ? " selected" : "";
  const sortOptions = Object.keys(ENTITY_HUBS[type].sortOptions)
    .map((value) => `<option value="${value}"${selected(state.sort, value)}>${escapeHtml(value === "permits" ? "Permit count" : value === "value" ? "Declared value" : "Latest activity")}</option>`)
    .join("");
  const contractorFilters = type === "contractors" ? `
      <label>Activity<select name="activity"><option value="all">All activity</option><option value="active"${selected(state.activity, "active")}>Active only</option></select></label>
      <label>Neighborhood<input name="neighborhood" value="${escapeHtml(state.neighborhood)}" maxlength="80" placeholder="e.g. Ballard"></label>
      <label>Permit type<input name="permit_type" value="${escapeHtml(state.permitType)}" maxlength="80" placeholder="Exact public type"></label>` : "";
  const projectFilters = type === "projects" ? `
      <label>View<select name="view"><option value="all">All time</option><option value="active"${selected(state.view, "active")}>Active</option><option value="recent"${selected(state.view, "recent")}>Recent 12 months</option></select></label>` : "";
  const addressFilters = type === "addresses" ? `
      <label>Neighborhood<input name="neighborhood" value="${escapeHtml(state.neighborhood)}" maxlength="80" placeholder="e.g. Ballard"></label>
      <label>Latest activity<select name="activity"><option value="all">Any time</option><option value="recent90"${selected(state.activity, "recent90")}>Past 90 days</option><option value="recent365"${selected(state.activity, "recent365")}>Past year</option></select></label>
      <label>Minimum permits<select name="min_permits"><option value="">Any</option><option value="2"${selected(state.minPermits, "2")}>2+</option><option value="5"${selected(state.minPermits, "5")}>5+</option><option value="10"${selected(state.minPermits, "10")}>10+</option></select></label>` : "";
  const valueFilter = ["contractors", "addresses"].includes(type) ? `
      <label>Minimum value<select name="min_value"><option value="">Any</option><option value="100000"${selected(state.minValue, "100000")}>$100K+</option><option value="500000"${selected(state.minValue, "500000")}>$500K+</option><option value="1000000"${selected(state.minValue, "1000000")}>$1M+</option><option value="5000000"${selected(state.minValue, "5000000")}>$5M+</option></select></label>` : "";
  return `<form method="get" action="/${type}" class="hub-filters">
      <label>Sort<select name="sort">${sortOptions}</select></label>
      ${contractorFilters}${projectFilters}${addressFilters}${valueFilter}
      <button type="submit">Apply</button>
      <a class="ent-link" href="/${type}">Reset</a>
    </form>`;
}

async function renderEntityHubPage(type, env, request) {
  const config = ENTITY_HUBS[type];
  if (!config) return render404();

  const state = buildEntityHubState(type, request);
  const query = buildEntityHubQuery(type, state);
  let items = [];
  try {
    const result = await env.DB.prepare(query.sql).bind(...query.binds).all();
    items = result.results || [];
  } catch (error) {
    // Graph migrations may briefly lag a deployment; keep the route available
    // but prevent an empty fallback from entering the index. Log it so a
    // permanently failing hub query is visible instead of silently empty.
    console.error(`entity-hub query failed for ${type}:`, error);
  }

  const hasNext = items.length > ENTITY_HUB_PAGE_SIZE;
  items = items.slice(0, ENTITY_HUB_PAGE_SIZE);
  const updatedThrough = items
    .map((item) => item.latest_activity)
    .filter(Boolean)
    .sort()
    .at(-1);
  const canonicalPath = state.hasFilters ? `/${type}` : hubUrl(type, state, state.page);
  const canonical = `${BASE_URL}${canonicalPath}`;
  const itemList = items.map((item, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: item.label,
    url: `${BASE_URL}${config.pathPrefix}${encodeURIComponent(item.slug)}`,
  }));
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "CollectionPage", name: config.title, description: config.description, url: canonical },
      { "@type": "ItemList", numberOfItems: items.length, itemListElement: itemList },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: config.title, item: canonical },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");
  const cards = items
    .map((item) => {
      const value = Number(item.total_value) > 0 ? entMoney(item.total_value) : "Value not reported";
      return `<article class="card">
        <h2 style="font-size:1.05rem;margin:0 0 0.4rem;"><a class="ent-link" href="${config.pathPrefix}${encodeURIComponent(item.slug)}">${escapeHtml(item.label)}</a></h2>
        <p style="margin:0 0 0.75rem;color:var(--text-muted);font-size:0.875rem;">${escapeHtml(item.detail || "Seattle construction activity")}</p>
        <div style="display:flex;gap:1rem;font-size:0.8rem;font-weight:650;"><span>${Number(item.permit_count || 0).toLocaleString()} permits</span><span>${value}</span></div>
      </article>`;
    })
    .join("");
  const pagination = `<nav aria-label="Pagination" style="display:flex;justify-content:space-between;gap:1rem;margin-top:1.5rem;">
      ${state.page > 1 ? `<a class="ent-link" rel="prev" href="${escapeHtml(hubUrl(type, state, state.page - 1))}">&larr; Previous</a>` : "<span></span>"}
      ${hasNext ? `<a class="ent-link" rel="next" href="${escapeHtml(hubUrl(type, state, state.page + 1))}">Next &rarr;</a>` : "<span></span>"}
    </nav>`;
  const body = `<style>
      .hub-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0.8rem;align-items:end;background:var(--surface);border:1px solid var(--border);border-radius:1rem;padding:1rem;margin:1.25rem 0}
      .hub-filters label{display:grid;gap:0.35rem;font-size:0.72rem;font-weight:750;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em}
      .hub-filters select,.hub-filters input,.hub-filters button{width:100%;border:1px solid var(--border);border-radius:.65rem;padding:.65rem;background:var(--bg);color:var(--text);font:inherit;text-transform:none;letter-spacing:normal}
      .hub-filters button{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:750;cursor:pointer}
    </style>
    <nav aria-label="Breadcrumb" style="font-size:0.8125rem;margin-bottom:1.25rem;"><a class="ent-link" href="/">Home</a> / ${escapeHtml(config.title)}</nav>
    <header style="max-width:800px;margin-bottom:2rem;"><p class="eyebrow">Explore Seattle construction</p><h1>${escapeHtml(config.title)}</h1><p style="font-size:1.08rem;color:var(--text-muted);line-height:1.7;">${escapeHtml(config.intro)}</p></header>
    ${renderEntityHubFilters(type, state)}
    ${items.length ? `<p style="color:var(--text-muted);">Page ${state.page}: showing ${items.length} ${config.itemLabel} from current public permit records.</p><section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1rem;">${cards}</section>${pagination}` : '<div class="card"><h2>No matching records</h2><p>Try removing a filter or return to the unfiltered index.</p></div>'}
    ${renderDataTrustNote(updatedThrough, "Hub rankings aggregate public permit records; declared value is not verified project cost.")}`;

  return new Response(
    renderEntityDoc({
      title: `${config.title} | Building Seattle`,
      description: config.description,
      canonical,
      jsonLd,
      noindex: items.length === 0 || state.hasFilters,
      body,
      activeNav: "explore",
    }),
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// ===========================================================================
// Plan review insights — distribution + breakdowns of how long Seattle's SDCI
// permit plan review actually takes, derived from the enrichment columns
// (total_days_plan_review, number_review_cycles, days_out_corrections).
// Pure stat helpers below are unit-tested via the exported chart/summary logic.
// ===========================================================================

const PLAN_REVIEW_DAY_BUCKETS = [
  { label: "0–30 days", min: 0, max: 30 },
  { label: "31–60 days", min: 31, max: 60 },
  { label: "61–90 days", min: 61, max: 90 },
  { label: "91–180 days", min: 91, max: 180 },
  { label: "181–365 days", min: 181, max: 365 },
  { label: "365+ days", min: 366, max: Infinity },
];

// Linear-interpolated percentile over an ascending-sorted numeric array.
export function percentileSorted(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Build the headline summary + day-bucket histogram from raw review-day values.
export function summarizePlanReview(values) {
  const sorted = values
    .filter((v) => v != null && v !== "")
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const count = sorted.length;
  const mean = count ? sorted.reduce((s, v) => s + v, 0) / count : 0;
  const histogram = PLAN_REVIEW_DAY_BUCKETS.map((b) => ({
    label: b.label,
    count: sorted.filter((v) => v >= b.min && v <= b.max).length,
  }));
  return {
    count,
    mean: Math.round(mean),
    median: Math.round(percentileSorted(sorted, 50)),
    p90: Math.round(percentileSorted(sorted, 90)),
    max: count ? sorted[count - 1] : 0,
    histogram,
  };
}

// Median/mean/p90/count over an array of day counts (drops nulls and negatives).
export function summarizeDays(values) {
  const sorted = values
    .filter((v) => v != null && v !== "")
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const count = sorted.length;
  const mean = count ? sorted.reduce((s, v) => s + v, 0) / count : 0;
  return {
    count,
    mean: Math.round(mean),
    median: Math.round(percentileSorted(sorted, 50)),
    p90: Math.round(percentileSorted(sorted, 90)),
  };
}

// Sum added/removed housing units across bucket rows of { added, removed }.
export function summarizeNetHousing(rows) {
  let added = 0;
  let removed = 0;
  for (const r of rows || []) {
    added += Number(r.added) || 0;
    removed += Number(r.removed) || 0;
  }
  return { added, removed, net: added - removed };
}

// Pull every input the plan-review insights need. Degrades to empty arrays via
// safeAll/safeFirst so the page and API still render when columns are unenriched.
async function getPlanReviewData(env) {
  const reviewedWhere =
    "total_days_plan_review IS NOT NULL AND total_days_plan_review >= 0";

  const [rawDays, byType, byNeighborhood, byCycles, byReviewLevel, cyclesAvg] = await Promise.all([
    safeAll(
      env,
      `SELECT total_days_plan_review AS d FROM permits WHERE ${reviewedWhere} ORDER BY d ASC`,
    ),
    safeAll(
      env,
      `SELECT COALESCE(NULLIF(type,''),'unknown') AS label, COUNT(*) AS cnt,
              AVG(total_days_plan_review) AS avg_days, AVG(number_review_cycles) AS avg_cycles
       FROM permits WHERE ${reviewedWhere} GROUP BY label ORDER BY cnt DESC`,
    ),
    safeAll(
      env,
      `SELECT COALESCE(NULLIF(neighborhood,''),'Unknown') AS label, COUNT(*) AS cnt,
              AVG(total_days_plan_review) AS avg_days,
              MAX((SELECT n.slug FROM neighborhoods n
                   WHERE lower(trim(n.name)) = lower(trim(permits.neighborhood)) LIMIT 1)) AS slug
       FROM permits WHERE ${reviewedWhere}
       GROUP BY label HAVING cnt >= 3 ORDER BY avg_days DESC LIMIT 12`,
    ),
    safeAll(
      env,
      `SELECT number_review_cycles AS cycles, COUNT(*) AS cnt
       FROM permits WHERE number_review_cycles IS NOT NULL AND number_review_cycles >= 0
       GROUP BY cycles ORDER BY cycles ASC LIMIT 15`,
    ),
    safeAll(
      env,
      `SELECT COALESCE(NULLIF(review_level,''),'Unknown') AS label, COUNT(*) AS cnt,
              AVG(total_days_plan_review) AS avg_days
       FROM permits WHERE ${reviewedWhere} GROUP BY label ORDER BY cnt DESC LIMIT 8`,
    ),
    safeFirst(
      env,
      `SELECT AVG(number_review_cycles) AS avg_cycles, AVG(days_out_corrections) AS avg_corrections
       FROM permits WHERE number_review_cycles IS NOT NULL AND number_review_cycles >= 0`,
    ),
  ]);

  const summary = summarizePlanReview(rawDays.map((r) => r.d));
  return {
    summary,
    avg_cycles: cyclesAvg && cyclesAvg.avg_cycles != null ? Number(cyclesAvg.avg_cycles) : null,
    avg_days_out_corrections:
      cyclesAvg && cyclesAvg.avg_corrections != null ? Number(cyclesAvg.avg_corrections) : null,
    by_type: byType.map((r) => ({
      label: r.label,
      count: Number(r.cnt) || 0,
      avg_days: Math.round(Number(r.avg_days) || 0),
      avg_cycles: r.avg_cycles != null ? Number(Number(r.avg_cycles).toFixed(1)) : null,
    })),
    by_neighborhood: byNeighborhood.map((r) => ({
      label: r.label,
      slug: r.slug || null,
      count: Number(r.cnt) || 0,
      avg_days: Math.round(Number(r.avg_days) || 0),
    })),
    by_cycles: byCycles.map((r) => ({ cycles: Number(r.cycles) || 0, count: Number(r.cnt) || 0 })),
    by_review_level: byReviewLevel.map((r) => ({
      label: r.label,
      count: Number(r.cnt) || 0,
      avg_days: Math.round(Number(r.avg_days) || 0),
    })),
  };
}

async function getPlanReviewStats(env) {
  const data = await getPlanReviewData(env);
  return new Response(JSON.stringify({ ...data, timestamp: new Date().toISOString() }), {
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

// Shared CSS for every /insights page (CSP-safe inline styles, no external CSS).
function insightsStyles() {
  return `<style>
      .pr-chart{display:flex;flex-direction:column;gap:0.55rem}
      .pr-row{display:grid;grid-template-columns:minmax(90px,160px) 1fr auto;align-items:center;gap:0.85rem}
      .pr-label{font-size:0.8rem;color:var(--text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pr-track{background:var(--bg-alt);border:1px solid var(--border);border-radius:999px;height:0.85rem;overflow:hidden}
      .pr-fill{height:100%;border-radius:999px;min-width:2px;transition:width .3s ease}
      .pr-val{font-size:0.8rem;font-weight:700;color:var(--primary);white-space:nowrap}
      .pr-sub{font-weight:500;color:var(--text-muted);font-size:0.72rem}
      .pr-note{font-size:0.78rem;color:var(--text-muted);margin-top:1rem}
      .ins-tabs{display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:1.5rem}
      .ins-tab{padding:0.4rem 0.9rem;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--text);text-decoration:none;font-size:0.82rem;font-weight:600}
      .ins-tab.active{background:var(--accent);border-color:var(--accent);color:#fff}
      .ins-card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1.25rem}
      .ins-feature{display:block;text-decoration:none;color:inherit}
      .ins-feature .card{height:100%;margin:0;transition:box-shadow .2s ease,transform .2s ease}
      .ins-feature:hover .card{box-shadow:var(--shadow);transform:translateY(-2px)}
      .nb-contractor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem;margin-top:1rem}
      .nb-contractor-card{border:1px solid var(--border);border-radius:16px;background:var(--bg);padding:1rem}
      .nb-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--border);padding-bottom:0.75rem;margin-bottom:0.75rem}
      .nb-card-head h3{margin:0;font-size:1rem;color:var(--text)}
      .nb-card-head span{color:var(--text-muted);font-size:0.78rem;font-weight:700;white-space:nowrap}
      .nb-contractor-card ol{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:0.55rem}
      .nb-contractor-row{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:0.6rem;font-size:0.84rem}
      .nb-rank{display:inline-flex;align-items:center;justify-content:center;width:1.45rem;height:1.45rem;border-radius:999px;background:rgba(59,130,246,0.12);color:var(--accent);font-weight:800;font-size:0.72rem}
      .nb-count{color:var(--text-muted);font-size:0.76rem;font-weight:700;white-space:nowrap}
      .nb-empty{color:var(--text-muted);font-size:0.84rem}
      @media(max-width:560px){.pr-row{grid-template-columns:minmax(72px,110px) 1fr auto;gap:0.5rem}.nb-contractor-grid{grid-template-columns:1fr}.nb-contractor-row{grid-template-columns:auto 1fr}.nb-count{grid-column:2;white-space:normal}}
  </style>`;
}

// Pill tab bar linking the insights pages; `active` highlights the current one.
function insightsTabs(active) {
  const tabs = [
    { key: "plan-review", label: "Plan Review", href: "/insights/plan-review" },
    { key: "pipeline", label: "Pipeline", href: "/insights/pipeline" },
    { key: "housing", label: "Housing", href: "/insights/housing" },
    { key: "adu-dadu", label: "ADU / DADU", href: "/insights/adu-dadu" },
    { key: "multifamily", label: "Multifamily", href: "/insights/multifamily-pipeline" },
    { key: "commercial", label: "Commercial", href: "/insights/commercial-projects" },
    { key: "tenant-improvements", label: "Tenant Improvements", href: "/insights/tenant-improvements" },
    { key: "map", label: "Map", href: "/insights/map" },
    { key: "contractors", label: "Contractors", href: "/insights/contractors" },
    { key: "network", label: "Network", href: "/insights/network" },
  ];
  return `<div class="ins-tabs">${tabs
    .map((t) => `<a class="ins-tab${t.key === active ? " active" : ""}" href="${t.href}">${escapeHtml(t.label)}</a>`)
    .join("")}</div>`;
}

// Server-rendered horizontal bar chart (CSP-safe: no external JS/CDN). `rows`
// are { label, value, display, sub }; bars are scaled to the largest value.
function prBarChart(rows, accent = "var(--accent)") {
  if (!rows || rows.length === 0) {
    return `<p style="color:var(--text-muted);">Not enough enriched data yet.</p>`;
  }
  const max = Math.max(...rows.map((r) => Number(r.value) || 0), 0);
  return `<div class="pr-chart">${rows
    .map((r) => {
      const v = Number(r.value) || 0;
      const pct = max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0;
      return `<div class="pr-row">
        <div class="pr-label" title="${escapeHtml(r.label)}">${r.href ? `<a class="ent-link" href="${escapeHtml(r.href)}">${escapeHtml(r.label)}</a>` : escapeHtml(r.label)}</div>
        <div class="pr-track"><div class="pr-fill" style="width:${pct}%;background:${accent};"></div></div>
        <div class="pr-val">${escapeHtml(r.display != null ? String(r.display) : String(v))}${
          r.sub ? `<span class="pr-sub"> · ${escapeHtml(r.sub)}</span>` : ""
        }</div>
      </div>`;
    })
    .join("")}</div>`;
}

async function renderPlanReviewPage(env) {
  const canonical = `${BASE_URL}/insights/plan-review`;
  const [data, freshness] = await Promise.all([getPlanReviewData(env), getDataFreshness(env)]);
  const s = data.summary;
  const hasData = s.count > 0;

  const title = "Seattle Permit Plan Review Times — How Long Does It Take?";
  const description =
    "How long Seattle SDCI permit plan review really takes: distribution of review days, average wait by permit type and neighborhood, and review-cycle counts.";

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Dataset",
        name: "Seattle Permit Plan Review Times",
        description,
        url: canonical,
        dateModified: freshness?.updated_through || undefined,
        isBasedOn: "https://data.seattle.gov/resource/k44w-2dcq.json",
        creator: { "@type": "Organization", name: "Building Seattle" },
      },
      {
        "@type": "Article",
        headline: "How long does Seattle permit plan review take?",
        description,
        url: canonical,
        dateModified: freshness?.updated_through || undefined,
        author: { "@type": "Organization", name: "Building Seattle" },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Insights", item: `${BASE_URL}/insights` },
          { "@type": "ListItem", position: 3, name: "Plan Review Times", item: canonical },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");

  const emptyState = `
    <div class="card" style="text-align:center;padding:3rem 1.75rem;">
      <h2 style="margin-top:0;">No plan-review data yet</h2>
      <p style="color:var(--text-muted);max-width:42ch;margin:0 auto;">Plan-review timing is populated as permits are enriched from the Seattle SDCI feed. Check back once enrichment has run.</p>
    </div>`;

  const histogramRows = s.histogram.map((b) => ({
    label: b.label,
    value: b.count,
    display: b.count.toLocaleString(),
    sub: s.count ? `${Math.round((b.count / s.count) * 100)}%` : "",
  }));

  const typeRows = data.by_type.map((t) => ({
    label: t.label,
    value: t.avg_days,
    display: `${t.avg_days} days`,
    sub: `${t.count.toLocaleString()} permits`,
  }));

  const neighborhoodRows = data.by_neighborhood.map((n) => ({
    label: n.label,
    href: n.slug ? `/neighborhood/${encodeURIComponent(n.slug)}` : null,
    value: n.avg_days,
    display: `${n.avg_days} days`,
    sub: `${n.count.toLocaleString()} permits`,
  }));

  const cycleRows = data.by_cycles.map((c) => ({
    label: c.cycles === 1 ? "1 cycle" : `${c.cycles} cycles`,
    value: c.count,
    display: c.count.toLocaleString(),
  }));

  const reviewLevelRows = data.by_review_level.map((r) => ({
    label: r.label,
    value: r.avg_days,
    display: `${r.avg_days} days`,
    sub: `${r.count.toLocaleString()} permits`,
  }));

  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Insights", href: "/insights" }, { label: "Plan Review Times" }])}
    ${insightsStyles()}
    ${insightsTabs("plan-review")}
    <div class="ent-hero">
      <div class="ent-kicker">Insights</div>
      <h1>How long does Seattle permit plan review take?</h1>
      <p style="color:var(--text-muted);max-width:65ch;margin:0;">Based on ${s.count.toLocaleString()} permits with recorded SDCI plan-review timing. "Plan review" is the time spent in review cycles before a permit is issued.</p>
    </div>
    ${
      hasData
        ? `
    <div class="card">
      <div class="stat-row">
        ${entStat("Permits analyzed", s.count.toLocaleString())}
        ${entStat("Median review", `${s.median} days`)}
        ${entStat("Average review", `${s.mean} days`)}
        ${entStat("90th percentile", `${s.p90} days`)}
        ${entStat("Avg review cycles", data.avg_cycles != null ? data.avg_cycles.toFixed(1) : "N/A")}
      </div>
      <p class="pr-note">Half of permits clear review in ${s.median} days or less, but the slowest 10% take ${s.p90}+ days — the gap is where projects stall.</p>
    </div>
    <div class="card">
      <h2>Distribution of plan-review time</h2>
      ${prBarChart(histogramRows)}
    </div>
    <div class="ent-grid">
      <div class="card">
        <h2>Average review time by permit type</h2>
        ${prBarChart(typeRows)}
      </div>
      <div class="card">
        <h2>Review cycles per permit</h2>
        ${prBarChart(cycleRows, "var(--success)")}
        <p class="pr-note">Each correction cycle adds a round-trip with reviewers. ${
          data.avg_days_out_corrections != null
            ? `Permits sit out for corrections about ${Math.round(data.avg_days_out_corrections)} days on average.`
            : ""
        }</p>
      </div>
    </div>
    <div class="card">
      <h2>Slowest neighborhoods by average review time</h2>
      <p style="color:var(--text-muted);margin-top:0;font-size:0.85rem;">Neighborhoods with at least 3 reviewed permits, ranked by longest average review.</p>
      ${prBarChart(neighborhoodRows, "var(--amber)")}
    </div>
    <div class="card">
      <h2>Average review time by review level</h2>
      ${prBarChart(reviewLevelRows)}
    </div>
    <p class="pr-note">Raw numbers available as JSON at <a class="ent-link" href="/api/plan-review">/api/plan-review</a>.</p>
    `
        : emptyState
    }`;

  return new Response(
    renderEntityDoc({
      title,
      description,
      canonical,
      jsonLd,
      noindex: !hasData,
      body: `${body}${renderDataTrustNote(freshness?.updated_through, "Review durations use SDCI-reported timing fields and exclude missing or negative values.")}`,
      activeNav: "insights",
    }),
    { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=300" } },
  );
}

// --- Permit pipeline (applied → issued → completed) -------------------------

async function getPipelineData(env) {
  const issuedFunnel =
    "applied_date IS NOT NULL AND applied_date != '' AND issued_date IS NOT NULL AND issued_date != '' AND julianday(issued_date) >= julianday(applied_date)";
  const completedFunnel =
    "issued_date IS NOT NULL AND issued_date != '' AND completed_date IS NOT NULL AND completed_date != '' AND julianday(completed_date) >= julianday(issued_date)";

  const [stageRow, appliedToIssued, issuedToCompleted, byTypeTiming] = await Promise.all([
    safeFirst(
      env,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN applied_date IS NOT NULL AND applied_date != '' THEN 1 ELSE 0 END) AS applied,
              SUM(CASE WHEN issued_date IS NOT NULL AND issued_date != '' THEN 1 ELSE 0 END) AS issued,
              SUM(CASE WHEN completed_date IS NOT NULL AND completed_date != '' THEN 1 ELSE 0 END) AS completed
       FROM permits`,
    ),
    safeAll(
      env,
      `SELECT CAST(julianday(issued_date) - julianday(applied_date) AS REAL) AS d
       FROM permits WHERE ${issuedFunnel}`,
    ),
    safeAll(
      env,
      `SELECT CAST(julianday(completed_date) - julianday(issued_date) AS REAL) AS d
       FROM permits WHERE ${completedFunnel}`,
    ),
    safeAll(
      env,
      `SELECT COALESCE(NULLIF(type,''),'unknown') AS label, COUNT(*) AS cnt,
              AVG(julianday(issued_date) - julianday(applied_date)) AS avg_days
       FROM permits WHERE ${issuedFunnel} GROUP BY label ORDER BY cnt DESC LIMIT 8`,
    ),
  ]);

  const total = Number(stageRow?.total) || 0;
  const applied = Number(stageRow?.applied) || 0;
  const issued = Number(stageRow?.issued) || 0;
  const completed = Number(stageRow?.completed) || 0;

  return {
    stages: { total, applied, issued, completed },
    issue_rate: applied ? Math.min(100, Math.round((issued / applied) * 100)) : 0,
    completion_rate: issued ? Math.min(100, Math.round((completed / issued) * 100)) : 0,
    applied_to_issued: summarizeDays(appliedToIssued.map((r) => r.d)),
    issued_to_completed: summarizeDays(issuedToCompleted.map((r) => r.d)),
    by_type: byTypeTiming.map((r) => ({
      label: r.label,
      count: Number(r.cnt) || 0,
      avg_days: Math.round(Number(r.avg_days) || 0),
    })),
  };
}

async function getPipelineStats(env) {
  const data = await getPipelineData(env);
  return new Response(JSON.stringify({ ...data, timestamp: new Date().toISOString() }), {
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

async function renderPipelinePage(env) {
  const canonical = `${BASE_URL}/insights/pipeline`;
  const [data, freshness] = await Promise.all([getPipelineData(env), getDataFreshness(env)]);
  const st = data.stages;
  const hasData = st.applied > 0 || st.issued > 0;

  const title = "Seattle Permit Pipeline — From Application to Completion";
  const description =
    "How Seattle building permits move from application to issuance to completion: stage counts, conversion rates, and the median days spent at each step.";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Seattle Permit Pipeline",
    description,
    url: canonical,
    creator: { "@type": "Organization", name: "Building Seattle" },
  }).replace(/</g, "\\u003c");

  const funnelRows = [
    { label: "Applied", value: st.applied, display: st.applied.toLocaleString() },
    {
      label: "Issued",
      value: st.issued,
      display: st.issued.toLocaleString(),
      sub: `${data.issue_rate}% of applied`,
    },
    {
      label: "Completed",
      value: st.completed,
      display: st.completed.toLocaleString(),
      sub: st.issued ? `${Math.round((st.completed / st.issued) * 100)}% of issued` : "",
    },
  ];

  const typeRows = data.by_type.map((t) => ({
    label: t.label,
    value: t.avg_days,
    display: `${t.avg_days} days`,
    sub: `${t.count.toLocaleString()} permits`,
  }));

  const emptyState = `
    <div class="card" style="text-align:center;padding:3rem 1.75rem;">
      <h2 style="margin-top:0;">No pipeline data yet</h2>
      <p style="color:var(--text-muted);max-width:42ch;margin:0 auto;">Pipeline timing comes from permit application, issue, and completion dates. Check back once permits have been ingested.</p>
    </div>`;

  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Insights", href: "/insights" }, { label: "Permit Pipeline" }])}
    ${insightsStyles()}
    ${insightsTabs("pipeline")}
    <div class="ent-hero">
      <div class="ent-kicker">Insights</div>
      <h1>The Seattle permit pipeline</h1>
      <p style="color:var(--text-muted);max-width:65ch;margin:0;">Every permit travels from application to issuance to completion. Here's how many make it to each stage and how long the journey takes.</p>
    </div>
    ${
      hasData
        ? `
    <div class="card">
      <div class="stat-row">
        ${entStat("Applied", st.applied.toLocaleString())}
        ${entStat("Issued", st.issued.toLocaleString())}
        ${entStat("Completed", st.completed.toLocaleString())}
        ${entStat("Issue rate", `${data.issue_rate}%`)}
        ${entStat("Median to issue", `${data.applied_to_issued.median} days`)}
      </div>
    </div>
    <div class="card">
      <h2>Pipeline funnel</h2>
      ${prBarChart(funnelRows)}
      <p class="pr-note">${data.issue_rate}% of applied permits reach issuance${
        data.completion_rate ? `, and ${data.completion_rate}% of issued permits are marked complete` : ""
      }.</p>
    </div>
    <div class="ent-grid">
      <div class="card">
        <h2>Time in each stage</h2>
        ${prBarChart(
          [
            {
              label: "Apply → Issue",
              value: data.applied_to_issued.median,
              display: `${data.applied_to_issued.median} days`,
              sub: `avg ${data.applied_to_issued.mean} · p90 ${data.applied_to_issued.p90}`,
            },
            {
              label: "Issue → Complete",
              value: data.issued_to_completed.median,
              display: `${data.issued_to_completed.median} days`,
              sub: `avg ${data.issued_to_completed.mean} · p90 ${data.issued_to_completed.p90}`,
            },
          ],
          "var(--success)",
        )}
        <p class="pr-note">Median durations across ${data.applied_to_issued.count.toLocaleString()} issued and ${data.issued_to_completed.count.toLocaleString()} completed permits.</p>
      </div>
      <div class="card">
        <h2>Median apply → issue by permit type</h2>
        ${prBarChart(typeRows)}
      </div>
    </div>
    <p class="pr-note">Raw numbers available as JSON at <a class="ent-link" href="/api/pipeline">/api/pipeline</a>.</p>
    `
        : emptyState
    }`;

  return new Response(
    renderEntityDoc({
      title,
      description,
      canonical,
      jsonLd,
      noindex: !hasData,
      body: `${body}${renderDataTrustNote(freshness?.updated_through, "Pipeline stages are permit-record states, not guaranteed completed projects.")}`,
      activeNav: "insights",
    }),
    { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=300" } },
  );
}

// --- Housing units tracker --------------------------------------------------

async function getHousingData(env) {
  const [byYear, byNeighborhood, totals] = await Promise.all([
    safeAll(
      env,
      `SELECT substr(COALESCE(NULLIF(issued_date,''), applied_date),1,4) AS yr,
              SUM(COALESCE(housing_units_added,0)) AS added,
              SUM(COALESCE(housing_units_removed,0)) AS removed
       FROM permits
       WHERE COALESCE(NULLIF(issued_date,''), applied_date) IS NOT NULL
         AND (housing_units_added IS NOT NULL OR housing_units_removed IS NOT NULL)
       GROUP BY yr HAVING yr IS NOT NULL AND yr != '' ORDER BY yr ASC`,
    ),
    safeAll(
      env,
      `SELECT COALESCE(NULLIF(neighborhood,''),'Unknown') AS label,
              SUM(COALESCE(housing_units_added,0)) AS added,
              SUM(COALESCE(housing_units_removed,0)) AS removed
       FROM permits
       WHERE housing_units_added IS NOT NULL OR housing_units_removed IS NOT NULL
       GROUP BY label
       HAVING (SUM(COALESCE(housing_units_added,0)) - SUM(COALESCE(housing_units_removed,0))) > 0
       ORDER BY (SUM(COALESCE(housing_units_added,0)) - SUM(COALESCE(housing_units_removed,0))) DESC LIMIT 12`,
    ),
    safeFirst(
      env,
      `SELECT SUM(COALESCE(housing_units_added,0)) AS added,
              SUM(COALESCE(housing_units_removed,0)) AS removed,
              SUM(CASE WHEN COALESCE(housing_units_added,0) > 0 THEN 1 ELSE 0 END) AS permits_adding
       FROM permits`,
    ),
  ]);

  const toRow = (r) => {
    const added = Number(r.added) || 0;
    const removed = Number(r.removed) || 0;
    return { ...r, added, removed, net: added - removed };
  };
  const grand = summarizeNetHousing((totals ? [totals] : []).map((r) => ({ added: r.added, removed: r.removed })));

  return {
    totals: { ...grand, permits_adding: Number(totals?.permits_adding) || 0 },
    by_year: byYear.map((r) => ({ year: r.yr, ...toRow(r) })),
    by_neighborhood: byNeighborhood.map((r) => ({ label: r.label, ...toRow(r) })),
  };
}

async function getHousingStats(env) {
  const data = await getHousingData(env);
  return new Response(JSON.stringify({ ...data, timestamp: new Date().toISOString() }), {
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

async function renderHousingPage(env) {
  const canonical = `${BASE_URL}/insights/housing`;
  const [data, freshness] = await Promise.all([getHousingData(env), getDataFreshness(env)]);
  const t = data.totals;
  const hasData = (t.added || 0) > 0 || (t.removed || 0) > 0;

  const title = "Seattle Housing Units Permitted — Net New Homes Tracker";
  const description =
    "Net new housing units permitted in Seattle: units added vs. removed over time and the neighborhoods adding the most homes.";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Seattle Housing Units Permitted",
    description,
    url: canonical,
    creator: { "@type": "Organization", name: "Building Seattle" },
  }).replace(/</g, "\\u003c");

  const yearRows = data.by_year.map((y) => ({
    label: y.year,
    value: y.net,
    display: (y.net >= 0 ? "+" : "") + y.net.toLocaleString(),
    sub: `+${y.added.toLocaleString()} / −${y.removed.toLocaleString()}`,
  }));

  const neighborhoodRows = data.by_neighborhood.map((n) => ({
    label: n.label,
    value: n.net,
    display: `+${n.net.toLocaleString()}`,
    sub: `${n.added.toLocaleString()} added`,
  }));

  const emptyState = `
    <div class="card" style="text-align:center;padding:3rem 1.75rem;">
      <h2 style="margin-top:0;">No housing data yet</h2>
      <p style="color:var(--text-muted);max-width:42ch;margin:0 auto;">Housing-unit counts come from permit records as they are ingested. Check back once permits with housing data have loaded.</p>
    </div>`;

  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Insights", href: "/insights" }, { label: "Housing" }])}
    ${insightsStyles()}
    ${insightsTabs("housing")}
    <div class="ent-hero">
      <div class="ent-kicker">Insights</div>
      <h1>Net new housing permitted in Seattle</h1>
      <p style="color:var(--text-muted);max-width:65ch;margin:0;">Permits add and remove dwelling units. The net is the number the city and press care about most — how many homes Seattle is actually approving.</p>
    </div>
    ${
      hasData
        ? `
    <div class="card">
      <div class="stat-row">
        ${entStat("Net units", (t.net >= 0 ? "+" : "") + t.net.toLocaleString())}
        ${entStat("Units added", t.added.toLocaleString())}
        ${entStat("Units removed", t.removed.toLocaleString())}
        ${entStat("Permits adding homes", t.permits_adding.toLocaleString())}
      </div>
      <p class="pr-note">Across all permits on record, Seattle has permitted a net ${(t.net >= 0 ? "+" : "") + t.net.toLocaleString()} dwelling units (${t.added.toLocaleString()} added, ${t.removed.toLocaleString()} removed).</p>
    </div>
    <div class="card">
      <h2>Net new units by year</h2>
      ${prBarChart(yearRows, "var(--success)")}
      <p class="pr-note">Bucketed by issue date (falling back to application date). Sub-labels show units added vs. removed.</p>
    </div>
    <div class="card">
      <h2>Neighborhoods adding the most homes</h2>
      ${prBarChart(neighborhoodRows, "var(--accent)")}
    </div>
    <p class="pr-note">Raw numbers available as JSON at <a class="ent-link" href="/api/housing">/api/housing</a>.</p>
    `
        : emptyState
    }`;

  return new Response(
    renderEntityDoc({
      title,
      description,
      canonical,
      jsonLd,
      noindex: !hasData,
      body: `${body}${renderDataTrustNote(freshness?.updated_through, "Housing-unit fields are shown as reported and can be incomplete or revised.")}`,
      activeNav: "insights",
    }),
    { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=300" } },
  );
}


async function hasAduDaduData(env) {
  const row = await env.DB.prepare(
    `/* adu-tracker:availability */
     SELECT 1 AS has_data
     FROM permits
     WHERE adu_type IN ('ADU', 'DADU')
     LIMIT 1`,
  ).first();
  return Boolean(row?.has_data);
}

async function getAduDaduData(env) {
  const [totals, byYear, byNeighborhood, recent] = await Promise.all([
    env.DB.prepare(
      `/* adu-tracker:totals */
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN adu_type = 'ADU' THEN 1 ELSE 0 END) AS adu_count,
             SUM(CASE WHEN adu_type = 'DADU' THEN 1 ELSE 0 END) AS dadu_count,
             SUM(COALESCE(value, 0)) AS total_value,
             SUM(COALESCE(housing_units_added, 0)) AS units_added,
             SUM(CASE WHEN issued_date IS NOT NULL AND issued_date != '' THEN 1 ELSE 0 END) AS issued,
             SUM(CASE WHEN lower(COALESCE(status, '')) IN ('active', 'pending', 'new', 'in review', 'under review') THEN 1 ELSE 0 END) AS active,
             MAX(COALESCE(updated_at, last_enriched_at, issued_date, applied_date, created_at)) AS data_updated_through
      FROM permits
      WHERE adu_type IN ('ADU', 'DADU')`,
    ).first(),
    env.DB.prepare(
      `/* adu-tracker:by-year */
      SELECT substr(COALESCE(NULLIF(issued_date, ''), applied_date), 1, 4) AS yr,
             COUNT(*) AS permits,
             SUM(CASE WHEN adu_type = 'ADU' THEN 1 ELSE 0 END) AS adu_count,
             SUM(CASE WHEN adu_type = 'DADU' THEN 1 ELSE 0 END) AS dadu_count
      FROM permits
      WHERE adu_type IN ('ADU', 'DADU')
        AND COALESCE(NULLIF(issued_date, ''), applied_date) IS NOT NULL
      GROUP BY yr
      HAVING yr IS NOT NULL AND yr != ''
      ORDER BY yr ASC`,
    ).all(),
    env.DB.prepare(
      `/* adu-tracker:by-neighborhood */
      SELECT COALESCE(NULLIF(neighborhood, ''), 'Unknown') AS label,
             COUNT(*) AS permits,
             SUM(CASE WHEN adu_type = 'ADU' THEN 1 ELSE 0 END) AS adu_count,
             SUM(CASE WHEN adu_type = 'DADU' THEN 1 ELSE 0 END) AS dadu_count,
             SUM(COALESCE(value, 0)) AS total_value
      FROM permits
      WHERE adu_type IN ('ADU', 'DADU')
      GROUP BY label
      ORDER BY permits DESC, total_value DESC
      LIMIT 12`,
    ).all(),
    env.DB.prepare(
      `/* adu-tracker:recent */
      SELECT permit_number, address, neighborhood, status, value, housing_units_added,
             COALESCE(NULLIF(issued_date, ''), applied_date) AS activity_date,
             adu_type
      FROM permits
      WHERE adu_type IN ('ADU', 'DADU')
      ORDER BY COALESCE(NULLIF(issued_date, ''), applied_date, created_at) DESC
      LIMIT 20`,
    ).all(),
  ]);

  const number = (value) => Number(value) || 0;
  const byYearRows = byYear.results || [];
  const byNeighborhoodRows = byNeighborhood.results || [];
  const recentRows = recent.results || [];
  return {
    totals: {
      total: number(totals?.total),
      adu_count: number(totals?.adu_count),
      dadu_count: number(totals?.dadu_count),
      total_value: number(totals?.total_value),
      units_added: number(totals?.units_added),
      issued: number(totals?.issued),
      active: number(totals?.active),
      data_updated_through: totals?.data_updated_through || null,
    },
    by_year: byYearRows.map((row) => ({
      year: row.yr,
      permits: number(row.permits),
      adu_count: number(row.adu_count),
      dadu_count: number(row.dadu_count),
    })),
    by_neighborhood: byNeighborhoodRows.map((row) => ({
      label: row.label,
      permits: number(row.permits),
      adu_count: number(row.adu_count),
      dadu_count: number(row.dadu_count),
      total_value: number(row.total_value),
    })),
    recent: recentRows.map((row) => ({
      ...row,
      value: number(row.value),
      housing_units_added: number(row.housing_units_added),
    })),
  };
}

async function getAduDaduStats(env) {
  try {
    const data = await getAduDaduData(env);
    return new Response(JSON.stringify({ ...data, timestamp: new Date().toISOString() }), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        "X-Robots-Tag": "noindex",
      },
    });
  } catch (error) {
    console.error("ADU tracker query failed:", error);
    return new Response(JSON.stringify({ error: "ADU tracker data is temporarily unavailable" }), {
      status: 503,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Retry-After": "300",
        "X-Robots-Tag": "noindex",
      },
    });
  }
}

async function renderAduDaduPage(env) {
  const canonical = `${BASE_URL}/insights/adu-dadu`;
  let data;
  try {
    data = await getAduDaduData(env);
  } catch (error) {
    console.error("ADU tracker page query failed:", error);
    const body = `
      ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Insights", href: "/insights" }, { label: "ADU / DADU" }])}
      <div class="ent-hero">
        <div class="ent-kicker">Seattle housing intelligence</div>
        <h1>Seattle ADU &amp; DADU permit tracker</h1>
      </div>
      <div class="card">
        <h2>Tracker temporarily unavailable</h2>
        <p>Seattle permit data could not be loaded for this request. Try again shortly.</p>
      </div>`;
    return new Response(
      renderEntityDoc({
        title: "Seattle ADU & DADU Permit Tracker | Building Seattle",
        description: "Track Seattle ADU and DADU permits using public SDCI permit records.",
        canonical,
        jsonLd: null,
        noindex: true,
        body,
        activeNav: "insights",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "text/html",
          "Cache-Control": "no-store",
          "Retry-After": "300",
        },
      },
    );
  }
  const totals = data.totals;
  const hasData = totals.total > 0;
  const title = "Seattle ADU & DADU Permit Tracker | Building Seattle";
  const description =
    "Track Seattle ADU and DADU permits by year, neighborhood, status, declared value, and recent activity using public SDCI permit records.";

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Dataset",
        name: "Seattle ADU and DADU Permit Tracker",
        description,
        url: canonical,
        creator: { "@type": "Organization", name: "Building Seattle" },
        spatialCoverage: { "@type": "Place", name: "Seattle, Washington" },
        dateModified: dateOrNull(totals.data_updated_through) || undefined,
        temporalCoverage: data.by_year.length
          ? `${data.by_year[0].year}/${data.by_year[data.by_year.length - 1].year}`
          : undefined,
        distribution: {
          "@type": "DataDownload",
          encodingFormat: "application/json",
          contentUrl: `${BASE_URL}/api/adu-dadu`,
        },
      },
      {
        "@type": "FAQPage",
        mainEntity: [
          {
            "@type": "Question",
            name: "What is the difference between an ADU and a DADU in Seattle?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "An ADU is an accessory dwelling unit associated with a primary home. A DADU is detached from the primary home and is often described as a backyard cottage.",
            },
          },
          {
            "@type": "Question",
            name: "Does every permit in this tracker represent a completed home?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "No. The tracker includes matching public permit records at different stages, from application and review through issuance and completion.",
            },
          },
          {
            "@type": "Question",
            name: "How are ADU and DADU permits identified?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "Building Seattle classifies permit records using explicit terms such as ADU, DADU, accessory dwelling unit, detached accessory dwelling unit, and backyard cottage in public permit descriptions.",
            },
          },
        ],
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Insights", item: `${BASE_URL}/insights` },
          { "@type": "ListItem", position: 3, name: "ADU and DADU Permit Tracker", item: canonical },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");

  const yearRows = data.by_year.map((row) => ({
    label: row.year,
    value: row.permits,
    display: row.permits.toLocaleString(),
    sub: `${row.adu_count} ADU · ${row.dadu_count} DADU`,
  }));
  const neighborhoodRows = data.by_neighborhood.map((row) => ({
    label: row.label,
    value: row.permits,
    display: row.permits.toLocaleString(),
    sub: `${row.dadu_count} detached · ${compactMoney(row.total_value)}`,
  }));
  const recentRows = data.recent
    .map(
      (permit) => `<tr>
        <td><a class="ent-link" href="/permits/${encodeURIComponent(permit.permit_number)}">${escapeHtml(permit.permit_number)}</a></td>
        <td>${escapeHtml(permit.adu_type)}</td>
        <td>${escapeHtml(permit.address || "Address unavailable")}</td>
        <td>${escapeHtml(permit.neighborhood || "Unknown")}</td>
        <td>${escapeHtml(permit.status || "Unknown")}</td>
        <td>${permit.value > 0 ? escapeHtml(compactMoney(permit.value)) : "Not reported"}</td>
        <td>${escapeHtml(entDate(permit.activity_date))}</td>
      </tr>`,
    )
    .join("");

  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Insights", href: "/insights" }, { label: "ADU / DADU" }])}
    ${insightsStyles()}
    ${insightsTabs("adu-dadu")}
    <div class="ent-hero">
      <div class="ent-kicker">Seattle housing intelligence</div>
      <h1>Seattle ADU &amp; DADU permit tracker</h1>
      <p style="color:var(--text-muted);max-width:70ch;margin:0;">Follow accessory dwelling unit permits across Seattle, compare attached ADUs with detached backyard cottages, and see where new small-scale housing activity is concentrating.</p>
    </div>
    ${
      hasData
        ? `
    <div class="card">
      <div class="stat-row">
        ${entStat("Matching permits", totals.total.toLocaleString())}
        ${entStat("ADU records", totals.adu_count.toLocaleString())}
        ${entStat("DADU records", totals.dadu_count.toLocaleString())}
        ${entStat("Issued", totals.issued.toLocaleString())}
        ${entStat("Active / in review", totals.active.toLocaleString())}
        ${entStat("Declared value", compactMoney(totals.total_value))}
      </div>
      <p class="pr-note">These are matching permit records, not a count of guaranteed completed dwellings. One property or project can have multiple related permits.</p>
      ${totals.data_updated_through ? `<p class="pr-note">Source data updated through ${escapeHtml(entDate(totals.data_updated_through))}.</p>` : ""}
    </div>
    <div class="card">
      <h2>ADU and DADU permits by year</h2>
      ${prBarChart(yearRows, "var(--success)")}
      <p class="pr-note">Grouped by issue date when available, otherwise application date.</p>
    </div>
    <div class="card">
      <h2>Seattle neighborhoods with the most ADU activity</h2>
      ${prBarChart(neighborhoodRows, "var(--accent)")}
    </div>
    <div class="card">
      <h2>Recent Seattle ADU and DADU permits</h2>
      <div style="overflow-x:auto;">
        <table class="ent">
          <thead><tr><th>Permit</th><th>Type</th><th>Address</th><th>Neighborhood</th><th>Status</th><th>Value</th><th>Date</th></tr></thead>
          <tbody>${recentRows}</tbody>
        </table>
      </div>
    </div>
    `
        : `<div class="card"><h2>ADU data is being classified</h2><p>The tracker will become indexable after matching Seattle permit records are available.</p></div>`
    }
    <div class="ent-grid" style="margin-top:1rem;">
      <section class="card">
        <h2>ADU vs. DADU</h2>
        <p><strong>ADU</strong> is the broader term for an accessory dwelling unit associated with a primary home. It can be inside, attached to, or converted from part of an existing structure.</p>
        <p><strong>DADU</strong> means detached accessory dwelling unit. In Seattle records it may also appear as a detached ADU or backyard cottage.</p>
      </section>
      <section class="card">
        <h2>How the tracker works</h2>
        <p>Building Seattle searches public permit descriptions for explicit ADU terminology, classifies detached projects separately, and aggregates results by year and neighborhood. A permit mentioning both attached and detached units is classified as DADU.</p>
        <p>Declared permit values and housing-unit fields are presented as reported and may be incomplete or revised during review.</p>
      </section>
    </div>
    <section class="card">
      <h2>Using ADU permit activity</h2>
      <p>Homeowners can see the kinds of projects moving through Seattle review. Contractors and designers can identify neighborhoods with sustained accessory-dwelling demand. Researchers can track how small-scale infill contributes to Seattle's housing pipeline.</p>
      <p class="pr-note">Raw tracker data is available at <a class="ent-link" href="/api/adu-dadu">/api/adu-dadu</a>. Source records come from Seattle Department of Construction and Inspections permit data.</p>
    </section>
  `;

  return new Response(
    renderEntityDoc({ title, description, canonical, jsonLd, noindex: !hasData, body, activeNav: "insights" }),
    { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=300" } },
  );
}

const MARKET_SEGMENTS = {
  multifamily: {
    title: "Seattle Multifamily Construction Pipeline",
    heading: "Seattle multifamily construction pipeline",
    description:
      "Track Seattle multifamily construction permits by year, neighborhood, status, declared value, housing units, and recent activity.",
    kicker: "Multifamily housing",
    methodology:
      "Includes permits reporting at least two added housing units or explicit multifamily, apartment, condominium, or townhouse language in public permit fields.",
    where: `(
      COALESCE(housing_units_added, 0) >= 2
      OR lower(COALESCE(type, '')) LIKE '%multifamily%'
      OR lower(COALESCE(description, '')) LIKE '%multifamily%'
      OR lower(COALESCE(detailed_description, '')) LIKE '%multifamily%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%multifamily%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%apartment%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%condominium%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%townhouse%'
    )`,
    path: "/insights/multifamily-pipeline",
  },
  commercial: {
    title: "High-Value Seattle Commercial Construction Projects",
    heading: "High-value commercial construction in Seattle",
    description:
      "Track Seattle commercial permits valued at $1 million or more, including offices, retail, hospitality, industrial, institutional, and mixed-use work.",
    kicker: "Commercial construction",
    methodology:
      "Includes permits with at least $1 million in declared value and commercial, office, retail, hotel, industrial, warehouse, institutional, hospital, school, or mixed-use language in public permit fields.",
    where: `COALESCE(value, 0) >= 1000000 AND (
      lower(COALESCE(type, '')) LIKE '%commercial%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%commercial%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%office%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%retail%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%hotel%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%industrial%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%warehouse%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%institutional%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%hospital%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%school%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%mixed use%'
    )`,
    path: "/insights/commercial-projects",
  },
  "tenant-improvements": {
    title: "Seattle Tenant-Improvement Permit Activity",
    heading: "Seattle tenant-improvement permit activity",
    description:
      "Follow Seattle tenant-improvement and tenant-alteration permits by year, neighborhood, status, declared value, and recent activity.",
    kicker: "Tenant improvements",
    methodology:
      "Includes permits whose type, description, detailed description, or primary-use field explicitly contains tenant improvement or tenant alteration language.",
    where: `(
      lower(COALESCE(type, '')) LIKE '%tenant improvement%'
      OR lower(COALESCE(type, '')) LIKE '%tenant alteration%'
      OR lower(COALESCE(description, '')) LIKE '%tenant improvement%'
      OR lower(COALESCE(description, '')) LIKE '%tenant alteration%'
      OR lower(COALESCE(detailed_description, '')) LIKE '%tenant improvement%'
      OR lower(COALESCE(detailed_description, '')) LIKE '%tenant alteration%'
      OR lower(COALESCE(primary_property_use, '')) LIKE '%tenant improvement%'
    )`,
    path: "/insights/tenant-improvements",
  },
};

async function getDataFreshness(env) {
  return safeFirst(
    env,
    `/* data-freshness */
     SELECT MAX(COALESCE(updated_at, last_enriched_at, issued_date, applied_date, created_at)) AS updated_through,
            COUNT(*) AS permit_count
     FROM permits`,
  );
}

function renderDataTrustNote(updatedThrough, extra = "") {
  const freshness = updatedThrough
    ? `Source records updated through ${escapeHtml(entDate(updatedThrough))}.`
    : "Freshness is shown when the source record provides a usable update date.";
  return `<aside class="card" aria-label="Data source and methodology" style="font-size:.82rem;color:var(--text-muted);">
      <strong style="color:var(--text);">Source and methodology.</strong>
      ${freshness} ${extra}
      <a class="ent-link" href="/methodology">Read the full methodology and limitations.</a>
    </aside>`;
}

async function getMarketSegmentData(env, segment) {
  const config = MARKET_SEGMENTS[segment];
  if (!config) return null;
  const where = config.where;
  const [totals, byYear, byNeighborhood, recent] = await Promise.all([
    safeFirst(
      env,
      `/* market-segment:${segment}:totals */
       SELECT COUNT(*) AS total, COALESCE(SUM(value), 0) AS total_value,
              SUM(CASE WHEN issued_date IS NOT NULL AND issued_date != '' THEN 1 ELSE 0 END) AS issued,
              SUM(CASE WHEN ${ACTIVE_PERMIT_SQL} THEN 1 ELSE 0 END) AS active,
              MAX(COALESCE(updated_at, last_enriched_at, issued_date, applied_date, created_at)) AS updated_through
       FROM permits p WHERE ${where}`,
    ),
    safeAll(
      env,
      `/* market-segment:${segment}:year */
       SELECT substr(COALESCE(NULLIF(issued_date, ''), applied_date), 1, 4) AS year,
              COUNT(*) AS permits, COALESCE(SUM(value), 0) AS total_value
       FROM permits p WHERE ${where}
         AND COALESCE(NULLIF(issued_date, ''), applied_date) IS NOT NULL
       GROUP BY year HAVING year IS NOT NULL AND year != '' ORDER BY year ASC`,
    ),
    safeAll(
      env,
      `/* market-segment:${segment}:neighborhood */
       SELECT COALESCE(NULLIF(neighborhood, ''), 'Unknown') AS label,
              COUNT(*) AS permits, COALESCE(SUM(value), 0) AS total_value
       FROM permits p WHERE ${where}
       GROUP BY label ORDER BY permits DESC, total_value DESC LIMIT 12`,
    ),
    safeAll(
      env,
      `/* market-segment:${segment}:recent */
       SELECT permit_number, address, neighborhood, status, type, value,
              COALESCE(NULLIF(issued_date, ''), applied_date) AS activity_date
       FROM permits p WHERE ${where}
       ORDER BY COALESCE(NULLIF(issued_date, ''), applied_date, created_at) DESC LIMIT 20`,
    ),
  ]);
  const number = (value) => Number(value) || 0;
  return {
    totals: {
      total: number(totals?.total),
      total_value: number(totals?.total_value),
      issued: number(totals?.issued),
      active: number(totals?.active),
      updated_through: totals?.updated_through || null,
    },
    by_year: byYear.map((row) => ({ ...row, permits: number(row.permits), total_value: number(row.total_value) })),
    by_neighborhood: byNeighborhood.map((row) => ({ ...row, permits: number(row.permits), total_value: number(row.total_value) })),
    recent,
  };
}

async function renderMarketSegmentPage(env, segment) {
  const config = MARKET_SEGMENTS[segment];
  if (!config) return render404();
  const data = await getMarketSegmentData(env, segment);
  const hasData = data.totals.total > 0;
  const canonical = `${BASE_URL}${config.path}`;
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Dataset",
        name: config.title,
        description: config.description,
        url: canonical,
        creator: { "@type": "Organization", name: "Building Seattle", url: BASE_URL },
        dateModified: dateOrNull(data.totals.updated_through) || undefined,
        spatialCoverage: { "@type": "Place", name: "Seattle, Washington" },
      },
      {
        "@type": "Article",
        headline: config.title,
        description: config.description,
        mainEntityOfPage: canonical,
        author: { "@type": "Organization", name: "Building Seattle" },
        dateModified: dateOrNull(data.totals.updated_through) || undefined,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Insights", item: `${BASE_URL}/insights` },
          { "@type": "ListItem", position: 3, name: config.heading, item: canonical },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");
  const yearRows = data.by_year.map((row) => ({
    label: row.year,
    value: row.permits,
    display: row.permits.toLocaleString(),
    sub: compactMoney(row.total_value),
  }));
  const neighborhoodRows = data.by_neighborhood.map((row) => ({
    label: row.label,
    value: row.permits,
    display: row.permits.toLocaleString(),
    sub: compactMoney(row.total_value),
  }));
  const recentRows = data.recent
    .map(
      (permit) => `<tr>
        <td><a class="ent-link" href="/permits/${encodeURIComponent(permit.permit_number)}">${escapeHtml(permit.permit_number)}</a></td>
        <td>${escapeHtml(permit.address || "Address unavailable")}</td>
        <td>${escapeHtml(permit.neighborhood || "Unknown")}</td>
        <td>${escapeHtml(permit.status || "Unknown")}</td>
        <td>${escapeHtml(permit.type || "Not reported")}</td>
        <td>${permit.value > 0 ? escapeHtml(compactMoney(permit.value)) : "Not reported"}</td>
        <td>${escapeHtml(entDate(permit.activity_date))}</td>
      </tr>`,
    )
    .join("");
  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Insights", href: "/insights" }, { label: config.heading }])}
    ${insightsStyles()}
    ${insightsTabs(segment)}
    <div class="ent-hero">
      <div class="ent-kicker">${escapeHtml(config.kicker)}</div>
      <h1>${escapeHtml(config.heading)}</h1>
      <p style="color:var(--text-muted);max-width:70ch;margin:0;">${escapeHtml(config.description)}</p>
    </div>
    ${
      hasData
        ? `<div class="card"><div class="stat-row">
            ${entStat("Matching permits", data.totals.total.toLocaleString())}
            ${entStat("Issued", data.totals.issued.toLocaleString())}
            ${entStat("Active / in review", data.totals.active.toLocaleString())}
            ${entStat("Declared value", compactMoney(data.totals.total_value))}
          </div></div>
          <div class="card"><h2>Permit activity by year</h2>${prBarChart(yearRows, "var(--success)")}</div>
          <div class="card"><h2>Leading Seattle neighborhoods</h2>${prBarChart(neighborhoodRows)}</div>
          <div class="card"><h2>Recent matching permits</h2><div style="overflow-x:auto;"><table class="ent">
            <thead><tr><th>Permit</th><th>Address</th><th>Neighborhood</th><th>Status</th><th>Type</th><th>Value</th><th>Date</th></tr></thead>
            <tbody>${recentRows}</tbody>
          </table></div></div>`
        : `<div class="card"><h2>Supporting data is unavailable</h2><p>This page will become indexable when matching permit records are available.</p></div>`
    }
    ${renderDataTrustNote(data.totals.updated_through, `${escapeHtml(config.methodology)} Declared value is not verified project cost.`)}
  `;
  return new Response(
    renderEntityDoc({
      title: `${config.title} | Building Seattle`,
      description: config.description,
      canonical,
      jsonLd,
      noindex: !hasData,
      body,
      activeNav: "insights",
    }),
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } },
  );
}

// --- Shared chart helpers for map / network (server-rendered SVG) -----------

// Compact money formatter for dense labels ($1.2M, $340K).
function compactMoney(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

// Neighborhood centroids for the bubble map, derived (lazily + memoized) from
// the canonical NEIGHBORHOOD_BOUNDS defined later in this file. Lazy so it reads
// that const after module evaluation rather than in its temporal dead zone.
let _neighborhoodCentroids = null;
function neighborhoodCentroids() {
  if (_neighborhoodCentroids) return _neighborhoodCentroids;
  const m = new Map();
  for (const [name, minLat, maxLat, minLng, maxLng] of NEIGHBORHOOD_BOUNDS) {
    m.set(name.toLowerCase(), { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 });
  }
  _neighborhoodCentroids = m;
  return m;
}

const SEATTLE_BBOX = { latMin: 47.5, latMax: 47.745, lngMin: -122.435, lngMax: -122.245 };

export function projectSeattle(lat, lng, W, H, pad) {
  const { latMin, latMax, lngMin, lngMax } = SEATTLE_BBOX;
  const xFrac = (lng - lngMin) / (lngMax - lngMin);
  const yFrac = (latMax - lat) / (latMax - latMin);
  return [pad + xFrac * (W - 2 * pad), pad + yFrac * (H - 2 * pad)];
}

// --- Construction map (neighborhood bubble map) -----------------------------

async function getMapData(env) {
  const rows = await safeAll(
    env,
    `SELECT neighborhood AS name, COUNT(*) AS permits, COALESCE(SUM(value),0) AS total_value
     FROM permits WHERE neighborhood IS NOT NULL AND neighborhood != ''
     GROUP BY neighborhood ORDER BY permits DESC`,
  );
  const neighborhoods = rows.map((r) => {
    const centroid = neighborhoodCentroids().get(String(r.name).toLowerCase()) || null;
    return {
      name: r.name,
      permits: Number(r.permits) || 0,
      total_value: Number(r.total_value) || 0,
      lat: centroid ? centroid.lat : null,
      lng: centroid ? centroid.lng : null,
      mapped: !!centroid,
    };
  });
  const mapped = neighborhoods.filter((n) => n.mapped);
  return {
    neighborhoods,
    mapped_count: mapped.length,
    unmapped_count: neighborhoods.length - mapped.length,
    total_permits: neighborhoods.reduce((s, n) => s + n.permits, 0),
    total_value: neighborhoods.reduce((s, n) => s + n.total_value, 0),
  };
}

async function getMapStats(env) {
  const data = await getMapData(env);
  return new Response(JSON.stringify({ ...data, timestamp: new Date().toISOString() }), {
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

// Render the bubble map as inline SVG. Labels use currentColor so they adapt to
// light/dark themes; bubble size encodes permit count, opacity encodes value.
function svgBubbleMap(mapped) {
  const W = 470;
  const H = 820;
  const pad = 40;
  if (!mapped.length) return "";
  const maxPermits = Math.max(...mapped.map((n) => n.permits), 1);
  const maxValue = Math.max(...mapped.map((n) => n.total_value), 1);
  // Largest bubbles drawn first so smaller ones layer on top and stay clickable.
  const ordered = [...mapped].sort((a, b) => b.permits - a.permits);
  const labelSet = new Set(ordered.slice(0, 14).map((n) => n.name));

  const bubbles = ordered
    .map((n) => {
      const [x, y] = projectSeattle(n.lat, n.lng, W, H, pad);
      const r = 5 + 30 * Math.sqrt(n.permits / maxPermits);
      const op = (0.25 + 0.6 * (n.total_value / maxValue)).toFixed(2);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#3b82f6" fill-opacity="${op}" stroke="#3b82f6" stroke-opacity="0.9" stroke-width="1"><title>${escapeHtml(n.name)}: ${n.permits.toLocaleString()} permits · ${compactMoney(n.total_value)}</title></circle>`;
    })
    .join("");

  const labels = ordered
    .filter((n) => labelSet.has(n.name))
    .map((n) => {
      const [x, y] = projectSeattle(n.lat, n.lng, W, H, pad);
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="9" font-weight="700" fill="currentColor" style="paint-order:stroke;stroke:var(--surface);stroke-width:2.5px;">${escapeHtml(n.name)}</text>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of Seattle construction permits by neighborhood" style="width:100%;height:auto;max-width:470px;display:block;margin:0 auto;color:var(--text);">
    <text x="${pad}" y="${pad - 18}" font-size="10" fill="var(--text-muted)">N &#8593;</text>
    ${bubbles}
    ${labels}
  </svg>`;
}

async function renderMapPage(env) {
  const canonical = `${BASE_URL}/insights/map`;
  const [data, freshness] = await Promise.all([getMapData(env), getDataFreshness(env)]);
  const mapped = data.neighborhoods.filter((n) => n.mapped);
  const hasData = mapped.length > 0;

  const title = "Seattle Construction Activity Map — Permits by Neighborhood";
  const description =
    "Where Seattle is building: permit counts and total construction value mapped across the city's neighborhoods.";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Seattle Construction Activity by Neighborhood",
    description,
    url: canonical,
    creator: { "@type": "Organization", name: "Building Seattle" },
  }).replace(/</g, "\\u003c");

  const rankRows = data.neighborhoods.slice(0, 15).map((n) => ({
    label: n.name,
    value: n.permits,
    display: n.permits.toLocaleString(),
    sub: compactMoney(n.total_value),
  }));

  const emptyState = `
    <div class="card" style="text-align:center;padding:3rem 1.75rem;">
      <h2 style="margin-top:0;">No mapped permits yet</h2>
      <p style="color:var(--text-muted);max-width:42ch;margin:0 auto;">The map plots permit activity by neighborhood. Check back once permits with neighborhoods have been ingested.</p>
    </div>`;

  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Insights", href: "/insights" }, { label: "Map" }])}
    ${insightsStyles()}
    ${insightsTabs("map")}
    <div class="ent-hero">
      <div class="ent-kicker">Insights</div>
      <h1>Where Seattle is building</h1>
      <p style="color:var(--text-muted);max-width:65ch;margin:0;">Every active permit, mapped to its neighborhood. Bubble size shows the number of permits; color depth shows total construction value.</p>
    </div>
    ${
      hasData
        ? `
    <div class="card">
      <div class="stat-row">
        ${entStat("Neighborhoods", data.mapped_count.toLocaleString())}
        ${entStat("Permits mapped", data.total_permits.toLocaleString())}
        ${entStat("Total value", compactMoney(data.total_value))}
      </div>
    </div>
    <div class="ent-grid">
      <div class="card">
        <h2>Construction activity map</h2>
        ${svgBubbleMap(mapped)}
        <p class="pr-note">Bubble size = permit count · color depth = total value. Hover a bubble for details.${data.unmapped_count ? ` ${data.unmapped_count} neighborhood${data.unmapped_count === 1 ? "" : "s"} without a known centroid are listed but not plotted.` : ""}</p>
      </div>
      <div class="card">
        <h2>Most active neighborhoods</h2>
        ${prBarChart(rankRows)}
      </div>
    </div>
    <p class="pr-note">Raw numbers available as JSON at <a class="ent-link" href="/api/map">/api/map</a>.</p>
    `
        : emptyState
    }`;

  return new Response(
    renderEntityDoc({
      title,
      description,
      canonical,
      jsonLd,
      noindex: !hasData,
      body: `${body}${renderDataTrustNote(freshness?.updated_through, "Neighborhood assignment is derived from normalized permit addresses.")}`,
      activeNav: "insights",
    }),
    { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=300" } },
  );
}

// --- Contractor scorecards --------------------------------------------------

async function getContractorScorecards(env) {
  const [topByPermits, topByValue, totals] = await Promise.all([
    safeAll(
      env,
      `SELECT c.name, c.slug, COUNT(p.id) AS permits, COALESCE(SUM(p.value),0) AS total_value,
              COUNT(DISTINCT p.neighborhood) AS neighborhoods,
              AVG(p.total_days_plan_review) AS avg_review,
              SUM(CASE WHEN p.status='active' THEN 1 ELSE 0 END) AS active
       FROM contractors c JOIN permits p ON p.contractor_id = c.id
       GROUP BY c.id ORDER BY permits DESC LIMIT 25`,
    ),
    safeAll(
      env,
      `SELECT c.name, c.slug, COUNT(p.id) AS permits, COALESCE(SUM(p.value),0) AS total_value
       FROM contractors c JOIN permits p ON p.contractor_id = c.id
       GROUP BY c.id ORDER BY total_value DESC LIMIT 12`,
    ),
    safeFirst(
      env,
      `SELECT (SELECT COUNT(*) FROM contractors) AS contractors,
              COUNT(DISTINCT p.contractor_id) AS active_contractors,
              COUNT(*) AS attributed_permits
       FROM permits p WHERE p.contractor_id IS NOT NULL`,
    ),
  ]);

  const num = (v) => Number(v) || 0;
  return {
    totals: {
      contractors: num(totals?.contractors),
      active_contractors: num(totals?.active_contractors),
      attributed_permits: num(totals?.attributed_permits),
    },
    top_by_permits: topByPermits.map((r) => ({
      name: r.name,
      slug: r.slug,
      permits: num(r.permits),
      total_value: num(r.total_value),
      neighborhoods: num(r.neighborhoods),
      active: num(r.active),
      avg_review: r.avg_review != null ? Math.round(Number(r.avg_review)) : null,
    })),
    top_by_value: topByValue.map((r) => ({
      name: r.name,
      slug: r.slug,
      permits: num(r.permits),
      total_value: num(r.total_value),
    })),
  };
}

async function getContractorScorecardStats(env) {
  const data = await getContractorScorecards(env);
  return new Response(JSON.stringify({ ...data, timestamp: new Date().toISOString() }), {
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

async function renderContractorsPage(env) {
  const canonical = `${BASE_URL}/insights/contractors`;
  const [data, freshness] = await Promise.all([getContractorScorecards(env), getDataFreshness(env)]);
  const hasData = data.top_by_permits.length > 0;

  const title = "Seattle's Most Active Contractors — Permit Scorecards";
  const description =
    "Which contractors pull the most Seattle building permits, the highest construction value, the fastest review times, and the widest neighborhood reach.";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Seattle Contractor Permit Scorecards",
    description,
    url: canonical,
    creator: { "@type": "Organization", name: "Building Seattle" },
  }).replace(/</g, "\\u003c");

  const permitRows = data.top_by_permits.slice(0, 15).map((c) => ({
    label: c.name,
    value: c.permits,
    display: c.permits.toLocaleString(),
    sub: `${c.neighborhoods} nbhds`,
  }));
  const valueRows = data.top_by_value.map((c) => ({
    label: c.name,
    value: c.total_value,
    display: compactMoney(c.total_value),
    sub: `${c.permits.toLocaleString()} permits`,
  }));

  const tableRows = data.top_by_permits
    .map(
      (c) => `<tr>
        <td><a class="ent-link" href="/contractor/${encodeURIComponent(c.slug)}">${escapeHtml(c.name)}</a></td>
        <td>${c.permits.toLocaleString()}</td>
        <td>${compactMoney(c.total_value)}</td>
        <td>${c.neighborhoods}</td>
        <td>${c.avg_review != null ? `${c.avg_review} days` : "—"}</td>
        <td>${c.active.toLocaleString()}</td>
      </tr>`,
    )
    .join("");

  const emptyState = `
    <div class="card" style="text-align:center;padding:3rem 1.75rem;">
      <h2 style="margin-top:0;">No contractor data yet</h2>
      <p style="color:var(--text-muted);max-width:42ch;margin:0 auto;">Scorecards rank contractors by their attributed permits. Check back once permits have been linked to contractors.</p>
    </div>`;

  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Insights", href: "/insights" }, { label: "Contractors" }])}
    ${insightsStyles()}
    ${insightsTabs("contractors")}
    <div class="ent-hero">
      <div class="ent-kicker">Insights</div>
      <h1>Seattle's most active contractors</h1>
      <p style="color:var(--text-muted);max-width:65ch;margin:0;">Ranked by the permits attributed to them — with total construction value, neighborhood reach, and median review speed.</p>
    </div>
    ${
      hasData
        ? `
    <div class="card">
      <div class="stat-row">
        ${entStat("Contractors", data.totals.contractors.toLocaleString())}
        ${entStat("With permits", data.totals.active_contractors.toLocaleString())}
        ${entStat("Attributed permits", data.totals.attributed_permits.toLocaleString())}
      </div>
    </div>
    <div class="ent-grid">
      <div class="card">
        <h2>Most permits pulled</h2>
        ${prBarChart(permitRows)}
      </div>
      <div class="card">
        <h2>Highest construction value</h2>
        ${prBarChart(valueRows, "var(--success)")}
      </div>
    </div>
    <div class="card">
      <h2>Contractor scorecards</h2>
      <div style="overflow-x:auto;">
        <table class="ent">
          <thead><tr><th>Contractor</th><th>Permits</th><th>Value</th><th>Nbhds</th><th>Avg review</th><th>Active</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>
    <p class="pr-note">Raw numbers available as JSON at <a class="ent-link" href="/api/contractor-scorecards">/api/contractor-scorecards</a>.</p>
    `
        : emptyState
    }`;

  return new Response(
    renderEntityDoc({
      title,
      description,
      canonical,
      jsonLd,
      noindex: !hasData,
      body: `${body}${renderDataTrustNote(freshness?.updated_through, "Contractor attribution follows public permit participants and may include general, specialty, or subcontractor roles.")}`,
      activeNav: "insights",
    }),
    { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=300" } },
  );
}

// --- Contractor ↔ neighborhood network --------------------------------------

async function getNetworkData(env) {
  const topContractors = await safeAll(
    env,
    `SELECT c.id, c.name, c.slug, COUNT(p.id) AS permits
     FROM contractors c JOIN permits p ON p.contractor_id = c.id
     GROUP BY c.id ORDER BY permits DESC LIMIT 16`,
  );
  const allNeighborhoods = await safeAll(
    env,
    `SELECT neighborhood AS name, COUNT(*) AS permits
     FROM permits
     WHERE neighborhood IS NOT NULL AND neighborhood != ''
     GROUP BY neighborhood ORDER BY neighborhood ASC`,
  );
  const contractorRows = await safeAll(
    env,
    `SELECT p.neighborhood AS neighborhood, c.id AS contractor_id, c.name AS contractor_name, c.slug AS contractor_slug, COUNT(*) AS permits
     FROM permits p JOIN contractors c ON c.id = p.contractor_id
     WHERE p.neighborhood IS NOT NULL AND p.neighborhood != ''
     GROUP BY p.neighborhood, c.id
     ORDER BY p.neighborhood ASC, permits DESC, c.name ASC`,
  );
  const contractorsByNeighborhood = new Map();
  for (const row of contractorRows) {
    const name = row.neighborhood;
    if (!contractorsByNeighborhood.has(name)) contractorsByNeighborhood.set(name, []);
    contractorsByNeighborhood.get(name).push({
      name: row.contractor_name,
      slug: row.contractor_slug,
      permits: Number(row.permits) || 0,
    });
  }
  const neighborhoodContractors = allNeighborhoods.map((n) => ({
    name: n.name,
    permits: Number(n.permits) || 0,
    contractors: (contractorsByNeighborhood.get(n.name) || []).slice(0, 5),
  }));

  if (!topContractors.length) {
    return { contractors: [], neighborhoods: [], edges: [], neighborhood_contractors: neighborhoodContractors };
  }
  const ids = topContractors.map((c) => Number(c.id));
  const placeholders = ids.map(() => "?").join(",");
  const breakdown = await safeAll(
    env,
    `SELECT contractor_id AS cid, neighborhood AS nb, COUNT(*) AS cnt
     FROM permits
     WHERE contractor_id IN (${placeholders}) AND neighborhood IS NOT NULL AND neighborhood != ''
     GROUP BY contractor_id, neighborhood`,
    ids,
  );

  // Keep each contractor's top 4 neighborhoods so the bipartite graph stays legible.
  const byContractor = new Map();
  for (const row of breakdown) {
    const cid = Number(row.cid);
    if (!byContractor.has(cid)) byContractor.set(cid, []);
    byContractor.get(cid).push({ nb: row.nb, cnt: Number(row.cnt) || 0 });
  }
  const edges = [];
  const nbTotals = new Map();
  for (const c of topContractors) {
    const list = (byContractor.get(Number(c.id)) || []).sort((a, b) => b.cnt - a.cnt).slice(0, 4);
    for (const { nb, cnt } of list) {
      edges.push({ contractor: c.slug, contractor_name: c.name, neighborhood: nb, count: cnt });
      nbTotals.set(nb, (nbTotals.get(nb) || 0) + cnt);
    }
  }
  const neighborhoods = [...nbTotals.entries()]
    .map(([name, weight]) => ({ name, weight }))
    .sort((a, b) => b.weight - a.weight);

  return {
    contractors: topContractors.map((c) => ({ name: c.name, slug: c.slug, permits: Number(c.permits) || 0 })),
    neighborhoods,
    edges,
    neighborhood_contractors: neighborhoodContractors,
  };
}

async function getNetworkStats(env) {
  const data = await getNetworkData(env);
  return new Response(JSON.stringify({ ...data, timestamp: new Date().toISOString() }), {
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

// Server-rendered bipartite SVG: contractors (left) linked to the neighborhoods
// they're most active in (right). Edge width encodes shared permit count.
function svgBipartiteNetwork(contractors, neighborhoods, edges) {
  if (!contractors.length || !neighborhoods.length) return "";
  const rowH = 34;
  const padY = 28;
  const W = 840;
  const colL = 280;
  const colR = 560;
  const midX = (colL + colR) / 2;
  const H = Math.max(contractors.length, neighborhoods.length) * rowH + padY * 2;

  const cPos = new Map();
  contractors.forEach((c, i) => cPos.set(c.slug, padY + i * rowH + rowH / 2));
  const nPos = new Map();
  neighborhoods.forEach((n, i) => nPos.set(n.name, padY + i * rowH + rowH / 2));

  const maxCount = Math.max(...edges.map((e) => e.count), 1);
  const edgePaths = edges
    .map((e) => {
      const y1 = cPos.get(e.contractor);
      const y2 = nPos.get(e.neighborhood);
      if (y1 == null || y2 == null) return "";
      const w = (1 + 4 * Math.sqrt(e.count / maxCount)).toFixed(1);
      return `<path d="M${colL},${y1} C${midX},${y1} ${midX},${y2} ${colR},${y2}" fill="none" stroke="currentColor" stroke-opacity="0.16" stroke-width="${w}"><title>${escapeHtml(e.contractor_name)} → ${escapeHtml(e.neighborhood)}: ${e.count} permits</title></path>`;
    })
    .join("");

  const maxPermits = Math.max(...contractors.map((c) => c.permits), 1);
  const cNodes = contractors
    .map((c) => {
      const y = cPos.get(c.slug);
      const r = (5 + 9 * Math.sqrt(c.permits / maxPermits)).toFixed(1);
      return `<a href="/contractor/${encodeURIComponent(c.slug)}">
        <circle cx="${colL}" cy="${y}" r="${r}" fill="#3b82f6"><title>${escapeHtml(c.name)}: ${c.permits} permits</title></circle>
        <text x="${colL - 14}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="11" fill="currentColor">${escapeHtml(c.name)}</text>
      </a>`;
    })
    .join("");

  const maxWeight = Math.max(...neighborhoods.map((n) => n.weight), 1);
  const nNodes = neighborhoods
    .map((n) => {
      const y = nPos.get(n.name);
      const r = (5 + 9 * Math.sqrt(n.weight / maxWeight)).toFixed(1);
      return `<g>
        <circle cx="${colR}" cy="${y}" r="${r}" fill="#10b981"><title>${escapeHtml(n.name)}: ${n.weight} permits across these contractors</title></circle>
        <text x="${colR + 14}" y="${y}" text-anchor="start" dominant-baseline="middle" font-size="11" fill="currentColor">${escapeHtml(n.name)}</text>
      </g>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Network of contractors linked to the Seattle neighborhoods they build in" style="width:100%;height:auto;color:var(--text);">
    <text x="${colL}" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="var(--text-muted)">Contractors</text>
    <text x="${colR}" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="var(--text-muted)">Neighborhoods</text>
    ${edgePaths}
    ${cNodes}
    ${nNodes}
  </svg>`;
}

async function renderNetworkPage(env) {
  const canonical = `${BASE_URL}/insights/network`;
  const [data, freshness] = await Promise.all([getNetworkData(env), getDataFreshness(env)]);
  const hasData = data.contractors.length > 0 && data.edges.length > 0;

  const title = "Who Builds Where — Seattle Contractor & Neighborhood Network";
  const description =
    "A network map linking Seattle's busiest contractors to the neighborhoods where they pull the most permits.";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Seattle Contractor–Neighborhood Network",
    description,
    url: canonical,
    creator: { "@type": "Organization", name: "Building Seattle" },
  }).replace(/</g, "\\u003c");

  // Accessible / SEO fallback: each contractor's top neighborhoods as text.
  const adjacency = data.contractors
    .map((c) => {
      const nbs = data.edges
        .filter((e) => e.contractor === c.slug)
        .sort((a, b) => b.count - a.count)
        .map((e) => `${escapeHtml(e.neighborhood)} (${e.count})`)
        .join(", ");
      return nbs
        ? `<li><a class="ent-link" href="/contractor/${encodeURIComponent(c.slug)}">${escapeHtml(c.name)}</a> <span style="color:var(--text-muted);font-size:0.82rem;">→ ${nbs}</span></li>`
        : "";
    })
    .join("");

  // Every neighborhood's top contractors, independently calculated from all
  // attributed permits instead of only the contractors shown in the SVG.
  const neighborhoodContractorCards = (data.neighborhood_contractors || [])
    .map((n) => {
      const contractorRows = n.contractors.length
        ? n.contractors
            .map(
              (c, index) =>
                `<li class="nb-contractor-row">
                  <span class="nb-rank">${index + 1}</span>
                  <a class="ent-link" href="/contractor/${encodeURIComponent(c.slug)}">${escapeHtml(c.name)}</a>
                  <span class="nb-count">${Number(c.permits).toLocaleString()} permit${Number(c.permits) === 1 ? "" : "s"}</span>
                </li>`,
            )
            .join("")
        : `<li class="nb-empty">No attributed contractors yet</li>`;
      return `<article class="nb-contractor-card">
        <div class="nb-card-head">
          <h3>${escapeHtml(n.name)}</h3>
          <span>${Number(n.permits).toLocaleString()} permit${Number(n.permits) === 1 ? "" : "s"}</span>
        </div>
        <ol>${contractorRows}</ol>
      </article>`;
    })
    .join("");

  const emptyState = `
    <div class="card" style="text-align:center;padding:3rem 1.75rem;">
      <h2 style="margin-top:0;">No network data yet</h2>
      <p style="color:var(--text-muted);max-width:46ch;margin:0 auto;">This network links contractors to the neighborhoods they build in. It needs permits attributed to contractors with neighborhoods — check back once that data is ingested.</p>
    </div>`;

  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Insights", href: "/insights" }, { label: "Network" }])}
    ${insightsStyles()}
    ${insightsTabs("network")}
    <div class="ent-hero">
      <div class="ent-kicker">Insights</div>
      <h1>Who builds where</h1>
      <p style="color:var(--text-muted);max-width:65ch;margin:0;">A network of Seattle's 16 busiest contractors and the neighborhoods where they pull the most permits. Thicker links mean more shared activity.</p>
    </div>
    ${
      hasData
        ? `
    <div class="card">
      <h2>Contractor &amp; neighborhood network</h2>
      ${svgBipartiteNetwork(data.contractors, data.neighborhoods, data.edges)}
      <p class="pr-note">Blue = contractors (sized by total permits) · green = neighborhoods (sized by permits from these contractors). Click a contractor to open their page. Each contractor is linked to its top 4 neighborhoods.</p>
    </div>
    <div class="card">
      <h2>Top neighborhoods by contractor</h2>
      <ul class="ent-list">${adjacency}</ul>
    </div>
    <div class="card">
      <h2>Top contractors by neighborhood</h2>
      <p class="pr-note">Includes every neighborhood with permit activity. Contractor rankings are recalculated across all attributed permits for that neighborhood.</p>
      <div class="nb-contractor-grid">${neighborhoodContractorCards}</div>
    </div>
    <p class="pr-note">Raw nodes and edges available as JSON at <a class="ent-link" href="/api/network">/api/network</a>.</p>
    `
        : emptyState
    }`;

  return new Response(
    renderEntityDoc({
      title,
      description,
      canonical,
      jsonLd,
      noindex: !hasData,
      body: `${body}${renderDataTrustNote(freshness?.updated_through, "Network edges aggregate attributed permits; they do not establish contractual relationships beyond the source records.")}`,
      activeNav: "insights",
    }),
    { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=300" } },
  );
}

// --- Insights index ---------------------------------------------------------

async function renderInsightsIndex(env) {
  const canonical = `${BASE_URL}/insights`;
  const [pr, pipe, house, aduAgg, mapAgg, contractorAgg] = await Promise.all([
    safeFirst(
      env,
      `SELECT COUNT(*) AS cnt, AVG(total_days_plan_review) AS avg_days
       FROM permits WHERE total_days_plan_review IS NOT NULL AND total_days_plan_review >= 0`,
    ),
    safeFirst(
      env,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN issued_date IS NOT NULL AND issued_date != '' THEN 1 ELSE 0 END) AS issued
       FROM permits`,
    ),
    safeFirst(
      env,
      `SELECT SUM(COALESCE(housing_units_added,0)) - SUM(COALESCE(housing_units_removed,0)) AS net
       FROM permits`,
    ),
    safeFirst(
      env,
      `/* adu-tracker:index */
       SELECT COUNT(*) AS total
       FROM permits
       WHERE adu_type IN ('ADU', 'DADU')`,
    ),
    safeFirst(
      env,
      `SELECT COUNT(DISTINCT neighborhood) AS nbhds
       FROM permits WHERE neighborhood IS NOT NULL AND neighborhood != ''`,
    ),
    safeFirst(
      env,
      `SELECT COUNT(DISTINCT contractor_id) AS active_contractors
       FROM permits WHERE contractor_id IS NOT NULL`,
    ),
  ]);

  const prCount = Number(pr?.cnt) || 0;
  const prAvg = pr?.avg_days != null ? Math.round(Number(pr.avg_days)) : null;
  const pipeTotal = Number(pipe?.total) || 0;
  const pipeIssued = Number(pipe?.issued) || 0;
  const houseNet = Number(house?.net) || 0;
  const aduTotal = Number(aduAgg?.total) || 0;
  const mapNbhds = Number(mapAgg?.nbhds) || 0;
  const activeContractors = Number(contractorAgg?.active_contractors) || 0;

  const title = "Seattle Construction Insights — Permit Data Visualized";
  const description =
    "Data-driven views of Seattle construction: permit timing, ADU and DADU activity, housing growth, neighborhood trends, contractors, and project connections.";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Building Seattle Insights",
    description,
    url: canonical,
  }).replace(/</g, "\\u003c");

  const feature = (href, kicker, h, teaser, stat) => `
    <a class="ins-feature" href="${href}">
      <div class="card">
        <div class="ent-kicker">${escapeHtml(kicker)}</div>
        <h2 style="margin:0.2rem 0 0.5rem;">${escapeHtml(h)}</h2>
        <p style="color:var(--text-muted);margin:0 0 1rem;font-size:0.9rem;">${escapeHtml(teaser)}</p>
        <div style="font-size:1.5rem;font-weight:800;color:var(--accent);">${stat}</div>
      </div>
    </a>`;

  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Insights" }])}
    ${insightsStyles()}
    <div class="ent-hero">
      <div class="ent-kicker">Insights</div>
      <h1>Seattle construction, visualized</h1>
      <p style="color:var(--text-muted);max-width:65ch;margin:0;">Data-driven views built from the permits we aggregate across Seattle. Each report updates as new permit data is ingested.</p>
    </div>
    <div class="ins-card-grid">
      ${feature(
        "/insights/plan-review",
        "Timing",
        "Plan review times",
        "How long permits spend in SDCI review before they're issued — by type, neighborhood, and review cycle.",
        prCount ? `${prAvg} <span style="font-size:0.9rem;color:var(--text-muted);font-weight:600;">avg days · ${prCount.toLocaleString()} permits</span>` : `<span style="font-size:0.95rem;color:var(--text-muted);">Awaiting data</span>`,
      )}
      ${feature(
        "/insights/pipeline",
        "Flow",
        "The permit pipeline",
        "Application → issuance → completion: how many permits reach each stage and how long it takes.",
        pipeTotal ? `${pipeIssued.toLocaleString()} <span style="font-size:0.9rem;color:var(--text-muted);font-weight:600;">issued of ${pipeTotal.toLocaleString()}</span>` : `<span style="font-size:0.95rem;color:var(--text-muted);">Awaiting data</span>`,
      )}
      ${feature(
        "/insights/housing",
        "Growth",
        "Housing units tracker",
        "Net new dwelling units permitted across Seattle and the neighborhoods adding the most homes.",
        house && house.net != null ? `${houseNet >= 0 ? "+" : ""}${houseNet.toLocaleString()} <span style="font-size:0.9rem;color:var(--text-muted);font-weight:600;">net units</span>` : `<span style="font-size:0.95rem;color:var(--text-muted);">Awaiting data</span>`,
      )}
      ${feature(
        "/insights/adu-dadu",
        "Small-scale housing",
        "ADU & DADU permit tracker",
        "Accessory dwelling unit permits by year, neighborhood, status, declared value, and recent activity.",
        aduTotal ? `${aduTotal.toLocaleString()} <span style="font-size:0.9rem;color:var(--text-muted);font-weight:600;">matching permits</span>` : `<span style="font-size:0.95rem;color:var(--text-muted);">Awaiting data</span>`,
      )}
      ${feature(
        "/insights/multifamily-pipeline",
        "Multifamily",
        "Multifamily construction pipeline",
        "Seattle apartment, condominium, townhouse, and multi-unit permit activity by stage and neighborhood.",
        `<span style="font-size:1.1rem;">Explore multifamily activity &rarr;</span>`,
      )}
      ${feature(
        "/insights/commercial-projects",
        "Commercial",
        "High-value commercial projects",
        "Seattle commercial permits valued at $1 million or more, with neighborhoods, status, and recent activity.",
        `<span style="font-size:1.1rem;">Explore commercial activity &rarr;</span>`,
      )}
      ${feature(
        "/insights/tenant-improvements",
        "Interiors",
        "Tenant-improvement activity",
        "Tenant-improvement and tenant-alteration permits by year, neighborhood, value, and recent activity.",
        `<span style="font-size:1.1rem;">Explore TI activity &rarr;</span>`,
      )}
      ${feature(
        "/insights/map",
        "Geography",
        "Construction activity map",
        "Permit counts and total construction value mapped across Seattle's neighborhoods.",
        mapNbhds ? `${mapNbhds.toLocaleString()} <span style="font-size:0.9rem;color:var(--text-muted);font-weight:600;">neighborhoods</span>` : `<span style="font-size:0.95rem;color:var(--text-muted);">Awaiting data</span>`,
      )}
      ${feature(
        "/insights/contractors",
        "Players",
        "Contractor scorecards",
        "Which contractors pull the most permits, the highest value, and have the widest neighborhood reach.",
        activeContractors ? `${activeContractors.toLocaleString()} <span style="font-size:0.9rem;color:var(--text-muted);font-weight:600;">active contractors</span>` : `<span style="font-size:0.95rem;color:var(--text-muted);">Awaiting data</span>`,
      )}
      ${feature(
        "/insights/network",
        "Connections",
        "Who builds where",
        "A network linking Seattle's busiest contractors to the neighborhoods they build in.",
        activeContractors ? `<span style="font-size:1.1rem;">Explore the network &rarr;</span>` : `<span style="font-size:0.95rem;color:var(--text-muted);">Awaiting data</span>`,
      )}
    </div>
    ${renderDataTrustNote(null, "Each report prints its inclusion rules and suppresses indexing when the supporting dataset is unavailable.")}`;

  return new Response(
    renderEntityDoc({ title, description, canonical, jsonLd, noindex: false, body, activeNav: "insights" }),
    { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=300" } },
  );
}

async function safeAll(env, sql, binds = []) {
  try {
    return (await env.DB.prepare(sql).bind(...binds).all()).results || [];
  } catch {
    return [];
  }
}
async function safeFirst(env, sql, binds = []) {
  try {
    return (await env.DB.prepare(sql).bind(...binds).first()) || null;
  } catch {
    return null;
  }
}

async function renderAddressPage(slug, env, request) {
  const canonical = `${BASE_URL}/address/${encodeURIComponent(slug)}`;
  const address = await safeFirst(env, "SELECT * FROM addresses WHERE slug = ?", [slug]);
  if (!address) {
    return render404({
      heading: "Address not found",
      message: "We do not have an aggregated property page for that address yet.",
    });
  }

  const [permits, projects, participants, neighborhood, related] = await Promise.all([
    safeAll(
      env,
      `SELECT p.*, c.name AS contractor_name, c.slug AS contractor_slug
       FROM permits p LEFT JOIN contractors c ON c.id = p.contractor_id
       WHERE p.address_id = ? ORDER BY COALESCE(p.issued_date, p.applied_date) DESC`,
      [address.id],
    ),
    safeAll(
      env,
      "SELECT * FROM projects WHERE address_id = ? ORDER BY latest_activity_date DESC",
      [address.id],
    ),
    safeAll(
      env,
      `SELECT o.name, o.slug, o.type_guess, pp.role, COUNT(*) AS cnt
       FROM permit_participants pp
       JOIN permits p ON p.id = pp.permit_id
       JOIN people_orgs o ON o.id = pp.people_org_id
       WHERE p.address_id = ? GROUP BY o.id, pp.role ORDER BY cnt DESC`,
      [address.id],
    ),
    safeFirst(
      env,
      `SELECT n.* FROM neighborhoods n JOIN address_neighborhoods an ON an.neighborhood_id = n.id WHERE an.address_id = ? LIMIT 1`,
      [address.id],
    ),
    safeAll(
      env,
      `SELECT a.slug, a.display_address, COUNT(p.id) AS permits
       FROM address_neighborhoods an
       JOIN addresses a ON a.id = an.address_id
       JOIN permits p ON p.address_id = a.id
       WHERE an.neighborhood_id = (SELECT neighborhood_id FROM address_neighborhoods WHERE address_id = ? LIMIT 1)
         AND a.id != ?
       GROUP BY a.id ORDER BY permits DESC LIMIT 6`,
      [address.id, address.id],
    ),
  ]);

  const permitCount = permits.length;
  const totalValue = permits.reduce((s, p) => s + (Number(p.value) || 0), 0);
  const dates = permits.map((p) => p.issued_date || p.applied_date).filter(Boolean).sort();
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  const activePermits = permits.filter((p) => ["active", "pending", "new"].includes(p.status));
  const display = address.display_address;
  const noindex = permitCount === 0;

  // Build SEO title/description from actual permit data instead of a generic template.
  // This helps match search intent for address queries ("what's being built at X?").
  const latestPermit = permits[0];  // Already sorted by date DESC via SQL
  const permitTypeLabel = latestPermit
    ? ({ commercial: "Commercial Construction", residential: "Residential Construction",
         industrial: "Industrial Construction", demolition: "Demolition" })[(latestPermit.type || "").toLowerCase()] ||
      (latestPermit.type ? latestPermit.type.charAt(0).toUpperCase() + latestPermit.type.slice(1).toLowerCase() : "Construction")
    : "Construction";
  const valueStr = totalValue ? `$${parseInt(totalValue).toLocaleString()}` : "";
  const latestContractor = latestPermit?.contractor_name || "";

  const title = activePermits.length > 0
    ? `${display} — Active ${permitTypeLabel} | Building Seattle`
    : `${display} — Construction Activity | Building Seattle`;

  let description = `Construction permits & projects at ${display} in Seattle.`;
  if (activePermits.length > 0) {
    description += ` ${activePermits.length} active${valueStr ? `, ${valueStr}` : ""}.`;
  } else if (permits.length > 0) {
    description += ` ${permits.length} permits on record${valueStr ? `, ${valueStr}` : ""}.`;
  }
  if (latestContractor) description += ` Contractor: ${latestContractor}.`;
  description += ` View full property history & nearby projects.`;

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Place",
        name: display,
        address: {
          "@type": "PostalAddress",
          streetAddress: entStreet(display),
          addressLocality: address.city || "Seattle",
          addressRegion: address.state || "WA",
          postalCode: address.zip || undefined,
          addressCountry: "US",
        },
        ...(address.lat && address.lng
          ? { geo: { "@type": "GeoCoordinates", latitude: address.lat, longitude: address.lng } }
          : {}),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Permits", item: `${BASE_URL}/permits` },
          { "@type": "ListItem", position: 3, name: display, item: canonical },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");

  const projectsHtml = projects.length
    ? `<ul class="ent-list">${projects
        .map(
          (pr) => `<li>
            <a class="ent-link" href="/project/${encodeURIComponent(pr.slug)}">${escapeHtml(pr.name)}</a>
            <div style="font-size:0.8rem;color:var(--text-muted);">${entMoney(pr.total_estimated_value)} · ${entDate(pr.first_seen_date)} – ${entDate(pr.latest_activity_date)} · confidence ${pr.confidence_score}</div>
          </li>`,
        )
        .join("")}</ul>`
    : `<p style="color:var(--text-muted);">No inferred projects yet.</p>`;

  const participantsHtml = participants.length
    ? `<ul class="ent-list">${participants
        .map(
          (o) => `<li>
            <a class="ent-link" href="/contractor/${encodeURIComponent(o.slug)}">${escapeHtml(o.name)}</a>
            <span class="pill" style="margin-left:0.4rem;">${escapeHtml(o.role)}</span>
            <span style="font-size:0.8rem;color:var(--text-muted);"> · ${o.cnt} permit${o.cnt > 1 ? "s" : ""}</span>
          </li>`,
        )
        .join("")}</ul>`
    : `<p style="color:var(--text-muted);">No participants on record.</p>`;

  const relatedHtml = related.length
    ? `<ul class="ent-list">${related
        .map(
          (a) => `<li><a class="ent-link" href="/address/${encodeURIComponent(a.slug)}">${escapeHtml(a.display_address)}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${a.permits} permits</span></li>`,
        )
        .join("")}</ul>`
    : "";

  const body = `
    ${entBreadcrumb([
      { label: "Home", href: "/" },
      ...(neighborhood ? [{ label: neighborhood.name, href: `/neighborhood/${encodeURIComponent(neighborhood.slug)}` }] : [{ label: "Permits", href: "/permits" }]),
      { label: display },
    ])}
    <div class="ent-hero">
      <div class="ent-kicker">Property / Address</div>
      <h1>${escapeHtml(display)}</h1>
      ${neighborhood ? `<a class="ent-link" href="/neighborhood/${encodeURIComponent(neighborhood.slug)}">${escapeHtml(neighborhood.name)}</a>` : ""}
    </div>
    <div style="max-width:var(--container-max);margin:0 auto 2.5rem;padding:0 1.5rem;">
      <div class="card" style="margin-bottom:0;">
        <div style="font-size:1.05rem;line-height:1.85;color:var(--text-muted);">
          <p style="margin:0 0 1rem;">${escapeHtml(display)} is a property in Seattle${neighborhood ? `'s <a class="ent-link" href="/neighborhood/${encodeURIComponent(neighborhood.slug)}">${escapeHtml(neighborhood.name)}</a> neighborhood` : ""} with <strong style="color:var(--text);">${permitCount} construction permit${permitCount !== 1 ? "s" : ""}</strong> on record with the Seattle Department of Construction and Inspections${activePermits.length > 0 ? `, <strong style="color:var(--text);">${activePermits.length} of which ${activePermits.length === 1 ? "is" : "are"} currently active</strong>` : ""}.${totalValue > 0 ? ` The combined estimated project value across all permits is <strong style="color:var(--text);">$${parseInt(totalValue).toLocaleString()}</strong>.` : ""}</p>
          <p style="margin:0 0 1rem;">Permit activity at this address spans from ${firstDate ? new Date(firstDate).toLocaleDateString("en-US", {year:"numeric",month:"long"}) : "the earliest record"} to ${lastDate ? new Date(lastDate).toLocaleDateString("en-US", {year:"numeric",month:"long"}) : "the present"}${latestPermit ? `, with the most recent permit being a ${(latestPermit.type || "construction").toLowerCase()} project filed under permit number <a class="ent-link" href="/permits/${encodeURIComponent(latestPermit.permit_number)}">${escapeHtml(latestPermit.permit_number)}</a>` : ""}.${latestContractor ? ` The latest contractor associated with this address is <a class="ent-link" href="/contractor/${encodeURIComponent(latestPermit?.contractor_slug || "")}">${escapeHtml(latestContractor)}</a>.` : ""}</p>
          <p style="margin:0;">Use the data below to review individual permit records, track project timelines, see which contractors and participants have been involved, and explore nearby construction activity. Each permit links to its own detail page with review cycles, status changes, and project descriptions.</p>
        </div>
      </div>
    </div>
    <div class="ent-grid">
      <div>
        <div class="card">
          <h2>Summary</h2>
          <div class="stat-row">
            ${entStat("Permits", permitCount)}
            ${entStat("Total value", entMoney(totalValue))}
            ${entStat("Active / recent", activePermits.length)}
            ${entStat("Projects", projects.length)}
          </div>
          <div style="font-size:0.85rem;color:var(--text-muted);">First permit ${entDate(firstDate)} · Latest permit ${entDate(lastDate)}</div>
        </div>
        <div class="card">
          <h2>Permit records (${permitCount})</h2>
          ${entPermitRows(permits)}
        </div>
      </div>
      <div>
        <div class="card">
          <h3>Inferred projects</h3>
          ${projectsHtml}
        </div>
        <div class="card">
          <h3>Contractors &amp; participants</h3>
          ${participantsHtml}
        </div>
        ${relatedHtml ? `<div class="card"><h3>Nearby &amp; related addresses</h3>${relatedHtml}</div>` : ""}
      </div>
    </div>`;

  return new Response(
    renderEntityDoc({
      title,
      description,
      canonical,
      jsonLd,
      noindex,
      ogType: "place",
      body: `${body}${renderDataTrustNote(latestPermitActivity(permits), "Property totals aggregate public permit records; declared value is not verified project cost.")}`,
    }),
    { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" } },
  );
}

async function renderProjectPage(slug, env, request) {
  const canonical = `${BASE_URL}/project/${encodeURIComponent(slug)}`;
  const project = await safeFirst(
    env,
    `SELECT pr.*, a.display_address, a.slug AS address_slug, a.city, a.state
     FROM projects pr LEFT JOIN addresses a ON a.id = pr.address_id WHERE pr.slug = ?`,
    [slug],
  );
  if (!project) {
    return render404({ heading: "Project not found", message: "We have not clustered a project under that name yet." });
  }

  const [permits, participants, neighborhood] = await Promise.all([
    safeAll(
      env,
      `SELECT p.*, c.name AS contractor_name, c.slug AS contractor_slug
       FROM project_permits jp JOIN permits p ON p.id = jp.permit_id
       LEFT JOIN contractors c ON c.id = p.contractor_id
       WHERE jp.project_id = ? ORDER BY COALESCE(p.issued_date, p.applied_date) DESC`,
      [project.id],
    ),
    safeAll(
      env,
      `SELECT o.name, o.slug, o.type_guess, pp.role FROM project_participants pp
       JOIN people_orgs o ON o.id = pp.people_org_id WHERE pp.project_id = ? ORDER BY pp.role`,
      [project.id],
    ),
    safeFirst(
      env,
      `SELECT n.* FROM neighborhoods n JOIN address_neighborhoods an ON an.neighborhood_id = n.id WHERE an.address_id = ? LIMIT 1`,
      [project.address_id],
    ),
  ]);

  const noindex = permits.length === 0;
  const title = `${project.name} | Seattle Construction Activity`;
  const description = `Track permits, contractors, address history, estimated values, and recent construction activity for ${project.name}.`;

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CreativeWork",
        name: project.name,
        abstract: project.description_summary || undefined,
        url: canonical,
        dateCreated: project.first_seen_date || undefined,
        dateModified: project.latest_activity_date || undefined,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          ...(project.address_slug
            ? [{ "@type": "ListItem", position: 2, name: project.display_address, item: `${BASE_URL}/address/${encodeURIComponent(project.address_slug)}` }]
            : []),
          { "@type": "ListItem", position: project.address_slug ? 3 : 2, name: project.name, item: canonical },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");

  const participantsHtml = participants.length
    ? `<ul class="ent-list">${participants
        .map(
          (o) => `<li><a class="ent-link" href="/contractor/${encodeURIComponent(o.slug)}">${escapeHtml(o.name)}</a> <span class="pill" style="margin-left:0.4rem;">${escapeHtml(o.role)}</span></li>`,
        )
        .join("")}</ul>`
    : `<p style="color:var(--text-muted);">No participants on record.</p>`;

  const body = `
    ${entBreadcrumb([
      { label: "Home", href: "/" },
      ...(project.address_slug ? [{ label: project.display_address, href: `/address/${encodeURIComponent(project.address_slug)}` }] : [{ label: "Permits", href: "/permits" }]),
      { label: project.name },
    ])}
    <div class="ent-hero">
      <div class="ent-kicker">Inferred Project · confidence ${project.confidence_score}</div>
      <h1>${escapeHtml(project.name)}</h1>
      ${project.address_slug ? `<a class="ent-link" href="/address/${encodeURIComponent(project.address_slug)}">${escapeHtml(project.display_address)}</a>` : ""}
      ${neighborhood ? ` · <a class="ent-link" href="/neighborhood/${encodeURIComponent(neighborhood.slug)}">${escapeHtml(neighborhood.name)}</a>` : ""}
    </div>
    <div class="ent-grid">
      <div>
        <div class="card">
          <h2>Summary</h2>
          <div class="stat-row">
            ${entStat("Permits", permits.length)}
            ${entStat("Est. value", entMoney(project.total_estimated_value))}
            ${entStat("First activity", entDate(project.first_seen_date))}
            ${entStat("Latest activity", entDate(project.latest_activity_date))}
          </div>
          ${project.description_summary ? `<p style="margin-top:0.5rem;">${escapeHtml(project.description_summary)}</p>` : ""}
        </div>
        ${renderProjectReviewSummary(permits)}
        <div class="card">
          <h2>Permit records (${permits.length})</h2>
          ${entPermitRows(permits)}
        </div>
      </div>
      <div>
        <div class="card">
          <h3>Participants</h3>
          ${participantsHtml}
        </div>
        <div class="card">
          <h3>About this project</h3>
          <p style="font-size:0.85rem;color:var(--text-muted);margin:0;">This project was inferred by grouping related permits at the same address. Confidence score ${project.confidence_score}/100 reflects how strongly the permits appear to belong to a single effort.</p>
        </div>
      </div>
    </div>`;

  return new Response(
    renderEntityDoc({
      title,
      description,
      canonical,
      jsonLd,
      noindex,
      ogType: "article",
      body: `${body}${renderDataTrustNote(project.latest_activity_date || latestPermitActivity(permits), "Projects are inferred permit groups, not verified completed developments.")}`,
    }),
    { headers: { "Content-Type": "text/html" } },
  );
}

async function renderNeighborhoodPage(slug, env, request) {
  const canonical = `${BASE_URL}/neighborhood/${encodeURIComponent(slug)}`;
  const nb = await safeFirst(env, "SELECT * FROM neighborhoods WHERE slug = ?", [slug]);
  if (!nb) {
    return render404({ heading: "Neighborhood not found", message: "We do not track that neighborhood yet." });
  }

  const [recentPermits, projects, topContractors, totals, topAddresses] = await Promise.all([
    safeAll(
      env,
      `SELECT p.*, a.slug AS addr_slug, a.display_address, c.name AS contractor_name, c.slug AS contractor_slug
       FROM permits p
       JOIN address_neighborhoods an ON an.address_id = p.address_id
       JOIN addresses a ON a.id = p.address_id
       LEFT JOIN contractors c ON c.id = p.contractor_id
       WHERE an.neighborhood_id = ?
       ORDER BY COALESCE(p.issued_date, p.applied_date) DESC LIMIT 15`,
      [nb.id],
    ),
    safeAll(
      env,
      `SELECT pr.*, a.display_address, a.slug AS address_slug
       FROM projects pr
       JOIN address_neighborhoods an ON an.address_id = pr.address_id
       LEFT JOIN addresses a ON a.id = pr.address_id
       WHERE an.neighborhood_id = ? ORDER BY pr.latest_activity_date DESC LIMIT 10`,
      [nb.id],
    ),
    safeAll(
      env,
      `SELECT o.name, o.slug, COUNT(*) AS cnt FROM permit_participants pp
       JOIN permits p ON p.id = pp.permit_id
       JOIN address_neighborhoods an ON an.address_id = p.address_id
       JOIN people_orgs o ON o.id = pp.people_org_id
       WHERE an.neighborhood_id = ? AND pp.role = 'contractor'
       GROUP BY o.id ORDER BY cnt DESC LIMIT 10`,
      [nb.id],
    ),
    safeFirst(
      env,
      `SELECT COUNT(DISTINCT p.id) AS permits, COALESCE(SUM(p.value),0) AS total_value
       FROM permits p JOIN address_neighborhoods an ON an.address_id = p.address_id
       WHERE an.neighborhood_id = ?`,
      [nb.id],
    ),
    safeAll(
      env,
      `SELECT a.slug, a.display_address, COUNT(p.id) AS permits
       FROM addresses a JOIN address_neighborhoods an ON an.address_id = a.id
       JOIN permits p ON p.address_id = a.id
       WHERE an.neighborhood_id = ? GROUP BY a.id ORDER BY permits DESC LIMIT 10`,
      [nb.id],
    ),
  ]);

  const permitCount = Number(totals?.permits) || 0;
  const totalValue = Number(totals?.total_value) || 0;
  const noindex = permitCount === 0;
  const title = `${nb.name} Seattle Construction Permits & Development Activity`;
  const description = `Recent permits, active projects, top contractors, estimated values, and the most active addresses in ${nb.name}, Seattle.`;

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
      { "@type": "ListItem", position: 2, name: "Permits", item: `${BASE_URL}/permits` },
      { "@type": "ListItem", position: 3, name: nb.name, item: canonical },
    ],
  }).replace(/</g, "\\u003c");

  const listOrEmpty = (rows, fn, empty) =>
    rows.length ? `<ul class="ent-list">${rows.map(fn).join("")}</ul>` : `<p style="color:var(--text-muted);">${empty}</p>`;

  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Permits", href: "/permits" }, { label: nb.name }])}
    <div class="ent-hero">
      <div class="ent-kicker">Neighborhood</div>
      <h1>${escapeHtml(nb.name)}</h1>
    </div>
    <div class="card">
      <div class="stat-row">
        ${entStat("Permits", permitCount)}
        ${entStat("Total value", entMoney(totalValue))}
        ${entStat("Active projects", projects.length)}
        ${entStat("Top contractors", topContractors.length)}
      </div>
    </div>
    <div class="ent-grid">
      <div>
        <div class="card">
          <h2>Recent permits</h2>
          ${entPermitRows(recentPermits)}
        </div>
        <div class="card">
          <h2>Active projects</h2>
          ${listOrEmpty(
            projects,
            (pr) =>
              `<li><a class="ent-link" href="/project/${encodeURIComponent(pr.slug)}">${escapeHtml(pr.name)}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${entMoney(pr.total_estimated_value)} · ${entDate(pr.latest_activity_date)}</span></li>`,
            "No active projects yet.",
          )}
        </div>
      </div>
      <div>
        <div class="card">
          <h3>Top contractors</h3>
          ${listOrEmpty(
            topContractors,
            (c) => `<li><a class="ent-link" href="/contractor/${encodeURIComponent(c.slug)}">${escapeHtml(c.name)}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${c.cnt} permits</span></li>`,
            "No contractors on record.",
          )}
        </div>
        <div class="card">
          <h3>Most active addresses</h3>
          ${listOrEmpty(
            topAddresses,
            (a) => `<li><a class="ent-link" href="/address/${encodeURIComponent(a.slug)}">${escapeHtml(a.display_address)}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${a.permits} permits</span></li>`,
            "No addresses on record.",
          )}
        </div>
      </div>
    </div>`;

  return new Response(
    renderEntityDoc({
      title,
      description,
      canonical,
      jsonLd,
      noindex,
      body: `${body}${renderDataTrustNote(latestPermitActivity(recentPermits), "Neighborhood totals aggregate public permit records and do not represent completed projects or housing units.")}`,
    }),
    { headers: { "Content-Type": "text/html" } },
  );
}

// People/org-backed contractor page (owners, applicants, architects, and any
// contractor not present in the curated `contractors` table). Backed by
// permit_participants so /contractor/:slug works for the whole graph.
async function renderOrgContractorPage(slug, env, request) {
  const canonical = `${BASE_URL}/contractor/${encodeURIComponent(slug)}`;
  const org = await safeFirst(env, "SELECT * FROM people_orgs WHERE slug = ?", [slug]);
  if (!org) {
    return render404({
      heading: "Contractor not found",
      message: "We do not have a profile for that contractor yet.",
    });
  }

  const [permits, addresses, projects, neighborhoods, roles] = await Promise.all([
    safeAll(
      env,
      `SELECT p.*, a.slug AS addr_slug, a.display_address
       FROM permit_participants pp JOIN permits p ON p.id = pp.permit_id
       LEFT JOIN addresses a ON a.id = p.address_id
       WHERE pp.people_org_id = ? ORDER BY COALESCE(p.issued_date, p.applied_date) DESC LIMIT 50`,
      [org.id],
    ),
    safeAll(
      env,
      `SELECT a.slug, a.display_address, COUNT(p.id) AS permits, COALESCE(SUM(p.value),0) AS total_value
       FROM permit_participants pp JOIN permits p ON p.id = pp.permit_id
       JOIN addresses a ON a.id = p.address_id
       WHERE pp.people_org_id = ? GROUP BY a.id ORDER BY permits DESC LIMIT 12`,
      [org.id],
    ),
    safeAll(
      env,
      `SELECT DISTINCT pr.slug, pr.name, pr.latest_activity_date, pr.total_estimated_value
       FROM permit_participants pp JOIN permits p ON p.id = pp.permit_id
       JOIN projects pr ON pr.id = p.project_id
       WHERE pp.people_org_id = ? ORDER BY pr.latest_activity_date DESC LIMIT 12`,
      [org.id],
    ),
    safeAll(
      env,
      `SELECT n.name, n.slug, COUNT(*) AS cnt FROM permit_participants pp
       JOIN permits p ON p.id = pp.permit_id
       JOIN address_neighborhoods an ON an.address_id = p.address_id
       JOIN neighborhoods n ON n.id = an.neighborhood_id
       WHERE pp.people_org_id = ? GROUP BY n.id ORDER BY cnt DESC LIMIT 5`,
      [org.id],
    ),
    safeAll(env, `SELECT DISTINCT role FROM permit_participants WHERE people_org_id = ?`, [org.id]),
  ]);

  const totalValue = permits.reduce((s, p) => s + (Number(p.value) || 0), 0);
  const activeCount = permits.filter((p) => ["active", "pending", "new"].includes(p.status)).length;
  const roleLabels = roles.map((r) => r.role).join(", ") || "participant";
  const noindex = permits.length === 0;
  const isOrg = org.type_guess === "organization";

  const title = `${org.name} Seattle Permit & Construction Activity`;
  const description = `See permits, projects, addresses, estimated values, and recent construction activity associated with ${org.name} in Seattle.`;

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      isOrg
        ? {
            "@type": "Organization",
            name: org.name,
            url: canonical,
            address: { "@type": "PostalAddress", addressLocality: "Seattle", addressRegion: "WA", addressCountry: "US" },
          }
        : { "@type": "Person", name: org.name, url: canonical },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Permits", item: `${BASE_URL}/permits` },
          { "@type": "ListItem", position: 3, name: org.name, item: canonical },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");

  const listOrEmpty = (rows, fn, empty) =>
    rows.length ? `<ul class="ent-list">${rows.map(fn).join("")}</ul>` : `<p style="color:var(--text-muted);">${empty}</p>`;

  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Permits", href: "/permits" }, { label: org.name }])}
    <div class="ent-hero">
      <div class="ent-kicker">${escapeHtml(isOrg ? "Organization" : "Person")} · ${escapeHtml(roleLabels)}</div>
      <h1>${escapeHtml(org.name)}</h1>
    </div>
    <div class="card">
      <div class="stat-row">
        ${entStat("Permits", permits.length)}
        ${entStat("Active / recent", activeCount)}
        ${entStat("Total value", entMoney(totalValue))}
        ${entStat("Addresses", addresses.length)}
      </div>
    </div>
    <div class="ent-grid">
      <div>
        <div class="card">
          <h2>Recent activity</h2>
          ${entPermitRows(permits.slice(0, 20))}
        </div>
        <div class="card">
          <h2>Inferred projects</h2>
          ${listOrEmpty(
            projects,
            (pr) => `<li><a class="ent-link" href="/project/${encodeURIComponent(pr.slug)}">${escapeHtml(pr.name)}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${entMoney(pr.total_estimated_value)} · ${entDate(pr.latest_activity_date)}</span></li>`,
            "No inferred projects yet.",
          )}
        </div>
      </div>
      <div>
        <div class="card">
          <h3>Addresses worked on</h3>
          ${listOrEmpty(
            addresses,
            (a) => `<li><a class="ent-link" href="/address/${encodeURIComponent(a.slug)}">${escapeHtml(a.display_address)}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${a.permits} permits</span></li>`,
            "No addresses on record.",
          )}
        </div>
        <div class="card">
          <h3>Most common neighborhoods</h3>
          ${listOrEmpty(
            neighborhoods,
            (n) => `<li><a class="ent-link" href="/neighborhood/${encodeURIComponent(n.slug)}">${escapeHtml(n.name)}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${n.cnt} permits</span></li>`,
            "No neighborhood data.",
          )}
        </div>
      </div>
    </div>`;

  return new Response(
    renderEntityDoc({
      title,
      description,
      canonical,
      jsonLd,
      noindex,
      ogType: "profile",
      body: `${body}${renderDataTrustNote(latestPermitActivity(permits), "Participant matching follows names in public permit records and may combine or separate similarly named entities.")}`,
    }),
    { headers: { "Content-Type": "text/html" } },
  );
}

async function logIngest(
  env,
  { run_type, source, status, records_added = 0, records_updated = 0, error_message = null, start_time, end_time },
) {
  const stmt = env.DB.prepare(`
    INSERT INTO ingest_logs (run_type, source, status, records_added, records_updated, error_message, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  await stmt
    .bind(
      run_type,
      source,
      status,
      records_added,
      records_updated,
      error_message,
      start_time.toISOString().replace("T", " ").split(".")[0],
      end_time.toISOString().replace("T", " ").split(".")[0],
    )
    .run();
}

const SDCI_PERMIT_URL = "https://data.seattle.gov/resource/k44w-2dcq.json";
const SCHEDULED_INGEST_LIMIT = 5000;
const SCHEDULED_INGEST_PAGE_SIZE = 1000;

const NEIGHBORHOOD_BOUNDS = [
  ["Ballard", 47.668, 47.692, -122.41, -122.37],
  ["Crown Hill", 47.692, 47.71, -122.39, -122.37],
  ["Fremont", 47.65, 47.668, -122.37, -122.34],
  ["Phinney Ridge", 47.668, 47.692, -122.37, -122.35],
  ["Greenwood", 47.692, 47.71, -122.37, -122.34],
  ["Broadview", 47.71, 47.735, -122.37, -122.34],
  ["Bitter Lake", 47.71, 47.735, -122.36, -122.335],
  ["Magnolia", 47.63, 47.67, -122.42, -122.385],
  ["Interbay", 47.64, 47.66, -122.385, -122.365],
  ["Green Lake", 47.668, 47.692, -122.36, -122.325],
  ["Wallingford", 47.65, 47.668, -122.34, -122.315],
  ["Roosevelt", 47.668, 47.685, -122.325, -122.31],
  ["Maple Leaf", 47.685, 47.71, -122.325, -122.3],
  ["Northgate", 47.7, 47.72, -122.34, -122.31],
  ["Licton Springs", 47.692, 47.71, -122.345, -122.325],
  ["Haller Lake", 47.715, 47.735, -122.345, -122.32],
  ["Pinehurst", 47.72, 47.74, -122.32, -122.295],
  ["University District", 47.65, 47.668, -122.315, -122.29],
  ["Ravenna", 47.668, 47.688, -122.31, -122.28],
  ["Wedgwood", 47.685, 47.7, -122.3, -122.28],
  ["View Ridge", 47.68, 47.695, -122.28, -122.26],
  ["Sand Point", 47.68, 47.695, -122.27, -122.25],
  ["Laurelhurst", 47.66, 47.68, -122.285, -122.265],
  ["Bryant", 47.668, 47.685, -122.29, -122.27],
  ["Meadowbrook", 47.7, 47.715, -122.3, -122.28],
  ["Lake City", 47.71, 47.735, -122.3, -122.27],
  ["Olympic Hills", 47.72, 47.74, -122.3, -122.275],
  ["Queen Anne", 47.625, 47.65, -122.37, -122.345],
  ["South Lake Union", 47.62, 47.635, -122.345, -122.325],
  ["Eastlake", 47.635, 47.65, -122.335, -122.32],
  ["Capitol Hill", 47.61, 47.64, -122.325, -122.3],
  ["First Hill", 47.6, 47.615, -122.33, -122.315],
  ["Central District", 47.6, 47.62, -122.31, -122.29],
  ["Madrona", 47.608, 47.625, -122.295, -122.28],
  ["Leschi", 47.596, 47.608, -122.295, -122.28],
  ["Madison Park", 47.63, 47.645, -122.29, -122.27],
  ["Madison Valley", 47.625, 47.64, -122.3, -122.285],
  ["Montlake", 47.64, 47.655, -122.31, -122.29],
  ["Downtown", 47.6, 47.62, -122.345, -122.325],
  ["Belltown", 47.612, 47.622, -122.355, -122.34],
  ["Pioneer Square", 47.598, 47.605, -122.34, -122.325],
  ["International District", 47.593, 47.602, -122.33, -122.315],
  ["SoDo", 47.565, 47.595, -122.345, -122.32],
  ["Georgetown", 47.54, 47.565, -122.34, -122.31],
  ["Beacon Hill", 47.555, 47.6, -122.315, -122.295],
  ["North Beacon Hill", 47.575, 47.6, -122.315, -122.295],
  ["Mt Baker", 47.57, 47.59, -122.295, -122.28],
  ["Columbia City", 47.555, 47.575, -122.295, -122.275],
  ["Hillman City", 47.545, 47.558, -122.295, -122.275],
  ["Rainier Beach", 47.505, 47.535, -122.275, -122.245],
  ["Seward Park", 47.53, 47.56, -122.27, -122.25],
  ["Rainier Valley", 47.52, 47.555, -122.3, -122.27],
  ["South Park", 47.52, 47.54, -122.34, -122.315],
  ["Dunlap", 47.53, 47.545, -122.28, -122.26],
  ["West Seattle", 47.53, 47.6, -122.42, -122.345],
  ["Admiral", 47.57, 47.585, -122.41, -122.38],
  ["Alki", 47.576, 47.592, -122.42, -122.4],
  ["White Center", 47.505, 47.53, -122.38, -122.345],
];

async function runScheduledIngest(env) {
  const startTime = new Date();

  try {
    const rawPermits = await fetchSdciPermits();
    const { permits, contractors } = normalizeSdciPermits(rawPermits);

    await upsertScheduledContractors(env, contractors);
    const { added, updated } = await upsertScheduledPermits(env, permits);

    // Keep the derived entity graph (addresses / projects / orgs) fresh.
    try {
      await rebuildEntityGraph(env);
    } catch (graphError) {
      console.error("Entity graph rebuild failed:", graphError);
    }
    const alertDelivery = await sendPendingPermitAlerts(env);

    await logIngest(env, {
      run_type: "scheduled",
      source: "seattle_open_data",
      status: "success",
      records_added: added,
      records_updated: updated,
      start_time: startTime,
      end_time: new Date(),
    });

    console.log(
      `Scheduled ingest complete: ${added} added, ${updated} updated, ${alertDelivery.sent} alerts sent`,
    );
    return { added, updated, contractors: contractors.length, alerts_sent: alertDelivery.sent };
  } catch (error) {
    console.error("Scheduled ingest failed:", error);
    await logIngest(env, {
      run_type: "scheduled",
      source: "seattle_open_data",
      status: "error",
      error_message: error.message,
      start_time: startTime,
      end_time: new Date(),
    });
    throw error;
  }
}

async function fetchSdciPermits(total = SCHEDULED_INGEST_LIMIT, pageSize = SCHEDULED_INGEST_PAGE_SIZE) {
  const selectFields = [
    "permitnum",
    "permitclass",
    "permitclassmapped",
    "permittypemapped",
    "permittypedesc",
    "description",
    "housingunits",
    "statuscurrent",
    "originaladdress1",
    "originalcity",
    "originalstate",
    "originalzip",
    "contractorcompanyname",
    "link",
    "latitude",
    "longitude",
    "applieddate",
    "issueddate",
    "expiresdate",
    "completeddate",
    "estprojectcost",
    "readytoissuedate",
    "planreviewcompletedate",
    "zoning",
    "housingcategory",
    "dwellingunittype",
    "parentpermitnum",
    "relatedmup",
    "numberreviewcycles",
    "totaldaysplanreview",
    "daysoutcorrections",
    "housingunitsadded",
    "housingunitsremoved",
  ].join(",");
  const records = [];

  for (let offset = 0; offset < total; offset += pageSize) {
    const limit = Math.min(pageSize, total - offset);
    const url = new URL(SDCI_PERMIT_URL);
    url.searchParams.set("$select", selectFields);
    url.searchParams.set("$limit", String(limit));
    url.searchParams.set("$offset", String(offset));
    url.searchParams.set("$order", "applieddate DESC");
    url.searchParams.set("$where", "applieddate > '2022-01-01'");

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": "BuildingSeattle-Worker/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Seattle Open Data returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }

    const page = await response.json();
    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    records.push(...page);
    if (page.length < limit) {
      break;
    }
  }

  return records;
}

function normalizeSdciPermits(rawPermits) {
  const permits = [];
  const contractorsBySlug = new Map();

  for (const item of rawPermits) {
    const permitNumber = item.permitnum;
    if (!permitNumber) {
      continue;
    }

    const contractorName = String(item.contractorcompanyname || "").trim();
    if (contractorName && !["n/a", "none"].includes(contractorName.toLowerCase())) {
      const slug = slugify(contractorName);
      if (slug && !contractorsBySlug.has(slug)) {
        contractorsBySlug.set(slug, {
          name: contractorName,
          slug,
          specialty: item.permitclass || "General",
        });
      }
    }

    const address = [item.originaladdress1 || "", item.originalcity || "Seattle", item.originalstate || "WA"]
      .filter(Boolean)
      .join(", ");

    permits.push({
      permit_number: permitNumber,
      contractor_name: contractorName && !["n/a", "none"].includes(contractorName.toLowerCase()) ? contractorName : "",
      applicant_name: "",
      address: address || "Seattle, WA",
      neighborhood: detectNeighborhood(item.latitude, item.longitude),
      type: classifyPermitType(item.permitclass, item.permittypemapped),
      value: extractValue(item.estprojectcost),
      status: mapPermitStatus(item.statuscurrent),
      description: item.description || "No description",
      housing_units: parseInt(item.housingunits || "0", 10) || 0,
      housing_units_added: intOrNull(item.housingunitsadded),
      housing_units_removed: intOrNull(item.housingunitsremoved),
      housing_category: cleanFeedText(item.housingcategory),
      dwelling_unit_type: cleanFeedText(item.dwellingunittype),
      zoning: cleanFeedText(item.zoning),
      parent_permit_number: cleanFeedText(item.parentpermitnum),
      related_mup: cleanFeedText(item.relatedmup),
      number_review_cycles: intOrNull(item.numberreviewcycles),
      total_days_plan_review: intOrNull(item.totaldaysplanreview),
      days_out_corrections: intOrNull(item.daysoutcorrections),
      plan_review_complete_date: extractDate(item.planreviewcompletedate),
      ready_to_issue_date: extractDate(item.readytoissuedate),
      applied_date: extractDate(item.applieddate),
      issued_date: extractDate(item.issueddate),
      completed_date: extractDate(item.completeddate),
    });
  }

  return { permits, contractors: [...contractorsBySlug.values()] };
}

async function upsertScheduledContractors(env, contractors) {
  for (let i = 0; i < contractors.length; i += 100) {
    const batch = contractors.slice(i, i + 100).map((contractor) =>
      env.DB.prepare(
        `
      INSERT INTO contractors (name, slug, specialty)
      VALUES (?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        specialty = COALESCE(excluded.specialty, contractors.specialty),
        updated_at = CURRENT_TIMESTAMP
    `,
      ).bind(contractor.name, contractor.slug, contractor.specialty || null),
    );

    if (batch.length) {
      await env.DB.batch(batch);
    }
  }
}

async function upsertScheduledPermits(env, permits) {
  let added = 0;
  let updated = 0;
  const { results: allContractors } = await env.DB.prepare("SELECT id, name FROM contractors").all();
  const contractorMap = new Map(
    (allContractors || []).map((contractor) => [contractor.name.toLowerCase(), contractor.id]),
  );

  for (let i = 0; i < permits.length; i += 100) {
    const batchPermits = permits.slice(i, i + 100);
    const permitNumbers = batchPermits.map((permit) => permit.permit_number).filter(Boolean);
    const existingStatuses = await getExistingPermitStatuses(env, permitNumbers);
    const statusChanges = [];

    const statements = batchPermits.map((permit) => {
      const incomingStatus = normalizeStoredStatus(permit.status);
      if (existingStatuses.has(permit.permit_number)) {
        updated++;
        const previousStatus = normalizeStoredStatus(existingStatuses.get(permit.permit_number));
        if (previousStatus !== incomingStatus) {
          statusChanges.push({
            permit_number: permit.permit_number,
            previous_status: previousStatus,
            new_status: incomingStatus,
          });
        }
      } else {
        added++;
      }

      const contractorId = permit.contractor_name
        ? contractorMap.get(permit.contractor_name.toLowerCase()) || null
        : null;

      return env.DB.prepare(PERMIT_UPSERT_SQL).bind(
        permit.permit_number,
        contractorId,
        permit.applicant_name || null,
        permit.address,
        permit.neighborhood || null,
        permit.type || null,
        permit.value || null,
        incomingStatus,
        permit.description || null,
        permit.housing_units || 0,
        permit.applied_date || null,
        permit.issued_date || null,
        permit.completed_date || null,
        intOrNull(permit.housing_units_added),
        intOrNull(permit.housing_units_removed),
        permit.housing_category || null,
        permit.dwelling_unit_type || null,
        permit.zoning || null,
        permit.parent_permit_number || null,
        permit.related_mup || null,
        intOrNull(permit.number_review_cycles),
        intOrNull(permit.total_days_plan_review),
        intOrNull(permit.days_out_corrections),
        dateOrNull(permit.plan_review_complete_date),
        dateOrNull(permit.ready_to_issue_date),
      );
    });

    const reclassifyStatement = buildAduReclassificationStatement(env, permitNumbers);
    if (reclassifyStatement) statements.push(reclassifyStatement);
    statements.push(...buildStatusChangeStatements(env, statusChanges));

    if (statements.length) {
      await env.DB.batch(statements);
    }
  }

  return { added, updated };
}

async function getExistingPermitStatuses(env, permitNumbers) {
  const existingStatuses = new Map();
  if (!permitNumbers.length) {
    return existingStatuses;
  }

  const placeholders = permitNumbers.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT permit_number, status FROM permits WHERE permit_number IN (${placeholders})`,
  )
    .bind(...permitNumbers)
    .all();

  for (const row of results || []) {
    existingStatuses.set(row.permit_number, row.status);
  }

  return existingStatuses;
}

function buildStatusChangeStatements(env, statusChanges) {
  return statusChanges.map((change) =>
    env.DB.prepare(
      `
      INSERT INTO permit_status_changes (permit_number, previous_status, new_status)
      VALUES (?, ?, ?)
    `,
    ).bind(change.permit_number, change.previous_status || null, change.new_status || "new"),
  );
}

function detectNeighborhood(lat, lng) {
  if (!lat || !lng) {
    return "Other";
  }

  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  if (Number.isNaN(parsedLat) || Number.isNaN(parsedLng)) {
    return "Other";
  }

  for (const [name, minLat, maxLat, minLng, maxLng] of NEIGHBORHOOD_BOUNDS) {
    if (parsedLat >= minLat && parsedLat <= maxLat && parsedLng >= minLng && parsedLng <= maxLng) {
      return name;
    }
  }

  if (parsedLat >= 47.49 && parsedLat <= 47.74 && parsedLng >= -122.44 && parsedLng <= -122.24) {
    return "Other Seattle";
  }

  return "Other";
}

function classifyPermitType(permitClass, permitTypeMapped) {
  const permitClassValue = String(permitClass || "").toLowerCase();
  if (["commercial", "institutional"].includes(permitClassValue)) {
    return "commercial";
  }
  if (["single family/duplex", "multifamily"].includes(permitClassValue)) {
    return "residential";
  }
  if (permitClassValue === "industrial") {
    return "industrial";
  }
  if (permitClassValue === "vacant land") {
    return "land";
  }

  const mappedValue = String(permitTypeMapped || "").toLowerCase();
  if (mappedValue.includes("demolition")) {
    return "demolition";
  }
  if (mappedValue.includes("grading")) {
    return "grading";
  }
  if (mappedValue.includes("roof")) {
    return "residential";
  }

  return "other";
}

function extractValue(value) {
  if (!value) {
    return 0;
  }

  const parsed = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function mapPermitStatus(status) {
  const value = String(status || "").toLowerCase();
  if (!value) {
    return "new";
  }
  if (value.includes("issue") || value.includes("active") || value.includes("approved")) {
    return "active";
  }
  if (value.includes("pending") || value.includes("review") || value.includes("applied")) {
    return "pending";
  }
  if (value.includes("complete") || value.includes("final") || value.includes("closed")) {
    return "completed";
  }
  if (value.includes("expir")) {
    return "expired";
  }
  if (value.includes("cancel")) {
    return "cancelled";
  }
  return "new";
}

function extractDate(value) {
  if (!value) {
    return null;
  }

  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function ingestPermit(request, env) {
  const data = await request.json();
  const incomingStatus = normalizeStoredStatus(data.status);
  const existingPermit = data.permit_number
    ? await env.DB.prepare(`SELECT status FROM permits WHERE permit_number = ?`).bind(data.permit_number).first()
    : null;

  // Resolve contractor_id from contractor_name if provided
  let contractorId = null;
  if (data.contractor_name) {
    const contractor = await env.DB.prepare(`SELECT id FROM contractors WHERE name = ? COLLATE NOCASE`)
      .bind(data.contractor_name)
      .first();
    if (contractor) {
      contractorId = contractor.id;
    }
  }

  const stmt = env.DB.prepare(PERMIT_UPSERT_SQL);

  await stmt
    .bind(
      data.permit_number,
      contractorId,
      data.applicant_name || null,
      data.address,
      data.neighborhood || null,
      data.type || null,
      data.value || null,
      incomingStatus,
      data.description || null,
      data.housing_units || 0,
      data.applied_date || null,
      data.issued_date || null,
      data.completed_date || null,
      intOrNull(data.housing_units_added),
      intOrNull(data.housing_units_removed),
      data.housing_category || null,
      data.dwelling_unit_type || null,
      data.zoning || null,
      data.parent_permit_number || null,
      data.related_mup || null,
      intOrNull(data.number_review_cycles),
      intOrNull(data.total_days_plan_review),
      intOrNull(data.days_out_corrections),
      dateOrNull(data.plan_review_complete_date),
      dateOrNull(data.ready_to_issue_date),
    )
    .run();

  const reclassifyStatement = buildAduReclassificationStatement(env, [data.permit_number]);
  if (reclassifyStatement) await reclassifyStatement.run();

  if (existingPermit) {
    const previousStatus = normalizeStoredStatus(existingPermit.status);
    if (previousStatus !== incomingStatus) {
      await env.DB.prepare(
        `
        INSERT INTO permit_status_changes (permit_number, previous_status, new_status)
        VALUES (?, ?, ?)
      `,
      )
        .bind(data.permit_number, previousStatus, incomingStatus)
        .run();
    }
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function ingestPermitBatch(request, env) {
  const startTime = new Date();
  let items;
  try {
    const body = await request.json();
    items = body.items;
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  if (!Array.isArray(items)) {
    return new Response(JSON.stringify({ error: "items must be an array" }), { status: 400 });
  }

  let added = 0;
  let updated = 0;

  try {
    // 1. Pre-load contractors for fast in-memory lookup
    const { results: allContractors } = await env.DB.prepare("SELECT id, name FROM contractors").all();
    const contractorMap = new Map();
    for (const c of allContractors) {
      contractorMap.set(c.name.toLowerCase(), c.id);
    }

    // 2. Check existing permits in chunked queries
    const permitNumbers = items.map((i) => i.permit_number).filter(Boolean);
    const existingStatuses = new Map();
    if (permitNumbers.length > 0) {
      const chunkSize = 100;
      for (let i = 0; i < permitNumbers.length; i += chunkSize) {
        const chunk = permitNumbers.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => "?").join(",");
        const { results } = await env.DB.prepare(
          `SELECT permit_number, status FROM permits WHERE permit_number IN (${placeholders})`,
        )
          .bind(...chunk)
          .all();
        for (const r of results) existingStatuses.set(r.permit_number, r.status);
      }
    }

    // 3. Build batched insert statements
    const statements = [];
    const statusChanges = [];
    for (const item of items) {
      const contractorId = item.contractor_name ? contractorMap.get(item.contractor_name.toLowerCase()) || null : null;
      const incomingStatus = normalizeStoredStatus(item.status);

      if (existingStatuses.has(item.permit_number)) {
        updated++;
        const previousStatus = normalizeStoredStatus(existingStatuses.get(item.permit_number));
        if (previousStatus !== incomingStatus) {
          statusChanges.push({
            permit_number: item.permit_number,
            previous_status: previousStatus,
            new_status: incomingStatus,
          });
        }
      } else {
        added++;
      }

      statements.push(
        env.DB.prepare(PERMIT_UPSERT_SQL).bind(
          item.permit_number,
          contractorId,
          item.applicant_name || null,
          item.address,
          item.neighborhood || null,
          item.type || null,
          item.value || null,
          incomingStatus,
          item.description || null,
          item.housing_units || 0,
          item.applied_date || null,
          item.issued_date || null,
          item.completed_date || null,
          intOrNull(item.housing_units_added),
          intOrNull(item.housing_units_removed),
          item.housing_category || null,
          item.dwelling_unit_type || null,
          item.zoning || null,
          item.parent_permit_number || null,
          item.related_mup || null,
          intOrNull(item.number_review_cycles),
          intOrNull(item.total_days_plan_review),
          intOrNull(item.days_out_corrections),
          dateOrNull(item.plan_review_complete_date),
          dateOrNull(item.ready_to_issue_date),
        ),
      );
    }

    const reclassifyStatement = buildAduReclassificationStatement(env, permitNumbers);
    if (reclassifyStatement) statements.push(reclassifyStatement);
    statements.push(...buildStatusChangeStatements(env, statusChanges));

    await env.DB.batch(statements);

    await logIngest(env, {
      run_type: "permit",
      source: "scraper",
      status: "success",
      records_added: added,
      records_updated: updated,
      start_time: startTime,
      end_time: new Date(),
    });

    return new Response(JSON.stringify({ processed: items.length, added, updated }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    await logIngest(env, {
      run_type: "permit",
      source: "scraper",
      status: "error",
      error_message: error.message,
      start_time: startTime,
      end_time: new Date(),
    });
    throw error;
  }
}

function normalizeEnrichmentItem(item) {
  const licenseLookup = item.contractor_license_lookup || {};
  const contractorDisclosure = item.contractor_disclosure || {};
  const applicationInfo = item.application_info || {};
  const otherInfo = item.other_info || {};
  const contractorLicense =
    item.contractor_license || contractorDisclosure.contractor_license || licenseLookup.contractorlicensenumber || "";
  const contractorName = item.contractor_name || licenseLookup.businessname || "";

  return {
    permit_number: item.permit_number,
    contractor_name: contractorName ? String(contractorName).trim() : "",
    contractor_license: contractorLicense ? String(contractorLicense).trim() : "",
    contractor_license_status: item.contractor_license_status || licenseLookup.licensestatusdesc || "",
    contractor_ubi: item.contractor_ubi || licenseLookup.ubi || "",
    contractor_insurance_amount: intOrNull(item.contractor_insurance_amount || licenseLookup.insuranceamt),
    contractor_insurance_expires_date: dateOrNull(
      item.contractor_insurance_expires_date || licenseLookup.expirationdate,
    ),
    permit_detail_url: item.permit_detail_url || item.detail_url || null,
    work_performed_by:
      item.work_performed_by ||
      contractorDisclosure.performing_work ||
      applicationInfo["Who will be performing all the work?"] ||
      null,
    review_level: item.review_level || applicationInfo["Review Level"] || null,
    primary_property_use: item.primary_property_use || applicationInfo["Choose the Primary Property Use"] || null,
    parcel_number: item.parcel_number || item.parcel || null,
    detailed_description: item.detailed_description || item.project_description_detail || null,
    record_status_detail: item.record_status_detail || item.record_status || null,
    expires_date: dateOrNull(item.expires_date || item.expiration_date),
    housing_units_added: intOrNull(item.housing_units_added || otherInfo["Number of Added Units"]),
    housing_units_removed: intOrNull(item.housing_units_removed || otherInfo["Number of Removed Units"]),
    housing_units_existing: intOrNull(item.housing_units_existing || otherInfo["Number of Existing Units"]),
    sleeping_rooms: intOrNull(item.sleeping_rooms || otherInfo["Number of Sleeping Rooms"]),
    has_required_inspections: item.has_required_inspections ? 1 : 0,
    has_completed_inspections: item.has_completed_inspections ? 1 : 0,
  };
}

async function ingestPermitEnrichmentBatch(request, env) {
  const startTime = new Date();
  let items;
  try {
    const body = await request.json();
    items = body.items;
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!Array.isArray(items)) {
    return new Response(JSON.stringify({ error: "items must be an array" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const normalizedItems = items.map(normalizeEnrichmentItem).filter((item) => item.permit_number);
  let permitsUpdated = 0;
  let contractorsUpserted = 0;
  let contractorsLinked = 0;

  try {
    const contractorCandidates = new Map();
    for (const item of normalizedItems) {
      if (!item.contractor_name) {
        continue;
      }
      const slug = slugify(item.contractor_name);
      if (!slug) {
        continue;
      }
      contractorCandidates.set(slug, {
        slug,
        name: item.contractor_name,
        license_number: item.contractor_license || null,
        license_status: item.contractor_license_status || null,
        ubi: item.contractor_ubi || null,
        insurance_amount: item.contractor_insurance_amount,
        insurance_expires_date: item.contractor_insurance_expires_date,
      });
    }

    const contractorStatements = [...contractorCandidates.values()].map((contractor) =>
      env.DB.prepare(
        `
        INSERT INTO contractors (name, slug, specialty, license_number, license_status, ubi, insurance_amount, insurance_expires_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
          name = excluded.name,
          specialty = COALESCE(contractors.specialty, excluded.specialty),
          license_number = COALESCE(excluded.license_number, contractors.license_number),
          license_status = COALESCE(excluded.license_status, contractors.license_status),
          ubi = COALESCE(excluded.ubi, contractors.ubi),
          insurance_amount = COALESCE(excluded.insurance_amount, contractors.insurance_amount),
          insurance_expires_date = COALESCE(excluded.insurance_expires_date, contractors.insurance_expires_date),
          updated_at = CURRENT_TIMESTAMP
      `,
      ).bind(
        contractor.name,
        contractor.slug,
        "General Contractor",
        contractor.license_number,
        contractor.license_status,
        contractor.ubi,
        contractor.insurance_amount,
        contractor.insurance_expires_date,
      ),
    );

    if (contractorStatements.length) {
      await env.DB.batch(contractorStatements);
      contractorsUpserted = contractorStatements.length;
    }

    const contractorBySlug = new Map();
    const contractorSlugs = [...contractorCandidates.keys()];
    for (let i = 0; i < contractorSlugs.length; i += 100) {
      const chunk = contractorSlugs.slice(i, i + 100);
      const placeholders = chunk.map(() => "?").join(",");
      const { results } = await env.DB.prepare(`SELECT id, slug FROM contractors WHERE slug IN (${placeholders})`)
        .bind(...chunk)
        .all();
      for (const row of results || []) {
        contractorBySlug.set(row.slug, row.id);
      }
    }

    const permitStatements = normalizedItems.map((item) => {
      const contractorId = item.contractor_name ? contractorBySlug.get(slugify(item.contractor_name)) || null : null;
      if (contractorId) {
        contractorsLinked++;
      }
      permitsUpdated++;
      return env.DB.prepare(
        `
        UPDATE permits SET
          contractor_id = COALESCE(?, contractor_id),
          permit_detail_url = COALESCE(?, permit_detail_url),
          contractor_license = COALESCE(?, contractor_license),
          contractor_source = COALESCE(?, contractor_source),
          work_performed_by = COALESCE(?, work_performed_by),
          review_level = COALESCE(?, review_level),
          primary_property_use = COALESCE(?, primary_property_use),
          parcel_number = COALESCE(?, parcel_number),
          detailed_description = COALESCE(?, detailed_description),
          record_status_detail = COALESCE(?, record_status_detail),
          expires_date = COALESCE(?, expires_date),
          housing_units_added = COALESCE(?, housing_units_added),
          housing_units_removed = COALESCE(?, housing_units_removed),
          housing_units_existing = COALESCE(?, housing_units_existing),
          sleeping_rooms = COALESCE(?, sleeping_rooms),
          has_required_inspections = ?,
          has_completed_inspections = ?,
          last_enriched_at = CURRENT_TIMESTAMP
        WHERE permit_number = ?
      `,
      ).bind(
        contractorId,
        item.permit_detail_url,
        item.contractor_license || null,
        item.contractor_name ? "wa_lni_license" : "sdci_detail",
        item.work_performed_by,
        item.review_level,
        item.primary_property_use,
        item.parcel_number,
        item.detailed_description,
        item.record_status_detail,
        item.expires_date,
        item.housing_units_added,
        item.housing_units_removed,
        item.housing_units_existing,
        item.sleeping_rooms,
        item.has_required_inspections,
        item.has_completed_inspections,
        item.permit_number,
      );
    });

    for (let i = 0; i < permitStatements.length; i += 100) {
      const statementChunk = permitStatements.slice(i, i + 100);
      const permitNumbers = normalizedItems.slice(i, i + 100).map((item) => item.permit_number);
      const reclassifyStatement = buildAduReclassificationStatement(env, permitNumbers);
      if (reclassifyStatement) statementChunk.push(reclassifyStatement);
      await env.DB.batch(statementChunk);
    }

    await logIngest(env, {
      run_type: "permit_enrichment",
      source: "sdci_detail_lni",
      status: "success",
      records_added: contractorsUpserted,
      records_updated: permitsUpdated,
      start_time: startTime,
      end_time: new Date(),
    });

    return new Response(
      JSON.stringify({
        processed: normalizedItems.length,
        permits_updated: permitsUpdated,
        contractors_upserted: contractorsUpserted,
        contractors_linked: contractorsLinked,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    await logIngest(env, {
      run_type: "permit_enrichment",
      source: "sdci_detail_lni",
      status: "error",
      error_message: error.message,
      start_time: startTime,
      end_time: new Date(),
    });
    throw error;
  }
}

async function replaceIngestData(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (body.confirm !== "replace-all") {
    return new Response(JSON.stringify({ error: "confirm must be replace-all" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const startTime = new Date();
  try {
    await env.DB.prepare("DELETE FROM permit_status_changes").run();
    const permitsResult = await env.DB.prepare("DELETE FROM permits").run();
    const contractorsResult = await env.DB.prepare("DELETE FROM contractors").run();
    const permitsDeleted = permitsResult.meta?.changes || 0;
    const contractorsDeleted = contractorsResult.meta?.changes || 0;

    await logIngest(env, {
      run_type: "full_refresh",
      source: "direct_import",
      status: "success",
      records_added: 0,
      records_updated: permitsDeleted + contractorsDeleted,
      start_time: startTime,
      end_time: new Date(),
    });

    return new Response(
      JSON.stringify({
        success: true,
        permits_deleted: permitsDeleted,
        contractors_deleted: contractorsDeleted,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    await logIngest(env, {
      run_type: "full_refresh",
      source: "direct_import",
      status: "error",
      error_message: error.message,
      start_time: startTime,
      end_time: new Date(),
    });
    throw error;
  }
}

async function ingestContractor(request, env) {
  const data = await request.json();

  const stmt = env.DB.prepare(`
        INSERT INTO contractors (name, slug, specialty, description, license_number, years_active, phone, email, website)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
          name = excluded.name,
          specialty = excluded.specialty,
          description = COALESCE(excluded.description, contractors.description),
          license_number = COALESCE(excluded.license_number, contractors.license_number),
          years_active = COALESCE(excluded.years_active, contractors.years_active),
          phone = COALESCE(excluded.phone, contractors.phone),
          email = COALESCE(excluded.email, contractors.email),
          website = COALESCE(excluded.website, contractors.website),
          updated_at = CURRENT_TIMESTAMP
    `);

  await stmt
    .bind(
      data.name,
      data.slug,
      data.specialty || null,
      data.description || null,
      data.license_number || null,
      data.years_active || null,
      data.phone || null,
      data.email || null,
      data.website || null,
    )
    .run();

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function ingestContractorBatch(request, env) {
  const { items } = await request.json();

  if (!Array.isArray(items)) {
    return new Response(JSON.stringify({ error: "items must be an array" }), { status: 400 });
  }

  const statements = [];
  for (const item of items) {
    statements.push(
      env.DB.prepare(
        `
        INSERT INTO contractors (name, slug, specialty, license_number, years_active)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
          name = excluded.name,
          specialty = excluded.specialty,
          license_number = COALESCE(excluded.license_number, contractors.license_number),
          years_active = COALESCE(excluded.years_active, contractors.years_active),
          updated_at = CURRENT_TIMESTAMP
      `,
      ).bind(item.name, item.slug, item.specialty || null, item.license_number || null, item.years_active || null),
    );
  }

  await env.DB.batch(statements);

  return new Response(JSON.stringify({ processed: items.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function checkAuth(request, env) {
  const jwt = request.headers.get("CF-Access-Jwt-Assertion");

  if (!jwt) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      email: request.headers.get("CF-Access-Authenticated-User-Email"),
      id: request.headers.get("CF-Access-Authenticated-User-Id"),
    }),
    {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

// --- Agent discovery -------------------------------------------------------

const API_BASE = `${BASE_URL}/api`;

function jsonResponse(obj, contentType = "application/json") {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { ...corsHeaders, "Content-Type": contentType, "Cache-Control": "public, max-age=3600" },
  });
}

// True when the client explicitly asks for markdown (Markdown for Agents).
function wantsMarkdown(request) {
  const accept = request?.headers?.get("Accept") || "";
  return /text\/markdown/i.test(accept);
}

// Build a text/markdown response with content-negotiation hints for agents.
function markdownResponse(request, markdown) {
  const headers = {
    ...corsHeaders,
    "Content-Type": "text/markdown; charset=utf-8",
    Vary: "Accept",
    "x-markdown-tokens": String(Math.ceil(markdown.length / 4)),
  };
  if (request?.url) {
    headers.Link = `<${request.url}>; rel="alternate"; type="text/markdown"`;
  }
  return new Response(markdown, { headers });
}

// RFC 9727 / RFC 9264 — machine-readable API catalog (application/linkset+json).
function renderApiCatalogObject() {
  return {
    linkset: [
      {
        anchor: API_BASE,
        "service-desc": [{ href: `${BASE_URL}/openapi.json`, type: "application/json" }],
        "service-doc": [{ href: `${BASE_URL}/api-docs`, type: "text/html" }],
        status: [{ href: `${BASE_URL}/api/stats`, type: "application/json" }],
      },
    ],
  };
}

function renderApiCatalog() {
  return jsonResponse(renderApiCatalogObject(), "application/linkset+json");
}

// OpenAPI 3.1 description of the public read endpoints (service-desc target).
function renderApiSpecObject() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Building Seattle API",
      version: "1.0.0",
      description:
        "Read-only access to aggregated Seattle construction permit and contractor data. No authentication required.",
    },
    servers: [{ url: BASE_URL }],
    paths: {
      "/api/permits": {
        get: {
          operationId: "searchPermits",
          summary: "Query permits with optional filters and pagination.",
          parameters: [
            { name: "neighborhood", in: "query", schema: { type: "string" }, description: "Filter by neighborhood." },
            { name: "type", in: "query", schema: { type: "string" }, description: "Filter by permit type." },
            { name: "status", in: "query", schema: { type: "string" }, description: "Filter by permit status." },
            {
              name: "q",
              in: "query",
              schema: { type: "string" },
              description:
                "Free-text search across address, description, permit number, neighborhood, and contractor name.",
            },
            { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
            { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
          ],
          responses: {
            200: {
              description: "Matching permits.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      total: { type: "integer" },
                      page: { type: "integer" },
                      per_page: { type: "integer" },
                      results: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/contractors": {
        get: {
          operationId: "listContractors",
          summary: "List contractors ranked by active project count (top 20).",
          responses: {
            200: {
              description: "Contractor records, each including an active_projects count.",
              content: { "application/json": { schema: { type: "array", items: { type: "object" } } } },
            },
          },
        },
      },
      "/api/stats": {
        get: {
          operationId: "getStats",
          summary: "Aggregate counts and permit value totals for the dashboard.",
          responses: {
            200: {
              description: "Aggregate statistics.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      leads: { type: "integer" },
                      permits: { type: "integer" },
                      contractors: { type: "integer" },
                      active_permits: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function renderOpenApiSpec() {
  return jsonResponse(renderApiSpecObject());
}

// Human-readable API documentation (service-doc target).
function renderApiDocs() {
  const endpoint = (method, path, desc, params) => `
      <div class="endpoint">
        <h3><span class="method">${method}</span> <code>${escapeHtml(path)}</code></h3>
        <p>${escapeHtml(desc)}</p>
        ${params ? `<table><thead><tr><th>Parameter</th><th>Description</th></tr></thead><tbody>${params}</tbody></table>` : ""}
      </div>`;
  const param = (name, desc) => `<tr><td><code>${escapeHtml(name)}</code></td><td>${escapeHtml(desc)}</td></tr>`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API Documentation | Building Seattle</title>
    <meta name="description" content="Public read-only API for Seattle construction permit and contractor data.">
    <link rel="canonical" href="${BASE_URL}/api-docs">
    <link rel="icon" href="/favicon.ico" sizes="32x32" type="image/png">
    <link rel="manifest" href="/site.webmanifest">
    ${renderDesignTokens()}
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg-alt); color: var(--text); line-height: 1.6; display: flex; flex-direction: column; min-height: 100vh; }
        .container { max-width: var(--container-max); margin: 0 auto; padding: 0 1.5rem; }
        main { flex: 1; padding-top: 6rem; padding-bottom: 4rem; }
        h1 { font-size: 2.25rem; font-weight: 800; color: var(--primary); margin-bottom: 0.5rem; }
        .lede { color: var(--text-muted); margin-bottom: 2rem; max-width: 640px; }
        .endpoint { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 1.25rem 1.5rem; margin-bottom: 1.25rem; }
        .endpoint h3 { font-size: 1.05rem; margin-bottom: 0.5rem; color: var(--primary); }
        .method { display: inline-block; background: var(--accent); color: #fff; font-size: 0.7rem; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 0.35rem; vertical-align: middle; }
        code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.875rem; }
        table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; font-size: 0.875rem; }
        th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border); vertical-align: top; }
        th { color: var(--text-muted); font-weight: 600; }
        .resources { margin-top: 2rem; font-size: 0.9rem; }
        .resources a { color: var(--accent); }
    </style>
</head>
<body>
    ${renderNav("api")}
    <main>
      <div class="container">
        <h1>API Documentation</h1>
        <p class="lede">Read-only JSON access to aggregated Seattle construction permit and contractor data. No authentication required. Base URL <code>${BASE_URL}</code>.</p>
        ${endpoint("GET", "/api/permits", "Query permits with optional filters and pagination. Returns { total, page, per_page, results[] }.", [param("neighborhood", "Filter by neighborhood."), param("type", "Filter by permit type."), param("status", "Filter by permit status."), param("q", "Free-text search across address, description, permit number, neighborhood, and contractor name."), param("page", "Page number (default 1)."), param("per_page", "Results per page (1-100, default 50).")].join(""))}
        ${endpoint("GET", "/api/contractors", "List the top 20 contractors ranked by active project count. Each record includes an active_projects count.", "")}
        ${endpoint("GET", "/api/stats", "Aggregate counts and permit value totals for the dashboard.", "")}
        <div class="resources">
          Machine-readable: <a href="/openapi.json">OpenAPI spec</a> &middot; <a href="/.well-known/api-catalog">API catalog</a>
        </div>
      </div>
    </main>
    ${renderFooter()}
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

async function executeMcpTool(name, args, env, requestUrl) {
  let response;
  if (name === "search_permits") {
    const url = new URL("/api/permits", requestUrl);
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    response = await getPermits(new Request(url), env);
  } else if (name === "list_contractors") {
    response = await getContractors(new Request(new URL("/api/contractors", requestUrl)), env);
  } else {
    response = await getStats(env);
  }
  if (!response.ok) throw new Error(`request failed with status ${response.status}`);
  return response.json();
}

// SEP-1649 MCP Server Card for the live Streamable HTTP transport.
function renderMcpServerCard() {
  return jsonResponse({
    serverInfo: { name: "building-seattle", version: "1.0.0" },
    description: "Read-only access to aggregated Seattle construction permit and contractor data.",
    transport: { type: "streamable-http", endpoint: `${BASE_URL}/mcp` },
    documentation: `${BASE_URL}/api-docs`,
    capabilities: { tools: { listChanged: false } },
    tools: MCP_TOOLS,
  });
}

// Agent Skills Discovery RFC v0.2.0 — index of discoverable machine-readable resources.
async function renderAgentSkillsIndex() {
  const sha256 = async (text) => {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };
  const openapiBody = JSON.stringify(renderApiSpecObject(), null, 2);
  const catalogBody = JSON.stringify(renderApiCatalogObject(), null, 2);
  return jsonResponse({
    $schema: "https://agentskills.io/schema/v0.2.0/index.json",
    skills: [
      {
        name: "building-seattle-api",
        type: "openapi",
        description: "OpenAPI description of the Building Seattle public read API.",
        url: `${BASE_URL}/openapi.json`,
        sha256: await sha256(openapiBody),
      },
      {
        name: "building-seattle-catalog",
        type: "api-catalog",
        description: "RFC 9727 API catalog linking the Building Seattle API resources.",
        url: `${BASE_URL}/.well-known/api-catalog`,
        sha256: await sha256(catalogBody),
      },
    ],
  });
}

// --- Markdown renderings (Markdown for Agents) -----------------------------

// Escape characters that would break a markdown table cell.
function mdCell(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function homeMarkdown(lastUpdated) {
  return `# Building Seattle

Construction intelligence for Seattle: live permit data and contractor profiles
aggregated from public Seattle DCI records.

_Data last updated: ${lastUpdated}_

## Explore

- [Browse permits](${BASE_URL}/permits)
- [API documentation](${BASE_URL}/api-docs)

## Public API (no authentication)

- \`GET ${BASE_URL}/api/permits\` — query permits (filters: \`neighborhood\`, \`type\`, \`status\`, \`q\`, \`page\`, \`per_page\`)
- \`GET ${BASE_URL}/api/contractors\` — top contractors by active project count
- \`GET ${BASE_URL}/api/stats\` — aggregate statistics

Machine-readable discovery: [OpenAPI spec](${BASE_URL}/openapi.json) ·
[API catalog](${BASE_URL}/.well-known/api-catalog)
`;
}

function permitBrowserMarkdown({ permits, total, page, totalPages, neighborhood, type, status, q }) {
  const filters = [
    neighborhood ? `neighborhood=${neighborhood}` : null,
    type ? `type=${type}` : null,
    status ? `status=${status}` : null,
    q ? `q=${q}` : null,
  ].filter(Boolean);
  const rows = (permits || [])
    .map((p) => {
      const value = p.value ? `$${parseInt(p.value).toLocaleString()}` : "—";
      const link = `${BASE_URL}/permits/${encodeURIComponent(p.permit_number)}`;
      return `| [${mdCell(p.permit_number)}](${link}) | ${mdCell(p.address)} | ${mdCell(p.neighborhood)} | ${mdCell(p.type)} | ${mdCell(p.status)} | ${value} | ${mdCell(p.contractor_name)} |`;
    })
    .join("\n");
  return `# Seattle Permits

${total.toLocaleString()} permits match${filters.length ? ` (filters: ${filters.join(", ")})` : ""}. Page ${page} of ${totalPages || 1}.

| Permit | Address | Neighborhood | Type | Status | Value | Contractor |
|---|---|---|---|---|---|---|
${rows || "| _No permits found_ | | | | | | |"}

JSON: \`GET ${BASE_URL}/api/permits\`
`;
}

function permitDetailMarkdown(permit, { neighborhood, permitType, valueFormatted, issuedDate, canonical }) {
  const field = (label, value) =>
    `- **${label}:** ${value === null || value === undefined || value === "" ? "—" : value}`;
  const lines = [
    field("Permit number", permit.permit_number),
    field("Address", permit.address),
    field("Neighborhood", neighborhood),
    field("Type", permitType),
    field("Status", permit.status),
    field("Project value", valueFormatted),
    field("Issued", issuedDate),
    permit.contractor_name
      ? field(
          "Contractor",
          `[${permit.contractor_name}](${BASE_URL}/contractor/${encodeURIComponent(permit.contractor_slug || "")})`,
        )
      : null,
    field("Property owner", permit.owner_name),
    field("Applicant", permit.applicant_name),
  ].filter(Boolean);
  const description = permit.detailed_description || permit.description;
  return `# Permit ${permit.permit_number}

${permit.address || "Seattle"}

${lines.join("\n")}
${description ? `\n## Description\n\n${description}\n` : ""}
[View on Building Seattle](${canonical})
`;
}

function contractorMarkdown(contractor, { permits, activeProjects, completionRate, canonical }) {
  const rows = (permits || [])
    .map((p) => {
      const value = p.value ? `$${parseInt(p.value).toLocaleString()}` : "—";
      const link = `${BASE_URL}/permits/${encodeURIComponent(p.permit_number)}`;
      return `| [${mdCell(p.permit_number)}](${link}) | ${mdCell(p.address)} | ${mdCell(p.status)} | ${value} |`;
    })
    .join("\n");
  const detail = (label, value) => (value ? `- **${label}:** ${value}` : null);
  const meta = [
    detail("Specialty", contractor.specialty),
    detail("Phone", contractor.phone),
    detail("Email", contractor.email),
    detail("Website", contractor.website),
    detail("License status", contractor.license_status),
    `- **Active projects:** ${activeProjects}`,
    `- **Completion rate:** ${completionRate}%`,
  ].filter(Boolean);
  return `# ${contractor.name}

${meta.join("\n")}

## Recent permits

| Permit | Address | Status | Value |
|---|---|---|---|
${rows || "| _No permits on record_ | | | |"}

[View on Building Seattle](${canonical})
`;
}

// WebMCP: expose read-only site tools to AI agents running in the browser.
function renderWebMcpScript() {
  return `<script>
    (function () {
      if (!navigator.modelContext || typeof navigator.modelContext.provideContext !== "function") return;
      var json = function (res) { return res.json(); };
      var qs = function (args) {
        var p = new URLSearchParams();
        Object.keys(args || {}).forEach(function (k) {
          if (args[k] !== undefined && args[k] !== null && args[k] !== "") p.set(k, args[k]);
        });
        var s = p.toString();
        return s ? "?" + s : "";
      };
      try {
        navigator.modelContext.provideContext({
          tools: [
            {
              name: "search_permits",
              description: "Search Seattle construction permits with optional filters and pagination.",
              inputSchema: {
                type: "object",
                properties: {
                  neighborhood: { type: "string" },
                  type: { type: "string" },
                  status: { type: "string" },
                  q: { type: "string", description: "Free-text search" },
                  page: { type: "integer", minimum: 1 },
                  per_page: { type: "integer", minimum: 1, maximum: 100 }
                }
              },
              execute: function (args) {
                return fetch("/api/permits" + qs(args), { headers: { Accept: "application/json" } })
                  .then(json)
                  .then(function (d) { return { content: [{ type: "text", text: JSON.stringify(d) }] }; });
              }
            },
            {
              name: "list_contractors",
              description: "List the top Seattle contractors ranked by active project count.",
              inputSchema: { type: "object", properties: {} },
              execute: function () {
                return fetch("/api/contractors", { headers: { Accept: "application/json" } })
                  .then(json)
                  .then(function (d) { return { content: [{ type: "text", text: JSON.stringify(d) }] }; });
              }
            },
            {
              name: "get_stats",
              description: "Get aggregate Seattle permit, contractor, and value statistics.",
              inputSchema: { type: "object", properties: {} },
              execute: function () {
                return fetch("/api/stats", { headers: { Accept: "application/json" } })
                  .then(json)
                  .then(function (d) { return { content: [{ type: "text", text: JSON.stringify(d) }] }; });
              }
            }
          ]
        });
      } catch (e) { /* WebMCP unavailable; ignore */ }
    })();
  </script>`;
}

function renderRobotsTxt() {
  const body = `User-agent: *
Content-Signal: search=yes, ai-train=no, ai-input=yes
Allow: /
Disallow: /admin
Disallow: /api/admin/
Disallow: /ingest/
Disallow: /leads
Disallow: /alerts/

Sitemap: ${BASE_URL}/sitemap.xml
`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain" },
  });
}

const SITEMAP_PAGE_SIZE = 45000;
const SITEMAP_STATIC_PATHS = [
  "/",
  "/permits",
  "/data",
  "/about",
  "/methodology",
  "/contractors",
  "/neighborhoods",
  "/projects",
  "/addresses",
  "/insights",
  "/insights/plan-review",
  "/insights/pipeline",
  "/insights/housing",
  "/insights/adu-dadu",
  "/insights/multifamily-pipeline",
  "/insights/commercial-projects",
  "/insights/tenant-improvements",
  "/insights/map",
  "/insights/contractors",
  "/insights/network",
];

const SITEMAP_SECTIONS = {
  permits: {
    numbered: true,
    urlPrefix: "/permits/",
    statsSql: `/* sitemap:stats:permits */
      SELECT
        COUNT(*) AS total,
        substr(MAX(COALESCE(updated_at, last_enriched_at, issued_date, created_at)), 1, 10) AS lastmod
      FROM permits`,
    rowsSql: `/* sitemap:rows:permits */
      SELECT
        permit_number AS slug,
        substr(COALESCE(updated_at, last_enriched_at, issued_date, created_at), 1, 10) AS lastmod
      FROM permits
      ORDER BY permit_number
      LIMIT ? OFFSET ?`,
  },
  addresses: {
    numbered: true,
    urlPrefix: "/address/",
    statsSql: `/* sitemap:stats:addresses */
      SELECT
        COUNT(DISTINCT a.id) AS total,
        substr(MAX(COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at, a.updated_at)), 1, 10) AS lastmod
      FROM addresses a
      JOIN permits p ON p.address_id = a.id`,
    rowsSql: `/* sitemap:rows:addresses */
      SELECT
        a.slug,
        substr(MAX(COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at, a.updated_at)), 1, 10) AS lastmod
      FROM addresses a
      JOIN permits p ON p.address_id = a.id
      GROUP BY a.id, a.slug
      ORDER BY a.slug
      LIMIT ? OFFSET ?`,
  },
  projects: {
    numbered: true,
    urlPrefix: "/project/",
    statsSql: `/* sitemap:stats:projects */
      SELECT
        COUNT(DISTINCT pr.id) AS total,
        substr(MAX(COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at, pr.updated_at)), 1, 10) AS lastmod
      FROM projects pr
      JOIN project_permits pp ON pp.project_id = pr.id
      JOIN permits p ON p.id = pp.permit_id`,
    rowsSql: `/* sitemap:rows:projects */
      SELECT
        pr.slug,
        substr(MAX(COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at, pr.updated_at)), 1, 10) AS lastmod
      FROM projects pr
      JOIN project_permits pp ON pp.project_id = pr.id
      JOIN permits p ON p.id = pp.permit_id
      GROUP BY pr.id, pr.slug
      ORDER BY pr.slug
      LIMIT ? OFFSET ?`,
  },
  contractors: {
    numbered: true,
    urlPrefix: "/contractor/",
    statsSql: `/* sitemap:stats:contractors */
      SELECT
        COUNT(*) AS total,
        substr(MAX(lastmod), 1, 10) AS lastmod
      FROM (
        SELECT slug, MAX(lastmod) AS lastmod
        FROM (
          SELECT c.slug, c.updated_at AS lastmod
          FROM contractors c
          UNION ALL
          SELECT c.slug, COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at) AS lastmod
          FROM contractors c
          JOIN permits p ON p.contractor_id = c.id
          UNION ALL
          SELECT o.slug, o.updated_at AS lastmod
          FROM people_orgs o
          WHERE EXISTS (SELECT 1 FROM permit_participants pp WHERE pp.people_org_id = o.id)
          UNION ALL
          SELECT o.slug, COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at) AS lastmod
          FROM people_orgs o
          JOIN permit_participants pp ON pp.people_org_id = o.id
          JOIN permits p ON p.id = pp.permit_id
        )
        GROUP BY slug
      )`,
    rowsSql: `/* sitemap:rows:contractors */
      SELECT slug, substr(MAX(lastmod), 1, 10) AS lastmod
      FROM (
        SELECT c.slug, c.updated_at AS lastmod
        FROM contractors c
        UNION ALL
        SELECT c.slug, COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at) AS lastmod
        FROM contractors c
        JOIN permits p ON p.contractor_id = c.id
        UNION ALL
        SELECT o.slug, o.updated_at AS lastmod
        FROM people_orgs o
        WHERE EXISTS (SELECT 1 FROM permit_participants pp WHERE pp.people_org_id = o.id)
        UNION ALL
        SELECT o.slug, COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at) AS lastmod
        FROM people_orgs o
        JOIN permit_participants pp ON pp.people_org_id = o.id
        JOIN permits p ON p.id = pp.permit_id
      )
      GROUP BY slug
      ORDER BY slug
      LIMIT ? OFFSET ?`,
  },
  neighborhoods: {
    numbered: false,
    urlPrefix: "/neighborhood/",
    statsSql: `/* sitemap:stats:neighborhoods */
      SELECT
        COUNT(DISTINCT n.id) AS total,
        substr(MAX(COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at)), 1, 10) AS lastmod
      FROM neighborhoods n
      JOIN address_neighborhoods an ON an.neighborhood_id = n.id
      JOIN permits p ON p.address_id = an.address_id`,
    rowsSql: `/* sitemap:rows:neighborhoods */
      SELECT
        n.slug,
        substr(MAX(COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at)), 1, 10) AS lastmod
      FROM neighborhoods n
      JOIN address_neighborhoods an ON an.neighborhood_id = n.id
      JOIN permits p ON p.address_id = an.address_id
      GROUP BY n.id, n.slug
      ORDER BY n.slug
      LIMIT ? OFFSET ?`,
  },
};

function sitemapPageCount(total) {
  return Math.ceil(Math.max(0, Number(total) || 0) / SITEMAP_PAGE_SIZE);
}

function sitemapDate(value) {
  const match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function sitemapChildPath(type, page, totalPages) {
  const section = SITEMAP_SECTIONS[type];
  if (!section?.numbered && totalPages === 1) {
    return `/sitemaps/${type}.xml`;
  }
  return `/sitemaps/${type}-${page}.xml`;
}

async function getSitemapStats(env, type) {
  const section = SITEMAP_SECTIONS[type];
  const stats = await env.DB.prepare(section.statsSql).first();
  return {
    total: Number(stats?.total) || 0,
    lastmod: sitemapDate(stats?.lastmod),
  };
}

function renderSitemapIndexEntry(loc, lastmod) {
  return `  <sitemap>
    <loc>${escapeHtml(loc)}</loc>${lastmod ? `\n    <lastmod>${escapeHtml(lastmod)}</lastmod>` : ""}
  </sitemap>`;
}

function renderSitemapUrlEntry(loc, lastmod) {
  return `  <url>
    <loc>${escapeHtml(loc)}</loc>${lastmod ? `\n    <lastmod>${escapeHtml(lastmod)}</lastmod>` : ""}
  </url>`;
}

function sitemapXmlResponse(xml, maxAge = 3600) {
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": `public, max-age=${maxAge}`,
    },
  });
}

function sitemapNotFound() {
  return new Response("Sitemap not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function renderSitemapXml(env, request) {
  const origin = BASE_URL;
  const sectionTypes = Object.keys(SITEMAP_SECTIONS);
  const statsEntries = await Promise.all(sectionTypes.map(async (type) => [type, await getSitemapStats(env, type)]));
  const statsByType = Object.fromEntries(statsEntries);
  const sitemaps = [
    {
      loc: origin + "/sitemaps/static.xml",
      lastmod: statsByType.permits.lastmod,
    },
  ];

  for (const type of sectionTypes) {
    const stats = statsByType[type];
    const totalPages = sitemapPageCount(stats.total);
    for (let page = 1; page <= totalPages; page++) {
      sitemaps.push({
        loc: origin + sitemapChildPath(type, page, totalPages),
        lastmod: stats.lastmod,
      });
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemaps.map((sitemap) => renderSitemapIndexEntry(sitemap.loc, sitemap.lastmod)).join("\n")}
</sitemapindex>`;

  return sitemapXmlResponse(xml, 900);
}

async function renderChildSitemapXml(path, env, request) {
  const match = path.match(/^\/sitemaps\/([a-z]+?)(?:-(\d+))?\.xml$/);
  if (!match) {
    return sitemapNotFound();
  }

  const [, type, pageText] = match;
  const origin = BASE_URL;

  if (type === "static") {
    if (pageText) return sitemapNotFound();
    const permitStats = await getSitemapStats(env, "permits");
    let staticPaths = SITEMAP_STATIC_PATHS;
    try {
      if (!(await hasAduDaduData(env))) {
        staticPaths = staticPaths.filter((staticPath) => staticPath !== "/insights/adu-dadu");
      }
    } catch (error) {
      console.error("ADU sitemap availability query failed:", error);
      staticPaths = staticPaths.filter((staticPath) => staticPath !== "/insights/adu-dadu");
    }
    const entries = staticPaths.map((staticPath) => ({
      loc: origin + staticPath,
      lastmod: permitStats.lastmod,
    }));
    return renderSitemapUrlSet(entries);
  }

  const section = SITEMAP_SECTIONS[type];
  if (!section) {
    return sitemapNotFound();
  }

  const stats = await getSitemapStats(env, type);
  const totalPages = sitemapPageCount(stats.total);
  const page = Number(pageText || 1);
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > totalPages ||
    path !== sitemapChildPath(type, page, totalPages)
  ) {
    return sitemapNotFound();
  }

  const offset = (page - 1) * SITEMAP_PAGE_SIZE;
  const { results = [] } = await env.DB.prepare(section.rowsSql).bind(SITEMAP_PAGE_SIZE, offset).all();
  const entries = results.map((row) => ({
    loc: origin + section.urlPrefix + encodeURIComponent(row.slug),
    lastmod: sitemapDate(row.lastmod),
  }));

  return renderSitemapUrlSet(entries);
}

function renderSitemapUrlSet(entries) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((entry) => renderSitemapUrlEntry(entry.loc, entry.lastmod)).join("\n")}
</urlset>`;

  return sitemapXmlResponse(xml);
}

function renderWebManifest() {
  return new Response(
    JSON.stringify({
      name: "Building Seattle",
      short_name: "Building Seattle",
      description: "Seattle construction permits, projects, contractors, and neighborhood activity.",
      start_url: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#0f172a",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    }),
    {
      headers: {
        "Content-Type": "application/manifest+json; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      },
    },
  );
}

function renderAppIcon(size) {
  const icons = {
    32:
      "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAWElEQVR4nO3WQQqAMAxE0bz/kR0XQbyBILQz4F9Z0EWtJj8DkjRNWZZlWY7zWmtm5pzZQ0Ts3iMiIqWUzjnP8/x+v58PoJRSSimllFJKKaWUUkoppZRSSimllFJKKaXUH/QAHNsKPPoJkJAAAAAASUVORK5CYII=",
    192:
      "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAACXklEQVR42u3dPU4CQRiAYXdjDx2cgZ/EgovoNeyoLa3tvIZehMIEvIOlR6DbSAwgOLMw8z1Phc1CmDfDurM/zWA0uYFztb4CBISAEBACAgEhIASEgEBACAgBISAQEAJCQAgIBISAEBACQkAgIASEgBAQCAgBISAEBAJCQAiIutz6Cvb5/vrsXg/HU1+IGQgBISAEBAJCQAgIASEgEBACQkAIiJ2V1N9/IiAEhIAQEAICASEgytN47Hfn7wd7nGMvoNOK0ZOAsqQjo1gB9bMiEaqkVj3lvpGAKqwnWkOtejQkoCsdyAgNVb4TvW8Ic+zn9vleZiAEBAJCQIdcfP+j+oOK9c9AFxzCCIekQ9zibjie9v8fdcJ6VutNjk+4mM/MQFc6GcRZDgu0E93boIZaTI11l9ZuaJ3OIaAEg+2EMgGlHHintAoo7w+cbkLvRCMgBISAQEAICAEhIAQEAkJACIhgyltMvX/5SL7N9+WdFMxACAgBISAQEAJCQOU5cGq9p4YJCAEhIKrhurDzPb+tk2/z6WFuBsJPGAgIASEgBAQCQkAICAGBgEgkzVrY7HGV48NtXhdGyAyEgEBACAgBISAQEALK4OiVXy4NExACQkAICASEgBAQAkJAICAERDncH2iHJ8ObgRAQAkJAICAEhIAQEAgIASEgBAQCQkAICAEhIBAQAkJACAgEhIAQEAICASEgBISA4IdmMJr8fyvu316iJLciMQMhIASEgBAQCAgBUYw0x4EwA4GAEBACQkAgIASEgBAQCAgBISAEBAJCQAgIASEgEBACQkAICE6wBUhBYQ0pqaiEAAAAAElFTkSuQmCC",
    512:
      "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIAAgMAAACJFjxpAAAADFBMVEUPFyr///87gvYAAABja/fMAAAClUlEQVR42u3dPXLTQACA0ZVHaqhUJJfgFDqCC2eGkqNwFEpmROEj+D5O4YrGHpSCDAShxPH+yMZ+XxFiKYQ3uytLspMhBEmSJEmSJEmSJEmSJEmSJEnSrVcl/vVV2K+TvsPi3CMAAAAAAPC/A+oQalMAAAAAAAAAAAAAAHDbgDb5hT5TAAAAAAAAAJAGaLoQwirpW6RczzTL50+G72cB3Hd/Pu/PAHj469F2M/cauH/zYXlA0402rOYFVMvjW4oC7ibGZE5A1U1sXM4IuJtcFjMCuhO2lgA0J4xLEUCb8UltkWsJxi7DGEB98o7MgDbniWWR7RiIPA4iAFXE2FzXJVkdtetiR6COPAj6ySu06jbWQBe5z50RAEA2wCZy3/WMwO71XcNtrIFD1K5rOh0P718ezcSFep8+ApuMR2EUYJfxIIgCHDKuwSjA8NpIr+c6F+zyzUAcYD+9+XGmwzCEsOke8hwDsU9EjyeMSxHA5DJczwiYGoK4AYgFDOvjW8qejPbjSYh9xT76bLh982HpwzCEEPo87xckXA9sf8/6EP/vJ/1w/r5vliHtDZvUK6JD7DnQnREAQC5AnfpUYgoAAAAAAAAAAAAAAFIBbQipv2ZjCt57Y7f4Nt7y85NFCAAAAAAAAAAAAHABgO7FR1MAAFD47vhIH76Ot/z4bAoAAAAAAAAAAGYAPL9b1JoCAAAAgKu6Pf/45Z8vyfQutSkAAAAAACgBqKdPaKYAAAAAAAAAAAAAAOCGAO2vPypTAAAAAACQUtJLbNveFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKQ3/sn4l/95aZl6UwAAAAAAAAAAAHBhAEmSJEmSJEmSJEmSngBzDUgMDdD3FgAAAABJRU5ErkJggg==",
  };
  const pngBase64 = icons[size];
  if (!pngBase64) return new Response("Icon not found", { status: 404 });
  const bytes = Uint8Array.from(atob(pngBase64), (character) => character.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}

function renderSocialImage(type) {
  const images = {
    permit: "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",
    contractor: "iVBORw0KGgoAAAANSUhEUgAABLAAAAJ2CAMAAAB4notuAAAATlBMVEUWKEQaL08SHjQcNVcYLUsaMlMTIDgXKkcUIzwVJT8QGi8eOF1Sjdj+//47gvZRjNTK1dySxfaYp7VVQkqKjpMqY7FeZXXJspd3seOccl9uYJleAAAgAElEQVR42uyd63LjKBCFEZGFcKrmX97/VTdjW7KQuPQNaGaNliROMpraqqnjr48O3cYtqLU+duRy+1frvilrXlnLb3v++xl4+WCHa/Yya8L+AbPv4JoOX5vHpq0J9+tu36drciZxuWCX1s3JLMB95tf++zF5fZ1ez4+NX1/QX5yCfbm+Xp+nYOPX1ySzvuvc5xbsyGWWu8ySus+q7D4e+Ht237+Xfezner3yVmaZavdZsvtwLcf9eMM7fo+4HPlPrsF2x3fMhfzGtzDfOPe3zjl4mXlnDNbqz++kU9M3TnN+xzTBxr/hRd7/np/R95ESGqtM+Dzz/2UTH5/+DfvYxeu5pARL4D4P1TGLFbkMR6UogrXmLxf5HkW53Cqyfgk9z/bQJUT6ZkLQfO6aMj+7qJsc6RtjP4QlJHwnhZIXmsqEdeaszHVgKbcsbQWroF9CQrPOovchqhTHUkiQ00RxIyLq8xKax0/96eevF37/jYx/8SEsAcI6/l95Il/ZU2WogrAOVZ4pqhLkWn4Jq4lghXUfmLDolaETcVLThAWqDOt7qQbPV0/lmVgO6oewuhFWyrsK5Uo7YSH9KxHviXOfi37tyuQWfYR18q86ElbpPmXviiw0UoL1ISzMfeybrwq+1b1SSei5fLXIeVhLO8ICsNWVsDiuu+Na7q9rFvCvqj6tNvjLPDysToL1rxKWb3Ifm/Cu7kN6WEX/SvTpHu8+F/16qZMuD8v/3ofnXbUlLB9TJxmh+RBWB+Gzu3d1x/FVZ8GKVHiGwVXHyrABYYH9qydhSaQaGILlQ499ZnpXFQWL8GzQBB7Wh7AG87CiuauoXOkkrCXjXy3vz9mcVXvCSvtXDw9LCWFtujV7hko1Iyy4dyVMWO5DWC+bSbYkhHpXyVRDT8FK5qc43tXSirBW3OX2CrGLYF2cqpmfaKghWAbLVufq8ENYw3lYBYUaxMNaAlWzxdxVb8KKpEJrBD6ZhPXWqHlt4z1x73PRr0Jq4eNhyQifrSF8lNyVCsHKJBQMw79qRFgr/NngW72cgH9FEiy/Rk+vzkzvSlywtsrP430r/yGs8Qgrkru626JcafWwEOcGuxPWRb+iytSbsPwpd9Xt8Dz4PpBc+8fDqiF89vhZTrB43lVHwcomFAzTu6pOWCvev1pfTwk7CFYybTXLpBokBYuUu1JTEn4IC3ufbHphSA8LpVCdCCuVu9LnYYUKpZ2wQOr0ISxx4bOnek1O+Ow5HwrLXXUVrKWcAjWE3JVtQ1grzr8Kc1fNBcuv2c5rMz/RICNYr8pvQj0dTKcbOhDWsx/bh7Dg90nlrkYhrKOOnT0saO6qPWHlc1daCMsnel5pJSyDzF19CEtO+OzFD2cL1jt35QHnBpUJVjahQPGwmgoWwbs6phsaC1axl60SwdrVaSLmrrp7WFu/23+TsGwFwkIqlFoP66llpqRq1TuFwu4D9a76EpYPvatVQYvt7H0M6tzgh7DkhM9ePCwh4dtyV57pXTUVrAXmX8EJq1wVCgoWKXd1rg6bCZYv+1f+4WF1FqzTqZsJ6V0pIKxwlsC/Q1j2QEKyHlYsdzUaYS0ZDwuTu2pHWJnc1aKLsHL92jUS1sl3N5R5Ju0J6zUHRRthrby/elctnvC9fSvP9K4aCxaqFzvHu6oiWITcVSfBAs1iUiJY4F7smGRDM8I6T2MambAuSmXfX0sGRy352aA2D2s5eVjoCrCph1U6N6iDsPLJUH2ERctd1RKsG2rWzviEZeMfLbm0PPe78kzvqolgJTvDUAkLXhkKCNaj7nMo/ypdGVYXLIBvdawMFcy19HDCgqcbGhBWfBbm+B6WjeURRAjLboRluXzVh7ByndpNqE6WOldQnrBwuatehOWBswa1ENamXdNbvwxnFm9bwtp1y41JWEHiKhSq7ZXH+1b3WM8rz/SuGggWaDIXhrAwyuVE+Or3PsTcVWPBAntXnQUr2U10YnpXzQgrOmf8X3lKeNAbK0ZY9jVIVc0AVKKHFdczQ8xd1SYsWE8GDR4WrDOfDsJ669f01iZfOY4gRli7WrkxCcsmOYsTHLXxnlce0fOqi2AtNMYyTO9KQLCC2s8Rc1fNBMtD/avOglWYNDgRc1cNCctl+GpcwrJxyLISOaxj7sozvatehFWaNGioClWNsHjeVUvCgnhXrafdQPVrMge+8toJ6+1dbXs0wrLRUvB+zTd4nDwl+4l6pndVWbDIfdkN/TSOnGAlJzbjvavKguUh5waVlITZ54AT4dxgU8JyhUvblJqVIpF2JyvLz2GFDruKEfNkDytdKxqmd1XDw6LkrmpObC7mrtb6T/f49wmVafLV4whihBUo1WuNRFj2QlU2lWqAE9bGV6k8u+cnGuQFi5C7yhMWvTJ0TO8KTliw6lCcsEBslVavZoRlYJMGJ2LuqgFh5b2rrTJchvKw7NEiPxSAu3XFSrrHzgyOMLHZXibglCcNmkWCryQI66lbjuld1fawfDx7pZawUpMGJ2O8fsK6elejEZYt+O3Hau7xeQWJ0/1e6teutCRcOP5VzMNqJliJngyO6V1VEixQ7iqnXA09LFAv0Yl76rmmYBX8q4dgjeZh2chzwXvwFTWHFT95MxJhISYN/vWwGk9szuuXI+au2nlYtImo/Tys+KTBbsMjEIR1rADdaY3nYUW7YNljZxkLIazXk8HirEEvk2qQEz5i7ipOWOxUA0awsr3aHTF3VY2wiLmrLoRloHz1JKyNqjjJBkHBgnlX2x6LsOy5MUNS1jzau7r2a78PRFil3NXZX289sbmkX47pXdUkLEzuSgNh5SYN6iYsd/WvBiYs1F/kwR2v8v1ElXlYxInNaQ+rqWBlPCqH6HnVyMMi5a46EBZqxuDEz4zKCpaDeFdv5Ro4h0UXrFzuapR5gtjc1flcc3/CCvXLLezp8pUIi+Zd9SOsuHfVfQAqgLBiuavxCYstWNbmku3nM4MqCOtQ3xli7ipGWI0ECzRn0An4VyKE9fKuZmLuqhlhGZx3FfOwFAiWuxkoW30I601XNlSpo5GlmbAwuauzv96PsOJnBh3Tu6pBWJTcVS/CSuWuzuqkk7DSuSv1hFVrxLwtnhqMV4VKPKxde2Q8rCoTmxFz5suERV2Oy1eHic1c/6qBh2VwlzLB+lWmWyF35T6EFXWvDus+mIcFy12dK8CeHlZs1mCvic3p+/hiv3Z9Hlb5TLNGwoJ4V/87wkp3vMr3u+ouWKc6z7DZ6qlcjQgLPGvQ8U/l8AjrlLuamd5VVcEieFdbdahAsILswq2Qu/oQVnhq8JK7ug/ylBCbu2o9sRmoX7s6aSIsv3lYnu5dtSQsqH+lj7DcL2Hlc1fVBGtRTFiw3FW851VnwSJObC5XhU0IC9Gj3RFzV4KCFdDUzPCtKntYhuJdeU2CdWCpG8K/egiWHdB74gdH4V35dHtY8NyVBsKKeVc9JzbndGtmelftCCufu9JMWO7hYcG8K42EZesI33nSIMy76i5YiX5XhuVd2RaEtWK8qzdhiZzMwQtW4szgzPSuxAXL8LyrTcU6C9Yl134DeldqCasuqV06Xt1tYbSEJsJaXvcB5a4K87raERasV7sGwjpq1+wl+KoeYWF8qxqBz4nNVo/tbhCVUuxhWUnBsiD/Kt9PtJNgJes8w3o22NDDQs4Z7CRYyX4Ms4B/VUGwyN6VipIw4lXd4IkG2VjDyq4GbXUPK65R98E8LFruqreHVerIp8PDeiuUlonN+fvgZ0loIKyjYt0cbukiLCtaEtpyrl2hYBX6XRmmd1VZsNDe1VYZdhGsTL+r2YukGmQEywQeFtK7UkFYyZ4MN6B3pYywaj8lfBeHJ766j/KUcMl6WPh5Em0IKzPHedFDWLEzg5oJi+pf9Sesa7+rEQkrmOC8yoDa3dty9goyDaexYBEnNuOrwioe1or3rjblai5YhW5Xs5dx3ScRvkrPE8wxlppYQ+a84A2Xavh/EJZFJa80e1jLy8MiqlRjwsrlrvR4WPEzg3oJC5e70uZhnR320QjrMlPCi/DVr9DcuWzVWLCWsn+FIaxSZSgoWCvHu+rgYW0V4JonrLWvYJ3qvomYu+pMWMVe7Td4okELYYXTUGUJKzZpcBzCivW7MsTcVTvCguWutBBWqt+VRsLK9WrXTVgu2fNqHMK6TG2mjueK9rx6TLuBnxhUIVikeYLUylBcsIjeVXPB8rBZg0oEKzGxGftssBNhAXq1owVLhYe1i5cVJSxCBajQwwpzV4bpXbXysLCTUPsQVjoZqtPDwueu2k5sBtSFpwpwFMKyqUZaniV779yVR58a7CRYyDmDhuldCQvW6tD+Vbw6bCBYxUmDx9xVV8GKnBucmN5VY8ICzxociLAOWPVSGxnTfSO12KTBcQgr1evKEHNXbQiL5l+1J6yDbiXSoZoIywQeFi531Z+w8v3auxHWSqGryHc807vaLs96NthMsNDzbwzyzGBVwfrVJbcuK96/6iRYHj5rsKNgRfPsEzF31YWwXPkiC1ZPD8uea0MhwnoER4m5K10e1rVWNEzvqiZhYXJXPQkLcqpZl4dlfu/D8656EVbpZLN2wrJxpdpfEbs1XPtdeaZ31USwkP5VibAwlaFjcdV7O2LuqqFgFb2r2BSvLoKVOS84Mb2rRoQF8q2OleFoTwnfAiZCWG/fynNUqhNhQeYMGmLuqi5hZc4MqiIsf/av1BPWpl8TKdfei7AceNagZsKyUcayoYvlKRIV8as8/TROK8EiT2wWSDXwBSs5sRnzbLCBYHmcd9VZsLITmym5q6aEhfCuxvKwbAqwLDM4+r6UDEBleFjxWtEwvataHhY2d1VzYjPu1KBmwnpr08T0rlp7WNBZg1oJyyY+npINWMJK97vyTO+qmmARfKscYRFTDVTBuuQWHNO7qkxYaO+qi2AB+rVPTO+qMmGBc1ejEZYt56d4HWo2hdI/sRmWuzrrmlkYKiVOWOvvfWi5q7Yels+cGtQwsbncr30yfP+qDWHBvCvNhGUhUoXxsCC92r1MqqGG8LEmCxqZVANNsCJ5dkfMXTURLIJ31akkLPYSnfincuoRloOcGxwz1lCtH9bZYR/TwyrXisbK56d49+F5Vy08LMo8iamrh3XteTX5qnEEMcIqVIB8wZrXZwlVSIMn3tHXZfs3Or+5233//IGsn59vd/kX1N3sBJzhopA5ccrIxR2YQE9iyjyO/YeSWl/wX52Dfbq+Lt+Zgw1dXzNyTfsOrq/T6ynY8PU1yazvuve5Bbt43W7fN5mFvY88YS0wtdpEy7MI6+pdvdR3KA+r6F8dclduubjtnc4SrruHJTFlvo6HBfSunj9b98+/H6dOcwkTPa9EychF9vPD8UXORz8Tlotnr9iENQef5xol4fcf5PrGme7lOYNP5VJYEi4Sl5FJNeAFKzlPkJa7qipYnuNeNSV9cIf2KVAwT05lyQifewoWmPZZJeF81C5pwfr5g14/ZMKyiZ5XdzveU0KAf9VmACpSvxzTu6rtYVFnofbxsNLO+klo/PZfoE+vb+UUTFSwCLkrNaa7p/HVhbE8JHcF6NeuhrBeOmQY2aszYS2LbSVYxX7tjpi7qkRYfl7LqSuIelUlLEDuKkZYaYLyAnEEnGLdiLkrXU8JSXoVKpanelf3cNSgdsKC5q7OPpXrSljXfleOmLuqS1gR72rVS1iQOYNdR8xnhQ+Xu9JFWD80wfopCJYFelfH3JUiD4s0sTlNWI0Fq5Cxciv7VI4cYb2m3XC8q0YelsH4V0/CMhInc+QEi5i7UkVY6x/i8ngPq3SyeQwPC1QnBhWg6+xhnWtDt/L9K2nC+o+9c91yVNWisNIKaKp2TKXM5f1f9ES5iCiyuAh0j2N2jUrSRrN/1BzfmkzW6gK8qzweln3WYKmE5etdFSFYF1/ButgEC1nmOKNNZVgEYeGVhxX8wGkJC9SrnQR6VxEIq1N/Guddg4kFy9G/EpVhXXUlCJbMLrSAFGDpJSEefQVrBJvuBu9qG3gtmbA8/KsCCGu/5xXB56zu+V/Hbc9gbsKC+FdlEpZf7qoowvrP+zALlqt3VZCH5TlP8LjfVTLCAva5IjROcpQEelfqxOYQ7+pkD6vyexQiWMq6YBvBv8puup8hWMbclWVnc/keFix3lXqeIFi/Mk9sPiKsEO8qLWHBdzSX6GGFeFc5BQudJ1jw3FVRgrVT41WB3pWoDE8mLIod5wwSv47IsQhr0++q8cxdnSpYHrkrvTrMLFibfTptoHf1z5aEe/3a93JXfwNhgbwry/7AtIRlnzNYBmEtvnsTolKJCKsy7xnsyicswpPungpViGChmIKl5K4A+waLKwm9JjZDK8PTPSyHGc6CsGIkG5pA78rkYRUiWJW7f7VWr+yCpfFU65VrL0CwUCIPy3UaarkeFjB7hcvwsGyzBkvxsIRCNZm6LLhdx567KpWwhEK1VShbZfaw4paEMLY6Uq8sgnXQr73y9q6SEZajf8WUi9A4ydHGtwY0ElaYckUTLM/cla5gmQTL2GOmjcJX/9wqITL0vPq7CAsfelhuEyXSEZbdvyqDsNa5q7ImNm+vA81dlUdY69xVG4Wv0grWaragQbC+V8dw+wJ5WKDclVSuy/C59PujCbfP7+dKsMbprvfllFMFy8xK7GsEeVenExb1e2QRrINZOE2cVEMswTJObLZxVhGCddCPoSVRUg3FEda3ftycg6MWh72nRsHqey5YOIlgGYVMfA1r7grFz0/5Xge6ozk3YenuetmE5e5dRRYsUkfwr2K22E4lWEh/RoGC9T0cCdY0Yl7Wf5fVx37vJtf9RMLqxtsgbw/0rvD488toSj5zJKyjyjCyYDnnrvTqMLFgdbZZg00Xx3UPFixe99WeuasCCOuw31UbJ9XgKlhNIGEtM5uPCGu43W4D/8v//v4CEdZETprUPakFhoyEhTrM4qduB73clNu/KexT7U1oo3gmQS/Au0pDWNS4Z9DEWPkIa7/fVamE5Zq7yjWx2eZdCYX6mwgL7Q1FPSIsIVEvY1GoCNZSAeqC9fnj750EayGso4ip+bgMa8E85Cv5mO75Xj9zIqxj5YouWNTdv1LVK6lgAXq1FyRYxqlLkNxVdsKy9Ltq46Qa8uSwkMXDkkx1M9WEe4TVzYL1fEzHD5OOuxthSbTxG6iKX+wL3JvHC3B7cbxE9YnZMyx10yd3ldrDsuWuSiEsUzq0XA8rbBJqLg+LGPYM/i2EhbT1QUvS/QsqWEhkr3TCerPn+EsoxnW6BN0zqBTBqq/D5DvV+inkNv8eP7+G54MrDD/5Pp90X9d2n+vNi5bzhd541sXZ1xqeMzHNntVc7X7e+LxeoOy9PFMJ63LlJ3u67qd5WA6+FU4vWFbvSlSFBc217KCElW7ajfU6tvleUrkSC5acZ+lJWEjzsFwI62UhLOG5d1yw2FLgqArWs1MNqo1gYeE9Db/aKmEzC9ZVKslsVAlleawFiypOPa4fv4/7PHN2XISI6ddL1ox35WLfv8p5krC68Vv5tM9MwfMIC5a7yk9Yx73aSyQsn9xVGR6Wud/V3+thcdqCe1hf+4TFHybCmj47AAmrvq28p80p6r8wjvpcUnmLV4Tzhwb2Bqa8rGSK9ByE5tAvZSXzji5iVXF4yGf3hbDmJwMrcO9eVWFEwfLKXWUTLGCv9syCtckt1J65q2weFmjWYGLBUuaFOwkW2q0N7Tms4TZMy4Tsr/oF2fw8VYdU8bCYiTTTjiCsA8Ea+Zpi9/WtEVbFvsS7Zgz2eYdpyOeCRPepMJ3fGd6qdVVP7z0Jc8c+UsQw7y2+BFYSFPKmFK3iYM8OU/Y/4TOt6yzCOnTWC/KwbDtvyiKs6nOdkLXBvIR1lAz9uzysHdcdGBwd9qPuZsJaLRJOlGMnrErSGEMt/ZTJCOfaQZWTLzfdWJephuEpVEuwEppNtUmofn5+fgnC3axkFEvlWp7JT+H5u09kNXtpd49UQ7hg8aqPOK0OmqvDkwUL7F3R3IJl2DNYe+auMhAWaM5glVawmjVfgQkL7e3IUTf6wZPuXybCQnxUvdjV3K0FazK1YYR1kWZ5pyfdZ6GY5IkLTMed9UlVui9dsOjlpdx/ymH1V1kljuzzIpw1l4af1+JWHzWQrCXcNsLviVkh+c4xsXl7HbfcVT7Cktp12O+qFMIS2lUHelfpCYuAZg1GEqzG7TqNA2Ghw9cInHTfN90hhDWVYhDCUsxywyk9J6SPeOycvIpi/SxZrElqXmsRJRhVo3qGQlh4YS1OWM3aW3ti91RDDMGa1Yl45q6SClYH8a5oKYJlnNgc4l0lIyygd5W8JGzWD2cPC60dLPkfYJXw9RpMrvuyZ7CTewapskp4YSbWlHW3EhaWn9vuJVySD5hfZ7lJvyNY+ENQlUiBfU6jmmDd0SoMrxDWssq45LBaTbA6XIaHFTIJNRVhQbvyleNhMU2qPXNXOT0sSNeYPIQF87CQMYtl3fys5bCMQayjVUJ+XLmcAAhrq0E7US2QYE2bn+ceCVemT0ywnj/8eBNm1T9/2bKAhbBmwRp+5Kc9Ug1hgqVUf8TRu8ogWCDvKrtgWfpd1V659qSERaD+VULC2nhXjoSls5V8gXpJRoAcFgs27AjW0u+qE6H0VQ4LLdy0dpF2CWswEhbZCtZgE6z533qml3MhOdxZ/xv0+UNm3j3msXaVsPCWsOaScDpH7pPOS1jUI3eVnrCOc1elEZauX3Wgd5WWsOBzBtMS1qJdNsFCB2y1euUgWN9ehDUqgsVatXwZ8Km9yarxaiQsURIuJ+PrWrDIdRi+nw1aLQ9eVwkqJBPwbN3PQlhUUBi8m0xMwTLOE3TJXSUTLGDuKrNgWXuJ1oHe1emERez+VfJYwy5beXhYR7oWSlii35XsFKoRViWSWEK4mB7sGVTsVDWpcEBY8mSsxxq6l3L/jqcfxN0RHYepd4x43Y+ah4UVD0sm3bncYdxcn9OnsxKWc/V38jxBv9xVronNQP2q6mC2SkdYLh35UntYQr+OBAsZkle7J8K35tg8LNmrXQ2Oso0uUzHG1g6f98fwbcAnngWthCGu7yVcERYPn9+Vk1dMN+05/By3Vbz0jYRS8Sgo//SUsRLvqM9Eeotn57kllkawDB2viGfu6mTCcs5dZSMsYK/22jN3lUCwvLyrkwmrOearaITVA/ph3Q5yDUvvF52w9P4yeFlq+xkMS4AXfWsONpvuysnDWrC4b7Xe46NsJZxjFoQJ1cB36wxP0vB33nh5JghL2Uo4pxoyEJbQLrLoFw2ZhHqeh9Vt/auCCcvUq72OwldnEhYsd5WPsNb6ZRIsMF1BVgldc1giA7XVqxl8uGQ8RXeFrRoJXRgeVsLaOXlRrFHLMGBR+3HKE9Xe/OLFGWsUm5uXZ3IvIb2GhRq8BGs3004CvavTBMsxd5XRwwLtEqyD1gZPFCzH3FUyD6s5fiTv6b6/l3Bn2o3ecZT1SJ7fv7HgOResbU/3HrOI+vNuPEXJc/XzycMv2awSYlyPgr+eD5FpZw1iPl+AfVV2q8+LC99mSGdF/XDV8kxszcGouvzwy3lZ7jE8LKZfxDN3lcrD6nb6tZftYe076+VMbDZ7WGCVykBYumLtCxZyoyuwYA3D67/DvYTg8Vyi3fH0m85tX/g77DfFHYsNUDxflU6/V2ewt7HoGDpdaFyaMyy50YplEHreVRSJ9b1edBmlc16d8hsZZ0xU/HMdnX8jz1SDm2AddGwnXrn2UwkryLtKRliOcwbr0F3PsQVLVICe3tVJhGX1rlIRFvAImifYKwomG7dXtg8sXWQej98OLUmq/ak5eDXNyzZjEOm7mlHqic02/SJBa4NnEtZO7oqWS1i2OYNlE5a7d5WGsDb61YifUgapyileAQNQe69BqiO3z2VCYd2rvUIIx3hUWu4KnV8SWuYJhnlX0QnLM3eVmLAc2EolrKIEK8i7Os3Dauz+1b9CWGHzBPkq4TDI7dXA62Dr/FQ1HZqfsNbKRJg24bPyU77X8VKprB7W8azBkgkrZBJqCg9ro1ZNU45g9ZEFC34dZTbO876ZNVhhhOIQFkojWMBJg8Qzd3UCYc01YBPoXZ1OWJU7X1WcsGIkG6IIFpk9LHDPq0SE1cD56v+EhRDtahaUmBpu9dbr4MMf86zBnIS11/GK0ND1wdiE5Ze7yklYkFmDJRKWkhb1noZ6HmFt9Ev6VwURVh9dsByug+cFvr6fGrcjvc6rojhYePawEgkWqJcoCVobjEhYcp5guH91sodVuT+KEiw5TzDEu4pOWGC2Komwxj4fYXldZ5epDidK5COs/UmD+SY2m68T4l2lJyzYjubyCEvbjZOoF7vp+GPYM6jxlTyiCtboLVgoJ2GZ6j3MPawArlp+khAW0L8ShEUjJBtIoHdlJqzOqzKMTliVz9rgUh3WcXbm+AuWNmmw9cxdRRYsWfe1TnwVV7DoxVewLqhowsKH/tV+7qoEwjqaNFgOYTHdakJUKiFh2XJX5RNW5a9SpxGWOXe15qu4goVqX8FqixGsTZ1XBXpX4khAWE7zBUn4rpwwwdJ4qnHcM5hQsCp3/6oowVqxVBvoXUUVrI8atU58RZqqi1gSojG4IizYw1rnrlz8qzyEte9d5ZvYfKxbDQ1lq5QeFrwjX1mERWYPK4SszvSw9nJX+hHVw+o9EasqQbAM+YQqyL9KRFgUujaoe1jhyVES6F3tE5a/ckX1sDxyV3p1mFWwdrpdtZ65q4iCtar/WjBbsZ+ohNXjS6CDVa6H5Zq7yklYkEmD+QlrnbtqovDVuYQFyV2VSFhqx6uWhLpXsQkL7l/FJyyEx7CCMJtgHSbUQ7yrRB4WdXtkFCxD1qrpoqQaYgqWl3fVlSNYu+uBbdDaYATB0nILLdi/4oIVlbA+xyWIr0r1sAC5K5R+nqCD/55xYjNAu4qaJ2i6zvGewZMJi97VcjQAACAASURBVNSB3pXQqLaKQ0YxPayj3NWZhMW6aFVOkDVWKLNg7eYT/AnLVBmeIljU3b8S1WEGwTrsd9X4dZOJL1i87qs9c1e6imUhrINu7a2yMlilEyxjv6sW6F2RswhrSjeMQM0ax0ucwGdkwlJzV5UtdwWc2JWCsI5yV+UQVrfb86pUwnLNXZVGWPqkwWQj5oH69cewZ/A0wkLK1Bw2X1T+w+ZxWkLdV7As+QR3wjIr1wkeFnX3rpbqMLlgWfpdNTEc93iCZZzY7DrHOQNhHU7CaeOkGvwEa4eh/oD4qjnPw1qpVaotNad4WFiMqvfKXaUnLMjaYH7C6gw9r8r2sPwnoeYlrG02tAzCWvTrjyV3dYaHNbcn7naZalGuXm8Jml+w8H623Y+wLKmGuIIV4F0JBUsoWKBZg0UI1v/YO7ctt20YipKiZEqZ///fTmxL1oUUcSOAacaK29Umy09ZZza3D4FwcFhId+WAsACbBqcctAPrdl57ArqrToQ1rHQFTyhnhHXuWgVi70qTsDDuypawCvPaHRMW119pbWwGuKvgh7DGs8Maof6KTVivlQ8vd7Xc8pXDwEJMCqX0rjoHFtldqQfWAtk16CKwDt8LRsK9QWPCAm0aVA+sxryr1OhdjT0Ji5xS7hzWh6kC013pOCz8LgkLwrq7eeOPsGi9Kx+EVb/bbE1Y5/xKQHclQFhvtvrz2dhcc1eOAuvcUBi4hAU9GYoE1veZLxPuDZZOhwqBBWKr9W0WWJV5V5HYuzIhLIC7Wk+FioEFmtWegO5KmLCGb8LiuStLwrqbdxWIvSsNwqK4K33CWsrdK6eEtWZXZHgrS8JqbRrU2tgMzK8xofiKQFjD/r1jqYXprlQC69H+VhDvsNQC65lL+cFzV2qBtbSffXIZB1Z1YzPtu0F1hwXeNKh6JATcEUwjrjkqQljDSlgstrJ2WOV5V4HprvoRFq53ZemwIBslfDms8HRYlN6VLWG17zVbOqySWU9jZ8Jae1dHvjoTFv1k2DGwHhTGCkx3JRJYu7NfJvauFAML1LuaPQTWzbz2yHRXKoQFdldBM7DGjNg1mIDuSoiwPgfERYSv9AmrtWcwUBOqI2Fx3FWvjc3Y3pVHwgoHh8X3V5qElQv3Bq02Njfy65BOaMJaiL2r87OwvhtUCCzGxmbCNBnpwKruE2wxlsmRENC7chBYt/MYIrF3pUhYGeKugsWREDGnPcFv5fAJa59Ypuu52A6rflIMTHfVx2Hhe1cWDguzDTWaE9Yxv6LMhnklwoLvlLD4lrBy82YkOSwnsnP72xIFvplh/0XZ7XKLOYCfuwlDvRZPUm9zJdQd+foL+xdu94rP9/tJcaw8cXtDXinKvL60Pmfa3rfP1/d72t7019ck83p/Tnq+q0/a3rXXV8K9iIS1uzP4XPNuvAAVTViP03yZ+ryrsO9fXXcP1riry17C+eCwaO5Kh7DavavDa52HZbSXsDSrPQaZDahx9zPw8JNw+7X77eve0+2ZiL0r2g/O/U+45z/HDye9f+B9/gvTvbr8NOzisEq9q5LDchlYD7q/KjsstSNhsdOeib2r7oG1wB430r3RZI9Fusd/a9jpSAjuXQmQ/gj+nBH/JNzNHJrDKrVD/e4TbM+XubujEwb5hjqHsTLGrBt9S7ic5rX72ScI3zMIDJrnn93iqnDnsK/Dwu9DpamJD0197gDSeldcpQAJrKH+3eAntRaZVoNk8JF6VzXCYrYa8IFVuTOYib2rjoQF7l3Ni3mtAbxpMAaRmzmygUXoXSlId1Tv6nw67Fpr2Peuju2FPz+IsEr3n+vzrvLjMXggrHlzWJReuxZhwXtXHgjrbt6Vr43NV8KC9q70m+64PYOigQVxVx+H5Uy6PwaRJ8i0GrCBdbuxmdK76uqwiN5KnbAQm3Ai/1ZOj8ACfVetHlgj3l91le6X7wYLN5t/msMCnBUN9gm28ysz3VVPwkKnlLnDqm+T8E1YuTivXZGwbntYI2LXoHBgDcMf4Kx2R4T1zKEwtLdHQAlL4lSYcd7qgSEsSrtBgLCe57+R6a4UCCtg3NWesJi3cmQDi+muOhEW0l9dT4edCGuozGv/iCzfhFWfeHUgrcK8K0vCKt0ZzLMEX0kTFrJ3ZUpY++xaqr1kr4RV6F0FP4SF81eigQVxV/vvBd0Q1jt95ByWamA1Z4lm/q0cGcJ659Mo4K9UHFbAPVHmZo7Ymq+J4a26EdZIe3rXGqop9eeHOazyxKv7Zqi9wzrmU370609xPofqrqwcVutGs0/CIqaU0hUx8CYJ+cBq9a6uMxkcENbhrMclrLV3pUZYwFnteSZO7JMlrO38NzLdVWfCIvmrsDksB4H1PgNOTHclGFjj+0hI6l3lztK90rsaLjVRv4TVmnhVvCNoTli1eaJZwF/JEdby/Tk8d6VLWKf8ummFeiQsSu+qP2HhvZVYYGF6V+5qDcSNza1Z7UqEBd6Dk/m3cviEtWOpETRP1CiwAt5dLb4C67CxmeuvxALrO5smtLfKo8rVHOhGCe8OC9S7GrT3CYLza0snm43N9XPhyHRXmoQVSu5qcbBiHkRYPHfV02FhelfCgdW+M1ibJ2rosIrnvMD2VwqENcPd1Z6wZv7NHEpgLaV57aMIX4k6LLK32p8OzQPr1LuamO5KKLDGg8Mi9K56Sfdm78o3YT3en1P3VgNw4rEmYUFmtfshrGV1WAufr3oTVmni1X0z1AthrXcGJ05KdSMsnr9iBRbVXbkILNI+QdieQQWHhdoymGcZ6z4y3VWNsNwEVqA8bgLrYqom8GzbjoG1Y6eJ2LvqQlhDZebVT3NYlN6VvcO6b4Z6Iaw1oXztE6x/DnaXhFThM0p0Gp4TR7lsJU9YlN6VUGC93dUfeO/KQWDdzrsKTHfVPbAI/mreHJZ6YFXnXY3E3lWnwAqR5a8cEFZl5tUkwlfkwLrcF5wE/JUQYZXc1U8irMfbYTV6V+vNwcbNZi3Cgu4atCWs653BcfZMWHcTr1ysmAfvGZxE+EqKsP5OHL2f1d6VsDjuyiywGh2FwHRXnR3WjHVXa4qZBNbNXcFRptUgE1jfuRQJ3mrxE1jVttUk02qgBVah056IvStxwsJ4q5/gsAgZZUBY9d6VxT5BUHY52th89znUPaj2DuuYUCoLUBH5lQT8FTWwQL2rP74CqzmvPTDdVZfAInir8+lQObCa89pHmVaDzF7L5W6vZSm5+m+7iXi/XiUsgVYDNrCq864mhreSkO5kd+WDsK7zrkJ10yBu13xvwqrdGbTc2Nzw7oeE8ktYF++Omhejs7G57a7WhPJBWJ/sStSEYgcW012ZBBZpnyDtXNghsNDeap9gqoG1tOe1uwms0Nocfk2vxY90b05qNwmsm3kMidi7EiyODmR/5c1hPTaHRXdXeg4LN5HPirBqzVCvhEV1V7YOK1dnXnkgrH1+pczhqi6EhTsVKgQWas9gAJurQSewiL2r8wlRKbAAbPU6GRoH1qW3EFGtq8WesIC7BpUDqzmnPQn4KyJh8dyVPWGV+1ahumkQt1OiF2FBe1e2hLU0dw36Iqzw/Tm03pUHh1VyVz4I63pnMDHdlThhuQws0j5B3slQKLDmTOxdmQTW0n7cBFZ1nyDkxqC5w8ptf2UUWI2eVRrJE2X4hEU4AbpzWOezYmC6q76ENaPdlZXDak2N8eiw6N8NWhLW/c0ba4d1Tqw0yrwECIt2MuwcWCh/1SYs+KmQHVjvc18m9q6UA2tp+6tjchkGVvHOYARPvDImLBBbfdJLKbDAewYT/1YOi7CYfGVFWI9bh0XpXWkQFrzXbklY9+7KH2GFzWHd3Gl2R1i53L1yQlj1eVcpOyEsanJ1DSzixmaBVoNEYFU3NkN6V+qBhdwzaBZYNxubcbcGTQgrt59jcqkEFmKHc+LfymEQlocFqAyHVTorBqa76kdYvE2oWoQFncjnhbDWVIrE3pWdw4JtlOi7sRmYX7vTnwOHxWo19AisB8Vd3RMW/mSYme5qPf9lprvqHFhgdzXbBlZzXnsET7wyIixg70r5SDji+Co/g0ai2UAhrOFnERZsz2Ag9q56Ehald9V7YzPVXfkgrOu8q8h0V5qEdde7siWs9qx2c8JyGViMzTdBptXACazqxmZM70qFsBC9K/PAaswSjUx3peCwQL0rdemO3DOYxmwVWD+NsGB7BsPAZStpwuJ8N6hHWNiNEtHYYZ3zKwaZHfP9CQu3DVXbYbVuNBsS1iDRapAOLLK7KhMWPbkyz1+BCAtzOhQmLHTvypCwQPsGI7F31T2wwO4qaBIW2l2t6ZUkbj7//wkL5q/+plMQ4SsZwpo3hwWbeWVDWDh3ZU9Y5XntUcBf9SYsSO/KhrDgewZNHZa7wHrwnyDTaqAEVnVjc4uxTGoNRHelTljAOVeRN1WmV2Bl2NN/PddE7F2dT4emR0Jvs9i5/kppASoqvzKxd6VFWNRN81aEVbvR7GVjc52w8mVeuxfCuutduXJYjgjr+yjHc1dHwmK3GuCB1Zh3lUm99o6EtbT4CnYy7ExYIG91JSx+s0EssJjuqiNhIfnqeDr8JazbzwG5q0PvypqwzvmVZ5676kdYS3Veuz/CKubXIZ08E9aWXYRtEn0JC+6ufgnr1LsKj+Eh5bCUA+t2lmgm9q46Eda2T5D23aCiw0LtcH4RloR1FwwssrfqSlgj/tmn1y9hAT4HdFZU3tgMza/MZqs+hIXtXVk7rNYuHL+ERUgpRYeF3STxrxPWlkVB5DtC5SMhYF57JvauxAnrfQIcme5KgbCQ/uqVXFGm1cAPrPf5b2K6K3HCWk9+Gc9We8b6Jazi58B7V2e7bklYpXntWcBfSRMWKaHMCKvcuzozlkfCovSuegVWYrqrX8I69a6CCF+pEhbolmAW8FcChLXZ9ZHYu1IjrEB7nATWlk+TgL8SPhKOlN7V/y6wejosQO9q0N8niNszaLexufY5PHelTVjQG80+HRbdXfUlrEKvAXjj5l8lrMs5LzDZan13JyzknsHMv5XDC6zTrcGR6a46ElbAfzcYDg7LPLB2vauJ6a7EAut98pvAzav70+EvYR0+h+6urAirtWfQE2EtH8JaeHylQVj3vSvPhJU3h0V3V70Ia0T12n8Da89XDymHtU8uBYeF2OG8Ehbfuo/UjDo9o4C/6hJYAe+v9unlILAONDWB5omqBNYzlSZi7+o3sACfg+ld2Tus+3lXfgjrlU7jzGUrPYeF2YTqh7Be58KJ6a56OizOJtR/LbCqZ7zAZisFwkL6q/lNWBLN0ZHprq6ExWo1SAZWwPur6+nQLLByeebVJMJXjMA6NRcmAX9lGFjRGWG9JoVy3JUFYbX8lRfC2t8YHJdFhLH6ERasd+WVsNbcmrIEX8kS1s5ckTdJ/FuERd7YDD8VdiSsmfIYBlaxbzUuMtZdLLAI7qp0OjQMrGLTauLdyOEG1sWsT8TelYvAik4dFsdd6RMWrBFqT1hHt+5nY3P5cyp3BheNb/f+hk9k8tWaUDYbm+v5lUoTZRTI6KcSVnPXYCD2rlQIa8Z+N/g5GWaJm8+YwGpMax/fyTXbB9YzmyLRXS0eCOtm3tVE7F2xA6syrT0B3ZWzwIrr2xFhPW4dFtRdaRLWJb9uWqGWhLVl186v+yUsmrvy4LAKdwaDF8JasysJ+Kt/h7AAc0SDgL/qFFgz3l990ks5sJbWtHZXgVXd2Ax3V4aBdXtbcJJpNVACq7pPkNK7Mg+s+HocOyyau9J1WPAbzXaEVe6GenZYmN6VL4d1tet+HNYrlRKxd/WvEdb1fDdwCKt9MhR1WDPeX51Ph6qBBdg06CCwDme/SOq1GxMWYF77JNNqgAdWY9NgIvaujAIrHt72hHV1VaHVuxrsCQvSu/JAWHebBv0RFs9d6W1sbnj3k123JqxzfqU1l7IuGcl8TlQirFumwhOWcmDNtO6VWWCBNg2aB9ap0x6Z7sqAsHIAzGtXDqzmJpzEdFeqgXVgK0cOa89Ugemu+hPW/Z1BP4R1v0/Co8OCz2TwRlj1Zqi9wzrmV2LbKzvCigoOq9m7whEW/FQoEljf2ZSJvatzinUPrAXmrtb0Mgys4p3BSOxdmRAWiK2CbmCNsE2DiemulAIrlvnKlLAetw7rfp6oDWFR3JUFYUE2DfohrFduRaa7siCsUu/KE2GVJl4lEb7SJqxPdvUPLNLGZnarQSqwqhubW70rg8BCbRo0Dazqxmbqd4OqhJXbj0lggeYwJP6tHJ3AiuXH3GGdz4qB6a76Oiz6Jgk9wlou9wZ9E9YrvyKxd2XrsNpTY3rvE0Tkl2l/ivs5a2K97nAh5g0pFPYy7KfYkcODO9l55PHEnPAo9hflTdcpjjdP3N6tV4oyry+9z5ne77//rD5f739P25v2+ppkXofPSdu7+qTn+/r6SjKvTp/zdXgXHmXCas9qD9fe1bWHJX+XcN45qsOvzHRXmltzCr2r+YawgH+yF2Ed3XtkuqvyD85cmK13+N/V2XsTtNPQuNk8MXtTr19/v93b/Wjbfuc/6s6FSVEcisKJRCCjZVeLWvT//6MDeSdAyDsRd7Z6UNCdLc989+TkXgfv3fDVE5ERTHEf8hcM/xuU/lWp2+1b7z1TSei8JujmYYW47l6tjbkS0X80bRoCc1cFS0Kn3FX1kvCklygM6uO+VbjMJaGzd1WQ9J3n4EjSR9HZhmwlITz2r6p5WL0lTwqi1gZzeFg+PRlqelh+8yRqe1imfsEjZ53pEzaUif0GG68s5GG5d+Sr42Ed9+RrzMNaCMvNu2JORRbB6mMYCyThq0DB2tkzOATmrrILlmfuqqJgOfVqh4G5qyKrhA57Bo8qw6yEhfz4CjHCSpFsyCB88JyvihKW26xB4LlnMCdhjew+Qd5VtonNYbmrWhObHfULwEjvqtQqoat3VYOwXCYNtkZY3cnqkLkClF6w+rgHSJNqCBWsw4nNIdmrzCUhPn80UhI6eFIwMHdVgLCGEO+qAGF5eVdcwZqNNZyyFSMsUNjDOqsVCwxA9dKvITB3VZKwxoBZqLCih7W3o7mlic3HhOU/UaJcvAY5TRr8FsIyvSt+pCKsHjj2u3IjLO9uMnGCZel3NXj0vCpGWBHeVUHC8pozCBP4V8kFy9m7chKa2/sn/LgfPfG+eU0a7NLszEkpWNCNr2hVmJmweqt/peiaUCdwqU9Yqn4Nkd5VTsLCJz2v2iIse7+r1gnL17vaCFYXI1cWwbrf350ld9U4YRn32eauzPRyOg+rj/evVA+roGBZe4kOgbmrjITltWewqoflMQcHxu/KySFYwd7VRrDex5oTKVj3t8ceiiYFC7o9YH7COs9dmQ77UN3D0vVriGarXIQVoFKVPSxg6dfeNmGFT5pngoU/cXplFaz7zX0WausellYb7hwpCKvXPKxowur7S0nBOunVPgTmrrIQ1lL/oSR8lZ2wAPacMwjjd+WkE6yl/rsG5q6OCCuuILQIFkEs90mDDQkWFB6Wx77WjITllrsy3fWahLXnvQ9J+CotYYXkruoSFjjtJ9oqYQ2Wfu0+HtZPNsFan3Lvx9euhyW8K+vO+3jCCpwnaCOsgoJ1mrIaAnNXGQhLTGwOyV0VJSwPtlI9rEYEi+jTdYhZGywqWMth96+aFCxW+3VOfKUIVm4P63SPjlEB1vWwtupUc2Lz8X0CFKoiYW30a6fya5Ow/HNXdQTLfZZEq4R1lLtKSViaFoFo/4oqVyHC4pVf70NYMemGIdK7khObw3JXBQQL+HtXUr1gmp058YLF6r9rpHdVTLDWJ+7ukwYrC9Ymt9B59mRLTFheuavdnc01CMvW76olwsLCw4rtYlWCsPzmDLZIWEEKVYuwHHc0t0VYcLmPPXcFkwmWUeeBJHxViLA8JuEM8btyYglLoykU6V1l97C8+1o1JVjaxOaQ3FUV0/1+tjbYmGApHNWd5K5gXsLyz12VnNjsoWBFO4X61IUogX9V0sNynYTaFmGtHUfjvKvChNX4xGb7fVy8qxgPazefAKLZqi9BWON58mpLWCmSDShco0YbYYVWhYkFK8C/0qvDqoK1s2fwGuld2QQrpF/ydeNScf9KJ6yzZENFwdqdNdh5zhNISFhhuau6hDWe9hNthbC4bqFI76oMYfn5V4mHmCTw3AElrCGWryIFSzm6Tb92lb7cdzS3Q1hQeFjOE0+CBCtwnqBrVZjdwxr9HkOK1GiYYO32ZECR3lUWwQrIXZnVYeWScONWXRP4V5GCpfWL2SGsu3y4TxqsJlgH/Ri6k9xVdg/LqTdy8XmCztmrjTq1QVhSodBYxnuKuY9L7qpND0vWhVeQto9VPGGZ/a6+28Pi+nVDrmzlL1jWflcg0Lu6lCEsb++Kq9eQZmeOn2BZ+l0hnCTVkEKwiC7BwNyVqWLVBOtgz+B1SJJqCBOsnV7t3b6HJQjLYVdOLcGy9rvqvPgqmrDkeiAIzF3VISxDuyyJ0JqEhdVfTKFamtis38fft2rJwzL3DF4T+FepCAsJD0t11pXc6FcRlp67uiG/Qbl+guU5T9DXv8pGWN5sJXNXFQTLulsQRa0NZhCsoHmCzZSEh7sFr0Ma1z1QsDY8ZfewkHNytIpgWbJWHfRKNaTxsHrmYYXkrmoQ1oF+VZon6KxdTcwTPLuPa+6qLcLaJhhS92KP87AQ8bB0Z/1HqQm/y8NSFeoG0xOW05xBEOldZSKsYO+KV4dFBcth1iDCYwuCBTQPK8K7qkRYw1k/0WuaVIOfYKHjWYPdySqh66zBgoIFXWYNdie5q4SEpesYCMxdlSWs0cu/qklYR73a2ySsOP+qJmEd9btqgbBU/eo2qVDGV/f11zcQFtydNZiesIInNjt1k8kvWGPIo4pg4dGhX3sTgqWsC8LA3FVVwnKYNFhJsA67WnUnHlaTguXQp73zSzXEe1i98LD6KO+qlIfl242vDmEd77xpkbBCclelJzY7+FdZ5wmGeVhSn7rNrEGhVvfvICy0m15ISVi9q3/lTljnlWEiwRqHKO+qLytYDt4VrwwrC9ZmvyCM9K4qEJaVr3juqrhgncxx7jb9GJomLMc5zpB4WBkJ67jfFQjMXZUhrMOOV6eJ0NKEddavvS3CAst97L3a210lHKyzBmsTlum9d5vkAvevvoGwjvtdpfWwAuYJDu/7/Pv7O3+0GvH2s558viapIe/1xMB/fOJVSh6/6vHC/HXseE6aCpFn9FPLG5G3f34Q1SZ412754SwlP5DgK+2NtoKF5fPPz/aces3yBL3//PoIwVJf+/sE67nbvP5HEm16kw+nMdVb/7NoRbAOJza79GRogLAGt1mDhQXrdLLgV3lYHnMGMxPWcb8rok89WL+D7JBScpWq8YScgMj38UOSDG8uTjuCNby3GkahiWrRn8pRqqjQt7/pgvVHtUn7QExRLg/9jUzB0p5nTxvXAP7aTrl/dyhY5A/rRZ79RwVLqwsfbQrW5j5huavaHtbZzuZEgoXCCGvb8XgrEHflaJuwbMnQFITl7FttCYt+KWeqWh9aF3K9mjXFot9HIisjJ6z+Pa8HucNyEC0i7MFPa/pEtfGp1H4MkmZOPIs2oR9+KbnHpOrVLBVrrQyNN9qUhPx5hmraOf2aTrt/pwjWzA6ibZgR1nhMWPz186eyYB32u4KR3lUhwhpc1gbVqrAIYVlyVzbCQoqHRavCJgTLKXdlVoYZCcve74oQFpxp2XUZ3rOs4B5EPvCCX+sX+TWq4vKnEVa/jrwn393lJzokgkDMtOoeIkWkCJau6LUKhQQ5cOPQdv3RXkreaxK1H6AfCIxL+Spoid5+edGCbrRa3SOspezriZJQMOPXjNo1mNz/o9+fCtZ6fU+dM8wIC0vC0tx1ougTZp5WYx6W1C4YmLuqR1iKdll2NtfwsDb6peSuvo+w9nNX6QkrcH7zSlhEa16UqxbxmInOEBJ6olV+MEGbSThQM/2dJCxilr95qSidKnoJuKs21loRfu7k/ZgsgYfUpTdhOe5Y0XtwxSIfCJKfIf1AQmYm2qHhLi0pnbAm7ZUjFufUa8T9xwu9vyZYeMTC6Dr1sCbcjOlumScYkrsq7mE5eleFBQu5+Fc6YfHjhzvu7QiW89pgLtPdY4rzSljDg5V8Kw/dblRHsFScnoDEnwCkF/FwVMLaChYBqUlUkTMXLHKr6U20kK0D0u8//R36EIlkPEPuIVYHBRYtKPjmlRz5nPMkEGmedgiLnRQyhfauAVLFiHD+/mEuWPOkLgcKwsKcsNRUO/2vxe2tEgKTsKLpqhxhGZWhg9CUIiwbXe0LRMuEBZ0nOccJVh9HWB0RICN1RbgIcSyaOUyt3/oX0zIbYdHKSDCVrPMe65f9JmtCJg678wQ1wiIfCKq0hXUZIty1KQlPCEteQ1iLW/nXmTnsSHntVxHWSad2mICushLW4E9XhQTLma4kYemC1QxhwTC6ykhY53q2Ehb5AprJq7UMFHIkNWcFlhckqtPbCAtzwhqoA8bVaZW+T79WgS+VuT5qDktNLMwTz1zRD8QI6Cp0pucyhJjVduBhUSWhK4KIixBUrunuPLbA32zYFyxGWEKdPlrqiii1MOlRK4Rl6heMZquyHpZrx+Pyq4Qb/dJSV40RFuxcVwZP+sbECFYfw1iA+lYL4hipdrQyxsh98bsavloIiYCFlbC0WINAtV6Bs4klQjWOOiYsRnl0bZDynyCobdrBukqI966BsxAsLHFLXyWk/voRYdGqUItBwAqC5TQJB0asDBYgLK+VwWKEhfz4CjHC0jsy/LRQEgatDGYmLLdpOAthjYyw9AOqhHUVhEU8LFJdPYczD0vmPmUMi7IZKek+lLk4YVHfalB25fTcX+oFVFHC6iUB6ZmqD94k1JH6Qf7w9hy7Bl9Vwuq4IOo5rJdCWKMkLGwS1lawYDXC2u/IAJPwVW7COurJ0AZh84CW5QAAIABJREFUbfRrpx/f9xDW+cpgGsGKnNy8EtZV8bBk2EB6WPQVioeFqeCcEhYDGyU22s1aitPfw2LqZXhY4o1sSff5NbGVPqxewzVK8bAwXTEEG8H6sxIWrQwb8LAcOjBAEL3vOZ9gBXhXhQjL89Gw6e6RaodlCMvNj1+xCTxkMBS/P5NtlfAfRSRSDp4S1kTDWuI0XVUTAkJrwotQw0W/hh+yTKjsuuH2Ua+s4rEPpOWwwFvmQlXCYh4W1jYIsltp16irhP/0VcL1eqoEQs00D0s9+seuYMGKHtaes97WxOZ9who8vKvyhGX3rr6NsDzmSQQLlnUajn8OayR8xaXpwnNYRH30HBav6eYzwpp4nIuHGkiIgP7fl3UgyWHR3YJYYypJWISrWE6Kr+0xcRGmOH2jcTxcJVTW+Xi2SrkGK/fHBzks9jAJS+/VV42wvKY4wwT+VWLBGtyS7UUEK5qwkOZhNSVYXt4VyktYvdW/Mroy0PTChaUWfl/dckJJutNgOeR7ChlLCePqrW8SNARrZDksBkM8ZrV+1f/6f8sB7gKriAD8LmRFsWytFGlHhl7JVS0vox+o43tolH2B5EXsjfY8rNkQLHGulyuHIxjE/enaIRiNHBZLr8tVQvxv38OaWyAsezfR9gnLz7sqRVhnuavGCcu4D9xPtmchrD7ev5J7CW982x7dJEOsLBr35ifFXkIuWPTZc8JiAKWdNPwpzLcyku2I04GHxfcS8g/UmQQ1PJQCbzBpao+wjGv27s8IC1sIiy8hPidBWLNxrpCH5TFpEMbtec4jWEOMe9USYTUsWM65KwRzxRqcujIcdRSlWQUkuzXMQnTwbadbA/OwOGIdENbYC8KinSDo9UqEFIt1wn5Vplnp9sJ7XfWXhw5HQP1AV3Ov4AiUmtFYJdwhLCZY6jXa/bVuDZPWpY8RFjYyDLQQ1FtXCNaq4WHZOoq2Tlihk+bLeFgWhfoyDwuedGVI72FFExapDJcSjnaC+ozKUiGtjdblNXlSOO1rUedCWNTNfvFGDX8st4BoioDR05W243pO6iphz/cdUw+L9KHhH0g28ZOCRN/Ii7Cwcg1ef6fcn9R/NsLCeNwKlq5hv4UIC/jxFRWaFMmGVA38ruA8dQXKCRa9D/InLLM6bEiwoPCwIryrhITllrsyp+HwLi/kNeu/1QMD2nlB7V1FpYP+pDw19P+Uy8f/1J2Jmqq6EoVDE6aDfs1Fmv3+b3qVIfNQmSO0+/RRRKV1+WexUnXc9fO/H5n5bPlzJBOmcRxJEaxRUQ15GphKx29BeO+DEZr+57/x3AOzETo36o9fr9sYwnp/PkduJx9l+1zXk5vJrj4bHnUW6FRnPCJDNdH3IZKkY+AcrbEIYUn6JalTnYSlyF2hIoR1dGwWCcvVv6rbw3LLXcXwsPo4HlZIBXZIieTx3m6EdMMZgN0m+jglkifD70zHZn3FduiSlLCQ+9rESI3GEizSsdnfu0pAWIcuuRGWrFzVCNalT61n7iqZh2Wdo5Op282o+nVUdRvkV+9a7IK2+XZsVtd091CogmcJId1wavWwfL2rHIQFyV19C2F5qVSwh+W90lEhSiRY9k6oJsKydEkFLIO/RnEVj7GhE05hwULu3hVVrybOzJxQwSJjwM551mAiwbrGfN017oMSlm50WFiwpNxCG+hdBRKWe+5KZKwhj2DZ9Iuo0+CrUIEdm3VahjWdnOsjLLcuzvURll/uKq+HBfOt6iWs5r0fv9xVcQ+LTBnMIVgOXQYHZR/nhIRl6IaqJiw/1UrmYTl6V1UJFpNp7wK9q+ixhrvHDYiw9OpVhWAJHZtD/atgD8sld5W7YzNIv5iRX5mOzfpOgzhEpQp4WNCKfDUSVoh3lY2wLLmrb/CwQryrAoTFjwoTE5ZzF+chgn/lLViKTs44Cl9FFyxv72qqQ7Ck+YJdoHcVRbAw52GBCMs2OiwoWMqaV22gd+UhWN3ngpBn7qosYem9q1udaiGsW7fwFIOvUhOWIXc11dKx2VzvqvPMXaUkLCwSlqN/VRdhNcTDCvGushOWuCT3sEa3dRj7UoKlTFphz9xVUsFCPt7VVM+QUOFVdYHeVQTB4urFKAjrYZs3WJVgaeYMto5zBqMIVncQFjh39RPv7F74fiSFimeWRyQsqlD1dWz2y13V6mHdCtUN4f5VXMI69UvwsCJ0qSlDWLdCzTiUrbIRlnpkmIiwRnf/6hwVFhGsScdXJ2FN4amGOIL1VqYGuZ4bVI8OCwmWtt5VF+hdeQuWpotzyxLW47xAcleFBctaq72NwldgwepOvtJ4WELuCsBXuQjL7l3VQFiKOYNjvYTllruqz8Pic1cdikNGMQgLEw8Lix7WlxGWXO9qjsJXGQhLp1xJCMv53CAdHRYQLONsQRzoXUUUrEOZminMuyo+JNTkrbo4qQZfwdJ2bCZ89WA9LLjzXkSwDFmrtomSaoAJVkfXw8PyyV2VICxJvwyphbIeluyw1+5h+XZCLU1Yorseu/BeKGO1lzZ9N2FJ9dqdyagAYRlTDbEJy9u7KuJhTWb/inpYhQWLGf01nrmrwoRlrdXexUk1uAmWxr/iCOtBV4+ZOTkFC9RrsPXMXTkIVsddOo2HBVaorIQF965KE9akmTNYI2GhQP+qLGGp613VQFisfrWXOjGe+5cRVqOseZWfsE7dAhNWdsEa3ddCgjXZ/KuxHsHS9hOEzBssTliAWu0FBMvYw1lHWEOtggWs1d7GSTWYBavj/StCWCHeVS4Py5a7qoOw9DNvavWwQrugpu3YDNSuhM0jQr33y8O6gqOnYn0TYelqtZfwsDqYhwUbGUYSrHHwOjcojw6zCBbAu7pHhkUFS1HxqvHMXRUiLFCfQZRbsLCNr9SE5TgrJ5dgNXC+ag4PK6FgdWq+YgjLNXeVh7DcvasShDWps1fVEhZiPCyQs16Vh2Wu1V6asET9ai9lIpmGx7cQlrneVV7Covp1vuEGmD9gqjFU1elk5pvNpfdb4nIcDWw1L22h08nR9tOp11lxnc8yd3EWzX5a89oeF3aZr/+y8tJ6LLN0jd8eZ/ON4HXmLvkWtYfVX6TVm2qM9lwjHI9Yw8j9c/aYGAfP3FVZD8s+s/mo1sCOEz1n6MTxsNB7P365KzhhMR3j2R8NL3XuuSsU9wsPs6M8fHpP0tcbvxV7NfkPd5aQfOE9br5y4iF9H0Anwvp8DZ4/zWwKhhpyV4ovKnI9brjqMi5ufDd/yIn82L/jDB6WU6ohdEhItGnwzF2JjSSSCpaDd1V8SKipeNWAvKvi9bDA3hUKTagL/3amTT8/AP9K72FVNSRs4P4VVaO4pH8P+fTeleosYe/jXaXxsPy9q1uxchHWBKzVXouHhYiH5Ze7Ypbj/vnOEip6DSZsHtGG5EaZVGhL5eX3upQUrKb18a5wKkuh++yno3plzI12n4uWsFyVK1iwNP0E7YxVZEhozV1VIljaileNZ+4q61lCgLc6lPFSAWz1NYTl5a5G9kA7Xe7KnMPK1u3Gvh/X3FUZDwtela8OwqL61QR6V7lzWNCqfNGaRwSdG6SpBcbD8pCXMmcJAVVjcI6TNpJ+dVoPy31kOAR6V7dGDaH+VUrB8vCuiggWoNNg45m7ykhYIO8qYcdm7+yVSFiYIaxHXYTl7F0lOlvdQfwrlrD6ML6KRVjjez8h3lU+wrLlrkp2bIZ0GmxQDL7KQVjm3FVpwpL0S0iFtkHyktvDsntXeWIxav9K62FlFSwh0z44zhnMKFiAOYP6kWGBIaExx9441WQoQFgOGcCMhIVd1/ZSLybVUA9hBSQDowpWB19Pwsresdm8H7Cznrhjs34/Ez9vsKJ+glD9aqakcYRohOXaUSIvYdlTyN9EWC4V+VISlilBzBBWUKrBR7CUcwaHAN8qKWF5elfZCQvgX/GEFZJsiE5YzrmrLISF3b2re3TYXirGpBrKE1YDrcugHxnOMTINR3AUcm6QJ6w+BmMNEfyr28Nyz7XnIyxX76o0YekqXjUITXUTFix3ld10t+Suvo+wGifvKi1hSb478a4UhPWTV7A09RgGz9xVYsKy+lY25cpEWOBOg034rJw0guU4hzWaYM1/bBXjo9AecCHzmq/1b2ZU7BaI30c1sYYG6l4lF6y3Ns1d47Si3P0Ebfo1BHpXaQnLvxtqGcLSdxqspZ+gjrAGRb32hIQlyJWTYHH3Ota/9qs8LIe590kJS5W7EmefX4QVPiocPHNXMMJyTzdEIaz32A9PMfgqMWEBfSuRsFCAd5VAsIK8q0DB+hMV6uHLV6dikdFhNYJ1jfzam6+wW+4qsmB1nIdlXenIEKGihCXPGRwCvatUhOXrXZUgLEil9noJa3DOXgULFtolgXo4sxWtd/W+zN9BWO7eVRrC0ueuRMY6CCu7YBl8qmEMnpUT08O6+gm6564KeFhOfQYbFCc5Gk2wHOcMxiWsP6UAwceA0vpXrWAFV2SLIFiWOmh6zurq8LBYdRr6ULZK5WH5eVflPCzznOZaCctLpYIF69dXsFS69YGs30oFi9tPSKf5mIQF8a4YwsomWKBa7YOlVns2wrrGf9gzd5WNsDz8K8R4WBUI1jH+66LwVSbBeui8K7kiQxWC1XAellfuKpJgSbmF2cG/asoSlrrm1RDBv4pNWNCaVzUQFrTTYH2E5Ze7Kk1YD9m/4iSkRg9L8N29uqHGq4dlzl2VIyxgH5zBLXe1P89lgRLWtf0T6fe5XZusJsJyVa1EhIVcvatbxWxCQw5CasEi/QTRQB4Tmru6/5hNdsF62NaKBIs7I9gGnRuMIFiAWv6m0WExwho1cwbdhnL/aQVLQ1i9XbDoZ/XDVTjQu8pLWAjcadDWVus+sP/yeViYChbw5F45wVJlGh4qCanTw3LPXaXzsNw6j0QlrOV+k3O6dL/1n8+dU6gn0QWZsMC5q7iEdY79rITlMyqMLljIna/Y0SGUsP6XTrC43JVMWIBEQwnBsnhXD6HmVVHBUlS7aoPZykuwtPWuZoB3lYqwxvVWD/aGaSWCtbKeVUtljFUmJ8Lqf5IS1nTsx9+3yklYkn5ZMqEWocH5COvUrfc7kRIWqp+wiHf1eLCX6glrpvrVhHSbn+PkRm/C6iD+VXTCIiw1s7csRLAWlqXIxo1EWHDXvXcVLJuHNdkJS7ls63uZ8wqWs2/l0u0muYf1Zqf9c9A2vYdlXRSCdfwh9hDBOuczd9itLsM9X/C3LsGSWKr1zF0FCVbn1o/SNDqMSlgNgSa29/yTLiOTu1oZFfOOI6QgrH5bzmWbTg8LsMznyy7qYbn1kqiAsIbjLbDcfQkHRA48UGama/uFChZeXEwwtWAdS2up1a5a6ies5k1YIc5VHMJix4ZzA2WrFGcJFzL2o776zgjWzrDUwowTGed9cMpeRSQszZxBDMpdbfkEyzN3JY4QC3pYd34Bn385SljuuSskbna+H7Y8hCVWlWFHhUUFy9BpsPXMXXkKlrVW+2zJXaUkrL5XmFg/KyNYG/WwJsbCYtWpNGGJcwYxyL9aihEWNHdVH2FdD7GcCtUFZK8YAVufEQnLVKv9mwiL1a65CXWvQghLnjM4O/FVbMIiNDXR3MLCCNZCWYpsOog5LCfXPRZhadNWGJJqmJ85Bcsrd+UqNMk8LMpRq46wApYlH2HJ6lWRYGmrMbQR/CsnwbLkrGagd5WEsKhfRU2s8fnkTKx73TRKk4uwBnuvwYOtIIHP+9NdxsPy64MaibCGAMJ6EsKKVSkU7c94hGWv1/49HhbVpxnHyk9FyY02c+e2RE66L/zYjyWpY3kRxVrpllzmKjthWXoNYkiqYckkWOjwsFCId1XQwxLqXV1/OkJYg081GWG53lUuhHWM+2TCakHeVYWCZek02DJkhdMJFrjP4Ayd9ZzEwyKGFYmO/lxv/PuddKvT/Rk/LCxmee3bZ9lflrzoZ5sgwroyV5/HIw+mqndFCQu/9n1bt31/DeoRoVKw8H68on03ohqaP8+jdSQszruaj2f33omZsfBx6GZl49LXduzBibDm6/XNpgd8H7WX6Lnj9SasQ6GiEBZeohAWJh6WuV77NxCWWPEqR8dmlz6Dc+NIWHGn5uzS2O/f9VkWUu0dJR3KV/vKGF4rL2UvQmTjuC1Eo2TBQvc+FmwirOPO5ITAxlKVkMM6lm7jvLgd3aKxPsWFkbOZfUGLkNP6dz+T93bn7/v8VEofOaqtqmPzoVYr+zgvlq/uV7Mf4kEOziYKS7vS21qgh8UdlXVXqBWzwbIRn6qVDtrK57CIGyWJD3c1m8PapX3umn3Qo0x8dTfCGuoVLGutqzZOqsEsWCC2kgmrgGCRc3/tTVjXm7XhXHeV0Ez7Irzhlo0xlmY6wW+ld5UJC5EzlZ2FsNDKSRBVLJp0J4QlPbe3xFkFa5ZuW18Met23NtOLyNTCPrS05T+OsKhevcQHWlsiGT0jWDMnujwTcZ/3920AwmrFh11e4rhSOGzbWfVqUArWwAsW+TtyCMWKDZd071SCtZG/CWt0kWsxVhHWqWEt+NxgzYQle+slCMvUC8fZw4oZHGVMrDtx9bpl5rrhJXjuG+Er+ZPPQVJLBIt8lJSERXYzmz2scRQ+TLtMWNNNWJviua02wXotinsx6HTfcyZMuFOWwqwukTsjJWG9FAduvr0rsssNCU+IUyzxFb52q4fVKV7fLgdDhf3qCUsQrBcrTTTI/mStepawNoVgzcp9UO7Cbh6WbXRYVLAaWKfBNk6qQSdYnRtfNYdguSQbYldr2Gh0dGQsrO1Wsu0a/QkWVo9UevV+X7YEse5r6JBPQVg/G7X3LR7WKovj6V0hibDUz21FJsHqd+Wd/k/d2banzipRGCpKcqhXuQgb//8/PXmDeWEw2KdVGz/tVGN11+U9izVDITN45BRBzZB21RWhzx4W8a7gU0lejebLfVFxgbnVsxkQcR4RlpH0+IqsKn2T7uAWxeoRLCXWc2VVh/cSGomwCpvia5R+DNf2sGbCMo/y1fsQ1r2dBp9LWMez2l9JWDjXnhNXIctHpLn2/EfzcWFgxD84HI3KJ0n0sMoPp4NVQj8JUlIT1ipY6KPgvWfa0xIs13hBIEX5kVBuJmA5P9YoFkaJsKDO8yHc/JV7T0Ww4h0eqsUnHHhYSK9uAaw6D/dofAUtiuU6BAvBlGA/OdvjYcFJxcPwyzeUKezU62G9rWB17jWoZ8L6ZcF6cJ9B90hq9BcI66P8hWy5Bp89+ISFpVQxPvtXyDJOekpowgNDI1CMmrAUlBFHq4TrZbzHpvg1p0O5YN2Kq7xyTXGMFlGxU0pFcWJajs13gguHOJ0ScnMcDW9dI9Iy+CjDGJlCFW4jLNaTAwsHy4dSe0CZbRuvhBXI38gyQK0t89vvUhAxjBxF1a9Bz89rYiWC8F8a0wldc+ls1vPbVPRofdOmWrAKhk1gYVERIx6Wm69SVHa9poNlQ6gJzfl2rbMP1MMym4f18PE+HlY7G/psD+soFfoqwhrsnrvyZPaVzimHohTn9Xy84goRNUiHWWjmzyOKb00MjVY3fjLzH2RFWA61+zQEa6xcq1C5WEywVGWE5yddLPRZEoqipXH1jYjr5aft3OnGzC9ijM2f6SlFh9YOY8ktlJeoRMICn36bc8WVIxFT3FhsvWsS4dzUZLTaojWGlocVqOiBMVRBWyKZzkVdVh8rgfaoPTjKBvjd6nqO6Q8mrKXugQtsOaPqkrgi1KjvBs+NkQmrpzJ8Aw/rcJroLwnWw95VVi/3EF/9wsRR5KZDhbgs93lkWhWHPdGhxPO/9+DoxTHEuuAv/SUxpRQnrLNH0YejHNb23ESxIkOfXbAmJE/bsRtyPpJ/YuOpfPf7837mDMXjhljYJd6VbnGkEq8JIWK76pemfYPgTe/u0YXVchheHXfLN1HTidWRI/LFGoQ1AtdRXfTcFUt79qq8/rgoFHwl+TLHik0cPSdeE8Iaoa4Iy2AAA3g68Qk05cUGlBvlhGWKh/XnCOtop8HnEFb/PoOvISw0iz2R2VcB1gwDJLFghe7jg0anUNK9fJ4/6PLe/JGQJ44qj7HtKOk+32v3rJA0bqlRJlip9sHdXMKMlypRldj0BnxKj5oJY5SWDoGYzpmh8gklEtY6U2o5xj17xZQDEVZdrUVWEU71qmFoRRr2Iz+kKIOlgOVLst3RM7VgcRyq3XHOS1yNhBnLgdeEcMIIhPUpE9bbC1b3ToO/4mF9g61ydfha0/1y+SgmFu58NmBTbWYTTiYgqzyBYIGOTAyNktxLCN50V9J9aSbcFSswqGkQlnegKoNCpnhNWEWQPU6o4zgVJixssMPpXdYKQoVNoTTtGUSDUmXUgTfXbw+ZKa4YXZGWc+CYa3dAWPn1qxNHru3EGWvi1tFswj69avWkxlqwNNMbFTgwsYqQTxwVCAtm07MppR7xFfOwVrY6mb/oYR3PPH6Wh9W71+AzBYvs01V2u8m4McEMGY+z7QZ1AEYKU37EvYSe3ukqNuGAYBU5WDtsJMEasYcV6mS732deMcFCBlujWTBwwVJ1iEEjpNrkLsqx9hOSsUWXIjjyo2ol3VHP4NQiLJSRuhF8sry8wyLW3UvoUW4BPesJZjAYMu/qmLAsrwkdCWH1EVZ5IedNncqfnmGEVWYeA2E9mmx4mmCtdV8fYfHK8IcF6xveFa0OX0hYe79zBBDK/BOWKnBEJlak8OQRcBXB+vCEmC582ZARFkx/GLsIq1SE48BsI+ph6dLavC2ixVq0KsJC6QokWGiCNCUs0mUIccsN6LIQZP3SrY5ml7YjtghrrB3zVbDMVFeEUBN29BJuB7mIQb+FvKPEsYdl0fqoDFBNwgpCrj3RitCtutT0sN6NsPQRYQnZqxcR1r1c+2sJi+zVVQhrQpNEI14xDABMt1I2EpYKZFpDoEh1pcDFCAsO02h+3vUJsKYQVrpfEo78OWbVkrsCU9X85zBhnShSFcG60D5oSHquXYLkXzJhnaIQ4vRyiSgMu0osCdE7D8tG76VkqFIWLSKK+zjX+CQRlmUK5bmn1SKsKORE/dY1mPXfakJYaC8c7GE95rw/sSTUhx6W+8c2Hnv8+PrnjgXr/PgNq9dLPaxFv8YLct0D6pLJ6oXs8VBRDxKaDypYF8nCAsK68uDWEWE5mMnnDghLSrr7dIewwLKmg/eIYFkpI4qH1XhyKTcWD4uylXWNhCYjLC+EqAJd0LOo0jtMuosqmQmrpNx9cyrfsYdltcP3MY6vGvYQFmjnCReiiU5rZx6W+WseVuWwu3+fn/9ZsOajKVmuP3d1N7XwLMEa+F6ols9nmFEnL/9v3ThT0R/HYAkLlq02YGaENR0Q1q5opjH1uARbgbDcAWE1egl128MS4Gm5N3W2IvHg0bwYolFFvQTCWpUrtXoEugkrCkWjOuoldL7xvGvvTXG0bkqY1a56CQsZUOjHyT5CWGXVIhpUEVpjGGF91oT1aLLhKYKluzysf58/dHw1dMl9M3fFK8QXEdYAHhaMB8gNywykzkWK9v7kD1GwxigTljkgrD32YBrTRGGREGZRHRGWUlIjc1k1rAjLyoQ1EMGyUZrMsP4EqsDRoL7nVaE09a9sswXIsxwWEqwLESwIkKh+wjItvdoIa/TEH5cm8nUQlh2JAnm+qVcXYRmoAuEaAfhqVSXkub8nYelDwsLuukk/pldf/3oIqz939RrCGuobEBZMrkp0al9x3QNb73vIw1JNwiIuvWnshgMdf8V1PyaspW6sK6CiWLcmYVksWE72sEI1LyYAVaWifA0PCzqVYpqWJbvpmLBGIljjdzysiJ52G97nCWHdWh7WHcESCOuMQgmuVqMewjLl7Bmqyonl2DlhvW1JiCjqHmH9GGB9NgXrm7mrt2jNGXbCGkh3zi1/dU95v78sZNTCgumjgXhYXiYs1SCsABORpgZhjZiw6oGhTcLaTitHBgyC1NSEJa4SorjZfcIqy3auaFcos9rppNABZ0CtxdH3Ox4WJSyThFVCCI3JggVJ/lWHUA5rWjx3LU6zepiwYNxCvdzXS1i2/LKxXMPzrpsvtP/8HyUssi749XOE9dXvYT20m8QTBGuQvKuasC4FoPYP8mWfeZVDDpqv992QNNU5rNBFWAk12fhNsMRJ7ZSw1hBCF2FtCHSxRLTODQ8r1RErTQaHsqfh+wz6UhMWFeCExeaJXlUjOHpMWKhlXOgVlD0seIE6zz2mHlaAMQlKntXeRVjlXqlUcx5d5j5h5dRCNq5uRf+ivUtYZvWw3oywqnlXMmFtVeHnzxHWl5xbcN/0rl5IWFS/LEw6zn82J1r5XS5sQMyJu1WLP1XISFMT/YCw/NIzfUJmmGnsNFgR1qD6CCvffb4/i3zWOayLGBylifo2YY1lQTWn7D34Voywqp7jIT7qYYHWRMGjut2tCL067/eHMJclQgo8tMzE3yYzNHJYEmGVzvNSEaJyr4+wYLHRZIVzfCLfzlfrytrfICxde1jo+PzB44iwHstdPVewBtm/YoTl6NyUyJkp8sh6QkJT9xK6HsLy/DGmsQsOJiy5JGwTVgEt1l5Y9xJKrTmKVZIRDwJkzlSOxEfoeyaElV33sRIs5R8mLFW35qh0v5cwUMFC89h3wnJ4mszOVnSuSx9h2bJVRazH7h16WFmXsnuaGd/cI6y3jTUwn6rlYf2yYO3a5L6Zu3qph4X1y8JuXSVIxIJTOVnFLKzhMiK7ynBjyw+dhIXLSE88LLzToOBhTYeEdUok4F7mscRGL+GH1PzM6sQmYSmY0JDHvOjWtloVYaFViF7CgtAUmFgw3VgkrJEJlrKQcpjWGhBWEWt5cf2EBS2HU6A9gQ8QVunHCZH0PWOpyWr1+TcIS3MPS7+KsHp7Bp8tWHf9K0ZYbHzoWG0iWCVA6/EypCG6m7DQo8xwRFhjH2GlfYonrg0nmbCiMF7D+3GSAAAgAElEQVRGFcEC6lKyh4VuExn7GZBvpWlXDhtLpU7gsF3aOaxEewnr0QzuYB5WeYQ+K7IquBhhlhBXyN4VmyAKLUN3CUtRLKfT2VuE5VHXzXojwx+9NUce1hsJ1u5dnap5V5SwaM/gjwtWlVtw38xdvYiwKv0akIfFdmABdTkTwTqhTQSvWGiItvnhAcK68D0o2E6D0irhfQ9rMKcahFQgY0FtqDPrsOyv+RY6u6yZmrDAex89G2U8yoRl2aRPHOecmoTFMwuaTaAxKHYmEZZFRfxKWBp9RcW1AjQncgILVKw322oTVqGm/BvBTjc1YYGOOrpTqiHJ37A7V5YQVkmGvzdhgff+SsI6z4T1vdzVcwRrOL5hwjoJrTKkYqumLqB0Qpp0iqHmMDQWpk1Y8NRh/CHCggX+KW+NGlqzQ33S47Sms844H7VME/UVc0U6N4beSL4M/0Q3luuuyyDmQOJovUl3PCJ5fvtdwh9vmbDO6AHn/cVlI2CfKAoX8dGhEcleMzyaf3N7Si3CYslYWuxxwoKvueSMm4CgyEUm+3c8rMJVJ33Pw+Ldzm3B6Wt+bjy+uWPz497VUwmrUiu6xfyF8AGq/EhTHhay1sY02Ojq8rCG/6HqEntXhacEwmIelmUeFvyxr9Ocrlc+eI9t2BJJfL5uXRkbhEXqQoXfgztbwwsdMg6atIPr8bCUsO3W9W4Oy5p6R5x0g6dNOJjO78fbbvY8V4uw6AYZk73jYdlzLW5rXWjIxA2h56aWk/cMjmLF6iWsHxQsdp3v5K5+U7AOfSuZsNgeg6jyG6IsZO1tc/w49BPWSH13K/DV+DBh6XpaAyjTQEdYkZKv8ah1IwtFKk9xvlXAEocmymg2VaZ6mqRoWXjsYQnbEs7gJDwMd1xXD8Ajn9cpyHK3YaxmgRbBkgmLbDi4mVMNwjJMBG+IodDbFIV9BlGq4V0ES9P9uu4TlvlNwRJnXv2funPRbhXEwjAMUHQ5s+qJqWnf/0UHUCN3uQlET89qmoSYpP3z7d99mRLzrioTlqFfh28lE5ZiYsmR35f8a64Kz0Btf+BPS5sFP2GNZxrkU/au3IRlnCXUCQsMq0OvTMdK+vl/kK3+cDFbiz6MvFHV9p6Bh7CAzjpPRcOWsJDQmMk1k8UvWHo9+APLTLmpku0FOPVKGn2xlzdDe6I6tN7depZQ/ZR4nLmjGEqTNyw1zf0T1mT0u2pFWETxsHL8q/KCNYT5VzJhCfWC9shPNrFmvW4GGAPXxfj4YMIa9Y7H/1tMvhoTPCymcpba58ciyaBSCvw8O1vpd3vC/QwhVyU/YY3SpAj5vCA07KSHylejPGUwWLBUxnqdLpVVsIRHpTxn1bV6As0Ef7+jTnRyE5aMYoh6PSysYJtMWFg6a2mZhfMtue7dCJYxsdnnYd0qWI55grF1g9UJy9Cvja8GzcNShEnpt0dfDiHbzujJBcbzYz0XDycseWbYrPlXiR6WuNGi/H3Oz2mUu7oDqSfV2SmLRyIP+U5QvpPyMJaOx6ulh4JNsNiDv92jJ+J3Pc9IzoEeFpegtwfFlmEXRy9h8YdFR5ESezW2SV1PQ5eI/LI9VqU4B+BVmgHrJKxzeo6ahGXzsCgkstcvKdPZpH4Nk5r+PCx9okQbwjq4akrMu7pLsKL8q69dsBQFOyTlS/4JOJOyvqzVycv65NuKhtF6C6Mhn157c+xYY6thjN74yYCjNIdLxbKuzwc7tokdmpH9zo6bX7cq1/GC5P1OK1DzFkZwsUvznuWOfdDCOxRMK3/NzqYz/Gge6wKcarOtQ6myjHjt1+UYVrH765KoyV8in50/LFMrTLfLC3/Y56rUDMLjlTF7zMBpv27a8rCwvUz6/DGEruvfX4T9Bj34mogdpqRY57xneRLO6WGd/e4aCxbUZ83bCauiYJFwwoqPDm8iLDPvSvkyCMsjL/4NwGEEQVLl6Hd15F3hRJXSN6iozzaexlKsw4R5mwCrpqwDzlkM4gAlo63GR9MvuV+7rSLZLljcycJ0HJWZNmwFjEOGR8iKtUdJIGij4nGRUtW8iZm28Z9gqxjxn/JV9sTRqw0H3AaxlcTARrH4O+47Z8DhzyKsQ7smY6JETcIyffcpw7cqL1hD/E6HZJVRNpymU8aOR1tWQ45gXW7grT72dUK46r2f5cVDgGDFb9CtQtSjUcZOXP2uIjeSekctp51gatvfYSWxThrsRrCga4ZzQw8rmLBSFOwWwvJ5V3YPq7JgWWoG8Vhmg8FqFbuO5dygFP05AKuUYNHcdQ6FShaaUoJlEJaiX3vMN/oBq1vCOrVr0ieiNvCwZHWaYC5blRGsIe7c4KleNCjiKypYVu9KJaxxzI0MYQnVY7oEQ72rTbteUl58TcLyxX/UTVjU2Qn5RsHCJl+5COt5Zk9YJw12IFjQx1cqYcF7PSwST1jpmQ2FCcudd9UXYY1G3WBtwopZx+tdia6hswuwWgmW4bsfCkVAL4S16RY69eutTFIdJ/4UwtLnDE7Q1/PqTsKy92ufCvhXZQQr0rs61Ku6YDnZ6iSsEq57IcFyTmzWd7X856U5WI0Ei7p3kuldZQmWhaWQevmhVlMBxyScLgQL+nakZzXcJVhCl+I9rNZpDd66QdvWkrCM7NCxb8Ky5l1pDa7MsRB9eFjaxC7ak4eFd8I6/Su1/seeg9Wrh6Uq1BSVjV7Ww7JlhU6kzJYqWEO8f6VGh5UF64KvOhEsKfYLJixjZFZTwqI+/2ojLEpBXcGyelcuwlIKDaz+VWPBuvCuZMJy97wqIlhS3BdKWFlVOSUJ6zrvqg/CMvpdjT0T1pV3Jfc8thpYBQWLJPpXurvenrBU/UKyq65WWD9jpKYVYUGjZnBTqHaEZe8Y04ywSp5OpjhuDxvJnbahIGdA74VtbgiW2abA20n+1ZKzjr0T93Ut2N15NEnrIPHl3Y9tQsoml0wh9yb/gVrXCdrMVc51bNftV29fF/ukXZomecVJ23zXhWy5979vsxJW+LnBtoRl864MwhqMGp3hXsKSOEr6By/yrtS2CfP8WO0JnDAogju+ef/T0kFpNKm5MkPLnd3bPu+sH23bf3umO6bGzfCbsTCiStS39xacH89INipDWOwDxn7d8TF5IpXde/d8UCURFskirPPjDOV+UKHtf7YOQuY/98YFK9m7+qorWGOId3V8NUgcfee5A0vN4JWH9VavUa7ka+ZhXXpXR2RYNyTETu/K7mFhTJ2+VeOQMNC7OiJDdF9IaOl3deVhCSI+shyyUkgzPax476oNYZl5V07C6sDDAoqHZfWubs6fyvGwNO8K3JKhjkmmf3UoFLpWp249LJt3VZiwAiwFohOW1VkvZAUEktrhCXDBSqgbbCZY4/XeiWAZBHV9ljBMvaoQFr3em5juAb4oMnxS2qtgRXmr6E7BMggq5CxhFdMdvaNH11nC0LyrloQ1DsNlZXNfZwk3D8uSdwV6J6yryuaWZwmN2JCpU9pJmx4IS6u8uTzZct9ZQqJ7WJYzMTUEC1m+3zys6Lz26oIV7F01FSxPvysY4l8FKFmlbg2X3lVFwfLmXbkJK9S/aiBYEd7VoV43CRaxnUF2E9YZGd4oWCpVaYy1E1a6d1WXsN7e1XhV2dwDYcn6BTO9q/qE5feu2nlYhn4pytQZYcErwoL23KtGhEXcHlZ1wkK2iDDOw2omWIG+VWPB8vZjgB6+aiFYMNG/ahYSBub2IU+OX0chYZB3he8WLGdHdreHdajXTYKFjFjQdpYwJe+qBWFdqlR3HtapXzDGWe+AsEI78rU6S+jKQv48DwsadYOtCOvUJY2wWiUMWwUrMe+qkmBFe1fNBOui3xXM8K0qEFawdwXqElawd3USFsbxmQ3VPaxg7+oWwSL26gc/YamZDdU8LJOw8ryrOoR1nXfVG2Hp+gVBCb6qQVhv7QrqyleXsLC1n6isUJ/kYfnyruoRlq3fVTXCQjcQVph63SJYEXlXjQXrMssKJuZdVSEsGuJdAVo9rSGKrU4Pq/uQMKGmtaBgEZ975SKsfkLCxLyrkr3YQ9aJnSgBmxKWqU5wvNksL0RYsRMlahKWLe+qTPF8C8IKUKlKHpahYORjPazw6LAwYSV7V1UJK2LOICzgX90kWFF5VxUIC6d4V4d6oZTKnDsJa89ZCCEsX2SYLVh71Dcd6gRDCcve76o1YSV7V/d6WKO351VvhOXrd9W2F3sIYYXlXdUnLH/e1ScSVkjeVR3Csvdr/1gPq5lgXfpWQy+me/AcHJhflXOPYEXmXVXzsKJ7q9Ge0xpgmId1u2A5+6D5PKy+QsIYZ72yh6XVDA41zu6V6IdlywztnbACI8BmHlZQ98eP8bDCvas7CcvWq33bPoqw0qLDQoQ14kD/qjlhRc0Z3AirRGZDMcGiV3wVFhkWJqwE/0qNDrsSLBjmYQVkNeQJFlE8rEjCIt0R1pDPV3cQVpp31YqwPP1Ex74Jizr7tbcnrDj/6nM8rHDv6g7C0nx3S7+rD/OwUtSrCGG9JzbH511VJqwItjoIq0DWaMExXyQx7+pWwkrIu9Kjw44ES7DVMU/QTVhhypUhWMoZwc8nrDIT5osTVrRCNSUsQ78MdeqVsGhE3eCdgoUS8646JyzsIKwCQ0xyPKyrySMfQ1jp2Q00l62Gc2KzL+9qaElYIN67OtQLlqnMyResPQIkmd5VQcHCe0iYlHelq1g3grXnLVwRVmhkmOlhBRLWERl2SViixnDzsLohrJGtk+dd1SSsgDmDXROWoVCgF8Ly1Ax+GGFNe2zok5f6HpalIx/8QMLK2Wimd3XsONO7quBhgbh9U6+OBGuf2JyWd3Wbh5WUd0X7FSxpYrObsKoIFgknrEPFOvWwECesoSfCGgRh5fpXdT2ssI58/REWzfKu7vawQvOuPsPDgp0QFmHr2PKu9K17wsrPbKA53tXgI6y0qLA4YSX4V3J02FywtI5XJNO7KiRYWPGwMryrTyIsGJ/VECdYJIWwSK8eltwruSfCGg8PK8u7qkVYMf5Vb4RFT8KieXxVmrDi8656Jiz49rDaEpZcMTgd2gTtvdo/grBKZDbgrHODbsLqRLBAvHelRoeNBcvgKVLAv8oWLMlXJ4l5Vx0JFgz3sKoKVhBhqerVmYeFzr0bwjoUCmezVQ3Cus676pewNnUiIJet7vGwUr2r/ghry2uYdne9rYd15o5OMGS0fNeEVaQyJ1awnPWCOKLn1e2CxXQJJuZd6dFhM8FydGsnmd5VpmAZeQsk07tqKlieekG7h3WjYJEYD8uR1dAPYSFpTn1twhrR7/ynXhrHn/m1KHWDeKh1do9p0CSOIWodT82guY3wv/OrkGDxpWjeOnLFIKHWKPBnnpcEwSLs4HDIrfn77SAsWb/Q9G9eMOa3xvxN+jzCOvpdTbu73t7D2gmLSB7WxxEWImUFi/2a7dvrDxg3ERL1jv9OwbISVm5kGERYYYKVlHe1KRgVglUkDwsnC5Y134rYawYTBUscXAhYnYLlnNgs9h9VsMKd90aC5cy1qkxYl3MFJ+LpKtMbYSFzLypY4BQsJllQv8kkE9awiQVaF9Vhz0pHwL9M/kIEi07/XvxG04qihS9mEiqe1oUJ1s/8ly9YYimPYBH25AMnDQJnKOckoHTCYk/+/T17wRf9dpC9F1gQ1rlDibDYfaZPJKzNu5oCeOhewlK1KUxo+iQsdAdhCUmC02Oen6ODsLav7ZLFw8pgK/arHyZYnOyE1rgfCygeVrJ3xb+j3wUEi8kM8BIWf/LhkwbJTlagSEjoISz8zQFJygfFun/F3guse1gSYcVlNlQVLG3OfFPCUjodhxCWy79qTljI5l3dRlhCsNjf6Tf7zbcQ1qgRluGu5xDWlwgwgwiLC1ZUaBmbdyUZWYD+FhCsq3mCIroO8N13jXISVmkPC/5KhIUt3jv4nk/C2pWJTLJgfeJZwqMrXwvCIjphSdr0eYSl6ld5wtolif3m/w3gvxtnbd46Z6rp8W9+PRfdw6I/DMlm/vNTsKbvXxZYrptc/LD7zU9xQSzzZBcfQpzI90N4ZnDcA9I/yh6VyeGLqxLcwGtelBV/tqh1OTysia/xeC7ikeYX4Ufz+jt7sYsVv/kRLJtabY+/UvY9X4N/8TsifsfnAvizZMexeVj0Zw+RAToO1YSj9yvDLx0rAvay8AMTdzhM9+3gnrs2TduhwiMa/wPbS8mOgpp5VvtVkBPWcbivTU7Ea/NYZcHC+7Nmy2Nxy3W/pXgW4gI/zB8uxzthsaNgq9PjGIVpJZ78InlYwpUSL9FjwfR4L1gcyN/k12O1eFicYPiaj5W/VKKoeH/LRP7T/u68ViE0Yh2+thCe/VBuEiyls5WbsG4XLG0KTpiH1YFg2ddBdv/qPsIahi+hXYdgDUKwyO/8/Lf//ipnCfn3+6/tW7C+fg4vjDLM4dfzu76AuPBeZjzv+lr+T92ZcDeKA0FYGkQEj7znAwz2//+jq67u1sHhY8d4Emd3EltIgGO+lEolUX3Th/bchz/ZA5FJgWUFWKlF6rEez2cFlhYcRwbWgXd2iwqLrsdrqHCiTUzrY0s944XwRBW/+dVR4cGUASamga68VK0EFk6J2i9aDF3JVIGBZTt9K4iHTk3Dqe/45Md4bNig8K5sOmwer9PzZPLgMWQelj3QWeNVpUpATjyLGz/BoVooLHo6WdmEW3Zy8jYfJeyy36DT34WvvqXhIVzhi1FCK+/FAGAR0BR0rv7W4zyOATS6JW1Xp0P5vIdVgOYfe1ix3/cbPaycX3sprHZdYUFPhQ/bUCgs9B9bqj1ZF+0oopM7EDcM/v1Cm0wvqnQ5cQPHMWyHJwat0XU+Hce6MwIsw8CiFn1r0RYpn9ZIt5QKaPdXbpZRRZdgnyksUkhEx9BiaDdcVNBWg2kDhs+BF5VBRYP6oWaF+jxKSG9LEEl0qM5YOtQlsKgpOpLBG22R2DM4Qyc6OQFWfQW9KnrHwjc8w3bslzP7eh80I0qKLzrP8BeK3n6gA0yjq71HVzAACMzIgUVl9YFVGd4/sqSOY2jrGxtWcqjsYeEdxIukv7oDNqGT95adqaSweKcoQnfSVfjFkDyib0uFhffc0XmHN9HhV+Z4h0yokZ8FRcMN0D5Qd6KSA8j2VmDZub7aVlgfAVahse4rrPphcvSfKay7/tWeCusPPKxSYRGwevLbD9pBFGCBc6x0egEWs6dtXPjEGS0nElkAKxR9Ger1kQESJFjzNY49nKlQAr4FUrlCYUlhY6kaQCKxBgIJ1fKdEnAgS41fhcIi7hzRQ6QXuZ9HygXP6ivYgYo3gQ+PDIZvLgMWHb0nm38cVxQW1WEBoi0aOndLFWJTnvlMsgmwvPCG9Cb0DCw6iZ7HFMOFWvhWVUc6Jjywdc2U45MAY6wIrT6zy4liFnRgr4nqnW88tEdlvL1jD0vYh2MU92oAW27RvIoKi2rxCXpWZxW2CxDAbhyAZROwLF51dKDhWa3mFjqIjDpvcWIVId2StqIi/I0IDxL3dleFtbXm1acVVn3fw/plCmvBr2onhUWf9YCqhcKaDLnsdI3kwMJzcrK6WruE9GFnpdXxddkq0aiIYEO6DMDisoaZocDqLUMvKSyLS1xahMISYIFgtFmNhgEB8qZOYJQqrAnuFU5QSuRZfWUOGaEHNefYlyoVlj8IXlrvlsBCnYhAbeEWLS5WWEA2gIUr/yC9y7qzRhVW0E+O+OT81opXQFStbhVAwVQBzApgoX8I3RcjDxajfHCvfAQd0dTK5lStSqErBpHOZVYETaS5aEsSJlBY+GtF2+DA5goL7xDxDAiqlD+0f4UZyvpKTa66C9e4ljyy718G1updBZcKywaF9RFg3b2v4NLDqn+mwqoef+2bw3JzhUXjgg0rquoaO3HZ4J4Aq6lPKdJpFFisgaw45Q3EVcdWONeNwJrsQmGpTMO4nsuAFQu8apg+7osUlmlFU7Xo/w3o+51P5/AfaSq8ZEyUOzWH27FTSXtWDCw+1NVEwpXRBMWgLTYi2Qw8H27KUt/0fJpOZKf1dKkDX4EhxrLCQj9urOZ5BhE44zgMw1kVVgIW9wiLYCeTx0YxFTNatkMrqrAGHSVUYRV+PuIIJzrGxMLSw0IP8ZApLH5X+cxubgEswZBBh687pbdhApaslPWViqpwXZLmC11WPZQdFZbdXJHhswpLubQNnN+ksBa0qnZQWNHypaQ7K6w2GyXEM/Qck8Iy7LwXsYYuB9ZBgVYAi6r5VuxXHkBMwPILhZW3KB5WASzDoOMjWlFYHmOGCix9DISXG5INEisgSJs1hWWcHuomsIwC6xblFu5wQ3uFwqqv2b57lWJMJ9l/980zDfqFtqoPqWqaJKPA6hexBgGWL4EVTXdCVSXAst9qyvvZMYrCktxVnl2fKaxDVmsbWGjOlX8YFVhOgRXRVBWH8vfAmuWu7iksXe9qF4X1YL7gVln98zwsAtZD3+ojo4QUD20LhdVKcLRtHiusAi9Oy0uFZS9sX7nLcOYhQ18Ca0Nh6bCfmSusNgKrUFhtUlgRWH0KWSleNAdlAaw2KSwjCot4p4e6ASybA+tP3A8Bi7OZEVFe8l1T7F1a2b+vu+Esg3/l3JsLxQKq1CXkDpwCa9wCliuARbwaeytdwk5CVrWMj1q2riYZFKRdryss2FptUlgErLzTNvewFFiVAisb9VNgtQtg2aug7FHq9P8prIJd9t8qrCI3+qsV1tK3yv/fLYeFx3MKK3lUGbDyWX6xfEVhsQardcjwjsK6zhXWVpfwjsKizgy763FWjgLrscKCfYW+z7ClsDCCWCWFdYupB1ZYRC1XTC+Mz8R0D1+BBOxrlwpL/aYSWGWX8KHCgodEvbnoYd0ksnUcL+xWoaOaoqGAS1xxYVthRQ8LydEthcUeFuJeC2BFhRVhRj1V+9bgqN3yr7bS7Dt5WPXrHhbrqh8GLG6nes6/2lNh8YM+iwDYQRTWgGw7AFQoLAaS7UaONTStF2e96cZU3qjpnisskUz0xCwVVl949dicWuRRQpOb7kZseanEjrpJHlYfu2xdkUtYV1grHlascMmhU5juX2q6U4ut7EeIwcmBPM4ug4r0Aw0JahF0DcuiYt6NcsfpKGGmsLRMjfM1hWWiz09SKY4S3mLS3YlOOxTzETcUllOFlQFrTFzo5grrmqB0g9duNxRW0mJBCB6ejMr/Xw+rvCPqv1NYs9zoL/ewFvxifVXt4mHF9Rjof7hCjUScMErYy6ursQZ8StNkv15Vj5abb4k1JIVVHTjvzmpqobA4mUCZIQ1KcIuzWANqiabaUFigF7fo2esm3g32eYVFh6ob2tVYgwFLYos1xxqQs+olh3WRQKg/nEevGow7a6ywKHVAegqHX6zIoOToTkuFFWMNp0cKS2hE3v6QFJYY59cs00XbUGpdPaw1hXXJgIXhTdounIFdeFiKHvRIWUsh1nA99zOFpTBDNZVbOJS/A5Z9pK/cZ4BVv+5h5TMGfyCwquc1VrWzwsIV1X5dOOqJ4GjgF4KjucKi4OgIvRODo4gpWol5cnAUAXMOjiaFZTntyX01TVQJsP5ge3ahe0im2KJnHx/Akl212H1belhJYSHXgC0xHhhIhePtn1FY5EFVmvnkMT/Tnc+3AlhUxr1FbbFJwdHBpOAo5TYZCtKkREHZ8hJaWO7bXSR6hRWnrmKaT0sPSyJXZXB01cPi9uvDkd6KUmFhy8HR74SUluNNO+2JurnCcjJKCBbF4CiDa66wfBYcvSFkRfyqEQgtFZZETJFsVb65y4Oo++sKK/eu7J01rz7rYSmZdldY1T4K675/tZ/CiuvxYfz5xDM+GpmAcuK8e550r2QCxZSm5mAs7nTkBDjKMdvQtzMPi0beztImzya8KbCoX4k2wl7HvEXPP08j+1qeR9SZSZse1pWPYJT86HGiZz2SDtsKi013TLGZ+uxQTdmvzN8Z5Nd5Wg3q6asylxBsO52AMrRyFBvf88nD/qYZiNSG41iViaY7tYaZQ+e+UFg89kcTIR+NEmL/lOeg+MStVFgcU+fG+BitgxajipsKC9MNp9DP+45n6xYKy/F56dQcmi7Av4GgxkqFxcF3no1jeZYQ5qHWfwUs+8zXB4D1VNZqWfZDu4SBQl1Vv/Rl3J4Kq+WZYuFaPco4HT5AyE1lCoukGEji0uoIDc0u0cnPofwan5QeVoNprzS9Fd57ASxp4tYBWEEgpRZZS6TJzximr2Jf1OQeFrvbNetEctp9jdM6oov3hMKSuSgmHqqRLltuusvk6tzGb3nmYLiY4+RnX9UcjsBrjufNTJhn3fFkG8sznM8jL4SQLb6AWMU0or819TFVxTiqePbww1FCrBxEs39IwtxKheVJ1xCbOjlGC7cLJ899wkxhOVFYjkkFHXTlX8OKhxU0F08sZ4sq7OLA0zYXHhblsUApzIuu46G81cNav9P8v/SwyntJ/E4Pay13NX+8VWG17f312p9Zq92VK1K1X1lZ8yXPDIoc/vW0X+ONfONqTWPjmjCe0vVfDX5EK01swss2fnuNq6iwijWveF5x08oznWbs2/ivcWx/G1psx3m5NTzRTrbqTiWw6Mg9b0FJUG7QEokwxUYVVs17Q/6Vww0GKSeMDmYrtEta9EDaa2tZGGd8WhOLdu9MgxOIDzxxMXkaBJO3qGBlXStfeenvtYa3sLQRyui8SXYFVlirK/OhCN/L9dqrmDyg2q6mOmCCt8IaW9PPKbXg48ZakwYbqJ2Wd4J6XBsB/deBZZ/zrpRcuwKrfn6+4LqH9aOAFft9zyus6v0e1p17pD69Kt8Od7sx2b9t++J9BuGu+7g0++NHa1aXyJovKVN3SWH5GGvYXs+KEvQDgCW0zFcS9cv1roQw31nC4F13u3EP23G6jVu738TqanxR0fj4Pd+i7sbRPjHHZtf1sOxK9upR9nwvhXVvvrgH2MkAACAASURBVODv87AWvntVjg3upLCK+3Xd1VgfvGNzu4GrJ1cSLRXWC8yaYWsOrNDf6pc5rDsPXskhX8DPP/7qTsO7b8/lHrTjvPfutS/n/EPQkJXe6aINrwDr73JY9jn/ym6uefVGYD09X9D+9C5hxqbuJX1VvdfD2ryP1w+6Y/MjjTVf8dhqQvPNt+cKisG8ACyYWbfNFUc37oVad0O/7/0EXf0E31bu1vWqMkqrZT0IVu274uiMUk/M7vugh/UUcH6iwqqe9K/eqbBaN+sD3vOv/mPv7JobuXEo2iyS1VYxb/v//+vKUkti8xMAQQLtkTSeVM16O3lIrg+PLgEBwqpt6rpBCGs7CGsDMtYNsk/Q7efA2nt89ahSPANrb/MVZNMg1wJUX9o1uEO56vPVDRp73MT836IRyUB/FZ8KpwTW4a5C2g1tEJZi6Z71FgKAq+LT4STCwrsrScJqzWs/gub2c+MlrGzBBGALxZ4QVmFW+0YImkmEleVXc5sEIGj2/p1AtsAyFtC7kiAs3555dTHCsvd/nnbvap7DGnRXCwkLtWnQQLZ5LVkx/0wn33VXsNRiJyxHe48FzcTAMjB3NTmw3lyV7xO8oMMqnP0CyF9FgTWDsCjuSo6w2nsGxVbMFz1VTFh7tmtwwYp5MGFVToDMQbPKYZV7V+sJK+42tELlGoRlH88p3xmc6bAe5z9H7F0tJKyttGke5LCG+YqRsED+ailhOfxng/npUFVgmYfDAnwu6OYFlj/nE4SwPs0GdYRVvS8YEP6KmbAKvasfzYSVePfKnkE9hHXeS0h1V/MJC9a7ugphtXpXqwnr1B31VyasT34FoLviI6z3xuYxd7XEYW3Yt6rAem9sbvHV4sDaPbF3pTiwThubof5qQmBV9wm2Zl4tCiy8w6pwVOj0rrLA4nRYiPaCCodV3DS/aXVYMWEREmpSYFmYv5oUNLMJy5z9Vec1l7DSxLq2w3olU+j0rjgJ63QGdMTe1cKmO4KrPl8qAivyVr7Zu9pWBpY7joQIxqqfDpU5rCphNVoNPIHl07MfjLDOc9rVEFZ3XntouKuJhHV7OKwxtlpJWEl+VfyVNsJ6fUo44q7mERaud6WdsELeu3IShPXKrnCad3VVh5XPuwpAdzVOWEmn3Q26q6mBtVHeagLrRFN+0F2xBdaRS57Yu7qmw5oeWAW2ghDW8sCCPQcwSzRY8K0cPsK6vQhL5A4g/jmt3pVuh/U7pmbcX80grMqdwX1u0MwiLHN/DtxdzSOsT36FtLlwQcIqzGS4BxbcX1EJq3hn0A26qwkOi9S7Sk+HooG15/cGPbF3xTxe5v3lib0rNYH18Op9woKcCocCy7f4CuKwVBEWeNdg6PSuGAnr3LtyDP5qLmEVbwx2W6FaCOuVW37QXfET1pi70khYjx0WDuatZhFWml/Bw2de6SOs+qz2gOIrSmBVulZu0F1NCawN66/y9BIMrGKn3Q+6K5bAitjJD7orBYFlIITl5geWb70v57CAc64C0F2xOKw4sZZcWh58TmHi1ar+1G4G+eqVUH7jISNOh0XpXeklrGc+BYfvSvE6rHM+BYMJFX0Oq2bWg51HWM15V46n1cAVWJshuysFhNW4L+h3llYDJbCK8648qdeuJLBM32EZxMmQFFgdd1UjLK+TsMDu6kxY8GYDkbDyO4O6CStz71vksNR+SrgXZl5NGLw35N7toLtSSVj3hApIf8VFWFl+Hd4qnJuhFyGs/p5BNGFN+RcFNQn7/O+FNTyvIP8c355nZLKfmZAX02haaI8G8BOS57X8OeHxreH5jv8Dff5JCLbwbr/ip2D+N9pr5t+N/5+W60UirJJdPxHWk7rSnsPPRMI6fwT42CcInXg1SkYxB2179Ov9J8/n7J3ZxtHzzr+SIyGne+rdq4n2TrhjGU7yLZbYu+IgI5P8fPz9LdS+9/06flyeFlQk/ONoP6gKFOXxDis7Gz7YKngOh2XP86cezBP/er1OAV6M+9Kne+H47fUrarEnVj36CVD62fD80WCpgQWa1e54Wg24wNqyRV7vL0PsXW2S0xp6mXY4LIZWg/PgjwP3157BYrZ5Yu9K6EgYT2p35Z3NH4eFPRWijoRAdxU7LA+cecV7JLTlbTfenhpUj/fvn3ncnsHf4mjJXfnj97PbQm9+rs+70uewWpPa4UsGuedYob17YtflHdbZvdtBd8UcWMYSKM3kDouLsFAOK8uvqHfFQ1hQFZD+/59pdPz1ILUxd3UEUAhpTHn7hjGfJxggsG79XYNqAivy6gZ5Z1CJdO/OaxcJrMZngHbos0EB6V70qyXCmh5YHvMO8Sb6tdLdltIoEHtXKWPNrDU0bzZr/JSwvGlQdlIoIbdmr+ca6Y0+PiWU+3SP4zkmJSwjQ1jtT2FkCSudxN7/lBB6o5k7sMB7BoUDKzv/GVLrSoiwAO7qdTJcGFigPYMWMfNKOLAamwbPhGXeDmtSYCHcVdlheRmHldca0L2r9IQ4ibD6s9p1EdZ2clg0fyVDWIVdg0oIq3xn0A66KznCMtGsdjnCqvWukol8igir1cOCuqtZhIXYMygaWM19glR7tYyw9r67+pwMlwUWcBeOHb+Vsyawmo3APE4mOyyPey8OrD5hfZ5j8f5q5pEw7V39iC5AReSXIfauZAlr785rlyIsV5l5JdtQpz/nnFjSDqvfIr4GYRXyq3PjhiOwblB39SMbWM15VwbRvBIlLKC7WhhYbkfsGrTjt3JmB5bp371YHFhgrvp8KSOs38BCuqvy6ZCZsAq7BlUT1ie/DNauCxNWz13JEZZr7hq8HmFF+fW+GyZDWK3e1fUIqzBPFHCjmSewuu7qR0dgNeYxGPDEK1HC6nqrTSKwEDPaLbF3tSywQPdaFzssj2Msr9FhkdyVnyvdb5V7g9L7BCH5ZW48O+bXEBZ8Kt+8jc2I/FIzZQHfdI/yK7p5I0FY5TuD8MvquggL6664AgvtroQIqzuv3Qx4q+mEtcM+GyydDCcSFspdfQiL5WbOjOAzMH/l5gbWce7DElbablBCWDZqupN6V34OYRV6Vz+CK+bx+bUZBn+1grCg7mo9YcFmtV+HsE7ZZc5Tj9cSFqR3dQ3CwveueAkL0bsSDSxAx8psQ1NlZjsscO9qqXR3OH/1IiyV0h04k+2ZXdMDy+MIK08vVQ6rsk8Q0rua4rAo21AlHVbpzqCufYIth4XbKLHSYTnAvParEFZ7n8Rqh4Wf3sgUWHaGw0IlFENg3Ubc1WLCAu8ZNAz+akpgIXtXiwgL6a4+J0OFhIVwV25uYHm8w6qdDhUQ1unsF5DuahJhwXtXOgirOqt9005Ye2PmlTxh1XtX1yOszF0ZacLC+iudDmvcX9ED69Z/L9zYPOyvYsIate7MgUV2V1MJi+CuXuml0mEZqL2aGliPXArFPc342f7ihJX0FgKxd8VKWJjelRaHVTPruglrR7urlYRVujOoc9sNzGH1d6GuJqx+7+oKDovSu8pmw5Mc1oC7WkRYG8Zf3Y7RxhzNUZbAuueTB8+8WkpYDs9XTqvDMkdgddxVaVfThMA6zn1QwuqdDgUJq3hnMBB7V0yEdQPNvNJDWP157ZoJC9O7WkdYsN6VcsKKnlNwV06GsHxKWB7LV1oI65NdYcBbjREW8s6gCGGhdjh/HJaiwHpvbKa6qwmE5bD3BkvzrtQE1pFPFuWuphKWhxNWP8FEHVZ1YzPdXQ0RFjmlhAir/tmgjo3NbcKiuatVDqubUBdxWObsrhyWjXgdlk8dFsPiWzmHZT+Ehe5dTSQsXHJNIiy0u3oll+G4+cwRWMf5zxN7V1MC685W3mE/HyyfDhUE1ql3ZYHNKy2EBW02iDssEGHhT4gEwqL1rmQIC75rUCNhUXpXs46ElsFf6XRYGHc1l7B822FdjLBs6rBG/RUvYakJrA3/VhRYp43NI+6K/Ujodjfqr9QEVsRQFuWuWAPL0xzW0sCiERbCYaETi0JYpIQScljQG836CAvVXlhKWJje1RU+JQQk1ALCevYawpFL3WaTcsJKz4XBDrkrLsK6kU+GzA6L4K7OvXbxwEp6V57Yu2INrOjk54m9K0WBVbwzaBu9KzcrsBr3BWuEhbiVs5qwLJ6w6KdDCmHdRv3VfMKCuyuNhLW/CGuIrfgJyxG9lU7CeuaWRbmreYT1ui8YjnS6LmGVZ7UHDr7icFgqAovAVunpUDiwsk67H3RXDIF1SiePvDOoLrAq8xgsyl2xBVbVU5UJC98cFbz83CWsoeYoyWGp2dhcfg6kd6WXsJ755DceMuJ2WNjelVbCemVXQPurWYTlP4Rl2vHCHlh2kLCSZ5fMerDihDV2KmQKrM0Qe1dpgokFVuXOoN95rLtn4SsIYcFOiAKB1Zx3ZUG9K6bASvbMQwmLcDNnBWFFvQWowxpvNtAcllrCwrsrTYQV9648g7+a5bBGNqHKE9a5dxVQ7moyYd1TKXgBh2X5HVaaTuKEpSawSL2rm5bAqrat/KC7GgysjJ88sXelIrAaXStrCK0GemCdGlVwwlop3S3cYb35Ce6whhMLH1iaCetG3iTBdWnZDLqrV0qt39jczi9L7F1pdFjxCZBCRhMdlg+mHy+6HVa5FSpIWCythtHAep/7DKF3ddNwJOzMu/I8rQZcYDU2DdpBdyUQWKBZ7ZbSaqAEVrYH9dKElfRCe4T1DKyxWzl/irDo7koDYZXuDGogrDi/bGdWu37CMsWZV1KEVZt5FfyfIKwsnUQJSzywomwyxN6VAofVnHYlFFjVaQwWNZNBSWABdg1aQ7Hu6MAqTmO/LGFlBNUmLHs4LJbE+isOq7RrUGLwnqG7q3ULUAn+3RJ7V5ocVqkdKkNY9fuCVyQsmxIWQ9D8FcLKzn6G2LsSIyzgrHbP02qAB1ZnWrsddFeLA8vA+MrcCYvQaoAGVtK7ghKW10lY2Z6uPmF9ToZMgfUXCIvSa5fY2NzIrsK8K2nCSvPLutHPByUJqz7vaiVhpfl1bcKK8+tcHC0x1r/rsKobm3G9KyHC2vu7BkUCqztJ1LrhWznrAgvAVq9ToZ0bWL7mr+qEJRBYUIdVnCXadljMgfU3CGvEXckRVvtmsyxh5ROv7C7nnkaf07rZvNZhnfPr6g7rk18JYX0dVn3elWHwV8sIC7FncElgOfimQTvorhYElsG4q9fXNMLyPb4q3xcMx51BNYT1OvU1+ConrPzO4D9OWJ/sMsTelSRhQWa1SxBWa1K73n2CuN6VFGFl/t1fmbBS9/4lLPCuQUPsXQkQFmrP4MLAAs25so6nOTo9sAzsXQqs/74vNa8/6bC2D2HhE0qMsGBTY2bvE0Tkl9pZ7KjeaOX1DaxLBdYlCKs578og7wwuJ6wd6q62tYSF8FcvwnLjN3NmBRbQX+V3Bu03sL6ENZewzvllBt3VSsLac3+lhrB6mwa1bmyGzLxqNUO/hPUlLN7A6swSNcTe1UKH1XVX23rpjtjgHDsspUdCcO/KfQPrXyMsI0xYaX4Zng3zCwhrr94blCes/qbBKxEWZqPEN7C+hMURWOA9g4bYu1oSWAR3NZWwkN4qTi/rdm3SHdG7qp8Mv4H1JawJhFWfd2Vu0+sIw4RV6F1tWggry6+KV9dPWAblrr6B9SUs/sAC3BM047dyZjksVO9qocNyuPczvdTWGpC9q29gfQlrmcMqNUM1bWwuExZtG+o6hwW703wVh4XdKPENrC9hjQYW2F99CGu82cAWWPuYu5pGWAR/FTcbFAYWqXf1Dax/hrB+vzUIEFZ7XrtmwsL0rlYTVq93pZywkueY5syrL2F9CWteYCF2OMcOS1Fg7f33ugWonti7Sk+HqgLrnk120F2NXX7O58UEb4Dv9g7ngLvjXN31FzyEQB6/Tu/aPsHa+/EIyAv2Xe9vZnFYQYCwerPadTss+jbUuYTlwO7qCg7LENwVU2AlzynOkxmcskB6PaYs2PHH+JBPPM5fhRyLf6OQkXbCQnmrOL0Mz80cnsDaHw5ryF2xExaxd5WeDpUE1vvsZ4m9K7bASubFBBBX9fiKN7CQ2eRbG5vzPTi4PYOL52EFe7DjIsIq5lcxmTQS1g6cebUisCyp134Vh4XvXc0krHTeFSihtARWeeJVfEYc2YTKRFhBmcPacO/tcFhKAuu9sRlzZ3CBwyL1rnatgXXa2Ex3V4OBlZ39AtBfLQoskguDE1bdnU0mLFhgRU5uqcOCTOTTR1gDKbWEsGi7JLR+Skh1V7yE5e/PQZh19YT1SaWAz6aJhKXDYRH81ed0qCKwot6VZ+ErhsA63JUn9q6UBVZ278YSe1fDgVWZ1R4Y/NVywmpsGqwTliWdDhc5rBD7q0WE1e5daSas/e2wRthqDmFhe1e6Ccvcn0PrXXET1iu/AiWdlBFWll/P//rp5krUYf2fvXPbbRxntrAIisMYdRHAdgT0+7/oL5KideKpikdvbDvjVmRZycX016sWF6sMt8oDa8J7V8fqcABgnZSUIOauKgBLc0kQc1fDAeuipXimd5UBLKeKAmLuqrOHxUP+lUthkV33FiUh8FuurLrCmhK9qzE9LGk9rG4Tm/0eFmVtcFwPC3DphYoeluESEHNXY3lYN36lBFCH9bCgsIdFyl1dq8OuwHLsGRTE3FVRYB1qP5HpXQ0ALOd+QU7MXWUBKzBrEILe1YAKi6foq11hcZ5XG1YGFrj1VVWFNSXk2sdUWMfclZD5/lVphZXa8+o7FBazHlamtspTWNc5g5DpXfVWWA7/6uhhfZnC2vk18UJBO14wsFdC1WP2gg2Wo0n4F7L9xN1i9wH3EwLnkRvX/v/xf/iRq7A+MooRc1c5ymhXQtev833C3WEOV52/TEk4lVJGs6cn6K2k2650X8eJuav9ITOVETvmEhggzXXf2+DWV/Ph4Lh+6NNiAjL1lf1XDLK1lVVG3n15u9ZJ2Ngc8Z72jc++Pc/hfxc4bF+I/cxlHjxt77R90oB1TCrswCLlru7dGtqNmE+ZNShkkVTDscvCzqJof2NDquN3gpRr714SRvu1c1bGdYf0yo+FdDf4clfMvhwVup9u8HnfPhjJNwfhTk9tz6h3dVTo/OBh+fY9hyl6iyNAyHcKqmXHtyGuVvCwcLkr/Ti819vDuu4ZbDZifnYi7MIs62Hhc1d95gmmzxmEuY+lIDx7BsFPlmu6YT92OPN5+Sl+2ANI9q1O9IE7oazoO2XgRdiVR3pYcPjJcAEfXGSil4GaZGWA5Z3YHM9dnbn16AGsYKcrUSbVQDHdnZl2TsxddTfdI71Eed6OnHRgibCycq8S+h93Rp3/BAqp9u8+Z4GYu3LUhi090J1UV2Z9KtFdkoX1WRWFRVBXZ51VCliSFVBXTUbMI6c48wLqqu8qoXsaDjRftBFufm2kSQQNu7wy6uoev353kUtQQF2127QM158E5zWXD8UAThZcWF3lK6wDm1imuuoSa5ApCqsLsLw7BnkBddUcWAmTBjkrk2tIUFgiXWGl5BqY45V9KkdIY4zr+9M5IKwou/oxNF0dPtLJHl80FgRS7dUVVlrHqyY5LILCcu+7GUFhHfnFCan20XJYrr030CUW48+4IEo55mAWUmHxK7WOZnqSwvLwq29bmADHLMoAk4DJiDXcaj9GSLV3VlhRfSU3D6spsCIdRTkh1d4RWImTnKvn+EQ41+5WWJjc6JVWLAY+HqBWTGFxvHtlq8Nu+TsPkSBhdbGCwppWhUX2rrorrFA30d4K68ovPpfQV70Ulr8jQ1uFZbnl7yZKWN1jrtwCJPtOR/vqkFdIUFip/tUoCivcreHGr1Magg6swMTmsMYaZGtO4iScxsCKdrvinuTVkMBCTMKpqrBEunfF4t5T7g4H7pknwZ3vbdSCjJXBI7mGUliWWJD+LOhh4VPtbSc2J5Gr5Yh5Cr9U0n3geYJ476qHwnLw61b5tdkDyC8E4w4vKqaw7h0ZQrmF0RXWjV+XaCkWWN5uoqyAf9VAYclwrv2eam8CLMQUZ17Av6oMLIbxrux/FRQW2rc6VodQYF9OBHzcxSx+PWMUlkqoZ3lXlmIDKSz4JEeTn9nB0Z1dLNO76qOw4n1jeiisUDfRsSc2p+eu2issD788znrtTe/X7MIJV3w/5Uu6Y3yr8RWWP3d13bqDB5ZnxyAj5q6ae1jIKc4NgZXUQ5RT9zy3BhZyknM1YAns09CrGrBcyav72Y939UmoE3NXYpQuHb5VQpS+KuBhWX4xjLM+iMJK2ddcd2Izil9DT7tJzo02mdicnLzq2Fbo4lwdNw/uCQdbIXo8LPykrrEU1vk+rtxVTnuZYEdRluFbNVJYMqavXJVhdYWF8K+swiqRbKgELLR3VamfWpZ/1QBY3Ou7i1P3BauxBCD9K191OIDCOtV/kKytINfDOvOLZXpX7RTWxXOP9I1prbBi03AGU1iRbg3pk3DqKixnT4ZgKrQmsG75q2t7hshqI9W/GtPDSvevcAor0u2KEXNXzRRWgnc1tTfdEVMGjx7WoCUhS/OuqgNL0L2rhp1meTB/deETcLx/NVSnWU9uIdXDyt78fOUXm8rMmG/hYWGmdbVVWPFJON+ksDDzumoqLF9Hhv692LmXUv774HJX37BKGMpdYRVW8hRnVsC/qqSwULmrJgoL6Vsd6cXL7MwpCT6W410VBpZqkUz0rVjvXv7B3AIQc1eDKSwnn1K8K06LNfj7XbFH5ThCEYUl0XOcWygszBTn8RVWWu6qjcK692o/9Qcda/hIVGHdfHfChPkxFBb4M+3c1TAZ62El7BNk+bty6gArYW2wxXguQcxdXavDYWMNyNxVNWAJJij+1aDA8k5sxq0NDqKwENOSTgTL3fzsSoaONbHZrbAok+bbeVhpHfm+xcPCzpqv5WEhp7oNMrHZdx987mpMhZWWu3IZWiFgoSY5M2rHvnrAknF9JaO1YXGFRfCvjhXigMBK8K+iqYZcYH1qP2AYVeXvedVVYTn2DUKmd9VRYQUn6kDcu6Jufg73ax9XYclIx6u+CgvjX42fdMd7V3UUlm8WTvqUrZEUFj95WLjc1XgKKyV35Q9i+YGFmDJoFVaJZEMxYEnsrsEmCmvGe1fn6nAoYK1s4km+1VwfWM5pN/Sp3x0VljPPDsTc1RCxhohP5T5/GqKKz2Hd+HWh08geFppSzRRWPHf1TR4WI3hXtTwsqnc1poelGvhleVfDKCxI3DPoe+sKrAnrXVl6sTI7c0oAS9d/YsKn2qsqLGLu6lodDgCsU26BF9FXWcA65RYAtWNwMIUV2C8Imd5VJw8r2k8UIrmrK7UiCit9zuCYCovuXZUGFo/Nmkjc0Tymh0X3rsorrGD26usUluUXkHLtLXuxZ2SvwOVduaWXG1joKc6PsYD1mdhM964qeFik3JUcFViXic3Y3FUxYAUnNlP1VTcPKzCxmZa76uphJfZhCCRHaQ38UjryjaiwqL5VC4UliZNQR10lpHpXNRRWjnc1lsLa2QR53tUQHlZq7ipgbZ2ARfCv9upwAGCd8gsiueNVZWBttZ8g5q4GA9Zt3w0n5q4ygeXtdwXoXYMDKKyEfu2Q6V019LCCuSu3wgp2lElVWOn+lQWN/HsuTpTA882mv+c/+Tnx+3yZs2WAJeX5ZnJVWHneVS2Fhc1dja2w2Hqf9J5X9RTWzi4g5q5GUliOflfqb3+uf9XJw8LmrngQWjuwJrx3dawONS1aAwuWWb+yyQDroKVEpndVEFiaS4KYuxoKWI48O8/0rsjA8vRkAFLqqruHFe0lCtm7chp6WMg+7U5EYRv4xXJXLtDMPmBp0QNXYNlh8XRg/Wri/a33OiksuSusqYBZXtjDonlXIyosxS/I9K5KeViWX4DoeTWuh3XveQWin/eUex/Pzhtn7irWEksBi5S7ulaHQYU1mTdvwMr0sEADa/79AMursOhVocj3r5IVVkp12AlY3v2CnJi7ygBWsFc7ZHpXzRVWYq924Lm7cpoorGTv6qCreIp3FVBYN34lJUKtwoL38/lesfXfyqdPNXgoCfnyXt/fS8L1LOhTUt9g/fTyUpJpEou+08uUfur4pR11c7wI5Zg91ZF6fb6MwprNvV4raCylzPVa4KjfTX10Pdx+04UL/YG5icKiZq/GVFiGX5DhW5VRWOLqYWX7Vz0Vlqfn1dDTbhDZK/Dpq5h3dQYWIXd1JdimsNTf/hUELy2oNmC9DsASv5ox78/Z9eX9XpZfdbVC0Ht9S9GMmQvVdUqP6bv+m/WxukZ/dH17WdTriiijsOBprlw+Cst+dmWYOVzvzxSwzE99/76XP3V9BWCd1JMg5q6GAZbHq+KZ3hUaWJGcFUS7tQ+lsJI7tAMvlBytCSzAP525K45cJaRMQt0UlqrOHisN5smtsP40V+Tv8/kB1lpGPqQ9fjHNtJcBnbrVIteaT6knoUs/fQNTUjIDKfEpCRWS1svV8cuCRp0xP3ZF4D9FIH3Nn0GYAp/5fesrrDzvajSFZQnVap5gKr9G7BSakRv9inmC1NxVbN9g2MMieldXhcU0pFaEuBXW7aw+2gikwMG2j28m+vqb2UvMDWBRlaFUx5vR/gEW1z9f1YEr5ozC0uxSOmtZmD7U1eB60fr5lVFc48zArhSwPP2ueKZ31QlY0X7tPNO7SgRW8pxBIOXaGyssnu5dHRVWiWRDJWAhvSsOGN/Ko7BwuSuPwtI4Er8+YDFjtjM4KKy33IH1b72PwshrWl8MpiZhFwC3P+W0AWvegbVBRyNNKsn0z4BGHFhkDzW4NPD0r7O+FgWWh1+cmLsaS2Hd9wzC3ENh+ftdAfs+hZUyZ3DEaTf03NV5zw3OdCfmria3wtKQYl5giW11cDfdD8CSBljm49qsUq74Zq7rhza0lIO1PpTaupaEhyu5WRs8VHv2UMFSabAPsGRhYDkz7ZyYu+oOrMheQV4m1RAHVuIsHMj08jFRdAAAE2hJREFUrhp5WBzjXxmFxXmJZEMV8AHev3JSiiNXCSnelSuHJWPAkqeSUAGLH4ClP76CSK/vmUpx2R6zYtKyvF4XhfUB1udKcaaUlP/twHpbYM0aWHNNhWX5xRE9r0b2sK4VYC8Pyzdr8Ds9rPiswe9RWPGeDC4PC8oqrHh1eFRY0ZJwcpaEuk5jBl6KaiqWuFLGWFXqf9J5NreelGluPaxdYXFT6JnclTCpBn9JWENhBXpe8UzvqgOwkmYN8jKphhCwkv0ro7CKpBrqgQ/pX9nKEHih5GhZ8AHOv/L3akd6WJ5c+wOtsAx9NtNdarfqCCzrcv25FJY6K0024TXNYFIJ6zX6e3V7sUkzDSm3h6XXICVjFjS6/lPu+vu1HZoqsYnCmk8eVr5/1VdhufcMtldY4X7t36awUvyr71FYMf+KIx0rosJKodemsDRadKzB0IT9XlcJt2CVy3Q3sQb299zU1ma0qzzCvG2tNhF5dYlDYU061mDOCAnLa1YaSoVG7cqgtCuDNRRW0KXigfXBIYGVOGeQ1wYWcsIg5HWVqQ0sTnt2n9jsBh/Qnrc6kCMVVo53dVVYNjiqqPF+Lb/vW3D0rbKbToWlg6PLWwdHdUB0y6Da8Ofb5LBUNl1ZWS99/qViWm8dHFVayUZMhYGUhC2A+lrfVJcvOjg6N1BYZzZx2dd7yr2PLxnaWmHFdjR/l8JK39H8DQoLk7uqpLDSkw12L6HdmrNl0hf4PQFr4n/P09YcUGrMbi7UW3Pe5phry10xalsxfKvWDFJ9fv3cli7VQFPvLlphrewxH1KgMcCS5rM6gWVvI0sqrMQ5g5yUa28OLJbqXdmqsKLCEulrgzu9oIB/VRx8hNzVtTocTmEBLXfFM6m1Kixa7srZD0s+HrOKev6oMz8/5jbyocNTP/9Ns01Ryenx81D5z2lWwVX1ePyYlxWg2yrhvF7+c3jTdudTv/D6g9bPz2LezqivjR76rifQmP4N6vGwGwxn+47cvymjsHz9rnjW2mAvhcW83lV7hZXWq/0bFBb37xkU36ewMLmrQDuZUh5Ws9bG0vS3YudWDtI9az7er734xGZk7iqssOj0qg4sluZf2Uc1hSXw/pXYVgkHBBbH+1dneg2lsHSDhQJ7BqkKK7XnVe1e7Moz110YVJVoABTohRzud1V7YjOCX5pO/2vvTJYjt4EgKkYRwUPd/f+faklNdnPBUitQkN1SeMYjucOXSSUeE5mxF5uJ7L3DniA3dzUnw2rnrmZiWJTc1XPQy9Rh8U+HJp3uL+h+3MnZShpF6Wrv4rCI/OpwWAapBk/BIvKr66nQwWElHr+65q6CCVZCYe7qrmBBHNb77IfIzl2ZvA6HpeJXdvNc+OnAau9MVPvaOx4Jm/xqZ1iRHNYCRH7V6mr3d1j13NVsDouau5rDYXFyV2AiWkWGxVUuG8H6/sv9tW25nUHujnMHwWK1tIOuVcbfYRFzV+6CJWBX53RDOMES5q4GrN2w+mJQem9QabdeDivMnuC2LzYX91HJrcf9GVb9RvNsDIvaGuPtsKjsag6HxWdXkfuwqLkri/xVxWHJToZGu4TbUuHrdH/l6LAY3KrMsMIIFjt3tfoJlih3dT8dhhGs/dyHwtxVMIeV7Tpm3RsEzC/jCBzWl4XHslxsJrGrPms3JIdF6Wqfg2Et+ezVEIdVyV0t8zksbu4qOMMCbHa1N3E7mDgsqXq5CBYjd9WRYa1cfrVFPhKSc1erv2AJcleBBauwJ0jLXYVyWJnzH1L81T0rCibQffjEPMFhfbHXUPs5rHzuKvKeYO0pIXdRwpNhSZZQx+4J1t5Ht4QayWFlc6NokgulOix1qsFa+Ni5qy4Oi8mvzrmroA6LnbtyEKzfcx+y+FX5ZDjcYd1yC8hiV+EcVrHvCmncSpsTLTCssA6Lnrsa4bBquav5HBYtd+XvsHi5qxkcliR3NXZPULAzaNR3xWJYYQRLwa4cHdYq+wgbaxDlrswFa9cmFOaugjmsR24BhbmrEA6r0seA7dyVS9Q9NMPantmrLQ7DorGrWRyWdA3V2mHROhlmcVjw/f+jeTYYy2Fxu9qdHJaeX1nmsBKRX3V1WILc1f10GEawdmoFzaeDtJMhqr3VzrCEuaswDqtwZxCFuavB0L3Z045UfuUhWDEdloxd2S82y3JX8zgsXu7Kz2Hp2FU0h7Vr186wxOwqiMOidF7586s3wwojWD997Ep25cSw2NxqiytYv+oEBvxKLVjFxWY+uwrAsIqLzRp2NYxhEXJWPXJX0zgsCbfq5bA2wRJq1ODoUulr782wJLmruAzrpUkozF1FY1ijcldRBet9/kuN3NVXT8H6qVpm8qvS6TCEYJ1Of6BkVwrByvZdoSJ7NdRhNfquUJRrH8awyDuD+GRX4JO8Cu2wftoa3tkrEbvydFic3NUMDmsRZq9sHdZLt1DJrqI4rLt+oY5dDXZYHHb1X3JYJy+VlOzKULB+dSkJc1cBBeu2JyjJtRsIVqGTAZXsapDDanaJopJddWVYzA3nTO4KvNl7QIa1qfmVj8OSPBuM7LAWFbuycliHfqEwdxXLYT07GVDrrTrsCQpy7cNeX0bQNNH7jELnaIo/IbWuftht+wKVwM5d3P+//n/lXv/4Oqzt/Ot2+vzkp7brHcBnBnT/T+7fdxwJleyq5oxe7uj1ud4x+usfr5HC/TevxWYdu1r3b7JwRsv3J5K5+ut4dyu5en8NayfAO9O6//76g8oiN/rjsC7sapE7I3j99LkRpevnz4+eapsLUlZs8POJ16RVOjmj1C4PhvZPBqufHED+Ltsy9j9xJMzoWVKyK4uJ+fO5LynZVYAjYTbTDsLclepIWPHdWPPjC/dqzqJOJOBL1i6u+1C5n18OXWp9YPXZ4FU2P19PnCMhtjPpN0ZeLDDm7Az+FwUrw92T2lt5MCx+7mrc2g2NvaOSXVkwrLMy4aJelz8Ea9E/3/sRrEOtTl+H23fVc6PUI/xFCQvcQc2wsMiw8G0VObmrUbRglGCVzosnh6U7GSbxc8ErW0+K7NVwh1VpbAdh7kogWKSdQRTcG1SyS8j87tNj9VSi9FAshsNyYaBY+PKZWX6+hp/xiJMSsZ4NXtVrBIf3Go+QateLYQVxWOvusKTsKtpTwnPqCpfFxGOhPjf6q0i46E9ykoctkM1P5Z8SAiU3estd9c5PPTQMTxXsh8M6sTd+7upisU4w7krm4E85rMpdwcTqZDAVrGymPSnZ1UDBqt4TBJtUA02wCM+OUX8rR34H8HnSK8UaGN7q7LA6PR2+rpseioTnUx4yOq+qjwoqlVfw+Oofcljb7d7giMXmmn6BMHcVz2Fdz4D+i80M/fr2VqPiLA8edQiNPA9zOflFaQp9Wyy73NXthg7gLTPjcmrs7bC2Vl97skk18ASr0tUOxL6rMIJFXBqE3VmtvoJF3hpE/a0cXVPoVbmeggV8fwW7wzJJjpqNR0hy7aXT4fPP303JF9ZlV+Iw0GHl+64iOKyzfoGSXUVwWLnGqzEOq9wnOq4W5ohtvfNaZIdF2RoMtidYeB9R39XJS8H5V9eK9/4Mq9F3NUiwqovN1M6rIIJFWhoEA3fVFCxGRzvSluh9r+ZA9WoO8D+GLzbnD4bA51aPzquLY4IriD99k/UTRfc9QZJu9RlAFekXCHNXcRxWvvFqhMPKsatgA6hAd1i0G81zOCxS7ur+h2dKlQHyiLd/Mclw9XJYTXZ1nAq7C1aj7woM+FU3wSLyq+XEsBwEK3HY1cdh6fmVy+VnkDwb/JwO0eQZoaHw4elpIor41QlOnR0W3DTsTt9tTocDGFZma3DIYjNtZxCU7Gqkw8q0Xa39HRatqz3QxHy1raGVu5rLYVFzV3dBOtkkuOIq73s7fRzWRt8a7Oqw1naXKOhv5fQSrIWzNAjegsXcGQwmWAmbPR60rvZIDGtXLBTlriB3mHs6LMgktIB4mzEsw6rdbB7LsJ5bg7CNe7qne5/6vebeDKvVyDeLw+LwqxkYFmdrEIog/XJUpAhSaIZFYldffQXr3STTyrHDqr6V4y9YC+3Z4PlU6CRYbHZ1nAxDCpYgd3U/HYZxWHgKYqm41ZWlw1O4Ht4qIsMiOKw6uxrNsEp9olHXbri5qzEOq7LjvMznsCi5q1kcFjZz7UWJgcdtwkbuCqZiWE1u9TXmSEhsuQJh7qqzYLH4lRvDSnx2dShXQIYlYlcpStNsIbmAstxVNkZVclieTQ7dHBa1lW+MwyqnQmd0WJSlwR4Oq5a7mo9h1e8MzuGwru/TYlfQBFBwOwmWcld24uXlsDbas8HnydDZYa3t5NXTYRnczPERLEbu6n4yNBSspGFX4RjWfu5DYe7qrmLDHdYtuYAyflUZT72y9nbuKnzSncauxjistdnVHsxhVRtHl3z2Kvda/RwWLXcVd7H5+j7c3NUMDOtErki5q5rDumWyJm4cJeauusYamCvOL4cV9ki40NhVXrXMBUvIrsIeCZXsKojDypJ1Zu4KKgV+2VYscGwh7cKwOIsSPR3WSuhrn8dh8fZQvRkWdwk1NsOSL6EGc1j5xYpG7qr6mBDacSswpO8eDouVu+rksFaJv1rfDCuYwyKyq5py9d+jrO9ShhAsuDAsJrsK6LDke5T34vaqcEGhfdTjmOjosLZi59V4h5XRrgJZn8FhUXJXfRyWjF9FZVhafuX1dM8oN1rpvCI+JRywtmsvWEJ25c6wVu6H3QCqg/Cxc1cugvWtS5iWxOdXIY+El+eCKLg3GMxhFT0UOXfVdkhQymPNI1iFrvbOe4JNhkVt45uDYfH3JDwcFid3Fd9hyXJXUR0W5E9/ksABYN6QZZ4yxhYscudVR4clZlfrm2EFEqzvcx8Ic1eGgnU596EwdxXGYRX6rlCYuxoO3RtLg6jIXZWl6Zl099padXJY9NxVX4eV0a9GIjSyw2LkrpwdVuXO4GQO67xLKORWoRxWsfGKkbuqOqxZl58TKdfeb2I+CXNXd/UKJFjLLlgqdmUmWMXFZs6zwTAMq7jYLHs2OJRhVfsYsNXVzopRZemVa4bUxWFJ2FUPh5VtZNii7wmW3mdpdl71ZFjc3FVshgUJhbmreAyr3XglFBew7LnqKVi/3iptOnblIFgKdhVMsE65KxDmrowE65FbQCW7GuqwKn3tqGRXQxgWYWkQjdhVaZfQW7cMHZYsd9Un1pBra3/7q20ih/XLsDTsytZhpe/3keWuIjosuDAsNb8a7rAy93KwVBAzy0svWO89QR27MhesdVsl2auggnVZbNawK5VgZfLsKMxdBXBY1T4GFOauBjIscg9D9t4g0Cus6rmGiXJYghOgm2BBu/Eq+J5g7X3YJ0BHhqVjV3Ec1lW/0Ghh3ntPkKFfji+YgmFdzoBJya6MBOt97kvC3FUowcrcGQRF9kohWMX7gqhkVwMc1nHyq/ZdoZJddWVYBHZ1d1ioYFeQv08IcxwJd+1KSnbl47CK7IrcxRfJYf3oFh76tWj8lYXDSm+GZbEyP9JhZbraf/7+p7FP92TvQ18aNGNXMAfDuuWukpJdmQnWrk1J9WwwhGBlM+2gejaoEKzinqAsdzWcYTWS7CjMXQ1gWOQdnMcWs7q+CiaE7rtupS+Nr/JjWM+lQV5fTCyGtXy/jyx3Ze2wDmVCJbuKwbCeZD36nqCOX1kjLfm7/dNBsLJ3BhOj88pJsC5nv0ROtNc1bJhgFe4MgtpbsQSr2deOSnbV2WGRlwYRLG7mOAsf8vzVo6lKiONhoNtSOqxP7iop2ZW9wyotDUZeu2np128Xu4pd6RzWs+8KhbmrCA6r0ncVeu2G1YeceYRnmryC6EfCQtYqKdmVWrBuZ7/EvjUYSrCKSSuQ38aRCVYjY4VJfSunn8NiLOGg+laOu8NisauTlXpeAITY3MrMYZ0Vq9sAKoNhadhVLIf1UShcrfJTmmeDnw9Men41jmGV1yTmY1jtO4NO+auwTwmrfVdJmxiVCVax7yopngwOEyxCVzssqhs5HMEidbWjkl11cFjAYVdnh6W7leMofMj3V9lbgxO+hA7reWcwhsP6aBcIc1eRHNaSuTfYY7GZqF/pzbCmclhn7UrF5MIsDoueu8I5FUolWJX7gskm1SATrMJiM/3GYBjBau7ggO5GDl2wiD1XmGySo+4MC3gfCEbJUR/hY7MruC8NwiSU3cJh5W7eRGJY68dh8RUqFMNaHn3toxxWiazH3hMk06voe4KN92nnrqK+PHJYpK72ZJNq4AhWte8KlOyqu2ARdwbBJtVQEqy0MHcGUdaI3MthifgVvBlWMIeFiuwVfQnnLzGsrdjXPt5hrXeGpeZXIx1Wqe+qr8Nq7wzO5bBu+lVJhc7gsCj86q+wK7pgkbrav/oLVqNLFIS5q0GCRfBWL/UCb8FibDgfDssi2eAifMBnV2n8nmBJ+AS5K8gtDc4tWEnK3HsNoAr1C1abjfkxDqucDu3NsFpbgzM5LMixqxRknovtsEbkruI7LPLOYCfBIu8MArnxaqBgLXR2dZwMHR0Wk1+9lAuTTXLUULDE3Op8OgznsP6juSuhw2p3tfdabN5oXe0rbCOf7sneZ8n3tQ9yWG1+NY/DyjReNVpjojosbu7qr5mufwEAa0Lat7f19gAAAABJRU5ErkJggg==",
    project: "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",
    address: "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",
    neighborhood: "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",
    insight: "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",
  };
  const pngBase64 = images[type];
  if (!pngBase64) return new Response("Social image not found", { status: 404 });
  const bytes = Uint8Array.from(atob(pngBase64), (character) => character.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}

function socialImageForCanonical(canonical) {
  const path = new URL(canonical).pathname;
  if (path.startsWith("/permits/")) return "permit";
  if (path.startsWith("/contractor")) return "contractor";
  if (path.startsWith("/project")) return "project";
  if (path.startsWith("/address")) return "address";
  if (path.startsWith("/neighborhood")) return "neighborhood";
  return "insight";
}

function renderOgImage() {
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAABLAAAAJ2EAYAAAAf0KcfAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRP//////" +
    "/wlY99wAAAAHdElNRQfqBBMXHBu5XO2xAACAAElEQVR42uzddZiV1f434M/Q3S1gUWKjoGCLhd3d3R3H7q5jd3cXit2iohgIioiAAkpId877B8zLiZ9H2TTc" +
    "93V5bZnZa+21v896nr1n9mfWKqpevX791q2LiwMAAAAAAAAAAMBcKaUEAAAAAAAAAAAAhRHAAgAAAAAAAAAAKJAAFgAAAAAAAAAAQIEEsAAAAAAAAAAAAAok" +
    "gAUAAAAAAAAAAFAgASwAAAAAAAAAAIACCWABAAAAAAAAAAAUSAALAAAAAAAAAACgQAJYAAAAAAAAAAAABRLAAgAAAAAAAAAAKJAAFgAAAAAAAAAAQIEEsAAA" +
    "AAAAAAAAAAokgAUAAAAAAAAAAFAgASwAAAAAAAAAAIACCWABAAAAAAAAAAAUSAALAAAAAAAAAACgQAJYAAAAAAAAAAAABRLAAgAAAAAAAAAAKJAAFgAAAAAA" +
    "AAAAQIEEsAAAAAAAAAAAAAokgAUAAAAAAAAAAFAgASwAAAAAAAAAAIACCWABAAAAAAAAAAAUSAALAAAAAAAAAACgQAJYAAAAAAAAAAAABRLAAgAAAAAAAAAA" +
    "KJAAFgAAAAAAAAAAQIEEsAAAAAAAAAAAAAokgAUAAAAAAAAAAFAgASwAAAAAAAAAAIACCWABAAAAAAAAAAAUSAALAAAAAAAAAACgQAJYAAAAAAAAAAAABRLA" +
    "AgAAAAAAAAAAKJAAFgAAAAAAAAAAQIEEsAAAAAAAAAAAAAokgAUAAAAAAAAAAFAgASwAAAAAAAAAAIACCWABAAAAAAAAAAAUSAALAAAAAAAAAACgQAJYAAAA" +
    "AAAAAAAABRLAAgAAAAAAAAAAKJAAFgAAAAAAAAAAQIEEsAAAAAAAAAAAAAokgAUAAAAAAAAAAFAgASwAAAAAAAAAAIACCWABAAAAAAAAAAAUSAALAAAAAAAA" +
    "AACgQAJYAAAAAAAAAAAABRLAAgAAAAAAAAAAKJAAFgAAAAAAAAAAQIEEsAAAAAAAAAAAAAokgAUAAAAAAAAAAFAgASwAAAAAAAAAAIACCWABAAAAAAAAAAAU" +
    "SAALAAAAAAAAAACgQAJYAAAAAAAAAAAABRLAAgAAAAAAAAAAKJAAFgAAAAAAAAAAQIHKKAEF6V1UumhCUrpi6UdLn5yUGVf23bLnJmVeK3N6mXWT0neWaVx6" +
    "dFI0oqhJUVXlAgAAAAAAAAAWveLaxYOKxyUzjpk+cEaNZHqn6ddN/zKZXnXa5tMuT2ZMmnHAjH8maVU8vbiyevH3FFWvXr9+69bFxUrB/1K6VOl7Sx+TlH+r" +
    "4lYVP0zK7lpurbK/qQsAAAAAAAAAsPSZ9vzUb6Y1SqZsOenNSRsnM2bOOHzGHerC/00Ai/97YgwrtX2p1ZJKD1a+vvKQpMzlZduXmaEuAAAAAAAAAMCyZ/q5" +
    "0z6dXjqZePCE0yY0SIrrzew8s6e6MIsAFv+m7JHlzinXNKn0VJU7K49TDwAAAAAAAACA/zRxr/FHT6iaTLt76hVTf1WPZV0pJVjGlU6ZlEnK96p4ZMUBglcA" +
    "AAAAAAAAAH+lJF9RkrcoyV+wbBLAWsaV71Hx0Ip9kwodKj5bYW31AAAAAAAAAAD4u0ryFiX5C5ZNAljLqJKtBgWvAAAAAAAAAADmTUn+oiSPwbJFAGsZUzSs" +
    "1PalVrPVIAAAAAAAAADA/FaSxyjJZ7BsEMBa1k70BytfX3mIOgAAAAAAAAAALCjyGcsWAaxlROlSpe8tfUxS5vKy7cvMUA8AAAAAAAAAgAWlJJ9Rktdg6SaA" +
    "tYwo/1bFrSp+qA4AAAAAAAAAAAuLvMayQQBrade7qEzRhKTsruXWKvubcgAAAAAAAAAALCz/P6/Ru6h00QT1WFoJYC3lSlcs/Ujpk9UBAAAAAAAAAGBRKV2x" +
    "9KPyG0svAaylXJlxZd8te646AAAAAAAAAAAsKvIbSzcBrKX9BO5S5vQy66oDAAAAAAAAAMCiUuY1+Y2lmQDWUq70HWWalB6tDgAAAAAAAAAAi0rpO8s0lt9Y" +
    "eglgLeWKRhQ1LqqqDgAAAAAAAAAAi0rRiKIm8htLLwEsAAAAAAAAAACAAglgAQAAAAAAAAAAFEgACwAAAAAAAAAAoEACWAAAAAAAAAAAAAUSwAIAAAAAAAAA" +
    "ACiQABYAAAAAAAAAAECBBLAAAAAAAAAAAAAKJIAFAAAAAAAAAABQIAEsAAAAAAAAAACAAglgAQAAAAAAAAAAFEgACwAAAAAAAAAAoEACWAAAAAAAAAAAAAUS" +
    "wAIAAAAAAAAAACiQABYAAAAAAAAAAECBBLAAAAAAAAAAAAAKJIAFAAAAAAAAAABQIAEsAAAAAAAAAACAAglgAQAAAAAAAAAAFEgACwAAAAAAAAAAoEACWAAA" +
    "AAAAAAAAAAUSwAIAAAAAAAAAACiQABYAAAAAAAAAAECBBLAAAAAAAAAAAAAKVEYJYMEpfVvl4vqNkwozG1y5zlVJxZeXe3H92km5s+r80PrFpPQh5bevvrs6" +
    "LelmPDTl9TGdk6lX/tHs+y2SSTsO3vmzUcnkUkPO6X52MuO4CUVDB6sTAAAAAAAAACyNiqpXr1+/deviYqVYOlWvXqtWzZrqsLCUO7H226ucmdSqvP7BZ+yX" +
    "lH202kZNhqnLsm7aAWO7DlwuGTn+s/uvfTiZevOIjj9cpS4AAAAAAAAAy5oxY0aOHDVKHZY2AlhLOQGsBXwCNSi9X/kqSc0N2v56UpOkcrcVG295s7rwv01o" +
    "2/+Xt45JRn3yxQo3/ZYUD53x+JSJ6gIAAAAAAACwtBPAWjqVUgIo4MRpWe6ear8mDR/f6bXHDhW8Yu5U/mLF5be8I2n42E6vPLbfnPkEAAAAAAAAACx5BLBg" +
    "LhTVL71v+UpJg9u2P/X+S5PSB5XfpvoO6kJhSh9SfvvqeyYN7tj+zPuvm7OiGgAAAAAAAACw5BDAgrlQc4O2A05qNCc4A/NDSZCvZCtLAAAAAAAAAGDJIYAF" +
    "f0O5E2u/s8o/5mwdBwtCyVaW5U6s/fYqZ6oHAAAAAAAAACwJBLDgb6hVZf1DzzhQHVhI863y+gefsZ86AAAAAAAAAMCSQAAL/ofSt1Uurr9cUvaRah2aDFYP" +
    "Fo6yj1bbqMmw2fOvsXoAAAAAAAAAwOJMAAv+hwozG1yxzpXqwCKbf1euc5U6AAAAAAAAAMDiTAAL/oeKLy/34vo11YFFOP9qqwMAAAAAAAAALM4EsOB/KHd2" +
    "nb6t31YHFtH8O6vOD61fVAcAAAAAAAAAWJwJYMH/UPqg8ttU314dWETz75Dy21ffXR0AAAAAAAAAYHEmgAUAAAAAAAAAAFAgASwAAAAAAAAAAIACCWABAAAA" +
    "AAAAAAAUSAALAAAAAAAAAACgQAJYAAAAAAAAAAAABRLAAgAAAAAAAAAAKJAAFgAAAAAAAAAAQIEEsAAAAAAAAAAAAApURgmAVds1vrHU9OSuGw4ZWb7qIhxI" +
    "h1ySScm4Xyc/nCOTMXtNfKJ4t+SP0ePWLa6bfDvy12kzv0+++LB/lZk3JN92/vXsmQOS4jOKyxSPdBwBAAAAAAAAgIVPAAtYfHTNBamYVE2FC/JIUjUVUpSk" +
    "cWqlKMlaWb5cqQ2Sg7LR1ByR9Nt62E/FRye37/7ObdNuTz57tm/tGccqIwAAAAAAAACw8NiCEFhirfRGveZFdybXnbzPP8udlhz502YTyj6nLgAAAAAAAADA" +
    "wiOABSw1Dhy64VVl9k8OemGjcmWPUA8AAAAAAAAAYMETwAKWOocWb3JhmYuS5X+u80Kp49QDAAAAAAAAAFhwyigBUKip1abfnOeTsY0nNc8Bc9++dP1Sk9Is" +
    "qdy9/KBcmJQbW+bE7Drv4ypdr2hymiW7/9pu9zK/Jddv9lqmOlwAAAAAAAAAwAIggAUUrOtvfW+feUhy3jbP7DfljwI6mDb7do1ZN+XXKDOmqFPS4raG95T6" +
    "JFn/hpVPLHV9ss877e8sU3vuA1obPNr8qFIvJdcnn2Wm4wUAAAAAAAAAzH+2IAQWG1OqTb+5+Pnku7MHTpoxNLln+PtXT9s/uXDl57+dWm/u+6t3SLUti8on" +
    "VfapMKDoJvUFAAAAAAAAAOY/ASxgsfdR5R9XmLFOMmSnMZsV95v79tUGVvyp6BF1BAAAAAAAAADmPwEsYIkx9IExbxZPmft2U3tOr1H8uvoBAAAAAAAAAPOf" +
    "ABawxKh9eZVvin78+/ef2nNGjXRJRn854Zlspn4AAAAAAAAAwPwngAUs9lZt1/jGUtOTxtfXalu0899v16vboFNmlkmmN5t5TfF36ggAAAAAAAAAzH8CWMBi" +
    "p8L5ZY8tOjzZ7se13i5zcnL1vnvdWX6nue/npcu77zxjX/UEAAAAAAAAABacMkoAFGq1dsvdWGp6clm3PU4p36DwfsqPLXNCdk3q1Kj6ZdEfSZPraz1VtFNS" +
    "YXjZD3L43Pf3+Sk/3zTztOTthr3GTv/VcQIAAAAAAAAAFhwBLKBgdb6v2ikTkk3TqtM8LadX5T/+fX5h3Xz8TZ/7Z26YXPjOcwdPrZqkWm52lAAAAAAAAACA" +
    "BUkAC1ji3fzkmw9NG5U8fevng6e/FcErAAAAAAAAAGChKaUEwJLumDEdR5TtkZxw81a/lK2QVDi/7LFFh6sLAAAAAAAAALDgCWABS7yyR5U+NZske7VZ794y" +
    "Rckd/zh4YvmhSfWTKvUuelV9AAAAAAAAAIAFRwALWOo0/7pBk6K3k0tX3/3JcuWSoq5FF6SiugAAAAAAAAAA818ZJQAK9f743q1mVk/O2+aZ/aYMmYcLUd9S" +
    "ZxatnlQdWLFvHk0a/FFjs6KGSfvdm40ofXuyxxPtHigzKqnatMKBufvv99um1fIzSu2YbPHsqt3LtEzeuqHna9O/cdwAAAAAAAAAgPlHAAtY5KY3m3lN8XfJ" +
    "qM0mJElGZcIJxUl+KBqcmRclr6z1VevpE5I7Pzt0o/Kjk/otqn1UVOPv97/bTW2fLP1F8lZ6Vpuu3AAAAAAAAADAfGQLQmCxN7z1uC7FlZO77n632vRN5779" +
    "atMaVy1VNqm4ebkhRSeoJwAAAAAAAAAw/whgAUuM7rX6XzHj6QIads0FqZg0bVB77aJD1REAAAAAAAAAmH8EsIAlxqR3pzbILYW3r7JPhQFFN6kjAAAAAAAA" +
    "ADD/CGABS4y691T7tGhm4e2nVJt+c55XRwAAAAAAAABg/hHAApYYG7/V6qDS3xfeftiDY96cOUUdAQAAAAAAAID5RwALWOytcEzdZ0qdnxxw4AbXluk09+3/" +
    "GD2+beokwx4Y+1axABYAAAAAAAAAMB+VUQJgcVFutTKjizolTRvUXrvokGSjiS1/Kd092bdhh2FlmicVK5Q9MifMfb/vNOz50vRfk6yT+1QZAAAAAAAAAJif" +
    "BLCAgm20VotDS32cvNHpzDoVLy68n7IPlR6fdkm5j8ucn/f/45sHJUnOLaTfqT1n1EiX5KlbP399+tZJHkhiBSwAAAAAAAAAYD4SwAIKVrpvqTOzelI55ZOr" +
    "5qGjWxbM+O598f3y049Ihr0+9q3inxwvAAAAAAAAAGD+K6UEwNLm/fG9W82snjxxwafDpg1SDwAAAAAAAABgwbECFrDUeOX7r7vNOCO57rzXdptWJSnuUFwh" +
    "k9QFAAAAAAAAAFhwBLCAJVb/HsN/KD4nueXEN5efNjnpNr3fGzMuT5JUyCXqAwAAAAAAAAAseAJYwKLXIZdkUjK507Q6eSyZ9O7UBrklGXHu+LWLWyaDThv5" +
    "RfGLSd+Lhx0w86Dk429+vG/Ghknft4f2n3m+8gEAAAAAAAAAi05R9er167duXVysFEun6tVr1apZUx0K1aTJPvu89ZY6sGgNHPjEE1tuqQ4AAAAAAAAAS7ox" +
    "Y0aOHDVKHZY2pZQAAAAAAAAAAACgMAJYAAAAAAAAAAAABRLAAgAAAAAAAAAAKJAAFgAAAAAAAAAAQIEEsAAAAAAAAAAAAAokgAUAAAAAAAAAAFAgASwAAAAA" +
    "AAAAAIACCWABAAAAAAAAAAAUSAALAAAAAAAAAACgQAJYAAAAAAAAAAAABRLAAgAAAAAAAAAAKJAAFgAAAAAAAAAAQIEEsAAAAAAAAAAAAAokgAX/w4wHpnQe" +
    "86w6sIjm30NTXh/TWR0AAAAAAAAAYHEmgAX/w9Sr/1jl+53VgUU0/678o9n3W6gDAAAAAAAAACzOBLDgf5i04+CdPxuhDizC+TdKHQAAAAAAAABgcSaABf/D" +
    "5FJDzu7+D3Vgkc2/c7qfrQ4AAAAAAAAAsDgTwIL/YcZxE4qGDkqm7T/2o4H11IOFY9oBY7sOXG72/BusHgAAAAAAAACwOBPAgr9h5ITPHrz2MXVgIc238Z/d" +
    "f+3D6gAAAAAAAAAASwIBLPgbpt48YosfrkkmtOs/6K0T1YMFY0Lb/r+8dUwy9eYRHX+4Sj0AAAAAAAAAYEkggAVzYdQnXzS9aWAy46Epr495RT2YP2Y8MKXz" +
    "mKeTUZ98scJNv6kHAAAAAAAAACxJBLBgLhQPmfHYlPHJkGM6X3Po6XOCM1CIkiDfkOM633Do+Unx0BmPT5moLgAAAAAAAACwJCmqXr1+/dati4uVYulUvXqt" +
    "WjVrqsMCO4Hql963fKWk5gZtB5zUKKn8xYrLb3mHuvC/lWxlWbKiWkmwDwAAAAAAAICl25gxI0eOGqUOSxsBrKWcANbCVe7E2u+s8o+kVpX1Dz3jwKTsI9U6" +
    "NBmsLsu6afuP/WhgvWTkhM8evPaxZOrNI7b44Rp1AQAAAAAAAFjWCGAtnQSwlnICWItW6dsqF9dfLqkws8EV61yZVHx5uRfXr5mUO7tO39ZvJ6UPKr9N9e3V" +
    "aUk344Epncc8m0y9+o9Vvt85mbTj4J0/G5FMLjXk7O7/SGYcN6Fo6CB1AgAAAAAAAFjWCWAtnQSwlnICWAAAAAAAAAAAiwcBrKVTKSUAAAAAAAAAAAAojAAW" +
    "AAAAAAAAAABAgQSwAAAAAAAAAAAACiSABQAAAAAAAAAAUCABLAAAAAAAAAAAgAIJYAEAAAAAAAAAABRIAAsAAAAAAAAAAKBAAlgAAAAAAAAAAAAFEsACAAAA" +
    "AAAAAAAokAAWAAAAAAAAAABAgQSwAAAAAAAAAAAACiSABQAAAAAAAAAAUCABLAAAAAAAAAAAgAIJYAEAAAAAAAAAABRIAAsAAAAAAAAAAKBAAlgAAAAAAAAA" +
    "AAAFEsACAAAAAAAAAAAokAAWAAAAAAAAAABAgQSwAAAAAAAAAAAACiSABQAAAAAAAAAAUCABLAAAAAAAAAAAgAIJYAEAAAAAAAAAABRIAAsAAAAAAAAAAKBA" +
    "AlgAAAAAAAAAAAAFEsACAAAAAAAAAAAokAAWAAAAAAAAAABAgQSwAAAAAAAAAAAACiSABQAAAAAAAAAAUCABLAAAAAAAAAAAgAIJYAEAAAAAAAAAABRIAAsA" +
    "AAAAAAAAAKBAAlgAAAAAAAAAAAAFEsACAAAAAAAAAAAokAAWAAAAAAAAAABAgQSwAAAAAAAAAAAACiSABQAAAAAAAAAAUCABLAAAAAAAAAAAgAIJYAEAAAAA" +
    "AAAAABRIAAsAAAAAAAAAAKBAAlgAAAAAAAAAAAAFEsACAAAAAAAAAAAokAAWAAAAAAAAAABAgQSwAAAAAAAAAAAACiSABQAAAAAAAAAAUCABLAAAAAAAAAAA" +
    "gAIJYAEAAAAAAAAAABRIAAsAAAAAAAAAAKBAAlgAAAAAAAAAAAAFEsACAAAAAAAAAAAokAAWAAAAAAAAAABAgQSwAAAAAAAAAAAACiSABQAAAAAAAAAAUCAB" +
    "LAAAAAAAAAAAgAIJYAEAAAAAAAAAABRIAAsAAAAAAAAAAKBAAlgAAAAAAAAAAAAFEsACAAAAAAAAAAAokAAWAAAAAAAAAABAgQSwAAAAAAAAAAAACiSABQAA" +
    "AAAAAAAAUCABLAAAAAAAAAAAgAIJYAEAAAAAAAAAABRIAAsAAAAAAAAAAKBAAlgAAAAAAAAAAAAFEsACAAAAAAAAAAAokAAWAAAAAAAAAABAgcooAQAAAAAs" +
    "fSpMKX9b+bHJmr3WuHCVZ5I296y5xmrtZt2u2i5pvPdyExq8lFRbvdq5VfdJqq1W9dwqeyeVH6rUuGLHZPxd49tObJOMrjbm+7FNkj8uG3nWqHLJd9/1qtD7" +
    "saT7A1+v3HOT5LM2X/zx9WHJsJ+Gjx7xmroDAAAAy56i6tXr12/durhYKZZO1avXqlWzpjoAADB/XPHoRdXP2DbZb6M9P93pnMVvfNNvnt5tRrNkUvPJt0zu" +
    "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" +
    "p1fn3v1+Ojb5vO4XH3/TanYQbJWk2+Tu9347Mhk9e2vExcUxVx5+7H5Vk3bD1x08TytANUmrdEh6jO65du9fkm9W7XHx93sk4+6a0HZCm6TuwbUPqfVe0v7W" +
    "9T5q02rOik6F2uTTDZ9a78ZkhwnbftXxH8nLrV/N27v9/fYlQclSg2cFXArV87XvB/Q5LnlryHudPv4mGfTk4Eq/75RM/XLqctPumvM60nzdZoetcEyydb+O" +
    "R2781rwHd7dfo9Ppm++f3Pbt3dUfefi/v99n6E9d+/dIntrxuTs73/vf369fod7vdWokmz690cXr7z73j//1Ed/26NUt6TO0b9f+Pf78fr8PGfLlsK8W/3Et" +
    "rpbV8xMAAFj2CGABAADMNv3m6d1mNEsu3uOqK256Mnn4ucf7PH+yujB/Hd7goHX2apOUH1B+n3IfFt7PjDNmPDRjWHLvkIe6P/VV8nTt57d+tWXy8839d/j1" +
    "kaS4SXGr4p+TcuuUO6nsUUn70m33bXNocnytoz4/sNniv1XVkmrCeROrTJycnFfmkn9cX35WgOad+2ZdX6Y3m32n15IkzZMkJ+fVJNnw2fbF676a3LTlNate" +
    "eN28b320/tdt66x9X/JiOufNuWh3yOyVdKqsWXlMpXn4YH9q92mNpt2VPLXjs3d2vjd5eLknXn6+bfLz6bO21JtxxowyM4YlZU4sU71M36T9xu22X7tsctQj" +
    "h9687zbJRst3WKntxuZTSQCjJBizZYPNumy41oJ7vJKValZP6ytbJlk9rdMyyeE5aN29kmSV3Jk9kj5f9r2//53J53VnB7PqfPnxt62Sj5/49Povd0hGHjlq" +
    "p9FfLvj6lK9X7p1yqyVHTDt4k70nFd7PL8UDLx08Mznhh9Mvvui55NtVv7v4hz2S/J6d82WSHbNcZj2fN5OkaKOi3kUPJTvfs/2zW72YXN7/woNPey+pfFml" +
    "8ZUqzP3jn/XKKYOPPjLp/GSXJ97dZU4Q7q9s88iW9TbZqvDnfdVVNxx/Z/XkjjvufffR1ZMkRSlKkkzKy0mqpm8aJpmZazItSbe0zM3JJSdeNemWvsk/q17V" +
    "9/yGyQ7jtm3W8fe5f/zVV191cst9k3yb6vk/AlifHt9to696J5+mW77q/d/f33DD9tuue3ayaTbK+gU8/1dGd+n8Tr/kvm8ffvTpB/9+u8V1XIubZf38BAAA" +
    "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" +
    "npask7WyWgHtW9Rv1mHFNZP+GfDhwgh4lARLmjZt8thyGyaN91luYoOXkyZ7Lzex4UtJs11XumaFR5I296y1xqrtkpYrNa+70pZJLs8pzkKcnwAAALMIYAEA" +
    "AAvNA/98ZLdnlk/u6/bwo0+/Ml+6LD/79tRUnv1/H8wOYl2R7HrIjvtu81Fy0pvH7HzwGUmlhyo1rrj53D9I5csqja9UITl5x2PvPKRDcmbOf/MqASz+ptp3" +
    "13q5xrpJudPKjix71Ny3n7T5pLcnX5oMeP+XnoMuTNIkrdJh/o+z+4Nfr9xzkyQXJfnQcfu7Rq06eubYvZK8kqT6/Ou3uEnxnOM8bsGNv0LfCieU75JUKVv5" +
    "mEpVC++n17m9b/xpYpIFtI3l9wf2Puqnt823v6v3Zn02+fnipHf65Ock1ze8JfeuldRvWW9Ine2T9re2+6hNq6T9S+2Gr31o0q7CukesWStZ6akVSjfdNf8/" +
    "gLywnbrl8S8cdm3y8mevrfH2DX8e2K57UJ2Da72f5IO8lQJe1y+dfv5Vp05JLs35Vy2OOw3Xr1BvSJ35cD0pCaq3OX+tsqtOSzbYd/3T1n0laduxzatrXDln" +
    "Jat6zevWqL12kmSdTPiXDj5PUpJ4vDnJWRnm7OKvOD8BAIBlVSklAAAAljbDfho+esRryZ3n3Hf7Y+OSTlfsduohlZPRJUGJAu38xvbfbXVq4UEulk3VVqt6" +
    "TpV9Cm//205Dbhr24JyVbhaUoT8NH/3Hq47X3BozZuzz435dcsdffbVq51adh/k57YVpY6cflEw8aOKgSe8uuHGOPHLkjqO/NN/m+TyfHWh68fDOe7z5WXLW" +
    "Kxcce/WRyWbPbFt2392TNX/oUGbbZ5JDTzm2zZm/JLd9e0/1Rx5Ouk3qfu+3I5Op3ac1mnbXghtfyevrUY8cevO+2/yP6+rqVc+tsvfSe5yqr1b1nELOy5IV" +
    "QY/od8jAvd9Juh739uvP9k6ev/ixKXeWTk5recIVh++cbDxog2/bfT5n5VCYr+97nJ8AAMAySgALAABY6g3o8EvPQacllw+4dvBt8xAQKD+l/G3lxiYbnLXe" +
    "PeuMVFf+nqrbVn20yi2Ftx9/9/h1J7RZ8OOc3GzyLVM6JVOGTe04tafj9nfN2HvG2TNeWILn5+ytxwo1uvqY78c2XvDjHH/exKoTJ5tvC1pJUPmd59+f3HW/" +
    "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" +
    "XSN4BQAAAMDCIYAFAAAAQJJk0uaT3p58aXLE9BP+efak5Pedh9w07IHFf9xTu09rNO2u5NgdTr3//DuTb1f97uIf9nA8AQAAAFg4BLAAAAAA+DcDOvzSc9Bp" +
    "ybbH7Lbtod8mHzb+ZM1u6y1+4yzZanD3LffrcuxVyZsrv3P3R1s6fgAAAAAsXEXVq9ev37p1cbFSLJ2qV69Vq2ZNdQAAAADm3YYbtt923bOT42se9fmBKyfr" +
    "f9W2ztr3JUVdi14ounbBP37vzfps8vPFyf3/fGS3Z5ZPnnv7pa9e/0cy/ebp3aY3c3wAAACAxd+YMSNHjhqlDksbAaylnAAWAAAAsKDUPr/W1TWnJh133bR8" +
    "h8eSNceu/sQqg5OWU5vXWml80vjMRk0bDE8qX1Z5fKUKSeWHKjWu2DEpblK8Sjokk8tPOW5KtWTMmDHPjfs1+W3nITcNfTDpv9eAGQOfS76t9t0+PyyXfPz4" +
    "Z9d/ucOclbkAAAAAllQCWEsnAaylnAAWAAAAAAAAAMDiQQBr6VRKCQAAAAAAAAAAAAojgAUAAAAAAAAAAFAgASwAAAAAAAAAAIACCWABAAAAAAAAAAAUSAAL" +
    "AAAAAAAAAACgQAJYAAAAAAAAAAAABRLAAgAAAAAAAAAAKJAAFgAAAAAAAAAAQIEEsAAAAAAAAAAAAAokgAUAAAAAAAAAAFAgASwAAAAAAAAAAIACCWABAAAA" +
    "AAAAAAAUSAALAAAAAAAAAACgQAJYAAAAAAAAAAAABRLAAgAAAAAAAAAAKJAAFgAAAAAAAAAAQIEEsAAAAAAAAAAAAAokgAUAAAAAAAAAAFAgASwAAAAAAAAA" +
    "AIACCWABAAAAAAAAAAAUSAALAAAAAAAAAACgQAJYAAAAAAAAAAAABRLAAgAAAAAAAAAAKJAAFgAAAAAAAAAAQIEEsAAAAAAAAAAAAAokgAUAAAAAAAAAAFAg" +
    "ASwAAAAAAAAAAIACCWABAAAAAAAAAAAUSAALAAAAAAAAAACgQAJYAAAAAAAAAAAABRLAAgAAAAAAAAAAKJAAFgAAAAAAAAAAQIEEsAAAAAAAAAAAAAokgAUA" +
    "AAAAAAAAAFAgASwAAAAAAAAAAIACCWABAAAAAAAAAAAUSAALAAAAAAAAAACgQAJYAAAAAAAAAAAABRLAAgAAAAAAAAAAKJAAFgAAAAAAAAAAQIEEsAAAAAAA" +
    "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" +
    "Qy99kExebdKASY//+fnS7bHPvup6/OJXt/k1Txb09WRJnU+L6rq1qF9f/vR9214DdhhwefLReu8v/971c+bX/59vnaa3ml5j9nw7ZM7X6/Wqf0v9FRf/60zJ" +
    "+VOytecPy3//dq+Xk9K7lj6q9JnJKr+03mLVHZNOR24/cMcPkiO2OubV47ZJTnj4lH1PX3nOFpfrVmj7xXpNZ69o9M2iv24sKz+XLO7XGT/3zNv76qKzis4t" +
    "umDhX48BAGB+EMACAGCRqNer3i31V0wazN5C4M9ua83eCqT0pqUPKH3qnPZl1iizW5kT//wXqSVfb9y/ybdNr5zzi+R+9X4e3bfOX4+vZCuFYasOPWFo/6Tc" +
    "xeXfKD9o1nhq/0tApEepb0/7Zpvk4Q3uL3vvvUm/B38+o+9t/91fxQ8q1au0Z9Lo3OUOaVw1aVm21T6t9/yXO5yVc4suKLyeRbNXDPqr25JfxC9s/c/td0i/" +
    "G/76flNumrzLlBXm/HvwFbO2SPkzUydO/XDq3f963Mv/23xYWPPg7yrZCqrkg7qSrZAGbvlrx18u/uv2H/R49/l3aif3T7vnyTtbJ/3q/zz65zpJnd9nbUlS" +
    "0m/JSiYlW8z8lbE1xt4xdqNkaOehY4cckpSevXVXyRZXf6bvBj+V6dP4r/sfc9eYxmPem/PvCr9VaF3xwP++35CuQ6YPOWLOv/c4Z++D970+WWX2SgIl51GJ" +
    "6ftNbzOtTvL2Jm8M67Jq8uXF3d78/PD5P397dez5zXdvJNNnb/G1sC2oebPAxruUzMeFZVGNe3G7Ps63+Xdy3ZXqPTF7JYzeyYjzZ61wM2qfke+P3OGv2/c5" +
    "6MeGvZstfnWbX/NkQV1PlvT5tKiuW4v69eXPDDi3/yE//433beNnr3z2Z/NtcZ8XEz+beNKE1ZJXjnux2/PfJrdsf+O91/+YvPjwc0Oe+Tnp1uSzTp8Om7OS" +
    "VNnHy3Yv+0ey8g/NyjUfmmx+4pYvbHVQctRKxz14wiZzVqpb1n8uWVCWlOuMn3vm7X31oroeAwDA/GALQgAAFolbet244vX7zflL1T99w/pYma/K/pHUrlLn" +
    "pTqrJ1u9sE3lbb9NGtZr9ESjW5Lt19rpk11eTR7MvQ3/5ffRqXZU9UHVN0uKyhadUlQ/KUpRipKclrNyTpK0yzk5/28Ndeq//qPS+pVvqtwzGfH2iPzxL1+v" +
    "O2TWL4rXfnXdw9s+mTQ+uvFeTSomNTrW/Lpm+6TMq2V2K9Ny9p1bJrksB+eSzApEzYOSX0wfd/dJ40557q/v/0LnZ8c+PSD5KX3y40I83hN3mTB+/POz/7Hp" +
    "n9+v+Oriy4svSTI1TyTJ1BOm/r/27jtOqvL8G/B3d6lLWXqRInZFLCBixd5NrNEYRU1sxJ5Eo7FEf8ZYE1OsSYwxaqKJscZYsXcFuyJqBBQQRHrbhW3vH0Dg" +
    "jdhOpF/XP3x2zzkz59xzzzMz7Heep/+cTkl+neFf5n5K5v/BqP3cmNmS7oMvUjG49QGtByV5KhfnoGTyK3P/oFDfpv6P9S2/+Piqm6oOqVwzqUpVKr+TJDk6" +
    "6yZdR3Q7sVv/JN9IiySZ9J1Jj038RpKHkjzw5c9vxoTp50/vm3RMx3T6OCl/srxD+QFJmie549P7V37GTDKfelz/WP/ruguTNMxBGZqUHF0695v0f07D/HHB" +
    "fvdtes9tdz2TfOPmvbfbb5Ok68hut3S7KPnmLXtvt+9C3TNx+oQ3J7yejDx2xLeHX5IM7f3Ws2/e99nf7P9fTbtoWpupg5JskSy8VNWSsrj6ZnFpdUCrd1ut" +
    "AP24pCyt817WxsevS8spFcdWPJUkOScDksmPTt540nNJ9s4/M/BLPN9bT71mWv8kyVu5Ydmp29fVJ4trPGn3w/art1+O+2lpjVtL+/Xls8x8d8YZMzZOkhz+" +
    "uf127bx+65kTMvzT/ba8jTOzfzt736oeybt5J8NuTt498Z0/DVtoe1mPuV8I6X7hqn/ucWqyyW823aff9cnqG66x/5onJbu02a18jwbJuLvHVo8dm3w8byaq" +
    "leVzyWIf35eTfvK55397X720xmMAAPg6CGABALBMmz/DzccZl7FjkwfG3XvdPVsl3/vV0VMGZsFMWo3KGz3d6JgF3wwu3a90YNlpSe7J1Hx3we/fOOO1Sa8+" +
    "W/x8Zm4x47cz5v5H8aN5JVm70zpHrHtwstcf9p26//pJ6TulZ5QelEzaf+LOE19J3t37nfOGjU2m9J3yw8lzkvH9x50+blTSdq127dtdkvTPttl+5or/ONbN" +
    "X3pjxyV7v0uqD770B7AHyt5uMCVJs9ydJNWHVPepbpfk7PzXnzq+mrIXyz4om5HkG+mVJDWv1dxRc8VXv51G5Y22bTz3m/TP5fykZrea9WpaJXk6/1zU/p+1" +
    "9GdR87+xfvNxN13z5/Kk/Vsdruj4l2SN7635izWPT7oPWvWRHuckXUZ2fa3bY8kmf9305X4Tkk0+3rSi3wnJ8/c/9/Yz05Ind39svUd/+zU20iW5cN4SUM0X" +
    "R582Km+0TeO5M38NmtsZS6ZvFpcVpR+XlKV13sva+Pi19d/+pceUnpZk3iw8tfP7pvGXPP6FuTNlZJ9lq25fV58srvFkee+npTVuLe7Xl6X9vm1Z7Yt15y0x" +
    "2OCBBsMaTEmGNR/6z6F3LPjc8VnmL8U4osHwvF+RjPhkeOv3JyUHTvvOe4c0S3pktTVXn5msO2O9/Xvul3ycceeNvcrnkpXtdcvnnv/tffVSG48BAOBrIIAF" +
    "AMBy5ZNffzJ8/HeSujXq2tU1TkrnLa1Xvnn5b5u9kcx5dE7vOZm3hELvJMlPkqRsu7IBZT9KHv2/h9956Mi539ivv7DACXyYnRf+j+ednti1w+5vJaXXlU4o" +
    "XSN5aN8HZty3UfLqFi9v/9L5Sf72n13b56UkyZ+SZLPH2ty01b+S3J+3c3LxesxfKuLSSy/M+efrj0XWZwn0wZc167lZJ8/cIMlO2SFJWvyiRVWLPeZtvOuL" +
    "j2/bvO3d7TZIOt7d+dzOnZNxw8Y2+ujYZOadM2fM3G/eTusnFcMrDms1dwmq/8sqX+LE5i1N2frBNnu07pukXX6awcmURydvPPm5JI2W0vN9/fEnfjwi+STj" +
    "8/GpyfMVz671TJKyk8vuLvsgWXfGenv13C/ZrXTPH31z12SzNpvfvuVpyeAnXrj8+QOTynlLay0p9ZfUX5CfJfl9km2+/HEtp1Qc2/LpJN2zXyYuub6ZdPzE" +
    "Fyfuuxied/vMnDHzzhWvH42Pi3d8/LpUrVI1tOqmJEmn/F/SvF2Ln7YYnGT6lzu+1ZDW32o1KMk+uT7TVry6LbbXoXdnnjHj+uW3LsatlWuc2Xa77QbsMC2p" +
    "OKDVu622TSafPanFxG8mY1qOXmv0j7/CDV2SC/KzZNSaH7b74OKkx36rrbl6kqZvlPcoP3juUyZbrTyfS7xuqY/xGACAlV2pEgAAsFyZ94eO6tHVD1RfveDX" +
    "DTZquH+Dkxb8PPPIGXUz/plMeXRy78nPJWUvzp3Rosc1q/199dO/+G4alTfaptExyXFHnFT7g38mJ9z7g6NOWScp227u0iNN92x6bfmwpPl1zUub75XUvF5z" +
    "e83lyWvrvHLxy/t88e13/EbHlh2v93Aubou7D76q+X+ortm9Zt2aVknbq9r1a3dn0nrj1s+02fSLj992wx3223FS8o0H99pjn82SVoNbHdD64WTc3mPPGzt2" +
    "we123LJTg07Xfvnb7Xpgt290b5g0b9f8py0GJzN+PL3J9PuTiTMm7j3hjcX/OM0/39NOO/PMn/402Xv2vrfs//fP3n/+DBRvDXnzgDe2Tsa9PbbxR8cmJZNK" +
    "ZpXUJM3uata82b5Lvt+q5y8dM0/TN5v2aHrwFx+3xl5rnrf2MUu+bxaX5b0fjY9LZ3z8unzSefyR499b8H6hw9C5M2U2PrnxnU1GfvHxa/9qneHrDVtx67a4" +
    "xpPlvi7GrZVqnBlTMXqtUQsFrTbep/eMTTb8H97H3N3pnM6dF/w8dY0pN07Z3ucSr1vqYzwGAGBlI4AFAMByqfrEOVvPWegPHY2uaPR0o3Gf3m/weS8++PxR" +
    "C37evumO2+w8Jim/s1nzZvt9ev8m8wITezXf9+79b1vwH7dvDX7jgNe3XhD8mHNCdf85nRb83GDDBvs3OClpe367Xu3+8dnn3ev3G3bdaJtknZ+u90bPN5d+" +
    "HevuqP193aULfm54ZaOnFlXH5d3i6oOvav5SIG8OfH30a0/mP9/Q3qFq5767fJCU3T93KZz/tn7fXv/Y4Olkza3XOn3tIxbMfDbyuJHfHnFJUn3i3H6cf7vz" +
    "g0i7XLd76Z4vJY2rGvdtfMRnX+f8+1+oXg89f9SSWxpt/I3jx40/NKnsVTmy8uZkjWfXql57dNK5wypTVvmcJUc6rdt5Tudrkg5Pd7y4U7dkdpPZQ2b/KZm8" +
    "y+T7Ju++5Pt80oeTdpq40AwBvf6xwdob7ZA07Npw94bHLbTjvMd90xM223rz3yVdR3Z7rdtFS75vFld9lvd+XN591cdzWRkfvy6V91YePWvdZMRZw7/3/mVJ" +
    "wyvmXn///bYbuP3MBc+f/9a9z6qb96hN+tzX96hN/7b8vK4sK69Dy3tdVrRxa1l7f7es9cULGz2//7OTkrrb635fd2myft8N/rHh08ku1+1esudLSYszWk5q" +
    "ufNnH18xuNUBrQYlu7bb/ew990zWvmGdcev+e8F5vd196KA3717xPpd81b5aXH24or1uLW/Pt8U9vngfCQDA8sxbTgAAlkuzz5296+yuSfO0uLtFkopvVbzT" +
    "un/y0d/GbD+m74L9XnnypY5DhiZdend9ptt9Sc8frr9lr1uSgasf9+cT2yVjd/ro6jEbJqX7lQ4sOy3pWNGxZcet5v3Bdo1kzDWjbx1VmTz1uye+9fj8PzC2" +
    "S2rnfSP3pSsG3/zigKTfqM3v3yLJIVcf+vfvzkrevu7tfkNfSupur/1D7aVJt51W3WHVkqTtpW3btrszeXPHNw5/7fxkg1YbXrPxw8l6x/V8Yf1Xk9k3zT64" +
    "6uXk5UOH3Dx4wOKv47RW066Z2j+pfbx2RO2vkg7pcEXHHyUHX33oRt+dlQy7+u1+b22cvPzmkNUGv7v89svi6oOinnj9sTseaZt0mdp1w26HJmscvuZ5a92U" +
    "HHvRCSef1Cv5uGzcmHFHJ83nLQ3Vflz7Vzo8mNStWdeurkly//fubfuvrZO69Wpb1HZccLuPH/LoJo9clXTu02XzLmcnq/69R3qclRx76olNfvCHZOz4j74x" +
    "5udJTs9ZJeckq1zY5bguDyYNuzY8t+Fxyfvr/XvOex2TIf0H3/Xid5NcmXZpsvgfn/p51/XoPx4e8tCqyZ73f7PH3lOSAT86/MojGiRjx3/U6qNJyYwfT286" +
    "7f6k+S9aVLbcPVnlsi7Hd/l+kr/m5ZyTPFB/35P/6jLv+Tlmyff521cN3eytjZOtjut/9DbrJh337HRtp2uT7x9zQuuTb04mnjNhw09+klTUtvplq82TFuUt" +
    "Tmn5XDKk6sVNX/gw6duk3+DNui/5vllc9Vle+3F591Ufz2VtfPy6DHr+gZPvvz055ILDr//etKTPnZsc1fdvSdf1u53QbXjy8THjasY+kVQMrzi81WNJ90Gr" +
    "PtLj3GT0NaNuHfXJvGBkFlpadOfsuPDXGJf3ui2u8WR5r8uKMm4ta+/vlrW++OSGucHvf3a684jbD072HL3X/ftcnWyc3mf0uSvZOL3TJ8mMd2bUzRifzDl3" +
    "9q6zuyVNDm3616bvJeX/KO9Q/mSSI1KXPguCjfd9eM/Od++dTNl18p8WDoKvKJ9LvmpfLa4+XFFft5aX59uSGl+8jwQAYHkkgAUAwHJp2u+ndZ36aNL2lHZX" +
    "tdsg2fyxLW/aqmUy7N/DJgytWhDomL8E0b9Ov/usO89JPmg98poRDycbN+ozfZMNk1UadFm96y1J7bja62rXSiYeP3HLifsmb//fW7u+2Td56dAhE18ckNQd" +
    "UtenbhH/Mf/EIY9t8shVybRtpn08tWfSe0KfN/velvRafYMbNnw8qbqhcmTlLcmIK0acN7xZ8s9z7tj/9rWTyRMn3zfp3qTJoU1aNl0nWb3fGtuteU+yasce" +
    "U1abnbycITcPXgJ1nP8Ho8dOfOTgQX9Jtlhzqxn9L0o6j1ll8ipXJKOuG1X6wfgkmyW5bDlumMXcB1/V/Jma/nrcjRf8uTzZ8tqtf93/hGSds9frs95byapj" +
    "elStNjuZ3W72rrMHJ+/u+k6nYbsnz+//7PefnpWMO2Zso7EdF/F4njtn19ldk5uvuPH1Gy5O+mXz+7don6z7455N1n8t6XpAt9e6z0hq162ZU3NNMmHGJ8PH" +
    "v5G8ecAbJ79+e/LqMa+UvfzyQs+fJeytA9549/VHk+pOc8bN6ZT0uanvIf3+Mm9pnDuTzj1X2WaVw5LZt1QNqbonGTltxL+HH5sMrn2hy/PTkhGXDa96/8Wl" +
    "1+eV284aP+vW5JY5Nz1/4xvJtqfu8NKOxyddj+76w25nJh3/3XFCp6rkk/0+ef+TzZNB2z542APTkqmrT7lhyvZJ3xv6ZbMBS6FvFlN9lvd+XF595cdzGRsf" +
    "vy5THp3Se/JzyQ1P/6nq2t2TrX/R/8xtX0zWeHati9YenfRstn7PDZ6ftzTR48mzRz+94VNzkqH1b132xoPJURm403EvJ9UnVm89b2nRxhm/7L6uLCuvQ8t7" +
    "XVaUcWuZe3+3jPbFu+Pe+dOwm5NxLf4w+prtkz7dNrl80/HJaj9f/fo1TklanTh3pqtmGzbbo9lJSdUeVftW9UhGbfLhFh/+NBl+/fs/fu/q5LVfvlr1yo5J" +
    "1ZWVT1fevPTqsLg/l3zVvlpsfbiCvm4tL8+3JTW+eB8JAMDyqKSiomPHnj3r65VixVRR0aZN69bqAAAAAPBFOl+2yvFdWieHfvzdiiNOSN6YtwTS/Wv868Z/" +
    "PqE+AAAAwP9u6tRJkyZPVocVTakSAAAAALAi2XHAzn/d9ZBkt5I9fvSNXZMGGzbYv8FJX3zcKpetclyXhb7INm7Y2EYfHaueAAAAAHw+ASwAAAAAVijtD+/Q" +
    "qeNNyYY/3rhJ735J3yb9Bm/W/bP3b31Lm+3a3JNs3m+r7lv9IqnZvWbdmlbJe4e/0/mdNdQTAAAAgM/XQAkAAAAAWJE8dccTv3+sWfLtAw/+xoBWyTbZbsAO" +
    "U5J1j+954voDkknHTXhxwr5J0z3Lry1/O+l2dvfnVv1WUvrv0ualVcmDbe4fcO8myYwJM0qnb6qeAAAAAHy+koqKjh179qyvV4oVU0VFmzatW6sDAAAAsPJp" +
    "c1Xbfm3vTDZ7bYvbt2yTdB/U/ZEe5ybN27f4aYvBSdVvq/at6pGMHf9RqzEnJUOqXtz0hQ+TD7/9wTdHXqB+AAAAwNdv6tRJkyZPVocVjQDWCk4ACwAAAAAA" +
    "AABg2SCAtWIqVQIAAAAAAAAAAIBiBLAAAAAAAAAAAAAKEsACAAAAAAAAAAAoSAALAAAAAAAAAACgIAEsAAAAAAAAAACAggSwAAAAAAAAAAAAChLAAgAAAAAA" +
    "AAAAKEgACwAAAAAAAAAAoCABLAAAAAAAAAAAgIIEsAAAAAAAAAAAAAoSwAIAAAAAAAAAAChIAAsAAAAAAAAAAKAgASwAAAAAAAAAAICCBLAAAAAAAAAAAAAK" +
    "EsACAAAAAAAAAAAoSAALAAAAAAAAAACgIAEsAAAAAAAAAACAggSwAAAAAAAAAAAAChLAAgAAAAAAAAAAKEgACwAAAAAAAAAAoCABLAAAAAAAAAAAgIIEsAAA" +
    "AAAAAAAAAAoSwAIAAAAAAAAAAChIAAsAAAAAAAAAAKAgASwAAAAAAD5qhbcAACD5SURBVAAAAICCBLAAAAAAAAAAAAAKEsACAAAAAAAAAAAoSAALAAAAAAAA" +
    "AACgIAEsAAAAAAAAAACAggSwAAAAAAAAAAAAChLAAgAAAAAAAAAAKEgACwAAAFhqSndvXNrywaRbt+98Z9CgpMntq9yw+fSlf15d9/n2mPuuTFrc07P5QQd9" +
    "enuXafvdffujSct11z/lkD2K30/L6zZ457Ctk87dv9nhxsqvfh4sXuXNu7+1/QtJ+aDVpuzc96tv/7r6BAAAAIBlmwAWAAAAwH+p/MuonZ++Iak5eVrNqMuc" +
    "x8qqvPmqQ7d7IWn28GqTFx3A+vztAAAAAKwcGigBAAAAwP9vYvNnh144OMnwJF2cBwAAAADw2QSwAAAAgGVGWVXTrm3XStp16v+P885MmtR1vqjvJUndwOpO" +
    "s+5OZq4z4v6HWiVTX3vtmD91SPKL+t/Xtlxw/PylDCff9vKYax5MZmz2zpN3/PLT99P2pq13OufPSembja5t/nzyySWPrnba7xZsn7/039Qj31jnxqeT6d8c" +
    "OuNvf/vy11FydoNfNb08adWvzxPHXpqUX9Pt5G2GJdmq5J6SnySVF4765KmPktrGs/869dJ5By0iYPVF5zF/+5QBr9Zfu2bSsFHF8asdlZQf2m3Q1ocnJePL" +
    "Xm40Kqm89aMTXtwhmdT7hW//ap2kvlf10TO2WOh8G5et0+jPSaua3i0HtknKd1n1kh13SNK95OA8nFRuOqbh8/sktTtWXjPpgKTJyM4bbDIk+Xj7+1cdOGLB" +
    "7TRsVHF8j6OTVp17D/z+S0mjo9tdv96WSbrl4JJHktl3j7/itQ+Tyae81Oeq7ZLarWb+YNy9n77u5putdc7ezybNf73OpftUJw0ubfZ+xzeSmlun3TW6UTLt" +
    "G3PrMOuhD05/9NFF1H986cuNRicVx238zSOPTMqv6XbSNm8npbs1Lq14MKm9e9bb42+Z108VybQ2b21/80ZJRuXm7JR0fGz3D36/WtLosFZ3rL5ekptzZtZL" +
    "unX7Tgbtn1S3nPrGB92ShtMq7lh1EdvH9Lrj7/vXJfn7l+uX//V6v9DlJY+X3ZFUPLRh38NnJ83eWW33XabM6//nkuqOUyaPPCiZeuSb69z4TFJ12UdtXrxg" +
    "oeN/XDKwbFrScudeQwY0SprNWu2mXW5Pyh5temybfyQ1o6Yf+dG5yfQnhx1y6x+SmROHlz14zWf387RBb/b9y+ykwbdb7NN1TtJ0265HbH1jUt+hrs+crsmM" +
    "295d765zkqrnxj47uC5p9as+Lx//eNLod23WX7NtUttk1uiJ/06mbPvqzdcOTCqPHfXbJ9czfgIAAABLjyUIAQAAgGVG6x9u8uPjypL6Tep+Wf1OMumvgx/9" +
    "Tedk1oYfDn/8rqTlGesddOCIpPWvNnn5uMeX3eto88/N9v5R16TZeT223mlQMn2Vd75/2yvJ5ItfPOo3hyZl+5T3bP+dpMWv17503+r//f5aXbTRLUevmtTf" +
    "WDOkcv1kfOXD3/vR+GRS2+drLzs+aXp7lxs2n5FU7NxryIDGizjfIzY/7vSLksZPdXqjT0XyyRZPbHVmWTLusPt/8v1rk7qKOc2mn520XG29PQ+49dPHzw88" +
    "tR+zXfeLHkzq9637qObqZOLkZ396QUUyed7jWPaLucGi9ptu0/BneyfploPz8ILbadls/c4HX5a0fqHveSdskVSNGdtjyKBkYotnhl74YlJ1+scjXz02afvQ" +
    "lqed8UjS7Pg1yne/fhH1qOnTYmDrpPz/5tZ/6nVvvndT/+ST3zyx29lbJDO/N+K4hy9OKoZtcNl3702aXbzGkXsOWHD8xBbPDL1wcDL7lfETX78+mTN0Yrt3" +
    "tk0+fuPBEcdflkwsffb+Cy757O11veYcPXOLL37cvq7r/RL9uM8p3ZIWY9e55lsbJzN6vPfrf52cTLr4xaN+fejcx3fG2Um7/bY57PxmC4J0/zn+J/3++IOb" +
    "kpZX9/znt/+YzHx1+K0PvJtMfO2ZNX6+X1I1ZuyqgwclbV7t9/dT3klabLPuXw845nOue14f1japHD3x38n4do88dMrNSeVGHw5/4q6k4qENNjm8Kml/+vYj" +
    "fvH9ZNYRI497+OLk45YPXnFCo2TOgxMHDftZ0vbcLZ46faek5PcNx5XvbfwEAAAAlh4zYAEAAADLjMoffPTACy8kE898psPPxyS5N62SZFZGDBs0JCnpX/p4" +
    "gzuSZietcfeeo5Ipu792zPXPfXpGp6WlwW9bNuh2SlJ+cvfVt9s3mXT8i+f+6vlk5lXvz7q/f5Jk/WyWzOoyauCTuyadb9nzgD8dmaRbSUoeKX6/cx6cOOjt" +
    "85Mp7V4ec83NSZKrkqR6ztSrRm6WNO3XvWH/fZLG73d4aIO/Jhmb5LKk4ccVrVf9W1L+r+7Pb9M2+eSqx879yfPJnNIJZwxtmuSc/CD3JlO6vXTwVT9MmvTt" +
    "2KP33JmNfv//XfcdFYd23ygpu6B8w3bXJdP7PT/10k2T2Qd/3OaVuTMpnZ4k1UdO7T6yPmn59153DmiUlLRtWNts76TkitLSsgeTlo17DRnwXjK9wTv97tgt" +
    "mXLAy8Ou+XmSZOckqczoPJ2k9NxGT7fYOak4odezh52bzGz//un3L3Q+ZU83+02nPZNp671++J9bJDPL3u9331+TJH9Mktn5OC8nadqqy4mbP5A06tl263VH" +
    "JDPzfu5dJ6npO233D9oldb3m/GPG5knJ4Q371rZM5lwyabV3f5fkjXRL5gatZly+iO2/yPOZOzPbHot6vEp3b1za8mu83i/qx2a/XG33nXdLprz4covfnZZM" +
    "7/xO39tfSTJo7j1VNh51wFN/TjpP23vozX9Nmr7e/Tfb/iCpH/rBYXUvJs1OXr16t7WTybcP/uHllycz7vp3v3vuWeh5m9F/eiZJSf+yXzc6KWl5ZK+tDx2U" +
    "TP/1u6fetU6SeYHK+aoOHnfhK7clUw987arrHk9yde5J72TacUP3mnJw0vyltbJXkll//KDbIyXJjI/e6/TPyiQ35uIck0xvMezy29om5c1XXWe7PyeNzmp1" +
    "0Rrjk9n5ZNc37jaOAgAAAEueGbAAAACAZcas1h9c8Pj0z9ne5oMLHp+RlFxe+njZHUmjNVo9s9pqy875N7mkY4/eV+c/MzvNevuD1x47cxE7zls6sbJ6zH7P" +
    "vv2/329V6dgzXjr9s7fXfbdq6uTWSen9Dbdv1mzB7xv37tB2o+8lebb+m/UXJVWvjJ/4+p8WcQPzluab/cr4ia8tYgammpIZj3y0dVJ7/+y6absmbSZuVnrq" +
    "1UmL1dbd81u3Jg0Pa/WT1f+QVL8/ZevhI5KJhz798M++m9TvUf3YzJlJ4706nLhx96TkpdJTG66TzDx35NMP7/zZ11P5+Ojrnz4sKetT/mq765KyPk1fbXfd" +
    "gu0TDnziqrMeT2b0+Pdv7jk5abBFi8ou/ZMmB3a+ctNHkxZj1/nd/r2TBoMrHlj1k6Tkx6UDy6YtuT75uq/3M/vx5o5n9tl/oefPhnNnmPpv9bNr35nz3WRc" +
    "o/tOOPqYZMb+73S5c7ekyS2dzui90PFfeJ79xjR8bp+k9OyGv2p6edKwUav/byat+eZ8b8Idb31zEX368+ofVZ640H43Tb7k/YGLPt/Z313wc8nZDX9Vfrnx" +
    "EwAAAFh6zIAFAAAALDPmB4XS9DO2/2H2X6ZcmqRvdkuSXF76eNmdmTu/0rFf4Y62Krmn9Iwkbyb5GpcuKzux/PwOHZK6zWrOqeqZ1O9Qs1ZVl8/ev/YPVX+Z" +
    "8oskF+eoHPI/1O292nOrbkqyWZJffs6OW5b8q/SMJB/OrXHpMY0HVJyW1H2z5kezeifZpG5c9T6fc75vzT5oWlmSsblt4d/XD6zuNOvuZPypg/Y/+b6k5avr" +
    "H3Nw+6TF1T0nHnRt0uqY3i0HnjZvybn3kumrDdvztluT6SOG3XvbgUnZn5tUtJ6cJBmfJB2n7XLilXOSPJPkwkWeyviMTnJQWqRzUtqy8V4tt0tqU5kJayTN" +
    "Zq120y63JxV/6H3wMZckZcc0PqLinKR2p6r7prRM5jw1abV3T03qN5hz1IwtknwnF+X2JdfnX/f1fpbSG5pUtJqcpNncgF3tlpX/mvDevI07LaKPdqy6ZvIB" +
    "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" +
    "9YOkxY/W7r3vQjNGzXx1+K0PvJvkztIuDY5P2rbe6udnTUtKd2jwXpPOX7z9i/yv1ztfg/oWO63yTNJ4t7Y7r3vOp7dP3OW5Sy7aMakcPrrqmS5Jq4s2vuWo" +
    "VZM2855fdT+v/lHlSQsel/+eMWzC6k81+b+xyazrRnZ7pDRp8ZO5wbZ2T/T/07mHJk1u7nhm7/2Tiec91/+Sh5PKDT8c/sRdxjMAAABg5VFSUdGxY8+e9fVK" +
    "sWKqqGjTpnVrdQAAAAA+reS+hts3a5Y0atHm8nUaJtUbTl793VOTuoo5zWac/en927+844RfXpfUbDp19w/aJ5Nrhwy+Yi91BAAAAPiypk6dNGnyZHVY0TRQ" +
    "AgAAAICV1KjcUr9T0m6tbUafd3UyZ88Jmw09PpleM6zlbW3nLuVXfdWCGcgaP9JucK9vJlMOeWnE1ZcluTGDFREAAACAlZ0ZsFZwZsACAAAAvkijo9tev96W" +
    "ScVGG/3hiPFJoyltNl97t6Tkx6UDy6Ylcy6YvNH7tyZT1339lD/vmcw++OMLX7ld3QAAAAC+KjNgrZgEsFZwAlgAAAAAAAAAAMsGAawVU6kSAAAAAAAAAAAA" +
    "FCOABQAAAAAAAAAAUJAAFgAAAAAAAAAAQEECWAAAAAAAAAAAAAUJYAEAAAAAAAAAABQkgAUAAAAAAAAAAFCQABYAAAAAAAAAAEBBAlgAAAAAAAAAAAAFCWAB" +
    "AAAAAAAAAAAUJIAFAAAAAAAAAABQkAAWAAAAAAAAAABAQQJYAAAAAAAAAAAABQlgAQAAAAAAAAAAFCSABQAAAAAAAAAAUJAAFgAAAAAAAAAAQEECWAAAAAAA" +
    "AAAAAAUJYAEAAAAAAAAAABQkgAUAAAAAAAAAAFCQABYAAAAAAAAAAEBBAlgAAAAAAAAAAAAFCWABAAAAAAAAAAAUJIAFAAAAAAAAAABQkAAWAAAAAAAAAABA" +
    "QQJYAAAAAAAAAAAABQlgAQAAAAAAAAAAFCSABQAAAAAAAAAAUJAAFgAAAAAAAAAAQEECWAAAAAAAAAAAAAUJYAEAAAAAAAAAABQkgAUAAAAAAAAAAFCQABYA" +
    "AAAAAAAAAEBBAlgAAAAAAAAAAAAFCWABAAAAAAAAAAAUJIAFAAAAAAAAAABQkAAWAAAAAAAAAABAQQJYAAAAAAAAAAAABQlgAQAAAAAAAAAAFCSABQAAAAAA" +
    "AAAAUJAAFgAAAAAAAAAAQEECWAAAAAAAAAAAAAUJYAEAAAAAAAAAABQkgAUAAAAAAAAAAFCQABYAAAAAAAAAAEBBAlgAAAAAAAAAAAAFCWABAAAAAAAAAAAU" +
    "JIAFAAAAAAAAAABQkAAWAAAAAAAAAABAQQJYAAAAAAAAAAAABQlgAQAAAAAAAAAAFCSABQAAAAAAAAAAUJAAFgAAAAAAAAAAQEECWAAAAAAAAAAAAAUJYAEA" +
    "AAAAAAAAABQkgAUAAAAAAAAAAFCQABYAAAAAAAAAAEBBAlgAAAAAAAAAAAAFCWABAAAAAAAAAAAUJIAFAAAAAAAAAABQkAAWAAAAAAAAAABAQQJYAAAAAAAA" +
    "AAAABQlgAQAAAAAAAAAAFCSABQAAAAAAAAAAUJAAFgAAAAAAAAAAQEECWAAAAAAAAAAAAAUJYAEAAAAAAAAAABQkgAUAAAAAAAAAAFCQABYAAAAAAAAAAEBB" +
    "AlgAAAAAAAAAAAAFCWABAAAAAAAAAAAUJIAFAAAAAAAAAABQkAAWAAAAAAAAAABAQQJYAAAAAAAAAAAABQlgAQAAAAAAAAAAFCSABQAAAAAAAAAAUJAAFgAA" +
    "AAAAAAAAQEECWAAAAAAAAAAAAAUJYAEAAAAAAAAAABQkgAUAAAAAAAAAAFCQABYAAAAAAAAAAEBBAlgAAAAAAAAAAAAFCWABAAAAAAAAAAAUJIAFAAAAAAAA" +
    "AABQkAAWAAAAAAAAAABAQQJYAAAAAAAAAAAABQlgAQAAAAAAAAAAFCSABQAAAAAAAAAAUJAAFgAAAAAAAAAAQEECWAAAAAAAAAAAAAUJYAEAAAAAAAAAABQk" +
    "gAUAAAAAAAAAAFCQABYAAAAAAAAAAEBBAlgAAAAAAAAAAAAFCWABAAAAAAAAAAAUJIAFAAAAAAAAAABQkAAWAAAAAAAAAABAQQJYAAAAAAAAAAAABQlgAQAA" +
    "AAAAAAAAFCSABQAAAAAAAAAAUJAAFgAAAAAAAAAAQEECWAAAAAAAAAAAAAUJYAEAAAAAAAAAABQkgAUAAAAAAAAAAFCQABYAAAAAAAAAAEBBAlgAAAAAAAAA" +
    "AAAFCWABAAAAAAAAAAAUJIAFAAAAAAAAAABQkAAWAAAAAAAAAABAQQJYAAAAAAAAAAAABQlgAQAAAAAAAAAAFCSABQAAAAAAAAAAUJAAFgAAAAAAAAAAQEEC" +
    "WAAAAAAAAAAAAAUJYAEAAAAAAAAAABQkgAUAAAAAAAAAAFCQABYAAAAAAAAAAEBBAlgAAAAAAAAAAAAFCWABAAAAAAAAAAAUJIAFAAAAAAAAAABQkAAWAAAA" +
    "AAAAAABAQQJYAAAAAAAAAAAABQlgAQAAAAAAAAAAFCSABQAAAAAAAAAAUJAAFgAAAAAAAAAAQEECWAAAAAAAAAAAAAUJYAEAAAAAAAAAABQkgAUAAAAAAAAA" +
    "AFCQABYAAAAAAAAAAEBBAlgAAAAAAAAAAAAFCWABAAAAAAAAAAAUJIAFAAAAAAAAAABQkAAWAAAAAAAAAABAQQJYAAAAAAAAAAAABQlgAQAAAAAAAAAAFCSA" +
    "BQAAAAAAAAAAUJAAFgAAAAAAAAAAQEECWAAAAAAAAAAAAAUJYAEAAAAAAAAAABQkgAUAAAAAAAAAAFCQABYAAAAAAAAAAEBBAlgAAAAAAAAAAAAFCWABAAAA" +
    "AAAAAAAUJIAFAAAAAAAAAABQkADWCq6+bf2o+unqAAAAAAAAAACwtNS3rR8tv7HiEsBawdV+v2Z0bSt1AAAAAAAAAABYWmqPrRklv7HiEsBawdXsUfPLmiHq" +
    "AAAAAAAAAACwtNTsLr+xIhPAWtGfwC2qd6i+QB0AAAAAAAAAAJYW+Y0VmwDWCq62snZA7W/UAQAAAAAAAABgaamtrD1UfmPFJYC1olu3vra+WVJ9x5xXq1dR" +
    "DgAAAAAAAACAJeU/eY1162vqm6nHikoAayUxe+fKhyq3UQcAAAAAAAAAgCVFXmPlIIC1kqitqz2q9pqk5qzq52rK1AMAAAAAAAAAYHGZn8+Yn9dgxSaAtZKZ" +
    "9d2Zp8zspA4AAAAAAAAAAIuLfMbKRQBrJVPfoe5fdW8ms7494/szW6gHAAAAAAAAAMDXZX4eY34+g5WDANZKqvoPcy6c82FS9Wzlt6peUQ8AAAAAAAAAgKLm" +
    "5y/m5zFYuQhgreRmb1j5p8o1BbEAAAAAAAAAAL6q+XmL+fkLVk4CWCu72tSkJpm9fuUfKntYmhAAAAAAAAAA4IvMz1fMz1vMz1+wchLA4v8zfyq8ae9N2XJq" +
    "l6TmrOrnasrUBQAAAAAAAABYec3PT8zPU1hqkIWVVFR07NizZ329UvB5ykrL/lh2bNJ4UNNdmj6ZNNyv0cYNP1IXAAAAAAAAAGDFU33HnFerV0lm71z5UOU2" +
    "SW1d7VG116gLiyaARTHDShqUzEzKmpbdVPaDpMH0ho82PCtpcH+DUxv0TcquadCtbEpSMrGka4klDQEAAAAAAACAZUB92/pR9dOT2u/XjK5tldTsUfPLmiFJ" +
    "TYvqHaovSGorawfU/ibJuvW19c3Uiy9HAAsAAAAAAAAAAKCgUiUAAAAAAAAAAAAoRgALAAAAAAAAAACgIAEsAAAAAAAAAACAggSwAAAAAAAAAAAAChLAAgAA" +
    "AAAAAAAAKEgACwAAAAAAAAAAoCABLAAAAAAAAAAAgIIEsAAAAAAAAAAAAAoSwAIAAAAAAAAAAChIAAsAAAAAAAAAAKAgASwAAAAAAAAAAICCBLAAAAAAAAAA" +
    "AAAKEsACAAAAAAAAAAAoSAALAAAAAAAAAACgIAEsAAAAAAAAAACAggSwAAAAAAAAAAAAChLAAgAAAAAAAAAAKEgACwAAAAAAAAAAoCABLAAAAAAAAAAAgIIE" +
    "sAAAAAAAAAAAAAoSwAIAAAAAAAAAAChIAAsAAAAAAAAAAKAgASwAAAAAAAAAAICCBLAAAAAAAAAAAAAKEsACAAAAAAAAAAAoSAALAAAAAAAAAACgIAEsAAAA" +
    "AAAAAACAggSwAAAAAAAAAAAAChLAAgAAAAAAAAAAKEgACwAAAAAAAAAAoCABLAAAAAAAAAAAgIIEsAAAAAAAAAAAAAoSwAIAAAAAAAAAAChIAAsAAAAAAAAA" +
    "AKAgASwAAAAAAAAAAICCBLAAAAAAAAAAAAAKEsACAAAAAAAAAAAoSAALAAAAAAAAAACgIAEsAAAAAAAAAACAggSwAAAAAAAAAAAAChLAAgAAAAAAAAAAKEgA" +
    "CwAAAAAAAAAAoCABLAAAAAAAAAAAgIIEsAAAAAAAAAAAAAoSwAIAAAAAAAAAAChIAAsAAAAAAAAAAKAgASwAAAAAAAAAAICCBLAAAAAAAAAAAAAKEsACAAAA" +
    "AAAAAAAoSAALAAAAAAAAAACgIAEsAAAAAAAAAACAggSwAAAAAAAAAAAAChLAAgAAAAAAAAAAKEgACwAAAAAAAAAAoCABLAAAAAAAAAAAgIIEsAAAAAAAAAAA" +
    "AAoSwAIAAAAAAAAAAChIAAsAAAAAAAAAAKCg/wfJ9TftjT24QwAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNC0xOVQyMzoyNzozNyswMDowMGDkx7sAAAAl" +
    "dEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDQtMTlUMjM6Mjc6MzcrMDA6MDARuX8HAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA0LTE5VDIzOjI4OjI3KzAw" +
    "OjAwew0FywAAAABJRU5ErkJggg==";
  const binary = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
  return new Response(binary.buffer, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

async function renderMethodologyPage(env) {
  const canonical = `${BASE_URL}/methodology`;
  const freshness = await getDataFreshness(env);
  const updatedThrough = freshness?.updated_through || null;
  const permitCount = Number(freshness?.permit_count) || 0;
  const title = "Building Seattle Data Methodology & Sources";
  const description =
    "How Building Seattle collects, enriches, groups, and presents public Seattle construction permit data, including refresh timing and known limitations.";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "AboutPage",
        name: title,
        description,
        url: canonical,
        about: { "@type": "Dataset", name: "Building Seattle construction permit data" },
        dateModified: dateOrNull(updatedThrough) || undefined,
      },
      {
        "@type": "Organization",
        name: "Building Seattle",
        url: BASE_URL,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Methodology", item: canonical },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");
  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Methodology" }])}
    <div class="ent-hero">
      <div class="ent-kicker">Data trust</div>
      <h1>Methodology, sources, and limitations</h1>
      <p style="color:var(--text-muted);max-width:72ch;margin:0;">How raw Seattle permit records become the searchable permits, properties, contractors, projects, neighborhoods, and analytical reports published on Building Seattle.</p>
    </div>
    <div class="card"><div class="stat-row">
      ${entStat("Permit records", permitCount ? permitCount.toLocaleString() : "Refreshing")}
      ${entStat("Updated through", updatedThrough ? entDate(updatedThrough) : "Unavailable")}
      ${entStat("Scheduled base ingest", "Daily")}
    </div></div>
    <section class="card">
      <h2>Primary source</h2>
      <p>The base feed is the Seattle Department of Construction and Inspections public building-permit dataset published through Seattle Open Data. Building Seattle reads the official machine-readable feed at <a class="ent-link" href="https://data.seattle.gov/resource/k44w-2dcq.json" rel="external">data.seattle.gov</a>.</p>
      <p>Where SDCI publishes a record-level detail URL, the corresponding permit page links directly to that official record.</p>
    </section>
    <section class="card">
      <h2>Ingest and enrichment</h2>
      <p>A scheduled daily ingest upserts base permit fields. A separate enrichment job retrieves detail-page fields that are not consistently available in the open-data feed, including parcel number, review level, review milestones, contractor license details, housing-unit changes, and fuller descriptions.</p>
      <p>Dates and statuses may change as SDCI reviewers update a record. Page-level “updated through” labels report the newest source-record timestamp included in that result, not the time a reader opened the page.</p>
    </section>
    <section class="card">
      <h2>Derived entities and matching confidence</h2>
      <p>Permits are the evidence records. Address pages come from normalized street addresses. Projects group permits that share an address and have related timing and work signals. Contractor and participant pages use names and license information published on permits.</p>
      <p>Entity grouping is deterministic but inferred. Similar names, shared addresses, incomplete licenses, or changed project descriptions can split one real-world entity into several pages or combine records that later need correction.</p>
    </section>
    <section class="card">
      <h2>Values, units, and completion</h2>
      <p><strong>Declared permit value is not verified project cost.</strong> It can omit land, design, financing, owner-provided work, later changes, or portions filed under related permits.</p>
      <p><strong>A permit record is not a completed project or dwelling.</strong> One property can have several related permits, and applied, issued, active, expired, and completed records represent different stages. Housing-unit fields are presented as reported and can be incomplete or revised.</p>
    </section>
    <section class="card">
      <h2>Analytical classifications</h2>
      <p>Insight pages use documented, reproducible rules over public permit fields. ADU/DADU classifications look for explicit accessory-dwelling language. Commercial and tenant-improvement reports use the inclusion rules printed on each page. These are research views, not official SDCI classifications.</p>
    </section>
    <section class="card">
      <h2>Corrections and reuse</h2>
      <p>Use the official SDCI detail link when a decision depends on a single permit. For bulk research, the <a class="ent-link" href="/data">dataset page</a> and <a class="ent-link" href="/api-docs">public API documentation</a> describe reusable access paths.</p>
    </section>`;
  return new Response(
    renderEntityDoc({ title, description, canonical, jsonLd, noindex: false, body, activeNav: "data" }),
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } },
  );
}

function renderAboutPage() {
  const canonical = `${BASE_URL}/about`;
  const title = "About Building Seattle — Construction Permit Intelligence";
  const description = "Building Seattle tracks construction permits across the Seattle metro area, aggregating public SDCI records into searchable property, contractor, and neighborhood views.";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="robots" content="index,follow">
    <link rel="canonical" href="${canonical}">
    <meta property="og:title" content="About Building Seattle | Seattle Construction Intelligence">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${canonical}">
    <meta name="twitter:card" content="summary">
    <link rel="icon" href="/favicon.ico" sizes="32x32" type="image/png">
    <link rel="manifest" href="/site.webmanifest">
    ${renderDesignTokens()}
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg-alt); color: var(--text); line-height: 1.7; }
        .container { max-width: var(--container-max); margin: 0 auto; padding: 0 1.5rem; }
        .hero { background: linear-gradient(135deg, var(--primary) 0%, #1e293b 100%); color: white; padding: 5rem 0 3rem; margin-bottom: 3rem; }
        .hero h1 { font-size: 2.5rem; font-weight: 800; margin-bottom: 1rem; }
        .hero p { font-size: 1.15rem; opacity: 0.85; max-width: 680px; }
        .content { max-width: 780px; margin: 0 auto; padding-bottom: 4rem; }
        .content h2 { font-size: 1.5rem; font-weight: 700; margin: 2.5rem 0 1rem; color: var(--primary); }
        .content p { color: var(--text-muted); font-size: 1.05rem; margin-bottom: 1.25rem; }
        .content ul { color: var(--text-muted); font-size: 1.05rem; margin: 0 0 1.5rem 1.5rem; }
        .content li { margin-bottom: 0.5rem; }
        .content strong { color: var(--text); }
        .content a { color: var(--accent); font-weight: 600; text-decoration: none; }
        .content a:hover { text-decoration: underline; }
        .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin: 2rem 0; }
        .stat-card { background: var(--bg); border: 1px solid var(--border); border-radius: 1rem; padding: 1.5rem; text-align: center; }
        .stat-card .num { font-size: 2rem; font-weight: 800; color: var(--accent); }
        .stat-card .label { font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem; }
    </style>
</head>
<body>
    ${renderNav("about")}
    <main>
        <section class="hero">
            <div class="container">
                <h1>About Building Seattle</h1>
                <p>Construction permit intelligence for the Seattle metro area — tracking who's building what, where, and with whom.</p>
            </div>
        </section>
        <section class="content">
            <div class="container">
                <h2>What Building Seattle does</h2>
                <p>Building Seattle collects, organizes, and publishes construction permit data from the <strong>Seattle Department of Construction and Inspections</strong>. Every permit — from tenant improvements and residential additions to major commercial projects — is ingested, enriched, and made searchable through a fast, modern web interface.</p>
                <p>The site connects permits to their <strong>addresses, contractors, projects, and neighborhoods</strong>, turning raw city records into structured, linkable pages that help you understand Seattle's construction market at a glance.</p>

                <h2>How the data works</h2>
                <p>Permit records are ingested from public SDCI data feeds and enriched through an automated pipeline that:</p>
                <ul>
                    <li>Normalizes addresses and links permits to property pages</li>
                    <li>Identifies contractors and builds contractor profile pages with project histories</li>
                    <li>Groups related permits into inferred projects</li>
                    <li>Maps permits to Seattle neighborhoods</li>
                    <li>Tracks permit timelines, review cycles, and status changes</li>
                </ul>
                <p>Data is refreshed regularly to reflect new permit applications, issuances, and status updates from SDCI. The <a href="/methodology">methodology and sources page</a> documents refresh timing, entity matching, classifications, and known limitations.</p>

                <h2>What you can do here</h2>
                <ul>
                    <li><strong>Search permits</strong> — Browse live permits by address, neighborhood, type, status, contractor, and project value</li>
                    <li><strong>Research properties</strong> — See every permit filed at a specific address, with total values and active projects</li>
                    <li><strong>Track contractors</strong> — View contractor profiles with permit histories, active projects, and review cycle data</li>
                    <li><strong>Follow neighborhoods</strong> — See which neighborhoods have the most permit activity and which contractors are working there</li>
                    <li><strong>Monitor the market</strong> — Use the <a href="/insights">Insights</a> pages for plan review timelines, permit pipelines, and housing activity</li>
                    <li><strong>Access the API</strong> — Pull permit data programmatically via the <a href="/api-docs">public API</a></li>
                </ul>

                <h2>Coverage</h2>
                <p>Building Seattle covers construction permits within the city of Seattle, Washington, sourced from the Seattle Department of Construction and Inspections public records. The data includes permits across all permit types — commercial, residential, industrial, demolition, and more — spanning from historical records to the most recently filed applications.</p>

                <h2>Get in touch</h2>
                <p>Building Seattle is an independent project. For questions, corrections, or data inquiries, reach out via the site or file an issue on the project repository.</p>

                <div style="display:flex;gap:1rem;margin-top:2.5rem;flex-wrap:wrap;">
                    <a href="/permits" class="btn" style="display:inline-flex;align-items:center;justify-content:center;padding:0.75rem 1.5rem;border-radius:0.5rem;font-weight:600;text-decoration:none;background:var(--accent);color:white;">Browse Live Permits</a>
                    <a href="/insights" class="btn" style="display:inline-flex;align-items:center;justify-content:center;padding:0.75rem 1.5rem;border-radius:0.5rem;font-weight:600;text-decoration:none;background:var(--bg);color:var(--text);border:1px solid var(--border);">View Insights</a>
                </div>
            </div>
        </section>
    </main>
    ${renderFooter()}
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=86400" },
  });
}

const GUMROAD_PRODUCT_URL = "https://buildingseattle.gumroad.com/l/seattle-permits";
const GUMROAD_UTM = "utm_source=buildingseattle&utm_medium=site&utm_campaign=data_page";

async function renderDataPage(env) {
  const canonical = `${BASE_URL}/data`;
  const title = "Seattle Construction Permit Dataset — CSV Download | Building Seattle";
  const description =
    "The complete Building Seattle permit dataset as a ready-to-use CSV: every Seattle construction permit, enriched with parcel numbers, review levels, and contractor licenses. Free 100-row sample.";

  let stats = { permits: 0, contractors: 0, neighborhoods: 0, total_value: 0 };
  try {
    const row = await env.DB.prepare(
      `
      SELECT
        COUNT(*) as permits,
        SUM(value) as total_value,
        COUNT(DISTINCT neighborhood) as neighborhoods,
        COUNT(DISTINCT contractor_id) as contractors
      FROM permits
    `,
    ).first();
    if (row) stats = row;
  } catch (error) {
    console.warn("Data page stats unavailable:", error.message);
  }

  const billions = stats.total_value ? `$${(stats.total_value / 1e9).toFixed(2)}B` : "$12B+";
  const permitCount = stats.permits ? Number(stats.permits).toLocaleString() : "13,000+";
  const contractorCount = stats.contractors ? Number(stats.contractors).toLocaleString() : "2,000+";
  const buyUrl = `${GUMROAD_PRODUCT_URL}?${GUMROAD_UTM}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="robots" content="index,follow">
    <link rel="canonical" href="${canonical}">
    <meta property="og:title" content="Seattle Construction Permit Dataset | Building Seattle">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${canonical}">
    <meta name="twitter:card" content="summary">
    <link rel="icon" href="/favicon.ico" sizes="32x32" type="image/png">
    <link rel="manifest" href="/site.webmanifest">
    ${renderDesignTokens()}
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg-alt); color: var(--text); line-height: 1.7; }
        .container { max-width: var(--container-max); margin: 0 auto; padding: 0 1.5rem; }
        .hero { background: linear-gradient(135deg, var(--primary) 0%, #1e293b 100%); color: white; padding: 5rem 0 3rem; margin-bottom: 3rem; }
        .hero h1 { font-size: 2.5rem; font-weight: 800; margin-bottom: 1rem; }
        .hero p { font-size: 1.15rem; opacity: 0.85; max-width: 680px; }
        .content { max-width: 780px; margin: 0 auto; padding-bottom: 4rem; }
        .content h2 { font-size: 1.5rem; font-weight: 700; margin: 2.5rem 0 1rem; color: var(--primary); }
        .content p { color: var(--text-muted); font-size: 1.05rem; margin-bottom: 1.25rem; }
        .content ul { color: var(--text-muted); font-size: 1.05rem; margin: 0 0 1.5rem 1.5rem; }
        .content li { margin-bottom: 0.5rem; }
        .content strong { color: var(--text); }
        .content a { color: var(--accent); font-weight: 600; text-decoration: none; }
        .content a:hover { text-decoration: underline; }
        .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin: 2rem 0; }
        .stat-card { background: var(--bg); border: 1px solid var(--border); border-radius: 1rem; padding: 1.5rem; text-align: center; }
        .stat-card .num { font-size: 2rem; font-weight: 800; color: var(--accent); }
        .stat-card .label { font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem; }
        .tier-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; margin: 2rem 0; }
        .tier-card { background: var(--bg); border: 1px solid var(--border); border-radius: 1rem; padding: 2rem; }
        .tier-card.featured { border-color: var(--accent); box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
        .tier-card h3 { font-size: 1.25rem; font-weight: 700; color: var(--primary); }
        .tier-card .price { font-size: 2.25rem; font-weight: 800; color: var(--text); margin: 0.5rem 0 1rem; }
        .tier-card ul { margin-left: 1.25rem; }
        .btn { display: inline-flex; align-items: center; justify-content: center; padding: 0.85rem 1.75rem; border-radius: 0.5rem; font-weight: 600; text-decoration: none; font-size: 1rem; }
        .btn-primary { background: var(--accent); color: white !important; }
        .btn-secondary { background: var(--bg); color: var(--text) !important; border: 1px solid var(--border); }
    </style>
</head>
<body>
    ${renderNav("data")}
    <main>
        <section class="hero">
            <div class="container">
                <h1>The Seattle Permit Dataset</h1>
                <p>Everything on this site — ${permitCount} enriched construction permits, ${billions} in project value — exported as a clean, ready-to-analyze CSV. Refreshed monthly, updates free for every buyer.</p>
            </div>
        </section>
        <section class="content">
            <div class="container">
                <div class="stat-grid">
                    <div class="stat-card"><div class="num">${permitCount}</div><div class="label">Permits</div></div>
                    <div class="stat-card"><div class="num">${billions}</div><div class="label">Construction value</div></div>
                    <div class="stat-card"><div class="num">${contractorCount}</div><div class="label">Contractors</div></div>
                    <div class="stat-card"><div class="num">32</div><div class="label">Columns per record</div></div>
                </div>

                <h2>What's in it</h2>
                <p>Every construction permit filed with Seattle SDCI, cleaned and deduplicated, then enriched with data the open data portal doesn't have: <strong>parcel numbers, review levels, full detail-page descriptions, contractor license numbers, review-cycle counts, and housing unit breakdowns</strong>. One UTF-8 CSV that opens in Excel, Google Sheets, pandas, or R — plus a full data dictionary.</p>

                <h2>Try before you buy</h2>
                <p>A <strong>free 100-row sample</strong> with the same 32 columns and real enriched data is available on the product page. If it doesn't have what you need, don't buy the full version. If you do buy and it isn't useful, there's a 14-day no-questions refund.</p>

                <div class="tier-grid">
                    <div class="tier-card">
                        <h3>Foundation</h3>
                        <div class="price">$49</div>
                        <ul>
                            <li>Full CSV — every permit, 32 columns</li>
                            <li>Complete data dictionary</li>
                            <li>Free monthly updates via Gumroad</li>
                        </ul>
                        <p style="margin-top:1.5rem;"><a class="btn btn-secondary" href="${buyUrl}&utm_content=foundation" rel="noopener">Get Foundation</a></p>
                    </div>
                    <div class="tier-card featured">
                        <h3>Pro</h3>
                        <div class="price">$89</div>
                        <ul>
                            <li>Everything in Foundation</li>
                            <li>Python refresh script (stdlib-only)</li>
                            <li>Contractor CSV — licenses, specialties, permit counts, total values</li>
                            <li>Free monthly updates via Gumroad</li>
                        </ul>
                        <p style="margin-top:1.5rem;"><a class="btn btn-primary" href="${buyUrl}&utm_content=pro" rel="noopener">Get Pro</a></p>
                    </div>
                </div>

                <h2>Who it's for</h2>
                <ul>
                    <li><strong>Material suppliers</strong> — find active job sites by neighborhood before your competitors do</li>
                    <li><strong>General contractors</strong> — see who's winning bids and which subs are active</li>
                    <li><strong>Developers</strong> — size the construction pipeline in any Seattle neighborhood</li>
                    <li><strong>Underwriters, journalists, researchers</strong> — license data, project values, and processing times with a paper trail to the source</li>
                </ul>

                <h2>Why pay for public data?</h2>
                <p>The raw records are public — the work isn't. The city publishes permits piecemeal through a clunky portal, without contractor licenses, parcel numbers, review levels, or detailed descriptions. Our pipeline scrapes, cleans, deduplicates, and enriches every record so you don't spend a weekend doing it yourself.</p>

                <div style="display:flex;gap:1rem;margin-top:2.5rem;flex-wrap:wrap;">
                    <a href="${buyUrl}" class="btn btn-primary" rel="noopener">Get the Dataset</a>
                    <a href="/permits" class="btn btn-secondary">Browse the Data Live</a>
                </div>
            </div>
        </section>
    </main>
    ${renderFooter()}
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" },
  });
}

function render404(options) {
  const heading = options?.heading || "Page not found";
  const message =
    options?.message ||
    "The page you are looking for does not exist or has been moved. Try browsing live permits or return to the homepage.";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(heading)} | Building Seattle</title>
    <meta name="description" content="${escapeHtml(message)}">
    <meta name="robots" content="noindex">
    <link rel="canonical" href="${BASE_URL}/">
    <link rel="icon" href="/favicon.ico" sizes="32x32" type="image/png">
    <link rel="manifest" href="/site.webmanifest">
    ${renderDesignTokens()}
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg-alt); color: var(--text); line-height: 1.6; display: flex; flex-direction: column; min-height: 100vh; }
        .container { max-width: var(--container-max); margin: 0 auto; padding: 0 1.5rem; }
        main { flex: 1; }
        .error-section { padding-top: 8rem; padding-bottom: 6rem; text-align: center; }
        .error-section h1 { font-size: 6rem; font-weight: 800; color: var(--accent); margin-bottom: 1rem; line-height: 1; }
        .error-section h2 { font-size: 1.5rem; font-weight: 700; margin-bottom: 1rem; color: var(--primary); }
        .error-section p { color: var(--text-muted); margin-bottom: 2rem; max-width: 500px; margin-left: auto; margin-right: auto; }
        .btn { display: inline-flex; align-items: center; justify-content: center; padding: 0.75rem 1.5rem; border-radius: var(--radius-sm); font-weight: 600; text-decoration: none; transition: all 0.2s; border: none; cursor: pointer; font-size: 0.875rem; }
        .btn-primary { background: var(--accent); color: white; }
        .btn-primary:hover { background: var(--accent-hover); }
        .btn-secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); margin-left: 0.5rem; }
        .btn-secondary:hover { background: var(--border); }
    </style>
</head>
<body>
    ${renderNav()}
    <main>
      <section class="error-section">
          <div class="container">
              <h1>404</h1>
              <h2>${escapeHtml(heading)}</h2>
              <p>${escapeHtml(message)}</p>
              <div>
                  <a href="/" class="btn btn-primary">Return Home</a>
                  <a href="/permits" class="btn btn-secondary">Browse Permits</a>
              </div>
          </div>
      </section>
    </main>
    ${renderFooter()}
</body>
</html>`;

  return new Response(html, {
    status: 404,
    headers: { "Content-Type": "text/html" },
  });
}
