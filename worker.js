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
import { countedValueSql, countedValues } from "./value_counting.js";
import { bsIcon, bsStatusPill, bsTransition, themeBootScript, themeToggleButton, themeToggleStyles, themedLockup } from "./brand_ui.js";
import { handleMcpRequest, MCP_TOOLS } from "./mcp.js";
import { getBasisResetRadar, ingestBasisResetEvent, renderBasisResetRadar } from "./basis_reset_routes.js";
import {
  developmentSiteJoin, developmentSiteColumns, withDevelopmentSiteFields,
  ingestDevelopmentSites, getDevelopmentSiteGeometry, renderDevelopmentSiteCard, DEVELOPMENT_SITE_SCHEMA, developmentSitesArePublic,
} from "./development_sites.js";

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

// --- Template-wide HTML edge caching --------------------------------------
// Worker responses bypass Cloudflare's edge cache unless a Cache Rule exists.
// While the owner's dashboard Cache Rule (drafted 2026-08-16) is not yet live,
// this layer serves warm public HTML pages straight from the edge cache,
// skipping Worker execution and D1 lookups entirely — the dominant LCP cost on
// mobile (cold Worker start + D1 query + 900KB script transfer per hit).
// Keyed by URL with a version prefix: bump HTML_CACHE_VERSION after any
// template change so stale entries are bypassed.
const HTML_CACHE_VERSION = "v10";
const HTML_CACHE_EXCLUDED_PREFIXES = [
  "/api/", "/admin", "/ingest/", "/leads", "/alerts",
  "/social/", "/icons/", "/.well-known/", "/openapi", "/api-docs",
  "/robots.txt", "/sitemap", "/favicon", "/og-image", "/site.webmanifest",
  "/409508639a064e738971e5aa92be599e.txt",
];

// Public GET HTML pages are edge-cacheable; API/admin/ingest/auth/asset paths
// are not (they are dynamic, credentialed, or binary).
export function isHtmlCacheablePath(path) {
  return !HTML_CACHE_EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// TTL for a cached HTML copy: honor the page's own max-age (permit/address
// pages say 3600, insight pages 300), clamped to [60, 86400] seconds.
export function htmlCacheTtl(response) {
  const cc = response?.headers?.get("Cache-Control") || "";
  const match = cc.match(/max-age=(\d+)/);
  const ttl = match ? Number(match[1]) : 3600;
  return Math.max(60, Math.min(Number.isFinite(ttl) ? ttl : 3600, 86400));
}

function edgeHtmlCache() {
  return typeof caches !== "undefined" && caches.default ? caches.default : null;
}

// Wraps the route handler: serve warm pages from the edge cache, and store
// freshly rendered 200 text/html pages back into it. Content-negotiated
// markdown responses and non-GET requests are never cached. The version is
// encoded as a query param on the cache key (the Cache API matches on the
// full URL) so template changes can invalidate by bumping HTML_CACHE_VERSION.
async function withHtmlEdgeCache(request, env, ctx, render) {
  const url = new URL(request.url);
  const path = url.pathname;
  const cacheable =
    request.method === "GET" && isHtmlCacheablePath(path) && !wantsMarkdown(request);
  const cache = cacheable ? edgeHtmlCache() : null;
  const key = cache
    ? (() => {
        const keyUrl = new URL(url.toString());
        keyUrl.searchParams.set("__bsv", HTML_CACHE_VERSION + (developmentSitesArePublic(env) ? "" : "-sites-off"));
        return new Request(keyUrl.toString(), { method: "GET" });
      })()
    : null;

  if (cache && key) {
    const hit = await cache.match(key);
    if (hit) {
      ctx?.waitUntil?.(logPageView(request, env, path));
      return hit;
    }
  }

  const response = await render();

  if (cache && key && response?.status === 200) {
    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.includes("text/html")) {
      const ttl = htmlCacheTtl(response);
      const headers = new Headers(response.headers);
      // Advertise edge-cache eligibility (s-maxage) so the owner's dashboard
      // Cache Rule, once deployed, honors the same TTL; also store the copy.
      headers.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl}`);
      const upgraded = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      ctx?.waitUntil?.(cache.put(key, upgraded.clone()));
      return upgraded;
    }
  }
  return response;
}

export default {
  async fetch(request, env, ctx) {
    return withHtmlEdgeCache(request, env, ctx, async () => {
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
        const authError = await requireAdminAuth(request, env);
        if (authError) return secure(authError);
        return secure(await renderAdminDashboard(request, env));
      }

      if (path === "/leads" && request.method === "POST") {
        return secure(await handleLeadCapture(request, env));
      }

      if (path === "/leads/batch" && request.method === "POST") {
        const authError = await requireIngestAuth(request, env);
        if (authError) {
          return secure(authError);
        }
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

      const siteGeometryMatch = path.match(/^\/api\/development-sites\/([^/]+)\/geometry$/);
      if (siteGeometryMatch && request.method === "GET") {
        if (!developmentSitesArePublic(env)) return secure(new Response(JSON.stringify({ error: "Boundary unavailable" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
        }));
        return secure(await getDevelopmentSiteGeometry(decodeURIComponent(siteGeometryMatch[1]), env));
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

      if (path === "/api/basis-reset") {
        return secure(await getBasisResetRadar(request, env));
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

      if (path === "/insights/basis-reset") {
        ctx.waitUntil(logPageView(request, env, "/insights/basis-reset"));
        try {
          return secure(await renderBasisResetRadar(env));
        } catch (error) {
          console.error("basis-reset render failed:", error);
          return secure(renderBasisResetUnavailable());
        }
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
        const authError = await requireAdminAuth(request, env);
        if (authError) return secure(authError);
        const stats = await getAdminStats(env);
        return secure(
          new Response(JSON.stringify(stats), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }),
        );
      }

      if (path === "/api/admin/analytics") {
        const authError = await requireAdminAuth(request, env);
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
        const authError = await requireAdminAuth(request, env);
        if (authError) return secure(authError);
        // 200 only when every permit ended up linked; a failed or partial
        // rebuild is a 500 so a curl/CI caller cannot mistake it for success.
        let body;
        try {
          body = await runLoggedEntityGraphRebuild(env, "admin");
        } catch (error) {
          body = { ok: false, error: String(error?.message || error) };
        }
        return secure(
          new Response(JSON.stringify(body, null, 2), {
            status: body.ok ? 200 : 500,
            headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
          }),
        );
      }

      if (path === "/admin/entity-report") {
        const authError = await requireAdminAuth(request, env);
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

      if (path === "/ingest/development-sites/batch" && request.method === "POST") {
        const authError = await requireIngestAuth(request, env);
        if (authError) return secure(authError);
        return secure(await ingestDevelopmentSites(request, env));
      }

      if (path === "/ingest/basis-reset" && request.method === "POST") {
        const authError = await requireIngestAuth(request, env);
        if (authError) return secure(authError);
        return secure(await ingestBasisResetEvent(request, env));
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

      if (path === "/llms.txt") {
        return secure(renderLlmsTxt());
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
    });
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
  `<${BASE_URL}/llms.txt>; rel="llms-txt"; type="text/plain"`,
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

// Display helper: SDCI source text arrives in ALL CAPS ("2704 S HINDS ST,
// SEATTLE, WA"). Render title case for readability while keeping directionals,
// unit types, and common business suffixes uppercase.
const TITLECASE_KEEP_UPPER = new Set(["NE", "NW", "SE", "SW", "N", "S", "E", "W", "LLC", "LLP", "INC", "CO", "USA", "US", "WA", "ADU", "DADU", "HVAC", "IID", "IV", "III", "II"]);
function countLabel(count, singular, plural) {
  const n = Number(count) || 0;
  const word = new Intl.PluralRules("en-US").select(n) === "one" ? singular : plural;
  return `${n.toLocaleString("en-US")} ${word}`;
}

function smartTitleCase(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\b[a-z][a-z0-9&.'/()-]*/g, (word) => {
      const upper = word.toUpperCase();
      if (TITLECASE_KEEP_UPPER.has(upper)) return upper;
      return word.replace(/(^|[\s/('-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
    });
}

function truncateMetaDescription(value, maxLength = 165) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const candidate = text.slice(0, maxLength - 1);
  const lastSpace = candidate.lastIndexOf(" ");
  const shortened = lastSpace >= Math.floor(maxLength * 0.7) ? candidate.slice(0, lastSpace) : candidate;
  return shortened.replace(/[,:;.!?\s]+$/, "") + "…";
}

const PERMIT_TYPE_LABELS = {
  commercial: "Commercial Construction",
  residential: "Residential Construction",
  industrial: "Industrial Construction",
  demolition: "Demolition",
  other: "General Construction",
  new: "New Construction",
  alteration: "Alteration/Repair",
  repair: "Repair",
};

function permitTypeLabel(type) {
  const value = cleanFeedText(type);
  if (!value) return "General Construction";
  return PERMIT_TYPE_LABELS[value.toLowerCase()] || `${value.charAt(0).toUpperCase()}${value.slice(1).toLowerCase()}`;
}

function permitDescriptionText(permit) {
  return cleanFeedText(permit?.detailed_description) || cleanFeedText(permit?.description) || "";
}

// Keep the source's most useful project/tenant phrase near the start of SERP
// titles and first-screen summaries without inventing a project name.
function permitSearchDescriptor(permit) {
  const text = permitDescriptionText(permit);
  if (!text) return "";
  const clause = text.split(/\s+(?:on|per|subject to)\s+/i)[0].trim();
  let descriptor = truncateMetaDescription(clause || text, 84).replace(/[,:;.!?\s]+$/, "");
  const trailingParenthetical = descriptor.match(/\s+\(([^()]{2,60})\)$/);
  if (trailingParenthetical) {
    const repeatedName = trailingParenthetical[1].trim();
    const withoutParenthetical = descriptor.slice(0, trailingParenthetical.index).trim();
    if (
      withoutParenthetical.localeCompare(repeatedName, undefined, { sensitivity: "accent" }) === 0 ||
      withoutParenthetical.toLocaleLowerCase().startsWith(`${repeatedName.toLocaleLowerCase()} `)
    ) {
      descriptor = withoutParenthetical;
    }
  }
  return descriptor;
}

function isGenericPermitDescriptor(value) {
  return /^(allow|construct|demolish|install|alter|change|repair|remove|establish|replace|permit)\b/i.test(value || "");
}

function featuredAddressPermit(permits) {
  const rows = (permits || [])
    .map((permit) => ({ permit, descriptor: permitSearchDescriptor(permit) }))
    .filter(({ descriptor }) => descriptor);
  return rows.find(({ descriptor }) => !isGenericPermitDescriptor(descriptor)) || rows[0] || null;
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

const ACCESS_CERTS_CACHE = { fetchedAt: 0, keys: null, promise: null };
const ACCESS_CERTS_TTL_MS = 60 * 60 * 1000;

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return atob(base64);
}

function base64UrlBytes(value) {
  const binary = base64UrlDecode(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function fetchAccessCertKeys(env) {
  const teamDomain = String(env.CF_ACCESS_TEAM_DOMAIN || "").trim();
  if (!teamDomain) return null;
  if (ACCESS_CERTS_CACHE.keys && Date.now() - ACCESS_CERTS_CACHE.fetchedAt < ACCESS_CERTS_TTL_MS) {
    return ACCESS_CERTS_CACHE.keys;
  }
  if (!ACCESS_CERTS_CACHE.promise) {
    ACCESS_CERTS_CACHE.promise = (async () => {
      try {
        const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
          headers: { "User-Agent": "BuildingSeattle-Worker" },
        });
        if (!response.ok) return null;
        const data = await response.json();
        const keys = Array.isArray(data?.keys) ? data.keys : [];
        ACCESS_CERTS_CACHE.keys = keys;
        ACCESS_CERTS_CACHE.fetchedAt = Date.now();
        return keys;
      } catch {
        return null;
      } finally {
        ACCESS_CERTS_CACHE.promise = null;
      }
    })();
  }
  return ACCESS_CERTS_CACHE.promise;
}

// Verify a Cloudflare Access JWT (RS256) against the team's published signing
// keys. Returns the decoded payload only when the signature, audience,
// issuer, and expiry all check out; returns null otherwise. Requires
// CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD to be configured, so a bare
// CF-Access-Jwt-Assertion header is never treated as authentication.
async function verifyAccessJwt(token, env) {
  const teamDomain = String(env.CF_ACCESS_TEAM_DOMAIN || "").trim();
  const audience = String(env.CF_ACCESS_AUD || "");
  if (!token || !teamDomain || !audience) return null;

  const parts = String(token).split(".");
  if (parts.length !== 3) return null;

  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]));
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }

  if (typeof payload?.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
  if (payload.iss && payload.iss !== `https://${teamDomain}`) return null;
  const audMatches = audience === payload.aud || (Array.isArray(payload.aud) && payload.aud.includes(audience));
  if (!audMatches) return null;

  let keys = await fetchAccessCertKeys(env);
  let key = (keys || []).find((candidate) => candidate.kid === header.kid);
  if (!key) {
    // One stale-cache refresh attempt before rejecting an unknown key id.
    ACCESS_CERTS_CACHE.keys = null;
    ACCESS_CERTS_CACHE.fetchedAt = 0;
    keys = await fetchAccessCertKeys(env);
    key = (keys || []).find((candidate) => candidate.kid === header.kid);
  }
  if (!key) return null;

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: key.kty, n: key.n, e: key.e, kid: key.kid, alg: key.alg || "RS256", use: key.use || "sig" },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      cryptoKey,
      base64UrlBytes(parts[2]),
      data,
    );
    return valid ? payload : null;
  } catch {
    return null;
  }
}

async function requireAdminAuth(request, env) {
  const jwt = request.headers.get("CF-Access-Jwt-Assertion");
  if (jwt && (await verifyAccessJwt(jwt, env))) {
    return null;
  }

  const configuredToken = env.ADMIN_API_TOKEN;
  if (configuredToken && (await timingSafeEqualString(request.headers.get(ADMIN_TOKEN_HEADER), configuredToken))) {
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
        /* Legacy page variables, aliased to the design-system tokens in
           /brand/tokens.css so every template follows [data-theme]. */
        --primary: var(--ink);
        --bg: var(--surface);
        --bg-alt: var(--surface-alt);
        --text: var(--ink);
        --text-muted: var(--ink-muted);
        --text-subtle: var(--ink-muted);
        --border: var(--line-subtle);
        --warn: var(--warning);
        --danger-solid: var(--danger);
        --steel: var(--ink-secondary);
        --radius-sm: 0.5rem;
        --radius-md: 0.75rem;
        --radius-lg: 1rem;
        --shadow-sm: var(--shadow-1);
        --shadow-md: 0 14px 45px rgba(11,41,69,0.06);
        --shadow-lg: var(--shadow-2);
        --shadow: var(--shadow-1);
        --container-max: 1200px;
        color-scheme: light;
      }
      [data-theme="dark"] { color-scheme: dark; --shadow-md: var(--shadow-2); }
      html { scroll-padding-block-start: 5rem; }
      .global-nav { position: fixed; top: 0; left: 0; right: 0; background: rgba(255,255,255,0.9); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); z-index: 50; }
      [data-theme="dark"] .global-nav { background: rgba(8,24,42,0.9); }
      :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .global-nav-row { height: 4rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
      .global-nav .logo { font-weight: 800; font-size: 1.25rem; color: var(--ink); text-decoration: none; display: flex; align-items: center; gap: 0.5rem; }
      .global-nav .logo { min-width: 0; flex: 0 1 auto; }
      .global-nav .logo img { display: block; height: auto; max-height: 24px; width: auto; max-width: 100%; }
      @media (max-width: 380px) { .global-nav-row, .global-nav-end { gap: 0.5rem; } }
      .global-nav-links { display: none; gap: 1.75rem; align-items: center; }
      .global-nav-links a { color: var(--ink-muted); text-decoration: none; font-weight: 500; font-size: 0.875rem; }
      .global-nav-links a:hover, .global-nav-links a.active { color: var(--link); }
      .global-nav-end { display: flex; align-items: center; gap: 0.75rem; }
      .global-nav-hamburger { display: block; background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--ink); padding: 0.25rem; }
      ${themeToggleStyles()}
      @media (min-width: 768px) {
        .global-nav-links { display: flex; }
        .global-nav-hamburger { display: none; }
      }
      @media (max-width: 767px) {
        .global-nav-links.open { display: flex; position: absolute; top: 4rem; right: 1rem; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 0.5rem 1rem; flex-direction: column; min-width: 180px; box-shadow: var(--shadow-sm); backdrop-filter: blur(12px); }
      }
      .global-nav-spacer { height: 4rem; }
      .global-footer { background: var(--bg-alt); border-top: 1px solid var(--border); padding: 3rem 0; color: var(--text-muted); font-size: 0.875rem; margin-top: 4rem; }
      .global-footer-row { display: flex; flex-direction: column; gap: 1rem; align-items: center; text-align: center; max-width: var(--container-max); margin: 0 auto; padding: 0 1.5rem; }
      @media (min-width: 768px) { .global-footer-row { flex-direction: row; justify-content: space-between; text-align: left; } }
      .global-footer a { color: var(--text-muted); text-decoration: none; }
      .global-footer a:hover { color: var(--accent); }
      .skip-link { position: absolute; left: -9999px; top: 0; z-index: 100; background: var(--brand-navy); color: #fff; padding: 0.65rem 1rem; border-radius: 0 0 var(--radius-sm) 0; font-weight: 700; text-decoration: none; }
      .skip-link:focus { left: 0; color: #fff; }
    </style>`;
}

function renderNav(activePage) {
  // One nav across every template; each entry lists the activePage keys that
  // highlight it (legacy "explore" key now maps to Neighborhoods).
  const items = [
    { href: "/permits", label: "Permits", keys: ["permits"] },
    { href: "/contractors", label: "Contractors", keys: ["contractors"] },
    { href: "/neighborhoods", label: "Neighborhoods", keys: ["neighborhoods", "explore"] },
    { href: "/insights", label: "Insights", keys: ["insights"] },
    { href: "/data", label: "Data", keys: ["data"] },
    { href: "/api-docs", label: "API", keys: ["api"] },
  ];
  const link = ({ href, label, keys }) =>
    `<a href="${href}"${keys.includes(activePage) ? ' class="active"' : ""}>${label}</a>`;
  return `<nav class="global-nav" id="global-nav" onkeydown="if(event.key==='Escape'){var l=document.getElementById('global-nav-links');if(l.classList.contains('open')){l.classList.remove('open');var b=this.querySelector('.global-nav-hamburger');b.setAttribute('aria-expanded','false');b.focus();}}">
      <div class="container global-nav-row">
        <a href="/" class="logo">${themedLockup("Building Seattle")}</a>
        <div class="global-nav-end">
          <div class="global-nav-links" id="global-nav-links">
          ${items.map(link).join("\n          ")}
          </div>
          ${themeToggleButton()}
          <button class="global-nav-hamburger" onclick="this.setAttribute('aria-expanded',String(document.getElementById('global-nav-links').classList.toggle('open')))" aria-label="Menu" aria-expanded="false" aria-controls="global-nav-links">&#9776;</button>
        </div>
      </div>
    </nav>`;
}

function renderFooter() {
  return `<footer class="global-footer">
      <div class="global-footer-row">
        <div>Building Seattle &mdash; Seattle construction intelligence</div>
        <div><a href="/about">About</a> &middot; <a href="/contractors">Contractors</a> &middot; <a href="/neighborhoods">Neighborhoods</a> &middot; <a href="/projects">Projects</a> &middot; <a href="/addresses">Addresses</a> &middot; <a href="/insights">Insights</a> &middot; <a href="/data">Dataset</a> &middot; <a href="/methodology">Methodology</a> &middot; <a href="/api-docs">API</a> &middot; <a href="https://buildingseattle.gumroad.com/l/seattle-permits?utm_source=buildingseattle&utm_medium=site&utm_campaign=footer" rel="noopener">Buy the dataset</a></div>
      </div>
    </footer>`;
}

// ===========================================================================
// Homepage ("/") — task-first landing page shared by the HTML and Markdown
// representations. This is the single source of truth for the root route: the
// retired duplicate homepage template (and its lead-capture modal) was removed
// so homepage SEO/metadata edits can no longer land on a template that never
// ships.
// ===========================================================================

function compactNumber(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1e9) return `${(number / 1e9).toFixed(number >= 10e9 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/, "")}B`;
  if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(number >= 10e6 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/, "")}M`;
  if (Math.abs(number) >= 1e3) return `${(number / 1e3).toFixed(number >= 10e3 ? 0 : 1).replace(/\.0$/, "")}K`;
  return Math.round(number).toLocaleString("en-US");
}

function compactMetricMoney(value) {
  return `$${compactNumber(value)}`;
}

function parseUtcDate(value) {
  if (!value) return null;
  const source = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(source)
    ? `${source.replace(" ", "T")}Z`
    : source;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value, includeTime = false) {
  const date = parseUtcDate(value);
  if (!date) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: includeTime ? undefined : "numeric",
    hour: includeTime ? "numeric" : undefined,
    minute: includeTime ? "2-digit" : undefined,
    timeZone: "America/Los_Angeles",
  }).format(date);
}
function humanize(value, fallback = "Permit") {
  const text = String(value || fallback)
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .trim();
  return text ? text.replace(/\b\w/g, (letter) => letter.toUpperCase()) : fallback;
}

async function dbFirst(env, sql, binds = []) {
  try {
    if (!env?.DB?.prepare) return null;
    const statement = env.DB.prepare(sql);
    return binds.length ? await statement.bind(...binds).first() : await statement.first();
  } catch (error) {
    console.warn("Building Seattle homepage query failed:", error?.message || error);
    return null;
  }
}

async function dbAll(env, sql, binds = []) {
  try {
    if (!env?.DB?.prepare) return [];
    const statement = env.DB.prepare(sql);
    const payload = binds.length ? await statement.bind(...binds).all() : await statement.all();
    return payload?.results || [];
  } catch (error) {
    console.warn("Building Seattle homepage query failed:", error?.message || error);
    return [];
  }
}

export async function getCanonicalStats(env) {
  const [stats, ingest] = await Promise.all([
    dbFirst(
      env,
      `/* homepage:canonical-stats */
       SELECT
         COUNT(*) AS permits,
         SUM(CASE WHEN lower(COALESCE(status,'')) = 'active' THEN 1 ELSE 0 END) AS active_permits,
         COUNT(DISTINCT CASE WHEN contractor_id IS NOT NULL THEN contractor_id END) AS contractors,
         COUNT(DISTINCT CASE WHEN contractor_id IS NOT NULL AND lower(COALESCE(status,'')) = 'active' THEN contractor_id END) AS active_contractors,
         COALESCE(SUM(${countedValueSql("permits")}), 0) AS total_value,
         MAX(COALESCE(issued_date, applied_date)) AS latest_record_date
       FROM permits`,
    ),
    dbFirst(
      env,
      `/* homepage:last-ingest */
       SELECT end_time FROM ingest_logs
       WHERE status = 'success' AND run_type NOT IN ('entity_graph', 'development_sites')
       ORDER BY end_time DESC LIMIT 1`,
    ),
  ]);

  return {
    permits: Number(stats?.permits) || 0,
    active_permits: Number(stats?.active_permits) || 0,
    contractors: Number(stats?.contractors) || 0,
    active_contractors: Number(stats?.active_contractors) || 0,
    total_value: Number(stats?.total_value) || 0,
    latest_record_date: stats?.latest_record_date || null,
    last_ingest_at: ingest?.end_time || null,
  };
}

export async function getActiveContractors(env) {
  return dbAll(
    env,
    `/* api:active-contractors */
     SELECT c.*, COUNT(p.id) AS active_projects
     FROM contractors c
     JOIN permits p
       ON c.id = p.contractor_id
      AND lower(COALESCE(p.status,'')) = 'active'
     GROUP BY c.id
     HAVING COUNT(p.id) > 0
     ORDER BY active_projects DESC, c.name ASC
     LIMIT 20`,
  );
}

export async function buildHomeSnapshot(env) {
  const [stats, changes, addresses, contractors30d, neighborhoods30d] = await Promise.all([
    getCanonicalStats(env),
    dbAll(
      env,
      `/* homepage:what-changed */
       SELECT sc.id, sc.permit_number, sc.previous_status, sc.new_status, sc.changed_at,
              p.address, p.neighborhood, p.type, p.value
       FROM permit_status_changes sc
       LEFT JOIN permits p ON p.permit_number = sc.permit_number
       ORDER BY datetime(sc.changed_at) DESC, sc.id DESC
       LIMIT 6`,
    ),
    dbAll(
      env,
      `/* homepage:active-addresses */
       SELECT p.address AS label, COUNT(*) AS active_permits, COALESCE(SUM(${countedValueSql("p")}), 0) AS total_value
       FROM permits p
       WHERE lower(COALESCE(p.status,'')) = 'active'
         AND p.address IS NOT NULL AND trim(p.address) != ''
       GROUP BY p.address
       ORDER BY active_permits DESC, total_value DESC, p.address ASC
       LIMIT 5`,
    ),
    dbAll(
      env,
      `/* homepage:contractors-30d */
       SELECT c.name AS label, c.slug, COUNT(p.id) AS permits, COALESCE(SUM(${countedValueSql("p")}), 0) AS total_value
       FROM contractors c
       JOIN permits p ON p.contractor_id = c.id
       WHERE lower(COALESCE(p.status,'')) = 'active'
         AND date(COALESCE(p.issued_date, p.applied_date)) >= date('now', '-30 days')
       GROUP BY c.id
       ORDER BY permits DESC, total_value DESC, c.name ASC
       LIMIT 5`,
    ),
    dbAll(
      env,
      `/* homepage:neighborhoods-30d */
       SELECT p.neighborhood AS label, COUNT(*) AS permits, COALESCE(SUM(${countedValueSql("p")}), 0) AS total_value
       FROM permits p
       WHERE p.neighborhood IS NOT NULL AND trim(p.neighborhood) != ''
         AND date(COALESCE(p.issued_date, p.applied_date)) >= date('now', '-30 days')
       GROUP BY p.neighborhood
       ORDER BY permits DESC, total_value DESC, p.neighborhood ASC
       LIMIT 5`,
    ),
  ]);

  return { stats, changes, addresses, contractors30d, neighborhoods30d };
}

function transitionLabel(change) {
  const previous = humanize(change?.previous_status, "New").toUpperCase();
  const next = humanize(change?.new_status, "Updated").toUpperCase();
  return `${previous} → ${next}`;
}

function renderChanges(changes) {
  if (!changes.length) {
    return `<div class="bs-empty">No recent status changes are available in the current data snapshot.</div>`;
  }

  return changes
    .map((change) => {
      const permit = encodeURIComponent(String(change.permit_number || ""));
      const title = change.address ? smartTitleCase(change.address) : change.permit_number || "Seattle permit";
      const metadata = [
        humanize(change.type, "Permit"),
        change.value ? `${compactMetricMoney(change.value)} declared value` : null,
        change.changed_at ? formatDate(change.changed_at, true) : null,
      ].filter(Boolean);
      return `<a class="bs-change" href="/permits/${permit}">
        ${bsTransition(change?.previous_status, change?.new_status, humanize(change?.previous_status, "New"), humanize(change?.new_status, "Updated"))}
        <span class="bs-change__title">${escapeHtml(title)}</span>
        <span class="bs-change__meta">${escapeHtml(metadata.join(" · "))}</span>
      </a>`;
    })
    .join("");
}

function renderRanking(rows, type) {
  if (!rows.length) return `<div class="bs-empty">No qualifying records in this snapshot.</div>`;

  return rows
    .map((row, index) => {
      const rawLabel = row.label || "Unclassified";
      const label = type === "address" ? smartTitleCase(rawLabel) : rawLabel;
      let href = "/permits";
      let metric = "";
      if (type === "address") {
        href = `/permits?q=${encodeURIComponent(rawLabel)}`;
        metric = `${Number(row.active_permits) || 0} active permits`;
      } else if (type === "contractor") {
        href = row.slug ? `/contractor/${encodeURIComponent(row.slug)}` : `/permits?q=${encodeURIComponent(label)}`;
        metric = `${Number(row.permits) || 0} new active permits`;
      } else {
        href = `/permits?neighborhood=${encodeURIComponent(label)}`;
        metric = `${Number(row.permits) || 0} recent permits`;
      }
      return `<a class="rank-row" href="${href}">
        <span class="rank-index">${index + 1}</span>
        <span class="rank-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(metric)}</small></span>
        <span class="rank-value">${escapeHtml(compactMetricMoney(row.total_value || 0))}<small>declared</small></span>
      </a>`;
    })
    .join("");
}

export function renderHomepage(snapshot) {
  const { stats, changes, addresses, contractors30d, neighborhoods30d } = snapshot;
  const ingestLabel = stats.last_ingest_at ? formatDate(stats.last_ingest_at, true) : "Unavailable";
  const recordLabel = stats.latest_record_date ? formatDate(stats.latest_record_date) : "Unavailable";
  const title = "Seattle Construction Permits & Projects — Building Seattle";
  const description = "Search Seattle construction permits, projects, contractor activity, neighborhoods, addresses, and daily SDCI status changes in one public-record database.";
  const faqItems = [
    {
      q: "What can I search on Building Seattle?",
      a: "Search permit records by address, permit number, contractor, neighborhood, project description, permit type, status, and other fields exposed by the permit browser.",
    },
    {
      q: "Where does the data come from?",
      a: "The base records come from Seattle Department of Construction and Inspections public data. Building Seattle cleans, links, and enriches those records into research views.",
    },
    {
      q: "How current is the data?",
      a: "The ingestion pipeline is scheduled daily. This page reports the latest successful ingest separately from the latest permit event date so freshness is not confused with source activity.",
    },
    {
      q: "What does \u201cpermit value\u201d mean?",
      a: "It is the declared value attached to the permit record. It is not a verified total project cost and may exclude land, design, financing, related permits, later changes, and other project costs.",
    },
  ];
  const structuredData = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
    name: "Building Seattle",
    url: BASE_URL,
    description,
    potentialAction: {
        "@type": "SearchAction",
        target: `${BASE_URL}/permits?q={search_term_string}`,
        "query-input": "required name=search_term_string",
      },
      },
      {
        "@type": "FAQPage",
        mainEntity: faqItems.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a },
        })),
      },
    ],
  }).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  ${themeBootScript()}
  <link rel="preload" href="/brand/fonts/IBMPlexSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/brand/fonts/IBMPlexSans-SemiBold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/brand/tokens.css">
  <link rel="stylesheet" href="/brand/bundle.css">
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="${BASE_URL}/">
  <link rel="manifest" href="/site.webmanifest">
  <link rel="icon" href="/favicon.ico">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${BASE_URL}/">
  <meta property="og:image" content="${BASE_URL}/social/insight.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Building Seattle — Seattle construction permit data">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${BASE_URL}/social/insight.png">
  <meta name="twitter:image:alt" content="Building Seattle — Seattle construction permit data">
  <script type="application/ld+json">${structuredData}</script>
  <style>
    .skip-link{position:absolute;left:-9999px;top:0;z-index:100;background:var(--brand-navy);color:#fff;padding:10px 16px;border-radius:0 0 10px 0;font-weight:800;text-decoration:none}.skip-link:focus{left:0}
    :root{--primary:var(--ink);--bg:var(--surface);--bg-alt:var(--surface-alt);--panel:var(--surface-raised);--text:var(--ink);--muted:var(--ink-muted);--border:var(--line);--soft:var(--line-subtle);--max:1200px;color-scheme:light}[data-theme="dark"]{color-scheme:dark}
    *{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:80px}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);line-height:1.55}a{color:inherit}a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:3px}button,input{font:inherit}.container{width:min(var(--max),calc(100% - 32px));margin:0 auto}.site-header{position:sticky;top:0;z-index:20;background:var(--header-bg,rgba(255,255,255,.96));border-bottom:1px solid var(--soft);backdrop-filter:blur(12px)}.header-inner{min-height:64px;display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:inline-flex;align-items:center;gap:10px;text-decoration:none;font-weight:800;color:var(--ink)}.brand img{display:block;height:24px;width:auto}.nav{display:flex;align-items:center;gap:22px;font-size:14px;font-weight:700}.nav-toggle{display:none;position:relative}.nav-toggle>summary{list-style:none;cursor:pointer;font-size:20px;line-height:1;padding:9px 12px;border:1px solid var(--border);border-radius:9px;color:var(--ink);background:var(--panel)}.nav-toggle>summary::-webkit-details-marker{display:none}.nav-toggle[open]>summary{background:var(--bg-alt)}.mobile-nav{position:absolute;right:0;top:calc(100% + 8px);display:flex;flex-direction:column;gap:2px;min-width:210px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:8px;box-shadow:0 12px 32px rgba(11,41,69,.14);z-index:40}.mobile-nav a{text-decoration:none;color:var(--ink);font-weight:700;font-size:14px;padding:11px 12px;border-radius:8px}.mobile-nav a:hover{background:var(--bg-alt)}.nav a{text-decoration:none;color:var(--ink-secondary)}.nav a:hover{text-decoration:underline;text-underline-offset:4px}.hero{padding:40px 0 32px;border-bottom:1px solid var(--soft)}.eyebrow,.section-kicker{margin:0 0 10px;color:var(--link);font-size:12px;line-height:1.2;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero h1{max-width:850px;margin:0;color:var(--primary);font-size:clamp(2.2rem,5.4vw,3.6rem);line-height:1;letter-spacing:-.04em;text-wrap:balance}.hero-copy{max-width:710px;margin:20px 0 0;font-size:clamp(1rem,2.5vw,1.18rem);color:var(--ink-secondary)}.search-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;max-width:820px;margin-top:28px}.search-form label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.hero-subactions{display:flex;flex-wrap:wrap;gap:16px;margin-top:14px;font-size:14px;font-weight:750}.hero-subactions a{text-underline-offset:4px}.hero-grid{display:grid;gap:8px}.hero-aside{margin-top:6px}.metric-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:24px;max-width:820px}@media(min-width:960px){.hero-grid{grid-template-columns:minmax(0,1.5fr) minmax(280px,.7fr);gap:56px;align-items:start}.hero-aside{margin-top:6px;padding:20px 22px;border:1px solid var(--border);border-radius:12px;background:var(--bg-alt)}.hero-aside .metric-strip{grid-template-columns:1fr;gap:18px;margin-top:0;max-width:none}.hero-aside .bs-metric{border-top-width:1px;border-top-color:var(--border);padding-top:14px}.hero-aside .bs-metric:first-child{border-top-width:3px;border-top-color:var(--ink)}.hero-aside .bs-metric__value{font-size:2rem}.hero-aside .freshness{margin-top:18px;padding-top:14px;border-top:1px solid var(--soft)}}.bs-metric:hover .bs-metric__value{color:var(--accent)}.bs-metric__value{font-size:clamp(1.25rem,5vw,1.85rem);line-height:1.05}.freshness{max-width:820px;margin:18px 0 0;flex-wrap:nowrap;align-items:flex-start}.freshness>span{flex:1;min-width:0}.freshness>.bs-icon{margin-top:1px}.freshness a{font-weight:750;text-underline-offset:3px}.section{padding:52px 0;border-bottom:1px solid var(--soft)}.section.alt{background:var(--bg-alt)}.section-head{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:22px}.section h2{margin:0;color:var(--primary);font-size:clamp(1.75rem,5vw,2.6rem);line-height:1.05;letter-spacing:-.035em}.section-deck{max-width:680px;margin:8px 0 0;color:var(--ink-secondary)}.text-link{font-weight:800;color:var(--link);text-underline-offset:4px;white-space:nowrap}.market-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.market-card{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}.market-card header{padding:18px 18px 14px;border-bottom:1px solid var(--soft)}.market-card h3{margin:0;color:var(--ink);font-size:16px}.market-card p{margin:5px 0 0;color:var(--ink-secondary);font-size:12px}.rank-row{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:10px;align-items:center;padding:13px 16px;border-bottom:1px solid var(--soft);text-decoration:none}.rank-row:last-child{border-bottom:0}.rank-row:hover strong{text-decoration:underline;text-underline-offset:3px}.rank-index{color:var(--ink-muted);font-size:12px;font-weight:800}.rank-copy{min-width:0}.rank-copy strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);font-size:13px}.rank-copy small,.rank-value small{display:block;color:var(--ink-muted);font-size:11px;font-weight:600}.rank-value{text-align:right;color:var(--ink);font-size:12px;font-weight:800}.tasks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-top:1px solid var(--border);border-left:1px solid var(--border)}.task{min-height:146px;padding:22px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);text-decoration:none;background:var(--panel)}.task:hover{background:var(--bg-alt)}.task strong{display:flex;justify-content:space-between;gap:16px;color:var(--ink);font-size:18px}.task p{max-width:48ch;margin:9px 0 0;color:var(--ink-secondary);font-size:14px}.trust{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(260px,.6fr);gap:28px;align-items:start}.trust-copy{font-size:16px}.trust-copy p{max-width:70ch}.trust-note{border-left:4px solid var(--ink);padding:4px 0 4px 18px;color:var(--ink-secondary)}.trust-meta{border:1px solid var(--border);border-radius:12px;padding:20px;background:var(--panel)}.trust-meta dl{margin:0}.trust-meta div+div{border-top:1px solid var(--soft);margin-top:12px;padding-top:12px}.trust-meta dt{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-muted)}.trust-meta dd{margin:4px 0 0;font-weight:750;color:var(--ink)}.faq{border-top:1px solid var(--border)}details{border-bottom:1px solid var(--border)}summary{list-style:none;cursor:pointer;padding:18px 2px;font-weight:800;color:var(--ink)}summary::-webkit-details-marker{display:none}summary::after{content:"+";float:right;color:var(--ink-secondary)}details[open] summary::after{content:"−"}.answer{max-width:760px;padding:0 36px 20px 2px;color:var(--ink-secondary)}.alert-panel{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:center;padding:28px;border-radius:14px;background:var(--brand-navy);color:#fff}.alert-panel h2{color:#fff}.alert-panel p{max-width:680px;margin:9px 0 0;color:#CBD3DD}.alert-button{display:inline-flex;min-height:48px;align-items:center;justify-content:center;padding:0 20px;border-radius:8px;background:#fff;color:var(--brand-navy);font-weight:850;text-decoration:none;white-space:nowrap}.site-footer{padding:30px 0 42px}.footer-inner{display:flex;justify-content:space-between;gap:24px;align-items:start}.footer-brand{font-weight:850;color:var(--ink)}.footer-nav{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:12px 18px;font-size:13px}.footer-nav a{color:var(--ink-secondary);text-underline-offset:3px}
    @media(max-width:780px){.nav{display:none}.nav-toggle{display:block}.hero{padding-top:40px}.search-form{grid-template-columns:1fr}.search-form .bs-btn{width:100%}.section{padding:44px 0}.section-head{display:block}.section-head .text-link{display:inline-block;margin-top:12px}.market-grid{grid-template-columns:1fr}.tasks{grid-template-columns:1fr}.trust{grid-template-columns:1fr}.alert-panel{grid-template-columns:1fr}.alert-button{width:100%}.footer-inner{display:block}.footer-nav{justify-content:flex-start;margin-top:16px}.task{min-height:auto}.rank-copy strong{white-space:normal}}
    @media(max-width:360px){.container{width:min(var(--max),calc(100% - 24px))}.metric-strip{gap:6px}.bs-metric__value{font-size:1.16rem}.bs-metric__label{font-size:11px}.hero h1{font-size:2.05rem}}
    @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
    [data-theme="dark"] .site-header{--header-bg:rgba(8,24,42,.96)}
    [data-theme="dark"] .alert-panel{box-shadow:inset 0 0 0 1px var(--line)}
    .header-end{display:flex;align-items:center;gap:12px;flex:0 0 auto}.brand{min-width:0;flex:0 1 auto}.brand img{max-width:100%;height:auto;max-height:24px}@media(max-width:380px){.header-inner,.header-end{gap:8px}}
    ${themeToggleStyles()}
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/" aria-label="Building Seattle home">${themedLockup("")}</a>
      <div class="header-end">
      <nav class="nav" aria-label="Primary navigation">
        <a href="/permits">Permits</a><a href="/contractors">Contractors</a><a href="/neighborhoods">Neighborhoods</a><a href="/insights">Insights</a><a href="/data">Data</a>
      </nav>
      ${themeToggleButton()}
      <details class="nav-toggle">
        <summary aria-label="Open navigation menu">&#9776;</summary>
        <nav class="mobile-nav" aria-label="Mobile navigation">
          <a href="/permits">Permits</a><a href="/contractors">Contractors</a><a href="/neighborhoods">Neighborhoods</a><a href="/insights">Insights</a><a href="/data">Data</a><a href="/api-docs">API</a>
        </nav>
      </details>
      </div>
    </div>
  </header>
  <main id="main-content">
    <section class="hero">
      <div class="container hero-grid">
        <div class="hero-main">
        <p class="eyebrow">Seattle SDCI permit data</p>
        <h1>Seattle construction permits, projects &amp; contractor activity</h1>
        <p class="hero-copy">Search current Seattle permit records by address, permit number, contractor, neighborhood, or project description.</p>
        <form class="bs-search search-form" action="/permits" method="get" role="search">
          <label for="home-search">Search Seattle construction permits</label>
          <span class="bs-search__box"><span data-icon="search">${bsIcon("search", 20)}</span><input class="bs-input" id="home-search" name="q" type="search" autocomplete="off" placeholder="Address, permit #, contractor, neighborhood…"></span>
          <button class="bs-btn bs-btn--primary" type="submit">Search</button>
        </form>
        <div class="hero-subactions"><a href="/permits">Browse all permits →</a><a href="/projects">Explore projects →</a></div>
        </div>
        <aside class="hero-aside" aria-label="Database snapshot">
        <div class="metric-strip" aria-label="Current database metrics">
          <a class="bs-metric" href="/permits?status=active"><span class="bs-metric__value">${escapeHtml(stats.active_permits.toLocaleString("en-US"))}</span><span class="bs-metric__label">active permits</span></a>
          <a class="bs-metric" href="/contractors"><span class="bs-metric__value">${escapeHtml(stats.contractors.toLocaleString("en-US"))}</span><span class="bs-metric__label">contractors linked to permits</span></a>
          <a class="bs-metric" href="/permits"><span class="bs-metric__value">${escapeHtml(compactMetricMoney(stats.total_value))}</span><span class="bs-metric__label">declared permit value</span></a>
        </div>
        <p class="bs-source freshness">${bsIcon("source", 14)}<span>Seattle SDCI Open Data · Scheduled daily ingest · Last successful ingest <strong>${escapeHtml(ingestLabel)}</strong> · Latest permit event <strong>${escapeHtml(recordLabel)}</strong> · <a href="/methodology">Methodology</a></span></p>
        </aside>
      </div>
    </section>

    <section class="section" aria-labelledby="changes-heading">
      <div class="container">
        <div class="section-head"><div><p class="section-kicker">Current signal</p><h2 id="changes-heading">What changed</h2><p class="section-deck">Recent status transitions recorded in the Building Seattle permit history.</p></div><a class="text-link" href="/permits">Browse permits →</a></div>
        <div class="bs-changes">${renderChanges(changes)}</div>
      </div>
    </section>

    <section class="section alt" aria-labelledby="market-heading">
      <div class="container">
        <div class="section-head"><div><p class="section-kicker">Market activity</p><h2 id="market-heading">Seattle construction activity</h2><p class="section-deck">Explicit rankings with the metric and timeframe shown. Declared values are source-reported permit values, not verified total project costs.</p></div></div>
        <div class="market-grid">
          <article class="market-card"><header><h3>Most active addresses</h3><p>Current active permit count · all active records</p></header>${renderRanking(addresses, "address")}</article>
          <article class="market-card"><header><h3>Contractors with new active work</h3><p>Active permits applied or issued · past 30 days</p></header>${renderRanking(contractors30d, "contractor")}</article>
          <article class="market-card"><header><h3>Neighborhoods with recent activity</h3><p>Permits applied or issued · past 30 days</p></header>${renderRanking(neighborhoods30d, "neighborhood")}</article>
        </div>
        <div class="market-context" aria-labelledby="construction-guide-heading" style="max-width:850px;margin:34px auto 0;color:var(--muted);line-height:1.75">
          <h3 id="construction-guide-heading" style="margin:0 0 10px;color:var(--primary);font-size:1.25rem">How to read Seattle construction activity</h3>
          <p>Seattle construction activity starts in the public permit record, before every proposed project becomes a finished building. An application shows intent; review and correction cycles show work moving through SDCI; issuance authorizes the permitted scope; and completion records the city’s final status. Start with <a class="text-link" href="/permits?status=active">active Seattle construction permits</a> when you want the current pipeline, or use <a class="text-link" href="/projects">linked projects</a> to group related records at the same site.</p>
          <p>The <a class="text-link" href="/insights/pipeline">permit pipeline</a> separates applications, issued permits, and completions, while the <a class="text-link" href="/insights/plan-review">plan-review dashboard</a> shows how long review takes and how correction cycles affect timing. Those measures describe the city’s permitting process; they do not prove that construction has started on site.</p>
          <p>Use <a class="text-link" href="/neighborhoods">neighborhood activity</a> to see where permits cluster and <a class="text-link" href="/contractors">contractor activity</a> to trace firms attached to public records. Declared permit value is useful for comparing the scale of filings, but it is an applicant-reported estimate rather than a verified construction budget.</p>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="tasks-heading">
      <div class="container">
        <div class="section-head"><div><p class="section-kicker">Start with a task</p><h2 id="tasks-heading">Get to the useful record</h2></div></div>
        <div class="tasks">
          <a class="task" href="/permits?status=active"><strong><span>Find prospective work</span><span aria-hidden="true">→</span></strong><p>Start with active permits, then narrow by neighborhood, project type, contractor, or declared value.</p></a>
          <a class="task" href="/addresses"><strong><span>Research an address</span><span aria-hidden="true">→</span></strong><p>Move from an address into its permit history, related projects, and public-record participants.</p></a>
          <a class="task" href="/neighborhoods"><strong><span>Track a neighborhood</span><span aria-hidden="true">→</span></strong><p>Compare construction activity across Seattle neighborhoods and drill into the supporting permits.</p></a>
          <a class="task" href="/data"><strong><span>Use the data</span><span aria-hidden="true">→</span></strong><p>Download the dataset or use the public read-only API for your own analysis and workflows.</p></a>
        </div>
      </div>
    </section>

    <section class="section alt" aria-labelledby="trust-heading">
      <div class="container trust">
        <div class="trust-copy"><p class="section-kicker">Source &amp; methodology</p><h2 id="trust-heading">Built from Seattle public records</h2><p>Building Seattle organizes Seattle Department of Construction and Inspections records into searchable permits, addresses, projects, contractors, and neighborhoods.</p><p class="trust-note">Permit values are <strong>declared permit values</strong>, not verified total project costs. Some project and entity relationships are inferred from source records and should be read with the methodology in mind.</p><p><a class="text-link" href="/methodology">Read the methodology →</a> &nbsp; <a class="text-link" href="/data">Explore the dataset →</a></p></div>
        <section class="trust-meta" aria-label="Data freshness"><dl><div><dt>Source</dt><dd>Seattle SDCI Open Data</dd></div><div><dt>Ingest cadence</dt><dd>Scheduled daily</dd></div><div><dt>Last successful ingest</dt><dd>${escapeHtml(ingestLabel)}</dd></div><div><dt>Latest permit event</dt><dd>${escapeHtml(recordLabel)}</dd></div></dl></section>
      </div>
    </section>

    <section class="section" aria-labelledby="faq-heading">
      <div class="container"><div class="section-head"><div><p class="section-kicker">Common questions</p><h2 id="faq-heading">About the data</h2></div></div><div class="faq">
        <details><summary>What can I search on Building Seattle?</summary><div class="answer">Search permit records by address, permit number, contractor, neighborhood, project description, permit type, status, and other fields exposed by the permit browser.</div></details>
        <details><summary>Where does the data come from?</summary><div class="answer">The base records come from Seattle Department of Construction and Inspections public data. Building Seattle cleans, links, and enriches those records into research views.</div></details>
        <details><summary>How current is the data?</summary><div class="answer">The ingestion pipeline is scheduled daily. This page reports the latest successful ingest separately from the latest permit event date so freshness is not confused with source activity.</div></details>
        <details><summary>What does “permit value” mean?</summary><div class="answer">It is the declared value attached to the permit record. It is not a verified total project cost and may exclude land, design, financing, related permits, later changes, and other project costs.</div></details>
      </div></div>
    </section>

    <section class="section alt" aria-labelledby="alerts-heading"><div class="container"><div class="alert-panel"><div><p class="section-kicker" style="color:var(--brand-sky)">Permit alerts</p><h2 id="alerts-heading">Get the changes that matter</h2><p>Choose a permit and subscribe to its status changes. Building Seattle already supports free per-permit alerts with confirmation and one-click unsubscribe.</p></div><a class="alert-button" href="/permits">Find a permit to watch</a></div></div></section>
  </main>
  <footer class="site-footer"><div class="container footer-inner"><div><div class="footer-brand">Building Seattle</div><div style="margin-top:4px;color:var(--ink-muted);font-size:12px">Seattle construction intelligence</div></div><nav class="footer-nav" aria-label="Footer navigation"><a href="/permits">Permits</a><a href="/contractors">Contractors</a><a href="/neighborhoods">Neighborhoods</a><a href="/projects">Projects</a><a href="/addresses">Addresses</a><a href="/insights">Insights</a><a href="/data">Dataset</a><a href="/methodology">Methodology</a><a href="/about">About</a><a href="/api-docs">API</a><a href="https://buildingseattle.gumroad.com/l/seattle-permits?utm_source=buildingseattle&utm_medium=site&utm_campaign=footer" rel="noopener">Buy the dataset</a></nav></div></footer>
</body>
</html>`;
}
function renderHomeMarkdown(snapshot) {
  const { stats, changes } = snapshot;
  const lines = [
    "# Seattle construction permits, projects & contractor activity",
    "",
    "Search current Seattle permit records by address, permit number, contractor, neighborhood, or project description.",
    "",
    `- ${stats.active_permits.toLocaleString("en-US")} active permits`,
    `- ${stats.contractors.toLocaleString("en-US")} contractors linked to permits`,
    `- ${compactMetricMoney(stats.total_value)} declared permit value`,
    `- Scheduled daily ingest; last successful ingest: ${stats.last_ingest_at ? formatDate(stats.last_ingest_at, true) : "Unavailable"}`,
    `- Latest permit event in the dataset: ${stats.latest_record_date ? formatDate(stats.latest_record_date) : "Unavailable"}`,
    "",
    `Search: ${BASE_URL}/permits?q=SEARCH_TERM`,
    "",
    "## What changed",
    "",
  ];
  if (!changes.length) lines.push("No recent status changes are available in the current snapshot.");
  for (const change of changes) {
    lines.push(`- ${transitionLabel(change)} — ${change.address || change.permit_number || "Seattle permit"} — ${change.changed_at ? formatDate(change.changed_at, true) : "date unavailable"}`);
  }
  lines.push("", "## Methodology", "", "Permit values are declared values, not verified total project costs. Some project and entity relationships are inferred from public records.", "", `${BASE_URL}/methodology`);
  return lines.join("\n");
}

// Root route: content-negotiates Markdown for agents, otherwise renders the
// shared task-first homepage. Cache-Control drives the edge TTL applied by
// withHtmlEdgeCache, and withSecurityHeaders adds the discovery Link header.
async function handleRoot(request, env) {
  const snapshot = await buildHomeSnapshot(env);
  if (wantsMarkdown(request)) return markdownResponse(request, renderHomeMarkdown(snapshot));
  return new Response(renderHomepage(snapshot), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300, s-maxage=300" },
  });
}

async function handleLeadCapture(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const email = String(data.email || "").trim().toLowerCase();
  const company = String(data.company || "").trim();
  const interest = String(data.interest || "").trim();
  if (!isValidEmail(email) || !company || !interest) {
    return new Response(JSON.stringify({ error: "A valid email, company, and interest are required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const neighborhoods = String(data.neighborhoods || "").trim().slice(0, 500) || null;
  const source = String(data.source || "website").slice(0, 100);
  const userAgent = String(data.userAgent || "").slice(0, 300) || null;

  const stmt = env.DB.prepare(`
        INSERT OR IGNORE INTO leads (email, company, interest, neighborhoods, source, user_agent, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);

  await stmt
    .bind(
      email,
      company,
      interest,
      neighborhoods,
      source,
      userAgent,
    )
    .run();

  return new Response(JSON.stringify({ success: true, id: crypto.randomUUID() }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const LEAD_BATCH_MAX_ITEMS = 500;
const LEAD_FIELD_MAX_LENGTH = 500;

async function handleLeadBatch(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items) {
    return new Response(JSON.stringify({ error: "items must be an array" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (items.length > LEAD_BATCH_MAX_ITEMS) {
    return new Response(
      JSON.stringify({ error: `items must contain at most ${LEAD_BATCH_MAX_ITEMS} records` }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const results = [];

  for (const data of items) {
    const email = String(data?.email || "").trim().toLowerCase();
    const company = String(data?.company || "").trim();
    const interest = String(data?.interest || "").trim();
    if (!isValidEmail(email) || !company || !interest) {
      results.push({ email, status: "error", error: "invalid" });
      continue;
    }
    try {
      const stmt = env.DB.prepare(`
                INSERT OR IGNORE INTO leads (email, company, interest, neighborhoods, source, created_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
            `);
      await stmt
        .bind(
          email,
          company.slice(0, LEAD_FIELD_MAX_LENGTH),
          interest.slice(0, LEAD_FIELD_MAX_LENGTH),
          String(data.neighborhoods || "").trim().slice(0, LEAD_FIELD_MAX_LENGTH) || null,
          String(data.source || "batch").slice(0, 100),
        )
        .run();
      results.push({ email, status: "success" });
    } catch {
      results.push({ email, status: "error", error: "invalid" });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
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
  ${themeBootScript()}
  <link rel="preload" href="/brand/fonts/IBMPlexSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/brand/fonts/IBMPlexSans-SemiBold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/brand/tokens.css">
  <link rel="stylesheet" href="/brand/bundle.css">
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
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
  const siteContext = developmentSitesArePublic(env);
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

  const listQuery = `SELECT p.*, ${siteContext ? developmentSiteColumns() + "," : ""} c.name as contractor_name, c.slug as contractor_slug, c.specialty as contractor_specialty, c.phone as contractor_phone, c.email as contractor_email FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id ${siteContext ? developmentSiteJoin() : ""} ${where} ORDER BY p.issued_date DESC LIMIT ${perPage} OFFSET ${offset}`;
  const countQuery = `SELECT COUNT(*) as total FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id ${where}`;

  const [{ results }, { total }] = await Promise.all([
    env.DB.prepare(listQuery)
      .bind(...params)
      .all(),
    env.DB.prepare(countQuery)
      .bind(...params)
      .first(),
  ]);

  return new Response(JSON.stringify({ total, page, per_page: perPage, results: (results || []).slice(0, perPage).map(row => siteContext ? withDevelopmentSiteFields(row) : row) }), {
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
      const address = escapeHtml(change.address || "Unknown address");
      const neighborhood = escapeHtml(change.neighborhood || "Seattle");
      const permitNumber = escapeHtml(change.permit_number);
      const type = escapeHtml(change.type || "General");
      const value = change.value ? `$${Number(change.value).toLocaleString("en-US")}` : "Value not reported";

      return `<article class="change-card">
        <div>
          <div class="change-title"><a href="/permits/${encodeURIComponent(change.permit_number)}">${address}</a></div>
          <div class="change-meta">Permit ${permitNumber} &bull; ${neighborhood} &bull; ${type} &bull; ${value}</div>
        </div>
        <div class="change-status">
          ${bsTransition(normalizeStoredStatus(change.previous_status), normalizeStoredStatus(change.new_status), humanize(normalizeStoredStatus(change.previous_status)), humanize(normalizeStoredStatus(change.new_status)))}
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

  let primaryWhere = where;
  let fallbackWhere = where;
  let primaryParams = params;
  let fallbackParams = params;
  if (q) {
    const like = "%" + q + "%";
    primaryWhere +=
      " AND (p.address LIKE ? OR p.description LIKE ? OR p.detailed_description LIKE ? OR p.permit_number LIKE ? OR p.neighborhood LIKE ? OR c.name LIKE ?)";
    primaryParams = [...params, like, like, like, like, like, like];
    fallbackWhere +=
      " AND (p.address LIKE ? OR p.description LIKE ? OR p.permit_number LIKE ? OR p.neighborhood LIKE ? OR c.name LIKE ?)";
    fallbackParams = [...params, like, like, like, like, like];
  }

  const listQuery = `SELECT p.*, c.name as contractor_name, c.slug as contractor_slug, c.specialty as contractor_specialty, a.slug as address_slug, a.display_address as address_display FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id LEFT JOIN addresses a ON a.id = p.address_id ${primaryWhere} ORDER BY p.issued_date DESC LIMIT ${perPage} OFFSET ${offset}`;
  const countQuery = `SELECT COUNT(*) as total FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id LEFT JOIN addresses a ON a.id = p.address_id ${primaryWhere}`;

  let permitResult;
  let totalResult;
  try {
    [permitResult, totalResult] = await Promise.all([
      env.DB.prepare(listQuery).bind(...primaryParams).all(),
      env.DB.prepare(countQuery).bind(...primaryParams).first(),
    ]);
  } catch {
    // Entity-graph columns are added by a separate migration. Keep the public
    // permit browser available while that migration is being rolled out.
    const fallbackListQuery = `SELECT p.*, c.name as contractor_name, c.slug as contractor_slug, c.specialty as contractor_specialty FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id ${fallbackWhere} ORDER BY p.issued_date DESC LIMIT ${perPage} OFFSET ${offset}`;
    const fallbackCountQuery = `SELECT COUNT(*) as total FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id ${fallbackWhere}`;
    [permitResult, totalResult] = await Promise.all([
      env.DB.prepare(fallbackListQuery).bind(...fallbackParams).all(),
      env.DB.prepare(fallbackCountQuery).bind(...fallbackParams).first(),
    ]);
  }

  const [
    { results: neighborhoods },
    { results: types },
    { results: statuses },
    lastRun,
    recentStatusChanges,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT DISTINCT neighborhood FROM permits WHERE neighborhood IS NOT NULL AND neighborhood != '' ORDER BY neighborhood ASC`,
    ).all(),
    env.DB.prepare(`SELECT DISTINCT type FROM permits WHERE type IS NOT NULL AND type != '' ORDER BY type ASC`).all(),
    env.DB.prepare(
      `SELECT DISTINCT status FROM permits WHERE status IS NOT NULL AND status != '' ORDER BY status ASC`,
    ).all(),
    env.DB.prepare(
      `SELECT end_time FROM ingest_logs WHERE status = 'success' AND run_type NOT IN ('entity_graph', 'development_sites') ORDER BY end_time DESC LIMIT 1`,
    ).first(),
    getRecentStatusChanges(env, 8),
  ]);
  const permits = permitResult?.results || [];
  const totalRaw = totalResult?.total || 0;
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
  const isFilteredView = Boolean(q || neighborhood || type || status);
  const filterLabels = [
    neighborhood,
    type ? permitTypeLabel(type) : null,
    status ? `${status.charAt(0).toUpperCase()}${status.slice(1)}` : null,
  ].filter(Boolean);
  const queryLabel = q ? ` matching \u201c${q}\u201d` : "";
  const filterSuffix = filterLabels.length ? ` \u00b7 ${filterLabels.join(" \u00b7 ")}` : "";
  const resultsHeading =
    total === 0 && isFilteredView
      ? `No permits${queryLabel || " match these filters"}${filterSuffix}`
      : `${countLabel(total, "permit", "permits")}${queryLabel}${filterSuffix}`;
  const clearSearchParams = new URLSearchParams();
  if (neighborhood) clearSearchParams.set("neighborhood", neighborhood);
  if (type) clearSearchParams.set("type", type);
  if (status) clearSearchParams.set("status", status);
  const clearSearchHref = `/permits${clearSearchParams.toString() ? `?${clearSearchParams}` : ""}`;
  const emptyResults = `<div class="empty">
                <p style="margin:0 0 0.75rem;">${q ? "Check the spelling, or search by street address or permit number." : "Try fewer filters."}</p>
                ${q && filterLabels.length ? `<a class="empty-link" href="${escapeHtml(clearSearchHref)}">Clear search</a> &middot; ` : ""}<a class="empty-link" href="/permits">Clear all filters</a>
            </div>`;
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
  // The feed is unrelated to a search; showing it above filtered results made
  // an empty search look like it had hits.
  const showStatusFeed = !isFilteredView && page === 1;
  const cards = permits
    .map((permit) => {
      const value = permit.value ? `$${Number(permit.value).toLocaleString("en-US")}` : "Value not reported";
      const issued = permit.issued_date
        ? new Date(permit.issued_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "Date pending";
      const contractor = permit.contractor_slug
        ? `<a href="/contractor/${encodeURIComponent(permit.contractor_slug)}" style="color:var(--accent);text-decoration:none;font-weight:600;">${escapeHtml(permit.contractor_name || "View contractor")}</a>`
        : `<span style="color:var(--text-muted);">Contractor not linked yet</span>`;
      const address = escapeHtml(permit.address_display || permit.address || "Unknown address");
      const addressLink = permit.address_slug
        ? `<a href="/address/${encodeURIComponent(permit.address_slug)}" style="color:var(--accent);text-decoration:none;font-size:0.78rem;font-weight:650;">Property history &rarr;</a>`
        : "";
      const permitNumber = escapeHtml(permit.permit_number || "Unknown permit");
      const neighborhoodLabel = escapeHtml(permit.neighborhood || "Seattle");
      const typeLabel = escapeHtml(permitTypeLabel(permit.type));
      const description = escapeHtml(permitSearchDescriptor(permit) || "No project description available yet.");

      return `<article class="permit-card">
        <div class="permit-card-top">
          <div>
            <div class="permit-address"><a href="/permits/${encodeURIComponent(permit.permit_number || "")}">${address}</a></div>
            ${addressLink}
            <div class="permit-meta">${neighborhoodLabel} &bull; ${typeLabel} &bull; ${issued}</div>
          </div>
          ${bsStatusPill(permit.status, humanize(permit.status || "new"))}
        </div>
        <p class="permit-description">${description}</p>
        <div class="permit-footer">
          <div>
            <div class="permit-value">${value}</div>
            <div class="permit-number">Permit <span class="bs-id">${permitNumber}</span></div>
          </div>
          <div class="permit-contractor">${contractor}</div>
        </div>
      </article>`;
    })
    .join("");

  // Paginated pages get a distinct title so the series doesn't share one
  // duplicate <title> in the index.
  const browserTitle = `Seattle Building Permits & SDCI Records | Building Seattle${page > 1 ? ` — Page ${page}` : ""}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  ${themeBootScript()}
  <link rel="preload" href="/brand/fonts/IBMPlexSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/brand/fonts/IBMPlexSans-SemiBold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/brand/tokens.css">
  <link rel="stylesheet" href="/brand/bundle.css">
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(browserTitle)}</title>
    <meta name="description" content="Search Seattle building permits, project descriptions, status changes, contractors, valuations, and property history in public SDCI records refreshed daily.">
    <meta name="robots" content="${hasPermitFilters || total === 0 ? "noindex,follow" : "index,follow,max-image-preview:large"}">
    <link rel="canonical" href="${permitCanonical}">
    <meta property="og:title" content="${escapeHtml(browserTitle)}">
    <meta property="og:description" content="Search Seattle building permits, project descriptions, status changes, contractors, valuations, and property history in public SDCI records refreshed daily.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${permitCanonical}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(browserTitle)}">
    <meta name="twitter:description" content="Search Seattle building permits, project descriptions, status changes, contractors, valuations, and property history in public SDCI records refreshed daily.">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
	    <meta property="og:image:width" content="1200">
	    <meta property="og:image:height" content="630">
	    <meta name="twitter:image" content="${BASE_URL}/og-image.png">
	    <link rel="icon" href="/favicon.ico" sizes="32x32" type="image/png">
	    <link rel="manifest" href="/site.webmanifest">
	    ${renderDesignTokens()}
	    <style>
        * { box-sizing: border-box; }
        body { margin: 0; font-family:var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif); background: var(--bg-alt); color: var(--text); }
        .container { box-sizing: content-box; max-width: var(--container-max); margin: 0 auto; padding: 0 1.5rem; }
        .hero { padding: 1.5rem 0 0.5rem; }
        .hero h1 { margin: 0 0 0.75rem; font-size: clamp(2rem, 4vw, 3.25rem); line-height: 1.05; }
        .hero p { margin: 0; max-width: 720px; color: var(--text-muted); font-size: 1.05rem; }
        .permit-guide { max-width: 780px; margin: 2.5rem 0 2rem; color: var(--text-muted); line-height: 1.7; }
        .permit-guide h2 { margin: 0 0 0.75rem; color: var(--text); font-size: 1.35rem; }
        .permit-guide p { margin: 0 0 0.75rem; }
        .permit-guide a { color: var(--accent); font-weight: 650; }
        .filters { background: var(--surface); border: 1px solid var(--border); border-radius: 1rem; padding: 1rem; display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; align-items: end; margin: 1rem 0 2rem; }
        @media (min-width: 1140px) { .filters { grid-template-columns: minmax(220px, 2fr) repeat(3, minmax(190px, 1fr)) auto auto; } }
	        label { display: block; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-bottom: 0.4rem; }
	        select, button, .secondary-link { width: 100%; border-radius: 0.75rem; border: 1px solid var(--border); padding: 0.8rem 0.9rem; font: inherit; }
        select { background: var(--surface); color: var(--text); }
        .empty-link { color: var(--accent); font-weight: 650; }
	        button { background: var(--accent); color: var(--on-accent); font-weight: 700; cursor: pointer; border-color: var(--accent); }
	        .secondary-link { background: transparent; color: var(--text); text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
        .results-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1rem; }
        .results-head p { margin: 0; color: var(--text-muted); }
        .status-changes { margin: 0 0 2rem; }
        .status-changes-header { display: flex; justify-content: space-between; gap: 1rem; align-items: end; margin-bottom: 1rem; }
        .status-changes-header h2 { margin: 0; }
        .status-changes-header p { margin: 0.35rem 0 0; color: var(--text-muted); }
        .change-list { display: grid; gap: 0.75rem; }
        .change-card { background: var(--surface); border: 1px solid var(--border); border-radius: 1rem; padding: 1rem; display: flex; justify-content: space-between; align-items: center; gap: 1rem; box-shadow: 0 8px 30px rgba(11,41,69, 0.04); }
        .change-title a { color: var(--primary); text-decoration: none; font-size: 1rem; font-weight: 800; }
        .change-meta, .change-time { color: var(--text-muted); font-size: 0.85rem; }
        .change-status { display: flex; align-items: center; justify-content: flex-end; gap: 0.45rem; flex-wrap: wrap; min-width: 260px; }
        .permits { display: grid; gap: 1rem; padding-bottom: 3rem; }
        .permit-card { background: var(--surface); border: 1px solid var(--border); border-radius: 1rem; padding: 1.25rem; box-shadow: 0 8px 30px rgba(11,41,69, 0.04); }
        .permit-card-top, .permit-footer { display: flex; justify-content: space-between; align-items: start; gap: 1rem; }
        .permit-address a { color: var(--primary); text-decoration: none; font-size: 1.1rem; font-weight: 800; }
        .permit-meta, .permit-number, .permit-description { color: var(--text-muted); }
        .permit-description { margin: 0.85rem 0 1rem; line-height: 1.6; }
        .permit-value { font-size: 1.35rem; font-weight: 800; color: var(--primary); }
        .empty { background: var(--surface); border: 1px dashed var(--border); border-radius: 1rem; padding: 2rem; text-align: center; color: var(--text-muted); }
        @media (max-width: 720px) {
          .permit-card-top, .permit-footer, .results-head, .status-changes-header, .change-card { flex-direction: column; align-items: stretch; }
          .change-status { justify-content: flex-start; min-width: 0; }
        }
    </style>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://buildingseattle.com/"},{"@type":"ListItem","position":2,"name":"Permits","item":"https://buildingseattle.com/permits"}]}</script>
</head>
<body>
    <a class="skip-link" href="#main-content">Skip to content</a>
    ${renderNav("permits")}
    <div class="global-nav-spacer"></div>
    <div class="container" style="padding-top:1.25rem;">
        <nav aria-label="breadcrumb" style="font-size:0.8125rem;color:var(--text-muted);">
            <a href="/" style="color:var(--text-muted);text-decoration:none;">Home</a> <span style="margin:0 0.4rem;">/</span> <span style="color:var(--text);font-weight:600;">Permits</span>
        </nav>
    </div>
    <main class="container" id="main-content">
        <section class="hero">
            <h1>Seattle Construction Permits</h1>
            <p>Search live SDCI permit records by address, permit number or contractor, then filter by neighborhood, type and status.</p>
        </section>
        <form class="filters" action="/permits" method="GET">
            <div>
                <label for="q">Search</label>
                <input type="text" id="q" name="q" value="${escapeHtml(q || "")}" placeholder="e.g. 1201 3rd Ave" style="width:100%;border-radius:0.75rem;border:1px solid var(--border);padding:0.8rem 0.9rem;font:inherit;">
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
                <button type="submit">Apply filters</button>
            </div>
            <div>
                <a class="secondary-link" href="/permits">Clear filters</a>
            </div>
        </form>
        ${showStatusFeed ? `
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
        </section>` : ""}
        <div class="results-head">
            <h2 style="margin:0;">${escapeHtml(resultsHeading)}</h2>
            <p>Updated ${lastUpdated}</p>
        </div>
        <section class="permits" aria-label="Permit results">
            ${cards || emptyResults}
        </section>
        ${totalPages > 1 ? renderPagination(url, page, totalPages, total, permits.length, offset) : ""}
        <section class="permit-guide" aria-labelledby="permit-guide-heading">
            <h2 id="permit-guide-heading">How to search Seattle permit records</h2>
            <p>Start with a street address, permit number, or contractor, then combine the neighborhood, permit type, and status filters to narrow the public Seattle Department of Construction &amp; Inspections record. Each result surfaces the project description, declared valuation, issue date, current status, and linked property or contractor history. The data is refreshed daily.</p>
            <p>Permit valuations are project estimates, and a status describes the city's review or issuance workflow rather than proving construction is complete. Read the <a href="/methodology">data methodology</a>, or compare activity across <a href="/neighborhoods">Seattle neighborhoods</a>, <a href="/contractors">contractors</a>, and <a href="/addresses">property records</a>.</p>
        </section>
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
  // The current step is the latest reached milestone; "Expires" is a deadline,
  // not an event, so it is never the current step.
  let currentIndex = -1;
  nodes.forEach((n, index) => {
    if (n.reached && n.label !== "Expires") currentIndex = index;
  });
  const nodesHtml = nodes
    .map((n, index) => {
      const state = index === currentIndex ? " is-current" : n.reached && n.label !== "Expires" ? " is-done" : "";
      const detail = n.detail ? escapeHtml(n.detail) : "&mdash;";
      return `<div class="bs-step${state}"${index === currentIndex ? ' aria-current="step"' : ""}><span class="bs-step__label">${escapeHtml(
        n.label,
      )}</span><span class="bs-step__date">${detail}</span></div>`;
    })
    .join("");
  // Bar runs from the first diamond's centre to the current one's.
  const progress = currentIndex > 0 ? `calc(${((currentIndex * 100) / nodes.length).toFixed(3)}% + 1px)` : "0px";

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
            `<div class="timeline-metric"><div class="timeline-metric-value bs-num">${v.toLocaleString()}</div><div class="timeline-metric-label">${escapeHtml(
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
                <div class="bs-card card-full timeline-card">
                    <style>
                      .timeline-scroll{margin-top:1rem;overflow-x:auto;padding-bottom:2px}
                      .timeline-scroll .bs-timeline{min-width:calc(var(--steps) * 84px)}
                      .bs-step{padding-right:var(--space-2)}
                      .bs-step:not(.is-done):not(.is-current)::before{background:var(--line);border-color:var(--line)}
                      .timeline-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1rem;margin-top:1.5rem}
                      .timeline-metric{background:var(--bg-alt);border:1px solid var(--border);border-radius:0.5rem;padding:0.85rem 1rem;text-align:center}
                      .timeline-metric-value{font-size:1.5rem;font-weight:700;color:var(--ink);line-height:1.1}
                      .timeline-metric-label{font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-top:0.3rem}
                      .timeline-next{margin-top:1.25rem;font-size:0.9rem;color:var(--text)}
                      .timeline-next-label{display:inline-block;font-weight:700;color:var(--primary);margin-right:0.5rem;text-transform:uppercase;font-size:0.68rem;letter-spacing:0.05em}
                      .timeline-foot{margin-top:1rem;font-size:0.72rem;color:var(--text-muted);line-height:1.5}
                    </style>
                    <div class="card-label">Construction Permit Timeline</div>
                    <div class="timeline-scroll" role="region" aria-label="Permit timeline" tabindex="0"><div class="bs-timeline" style="--steps:${nodes.length}"><span class="bs-timeline__bar" style="width:${progress}"></span>${nodesHtml}</div></div>
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
    SELECT p.*, ${developmentSiteColumns()}, ds.boundary_geojson AS development_site_boundary,
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
    ${developmentSiteJoin()}
    LEFT JOIN addresses a ON a.id = p.address_id
    LEFT JOIN projects pr ON pr.id = p.project_id AND ${MULTI_PERMIT_PROJECT_SQL}
    WHERE p.permit_number = ?
  `,
    )
      .bind(permitNumber)
      .all());
  } catch {
    ({ results } = await env.DB.prepare(
      `
    SELECT p.*, ${developmentSiteColumns()}, ds.boundary_geojson AS development_site_boundary,
           c.name as contractor_name,
           c.slug as contractor_slug,
           c.specialty as contractor_specialty,
           c.phone as contractor_phone,
           c.email as contractor_email,
           c.website as contractor_website,
           c.address as contractor_address
    FROM permits p
    LEFT JOIN contractors c ON p.contractor_id = c.id
    ${developmentSiteJoin()}
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

  // Format permit type and promote the source description into the page's
  // search result title and first-screen context.
  const permitType = permitTypeLabel(permit.type);
  const issuedDate = permit.issued_date
    ? new Date(permit.issued_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "N/A";

  const officialDetailUrl = safeHttpUrl(permit.permit_detail_url);
  const peopleCards = [
    permit.owner_name
      ? `
	                <div class="bs-card">
	                    <div class="card-label">Property Owner</div>
	                    <div class="bs-card__title">${escapeHtml(permit.owner_name)}</div>
	                    ${permit.owner_address ? `<div style="font-size: 0.875rem; color: var(--text-muted); margin-top: 0.25rem;">${escapeHtml(permit.owner_address)}</div>` : ""}
	                </div>
	      `
      : "",
    permit.applicant_name
      ? `
	                <div class="bs-card">
	                    <div class="card-label">Applicant</div>
	                    <div class="bs-card__title">${escapeHtml(permit.applicant_name)}</div>
	                </div>
      `
      : "",
    permit.architect_name
      ? `
	                <div class="bs-card">
	                    <div class="card-label">Architect</div>
	                    <div class="bs-card__title">${escapeHtml(permit.architect_name)}</div>
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
    ["Property reference", permit.parcel_number],
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
                <div class="bs-card card-full">
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

  const valueFormatted = permit.value ? `$${parseInt(permit.value).toLocaleString()}` : "N/A";
  const permitDescriptor = permitSearchDescriptor(permit);
  const addressLabel = cleanFeedText(permit.address) || "Seattle";
  const permitAddressLabel = entStreet(addressLabel) || "Seattle";
  const safePermitNumber = escapeHtml(permit.permit_number || "Unknown permit");
  const serializedPermitNumber = JSON.stringify(String(permit.permit_number || "")).replace(/</g, "\\u003c");
  const safeAddress = escapeHtml(smartTitleCase(addressLabel) || "Unknown Address");
  const safeNeighborhood = escapeHtml(neighborhood);
  const safePermitType = escapeHtml(permitType);
  const safeTitleAddress = escapeHtml(permit.address || "Seattle");
  const safeDescription = escapeHtml(
    permit.detailed_description || permit.description || "No description available for this permit.",
  );
  const mapsQuery = encodeURIComponent(permit.address || "Seattle, WA");

  // Work highlight: SDCI's enriched "detailed description" is preferred over
  // the shorter scraped description because it commonly leads with the
  // tenant/project name (e.g. "MangoApps Tenant improvement...", "Sephora -
  // Downtown Seattle Construct alterations...") ahead of the same work
  // summary — exactly the specific, searchable detail that makes a
  // title/description/summary unique instead of generic.
  const rawWorkText = String(permit.detailed_description || permit.description || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,]?\s*per plans?\.?$/i, "")
    .replace(/[.,\s]+$/, "");
  const streetOnly = permit.address ? entStreet(permit.address) : "";
  const titleLocation = streetOnly ? `${smartTitleCase(streetOnly)}, Seattle` : "Seattle";
  const rawTitleHighlight =
    permitDescriptor || rawWorkText || `${permitType} (${permit.status || "Unknown"})`;
  // Keep the <title> reasonably tight so it isn't truncated in SERPs: the
  // work highlight absorbs the overflow, but the brand suffix always ships —
  // Google truncates long titles for display on its own, so a missing brand
  // suffix is worse than a slightly long title.
  const PERMIT_TITLE_MAX = 90;
  const brandSuffix = " | Building Seattle";
  const titlePrefix = `${titleLocation} — `;
  const highlightBudget = Math.max(20, PERMIT_TITLE_MAX - titlePrefix.length - brandSuffix.length);
  const pageTitle = `${titlePrefix}${truncateMetaDescription(rawTitleHighlight, highlightBudget)}${brandSuffix}`;
  const safeTitle = escapeHtml(pageTitle);

  // Build the meta description with the required facts (permit number/status)
  // always intact, and the contractor included whole or not at all — never
  // truncate the tail mid-name. Only the leading work/address snippet, which
  // is already word-boundary truncated, absorbs any remaining length overflow.
  const META_MAX = 165;
  const permitCore = `Permit ${permit.permit_number} (${permit.status || "status unknown"}).`;
  const contractorSuffix = permit.contractor_name ? ` Contractor: ${permit.contractor_name}.` : "";
  const coreWithContractor = `${permitCore}${contractorSuffix}`;
  const metaCore = coreWithContractor.length <= META_MAX - 30 ? coreWithContractor : permitCore;
  const metaLeadBudget = Math.max(20, META_MAX - metaCore.length - 1);
  const metaWorkSnippet = permitDescriptor || rawWorkText
    ? truncateMetaDescription(permitDescriptor || rawWorkText, Math.min(75, metaLeadBudget))
    : `${permitType} project`;
  const metaLead = truncateMetaDescription(`${metaWorkSnippet} at ${streetOnly || permit.address || "Seattle"}, Seattle.`, metaLeadBudget);
  const metaDesc = truncateMetaDescription(`${metaLead} ${metaCore}`, META_MAX);
  const safeMetaDesc = escapeHtml(metaDesc);

  // Concise, factual summary sentence rendered directly below the H1 so the
  // same facts a searcher was looking for (work scope, address, permit
  // number/status, contractor) are visible on the first screen, with links
  // into the verified address/contractor entity pages.
  const neighborhoodPhrase =
    neighborhood && neighborhood !== "Seattle" ? ` in ${safeNeighborhood}, Seattle` : " in Seattle";
  const summaryAddressHtml = permit.address_slug
    ? `<a href="/address/${encodeURIComponent(permit.address_slug)}" style="color:var(--accent);text-decoration:none;font-weight:600;">${safeAddress}</a>`
    : safeAddress;
  const summaryContractorHtml = permit.contractor_name
    ? ` Work is being performed by ${
        permit.contractor_slug
          ? `<a href="/contractor/${encodeURIComponent(permit.contractor_slug)}" style="color:var(--accent);text-decoration:none;font-weight:600;">${escapeHtml(permit.contractor_name)}</a>`
          : escapeHtml(permit.contractor_name)
      }.`
    : permit.work_performed_by === "Owner/Lessee"
      ? " Work is being performed by the property owner/lessee."
      : "";
  // Cap the lead clause so an unusually long scraped description can't turn
  // this "concise summary below the H1" into a duplicate of the full Project
  // Description card further down the page.
  const summaryWorkSnippet = rawWorkText ? truncateMetaDescription(rawWorkText, 220) : "";
  const summaryLeadText = summaryWorkSnippet
    ? summaryWorkSnippet.charAt(0).toUpperCase() + summaryWorkSnippet.slice(1)
    : `A ${permitType.toLowerCase()} project`;
  const permitSummaryHtml = `${escapeHtml(summaryLeadText)} at ${summaryAddressHtml}${neighborhoodPhrase}. Permit ${safePermitNumber} is ${escapeHtml((permit.status || "under review").toLowerCase())}${valueFormatted !== "N/A" ? `, valued at ${valueFormatted}` : ""}.${summaryContractorHtml}`;
  const permitJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Report",
        name: `Seattle construction permit ${permit.permit_number}`,
        headline: rawWorkText
          ? `${truncateMetaDescription(rawWorkText, 90)} — ${permit.address || "Seattle"}`
          : `${permitType} permit at ${permit.address || "Seattle"}`,
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
        ...(permit.contractor_name
          ? {
              contributor: {
                "@type": "Organization",
                name: permit.contractor_name,
                url: permit.contractor_slug ? `${BASE_URL}/contractor/${permit.contractor_slug}` : undefined,
              },
            }
          : {}),
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
    ? `<div class="bs-card card-full">
                    <div class="card-label">Explore This Record</div>
                    <div style="display:flex;flex-wrap:wrap;gap:1.5rem;margin-top:0.5rem;">
                        ${entityLinks.map((l) => `<div>${l}</div>`).join("")}
                    </div>
                </div>`
    : "";
  const firstScreenLinks = [
    permit.address_slug
      ? `<a href="/address/${encodeURIComponent(permit.address_slug)}" style="color:var(--accent);text-decoration:none;font-weight:650;">Address history: ${escapeHtml(permit.address_display || permit.address || "Property")}</a>`
      : "",
    permit.project_slug
      ? `<a href="/project/${encodeURIComponent(permit.project_slug)}" style="color:var(--accent);text-decoration:none;font-weight:650;">Project: ${escapeHtml(permit.project_name || "View project")}</a>`
      : "",
    permit.contractor_slug
      ? `<a href="/contractor/${encodeURIComponent(permit.contractor_slug)}" style="color:var(--accent);text-decoration:none;font-weight:650;">Contractor: ${escapeHtml(permit.contractor_name || "View contractor")}</a>`
      : "",
  ].filter(Boolean).join(" <span style=\"color:var(--text-subtle);\">·</span> ");


  if (wantsMarkdown(request)) {
    return markdownResponse(
      request,
      permitDetailMarkdown(permit, { neighborhood, permitType, valueFormatted, issuedDate, canonical }),
    );
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  ${themeBootScript()}
  <link rel="preload" href="/brand/fonts/IBMPlexSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/brand/fonts/IBMPlexSans-SemiBold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/brand/tokens.css">
  <link rel="stylesheet" href="/brand/bundle.css">
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
	    <title>${safeTitle}</title>
	    <meta name="description" content="${safeMetaDesc}">
	    <meta name="robots" content="index,follow,max-image-preview:large">
	    <link rel="canonical" href="${canonical}">
	    <meta property="og:title" content="${safeTitle}">
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
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family:var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
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
            font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
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
        .permit-summary {
            font-size: 1.0625rem;
            line-height: 1.65;
            color: var(--text);
            max-width: 62ch;
            margin: 1rem 0 0;
        }

        /* Grid Layout */
        .detail-grid {
            display: grid;
            grid-template-columns: minmax(0, 1fr);
            gap: 1.5rem;
        }
        @media (min-width: 768px) {
            .detail-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (min-width: 1024px) {
            .detail-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        }

        /* Cards */
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

        /* Footer */
	        footer {
	            background: var(--bg-alt);
	            border-top: 1px solid var(--border);
	            padding: 2rem 0;
	            text-align: center;
	            color: var(--text-muted);
	            font-size: 0.875rem;
	        }
	        .modal { border: 0; padding: 0; background: transparent; max-width: none; }
	        .modal::backdrop { background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); }
	        .lead-error { color: var(--danger-solid); font-size: 0.875rem; margin: 0.5rem 0 0; }
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
    <a class="skip-link" href="#main-content">Skip to content</a>
    ${renderNav("permits")}
	    <div class="container" style="padding-top:5.25rem;">
        <nav aria-label="breadcrumb" style="font-size:0.8125rem;color:var(--text-muted);">
	            <a href="/" style="color:var(--text-muted);text-decoration:none;">Home</a> <span style="margin:0 0.4rem;">/</span> <a href="/permits" style="color:var(--text-muted);text-decoration:none;">Permits</a> <span style="margin:0 0.4rem;">/</span> <span style="color:var(--text);font-weight:600;">Permit ${safePermitNumber}</span>
        </nav>
    </div>

    <main id="main-content">
        <div class="container">
            <div class="permit-header">
	                <div class="permit-number">PERMIT #<span class="bs-id">${safePermitNumber}</span></div>
	                <h1 class="permit-title">${safeAddress}</h1>
	                ${bsStatusPill(permit.status, humanize(permit.status, "Unknown"))}
                <p class="permit-summary">${permitSummaryHtml}</p>
	                ${firstScreenLinks ? `<nav aria-label="Related permit records" style="display:flex;flex-wrap:wrap;gap:0.5rem 0.9rem;margin:1rem 0 0;font-size:0.84rem;">${firstScreenLinks}</nav>` : ""}
            </div>
            <div class="detail-grid">
                <h2 class="card-full" style="font-size:1.5rem;font-weight:700;margin:1.5rem 0 0;color:var(--primary);grid-column:1/-1;">Permit Timeline &amp; Status</h2>
                ${timelineCard}
                ${entityLinksCard}
                <h2 class="card-full" style="font-size:1.5rem;font-weight:700;margin:1.5rem 0 0;color:var(--primary);grid-column:1/-1;">Project Overview</h2>
                <div class="bs-card">
                    <div class="card-label">Project Details</div>
                    <dl class="bs-dl" style="margin-top:0.75rem;">
                        <dt>Value</dt><dd class="bs-num">${valueFormatted}</dd>
                        <dt>Type</dt><dd>${safePermitType}</dd>
                        <dt>Issued</dt><dd>${issuedDate}</dd>
                        <dt>Location</dt><dd>${safeNeighborhood}</dd>
                    </dl>
                </div>

                <h2 class="card-full" style="font-size:1.5rem;font-weight:700;margin:1.5rem 0 0;color:var(--primary);grid-column:1/-1;">Contractor Information</h2>
                <div class="bs-card">
                    <div class="card-label">Contractor</div>
                    ${
                      permit.contractor_slug
                        ? `
	                        <a class="bs-card__title" style="display:block;color:var(--link);margin-top:0.5rem;text-decoration:none;" href="/contractor/${encodeURIComponent(permit.contractor_slug)}">${escapeHtml(permit.contractor_name || "View Contractor")}</a>
	                        ${permit.contractor_specialty ? `<div style="font-size: 0.875rem; color: var(--text-muted); margin-top: 0.25rem;">${escapeHtml(permit.contractor_specialty)}</div>` : ""}
	                        ${permit.contractor_license ? `<div style="font-size: 0.8125rem; color: var(--text-muted); margin-top: 0.25rem;">License ${escapeHtml(permit.contractor_license)}</div>` : ""}
	                        ${permit.contractor_phone ? `<div style="font-size: 0.8125rem; color: var(--text-muted); margin-top: 0.25rem;">${escapeHtml(permit.contractor_phone)}</div>` : ""}
	                        ${permit.contractor_email ? `<div style="font-size: 0.8125rem; color: var(--text-muted); margin-top: 0.25rem;">${escapeHtml(permit.contractor_email)}</div>` : ""}
                    `
                        : `
	                        <div class="bs-card__title" style="color: var(--text-muted); margin-top: 0.5rem;">${permit.work_performed_by === "Owner/Lessee" ? "Owner/Lessee" : "Not published by SDCI"}</div>
	                        ${permit.contractor_license ? `<div style="font-size: 0.8125rem; color: var(--text-muted); margin-top: 0.25rem;">License ${escapeHtml(permit.contractor_license)}</div>` : ""}
	                        ${permit.work_performed_by === "Owner/Lessee" ? "" : `<button type="button" onclick="openModal()" style="margin-top:0.75rem;background:none;border:none;padding:0;color:var(--accent);font-size:0.875rem;font-weight:600;cursor:pointer;text-align:left;">Get an email if a contractor is attached &rarr;</button>`}
                    `
                    }
                    ${peopleCards}
                </div>

                <h2 class="card-full" style="font-size:1.5rem;font-weight:700;margin:1.5rem 0 0;color:var(--primary);grid-column:1/-1;">Location &amp; Map</h2>
                ${developmentSitesArePublic(env) ? renderDevelopmentSiteCard(permit) : ""}
                <div class="bs-card" style="padding: 0; overflow: hidden;">
	                    <iframe title="Map of ${safeAddress}" width="100%" height="300" style="border: 0; display: block;" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade" src="https://maps.google.com/maps?q=${mapsQuery}&t=&z=17&ie=UTF8&iwloc=&output=embed"></iframe>
                    <div style="padding: 0.75rem 1rem; background: var(--bg-alt); border-top: 1px solid var(--border); display: flex; gap: 1rem; justify-content: center;">
	                        <a href="https://www.google.com/maps/search/?api=1&query=${mapsQuery}" target="_blank" rel="noopener" style="font-size: 0.8125rem; color: var(--accent); text-decoration: none; font-weight: 500;">Google Maps &rarr;</a>
	                        <a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${mapsQuery}" target="_blank" rel="noopener" style="font-size: 0.8125rem; color: var(--accent); text-decoration: none; font-weight: 500;">Street View &rarr;</a>
                    </div>
                </div>

                <div class="bs-card card-full description-card">
                    <div class="card-label">Project Description</div>
	                    <div class="description-text">${safeDescription}</div>
                </div>
                <h2 class="card-full" style="font-size:1.5rem;font-weight:700;margin:1.5rem 0 0;color:var(--primary);grid-column:1/-1;">Additional Details</h2>
                ${enrichmentCards}
            </div>

            <div class="actions">
                <button class="bs-btn bs-btn--primary" onclick="openModal()">${primaryLeadLabel}</button>
                ${
                  permit.contractor_slug
                    ? `<a href="/contractor/${encodeURIComponent(permit.contractor_slug)}" class="bs-btn bs-btn--secondary">View Contractor</a>`
                    : `<a href="https://www.google.com/maps/search/?api=1&query=${mapsQuery}" target="_blank" rel="noopener" class="bs-btn bs-btn--secondary">Open Map</a>`
                }
            </div>
            </div>
        </div>
    </main>

    <dialog id="leadModal" class="modal" aria-labelledby="leadModalTitle" aria-describedby="leadModalDescription">
        <div class="modal-content">
            <button class="modal-close" onclick="closeModal()" aria-label="Close dialog">&times;</button>
            <h3 id="leadModalTitle" style="margin-bottom:0.5rem;">${primaryLeadLabel}</h3>
            <p id="leadModalDescription" style="color:var(--text-muted);margin-bottom:1.5rem;font-size:0.9rem;">Get an email when permit ${safePermitNumber} changes status.</p>
            <form id="leadForm" onsubmit="submitLead(event)">
                <div class="form-group">
                    <label for="lead-email">Email *</label>
                    <input id="lead-email" type="email" name="email" required autocomplete="email" placeholder="you@example.com">
                    <p id="lead-error" class="lead-error hidden"></p>
                </div>
                <button type="submit" class="bs-btn bs-btn--primary" style="width:100%;">
                    <span id="submitText">Email Me Status Changes</span>
                    <span id="submitLoader" class="loader hidden"></span>
                </button>
            </form>
            <div id="formSuccess" class="hidden" style="text-align:center;padding:2rem;">
                <div style="font-size:3rem;margin-bottom:1rem;">&#10003;</div>
                <h4 id="formSuccessTitle" tabindex="-1">Check your inbox to confirm</h4>
                <p style="color:var(--text-muted);">The alert starts after you confirm your email address.</p>
            </div>
        </div>
    </dialog>

    ${renderFooter()}
    <script>
        var leadModal = document.getElementById('leadModal');
        var leadTrigger;
        function openModal() { leadTrigger = document.activeElement; leadModal.showModal(); var field = document.getElementById('lead-email'); if (field) field.focus(); }
        function closeModal() { leadModal.close(); }
        // Clicking the backdrop (the dialog box itself, outside .modal-content) closes it.
        leadModal.addEventListener('click', function(e) { if (e.target === leadModal) closeModal(); });
        leadModal.addEventListener('close', function() { if (leadTrigger && leadTrigger.focus) leadTrigger.focus(); });

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
                    document.getElementById('formSuccessTitle').focus();
                } else {
                    var result = await response.json().catch(function() { return {}; });
                    var failure = new Error('Submission failed');
                    failure.serverMessage = result.error;
                    throw failure;
                }
            } catch (err) {
                var errorEl = document.getElementById('lead-error');
                var emailField = document.getElementById('lead-email');
                errorEl.textContent = (err && err.serverMessage) || "We couldn't save your alert. Check your connection and try again.";
                errorEl.classList.remove('hidden');
                emailField.setAttribute('aria-invalid', 'true');
                emailField.setAttribute('aria-describedby', 'lead-error');
                emailField.focus();
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
  // Only contractors with active permit work qualify (the JOIN + HAVING do the
  // filtering), ranked by active project count.
  const results = await dbAll(
    env,
    `/* api:active-contractors */
     SELECT c.*, COUNT(p.id) AS active_projects
     FROM contractors c
     JOIN permits p
       ON c.id = p.contractor_id
      AND lower(COALESCE(p.status,'')) = 'active'
     GROUP BY c.id
     HAVING COUNT(p.id) > 0
     ORDER BY active_projects DESC, c.name ASC
     LIMIT 20`,
  );

  return new Response(JSON.stringify(results), {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}

async function getStats(env) {
  const stats = await getCanonicalStats(env);
  const avgValue = await dbFirst(
    env,
    `/* api:mean-permit-value */ SELECT AVG(value) AS avg_value FROM permits`,
  );

  return new Response(
    JSON.stringify({
      permits: stats.permits,
      contractors: stats.contractors,
      active_contractors: stats.active_contractors,
      active_permits: stats.active_permits,
      total_value: stats.total_value,
      avg_value: Number(avgValue?.avg_value) || 0,
      latest_record_date: stats.latest_record_date,
      last_ingest_at: stats.last_ingest_at,
      timestamp: new Date().toISOString(),
    }),
    {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=300",
      },
    },
  );
}

async function getAdminStats(env) {
  // entity_graph rows (rebuild outcomes) are listed in the dashboard log but are not
  // permit ingests: counting them would inflate growth and shift "last run".
  const [lastRun, growth24h, neighborhoods, performance, counts] = await Promise.all([
    env.DB.prepare("SELECT * FROM ingest_logs WHERE run_type NOT IN ('entity_graph', 'development_sites') ORDER BY start_time DESC LIMIT 1").first(),
    env.DB.prepare(
      "SELECT SUM(records_added) as added FROM ingest_logs WHERE start_time > datetime('now', '-1 day') AND run_type NOT IN ('entity_graph', 'development_sites')",
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
      WHERE run_type NOT IN ('entity_graph', 'development_sites')
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
  ${themeBootScript()}
  <link rel="preload" href="/brand/fonts/IBMPlexSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/brand/fonts/IBMPlexSans-SemiBold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/brand/tokens.css">
  <link rel="stylesheet" href="/brand/bundle.css">
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
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
              <div class="bs-card"><span class="label">Last Run</span><div class="value">${stats.last_run?.status || "N/A"}</div></div>
              <div class="bs-card"><span class="label">24h Growth</span><div class="value">+${stats.growth_24h}</div></div>
              <div class="bs-card"><span class="label">Total Permits</span><div class="value">${stats.total_counts.permits}</div></div>
              <div class="bs-card"><span class="label">Success Rate</span><div class="value">${Math.round(stats.performance?.success_rate || 0)}%</div></div>
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
      SELECT neighborhood, COUNT(*) as count, SUM(${countedValueSql("permits")}) as total_value
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
      `SELECT a.slug, a.display_address, COUNT(p.id) AS permits, COALESCE(SUM(${countedValueSql("p")}),0) AS total_value
       FROM permits p JOIN addresses a ON a.id = p.address_id
       WHERE p.contractor_id = ? GROUP BY a.id ORDER BY permits DESC LIMIT 12`,
      [contractor.id],
    ),
    safeAll(
      env,
      `SELECT DISTINCT pr.slug, pr.name, pr.latest_activity_date, pr.total_estimated_value
       FROM permits p JOIN projects pr ON pr.id = p.project_id AND ${MULTI_PERMIT_PROJECT_SQL}
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
  const shownPermits = permits.results.length;
  // metrics.total_count is the true total; the list query is capped at 10.
  const totalPermits = Math.max(Number(metrics.total_count) || 0, shownPermits);

  if (wantsMarkdown(request)) {
    return markdownResponse(
      request,
      contractorMarkdown(contractor, { permits: permits.results || [], activeProjects, completionRate, canonical }),
    );
  }

  const licenseStatusRaw = contractor.license_status ? String(contractor.license_status).trim() : "";
  const licenseStatusUpper = licenseStatusRaw.toUpperCase();
  const licenseBadgeColor =
    licenseStatusUpper === "ACTIVE"
      ? "var(--success)"
      : licenseStatusUpper === "EXPIRED"
        ? "var(--danger-solid)"
        : "var(--steel)";
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
    ? `<div class="bs-card">
          <h3 style="margin-top:0">WA L&amp;I Credentials</h3>
          ${
            licenseStatusRaw
              ? `<div style="display:inline-block;padding:0.25rem 0.75rem;border-radius:999px;background:${licenseBadgeColor};color:var(--surface);font-size:0.75rem;font-weight:700;letter-spacing:0.05em;margin-bottom:1rem">${escapeHtml(licenseStatusUpper)}</div>`
              : ""
          }
          ${contractor.license_number ? `<p style="margin:0.5rem 0;font-size:0.9375rem"><span style="color:var(--text-muted)">License</span> <span style="font-weight:600;font-family:monospace">${escapeHtml(contractor.license_number)}</span></p>` : ""}
          ${contractor.ubi ? `<p style="margin:0.5rem 0;font-size:0.9375rem"><span style="color:var(--text-muted)">UBI</span> <span style="font-weight:600;font-family:monospace">${escapeHtml(contractor.ubi)}</span></p>` : ""}
          ${insuranceFormatted ? `<p style="margin:0.5rem 0;font-size:0.9375rem"><span style="color:var(--text-muted)">Insurance</span> <span style="font-weight:600">${escapeHtml(insuranceFormatted)}</span>${insuranceExpiry ? ` <span style="color:var(--text-muted);font-size:0.8125rem">(through ${escapeHtml(insuranceExpiry)})</span>` : ""}</p>` : ""}
          <p style="margin:1rem 0 0;font-size:0.75rem;color:var(--text-muted)">Verified via WA Labor &amp; Industries</p>
        </div>`
    : "";
  const contractorDisplayName = smartTitleCase(contractor.name);
  const safeContractorName = escapeHtml(contractor.name);
  const safeContractorDisplayName = escapeHtml(contractorDisplayName);
  const fullContractorTitle = `${contractorDisplayName} — ${contractor.specialty || "Contractor"} | Building Seattle`;
  const contractorPageTitle =
    fullContractorTitle.length <= 60 ? fullContractorTitle : `${contractorDisplayName} | Building Seattle`;
  const safeContractorSpecialty = escapeHtml(contractor.specialty || "Contractor");
  // "General Contractor" already names the role, so don't append "contractor" again.
  const specialtyRole = contractor.specialty
    ? /contractor$/i.test(contractor.specialty.trim())
      ? contractor.specialty.trim()
      : `${contractor.specialty.trim()} contractor`
    : "construction contractor";
  const specialtyPhrase = `${/^[aeiou]/i.test(specialtyRole) ? "an" : "a"} ${specialtyRole}`;
  const topNeighborhoods = (marketFocus.results || []).map((f) => f.neighborhood).filter(Boolean);
  // Factual summary instead of placeholder copy when L&I has no description.
  const heroSummary = contractor.description
    ? contractor.description
    : [
        contractor.specialty || "Contractor",
        countLabel(totalPermits, "Seattle permit", "Seattle permits"),
        topNeighborhoods.length ? topNeighborhoods.join(", ") : null,
      ]
        .filter(Boolean)
        .join(" · ");
  const safeContractorMetaDescription = escapeHtml(
    `${contractorDisplayName}: ${specialtyRole.charAt(0).toUpperCase()}${specialtyRole.slice(1)} in Seattle, WA. ${countLabel(totalPermits, "permit", "permits")}, ${activeProjects} active. Permit timelines, review cycles & project history.`,
  );
  const permitListHeading =
    totalPermits > shownPermits
      ? `Recent permits (${shownPermits} of ${totalPermits.toLocaleString("en-US")})`
      : `Permits (${shownPermits})`;
  const dayUnit = (value) =>
    typeof value === "number"
      ? ` <span style="font-size:0.875rem; font-weight:400; color:#94a3b8">${new Intl.PluralRules("en-US").select(value) === "one" ? "day" : "days"}</span>`
      : "";
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
  ${themeBootScript()}
  <link rel="preload" href="/brand/fonts/IBMPlexSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/brand/fonts/IBMPlexSans-SemiBold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/brand/tokens.css">
  <link rel="stylesheet" href="/brand/bundle.css">
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(contractorPageTitle)}</title>
    <meta name="description" content="${safeContractorMetaDescription}">
    <meta name="robots" content="index,follow,max-image-preview:large">
    <link rel="canonical" href="${canonical}">
    <meta property="og:title" content="${escapeHtml(contractorPageTitle)}">
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
        body{font-family:var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);margin:0;background:var(--bg-alt);color:var(--text)}
        .container{max-width:var(--container-max);margin:0 auto;padding:0 1.5rem}
        .seo-hero{background:var(--brand-navy);color:white;padding:6rem 0 3rem;margin-top:4rem}
        .grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:3rem}
        .bs-card{margin-bottom:2rem}
        .bs-card .bs-metric__value{font-size:1.5rem;line-height:1.15}
        .entity-links{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:1.5rem;margin-top:1rem}
        .entity-links a{display:inline-block;padding-block:0.25rem;line-height:1.4;color:var(--accent);text-decoration:none}
        .entity-links a:hover,.permit-row a:hover{text-decoration:underline}
        .permit-row a{color:var(--accent);text-decoration:none}
        @media(max-width:768px){.grid{grid-template-columns:minmax(0,1fr)}}
    </style>
    <script type="application/ld+json">${contractorJsonLd}</script>
</head>
<body>
    <a class="skip-link" href="#main-content">Skip to content</a>
    ${renderNav()}

    <main id="main-content">
    <div class="seo-hero">
        <div class="container">
            <nav aria-label="breadcrumb" style="font-size:0.8125rem;color:#94a3b8;margin-bottom:1rem;">
                <a href="/" style="color:#94a3b8;text-decoration:none;">Home</a> <span style="margin:0 0.4rem;">/</span> <a href="/permits" style="color:#94a3b8;text-decoration:none;">Permits</a> <span style="margin:0 0.4rem;">/</span> <span style="color:#ffffff;font-weight:600;">${safeContractorDisplayName}</span>
            </nav>
            <div style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:2rem;">
                <div style="max-width:600px;min-width:0">
                    <div style="color:#94a3b8;font-size:0.875rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem">${safeContractorSpecialty}</div>
                    <h1 style="font-size:clamp(2rem,8vw,3rem);font-weight:800;line-height:1.1;letter-spacing:-0.02em;overflow-wrap:anywhere;margin:0 0 1rem 0">${safeContractorDisplayName}</h1>
                    <p style="font-size:1.25rem;color:#94a3b8;margin:0">${escapeHtml(heroSummary)}</p>
                </div>
                <div style="display:flex; gap:1.5rem;">
                    <div style="text-align:right">
                        <div style="font-size:0.75rem; color:#94a3b8; text-transform:uppercase; margin-bottom:0.25rem">Permit Speed</div>
                        <div style="font-size:1.5rem; font-weight:700;">${permitDays}${dayUnit(permitDays)}</div>
                    </div>
                    <div style="text-align:right">
                        <div style="font-size:0.75rem; color:#94a3b8; text-transform:uppercase; margin-bottom:0.25rem">Build Speed</div>
                        <div style="font-size:1.5rem; font-weight:700;">${buildDays}${dayUnit(buildDays)}</div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div class="container" style="padding:3rem 1.5rem">
        <div class="grid">
            <div>
                <div class="bs-card">
                    <h2>About ${safeContractorDisplayName}</h2>
                    <p style="font-size:1rem;line-height:1.6;color:var(--text-muted);margin:0 0 1rem 0;">
                        ${safeContractorDisplayName} is ${escapeHtml(specialtyPhrase)} operating in Seattle, Washington.
                        Based on Seattle DCI permit records, this contractor has been involved in ${countLabel(totalPermits, "permit", "permits")}
                        across Seattle's neighborhoods${activeProjects > 0 ? `, with ${activeProjects.toLocaleString("en-US")} currently active` : ""}.
                        ${metrics.total_count > 0 && typeof permitDays === "number" ? `Permits by this contractor average ${countLabel(permitDays, "day", "days")} from application to issuance${reviewCycles !== "—" ? `, with an average of ${reviewCycles} review ${reviewCycles === "1.0" ? "cycle" : "cycles"}` : ""}.` : ""}
                    </p>
                    <p style="font-size:1rem;line-height:1.6;color:var(--text-muted);margin:0;">
                        ${contractor.description
                          ? escapeHtml(contractor.description)
                          : `Contractors listed on Building Seattle are drawn from public SDCI permit data and may include general contractors, subcontractors, and specialty trades.`}
                    </p>
                </div>
                <div class="bs-card">
                    <h2>${permitListHeading}</h2>
                    ${permits.results
                      .map(
                        (p) => `
                        <div class="permit-row" style="padding:1rem 0;border-bottom:1px solid var(--border)">
                            <div style="font-weight:700"><a href="/permits/${encodeURIComponent(p.permit_number)}">${escapeHtml(p.address)}</a></div>
                            <div style="font-size:0.875rem;color:var(--text-muted)">${escapeHtml(p.type || "Unknown")} &bull; ${p.value ? `$${Number(p.value).toLocaleString("en-US")}` : "Value not reported"} &bull; ${escapeHtml(p.status)}</div>
                        </div>
                    `,
                      )
                      .join("")}
                </div>
                ${
                  graphAddresses.length || graphProjects.length
                    ? `<div class="bs-card">
                    <h3 style="margin-top:0">Addresses &amp; Projects</h3>
                    <div class="entity-links">
                      <div>
                        <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.5rem;font-weight:600;">Addresses worked on</div>
                        ${
                          graphAddresses.length
                            ? graphAddresses
                                .map(
                                  (a) =>
                                    `<div style="font-size:0.9rem;"><a href="/address/${encodeURIComponent(a.slug)}">${escapeHtml(a.display_address)}</a> <span style="color:var(--text-muted);font-size:0.8rem;">· ${countLabel(a.permits, "permit", "permits")}</span></div>`,
                                )
                                .join("")
                            : '<div style="color:var(--text-muted);font-size:0.85rem;">No linked addresses yet.</div>'
                        }
                      </div>
                      <div>
                        <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.5rem;font-weight:600;">Inferred projects</div>
                        ${
                          graphProjects.length
                            ? graphProjects
                                .map(
                                  (pr) =>
                                    `<div style="font-size:0.9rem;"><a href="/project/${encodeURIComponent(pr.slug)}">${escapeHtml(pr.name)}</a></div>`,
                                )
                                .join("")
                            : '<div style="color:var(--text-muted);font-size:0.85rem;">No multi-permit projects yet.</div>'
                        }
                      </div>
                    </div>
                </div>`
                    : ""
                }
            </div>
            <div>
                ${credentialsCard}
                <div class="bs-card">
                    <h3>Market Specialization</h3>
                    <div style="margin-top:1.5rem">
                        <div style="font-size:0.875rem; color:var(--text-muted); margin-bottom:0.75rem">Top Neighborhoods</div>
                        ${marketFocus.results
                          .map(
                            (f) => `
                            <div style="display:flex; justify-content:space-between; gap:1rem; margin-bottom:0.5rem; font-size:0.9375rem">
                                <span style="font-weight:600">${escapeHtml(f.neighborhood)}</span>
                                <span style="color:var(--text-muted);white-space:nowrap">${countLabel(f.count, "permit", "permits")}</span>
                            </div>
                        `,
                          )
                          .join("")}
                    </div>
                    <div style="margin-top:1.5rem; padding-top:1.5rem; border-top:1px solid var(--border)">
                        <div style="font-size:0.875rem; color:var(--text-muted); margin-bottom:0.75rem">Permit Mix</div>
                        <div style="display:flex; flex-wrap:wrap; gap:0.5rem">
                            ${projectTypes.results
                              .map(
                                (t) => `
                                <span style="background:var(--accent-soft); color:var(--link); padding:0.25rem 0.75rem; border-radius:999px; font-size:0.75rem; font-weight:600; text-transform:capitalize">${escapeHtml(t.type)}</span>
                            `,
                              )
                              .join("")}
                        </div>
                    </div>
                </div>

                <div class="bs-card" style="position:sticky;top:6rem">
                    <h3>Efficiency Metrics</h3>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem; margin:1.5rem 0">
                        <div class="bs-metric">
                            <div class="bs-metric__value">${completionRate}%</div>
                            <div class="bs-metric__label">Completion Rate</div>
                        </div>
                        <div class="bs-metric">
                            <div class="bs-metric__value">${activeProjects}</div>
                            <div class="bs-metric__label">Active Permits</div>
                        </div>
                        <div class="bs-metric">
                            <div class="bs-metric__value">${reviewCycles}</div>
                            <div class="bs-metric__label">Avg Review Cycles</div>
                        </div>
                        <div class="bs-metric">
                            <div class="bs-metric__value">${planReviewDays}</div>
                            <div class="bs-metric__label">Plan-Review Days</div>
                        </div>
                        <div class="bs-metric">
                            <div class="bs-metric__value">${correctionsDays}</div>
                            <div class="bs-metric__label">Days in Corrections</div>
                        </div>
                        <div class="bs-metric">
                            <div class="bs-metric__value" style="color:${netHousingUnits > 0 ? "var(--success)" : netHousingUnits < 0 ? "var(--danger-solid)" : "var(--accent)"}">${netHousingUnits > 0 ? "+" : ""}${netHousingUnits}</div>
                            <div class="bs-metric__label">Net Housing Units</div>
                        </div>
                    </div>

                    <div style="padding-top:1rem; border-top:1px solid var(--border)">
                        ${contractor.phone ? `<p style="margin:0.5rem 0">Phone <span style="font-weight:500">${escapeHtml(contractor.phone)}</span></p>` : ""}
                        ${contractor.email ? `<p style="margin:0.5rem 0">Email <span style="font-weight:500">${escapeHtml(contractor.email)}</span></p>` : ""}
                        ${contractorWebsite ? `<p style="margin:0.5rem 0">Web <a href="${escapeHtml(contractorWebsite)}" target="_blank" rel="noopener" style="color:var(--accent); text-decoration:none">${escapeHtml(contractorWebsite.replace("https://", "").replace("http://", ""))}</a></p>` : ""}
                    </div>
                </div>
            </div>
        </div>
    </div>
    </main>
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
         p.address_id, p.project_id,
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

// Like runEntityBatch, but each group of statements is kept whole inside one
// batch (transaction). A group larger than the chunk size runs alone.
async function runEntityGroups(env, groups) {
  const CHUNK = 50;
  let batch = [];
  for (const group of groups) {
    if (batch.length && batch.length + group.length > CHUNK) {
      await env.DB.batch(batch);
      batch = [];
    }
    batch.push(...group);
  }
  if (batch.length) await env.DB.batch(batch);
}

// Reads a whole table and, unlike safeAll, lets any D1 error propagate. The
// rebuild must never mistake a failed read for an empty table.
async function entityRows(env, sql) {
  return (await env.DB.prepare(sql).all()).results || [];
}

// Column values compare equal across SQLite type affinity (a stored 2026 vs a
// computed "2026"), so a row is only rewritten when its content really differs.
function sameStored(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return String(a) === String(b);
}

// Brings one derived table in line with `desired` without deleting anything:
// inserts rows whose natural key is new, updates rows whose content changed,
// and reports the ids of rows that are no longer wanted so the caller can drop
// them once nothing references them. Row ids of surviving entities never change.
async function syncEntityRows(env, { table, keyColumn, insertColumns, updateColumns, desired, existingRows }) {
  const existingByKey = new Map();
  for (const row of existingRows) {
    if (!existingByKey.has(row[keyColumn])) existingByKey.set(row[keyColumn], row);
  }
  const inserts = [];
  const updates = [];
  for (const row of desired) {
    const existing = existingByKey.get(row[keyColumn]);
    if (!existing) inserts.push(row);
    else if (updateColumns.some((column) => !sameStored(existing[column], row[column]))) {
      updates.push({ id: existing.id, row });
    }
  }

  const insertSql = `INSERT INTO ${table} (${insertColumns.join(", ")}) VALUES (${insertColumns.map(() => "?").join(", ")})`;
  await runEntityBatch(
    env,
    inserts.map((row) => env.DB.prepare(insertSql).bind(...insertColumns.map((column) => row[column] ?? null))),
  );
  const updateSql = `UPDATE ${table} SET ${updateColumns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`;
  await runEntityBatch(
    env,
    updates.map(({ id, row }) =>
      env.DB.prepare(updateSql).bind(...updateColumns.map((column) => row[column] ?? null), id),
    ),
  );

  const rows = inserts.length ? await entityRows(env, `SELECT id, ${keyColumn} FROM ${table} ORDER BY id`) : existingRows;
  const idByKey = new Map();
  for (const row of rows) {
    if (!idByKey.has(row[keyColumn])) idByKey.set(row[keyColumn], row.id);
  }
  const keepIds = new Set(desired.map((row) => idByKey.get(row[keyColumn])));
  return {
    idByKey,
    added: inserts.length,
    updated: updates.length,
    staleIds: rows.filter((row) => !keepIds.has(row.id)).map((row) => row.id),
  };
}

// Same idea for the join tables: add the pairs that are missing, remove the
// pairs that are no longer in the graph.
function planJoinRows(env, { table, columns, ownerColumn, desired, existingRows }) {
  const keyOf = (row) => columns.map((column) => row[column]).join("|");
  const wanted = new Map();
  for (const row of desired) {
    if (columns.every((column) => row[column] != null)) wanted.set(keyOf(row), row);
  }
  const have = new Set(existingRows.map(keyOf));
  const insertSql = `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  const deleteSql = `DELETE FROM ${table} WHERE ${columns.map((column) => `${column} = ?`).join(" AND ")}`;
  const missing = [...wanted].filter(([key]) => !have.has(key)).map(([, row]) => row);
  const stale = existingRows.filter((row) => !wanted.has(keyOf(row)));

  // A membership change is an insert of the new pair plus a delete of the old
  // one. Both go in the same D1 batch (one transaction) so a failure leaves each
  // owner (permit, project or address) with either its old rows or its new
  // rows, never both.
  const groups = new Map();
  const add = (row, statement) => {
    const owner = row[ownerColumn];
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(statement);
  };
  for (const row of missing) add(row, env.DB.prepare(insertSql).bind(...columns.map((column) => row[column])));
  for (const row of stale) add(row, env.DB.prepare(deleteSql).bind(...columns.map((column) => row[column])));
  return { groups, added: missing.length, removed: stale.length };
}

async function syncJoinRows(env, spec) {
  const plan = planJoinRows(env, spec);
  await runEntityGroups(env, [...plan.groups.values()]);
  return { added: plan.added, removed: plan.removed };
}

// Reconciles the derived entity graph with the permits table. Idempotent and
// non-destructive: nothing a public page reads is deleted or unlinked until
// its replacement already exists, so a failure part-way leaves the previous
// graph (plus some harmless extra rows) serving, and the next run finishes the
// job. Safe to call after imports or on a schedule. Any D1 error throws.
//
// Order of operations: insert/update entities -> relink permits -> sync join
// rows -> delete entities nothing references any more -> verify.
async function rebuildEntityGraph(env) {
  const startedAt = Date.now();
  const P = (sql) => env.DB.prepare(sql);
  const { results: permitRows } = await P(ENTITY_PERMIT_SELECT).all();
  const permits = permitRows || [];
  const [addrRows, orgRows, projRows, nbRows, projectPermitRows, permitParticipantRows, projectParticipantRows, addrNbRows] =
    await Promise.all([
      entityRows(env, "SELECT * FROM addresses ORDER BY id"),
      entityRows(env, "SELECT * FROM people_orgs ORDER BY id"),
      entityRows(env, "SELECT * FROM projects ORDER BY id"),
      entityRows(env, "SELECT * FROM neighborhoods ORDER BY id"),
      entityRows(env, "SELECT project_id, permit_id FROM project_permits"),
      entityRows(env, "SELECT permit_id, people_org_id, role FROM permit_participants"),
      entityRows(env, "SELECT project_id, people_org_id, role FROM project_participants"),
      entityRows(env, "SELECT address_id, neighborhood_id FROM address_neighborhoods"),
    ]);

  // A permits read that came back empty while entities exist is a failed read,
  // not a reason to delete the graph.
  if (!permits.length && (addrRows.length || projRows.length)) {
    throw new Error("Refusing to rebuild the entity graph from an empty permits table");
  }

  // Preserve already-minted slugs so existing entity URLs never change across
  // rebuilds: addresses/orgs/neighborhoods by their stable natural key,
  // projects by the permits they held (falling back to the join table for
  // permits whose own link was lost to an earlier failed run).
  const firstSlugBy = (rows, key) => {
    const map = new Map();
    for (const row of rows) if (!map.has(row[key])) map.set(row[key], row.slug);
    return map;
  };
  const projSlugById = new Map(projRows.map((row) => [row.id, row.slug]));
  const projectSlugByPermit = new Map();
  for (const permit of permits) {
    if (permit.project_id != null && projSlugById.has(permit.project_id)) {
      projectSlugByPermit.set(permit.id, projSlugById.get(permit.project_id));
    }
  }
  for (const row of projectPermitRows) {
    if (!projectSlugByPermit.has(row.permit_id) && projSlugById.has(row.project_id)) {
      projectSlugByPermit.set(row.permit_id, projSlugById.get(row.project_id));
    }
  }
  const graph = buildEntityGraph(permits, {
    addressSlugByNorm: firstSlugBy(addrRows, "normalized_address"),
    orgSlugByNorm: firstSlugBy(orgRows, "normalized_name"),
    neighborhoodSlugByName: firstSlugBy(nbRows, "name"),
    projectSlugByPermit,
    reservedProjectSlugs: projRows.map((row) => row.slug),
  });

  // 1. entities that other rows point at
  const addresses = await syncEntityRows(env, {
    table: "addresses",
    keyColumn: "normalized_address",
    insertColumns: ["slug", "normalized_address", "display_address", "city", "state", "zip", "lat", "lng"],
    updateColumns: ["display_address", "city", "state", "zip", "lat", "lng"],
    desired: graph.addresses,
    existingRows: addrRows,
  });
  const addrIdByTmp = new Map(graph.addresses.map((a) => [a.tmpId, addresses.idByKey.get(a.normalized_address)]));

  const orgs = await syncEntityRows(env, {
    table: "people_orgs",
    keyColumn: "normalized_name",
    insertColumns: ["slug", "name", "normalized_name", "type_guess"],
    updateColumns: ["name", "type_guess"],
    desired: graph.peopleOrgs,
    existingRows: orgRows,
  });
  const orgIdByTmp = new Map(graph.peopleOrgs.map((o) => [o.tmpId, orgs.idByKey.get(o.normalized_name)]));

  const neighborhoods = await syncEntityRows(env, {
    table: "neighborhoods",
    keyColumn: "name",
    insertColumns: ["slug", "name"],
    updateColumns: [],
    desired: graph.neighborhoods,
    existingRows: nbRows,
  });
  const nbIdByTmp = new Map(graph.neighborhoods.map((n) => [n.tmpId, neighborhoods.idByKey.get(n.name)]));

  const projects = await syncEntityRows(env, {
    table: "projects",
    keyColumn: "slug",
    insertColumns: [
      "slug", "address_id", "name", "description_summary", "confidence_score",
      "first_seen_date", "latest_activity_date", "total_estimated_value",
    ],
    // address_id is deliberately not updated here: an existing project moves to its
    // new address together with its permits' relinks (step 2), so a failure
    // part-way cannot leave the project at one address and its permits at another.
    updateColumns: [
      "name", "description_summary", "confidence_score",
      "first_seen_date", "latest_activity_date", "total_estimated_value",
    ],
    desired: graph.projects.map((p) => ({ ...p, address_id: addrIdByTmp.get(p.addressTmpId) ?? null })),
    existingRows: projRows,
  });
  const projIdByTmp = new Map(graph.projects.map((p) => [p.tmpId, projects.idByKey.get(p.slug)]));
  const storedProjectAddress = new Map(projRows.map((row) => [row.slug, row.address_id]));
  const projectAddressMoves = new Map(); // project id -> new address id
  for (const p of graph.projects) {
    const addressId = addrIdByTmp.get(p.addressTmpId) ?? null;
    if (storedProjectAddress.has(p.slug) && !sameStored(storedProjectAddress.get(p.slug), addressId)) {
      projectAddressMoves.set(projects.idByKey.get(p.slug), addressId);
    }
  }

  // project_permits mirrors permits.project_id, so a permit's join-row change is
  // committed in the same batch as its relink (below); only the rest is synced
  // in step 3.
  const projectPermitsPlan = planJoinRows(env, {
    table: "project_permits",
    ownerColumn: "permit_id",
    columns: ["project_id", "permit_id"],
    desired: graph.projects.flatMap((p) =>
      p.permitIds.map((permitId) => ({ project_id: projIdByTmp.get(p.tmpId), permit_id: permitId })),
    ),
    existingRows: projectPermitRows,
  });

  // 2. link permits back to their address + project, only where the stored
  // link differs. A permit moves straight from its old entity to its new one;
  // it is never parked on NULL in between. Statements are grouped per project so
  // a project that changes address commits with the relinks of its permits.
  const relinkedPermitIds = [];
  const linkGroups = new Map();
  const addToGroup = (key, statement) => {
    if (!linkGroups.has(key)) linkGroups.set(key, []);
    linkGroups.get(key).push(statement);
  };
  for (const [projectId, addressId] of projectAddressMoves) {
    addToGroup(`project:${projectId}`, P(`UPDATE projects SET address_id = ? WHERE id = ?`).bind(addressId, projectId));
  }
  let expectedLinked = 0;
  let expectedProjectLinked = 0;
  for (const permit of permits) {
    const addrTmp = graph.permitAddress.get(permit.id);
    const projTmp = graph.permitProject.get(permit.id);
    const addressId = addrTmp != null ? addrIdByTmp.get(addrTmp) ?? null : null;
    const projectId = projTmp != null ? projIdByTmp.get(projTmp) ?? null : null;
    if (addressId != null) expectedLinked += 1;
    if (projectId != null) expectedProjectLinked += 1;
    if (!sameStored(permit.address_id, addressId) || !sameStored(permit.project_id, projectId)) {
      relinkedPermitIds.push(permit.id);
      const groupKey = projectId != null ? `project:${projectId}` : `permit:${permit.id}`;
      addToGroup(groupKey, P(`UPDATE permits SET address_id = ?, project_id = ? WHERE id = ?`).bind(addressId, projectId, permit.id));
      for (const statement of projectPermitsPlan.groups.get(permit.id) || []) addToGroup(groupKey, statement);
      projectPermitsPlan.groups.delete(permit.id);
    }
  }
  await runEntityGroups(env, [...linkGroups.values()]);

  // 3. join tables
  const joins = {
    project_permits: await (async () => {
      await runEntityGroups(env, [...projectPermitsPlan.groups.values()]);
      return { added: projectPermitsPlan.added, removed: projectPermitsPlan.removed };
    })(),
    permit_participants: await syncJoinRows(env, {
      table: "permit_participants",
      ownerColumn: "permit_id",
      columns: ["permit_id", "people_org_id", "role"],
      desired: graph.permitParticipants.map((pp) => ({
        permit_id: pp.permit_id,
        people_org_id: orgIdByTmp.get(pp.orgTmpId),
        role: pp.role,
      })),
      existingRows: permitParticipantRows,
    }),
    project_participants: await syncJoinRows(env, {
      table: "project_participants",
      ownerColumn: "project_id",
      columns: ["project_id", "people_org_id", "role"],
      desired: graph.projectParticipants.map((pp) => ({
        project_id: projIdByTmp.get(pp.projectTmpId),
        people_org_id: orgIdByTmp.get(pp.orgTmpId),
        role: pp.role,
      })),
      existingRows: projectParticipantRows,
    }),
    address_neighborhoods: await syncJoinRows(env, {
      table: "address_neighborhoods",
      ownerColumn: "address_id",
      columns: ["address_id", "neighborhood_id"],
      desired: graph.addressNeighborhoods.map((an) => ({
        address_id: addrIdByTmp.get(an.addressTmpId),
        neighborhood_id: nbIdByTmp.get(an.nbTmpId),
      })),
      existingRows: addrNbRows,
    }),
  };

  // 4. drop entities that are no longer in the graph. The NOT EXISTS guards
  // keep a row that something still references (older production schemas
  // enforce permits.address_id as a foreign key), so a late-arriving link can
  // never turn into a failed delete or a dangling pointer.
  await runEntityBatch(
    env,
    projects.staleIds.map((id) =>
      P(`DELETE FROM projects WHERE id = ? AND NOT EXISTS (SELECT 1 FROM permits WHERE project_id = ?)`).bind(id, id),
    ),
  );
  await runEntityBatch(
    env,
    addresses.staleIds.map((id) =>
      P(
        `DELETE FROM addresses WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM permits WHERE address_id = ?)
           AND NOT EXISTS (SELECT 1 FROM projects WHERE address_id = ?)`,
      ).bind(id, id, id),
    ),
  );
  await runEntityBatch(env, orgs.staleIds.map((id) => P(`DELETE FROM people_orgs WHERE id = ?`).bind(id)));
  await runEntityBatch(env, neighborhoods.staleIds.map((id) => P(`DELETE FROM neighborhoods WHERE id = ?`).bind(id)));

  // 5. verify against the database itself, not against what we meant to write.
  // `ok` means every permit in the snapshot read at the start is linked. D1 has
  // no snapshot across batches, so a permit written by an ingest route while
  // this run is in flight is outside that contract: it is picked up by the next
  // run, and `snapshot_stale` says the permit count moved so the result is not
  // mistaken for a statement about those rows.
  const stored = await P(
    `SELECT (SELECT COUNT(*) FROM permits p JOIN addresses a ON a.id = p.address_id) AS linked,
            (SELECT COUNT(*) FROM permits p JOIN projects pr ON pr.id = p.project_id) AS project_linked,
            (SELECT COUNT(*) FROM permits) AS permits_now`,
  ).first();
  const linked = Number(stored?.linked) || 0;
  const projectLinked = Number(stored?.project_linked) || 0;
  const unlinked = Math.max(0, expectedLinked - linked);
  const projectUnlinked = Math.max(0, expectedProjectLinked - projectLinked);

  return {
    ok: unlinked === 0 && projectUnlinked === 0,
    snapshot_stale: Number(stored?.permits_now) !== permits.length,
    permits: permits.length,
    addresses: graph.addresses.length,
    people_orgs: graph.peopleOrgs.length,
    projects: graph.projects.length,
    permit_participants: graph.permitParticipants.length,
    neighborhoods: graph.neighborhoods.length,
    expected_linked: expectedLinked,
    linked,
    unlinked,
    expected_project_linked: expectedProjectLinked,
    project_linked: projectLinked,
    project_unlinked: projectUnlinked,
    changes: {
      addresses: { added: addresses.added, updated: addresses.updated, removed: addresses.staleIds.length },
      people_orgs: { added: orgs.added, updated: orgs.updated, removed: orgs.staleIds.length },
      projects: { added: projects.added, updated: projects.updated, removed: projects.staleIds.length },
      neighborhoods: { added: neighborhoods.added, updated: neighborhoods.updated, removed: neighborhoods.staleIds.length },
      permits_relinked: relinkedPermitIds.length,
      join_rows: joins,
    },
    duration_ms: Date.now() - startedAt,
  };
}

// Runs the rebuild and records the outcome in ingest_logs as its own row, so a
// partial or failed rebuild is visible without marking the (successful) permit
// ingest itself as failed. Status: running | success | partial (links missing) | error.
//
// The row is written as `running` BEFORE anything is mutated and updated at the
// end. /address/:slug refuses to answer 410 while the latest row is anything but
// `success`, so a run that dies, or whose final log write fails, still leaves the
// signal behind (a row stuck at `running` keeps empty addresses on 503 until the
// next run finishes). If the start marker cannot be written the run does not start.
async function runLoggedEntityGraphRebuild(env, source) {
  const startTime = new Date();
  const stamp = (date) => date.toISOString().replace("T", " ").split(".")[0];
  let logId = null;
  try {
    const started = await env.DB.prepare(
      `INSERT INTO ingest_logs (run_type, source, status, records_added, records_updated, start_time, end_time)
       VALUES ('entity_graph', ?, 'running', 0, 0, ?, ?)`,
    )
      .bind(source, stamp(startTime), stamp(startTime))
      .run();
    logId = started?.meta?.last_row_id ?? null;
  } catch (startError) {
    console.error("Could not record entity graph rebuild start; not running it:", startError);
    throw new Error(`entity graph rebuild not started: ${String(startError?.message || startError)}`);
  }

  let result = null;
  let failure = null;
  try {
    result = await rebuildEntityGraph(env);
  } catch (error) {
    failure = error;
    console.error("Entity graph rebuild failed:", error);
  }
  const status = failure ? "error" : result.ok ? "success" : "partial";
  const errorMessage = failure
    ? String(failure?.message || failure).slice(0, 500)
    : result.ok
      ? null
      : `${result.unlinked} of ${result.expected_linked} permits unlinked from addresses; ${result.project_unlinked} unlinked from projects`;
  if (status !== "success") console.error(`Entity graph rebuild ${status}: ${errorMessage}`);
  const added = result ? result.changes.addresses.added : 0;
  const updated = result ? result.changes.permits_relinked : 0;
  try {
    if (logId != null) {
      await env.DB.prepare(
        `UPDATE ingest_logs SET status = ?, records_added = ?, records_updated = ?, error_message = ?, end_time = ? WHERE id = ?`,
      )
        .bind(status, added, updated, errorMessage, stamp(new Date()), logId)
        .run();
    } else {
      await logIngest(env, {
        run_type: "entity_graph",
        source,
        status,
        records_added: added,
        records_updated: updated,
        error_message: errorMessage,
        start_time: startTime,
        end_time: new Date(),
      });
    }
  } catch (logError) {
    // the row stays `running`, which the empty-address guard treats as untrusted
    console.error("Could not record entity graph rebuild outcome in ingest_logs:", logError);
  }
  if (failure) throw failure;
  return result;
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

  // null (not 0) when the query fails, so a broken check never reads as healthy.
  const count = async (sql) => {
    try {
      const row = await env.DB.prepare(sql).first();
      const n = Number(row?.n);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
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
    lastRebuild,
    permitsWithoutAddress,
    permitsDanglingAddress,
    permitsDanglingProject,
    addressesWithoutPermits,
    projectsWithoutPermits,
  ] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM addresses`),
    one(`SELECT COUNT(*) AS n FROM people_orgs`),
    one(`SELECT COUNT(*) AS n FROM projects`),
    one(`SELECT COUNT(*) AS n FROM permits`),
    one(`SELECT COUNT(*) AS n FROM permits WHERE project_id IS NOT NULL`),
    one(`SELECT COUNT(*) AS n FROM permits WHERE project_id IS NULL`),
    one(`SELECT COUNT(*) AS n FROM neighborhoods`),
    many(
      `SELECT a.display_address, a.slug, COUNT(p.id) AS permits, COALESCE(SUM(${countedValueSql("p")}),0) AS total_value
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
    one(`SELECT status, error_message, end_time FROM ingest_logs
         WHERE run_type = 'entity_graph' ORDER BY start_time DESC, id DESC LIMIT 1`),
    count(`SELECT COUNT(*) AS n FROM permits WHERE address_id IS NULL`),
    count(`SELECT COUNT(*) AS n FROM permits p LEFT JOIN addresses a ON a.id = p.address_id
           WHERE p.address_id IS NOT NULL AND a.id IS NULL`),
    count(`SELECT COUNT(*) AS n FROM permits p LEFT JOIN projects pr ON pr.id = p.project_id
           WHERE p.project_id IS NOT NULL AND pr.id IS NULL`),
    count(`SELECT COUNT(*) AS n FROM addresses a
           WHERE NOT EXISTS (SELECT 1 FROM permits p WHERE p.address_id = a.id)`),
    count(`SELECT COUNT(*) AS n FROM projects pr
           WHERE NOT EXISTS (SELECT 1 FROM permits p WHERE p.project_id = pr.id)`),
  ]);

  // Every figure here should be 0 after a healthy rebuild. Any permit without
  // an address link means /address/:slug cannot be trusted to answer 410.
  const integrityChecks = {
    permits_without_address: permitsWithoutAddress,
    permits_with_dangling_address: permitsDanglingAddress,
    permits_with_dangling_project: permitsDanglingProject,
    addresses_without_permits: addressesWithoutPermits,
    projects_without_permits: projectsWithoutPermits,
  };
  const integrity = {
    ok: Object.values(integrityChecks).every((value) => value === 0),
    ...integrityChecks,
    last_rebuild: lastRebuild?.status
      ? { status: lastRebuild.status, error_message: lastRebuild.error_message || null, at: lastRebuild.end_time || null }
      : null,
  };

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
    integrity,
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
    : dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function entStreet(displayAddress) {
  return String(displayAddress || "").split(",")[0].trim() || String(displayAddress || "");
}

function entStyles() {
  return `<style>
    body{font-family:var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);margin:0;background:var(--bg-alt);color:var(--text);line-height:1.6}
    .container{max-width:var(--container-max);margin:0 auto;padding:0 1.5rem}
    .ent-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:2.5rem;align-items:start}
    @media(max-width:860px){.ent-grid{grid-template-columns:minmax(0,1fr)}}
    .table-scroll{overflow-x:auto;max-width:100%}
    .bs-card{margin-bottom:1.75rem;box-sizing:border-box}
    .bs-card h2{font-size:1.25rem;margin:0 0 1rem}
    .bs-card h3{font-size:1rem;margin:0 0 0.75rem}
    .stat-row .bs-metric__value{font-size:1.4rem;line-height:1.15}
    .stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:0.85rem;margin:1rem 0}
    .ent-list{list-style:none;margin:0;padding:0}
    .ent-list li{padding:0.75rem 0;border-bottom:1px solid var(--border)}
    .ent-list li:last-child{border-bottom:none}
    a.ent-link{color:var(--accent);text-decoration:none;font-weight:600}
    a.ent-link:hover{text-decoration:underline}
    table.ent{width:100%;border-collapse:collapse;font-size:0.875rem}
    table.ent th{text-align:left;color:var(--text-muted);font-weight:600;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;padding:0.5rem 0.75rem;border-bottom:1px solid var(--border)}
    table.ent td{padding:0.6rem 0.75rem;border-bottom:1px solid var(--border);vertical-align:top}
    .pill{display:inline-block;padding:0.15rem 0.6rem;border-radius:999px;font-size:0.7rem;font-weight:700;background:var(--accent-soft);color:var(--link);text-transform:capitalize}
    .ent-hero{margin-bottom:1.5rem}
    .ent-hero h1{font-size:2rem;font-weight:800;margin:0 0 0.5rem;color:var(--primary)}
    .ent-kicker{color:var(--text-muted);font-size:0.8rem;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:0.4rem}
  </style>`;
}

function entBreadcrumb(items) {
  const parts = items
    .map((it) =>
      it.href
        ? `<a href="${escapeHtml(it.href)}" style="color:var(--text-muted);text-decoration:underline;text-underline-offset:2px;">${escapeHtml(it.label)}</a>`
        : `<span style="color:var(--text);font-weight:600;">${escapeHtml(it.label)}</span>`,
    )
    .join(' <span style="margin:0 0.4rem;color:var(--text-subtle);">/</span> ');
  return `<nav aria-label="breadcrumb" style="font-size:0.8125rem;margin-bottom:1.5rem;">${parts}</nav>`;
}

function entStat(label, value) {
  return `<div class="bs-metric"><span class="bs-metric__value">${value}</span><span class="bs-metric__label">${escapeHtml(label)}</span></div>`;
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
        <div class="bs-card">
          <h2>Review timeline</h2>
          <div class="stat-row">${stats.join("")}</div>
          <p style="font-size:0.8rem;color:var(--text-muted);margin:0;">Plan-review metrics aggregated across this project's permits, from Seattle DCI. "City control days" is total plan-review days minus the days applicants held permits for corrections.</p>
        </div>`;
}

function renderBasisResetUnavailable() {
  const html = renderEntityDoc({
    title: "Basis Reset Radar | Building Seattle",
    description: "Seattle properties where a lower basis and existing development work may change redevelopment economics.",
    canonical: `${BASE_URL}/insights/basis-reset`,
    noindex: true,
    activeNav: "insights",
    body: `${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Insights", href: "/insights" }, { label: "Basis Reset Radar" }])}
      <div class="ent-hero"><h1>Basis Reset Radar</h1></div>
      <div class="bs-card"><h2>Temporarily unavailable</h2><p>The radar's scores aren't loading right now. Try again later, or explore the <a class="ent-link" href="/insights">other Seattle permit insights</a>.</p></div>`,
  });
  return new Response(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Retry-After": "3600", "Cache-Control": "no-store" },
  });
}

function renderEntityDoc({ title, description, canonical, jsonLd, noindex, ogType = "website", body, activeNav = "permits" }) {
  const metaDescription = truncateMetaDescription(description);
  const socialImage = `${BASE_URL}/social/${socialImageForCanonical(canonical)}.png`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${themeBootScript()}
  <link rel="preload" href="/brand/fonts/IBMPlexSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/brand/fonts/IBMPlexSans-SemiBold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/brand/tokens.css">
  <link rel="stylesheet" href="/brand/bundle.css">
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
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
    <a class="skip-link" href="#main-content">Skip to content</a>
    ${renderNav(activeNav)}
    <div class="global-nav-spacer"></div>
    <main class="container" id="main-content" style="padding:2rem 1.5rem 4rem;">
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
        <td>${p.status ? bsStatusPill(p.status, humanize(p.status)) : "—"}</td>
        <td>${entDate(p.issued_date || p.applied_date)}</td>
      </tr>`,
    )
    .join("");
  return `<div class="table-scroll" role="region" aria-label="Permits" tabindex="0"><table class="ent"><thead><tr><th>Permit</th><th>Type</th><th>Value</th><th>Status</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
// A cluster of one permit is not a project: it repeats the record its address
// page already publishes. Only multi-permit clusters are listed, linked, and
// advertised as projects; single-permit cluster pages canonicalize onto the
// address page instead. `pr` is the projects alias in every query using this.
const MULTI_PERMIT_PROJECT_SQL =
  "(SELECT COUNT(*) FROM project_permits mpp WHERE mpp.project_id = pr.id) > 1";
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
  if (type === "projects") havingParts.push(MULTI_PERMIT_PROJECT_SQL);
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
    havingParts.push(`COALESCE(SUM(${countedValueSql("p")}), 0) >= ?`);
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
      <label>Permit type<input name="permit_type" value="${escapeHtml(state.permitType)}" maxlength="80" placeholder="e.g. Construction"></label>` : "";
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
      <button type="submit">Apply filters</button>
      <a class="ent-link" href="/${type}">Clear filters</a>
    </form>`;
}

async function renderEntityHubPage(type, env, request) {
  const config = ENTITY_HUBS[type];
  if (!config) return render404();

  const state = buildEntityHubState(type, request);
  const query = buildEntityHubQuery(type, state);
  let items = [];
  let queryFailed = false;
  try {
    const result = await env.DB.prepare(query.sql).bind(...query.binds).all();
    items = result.results || [];
  } catch (error) {
    queryFailed = true;
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
      return `<article class="bs-card">
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
      .hub-filters select,.hub-filters input,.hub-filters button{width:100%;min-width:0;box-sizing:border-box;height:2.75rem;border:1px solid var(--steel);border-radius:.65rem;padding:0 .75rem;background:var(--bg);color:var(--text);font:inherit;font-size:1rem;text-transform:none;letter-spacing:normal}
      .hub-filters input::placeholder{color:var(--text-muted);font-weight:400}.hub-filters input:not(:placeholder-shown),.hub-filters select{font-weight:500}.hub-filters .ent-link{display:inline-flex;align-items:center;height:2.75rem}.hub-filters button{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:750;cursor:pointer}
    </style>
    <nav aria-label="Breadcrumb" style="font-size:0.8125rem;margin-bottom:1.25rem;"><a class="ent-link" href="/">Home</a> / ${escapeHtml(config.title)}</nav>
    <header style="max-width:800px;margin-bottom:2rem;"><h1>${escapeHtml(config.title)}</h1><p style="font-size:1.08rem;color:var(--text-muted);line-height:1.7;">${escapeHtml(config.intro)}</p></header>
    ${renderEntityHubFilters(type, state)}
    ${items.length ? `<p style="color:var(--text-muted);">Page ${state.page}: showing ${items.length} ${config.itemLabel} from current public permit records.</p><section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1rem;">${cards}</section>${pagination}` : queryFailed ? `<div class="bs-card"><h2>Listings are temporarily unavailable</h2><p>We couldn't load ${escapeHtml(config.itemLabel)} right now. Try again in a few minutes.</p></div>` : `<div class="bs-card"><h2>No matching ${escapeHtml(config.itemLabel)}</h2><p>No ${escapeHtml(config.itemLabel)} match these filters. <a class="ent-link" href="/${type}">View all ${escapeHtml(config.itemLabel)}</a></p></div>`}
    ${renderDataTrustNote(updatedThrough, "Hub rankings aggregate public permit records; declared value is not verified project cost.")}`;

  return new Response(
    renderEntityDoc({
      title: `${config.title} | Building Seattle`,
      description: config.description,
      canonical,
      jsonLd,
      noindex: items.length === 0 || state.hasFilters,
      body,
      activeNav: type,
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
      @media(max-width:600px){.pr-row{grid-template-columns:minmax(72px,120px) minmax(0,1fr) auto}.pr-sub{display:block;white-space:normal}}
      .ins-tabs{display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:1.5rem}
      .ins-tab{padding:0.4rem 0.9rem;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--text);text-decoration:none;font-size:0.82rem;font-weight:600}
      .ins-tab.active{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
      .ins-card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1.25rem}
      .ins-feature{display:block;text-decoration:none;color:inherit}
      .ins-feature .bs-card{height:100%;box-sizing:border-box;margin:0;display:flex;flex-direction:column;}.ins-feature .ins-stat{margin-top:auto;padding-top:.25rem}.ins-feature .bs-card{transition:box-shadow .2s ease,transform .2s ease}
      .ins-feature:hover .bs-card{box-shadow:var(--shadow-2);border-color:var(--line-strong)}
      .nb-contractor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem;margin-top:1rem}
      .nb-contractor-card{border:1px solid var(--border);border-radius:16px;background:var(--bg);padding:1rem}
      .nb-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--border);padding-bottom:0.75rem;margin-bottom:0.75rem}
      .nb-card-head h3{margin:0;font-size:1rem;color:var(--text)}
      .nb-card-head span{color:var(--text-muted);font-size:0.78rem;font-weight:700;white-space:nowrap}
      .nb-contractor-card ol{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:0.55rem}
      .nb-contractor-row{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:0.6rem;font-size:0.84rem}
      .nb-rank{display:inline-flex;align-items:center;justify-content:center;width:1.45rem;height:1.45rem;border-radius:999px;background:var(--accent-soft);color:var(--link);font-weight:800;font-size:0.72rem}
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
    <div class="bs-card" style="text-align:center;padding:3rem 1.75rem;">
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
    <div class="bs-card">
      <div class="stat-row">
        ${entStat("Permits analyzed", s.count.toLocaleString())}
        ${entStat("Median review", `${s.median} days`)}
        ${entStat("Average review", `${s.mean} days`)}
        ${entStat("90th percentile", `${s.p90} days`)}
        ${entStat("Avg review cycles", data.avg_cycles != null ? data.avg_cycles.toFixed(1) : "N/A")}
      </div>
      <p class="pr-note">Half of permits clear review in ${s.median} days or less, but the slowest 10% take ${s.p90}+ days — the gap is where projects stall.</p>
    </div>
    <div class="bs-card">
      <h2>How to read these numbers</h2>
      <p class="pr-note">Plan around the median, budget around the 90th percentile. The average runs higher than the median because a long tail of complex projects — structural changes, new uses, landmark review — pulls it up. And each round of city review comments resets the clock while corrections are prepared, so the review-cycles figure matters as much as raw days.</p>
    </div>
    <div class="bs-card">
      <h2>Distribution of plan-review time</h2>
      ${prBarChart(histogramRows)}
    </div>
    <div class="ent-grid">
      <div class="bs-card">
        <h2>Average review time by permit type</h2>
        ${prBarChart(typeRows)}
      </div>
      <div class="bs-card">
        <h2>Review cycles per permit</h2>
        ${prBarChart(cycleRows, "var(--success)")}
        <p class="pr-note">Each correction cycle adds a round-trip with reviewers. ${
          data.avg_days_out_corrections != null
            ? `Permits sit out for corrections about ${Math.round(data.avg_days_out_corrections)} days on average.`
            : ""
        }</p>
      </div>
    </div>
    <div class="bs-card">
      <h2>Slowest neighborhoods by average review time</h2>
      <p style="color:var(--text-muted);margin-top:0;font-size:0.85rem;">Neighborhoods with at least 3 reviewed permits, ranked by longest average review.</p>
      ${prBarChart(neighborhoodRows, "var(--amber)")}
    </div>
    <div class="bs-card">
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

// ADU/DADU timeline rows, shared by the pipeline API and the ADU tracker page.
async function getAduTimelineRows(env) {
  const issuedFunnel =
    "applied_date IS NOT NULL AND applied_date != '' AND issued_date IS NOT NULL AND issued_date != '' AND julianday(issued_date) >= julianday(applied_date)";
  const completedFunnel =
    "issued_date IS NOT NULL AND issued_date != '' AND completed_date IS NOT NULL AND completed_date != '' AND julianday(completed_date) >= julianday(issued_date)";
  const aduWhere = "adu_type IN ('ADU', 'DADU')";
  const [aduStage, aduDays, aduCompletedDays, aduByYear, aduRecent] = await Promise.all([
      safeAll(
        env,
        `/* pipeline:adu-stage */
         SELECT adu_type,
                COUNT(*) AS cnt,
                SUM(CASE WHEN applied_date IS NOT NULL AND applied_date != '' THEN 1 ELSE 0 END) AS applied,
                SUM(CASE WHEN issued_date IS NOT NULL AND issued_date != '' THEN 1 ELSE 0 END) AS issued,
                SUM(CASE WHEN completed_date IS NOT NULL AND completed_date != '' THEN 1 ELSE 0 END) AS completed
         FROM permits WHERE ${aduWhere} GROUP BY adu_type`,
      ),
      safeAll(
        env,
        `/* pipeline:adu-days */
         SELECT adu_type, CAST(julianday(issued_date) - julianday(applied_date) AS REAL) AS d
         FROM permits WHERE ${aduWhere} AND ${issuedFunnel}`,
      ),
      safeAll(
        env,
        `/* pipeline:adu-completed-days */
         SELECT adu_type, CAST(julianday(completed_date) - julianday(issued_date) AS REAL) AS d
         FROM permits WHERE ${aduWhere} AND ${completedFunnel}`,
      ),
      safeAll(
        env,
        `/* pipeline:adu-by-year */
         SELECT adu_type, substr(COALESCE(NULLIF(issued_date,''),applied_date),1,4) AS yr,
                COUNT(*) AS cnt,
                ROUND(AVG(julianday(issued_date) - julianday(applied_date)), 0) AS avg_days
         FROM permits WHERE ${aduWhere} AND ${issuedFunnel}
         GROUP BY adu_type, yr ORDER BY yr ASC`,
      ),
      safeAll(
        env,
        `/* pipeline:adu-recent */
         SELECT p.permit_number, p.address, p.adu_type, a.slug AS address_slug, a.display_address
         FROM permits p LEFT JOIN addresses a ON a.id = p.address_id
         WHERE p.adu_type IN ('ADU', 'DADU') AND a.slug IS NOT NULL AND a.slug != ''
         ORDER BY COALESCE(p.issued_date, p.applied_date, p.created_at) DESC
         LIMIT 8`,
      ),
    ]);
  return { aduStage, aduDays, aduCompletedDays, aduByYear, aduRecent };
}

async function getAduTimeline(env) {
  const rows = await getAduTimelineRows(env);
  return summarizeAduTimeline({
    stageRows: rows.aduStage,
    dayRows: rows.aduDays,
    completedDayRows: rows.aduCompletedDays,
    byYearRows: rows.aduByYear,
    recentRows: rows.aduRecent,
  });
}

async function getPipelineData(env) {
  const issuedFunnel =
    "applied_date IS NOT NULL AND applied_date != '' AND issued_date IS NOT NULL AND issued_date != '' AND julianday(issued_date) >= julianday(applied_date)";
  const completedFunnel =
    "issued_date IS NOT NULL AND issued_date != '' AND completed_date IS NOT NULL AND completed_date != '' AND julianday(completed_date) >= julianday(issued_date)";

  const [stageRow, appliedToIssued, issuedToCompleted, byTypeTiming, aduTimeline] =
    await Promise.all([
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
      getAduTimeline(env),
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
    adu_timeline: aduTimeline,
  };
}

// Aggregates ADU/DADU pipeline-stage counts and application→issuance /
// issuance→completion durations (pure; safe to unit-test).
export function summarizeAduTimeline({ stageRows = [], dayRows = [], completedDayRows = [], byYearRows = [], recentRows = [] } = {}) {
  const bucket = (type) => {
    const stage = stageRows.find((r) => r.adu_type === type) || {};
    const days = dayRows.filter((r) => r.adu_type === type).map((r) => r.d);
    const completedDays = completedDayRows.filter((r) => r.adu_type === type).map((r) => r.d);
    const applied = Number(stage.applied) || 0;
    const issued = Number(stage.issued) || 0;
    const completedCount = Number(stage.completed) || 0;
    return {
      count: Number(stage.cnt) || 0,
      applied,
      issued,
      completed: completedCount,
      issue_rate: applied ? Math.min(100, Math.round((issued / applied) * 100)) : 0,
      completion_rate: issued ? Math.min(100, Math.round((completedCount / issued) * 100)) : 0,
      applied_to_issued: summarizeDays(days),
      issued_to_completed: summarizeDays(completedDays),
    };
  };
  return {
    ADU: bucket("ADU"),
    DADU: bucket("DADU"),
    by_year: byYearRows
      .filter((r) => r.yr)
      .map((r) => ({
        adu_type: r.adu_type,
        year: String(r.yr),
        count: Number(r.cnt) || 0,
        avg_days: Math.round(Number(r.avg_days) || 0),
      })),
    recent: recentRows.map((r) => ({
      permit_number: r.permit_number,
      address: r.address || null,
      adu_type: r.adu_type || null,
      address_slug: r.address_slug || null,
      display_address: r.display_address || null,
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

  // This page owns the GENERAL "seattle permit pipeline" intent; ADU-specific
  // timing lives on /insights/adu-dadu so the two pages don't cannibalize.
  const title = "Seattle Permit Pipeline: Applied, Issued & Completed";
  const description =
    "Where Seattle building permits stand: application, issuance, and completion funnel with median days in each stage and timing by permit type, from public SDCI records.";

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Dataset",
        name: "Seattle Building Permit Pipeline",
        description,
        url: canonical,
        creator: { "@type": "Organization", name: "Building Seattle" },
        spatialCoverage: { "@type": "Place", name: "Seattle, Washington" },
        ...(freshness?.updated_through ? { dateModified: dateOrNull(freshness.updated_through) || undefined } : {}),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Insights", item: `${BASE_URL}/insights` },
          { "@type": "ListItem", position: 3, name: "Permit pipeline", item: canonical },
        ],
      },
    ],
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
    <div class="bs-card" style="text-align:center;padding:3rem 1.75rem;">
      <h2 style="margin-top:0;">No pipeline data yet</h2>
      <p style="color:var(--text-muted);max-width:42ch;margin:0 auto;">Pipeline timing comes from permit application, issue, and completion dates. Check back once permits have been ingested.</p>
    </div>`;

  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Insights", href: "/insights" }, { label: "Permit Pipeline" }])}
    ${insightsStyles()}
    ${insightsTabs("pipeline")}
    <div class="ent-hero">
      <div class="ent-kicker">Permit pipeline</div>
      <h1>Seattle's permit pipeline, from application to completion</h1>
      <p style="color:var(--text-muted);max-width:65ch;margin:0;">Every Seattle building permit moves through the same funnel — application, issuance, completion. This is where the whole pipeline stands right now, computed from public SDCI records.</p>
    </div>
    ${
      hasData
        ? `<div class="bs-card">
      <h2>What the funnel says</h2>
      <p>Of ${st.applied.toLocaleString()} Seattle permits with an application date in the dataset, ${st.issued.toLocaleString()} have been issued — an issue rate of ${data.issue_rate}%. Permits that do issue take a median of ${data.applied_to_issued.median} days from application (average ${data.applied_to_issued.mean} days; the slowest decile takes ${data.applied_to_issued.p90} days or more).</p>
      <p>After issuance, ${data.completion_rate}% of permits are marked complete, with a median of ${data.issued_to_completed.median} days of construction time. Permits that never issue don't disappear from this funnel — they keep the applied count honest, which is why the issue rate is the number to watch.</p>
    </div>`
        : ""
    }
    <div class="bs-card">
      <h2>Looking for ADU timelines?</h2>
      <p>Accessory dwelling unit permits have their own tracker with median application-to-issuance times, step-by-step duration breakdowns, and activity by year and neighborhood.</p>
      <p><a class="ent-link" href="/insights/adu-dadu">See the ADU &amp; DADU permit timeline and tracker &rarr;</a></p>
    </div>
    ${
      hasData
        ? `
    <div class="bs-card">
      <div class="stat-row">
        ${entStat("Applied", st.applied.toLocaleString())}
        ${entStat("Issued", st.issued.toLocaleString())}
        ${entStat("Completed", st.completed.toLocaleString())}
        ${entStat("Issue rate", `${data.issue_rate}%`)}
        ${entStat("Median to issue", `${data.applied_to_issued.median} days`)}
      </div>
    </div>
    <div class="bs-card">
      <h2>Pipeline funnel (all permits)</h2>
      ${prBarChart(funnelRows)}
      <p class="pr-note">${data.issue_rate}% of applied permits reach issuance${
        data.completion_rate ? `, and ${data.completion_rate}% of issued permits are marked complete` : ""
      }.</p>
    </div>
    <div class="ent-grid">
      <div class="bs-card">
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
      <div class="bs-card">
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
    "@graph": [
      {
        "@type": "Dataset",
        name: "Seattle Housing Units Permitted",
        description,
        url: canonical,
        creator: { "@type": "Organization", name: "Building Seattle" },
        spatialCoverage: { "@type": "Place", name: "Seattle, Washington" },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Insights", item: `${BASE_URL}/insights` },
          { "@type": "ListItem", position: 3, name: "Housing units", item: canonical },
        ],
      },
    ],
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
    <div class="bs-card" style="text-align:center;padding:3rem 1.75rem;">
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
    <div class="bs-card">
      <div class="stat-row">
        ${entStat("Net units", (t.net >= 0 ? "+" : "") + t.net.toLocaleString())}
        ${entStat("Units added", t.added.toLocaleString())}
        ${entStat("Units removed", t.removed.toLocaleString())}
        ${entStat("Permits adding homes", t.permits_adding.toLocaleString())}
      </div>
      <p class="pr-note">Across all permits on record, Seattle has permitted a net ${(t.net >= 0 ? "+" : "") + t.net.toLocaleString()} dwelling units (${t.added.toLocaleString()} added, ${t.removed.toLocaleString()} removed).</p>
    </div>
    <div class="bs-card">
      <h2>How to read these numbers</h2>
      <p class="pr-note">Net units are what count for housing supply: gross additions minus demolitions and conversions that remove homes. A single permit can do both — a teardown replaced by a duplex removes one unit and adds two. Watch the neighborhood rankings too: citywide totals can mask how concentrated new construction is in a handful of areas.</p>
    </div>
    <div class="bs-card">
      <h2>Net new units by year</h2>
      ${prBarChart(yearRows, "var(--success)")}
      <p class="pr-note">Bucketed by issue date (falling back to application date). Sub-labels show units added vs. removed.</p>
    </div>
    <div class="bs-card">
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
             SUM(${countedValueSql("permits")}) AS total_value,
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
             SUM(${countedValueSql("permits")}) AS total_value
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
      <div class="bs-card">
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
  // This URL owns all ADU intent: the tracker AND the "how long does an ADU
  // permit take" timeline (moved from /insights/pipeline, which now covers the
  // general permit funnel) so the two pages stop competing for ADU queries.
  const title = "Seattle ADU & DADU Permits: Timeline & Tracker";
  const description =
    "How long does an ADU permit take in Seattle? Median application-to-issuance days, step-by-step timing, and ADU/DADU permits by year, neighborhood, and status from public SDCI records.";

  let aduTimeline = null;
  try {
    aduTimeline = await getAduTimeline(env);
  } catch (error) {
    console.warn("ADU timeline unavailable:", error?.message || error);
  }
  const aduTl = aduTimeline || { ADU: null, DADU: null, by_year: [], recent: [] };
  const aduTlHasData = (aduTl.ADU?.issued || 0) > 0 || (aduTl.DADU?.issued || 0) > 0;

  // Data-grounded FAQ: numbers are only quoted when the tracker actually has
  // issued ADU/DADU permits with dated records, so no fabricated claims ship.
  const faqTimelineEntities = [];
  if (aduTlHasData) {
    const aduMed = aduTl.ADU?.applied_to_issued?.median;
    const daduMed = aduTl.DADU?.applied_to_issued?.median;
    if (Number.isFinite(aduMed) && Number.isFinite(daduMed)) {
      faqTimelineEntities.push(
        {
          "@type": "Question",
          name: "How long does an ADU permit take in Seattle?",
          acceptedAnswer: {
            "@type": "Answer",
            text: `Across ${aduTl.ADU.applied_to_issued.count.toLocaleString()} issued ADU permits tracked by Building Seattle, the median time from application to issuance is ${aduMed} days.`,
          },
        },
        {
          "@type": "Question",
          name: "How long does a DADU (backyard cottage) permit take in Seattle?",
          acceptedAnswer: {
            "@type": "Answer",
            text: `Across ${aduTl.DADU.applied_to_issued.count.toLocaleString()} issued DADU permits tracked by Building Seattle, the median time from application to issuance is ${daduMed} days.`,
          },
        },
      );
    }
    faqTimelineEntities.push({
      "@type": "Question",
      name: "Does the ADU permit timeline include permits still in review?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "No. Timeline medians are computed only from permits with both application and issuance dates, so permits still in review are counted in stage totals but excluded from duration statistics.",
      },
    });
  }

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
          ...faqTimelineEntities,
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

  const aduTimelineRows = aduTlHasData
    ? [
        {
          label: "ADU (attached)",
          value: aduTl.ADU.applied_to_issued.median,
          display: `${aduTl.ADU.applied_to_issued.median} days`,
          sub: `${aduTl.ADU.applied_to_issued.count.toLocaleString()} issued permits`,
        },
        {
          label: "DADU (detached)",
          value: aduTl.DADU.applied_to_issued.median,
          display: `${aduTl.DADU.applied_to_issued.median} days`,
          sub: `${aduTl.DADU.applied_to_issued.count.toLocaleString()} issued permits`,
        },
      ]
    : [];
  const aduTimelineYearRows = aduTl.by_year
    .filter((r) => r.adu_type === "ADU" || r.adu_type === "DADU")
    .sort((a, b) => String(a.year).localeCompare(String(b.year)))
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.year)}</td>
        <td>${r.adu_type === "ADU" ? "ADU" : "DADU"}</td>
        <td>${r.count.toLocaleString()}</td>
        <td>${r.avg_days} days</td>
      </tr>`,
    )
    .join("");
  const aduTimelineSection = aduTlHasData
    ? `
    <div class="bs-card">
      <h2>How long does an ADU permit take in Seattle?</h2>
      <div class="stat-row">
        ${entStat("ADU median to issue", `${aduTl.ADU.applied_to_issued.median} days`)}
        ${entStat("DADU median to issue", `${aduTl.DADU.applied_to_issued.median} days`)}
        ${entStat("ADU permits issued", aduTl.ADU.issued.toLocaleString())}
        ${entStat("DADU permits issued", aduTl.DADU.issued.toLocaleString())}
      </div>
      ${prBarChart(aduTimelineRows, "var(--success)")}
      <p>Detached units take longer: the median DADU runs ${aduTl.DADU.applied_to_issued.median} days from application to issuance against ${aduTl.ADU.applied_to_issued.median} days for an attached ADU. Averages run higher than medians — ${aduTl.ADU.applied_to_issued.mean} days (ADU) and ${aduTl.DADU.applied_to_issued.mean} days (DADU) — because a small number of long reviews pull the average up.</p>
    </div>
    <div class="bs-card">
      <h2>How long each step takes</h2>
      <ol style="margin:0;padding-left:1.25rem;line-height:1.8;">
        <li><strong>Application</strong> — the permit is filed with the Seattle Department of Construction and Inspections. ${aduTl.ADU.applied.toLocaleString()} ADU and ${aduTl.DADU.applied.toLocaleString()} DADU permits in this dataset have an application date.</li>
        <li><strong>Review</strong> — plans go through SDCI review, including applicant correction cycles where published. ${aduTl.ADU.issue_rate}% of applied ADU permits and ${aduTl.DADU.issue_rate}% of applied DADU permits reach issuance.</li>
        <li><strong>Issuance</strong> — the permit is issued. Median ${aduTl.ADU.applied_to_issued.median} days after application for ADUs and ${aduTl.DADU.applied_to_issued.median} days for DADUs.</li>
        <li><strong>Completion</strong> — construction finishes and the permit is marked complete. ${aduTl.ADU.completion_rate}% of issued ADU permits and ${aduTl.DADU.completion_rate}% of issued DADU permits are marked complete, with a median of ${aduTl.ADU.issued_to_completed.median} days (ADU) and ${aduTl.DADU.issued_to_completed.median} days (DADU) from issuance.</li>
      </ol>
    </div>
    ${aduTimelineYearRows ? `<div class="bs-card">
      <h2>Average application → issuance time by year</h2>
      <div class="table-scroll" role="region" aria-label="Application to issuance time by year" tabindex="0">
        <table class="ent">
          <thead><tr><th>Year</th><th>Type</th><th>Issued permits</th><th>Average days</th></tr></thead>
          <tbody>${aduTimelineYearRows}</tbody>
        </table>
      </div>
      <p class="pr-note">Grouped by issue date; partial years reflect records ingested so far. Years with a handful of dated permits are noisier than recent full years.</p>
    </div>` : ""}
    `
    : "";

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
      <h1>Seattle ADU &amp; DADU permit timeline and tracker</h1>
      <p style="color:var(--text-muted);max-width:70ch;margin:0;">How long ADU and DADU permits actually take, plus every accessory dwelling unit permit across Seattle by year, neighborhood, and status. Compare attached ADUs with detached backyard cottages, and see where new small-scale housing activity is concentrating.</p>
    </div>
    ${
      hasData
        ? `
    <div class="bs-card">
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
    ${aduTimelineSection}
    <div class="bs-card">
      <h2>ADU and DADU permits by year</h2>
      ${prBarChart(yearRows, "var(--success)")}
      <p class="pr-note">Grouped by issue date when available, otherwise application date.</p>
    </div>
    <div class="bs-card">
      <h2>Seattle neighborhoods with the most ADU activity</h2>
      ${prBarChart(neighborhoodRows, "var(--accent)")}
    </div>
    <div class="bs-card">
      <h2>Recent Seattle ADU and DADU permits</h2>
      <div class="table-scroll" role="region" aria-label="Recent ADU and DADU permits" tabindex="0">
        <table class="ent">
          <thead><tr><th>Permit</th><th>Type</th><th>Address</th><th>Neighborhood</th><th>Status</th><th>Value</th><th>Date</th></tr></thead>
          <tbody>${recentRows}</tbody>
        </table>
      </div>
    </div>
    `
        : `<div class="bs-card"><h2>ADU data is being classified</h2><p>The tracker will become indexable after matching Seattle permit records are available.</p></div>`
    }
    <div class="ent-grid" style="margin-top:1rem;">
      <section class="bs-card">
        <h2>ADU vs. DADU</h2>
        <p><strong>ADU</strong> is the broader term for an accessory dwelling unit associated with a primary home. It can be inside, attached to, or converted from part of an existing structure.</p>
        <p><strong>DADU</strong> means detached accessory dwelling unit. In Seattle records it may also appear as a detached ADU or backyard cottage.</p>
      </section>
      <section class="bs-card">
        <h2>How the tracker works</h2>
        <p>Building Seattle searches public permit descriptions for explicit ADU terminology, classifies detached projects separately, and aggregates results by year and neighborhood. A permit mentioning both attached and detached units is classified as DADU.</p>
        <p>Declared permit values and housing-unit fields are presented as reported and may be incomplete or revised during review.</p>
      </section>
    </div>
    <section class="bs-card">
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
  return `<aside class="bs-card" aria-label="Data source and methodology" style="font-size:.82rem;color:var(--text-muted);">
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
       SELECT COUNT(*) AS total, COALESCE(SUM(${countedValueSql("p")}), 0) AS total_value,
              SUM(CASE WHEN issued_date IS NOT NULL AND issued_date != '' THEN 1 ELSE 0 END) AS issued,
              SUM(CASE WHEN ${ACTIVE_PERMIT_SQL} THEN 1 ELSE 0 END) AS active,
              MAX(COALESCE(updated_at, last_enriched_at, issued_date, applied_date, created_at)) AS updated_through
       FROM permits p WHERE ${where}`,
    ),
    safeAll(
      env,
      `/* market-segment:${segment}:year */
       SELECT substr(COALESCE(NULLIF(issued_date, ''), applied_date), 1, 4) AS year,
              COUNT(*) AS permits, COALESCE(SUM(${countedValueSql("p")}), 0) AS total_value
       FROM permits p WHERE ${where}
         AND COALESCE(NULLIF(issued_date, ''), applied_date) IS NOT NULL
       GROUP BY year HAVING year IS NOT NULL AND year != '' ORDER BY year ASC`,
    ),
    safeAll(
      env,
      `/* market-segment:${segment}:neighborhood */
       SELECT COALESCE(NULLIF(neighborhood, ''), 'Unknown') AS label,
              COUNT(*) AS permits, COALESCE(SUM(${countedValueSql("p")}), 0) AS total_value
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
        ? `<div class="bs-card"><div class="stat-row">
            ${entStat("Matching permits", data.totals.total.toLocaleString())}
            ${entStat("Issued", data.totals.issued.toLocaleString())}
            ${entStat("Active / in review", data.totals.active.toLocaleString())}
            ${entStat("Declared value", compactMoney(data.totals.total_value))}
          </div></div>
          <div class="bs-card"><h2>How to read these numbers</h2><p class="pr-note">Active and in-review permits are the forward pipeline — work likely to start or continue in the coming months. Declared value is the cost stated on the application, so it understates true project cost but stays comparable across permits. The neighborhood ranking shows where this segment is actually clustering, usually a better demand signal than the citywide total.</p></div>
          <div class="bs-card"><h2>Permit activity by year</h2>${prBarChart(yearRows, "var(--success)")}</div>
          <div class="bs-card"><h2>Leading Seattle neighborhoods</h2>${prBarChart(neighborhoodRows)}</div>
          <div class="bs-card"><h2>Recent matching permits</h2><div class="table-scroll" role="region" aria-label="Recent matching permits" tabindex="0"><table class="ent">
            <thead><tr><th>Permit</th><th>Address</th><th>Neighborhood</th><th>Status</th><th>Type</th><th>Value</th><th>Date</th></tr></thead>
            <tbody>${recentRows}</tbody>
          </table></div></div>`
        : `<div class="bs-card"><h2>Supporting data is unavailable</h2><p>This page will become indexable when matching permit records are available.</p></div>`
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
    `SELECT neighborhood AS name, COUNT(*) AS permits, COALESCE(SUM(${countedValueSql("permits")}),0) AS total_value
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
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" style="fill:var(--data-2);stroke:var(--data-2)" fill-opacity="${op}" stroke-opacity="0.9" stroke-width="1"><title>${escapeHtml(n.name)}: ${n.permits.toLocaleString()} permits · ${compactMoney(n.total_value)}</title></circle>`;
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
    <div class="bs-card" style="text-align:center;padding:3rem 1.75rem;">
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
    <div class="bs-card">
      <div class="stat-row">
        ${entStat("Neighborhoods", data.mapped_count.toLocaleString())}
        ${entStat("Permits mapped", data.total_permits.toLocaleString())}
        ${entStat("Total value", compactMoney(data.total_value))}
      </div>
      <p class="pr-note">Larger, darker bubbles mean more permitted work and higher declared value — the clearest signal of where construction capital is flowing. Only permits with a mappable address appear here, so citywide or multi-site permits are excluded.</p>
    </div>
    <div class="ent-grid">
      <div class="bs-card">
        <h2>Construction activity map</h2>
        ${svgBubbleMap(mapped)}
        <p class="pr-note">Bubble size = permit count · color depth = total value. Hover a bubble for details.${data.unmapped_count ? ` ${data.unmapped_count} neighborhood${data.unmapped_count === 1 ? "" : "s"} without a known centroid are listed but not plotted.` : ""}</p>
      </div>
      <div class="bs-card">
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
      `SELECT c.name, c.slug, COUNT(p.id) AS permits, COALESCE(SUM(${countedValueSql("p")}),0) AS total_value,
              COUNT(DISTINCT p.neighborhood) AS neighborhoods,
              AVG(p.total_days_plan_review) AS avg_review,
              SUM(CASE WHEN p.status='active' THEN 1 ELSE 0 END) AS active
       FROM contractors c JOIN permits p ON p.contractor_id = c.id
       GROUP BY c.id ORDER BY permits DESC LIMIT 25`,
    ),
    safeAll(
      env,
      `SELECT c.name, c.slug, COUNT(p.id) AS permits, COALESCE(SUM(${countedValueSql("p")}),0) AS total_value
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
    <div class="bs-card" style="text-align:center;padding:3rem 1.75rem;">
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
    <div class="bs-card">
      <div class="stat-row">
        ${entStat("Contractors", data.totals.contractors.toLocaleString())}
        ${entStat("With permits", data.totals.active_contractors.toLocaleString())}
        ${entStat("Attributed permits", data.totals.attributed_permits.toLocaleString())}
      </div>
      <p class="pr-note">Attribution comes from the contractor field on each permit, so owner-builder and unspecified permits are not counted here. Value reflects declared permit value, not final construction cost. Median review speed is a rough proxy for process experience — repeat filers tend to clear Seattle review faster.</p>
    </div>
    <div class="ent-grid">
      <div class="bs-card">
        <h2>Most permits pulled</h2>
        ${prBarChart(permitRows)}
      </div>
      <div class="bs-card">
        <h2>Highest construction value</h2>
        ${prBarChart(valueRows, "var(--success)")}
      </div>
    </div>
    <div class="bs-card">
      <h2>Contractor scorecards</h2>
      <div class="table-scroll" role="region" aria-label="Contractor scorecards" tabindex="0">
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
        <circle cx="${colL}" cy="${y}" r="${r}" style="fill:var(--data-2)"><title>${escapeHtml(c.name)}: ${c.permits} permits</title></circle>
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
        <circle cx="${colR}" cy="${y}" r="${r}" style="fill:var(--success)"><title>${escapeHtml(n.name)}: ${n.weight} permits across these contractors</title></circle>
        <text x="${colR + 14}" y="${y}" text-anchor="start" dominant-baseline="middle" font-size="11" fill="currentColor">${escapeHtml(n.name)}</text>
      </g>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Network of contractors linked to the Seattle neighborhoods they build in" style="width:100%;height:auto;color:var(--text);">
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
    <div class="bs-card" style="text-align:center;padding:3rem 1.75rem;">
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
      <p style="color:var(--text-muted);max-width:65ch;margin:0.5rem 0 0;">Read it as a specialization map: contractors bound tightly to one or two neighborhoods tend to be local specialists, while those linked across the city run larger, generalist operations.</p>
    </div>
    ${
      hasData
        ? `
    <div class="bs-card">
      <h2>Contractor &amp; neighborhood network</h2>
      ${svgBipartiteNetwork(data.contractors, data.neighborhoods, data.edges)}
      <p class="pr-note">Blue = contractors (sized by total permits) · green = neighborhoods (sized by permits from these contractors). Click a contractor to open their page. Each contractor is linked to its top 4 neighborhoods.</p>
    </div>
    <div class="bs-card">
      <h2>Top neighborhoods by contractor</h2>
      <ul class="ent-list">${adjacency}</ul>
    </div>
    <div class="bs-card">
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
  const segmentCount = (key) =>
    safeFirst(env, `/* insights-index:${key} */ SELECT COUNT(*) AS total FROM permits WHERE ${MARKET_SEGMENTS[key].where}`);
  const [pr, pipe, house, aduAgg, mapAgg, contractorAgg, multiAgg, commAgg, tiAgg] = await Promise.all([
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
    segmentCount("multifamily"),
    segmentCount("commercial"),
    segmentCount("tenant-improvements"),
  ]);
  const statLine = (n, unit) =>
    n
      ? `${n.toLocaleString()} <span style="font-size:0.9rem;color:var(--text-muted);font-weight:600;">${unit}</span>`
      : `<span style="font-size:0.95rem;color:var(--text-muted);">Awaiting data</span>`;

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
      <div class="bs-card">
        <div class="ent-kicker">${escapeHtml(kicker)}</div>
        <h2 style="margin:0.2rem 0 0.5rem;">${escapeHtml(h)}</h2>
        <p style="color:var(--text-muted);margin:0 0 1rem;font-size:0.9rem;">${escapeHtml(teaser)}</p>
        <div class="ins-stat" style="font-size:1.5rem;font-weight:800;color:var(--accent);">${stat}</div>
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
        "Pipeline",
        "Permit pipeline",
        "Every Seattle permit tracked from application to issuance to completion — stage counts, timing, and where projects stall.",
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
        "ADU & DADU timeline and tracker",
        "How long ADU and DADU permits actually take — medians by year and unit type, plus the full permit tracker.",
        aduTotal ? `${aduTotal.toLocaleString()} <span style="font-size:0.9rem;color:var(--text-muted);font-weight:600;">matching permits</span>` : `<span style="font-size:0.95rem;color:var(--text-muted);">Awaiting data</span>`,
      )}
      ${feature(
        "/insights/multifamily-pipeline",
        "Multifamily",
        "Multifamily construction pipeline",
        "Seattle apartment, condominium, townhouse, and multi-unit permit activity by stage and neighborhood.",
        statLine(Number(multiAgg?.total) || 0, "multifamily permits"),
      )}
      ${feature(
        "/insights/commercial-projects",
        "Commercial",
        "High-value commercial projects",
        "Seattle commercial permits valued at $1 million or more, with neighborhoods, status, and recent activity.",
        statLine(Number(commAgg?.total) || 0, "permits of $1M+"),
      )}
      ${feature(
        "/insights/tenant-improvements",
        "Interiors",
        "Tenant-improvement activity",
        "Tenant-improvement and tenant-alteration permits by year, neighborhood, value, and recent activity.",
        statLine(Number(tiAgg?.total) || 0, "tenant-improvement permits"),
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
        statLine(activeContractors, "contractors mapped"),
      )}
      ${feature(
        "/insights/basis-reset",
        "Capital signals",
        "Basis Reset Radar",
        "Properties where sales, distress, developer exits, or shovel-ready listings intersect with real permit and project activity.",
        `<span style="font-size:1.1rem;">Find reset opportunities &rarr;</span>`,
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

// 503 + Retry-After + no-store: "ask again later". Used when the database
// cannot tell us whether an entity page exists, so a crawler is never handed a
// 404/410 (a request to drop the URL) for a page that is merely unreadable.
function renderTemporarilyUnavailable() {
  const response = render404({
    status: 503,
    code: "503",
    heading: "Temporarily unavailable",
    message: "This page is being refreshed. Please try again in a few minutes.",
  });
  response.headers.set("Retry-After", "3600");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function renderAddressPage(slug, env, request) {
  const canonical = `${BASE_URL}/address/${encodeURIComponent(slug)}`;
  let address;
  try {
    address = (await env.DB.prepare("SELECT * FROM addresses WHERE slug = ?").bind(slug).first()) || null;
  } catch (error) {
    console.error("Address lookup failed:", error);
    return renderTemporarilyUnavailable();
  }
  if (!address) {
    return render404({
      heading: "Address not found",
      message: "We do not have an aggregated property page for that address yet.",
    });
  }

  // The permit list decides between "render", "gone" and "try later", so a
  // failed read must not look like an empty one.
  let permitsFailed = false;
  const [permits, projects, participants, neighborhood, related] = await Promise.all([
    env.DB.prepare(
      `SELECT p.*, c.name AS contractor_name, c.slug AS contractor_slug
       FROM permits p LEFT JOIN contractors c ON c.id = p.contractor_id
       WHERE p.address_id = ? ORDER BY COALESCE(p.issued_date, p.applied_date) DESC`,
    )
      .bind(address.id)
      .all()
      .then((result) => result.results || [])
      .catch((error) => {
        console.error("Address permit lookup failed:", error);
        permitsFailed = true;
        return [];
      }),
    safeAll(
      env,
      `SELECT pr.* FROM projects pr
       WHERE pr.address_id = ? AND ${MULTI_PERMIT_PROJECT_SQL}
       ORDER BY pr.latest_activity_date DESC`,
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

  if (permitsFailed) return renderTemporarilyUnavailable();

  const permitCount = permits.length;
  // An address with no permits on record has nothing to publish. Answering 410
  // makes Google drop the URL instead of spending crawl budget on a 200 that
  // only says `noindex`. These URLs are neither sitemapped nor linked
  // internally. That is only true while the permit -> address links are
  // intact: if any permit is still waiting to be linked, or the latest
  // entity-graph rebuild is running or did not finish cleanly (it may have stopped
  // part-way through relinking), "no permits here" cannot be trusted, so answer
  // 503 and let the crawler come back instead. No rebuild row yet counts as clean.
  if (permitCount === 0) {
    let check = null;
    try {
      check = await env.DB.prepare(
        `SELECT EXISTS(SELECT 1 FROM permits WHERE address_id IS NULL) AS pending,
                (SELECT status FROM ingest_logs WHERE run_type = 'entity_graph' ORDER BY id DESC LIMIT 1) AS last_rebuild`,
      ).first();
    } catch (error) {
      console.error("Address integrity check failed:", error);
    }
    if (!check || Number(check.pending) !== 0 || ["running", "error", "partial"].includes(check.last_rebuild)) {
      return renderTemporarilyUnavailable();
    }
    return renderGone({
      heading: "This address has no permits on record",
      message:
        "We no longer have construction permit records for this address in the public Seattle DCI data we publish. Try browsing permits or searching for another address.",
    });
  }
  // All permits at this address are loaded, so the shared rule sees every
  // match: a valuation SDCI repeats across demolition permits counts once.
  const totalValue = [...countedValues(permits).values()].reduce((s, v) => s + v, 0);
  const dates = permits.map((p) => p.issued_date || p.applied_date).filter(Boolean).sort();
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  const activePermits = permits.filter((p) => ["active", "pending", "new"].includes(String(p.status || "").toLowerCase()));
  const display = smartTitleCase(cleanFeedText(address.display_address) || cleanFeedText(address.normalized_address)) || "Seattle property";
  // Zero-permit addresses return 410 above, so every address page that renders
  // has records on it and stays indexable.
  const noindex = false;

  // Use one shared, source-backed descriptor for the address title, meta, and
  // first screen. Prefer a distinctive tenant/project phrase when available,
  // but never infer a project name from the address alone.
  const featured = featuredAddressPermit(permits);
  const featuredPermit = featured?.permit || permits[0] || null;
  const featuredDescriptor = featured?.descriptor || "";
  const valueStr = totalValue ? `$${parseInt(totalValue).toLocaleString()}` : "";
  const latestContractor = permits[0]?.contractor_name || "";

  // Long addresses can consume an entire title when a brand suffix is always
  // reserved. Prefer compact, source-backed permit facts so every indexed
  // address title tells searchers why the record is useful.
  const titlePermitFact = activePermits.length > 0
    ? `${activePermits.length} Active Permit${activePermits.length !== 1 ? "s" : ""}`
    : `${permitCount} Permit${permitCount !== 1 ? "s" : ""}`;
  const title = `${display} — ${titlePermitFact}${totalValue ? ` · ${compactMetricMoney(totalValue)}` : ""}`;

  // Put complete decision-making facts before the optional work descriptor.
  // Contractors are included whole or not at all; only the final descriptor
  // may be shortened to fit the search-description budget.
  const META_MAX = 165;
  const permitFact = permitCount === 1 && activePermits.length === 1
    ? "1 active construction permit"
    : `${permitCount} construction permit${permitCount !== 1 ? "s" : ""}`;
  let description = `${permitFact} at ${display}`;
  if (activePermits.length > 0 && !(permitCount === 1 && activePermits.length === 1)) {
    description += `; ${activePermits.length} active`;
  }
  if (valueStr) description += `; ${valueStr} declared value`;
  description += ".";
  const contractorSentence = latestContractor ? ` Contractor: ${smartTitleCase(latestContractor)}.` : "";
  if (description.length + contractorSentence.length <= META_MAX) description += contractorSentence;
  const descriptorBudget = META_MAX - description.length - 1;
  if (featuredDescriptor && descriptorBudget >= 20) {
    description += ` ${truncateMetaDescription(featuredDescriptor, descriptorBudget)}`;
  }

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
      ${featuredDescriptor ? `<p style="margin:0.75rem 0 0;max-width:760px;font-size:1.05rem;line-height:1.6;color:var(--text);"><strong>${escapeHtml(featuredDescriptor)}</strong>${featuredPermit?.permit_number ? ` <span style="color:var(--text-muted);">· <a class="ent-link" href="/permits/${encodeURIComponent(featuredPermit.permit_number)}">Permit ${escapeHtml(featuredPermit.permit_number)}</a></span>` : ""}</p>` : ""}
      ${neighborhood ? `<a class="ent-link" href="/neighborhood/${encodeURIComponent(neighborhood.slug)}">${escapeHtml(neighborhood.name)}</a>` : ""}
    </div>
    <div style="max-width:var(--container-max);margin:0 auto 2.5rem;padding:0 1.5rem;">
      <div class="bs-card" style="margin-bottom:0;">
        <div style="font-size:1.05rem;line-height:1.85;color:var(--text-muted);">
          <p style="margin:0 0 1rem;">${escapeHtml(display)} is a property in Seattle${neighborhood ? `'s <a class="ent-link" href="/neighborhood/${encodeURIComponent(neighborhood.slug)}">${escapeHtml(neighborhood.name)}</a> neighborhood` : ""} with <strong style="color:var(--text);">${permitCount} construction permit${permitCount !== 1 ? "s" : ""}</strong> on record with the Seattle Department of Construction and Inspections${activePermits.length > 0 ? `, <strong style="color:var(--text);">${activePermits.length} of which ${activePermits.length === 1 ? "is" : "are"} currently active</strong>` : ""}.${totalValue > 0 ? ` The combined estimated project value across all permits is <strong style="color:var(--text);">$${parseInt(totalValue).toLocaleString()}</strong>.` : ""}</p>
          <p style="margin:0 0 1rem;">Permit activity at this address spans from ${firstDate ? new Date(firstDate).toLocaleDateString("en-US", {year:"numeric",month:"long"}) : "the earliest record"} to ${lastDate ? new Date(lastDate).toLocaleDateString("en-US", {year:"numeric",month:"long"}) : "the present"}${featuredPermit?.permit_number ? `, with the featured record filed under permit number <a class="ent-link" href="/permits/${encodeURIComponent(featuredPermit.permit_number)}">${escapeHtml(featuredPermit.permit_number)}</a>` : ""}.${latestContractor && permits[0]?.contractor_slug ? ` The latest contractor associated with this address is <a class="ent-link" href="/contractor/${encodeURIComponent(permits[0].contractor_slug)}">${escapeHtml(latestContractor)}</a>.` : ""}</p>
          <p style="margin:0;">Use the data below to review individual permit records, track project timelines, see which contractors and participants have been involved, and explore nearby construction activity. Each permit links to its own detail page with review cycles, status changes, and project descriptions.</p>
        </div>
      </div>
    </div>
    <div class="ent-grid">
      <div>
        <div class="bs-card">
          <h2>Summary</h2>
          <div class="stat-row">
            ${entStat("Permits", permitCount)}
            ${entStat("Total value", entMoney(totalValue))}
            ${entStat("Active / recent", activePermits.length)}
            ${entStat("Projects", projects.length)}
          </div>
          <div style="font-size:0.85rem;color:var(--text-muted);">First permit ${entDate(firstDate)} · Latest permit ${entDate(lastDate)}</div>
        </div>
        <div class="bs-card">
          <h2>Permit records (${permitCount})</h2>
          ${entPermitRows(permits)}
        </div>
      </div>
      <div>
        <div class="bs-card">
          <h3>Inferred projects</h3>
          ${projectsHtml}
        </div>
        <div class="bs-card">
          <h3>Contractors &amp; participants</h3>
          ${participantsHtml}
        </div>
        ${relatedHtml ? `<div class="bs-card"><h3>Nearby &amp; related addresses</h3>${relatedHtml}</div>` : ""}
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
  const selfUrl = `${BASE_URL}/project/${encodeURIComponent(slug)}`;
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
  // A cluster of one permit is not a project: it repeats the record the
  // address page already publishes. Canonicalize the duplicate onto the
  // property page so the two URLs consolidate instead of competing, and keep
  // serving the page so existing links still resolve.
  const duplicatesAddress = permits.length === 1 && Boolean(project.address_slug);
  const canonical = duplicatesAddress
    ? `${BASE_URL}/address/${encodeURIComponent(project.address_slug)}`
    : selfUrl;
  const title = `${project.name} | Seattle Construction Activity`;
  const description = `Track permits, contractors, address history, estimated values, and recent construction activity for ${project.name}.`;

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CreativeWork",
        name: project.name,
        abstract: project.description_summary || undefined,
        url: selfUrl,
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
          { "@type": "ListItem", position: project.address_slug ? 3 : 2, name: project.name, item: selfUrl },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");

  // Repeated demolition valuations count once (value_counting.js). The match
  // can sit in another project at the same address, so judge against every
  // permit there; computed live so the page is right before the next rebuild.
  const addressPermits = project.address_id
    ? await safeAll(env, "SELECT id, permit_number, address_id, value FROM permits WHERE address_id = ?", [project.address_id])
    : [];
  const countedAtAddress = countedValues(addressPermits.length ? addressPermits : permits);
  const countedByPermit = new Map(permits.map((p) => [p.id, countedAtAddress.has(p.id) ? countedAtAddress.get(p.id) : Number(p.value) || 0]));
  const projectValue = permits.length
    ? [...countedByPermit.values()].reduce((sum, v) => sum + v, 0)
    : project.total_estimated_value;
  const skippedByValue = new Map();
  for (const p of permits) {
    if ((Number(p.value) || 0) > 0 && countedByPermit.get(p.id) === 0) {
      skippedByValue.set(Number(p.value), (skippedByValue.get(Number(p.value)) || 0) + 1);
    }
  }
  const repeatedValueNote = skippedByValue.size
    ? `<p style="font-size:0.8rem;color:var(--text-muted);margin:0.25rem 0 0;">${[...skippedByValue.entries()]
        .map(([value, extra]) => `SDCI repeats ${entMoney(value)} on ${countLabel(extra + 1, "permit", "permits")}; it is counted once.`)
        .join(" ")} <a class="ent-link" href="/methodology">How values are counted</a></p>`
    : "";
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
        <div class="bs-card">
          <h2>Summary</h2>
          <div class="stat-row">
            ${entStat("Permits", permits.length)}
            ${entStat("Est. value", entMoney(projectValue))}
            ${entStat("First activity", entDate(project.first_seen_date))}
            ${entStat("Latest activity", entDate(project.latest_activity_date))}
          </div>
          ${repeatedValueNote}
          ${project.description_summary ? `<p style="margin-top:0.5rem;">${escapeHtml(project.description_summary)}</p>` : ""}
        </div>
        ${renderProjectReviewSummary(permits)}
        <div class="bs-card">
          <h2>Permit records (${permits.length})</h2>
          ${entPermitRows(permits)}
        </div>
      </div>
      <div>
        <div class="bs-card">
          <h3>Participants</h3>
          ${participantsHtml}
        </div>
        <div class="bs-card">
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
       WHERE an.neighborhood_id = ? AND ${MULTI_PERMIT_PROJECT_SQL}
       ORDER BY pr.latest_activity_date DESC LIMIT 10`,
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
      `SELECT COUNT(DISTINCT p.id) AS permits, COALESCE(SUM(${countedValueSql("p")}),0) AS total_value
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
  const title = `${nb.name} Construction Permits — Seattle`;
  const description = `Recent permits, active projects, top contractors, estimated values, and the most active addresses in ${nb.name}, Seattle.`;

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        name: `${nb.name} construction permits`,
        description,
        url: canonical,
        isPartOf: { "@type": "WebSite", name: "Building Seattle", url: `${BASE_URL}/` },
        about: {
          "@type": "Place",
          name: `${nb.name}, Seattle, Washington`,
          address: {
            "@type": "PostalAddress",
            addressLocality: "Seattle",
            addressRegion: "WA",
            addressCountry: "US",
          },
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Neighborhoods", item: `${BASE_URL}/neighborhoods` },
          { "@type": "ListItem", position: 3, name: nb.name, item: canonical },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");

  const listOrEmpty = (rows, fn, empty) =>
    rows.length ? `<ul class="ent-list">${rows.map(fn).join("")}</ul>` : `<p style="color:var(--text-muted);">${empty}</p>`;

  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Neighborhoods", href: "/neighborhoods" }, { label: nb.name }])}
    <div class="ent-hero">
      <div class="ent-kicker">Neighborhood</div>
      <h1>${escapeHtml(nb.name)}</h1>
    </div>
    <div class="bs-card">
      <div class="stat-row">
        ${entStat("Permits", permitCount)}
        ${entStat("Total value", entMoney(totalValue))}
        ${entStat("Active projects", projects.length)}
        ${entStat("Top contractors", topContractors.length)}
      </div>
    </div>
    <div class="ent-grid">
      <div>
        <div class="bs-card">
          <h2>Recent permits</h2>
          ${entPermitRows(recentPermits)}
        </div>
        <div class="bs-card">
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
        <div class="bs-card">
          <h3>Top contractors</h3>
          ${listOrEmpty(
            topContractors,
            (c) => `<li><a class="ent-link" href="/contractor/${encodeURIComponent(c.slug)}">${escapeHtml(c.name)}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${c.cnt} permits</span></li>`,
            "No contractors on record.",
          )}
        </div>
        <div class="bs-card">
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
      `SELECT a.slug, a.display_address, COUNT(p.id) AS permits, COALESCE(SUM(${countedValueSql("p")}),0) AS total_value
       FROM permit_participants pp JOIN permits p ON p.id = pp.permit_id
       JOIN addresses a ON a.id = p.address_id
       WHERE pp.people_org_id = ? GROUP BY a.id ORDER BY permits DESC LIMIT 12`,
      [org.id],
    ),
    safeAll(
      env,
      `SELECT DISTINCT pr.slug, pr.name, pr.latest_activity_date, pr.total_estimated_value
       FROM permit_participants pp JOIN permits p ON p.id = pp.permit_id
       JOIN projects pr ON pr.id = p.project_id AND ${MULTI_PERMIT_PROJECT_SQL}
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

  // Counted total over every permit this org is on (not just the 50 listed),
  // with repeated demolition valuations counted once (value_counting.js).
  const valueRow = await safeFirst(
    env,
    `SELECT COALESCE(SUM(counted), 0) AS total FROM (
       SELECT DISTINCT p.id, ${countedValueSql("p")} AS counted
       FROM permit_participants pp JOIN permits p ON p.id = pp.permit_id
       WHERE pp.people_org_id = ?)`,
    [org.id],
  );
  const totalValue = valueRow ? Number(valueRow.total) || 0 : 0;
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
    <div class="bs-card">
      <div class="stat-row">
        ${entStat("Permits", permits.length)}
        ${entStat("Active / recent", activeCount)}
        ${entStat("Total value", entMoney(totalValue))}
        ${entStat("Addresses", addresses.length)}
      </div>
    </div>
    <div class="ent-grid">
      <div>
        <div class="bs-card">
          <h2>Recent activity</h2>
          ${entPermitRows(permits.slice(0, 20))}
        </div>
        <div class="bs-card">
          <h2>Inferred projects</h2>
          ${listOrEmpty(
            projects,
            (pr) => `<li><a class="ent-link" href="/project/${encodeURIComponent(pr.slug)}">${escapeHtml(pr.name)}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${entMoney(pr.total_estimated_value)} · ${entDate(pr.latest_activity_date)}</span></li>`,
            "No inferred projects yet.",
          )}
        </div>
      </div>
      <div>
        <div class="bs-card">
          <h3>Addresses worked on</h3>
          ${listOrEmpty(
            addresses,
            (a) => `<li><a class="ent-link" href="/address/${encodeURIComponent(a.slug)}">${escapeHtml(a.display_address)}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${a.permits} permits</span></li>`,
            "No addresses on record.",
          )}
        </div>
        <div class="bs-card">
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

    // Keep the derived entity graph (addresses / projects / orgs) fresh. The
    // outcome is recorded in its own ingest_logs row (partial / error included);
    // a failed rebuild does not fail the permit ingest or skip the alerts.
    let graph = null;
    try {
      graph = await runLoggedEntityGraphRebuild(env, "scheduled");
    } catch {
      // already logged by runLoggedEntityGraphRebuild
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
    return {
      added,
      updated,
      contractors: contractors.length,
      alerts_sent: alertDelivery.sent,
      entity_graph: graph ? { ok: graph.ok, unlinked: graph.unlinked } : { ok: false, error: true },
    };
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

  const payload = await verifyAccessJwt(jwt, env);
  if (!payload) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      email: payload.email || request.headers.get("CF-Access-Authenticated-User-Email"),
      id: payload.sub || payload.id || request.headers.get("CF-Access-Authenticated-User-Id"),
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
                      results: { type: "array", items: { type: "object", properties: DEVELOPMENT_SITE_SCHEMA } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/development-sites/{id}/geometry": {
        get: {
          operationId: "getDevelopmentSiteGeometry",
          summary: "Current SDCI development-site boundary as a GeoJSON Feature.",
          description: "This live boundary can change or disappear after refresh. Its timestamps describe the retrieved geometry, not a historical CSV snapshot.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { description: "Current boundary with source attribution and UTC source/fetch timestamps.", content: { "application/geo+json": { schema: { type: "object", required: ["type", "geometry", "properties"], properties: { type: { const: "Feature" }, geometry: { type: "object" }, properties: { type: "object", properties: DEVELOPMENT_SITE_SCHEMA } } } } } },
            404: { description: "No usable boundary is available." },
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
  const canonical = `${BASE_URL}/api-docs`;
  const title = "Seattle Permit & Contractor API | Building Seattle";
  const description =
    "Read-only JSON API for Seattle construction permits, contractors, and aggregate stats. Endpoints, parameters, and examples — no authentication required.";
  const socialImage = `${BASE_URL}/social/insight.png`;
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: title,
        description,
        url: canonical,
        publisher: { "@type": "Organization", name: "Building Seattle", url: `${BASE_URL}/` },
        about: {
          "@type": "WebAPI",
          name: "Building Seattle public API",
          documentation: canonical,
          provider: { "@type": "Organization", name: "Building Seattle", url: `${BASE_URL}/` },
          termsOfService: `${BASE_URL}/methodology`,
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "API documentation", item: canonical },
        ],
      },
    ],
  }).replaceAll("<", "\\u003c");
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
  ${themeBootScript()}
  <link rel="preload" href="/brand/fonts/IBMPlexSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/brand/fonts/IBMPlexSans-SemiBold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/brand/tokens.css">
  <link rel="stylesheet" href="/brand/bundle.css">
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="robots" content="index,follow,max-image-preview:large">
    <link rel="canonical" href="${canonical}">
    <meta property="og:type" content="article">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${canonical}">
    <meta property="og:image" content="${socialImage}">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="Seattle permit and contractor API — Building Seattle">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${socialImage}">
    <link rel="icon" href="/favicon.ico" sizes="32x32" type="image/png">
    <link rel="manifest" href="/site.webmanifest">
    ${renderDesignTokens()}
    <script type="application/ld+json">${jsonLd}</script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family:var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif); background: var(--bg-alt); color: var(--text); line-height: 1.6; display: flex; flex-direction: column; min-height: 100vh; }
        .container { box-sizing: content-box; max-width: var(--container-max); margin: 0 auto; padding: 0 1.5rem; }
        main { flex: 1; padding-top: 6rem; padding-bottom: 4rem; }
        h1 { font-size: 2.25rem; font-weight: 800; color: var(--primary); margin-bottom: 0.5rem; }
        .lede { color: var(--text-muted); margin-bottom: 2rem; max-width: 640px; }
        .endpoint { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 1.25rem 1.5rem; margin-bottom: 1.25rem; }
        .endpoint h3 { font-size: 1.05rem; margin-bottom: 0.5rem; color: var(--primary); }
        .method { display: inline-block; background: var(--accent); color: var(--on-accent); font-size: 0.7rem; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 0.35rem; vertical-align: middle; }
        code { font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 0.875rem; }
        table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; font-size: 0.875rem; }
        th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border); vertical-align: top; }
        th { color: var(--text-muted); font-weight: 600; }
        .resources { margin-top: 2rem; font-size: 0.9rem; }
        .resources a { color: var(--accent); }
    </style>
</head>
<body>
    <a class="skip-link" href="#main-content">Skip to content</a>
    ${renderNav("api")}
    <main id="main-content">
      <div class="container">
        <h1>API Documentation</h1>
        <p class="lede">Read-only JSON access to aggregated Seattle construction permit and contractor data. No authentication required. Base URL <code>${BASE_URL}</code>.</p>
        <h2>Endpoints</h2>
        ${endpoint("GET", "/api/permits", "Query permits with optional filters and pagination. Returns { total, page, per_page, results[] }.", [param("neighborhood", "Filter by neighborhood."), param("type", "Filter by permit type."), param("status", "Filter by permit status."), param("q", "Free-text search across address, description, permit number, neighborhood, and contractor name."), param("page", "Page number (default 1)."), param("per_page", "Results per page (1-100, default 50).")].join(""))}
        <p>Permit results include six nullable development-site fields: <code>development_site_id</code>, <code>development_site_sqft</code>, <code>development_site_status</code>, <code>development_site_source_updated_at</code>, <code>development_site_fetched_at</code>, and <code>development_site_geometry_url</code>. Source dates may be unknown. The existing <code>parcel_number</code> is an SDCI property reference, usually a development-site ID.</p>
        ${endpoint("GET", "/api/development-sites/{id}/geometry", "Current boundary as a GeoJSON Feature with source attribution and UTC timestamps. Returns 404 without a usable boundary. Geometry links are live: they may change or disappear after refresh and do not freeze the boundary to a CSV export date.", param("id", "SDCI development-site ID, such as DV0025961."))}
        ${endpoint("GET", "/api/contractors", "List the top 20 contractors ranked by active project count. Each record includes an active_projects count.", "")}
        ${endpoint("GET", "/api/stats", "Aggregate counts and permit value totals for the dashboard.", "")}
        <h2>Machine-readable resources</h2>
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

function renderLlmsTxt() {
  const lines = [
    "# Building Seattle",
    "",
    "> Building Seattle tracks every construction permit in Seattle — applications,",
    "> issuance, plan-review timelines, contractors, neighborhoods, and housing",
    "> units — built from daily City of Seattle SDCI open-data feeds.",
    "",
    "## Data & methodology",
    `- ${BASE_URL}/data — datasets, downloads, and licensing`,
    `- ${BASE_URL}/methodology — how permits are cleaned, clustered, and scored`,
    `- ${BASE_URL}/about — about the project`,
    "",
    "## Programmatic pages",
    `- ${BASE_URL}/permits — search and browse all permits (detail: /permits/{permit_number})`,
    `- ${BASE_URL}/contractors — contractor rankings (detail: /contractors/{slug})`,
    `- ${BASE_URL}/neighborhoods — neighborhood stats (detail: /neighborhoods/{slug})`,
    `- ${BASE_URL}/projects — clustered multi-permit projects`,
    `- ${BASE_URL}/addresses — permit history by address`,
    "",
    "## Insights",
    `- ${BASE_URL}/insights — analysis hub`,
    `- ${BASE_URL}/insights/plan-review — plan-review timing distributions`,
    `- ${BASE_URL}/insights/pipeline — the full permit pipeline, application to completion`,
    `- ${BASE_URL}/insights/adu-dadu — ADU & DADU permit timelines and tracker`,
    `- ${BASE_URL}/insights/housing — net new housing units tracker`,
    `- ${BASE_URL}/insights/multifamily-pipeline — multifamily construction pipeline`,
    `- ${BASE_URL}/insights/commercial-projects — commercial project activity`,
    `- ${BASE_URL}/insights/tenant-improvements — tenant-improvement trends`,
    `- ${BASE_URL}/insights/map — construction activity map by neighborhood`,
    `- ${BASE_URL}/insights/contractors — contractor leaderboard`,
    `- ${BASE_URL}/insights/network — who builds where`,
    "",
    "## Machine access",
    `- ${BASE_URL}/api/stats — current summary stats (JSON)`,
    `- ${BASE_URL}/api/contractors — contractor data (JSON)`,
    `- ${BASE_URL}/api-docs — API documentation`,
    `- ${BASE_URL}/openapi.json — OpenAPI spec`,
    `- ${BASE_URL}/sitemap.xml — full URL inventory`,
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
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
  "/api-docs",
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
        COUNT(*) AS total,
        substr(MAX(lastmod), 1, 10) AS lastmod
      FROM (
        SELECT
          pr.id,
          MAX(COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at, pr.updated_at)) AS lastmod
        FROM projects pr
        JOIN project_permits pp ON pp.project_id = pr.id
        JOIN permits p ON p.id = pp.permit_id
        GROUP BY pr.id
        HAVING COUNT(DISTINCT pp.permit_id) > 1
      )`,
    rowsSql: `/* sitemap:rows:projects */
      SELECT
        pr.slug,
        substr(MAX(COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at, pr.updated_at)), 1, 10) AS lastmod
      FROM projects pr
      JOIN project_permits pp ON pp.project_id = pr.id
      JOIN permits p ON p.id = pp.permit_id
      GROUP BY pr.id, pr.slug
      HAVING COUNT(DISTINCT pp.permit_id) > 1
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
      theme_color: "#0B2945",
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
      "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADNElEQVR4AexXW0hUURRdM/mIIipIyj60qCAqpH56ENoERYERZBC9y6KghP4MMjUTf/rVgX5srmWm+GNQEPQRU5EjIlSkJkg6QmWa2oyjc2euc+5p74lO4wNxroQ/M5wF57X3Wnftcy5z7W63Wy4k7KCfw+GwLQSIGlEB3KmtrZVzRXV1dQXFpBDm3ZQAKYG9OQdw9PiZWXAaaavTmfS2y+V6QJ1UwrxajACJ8bDE0KjAgG9mDAcEwhMSWVlZyM7OOatpNS+JfTHBcosRYMKISAQNibGQiZQkYFN6EjJWLYqOeU6neSHIKqLbuHEDDh8+lKNpWhcNlxAsNSXANCWoQVIt1qywIzONFFDK1GQbdqxPQfIiCaYWQsDj8aCyshKNjY0IBAKZLpc2TlstNSWAiTlDZloy0lcmcXcSTBMIGxHs2LUfJy9cx7lLBTh/uQAnTl2Mip60OY6BEmAyAz19zw8Drd3BaQhNCJiwIUBlGPRH0P9rgs5KBKNBE9HYOEhjtyoB7IBJAhiCajETJqj+umEioAv4gwKjugmdDiXHxiaNp68E8FMQf9ROSQLmBApIXbLMe/XqFVs8pLF7pwiQZCcU2AVDGBgK9WEk9I1uSVitccUMw3RvXpu0PjZhvH0lgG3kU85O8En3hfrROliH+525qPdeQZ03Hw2919Ax8oKuqh8iYtZkb1u2P17CqfuVACaWJqgEQL/ehZZhDW2+R7DTNfwb5Bdf8XbIidq+82WO7cvzed7pdGZWVTlZOw/jhhLADhA9foa78cnfhC/j7hmT0evq4uNjr+7y4ud+uW/PwdPeP7E8Ez+UAJMO3pjhQ7vvGfqCLTNmopPmqM9reciLN55fvvC0656bbw3H8pwVKAGS/G8ZaEDvWBuENKblskvbuvo8z2teONm0+86g0VnTM/YOb75rEIjwtCUoAbquw/5xKTLe78TWjlyFLe253oY8j+3J8eY+Zigvr9C2th8p4z0ZH3Yh2ByCoJcUr1mBElBUdMtWUlI8DaWlxZOuGY3zJ+0rLrbdLCyk6lihx78/JNbC5x+lHJh/KmsZEgISDiQcSDiQcCDqwP/8PJ8tN7+8fwMAAP///nl2mQAAAAZJREFUAwByJtg/tBNbAQAAAABJRU5ErkJggg==",
    192:
      "iVBORw0KGgoAAAANSUhEUgAAAMAAAADABAMAAACg8nE0AAAAMFBMVEX////29/jT2d5Mw//5cxZ0ut9EseprkKkxhbSLXUEpT2sWQ2QPLUkLKUUKKUULKERS0P0OAAAE4klEQVR42u2ZT2wbRRTGv93NprkE7aFxc6BoL4UoF4wEtEolVIRASVEkJ6jBTtWoVeBAQGpppIZitYcGhwRkKhDOoUGkKlLsBkFTKuIKDg2ClqYIZA4Y0ghpJbg0joSPNMZrDus/s56NvWvvnvp8sp9X89uZ+eZ782aEP+HtRwQBCEAAAhCAAAQgAAEIQAACEIAABCAAAQhAAAIQ4MEGbBz0FrAVWuv3EpDv05D+1DuAfkoDMDXvFaAwuwQAhamUR4DZ88WOHHJAEOxfUNwcKX/dcUtxvwd/VNrH/YNZ1wEbh9lf9464DdgKmd853e8uQO/TqiLpeVcB4jkuFLno6hD1vMmtikjKNcAvgDAW4IbtkOYSYH36CiC+p3KE4awrgEwYi1cBKcktrnvDbgDa54B8QgNaeYIN764L0E+nAOTDGuD7iPs3fbZZgJ4wtJILZ4H9l7j/F+otB+l4bYdOLJVIGz3Abul29RM/PNPZRA+EO0vl76tfbiPWVBN2vXaG/RUaAPIvcOKv7d01e5AxtY/FXy3FWtu7awEyr1el/GlrsTY6B/k5LnIGFmKVFxobIn2Gmz1pEuDEKiZU4B/ngEKCb/8tlXdWIewHchdSjgGLS1xo6HFg8w1AGDtRCYaPAvn3f57RHAJWv+BCwQHg4XDuBiCOlZ21+xigX04hH846AqxHudC+QaDwIpC4AUjJIqH7Wmm15+acADJhLrT3HFC4DgCJFaA1rgDArs8qq/2nqH1AO/828mgWuG40FU8VxSovKMDtKOMl9gD505wm5IgCJEvz/onhrGJCNQ1m4oo9N9Uvr3BPneoCNmfLT3zX04bdLc/1Aplx5rHf93TaMLtCnBOo9HIA2GTnRf64OJjmzkrvqnWHiHXo8gIIAP+Z5j13nEl3zODyYuUAW1HLBYBvzbF/V5h0x4BP1AW0jnMCHQSA583BtgNsuquMUX1A4emqpCUbxJaIKfghgDsWk+WvL1MhaCLIMQAXNGAnQ5DfAbAWtZys+utAZF9DiijAzZnhLLAzUGlf4dJdebJsLDTp1crXCRW4O2IUHH0lwisKn+7Kk2XHKjrKozHkBzZCpYKj1yCE/FbpDvKofbPbM1npc7G2Sc8DQi8ABA8YDl3dfkxxYNddL5UcOl+qbSIXAeFroO1Za4FGFCf5oDAUMBxan9XYguPviHzVMt1JE6rDjZc+/VtMQSF2nnmZz4vyWuUFGhpwvLPL/6UCsQ/Y0K5lBQDWw/bbr7N1ZIp7g3ALQO4wn05PNrZ1vDtSXdL0A2jhluvek64dSKXPAkLQb2cB2AE8al1wiBN+Lp02WIA80vIjV3A85IfYtcy0MKU2UUKNcfW3HkkBHTFuP9kgQHjNojrWgI5Jdj/ZTBEofcMR7g9ngcfGt3doZyqS4nz9fQSAkfj2DTZfiPvivFj7ASFUdKvmjxIsxJqeB4SgXx6tf1hRp07eTqzftz8BoefJTrgCwFPW9beouHVeZCVWu2en9rzIQqy6qwALsXYfdfdY05esygzX3D6Y9ZnEumPZ/aPl/UxWERc8OLtmnLWc/d0FlMUqvO335v6gJNbuY15dsRhi7f7Ku0siX9KBQBvaVfgu2Reo4ysW46Op8PaqUaXLUgIQgAAEIAABCEAAAhCAAAQgAAEIQAACEIAABHjAAf8DHkdpslZiJI4AAAAASUVORK5CYII=",
    512:
      "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIABAMAAAAGVsnJAAAAMFBMVEX////19vjT2N5Mw//5cxZ3ut5EsOlRiq2NXT4pT2wWQWEOLUgMKUQLKUUKKUULKERKJ4FSAAANoElEQVR42u3dX2gcxx0H8Lm9s1qomwpCUCEPFTRVZQLlkhhJuA89WoRkpITUODROSSkSsS2nVetGsbHkOlBLClXtqoRaklMk/FI7aoQtilRLMSkqJKkkCtFDixwZg6D1g7ADouShdlanPsjS/fZu/8zs7Mzs3X3vSX/u7NuP5uY3v9/MziRus/J+WAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAygBgurW8AeY7l8fKGWDlVcb6Lxl9C4nbBv9zu2mVMWb9IVOmLWDr+ln26FJ5AmRHVre++PzYalkCDA1uf7V2rBwBpgdzX3/SWn4A8530u+VflhvAyqvO76+MlRfAg4515w8235wrJwB7f0G/n31lrnwANk66xL1s92q5AGSHJ91+vPZSuQBcH3T/+VpreQBMd3r9ZvnZcgBYOeP9OwO5cfJnugPg/nWf3374SLrEW4Dte/0s2zdX2gCuAdAhoDs3tuIQAOlDd26sF2B4MPg5az8pXYDp3/I8a7m1VAHmO/mepzU3tsxlwN6PK5dYCVaFH5ZA+f4s+grFVhyvX2dubOkuAXM+XVtubGkvAfM9tBWKYzs7rKtQrCsZ2puaF3zFvXvfLaUWYB2tFn2JnkKxto9AalZUYPPNSyXVB6SGK0Ujh47cWGMnWHNBOHZqyI11RoGGt0RfoSE3Vg2Qvfi33DctvxB9ufrcWDXAjfdHSDPuOC76euW5seJxwOIFtvn3r391J/V65t83Bf+FT3c/VcQtYOUcY8weyH2Qk78WDoaKF1EpBdg9sZUITpBgeF00GG6qDYYqAezuhx//xfO5H1ZcqYxVMFQIsPH2zhtfIKPaml/FKhhaCgMgaboz5IPcIjwcUJkbKwNI3HB8dGfJd/uPxyg3VhYGF5wD382PpYKhutxYVQug/d5WjygVDNXlxpbCAUCewEQlCYbiufFcMQHQyJ9rFGS+o0I8N1ZUKFYCsDHgGrkXRmOYG1tKAqDHW50dk8uNiwXgxhzPb0Lkxq3FATA76v3ZuBi73Dh6gMVR395hVaZQfHMs/gAuAdCZIMWsUGypyYB9BM7J5MbRF4ojBtjoXhL5iFSYD4bRAmxc5Hh7jmB4wXRubCnLgH3CJCkUN5vOjS11GbB3OxmRGg5EmxtHmQ4v8LZnmhubnjeOsAWsnOdPluSGA+8sxRFg5bRQulgpMRx4MR1DAHtC6Ok0NxYdDuw5G8NOkJSAOTuMsbDDgW9OxTAKcAZAFsG8cdVQDMMgbwAkj/o2+h1/qXzXUHUMAWZGRV9Rl/c55i2VWyPpGA6FF4WvP3Uw78YRq+N5rqbWk8l9835cAAIyYLfrP1HQjrlK5YnuH5Nu9OJYPAB2T4i+InnYpR3zlMpr2xzjLvGeRwUARwacf/1HM24/Di6V7yEB8MFpzuRTNUCIN9H4ndzXdyf5542rfp9fV6EVNkMAIQYATaQdf376+hxvMKQBcHvcRStsZgDEP4Z17YRvgrF3V/mCIQ2AOXb7HDOaDi8IV3Tqusj1j88xlp1/spJj3tjqycXJxHvXdr6+89+nDbYAgQx4ZwBAygLjc4wxZv9mPTgYJk6RADg/6lFh0w1giwdAOgB452E7ts8El8oPtXlOvdMKm14Ae0A4AB4hA4BbO93H/atBa6ppBpw/7nJU2HQCCGfAjDWSAcAtch2zV/3njaum/JpdiDcSBYBkALzr+DvOXvPLjasu+0+92xLDAUtnBkwCoJ1XQJshl9CSFwyt/uqAqXdaYdMVBkMEwN7/5a7jT/l/MxIM8wrFjrsoSQCkjzsr+zS3gMXzMhlwdryg+dBg6CgUJ05lOKbeF8b0AshlwJvjLh8fu6faNRg6AqB34WFmTCeALZcBz7h2H/ZzbsHQLwBKDsrDA2wMSGXAtzy2kbjvEgxpCdi/8BAyGFpRLoLiy4Bvef4dC4MhLQEHFR7CBUMrzH3QEQ4A8j7Ik87c2JEBB7KHCoYhwqBHJPILgOTWp+xrfs9cJcHwidTi2w1C4647n+zTALAoPABI/bSSBEDfdurMjb/yvCB7iNxYeAcJoTnQreunA7nxoL9jqs+1HS9wjjua2xT3AbulMmAr8PqZ3SNVeBDOja2QtwGFy4D/xdF92ldlxh0bI0sqAWQz4N/xvGL2qkzhQbRQbBnLgH0Ersmw22Lbj1j6MuDHubtP51BZlF1snC4CcF98DpgGfYH86V2pQf7inCKAL7RLlIAZ6+J/4Qset1lwsmcUAWw2ZmTmgO/08r6wOSNXeFDWCVpHMjJzwI9xtoGm70sVHvqr1YVB13ltzwFAgdY3fs71STsQ2cxD9AOhVH86zABg+1HL0YJSf5YrPKTVDoU/OxhqEdR2IP1BoECqbzWqwoOaekDNa8IBcIP8d0ECqdcroyo8qCqI1LcL9sQbJ8jybiugBb1eHdXUu7qKEEcwpAEwOzxJ98jc5RsMm6tl1p7V9TIdFaHEM/cCRtvJk6Qn+ssbjP2T7ITypdqPvFswCQArveKFly8yLUVR60iavyee7sy/9dk7GDZJBcCUYACUKIsn/YMh7YkfbqXuuPXZKximDkhNvR9O65sY8Q2GtCd+cGi98G4vj2CY6pMpPCSFRqnSU2M1XVw9MdlKnd767BoMHQFQvPDQmNE7OeoZcGhP7NhKnd76bL3gGwClF5/rWB/Q3B48B+zcSp3e+pzq9QuAM3KFBz0A7rmxoyfO30qd3vqcnxnSDDDM4nOmf51g4ulPVwt7ogYSAAvO0viAnB/x6BPz0Q0ATtQyA4ukXOIObRUuW6k7tgV7kjx31wG5mYe0mWVyBQ2PTsu4bqVOg2H2xYxbjxBm8Xna1ELJml7PntjuWA+69XlnOOAMgOoz4AiXyjpyY3obkOdW6muO4UBBANSSAUe5Wryh3T0Aep+lQm99tnoZY6xFdwYcJUAuGDoC4NAk3/kRj3Ux1vycVAm8i5m9e3w7GDoD4Bt+L6G58aO1X6YBsE9m6YGpEybsgSXGkkdJT/Thj8KdHxEiAzyZNn/TVKo/nZcBd4bbFkxy8bm52+Y+O+jMgDvWWZidUCSn3o0esvKPvaJniVRdrpZfe9bcxmJy6+xegcPEPLbM1pkBq9xHiOMwMfdtweRvv44HwPXBcNuCRXD7dSwApjuZpi2zw5WAVe8qe/NlkWd/8K3cNTz+yMeCAbCBxW8jpQc/DL8tWHN7BLdfGwYIOE3TPzcWW30ilwGrAqDzGkx4WzCR1SdNbSyWe4l1SG2ZzT+zI5sBK+sEw2yZfTe3LZhV9Ve+lnaexXU7vTBbZp/xrLB5Jl8svhsqim+ZzS5fElt9koxqAKBmJCi+ZbajVN7QriMDVrqpqtyW2cHBMIoMWO22unLHSQUFwygDoKqNlVuOyxwn5R8M69tZEWytfUxqy2y/pZh1Z1kxAITYI5OWyr1Xn0SVASvfXV58j0zHUcteq09SEQdAhQcsSB4n5T7UDbkIyswRGxV/FA6Gryz5x7qwi6AMHbJSKxwMszQYuqT7jZniOmZH7jipwqWY9W2syE6akjtOKn8pZvhFUMYAOPfI5AuGEougzJ04aX1vSjRsO+aNv/ZR2NuA4nLcnuRxUrlgmDxRXZwHLkoeJ7VdKJZbBGX0yM0QuXF3YaE4whKw9kNXxXPjtZfyC8VNbayIzx2WO04qeTgdbQlY/7nDkudHWPX/IRuQFSVAiFI5DYbJfYqvP5oVIr4PviUjPIuoivT0efHhgKqzFQ0BhBkOKD1qWTsAq4nJ2YrGANi334rF2YrmAEKUypefLSmAEKXy26UFIFwqt4ZKC0C0VK5vKKALwGPLbK/h2akMKzUAodz4UBsrPQCB3HjPWVaKANyl8mgPE4sRAGepvGqIlSoAV6k86sPE4gTAs4ws8sPEYgUQnBtbPRlWygBBubHjLJWSBAgYDmgcAJgC8B0O6BwAGAPwKZVrHQCYA/BcVa53AGAQwGM4oHkAYBDAfTigewBgEsBtGZn2AYBRAFZxpdL0AMAsQMHpkvoHANqmxhjPTZZ7pky9DVMtwFkqrzJ2/QYBWC4Y0sPUyucjkJs31jobHKMWsF0qN3r9RgG2SuWJHpPXbxaA1VxwHideZn0AY4xND0+xsgYw/rAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABA/eP/Sb7+4BifnLwAAAAASUVORK5CYII=",
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
    permit: "iVBORw0KGgoAAAANSUhEUgAABLAAAAJ2CAMAAAB4notuAAAAwFBMVEX////29/je4ubQ1tvJ1uPH0du8x9JMw/+uu8ecq7n5cxb0cRaRo7WJmqpHuPJVnMZ6jZ9tgZQ+gKlQc41lbngNbslcZnM4X30MbccMasIMZbgMXqsLYbFEUWApRF0bRWUXM04SQnISM1ALUpULR38RQXERQHARP20NQHAPPWsOOmQNN18NNFoPM1QPM1EMM1gNMlQOMVELMVUOLk0MLk8LLlANLEoLLEoLKkgKK0kLKUYLKUUMKUQKKUYKKUUKKEWCOD/1AAB2IUlEQVR42u1dC1viyrb0iXAPKKhb9oxDBs84M1vU7QMHxD7I//9XNw/SayXpJN1Jd3xQ9X3n7BEhK0Qpuyu1am0JAACsY/Fw6+Nhsf7y4erCCa4eEgVSXzqs98+3v3x8+yfxpX2kCny72sKvFgA4wGr28DBbRf9+mlw4w+QpqvF69/v33Wtz9ZaXX79eLqN/T87/cobzSaIeCAsAHFHWmq7mDukjpJB5VOflpdl68/V/7xzSVUhZd6weCAsAnO4Nr39dOMav68Xb1fvz4++/HOPvH39kORAWADjEjXP6CCnk5q3qXX75qwF8uQRhAUADeL7+6Z4/fl4/v1W9BhZYiSUWCAsAnGJ65Zo/rqa83pP7ek+83vW5a746vxbYEgJAQ1jd/3ZJH7/vV29c75+vLunq6z+8HggLAFxj6U5Z+nWzfPt6C3dK1pfLRaIUCAsA3GMxcSIt/ZwsGEsxLlm4sTbweotLxiWPbqSsv3888nogLABoCC6kJSYmvQb7wN93y6bq+T5Of7d2SfWuHXjdv12n6v2zAmEBwMeUspiYtLpf09PVIz326LBeLFsxgSmkFKviFaPDuN45CAsAmpKybFoOfl6rV1Oy2y/YJDqqx1tx4tYZH3Ob+8K/f8xV9UBYANAY7HXNTOjjnO4cnDy5rZf2MTDXweMPW3zFxKtEPRAWAHw4KeuKc1J2GTUhY9Yf2/Xussuov3/c0WLIipT1bZJXD4QFAE3CT1WoLSbFqQy5nYM/aUFkt16OsZ1Z0Zf1LQ5fSLzK1ANhAYBouFvnV73W42eNI9nr1mH1nn7kktGXH0+WunUY+SnqgbAAoGnMakhLk5lcyxSvnZjFs04+Fq3VSuyhzOJZJ3Dm/K6wHggLAJrHY0Vp6eoxYbwq28ot7dXTcC0wH0LVbp2v/5TUA2EBgPgg3Tq0aJLGqzK+WVmqp8dAZMuq1K1Di7TceiAsAPgYwTNMltK/10i2rOdJ9Xr6GchkyzKWsph4lV8PhAUA4iMEz1CIjJkkRbYsM0sFWRnMAmTIluXidSAsABDvv1uH+mLmxn3U0pZVqd6d+Urpzjx4hjaTxfVAWADw7qUsEpMqRbaTLUuzW4fqVfIo0OZOU8oi8aqsHggLAMT7Dp6hUJfKFi7SozS6dahegfGqhIGkLUsjeIZCZMrrgbAAQLzrbh0pJi3rmNZp0aRdr1YuHy2ayoJnZIiMTj0QFgC8ZylLikmvdeNppC2rMHhG1qsdFyNtWYVH0nsWCAsAPkDwjAx10TReadqylrlbS1nPRlC7VNJzg2dkiIxuPRAWAIj3GjwjxXJb+aHSlqW+1yjr2Ro+L21Z6uAZKV5p1wNhAcA7lbKkmPRkMaFd2rIK6tmc3CXtVdngGRkiY1APhAUA4j0Gz8hQl7nlARaxLSslZcl6d3YHSkhbVip4RobIGNUDYQGAeH/BMzLUZXH9y/7sm3nGlSXrORjlLG1Z7Niqx0BYACA+ZPBMHCLzfP3L6az5WDqLKayy8UrTlhUHz8QhMsb1QFgAIN5Z8Ewc6rK8cTbD+VfscfjD6jUxEPWfrxQiU6EeCAsA3hfu7iwZr8q6BV+T9azP6coxXIUDUavWA2EBgHiXbtKrC8e4okGDloxXug3O1euBsABAbMag6KIImcn5Xw2A0rKq1gNhAcA7xJ9mCEtG5l19a4Kwvl3VrQfCAoD3iNebX67pSqpYlsZzGYzvqlwPhAUA4nNkKBtaG26WqUWdfQdWTgJyjXogLAB4t0LWxB1fXc+z9a4dCllsoH2deiAsABCfbhxY+W6Q0SLNoReubhXS+C5fb5/UqAfCAgDxycaBlRvdl4mYCBn67sg7ymasiht/VXV+U7keCAsAxAfPUK48zDnuVPzJHnq0LWVRArI8uOIhEBYAwJNV5L3iyzc2hNCylMXEK1Xzs2E9EBYAiM8zDkx/fFc6Ip5C32263pm7fZ6Ol5lXqAfCAoAPnKFcWbxStP7I0Hd/q2hnX/j3jwWJVV+z3YUL43ogLAAQHzZDubJ4pd5msu5CdaaxGUipWqrXUF//WRrWA2EBwGZIWdSHUxBiyp40qdmt843sC/mNONSso1cPhAUAmyBlyQTkshBTGfpeL2/mK/XhFDc6U0O0Tj0QFgB8ICmroivrF90ELO/4IVvWvKqUJcd3RcarkvuIN/r1QFgA8OmlLBKvtIyozJZ1V8niECcga7qsmC2rrB4ICwDE5w6euXoUpsPumS3LPAiGdCnt/mZmyyquB8ICAPGZg2fIX7Uy6UyklxkGwVCIzNzkhWTLKqwHwgIA8XmDZ2iptHq4MpXpl+ZBMLRUWphK9mTLKqgHwgIA8WmDZ6gPp4opgmxZut0zsg9nWcUsT7as3HogLAAQnzR4hvpwqiZrkS1Lh4AoRKZqAjLJXzn1QFgAID5l8AypUHWG3UtbVmkQDIXI1JloIW1Z6nogLAAQnzB45udkIewMu5e2rEKLAlkTbmqGPUhblqoeCAsAPmG3jhSvLAy7J1tWvpQlxSsLcVrEfdl6ICwAEJ+tW0eKV5YCS+W9xlVeE/PK6iALea8xUw+EBQCfLHhGhsho+0QNbFmKIBgZIjO3l68sbVmpeiAsABCfqlsn3sCt7E6wkLasdBBMvIFbXFqdYCFtWYl6ICwA+ExSlhSvHqwP3JG2LB4EE4fILO0P3JG2LFYPhAUAn0fK+n23cpEDn7ZlySAYGSLjZtS9tGXF9b6AsADgswTPyBAZdxNYY1tWGAQjQ2Qmziawxrasdb0/ICwA+CRSVixezScuZ9zHtqy78zhE5sbhwGiyZUX1QFgA8KmwuP514RR8iKFwMMewaK4hCAsAxKcKcnBMV6m0rD+u6SqVlgXCAoBPhJuLRiBDjS//agSXICwAQIZy7XFhVsaB6Y8LA2EBgNj0DOXKs+6FjXFgBuPCmias0X7Hwy8UADjFq72OnMJxYaJahrJpj85SvBFhjTtbW1vb/bH+K4YBDJ4vYjr0gheO8o64vi87e3fkGa7mJ/jEAeKdSu9sXFhiUedKemdye9OENe1vb4XYOdV+TfiKkT5dtbdaEQkNghe2FD/I8Ayi55ztbPen7+v37PjAxzE+b8A7lbK4ePU0mbC94Z0TLxaNCwuiZgITaWOEdbazJbE/ckFY41749O5Yi7BGrZA8By8gLEBsaoZy1XFha3NqwpHlopeQEWK4hjufNERYXmsrAU0py4SwxjEj7ngahDWUZ9L4L9J3/0f/PbkLXICwANF4hnLFgBnBzKm/rhf0oF0pixKX+ZazGcKadbZS2O6N38MKa/sNVliHPikdJRdVtyAswIWUZa9Hh3lFkwoZV7UsSllcvHr68aXJtIbnQOQe7acpS0fKcq1hdQ0Efc9Q/wdhAeIdZyhXtjJkUgFpfqH+ODDtcWHphZt7wro4PDgc+u/odCdNWa2RZcKiu4Q6hGV0l9ALz/4MhAWIz5ChbGhlkOPCxKvqeL/vpdVhZUPKkonLLMimIcL6fhR8Bg8OfdFmHN8mZFLW2DJhCRPCMkF7C4QFbKaUxcSr1f1V2cjV+lIWE6+y9OeWsP4NP4Ehjv3uIy8rZRUbC94PYe1YI6zvB5ywZocgLEC4HgdWK5thobXBZJvGWvkNPJtBEbO15VS8OjwgHB7PlFLWWTlhjfv729s7LSl6DXs+4q9Ogy+G4T+7AcYKwhq1d7a3d3s+URFhjYIn9yN6Cw4xEtPB/s72bptra16/veufxHZ7e7vlI+LO6fD46NDH0ZB5fm/XjwXvksgpfjA2g14cHx9GF8PH7Hb91UHw1fcsYT0M/Zcf+C//Fx864G2kLMZDZamAzJZ1Xblb59t1sR625VS8SiLYF2akrELtPSIsL37J7npp1A++aPPNWkg8U2KjBGFN2/F6bihST9kPnxCy6GC8u35ae8yt+fFrY2J9Pqb3dRQT0ZKWkoeysfyBHjw4vqUlVIzpd/7VMENYxPeHWHUB9aSsx981xSuNVEBmy1pWG0jxlfpw7tTLtC3H4hXnq2F4MgkpK2zUuR0+FxHWkChux6tAWGNa1W17BYTVlk9bH/olaR4biCznHETsNDtKU0+wH04Q9uHUlLASzwVjARYylE2tDEvDVEBmy5qb7wtl4nKBQWLLuXglP3L+J9b7z3/GXMpq+9Qx81cshxcFhMWFr3YFwuqz1/fyCavHnjYiIWxrp9Nrb0dsFy57ku/qiHPL4SFjsWWKsY8NCWuYPCYYCxDNduvQesmgNZHZskyDZ0i84sarJggrKV5FH2x/azr+z//93//9Z/S/WMraHdK+5+h7LmH5JtPB2aDDqMSIsMbRQVqDs9P+eq2mJKyt7a5fJlpUtUhoj44cVu+K9T2+g+OLf28vAnY5mhK3BLu+SchShw8xOR0ef5/dXEZv8TbSsI4SGtZxnob1XV6W2+g53/GJA0RzwTMkXhmOY2W2LJPgGQqRKbzNuNWEeBWuoP43CvgqpqzTnbCNj20cj29zCGu9DzylThojworWSb1IzdrPJ6ztIfMvhIJ7SKrrbWV4IsEPL3w70R+R74dHM0EkFl3sI/r38cHRLdscDtnKSd4l/Pcg5y5h+M+jZ/ZvfN4A0VTwDIXIvJobuciWpR08QyEyJerXViPi1TPRVURZPgWM5dpBKstTJWGttSPRiUnDjLDaREz+0i6fsLrRM87CZ4zjf3W4rcGnp+vwTNcPzma0GDpc3x38zp4wvFbYFfQIa3HIVlWz8EkP+LwBFoJnfprs63KNV5ojV/W6dagPp9R3ap2wvmfFq+CmPKOrAKPU7bY1Zf1b5MMisjEirATpTQtE9+gZJMsPVYQ1DU/0Ij9j4TV8U6lMK05SeoQ15MQojtgKDQBqoXxmIYlXNuwQ5cEzFCJTPt/Q+QprLU5lVliKjWPWbpQgrLH0bpoQVkRAw6xxNIewhJTKPCbcv8jV3VpyOx5eTBN0csyN7Gly4fSjR1jJXeARZHdANBQ8QyEy9caxki2reNVEITI6jYiONazw9t/ZbuDmHP/n/5iGld04qmT3pNM9/Oq0EmF5+oRFNXfkw9OuXG2xXezReg+beSvkbLj0RXYfh8YrrOxdVhAWINx361AfTu1xrGTLKpDRqQ/nTssH4eQu4Wy92QvEq+iOYKiweyFlBcaGrOvhcFjemiM3dyaENapOWP2krSF68PkobYUVhznkknqXhzUJC6o7IFx360jxyso4VrJl5UhZJF7pJtM48mGFcnqwxfNiO2bgYfD3hcFuUOF6OJ6K90dYz0njaH8tgyW45Hs+YX1PPQ7CAt4RVGq6FJ6sZcKTfK/a78kQmQLjVWNO98BYtM7UI5fo+H8q8eroWghdwjqrtSUUJoQlxm3uyWdv7ZCaZhaxwpT8Q+U35kRNg0eBx+q42pbwKHFMGLEAp/tC2YeztDl1R9qyMjcAZYiMSb6Dy+bnWSpPJkoZHWZ2g5dCK61hLOVzE8IaJ2IWjFZYfjf0znbkNd3tpxIebr8Pj+IlljpjIaKcqZW7hAAgHM/WkeLV673lIWHSlpUgJilembUdbjUxJ4d6AQMpK7nCOjx+FsWEFatbQ+mQGnBrVavE1rDD2WhsQlijna3tomyb2GwwVG7YjtJmUaMtYeQOwWcKEI1068gQmYrGK01blgyekSEypoF/bvOwvHY6TSaQsmbMgKXyt6cIq8+XUrvS3LkdZSrMtnWMo7tTbgvVI6ygp6edPafLoxmnl2FMOnLHdjzM2BvMV1gpd8Tw+BWfLkC4Cp6R4tWTo6nRskAUPCNDZCamkcquE0eHu2nKCqSs2OJ+9F0jcTTqmZmFzoLIjx7pUp2QOHpbWq05rTEFHWsSVkBuO5kV1lCe9etR7CGN2gNvomXv8ZpnmHcqurOoJKznwtacw+/ycZgaAOGoW0eKV0+TC2eIbVn+DlCGyFRIgHee6f4y2FYNzAl8WIfDV51Md59t+me9HZ6jsLsWlk67O1tKworWYK3WQDY/73TP+vF6T5+w/IPsB8l9rXZvMKI+58A3enEkU2O+rze3w4thtHi8lIzjv8XFxVEo0vv6O/Xu+OYstpIKvFoP8jVHRxexZn9AxwRjAY4+oi+WjFeatqz53MR41TRhJWPwSMp6HR5P9abm8JevO2VO2bGUorsXx8nox8sot4TJoRln2VsGx0JlQrigHqXDwDW6DmUIVazloSqZJlplDZnv9BK+UaBBLFxNt1emZVUeCdbIXMJRSyVlCd0xXxTgt7vOAn2hh86UhCVaRFiztl6AX0Z0H6TPOng4ecvgaJEOHI3t/ZzFDm8vmRPrMkFY00NGWLNDZpQfqrzzAOAEN87pKroVKaXgipMqGpr8nA5GNiIsaYfaHWdWbQO1rSG2UIWpMpKx/IhlI1uDlxbgAsn/+ojd4ZQJCpeHmQfJ6B5bHw4Tz13rWPHxQh0rytNasxPP3rnGRwoQb53iYHEaa9WZqw0RVtJCqj1vuR9Mh/Dpxevu8iEU0SAK/6H2KDGEoh8gJrXRoB8/Hg6h2OkEZqzgydHQaS948ikfQpGs6YtYra1w9ISP3W1Sv5YX/mgJPwn0+HIm0gMnjo7ZfG1xET0UUtFl4B9dP778PvS/kJx9G3y13iC/XgzXYX4hmUUHGCJZBnCO6ZVrvrpKiEDVZq5uNXY9yOLQHX+IH2CPu+xfRtvWBhMCgPisM1e1BlrUmLm61eAFiaZJtLyP8ePzmDlVtkIP8GsNCMxcrTWNVYgaM1ebJKygV2fnw6xRgjuR22zT1+WuewAQnzPF4acbS8OCsRSTTYxnrm41ez3GU/GRCGurE5/v82mwJdye4lcaEJi5Wn0aa9g5yMYPms5c3cJPqGBLGMx87voafGediNXDZQEEpKzK4pWUrWRSw3tqfv7g6GZsWK0xrgogNmDm6k+bVgZaTfHOwXOae2AycxWElY9U2MRO/xnXBBCYuVptGmvGx3B+LcxnroKwCjAetMMbm9s7u+3+GfQrQEDKqipeKToH//5xJ0xnroKwAAAQ1Weu6kxjLc901525CsICAECUBZLWiXMvimz/8uPJqFsHhAUAgBqzGlLWZKZpD6VBXxozV0FYAACIajNXdaaxargWmC2rtFsHhAUAgLDarUN9OJr9gmTLKuvWAWEBACAsBs+wEBn9yHayZRVLWSAsAACEveAZCpExC5AhW1bR60BYAAAIW9061IdjHNlOtqyCjSQICwAAYUfKIvGqUqIo2bJypSwQFgAAwkbwDIXIFBivikG2rJzgGRAWAADCQreO7MNZVJ0wkbRlKYNnQFgAAIjaUpYUr8ziYopsWaojgbAAABA1g2dkiEyloPZcW1Y2eAaEBQCAqBc8I0NkJud/WYG0ZaWDZ0BYAACIOlKWFK+uLdFVwpaVDJ4BYQEAIKoHz8gQmbuKs1HLbFmJ4BkQFgAAomrwjAyR+WOXrhK2LHZsEBYAAKJi8EwcIlPZeKVpy4qDZ36AsAAAEJWCZ+IQmVrGK01bVnD30de1QFgAAFTB3Z0l45WmLevy0v8/EBYAANVhxXilm5YFwgIAoAYm5381AErLAmEBAFAZV9+aIKxvVyAsAADqY+lOcCfhfYktIQAAVuDAgZUzuxCEBQBAbVw7FLLYQHsQFgAAVTGZ0L9d3Sr8+g+rdw3CAgCgEm78VdX5jRDCoXeUzVgN6v394xGEBQCAMdYBxgGFiOJM4zriFT84WnMAABA1ZXYuiduVsph4heZnAAAqYp7c/X25nDtwvTN3+xzxMgAAVMMi2zn4laSmhZ194d8/Fjn1QFgAAOhiqV5Dff1nKXIyjauAxKtMPRAWAACibiMONc+kMo0r9OFMCuqBsAAAEPUbnalBuVbezFfqw1HVA2EBACD0jFcl9/WkLWteVcr6+8e8uB4ICwAAoWm80nZO3VWyOJzfldUDYQEAICz1NzNblnnwDOlg+fVAWAAACAPjVVk7zbxa8AyFyBTVA2EBACCMjFdlsvnCPHiGlmbF9UBYAAAIQ+NVmU19aditI/twyuqBsAAAEJYTkEmO0iE8CpEprQfCAgBAWJ8wIW1ZpcEzFCKjUQ+EBQCAqGS80rRlFVoiyAqhVQ+EBQCAqGa80rVl5UtZUrzSrAfCAgBAuBksIe/9rfKapleG9UBYAACI6sYrTVuWInhGhsgY1ANhAQAg6hivNG1Z6eCZeMNoVA+EBQCAqGe80rRl8eCZOETGsB4ICwAA4Xb0fGzLksEzMkTGtB4ICwAAUd94pWfLCoNnZIiMeT0QFgAAwobxSs+WdXceh8hUqQfCAgBAOJgrWDRnsHI9EBYAALaMV9ppWVXrgbAAABCXfzWCy7r1QFgAANgZz6U/vqtyPRAWAADCwngug/Fd1euBsAAAEBUyjU17dJY26oGwAAAQjqV3JrfXqwfCAoBCPD88PTdZ72kyeWqy3vW5jHgRVcdz6Y/vEuL70dH36vVAWABQRFfT+9vb+6eXpurNJz8vLn5O5qJJs+jfPxihuOglpKNPjg98HE+q1gNhAUC+qhPQVYD76WsT9RbXvy5C/LpeNFHvLt6S8S3bwq6URQnIQtyGdBVS1m21eiAsAMhDTFcRZblfzcV0FVHWc6Pe9i8/nlxIWZwJ/z0+PJA4PP63Sj0QFgAo8TpjdBXgYbZyupq7+32RwO+7pWhSYOdLoWtLUhaTx2acriLKmpnXA2EBgJKuHm4zcEhZr/cpugop697ZRnTx44sqa09S5MqGlCUTkP3V4zBFVyFlDZ9N64GwACCD1VxBVw4pa3V/daHE1f3KjeMqhx6+/WNPymIrtlcVXUWU9WpWD4QFAGn6eM6hq5CyHEhLTzl0FVKWfY9D4WrmfGInv4FnM1wcHeTi6MKoHggLAETKeHVbCNu2rKfJRSFs27LKUvOY7nRduVvn2zUzXh0UgtmyyuuBsADAhK5uLduyQuNVMazasjTkbWbLWlYbSMHEsMnxQSnIllVaD4QFACmfaDms2bIW3MmQD2u2rDu9XR4zI8zN94UyAZkbr0oo61azHggLADI+UR3Ksm28KqOs50ZbBZktyzQIhsSrf48PDzTBbFmF9UBYACCyPtFy1L5hmDFeFaO2LWv+40vFm3wmQTAUIjPTp6uULaugHggLAITKJ+qYspTGqxLKqmPLqjAelZQo7SAYCpF5HhrRVdKWlV8PhAUAOT5Rh5SVa7wqRmVbVsXxqOT81NpNkvT1ak5XSVtWXj0QFgDk+kQ1KOvZtvGqhLKemh2PSras8iAYCpG5ODqoCLJlqeuBsAABJ8NtDZjbssqMV7ZtWfXGo5Itq3iVRiEy3yvTVdKWpaoHwgJAV/VgaMvSMF5ZtWXVHo9KtqyC7hmS6CfHBzUhbVmKeiAsAHRVFwa2rIW+k8GKLcvKeFTSpnKkJXrCbW26StiyMvVAWAB8ojYoy7bxyooty1qwFdmyVE55uWv89/jwwArIlpWqB8ICBHyiFqBxw9DQeFXblmU1OlTu+TKt0/JW4swWXSVsWcl6ICxgQ7GySVcalFXBeFXLllWxDVDDlpUgQklkz0OLdJWwZfF6ICwATgZrlDW3bbyqbMta2Z8lwdZSj5QF/1jLeKVpyyIlDoQFbCIWDuiqyJb15ICuimxZEyfTupgtKwqCkSEyF0cHTiBtWet6VyAsQODWoEWobFn1jFfmtqxrR3TFBXZ/xyn3iN8d0RW3Za3rgbCATcPL061LZGxZtY1XhrasO1fjm1O2rPnclvFKz5YV1gNhAZuF16f7W8dI2LIWtpwMmrasP27pKjN3/tYxXaWGGIKwgI3C3DldhZQlFz03zukqpKybuJ7dIaj5Hoe43vHhQQM4PAZhARu6H2yAse6nL2QV/emer36SjbSBBVZiidXEAosvsUBYACQsp7cKp1eu+epq2pTinplS4Vhxz0ypAGEBAjcJ3fpHV7Ydo2n/6KoBC5ZyOqpDC5ZydCEIC9hIrGYP7uhKYT9fulOyft0sHffk5M+zp0WkOyXr8DjZpQnCAjaGpdjSx3pfTmxpWDKWYlyycGNt+DlZqOuZDo6oMB31f6PR/+QXN46krGN5N8HvVDwGYQEbtajiy5/lk1PxKuwc5N1+LrzuzOce1WMN0ZNv9vmKTUf93+g///d//2GU9d1Faw6JV2Gnor87BGEBm7QHfJjTKsv2vpAdW3YOsm6/lf3mZ0W9x1XNGHet6airgK4C/GdE9ew3PxP9xsc+AmEBm6WyP9Am6tXmvvB+ulKuptgqaGnT4vDzeqmu9yBqzEDVmo4qYrqKKItJWVZ3gyResU5FEBbw6enqKXfj9jK1xVfkvMp0DrJuv7m1pkLWj1NQ79GaxYGJVx6jq5CyPPmta2uUdXyt9k2AsACxcU5R1u1nx+LAOFDROci7/exIWVdPhZ2Kk6mFeTnq6ahinKKrkLLGtBiysi88vCAtLsmBICzgMyNn13c/JTlmVntfeE+3H3M6B1m332v92NHfd68l9RhFLutbHGg6qk9XCr7yGYsoy0KOHw1UzRrpQViA2MTh86x75qWelJXow/mlEcJeM9hd70j2unVYH854pKSrSMqSlPVvzX2hjHNXRcSDsACxmfZQ5kh/frKxGyyJbGeeg1kNKWsy06zHLKV1unVoOur/8ukqoqz/2ejWoT4cZUQ8CAvYWDc7p6yHuqHIGpHtzJb1WFHKuno0qUcUWdXiQNNRS+gqRVlV94WHw5KtJQgL2ODmG6KsVZXcmXvpvNKMbCdbVqVuHVo06daTtqxK3TrUh7Mqp6ukLavSBB05KSe/PxGEBYhNbm+mHZ2xlMXEK/17f3R/zzh4hslSBvUeKktZTLzSo6ukLcs8eIZCZPIj4kFYwKc3XumGsJvtC4nqzCLbySZlFjxDITJV65lJWRQi42nTVdKWZSZlkXhV9DoQFiA2PKKPhbDrd+vQZtI4sp08BwbdOtSHYx4RL21ZBsEzFCIzNqKrhC3LIHiGQmSKI+JBWIDYAOOVbgj7q6729Vonsp1sWZpSFolXleoRRS709oUkXuUYr0oYS1KWZvAMhciUbSRBWIDYCONVGWUJmeJwrx8iU9lSRWYqjeAZCpGpXI/0L43gGQqRGY8q0FXSlqUTPCNDZP4t5TcQFiCQy5fY45VJWVK8WtYxrZPnoExBlzp9rXq0SCsLnpEhMv+rSldJj0NZ8IwMkdG5swjCAkBXKcoqHGMvQ2Re68bFSFtWoZQlxav69WKKLAyekSEytegqQVmFwTMyREavpweEBYCuspSVt7WUITKaRihNW1Zu8IwMkbFTL7Zl5QfPxCEyq7p0lbBl5QfPxOKVrj4PwgIE5kpkt3vq4BnpvLKVHyq3e+rgGSmWW6v3UDgeWopXNugqYctSB8/IEJkLXQcECAvYNOOVpi0ry4GSzZ6sxVoxm1SWkySbOamXdWXJEBnPEl0lbFnZ4BkZImNg2AJhAQKzUZW2rFTwjAyRmdsdKCE9B6ngGRkiY7metGWlXFkyRGZska64LSslUskQmYmJJR6EBYjNM15p2rJYt47sw1lcWx/ZJW1ZzLUgfQ8O6kmKnF/+nenDqWS80rRl8eCZOETGsIMHhAWITTReadqy4s1mvBt8vnYyYVDSUxw8E4fIOKonbVlxhnIcIjMeWaerhC0r3vzFfTj/mvZIg7AAgYGoBTcMAykrDpFZ3jmb4Sw9B0HwTBwis7xxVu9XXO/qK4XI/M8NXSU8DtG4rsqRDiAsAHRVTFmzmSUjlKYt6+6u2XqXl87pKkFZ4UDUqmHKICwAdFUe8GfJCKWblvUW9dzSVWqIoVFjNAgLEDBeGUbIOKePZFpW0/Xc01UyLeuiYooyCAsAYWkQ1kMzBEJxe83U+/NmhHUIwgI2aks4v3dNV/dzvoW5+eWaPn7dvDZaj2XMO1ewUpnv/l+cY2wJgY3Cy9QpZbEE5IqZxpUTkJupR1N1hBPDaMG4VVEtQxmEBWBfWD7MWWI6cccfbFqzEA5actK4nmfruaSsNF2JauPAQFjAR8b8wdUNQkaLjLoeHUlLNL7Lp6kn9/V+31ONCc2hdyZlkXiVrGd8qxCEBcDdkJ+AHHQq+g3RtDlcupCW2MzTcBXHVltO6snQGh93vtf9/MatlMXFq5tkPVPvKAgL+OBYPtmWsqb0cV5GOtk9e2hhuReZJSD7K8ZIt/rJNmzW61FojZz9RaHILvaFbDf4mK13c7zphDX7/n2a+PJiio81pKwK4pWq+dm6R4q8UFxm5xK8s3pzmq7KhhBaTZfhY7/4aERez0TKsk9Yw3V4xFEUdnMtS4XLwPX67+h4Kb8bTU+88F8i6BlBsxG9jcP84wu5ohzyew/xd9fdlXLmmaJ+cCwa4Qh8SIuDNcp6ICtDarfJfO8re00zNL4rvftj+0Q39RaXX9WTcmy63pm7PTV8mtUzcL07I6w4W15NWH66hCSM6F9HhoQls+tThCUT7yPGmqy/PLxM0dtxkk5lED7wMSnLjsVBJiArSZCR2fLmp2VrgaJzkPmkbNUj8Uoxo1DGuVuTsph4tbwsqjc9fkvCOr64uPRP4GhNCUfHIR4iwjj0r1tAqBeSMIKbBpeSli6GwfooiE4d+i/ynx+8Nv/4Yv2M4+PvMfEdDYf+dw+D+zwzv9Cx/6X/pIlQ1w/OLmDLV3zqxcd2ZVlMGxWrhXLN9rCQlDWf2BSTVurbgTKE3Xa9nCnQND7VipRF4lXOCFdW7/r47Qjrcs0crxElcLo5jGjmcv3odbzYOaR11A1/xVFidaU4fnxERmfBf4+jSbLxlxfxMbP1o6fLHSWwsVIWE6/yD/VgT1piYlL+obSeZNqHk5PoHgZjTaxZHJiVYXL+V3m9i8O3JqxZLmF9J8Lwn/c9eNGROWHNsoR1vNbEprN4vXUTr6xe1fXD/94mzxL4oBaHeyt9OMUR8WwZVm8u4UrPHypD2OvWe1Vo3yoKuRZ25xLmrOay9ZbDw7cjrOVhRDXX4Q7Oxy0nrOF6ReN/1z/Jo2f/f8dmhBUff73Ju7iIFa3E8+WXMZFl6x+rXgdsWLcOuwlYGhF/T7YsC5OfyyPbadC8lXp/fnwpG/x8J/eFZ1UnP5+Ny1dz2Xr/Hr+NhhXJQscJWXvIFSf/Pw8xYQUv8FdZBoTFjy9l9OMywvqurg/CwgAdttHTioiXoe+UaWwoJkkjvVZkuwx9ryplEeXNL7/8pTGr/k89KYvEqz9ldJWqV2ZxcHmX8FZJWPHIjPgu3TB87FgYENbamjCrRFjp+iCsjZeyWB+O7gqN3U40D56hEBntFdMvur1nHjxDfT+Ly69/aeHLj3l1KYvEq6cfX4zrFUtZTgjr8MjHeipGRsPyv3m4Zo81YV2EZiwDwjoMjnCUVMXSDJW7JUzXB2FtePAM9eG8mti52MvMumcoRMYosl2GvpvXi19YOKI+6zlYVJOySLxaXH6pUq8weMad6C6EmrCO6N7dmrB8VjoWwkjD8hWstZqeIqxYihe3MU89JAgpWz/8178HiaMAmyNlyaYb465EcpIaBMGQg904A5kSjSvVE/98+8sIX/9ZVtgXyt2gET0m6xUEz7wJYRHdRIT1/XBqSFiMc/JsDaGXPf7ye8LWkKgPW8Mm7wtJvFo81JG+dINnqK25SqQoGRN0g2foFmPxrTo1vl2ZSlkkXl19q1MvV8pqhLCia8dMCEPmNA+IYiJMCYs4J75LGN2GnAZO0eugnzIgwcg4+v1mKDeB2fr+2Q2P1k8HPg901ktkXa/q4SLK0umeITGpatIVEZBOPQqRqUJXSZuUzr6QxKtJ7Xo5FocmCCvZmnMkGN1c08rmONOaU2hrGKbvEq5fIjX5y7hFkWvyivpozfmkeC2jLBLOX55quONfdINgSEyqEwQo12gG9e50btXlUciNrpRF4tXN+V/1602VUtbbEJakm+qEFXDOrar5ORrHcXiRWFseDZMS/TBhukDzs9i84Jl7aQBd1utDpOiZwiAYCpGZ14s+pugZzXp/atBVIgqmeF8od4OPtuqpgmc+Z7zMxcUz4mUArRYbC8nw5DrVaLGxkNROQrpGPW1ngY5NKj94RobI1KTHZL2slIUAP0BsXvCMvMFnKbCUjqeWlmSoi6UAUbnbK6tn5CwosEnFnoOc4BkZIjO3XC8TPAPCAj65lJVdQUmjusV8ZWnLUgTByFCX5Z29XKvYllVUT9snamCTUkhZUrxyUS8VPAPCAsSGBc/EG7jVwm5SaXzLMd09E/fFrOxOlJDRM3n1jI1QmjaptJQVi1eu6iWCZ0BYwGZJWVK8sj8j7EElLUkxyf7saNnio6xXxQilaZPiiyxpZXBYj3XrgLCATQqekcug56fbW3fDDGUQjBSTnpzM64rZKVtvcv6XA8RRMHJfKHeDbutJV9YhCAvYnG4d6bx6tj5pJ52WFbY1y5ZldxNYYydpst61E/rgFBIGz/zn7H9N1YuCZ45vQVjAxgTPxGSydDnj/n76HAfPxCEy84nDmfMyLWs+if91V99ZoJFeNf5PLF41U+/7UTBKBoQFCNhJLVPWktdbXP+6cAqWliXsGKG006uarwfCAsSGuxxcUNZr7YzQinmiFnyiOulVT29VD4QFbBRmt41ARgLeXDQCOfv98q9GcPlW9UBYwIap70/u6YpNibYynstgfJd4PHdPH2zQvN852Gg9EBaABkNHdizh0tGgnAQm3BiiUvaoSbLepMl6ICxAYByYTf2KJtpL3cxeR07h+C4asuxQV/pyuXzLeiAsABnKNuX2F+WizpX0zuR20cSdu9QdwubrgbCAjfNhudsX8t3g02TC9mozJ1IWjQtL17tz4zy/E2zYPY1AbaKe78O6AGEBG6O13ydGoOYFz9Rrf+Za+8/ECFRfnbbfS/hYVM9uK3LUjiySw+7ZCFTX9Sah0/3oAoQFiA1yXzGHlOk4MINZ92QW5aZOS1lY2QTknHoLu9KSzKjiW0C+ZXNYj8bogLCAzw+uWN1PnUhZXLxKKFZcZbKQNqoY35Vfz6K0xJkpYRZlpk5X9f49RloDIDbnnuBD3jxBe1IWE68yKX00AtWnTkv7wqupXj1bXclMrsospPhSyEG9WWIYBQgL2Cy6Sk5t9sUfC5TFKPBVlVn8+17WW91bsDjIEBmNejakpa//rMjC8FUVD7p0Ve85lZEMwgI2ja6SEwnr5yQz+sud5kxTm+tLWUy80qlXW1piK6hcOmIUY7NeJtIdhAWIzfS0Pyzs5DfcPy21PO3Mj76oEzdD47u069Xqnvmb9cUUpfTRCNR6c754vYujA0zNATbHeKU5ArWOlMXEq7JpzswmVb1bh/GQQb3q3TPfrrX1KaY7XduopxxXD8ICxOc1XmkHV1V0ZbGdpUZKH7NJVZSymHhlVq/igAgmTmmk9DFb1vKybr3JcUOj6gFAfJTYK2ZGWJlbHGjWvW5KH7NJLc0tDnJ8V5V6c/N92t8/5oaGBWZGqFfvVk1XICxAfHbjlfYNvvQ4MP0QGYNWQWaTMg2eofVStXqm3TMkJhmk9DFblql0RvX+PT48AGEBYsNvDZbe5DORski8MhyPymxSJlIWiVfV65kEz1Coi+FtP3aTb1Kp3iyfrkBYwIbTVVKJ0g6eoRCZV3M1imxS2sEzFCJTpZ6kLO0gGAp1qaBGfb2sUe95WEBXICxg4+kq6XHQ6tYh6SvXCFWyXJLiudbujvZ1VevFU6L1xCiSoir6QMmWZVjvtZiuQFiAQJhocodXPmKVnmvDnlAePEMhMjXqPeh3z1CoS/XxqGTLujOod3F0cADCAmC80hmB+qJHexQi8zSxMQK1LHiGQmRs1SteNVGoS73GQLJl6db7XkpXICxAbJDxSteWVRA8QyEytcejkk2qoFuH+nDqj2OdTMtldJLMa49HJVuWVr3J8cEBCAsQMF5VyIjJkbLoCVbGo5JNKid4hkJkrNQjisyzHEgxyUpSzN9lh6Mn3GrR1YYR1vAsgvfp3tlZp9XqDOofZ7S+QqMmTnrca++3u/KH4a1rnwmnxitdW5ZqXyjFK2sZ7SSnq4JnZIiMtXrEgKp9mtzFWRuPSrYs1f5S1vv3+PAAhJXB7laE/md7Y73ofbVrH6izZetI5fB2wlLbMUGdrmtvi4ZuDZbZsnJztJY2p+BIz0GmW0f24VitJ/eYmX2avLVnNTpU7vkyNxxlvZk2XTVAWN7ZoNcbNPMne1MJ62zL1htrkrD217V2xvUIyypdJWxZr/zIkshe7y0P7ZK2rISUJYnFfr2YIhP7NEksFdsANWxZCSKU9Z6H+nTlmLC8fvxL6WO3NwJhuUFMM1v7H4iwPPmbcVaHsKzTVcKWJYNnZIhMRSOUpi1LBs/IEBk39WJblrQcyFCXlf1ZEmwt9UhZ8I+axqvmCGvE2Gr9t7QPwnKBlrzAH4iw5LJwa1CDsFxNcSa16iHxpaspztKWFRVIfemgXmzLmnxNhLpMHA26l7asKHhG1rs4Ojh4H4Q17mwpsDu0/5e6GyGlpPeiR882lLByrooTwqpWywZh1TNe6dmy/OAZuUd8mlw4Q2yT8qUsKV45rTeVO0C5Z7t2RFdcYOf1vpvSlTvCGu1sqTGwXim5sYixrt/b0C1hzlVxQljVatXfEtY2XmnaslYrW0YoPc/By0uz9eZzS8YrTVtWXG9yfHDwXgjLy+OrFIWAsByJ7u+fsOqK7q9Tp3SVmTu/cDVtXple1Ug9PirM3bT5nLnzt1XoyhVhFfDV1lYXhCWc2xo+AGHVszXMndNVsg3nxjl9RLcG36qe3SGo+R6HuN7x4cE7IqxuAV9tbXsgLOfG0Q9AWGnjqBlhvUwbYKx7ntH30z1/sCVPI/VYul8DC6zEEqviAssNYY23JTu1T0ee8EZnPbnm2vGwwnKPj0BYKZhqWK5uECoHTAh7M1C1pqM6vEGoijB1rbhnplRUU9xdEVZPRU6nEYXses18NLdBWJ+csNxYsJRzwCzOQNUaMNFIvas/6ffnwoKlHF1YzYLljrBiOXU7YRUdt4P7WGPbxU6VH5fx1mYT1mmDhHX6RoSVsqJb3g3OV9l6S3fKEpuO2ki9KxoOLYS1Gahawcls0WquZDkhrJ2cX/veVnua18AzKl55+Z2xo3GhCelMucjTJyyvSlO0V9Jz5G+Ga60oh9nDj4dDT9+apUMiHlUpIqzcC1RSK/9Hp0tYM2+Y9/uxdGNt4PcHVzOaU1FvBqredNTlDeMuR/V+3bwylmJc8uhGyuLTURP1bo7fA2HltradqgSv/u76dtFOS/kr7/X21wy4vd85S5tDpZ2+HbkXx2Lg/39bOpOiR0fFhDVorSvs7Bb7xLrcI3naCvedO/vqT+qwvRPtS7d3u6kP7On6MFGxmd9uGf0z8bjXDk9qp81Ia7AfHnK7lTjNWeK01Fcld/u+G72JjldEWHkXqKRW/o8ucxHyCGs86OzSIV6akbKYeBUOLGSjdZxIS2w6atg5+JstfxzU43aGsHOQjQOsMQNVazpqpt73t2/N8QxMol53m99BbGWc8KepBp+d04xOlYAn2rl2VTVhjfsJE8bOQIOKfQ45Y69qZRdCyfPe7o1Vd1FbQfnoCrTTj/fY4deriwEr2WYHnLLTyrsqaqSPqCSsggtUWKvoR5d6s7mE1UtWSF3HOjNQtcSr1eIhMw1sZb/5mR37Kh36br8eo0cZMsMEJnfNz0wm4/XevPnZ0w8POMv8xneSm1xFg09nZpWwsp6x/PsCjBlSZ55iuXHmJHaG6s+qt8sogj2eOEB086KfPMtxbcKatdNHVBFW0QUqqFX8o9MjrOxl3NpW/D1Z2bQ4cPGKr97Yqmtp03LApqMmVlOMVqzW49o+7xykEPYqM1C1pqPm1Zsev5MtYWl4QF/x+97iW4pdlZGr/WKRsM4UB8l3XkhmOCtsOVKd9/aZ6rM6Tuh99HgvdUYjkX5IftCrE1YrTUQqwiq8QPm1Sn50WoQ13lcdI8F6FWegaolX6U7FJ6Ks+cSBtSDdOUgh7Pbq/WT6WHo6BHMdmM5A1ZmOmvFNsHrXx+9CdC/ZE86U/dFs6TDeKfbKWyCswbbS2zoqI6zdoibJnEbKgeKzKk82SVijzEURGYrcOq1JWK3M0/pZwiq+QLm1yn50WoTVUh+jNXXmymLLKEWn4j3NqbAkLV1xTvqZn2hsqx47oMIpSiHsZjNQdaajqjoVeb2LwzckLKKMjqdj10r/Gc4eJ4WhLcIa5hTYGRcTVq+IFMbbOUcdZT6rZ1tqwsq+h2GWInfqEZbiPexkCKvkAuXWKvvR6RDWIOcQamuM9gzUorDRsk7F+6lUw1/rx4DSdNS8zkHWXWihHqPHm/MvJQuiZX2LA01HLc90183x23IbdeQvDbqnOaTlbVNO1mjsnXW2U+37kmC22v3Baa9Nn459W4S1S2rumTceksTbLSas6FZdp7O/reBZakzq+EaAEQnbu5nPaltNWOFR9ztttkzZWZdsscfO6hAWp9WdVqe9q/ybUXKBcmuV/eh0CEseY6c3OB30drPindVuHTayvkAUu6flXc2g9V+8D+dXvWcZ0mOBeYFC2Ot26zAyKoiIZ/X+PX6zXsLUfmCn1T0d56/Duumd1M408ZT4HhyTYEfZG1Vnyu1OsQ9rkP6jPd4v3hQyIj7NrFO8pPE7FJ6S8S+D1Gd1Z1tNWAE/hEfjtyLj23ODDKtOs5dlu9SH1UvfD/B62xnC0rpAylrlP7oywsrcu/HahXxVb18oI0VL7ajshuGshrRE01FLIttp0HwdKeundtsgs3je1ejWoemoJXZUVk+jW2fLqc86ud0Yqu8ldjM9HsQo3STndBT3H+sQ1k7mz/54p9DrrbiZSaJ0P3mSrMm7ndrE8ebw7f1uf7CeU9PNiGi0DKVP6jC9WqlEWHL9su9l7we2TS6Qulbpj66MsE6zP4nT7bJW1KoWBxKvNBp+GGU9XlUNKU4YrzRD36vXIwFfw83OfAhVu3VoOqqGS4LVK90XbjmOlEuKD6eKO4S7ir/6Lfasrmob07FCWCNFfsRZUYPIdEtx0oPUbbudrArvpU6yy1Kjx6qUi9PsQ+wk5SpnVp2wPFV4xihFWHoXKKdW2Y+ujLD6inu6w9JW1FWV3BnGQIsHsxdU6p6hPhzNyHayZVWq9/ve0GRFNqlK3Tq0aNLsT6R6ZRN0HBHWLEd0pb/mklL6ik/RNn2K1TzUtkJYPdVqaifDGYoV1kB12O3EB3pHReDdFAu1xkov5Y5CD2wr3CBedcIaKM1y+8liehcor1bJj66MsHoVEx+NpSwmXunvKR+qB8Gw3Zn+vT8SzI3rMXrUXzCRTcpYymLilX5EPNUrDp5xlunez7m7NEz/hfdUn/1BSdDWvhXCUlbrKh2sKWY4U372zzg3dVR75J1kjXQ0mOLtKXbOtOMeVScs+Rdlpnq0bXKBtrX6FjPvrYyw4su6OzX93TOSsph49WIUEU+2LLPgGQqRMYtsp12dmcWB2hTNJkyQTeq64dcVSVnupuacqp04sTpzqhz00i5JJVXsI6sTluJznrNVFaLoFcPEYkVpp5d7rWnis7qb86Fuiez76ymOdladsHaV1z9pa9C8QHqE1c+9VZpDWGcFjU/2gmdopbQ0XZmRLcuge4aM5saR7WTLMqhHKzPjvCuySRmszGhzd2e+MrsrD55xOZfwdL/AwTNQfmbL4k2sEpZcvIxV66UdbcIaJ+LqlVvK1HpSRUx5j+8q3okFwlLfXEhef80L5IiwmO9it9M3TL3QDJ4hLaqSJ4JsWZrSEu3OKkW2ky1Ls97vu8r0kdzcaUpZJF79qVcvN3hmy/HY5157V90t2JM3yTh21J/ksR/TEqJjk7Dkn3DlKWyVND8rPvwd/pQdftDdJMWYENa+4p1s1yesbaVClCQszQtUWCv/R1fqw0rpoNvtgQlpaQTPkHhVOQuQbFkaQTAUIlPZUkW2LI169OTKliqySWkEz1CITIHxSrdeTvCM81H1wQ5m0OWstV1wH1ExEfS0u5+1J1ohrEHhKajMltNiwmonplcVtOe8PWG9bGkQluYFyq1V/KMrJSyFy36n/2JPypLiVa28B1qklUlLcne2rGNaJ1tWWT25g5z/+GIjea8seEaGyNTKAaR6yuCZJggrijXaTX5oW4WfhfiX9mWgVsKsEFa/+PM4NCasFteX1Oi/E8LydAhL8wKpa5X+6Mp7CVX1dwxyTQuJSPbhrBYPdTt6VhrSkhSvXuvGxUhbVmE9Odt5UTcuRtqkCj0Res8yq6eQspoiLL7C75QT1lZRWoMtwuoVn8KZ8ZZwP9WWlDuV8YMQluYFUtYq/9FpxMt08jlfk7LylClSn2x0TUvKyg2CkSEymsYrTVtWbj0pli1tBLVLJT03eEaGyKys1ssGzzRIWF7CYNnWWGHljzdsYoV15mKF9V4Ia2xhhVVEWBo/Op0Av1HLIEojx5WlYhgZImNr2L282ajunpG7M1v5oXJ7qaxHYtmVpfxQaZNSB89I8WpybrleOnimQcKSJLLLPxo7Z0oku0eC7twwTrdlk7CknelUeQrjShoWMYHyoN5HEt01L5CqlsaPTitx1O9wzCzVdqY1XVmSXWwOu5e2rCwnSXZ5shajxWxZBfUm5w5mdGWDZ2SIzLWLesngmSYJq8MV9V6B3SltyNw9dWJrGCrv2guhF5GsIKwuP5+BhonyDQlrR4OwNC+QopbOj06PsIK/AcG95m1VEJiuKytBS/fx/s3ysHtpy0oFwciUhLndgRLSlpWu97iKI2QsD5K4E6rgGRkic2d3gIWslwiecUZYXj5h7fJf6fyhTi+KPBE3PixtHVe9wpopfVi9j0FYWj6sM0PC0vrRaRPWendIyfKmzTrcZCUjRV8czNuZLjOuBWktWFxbH9klbVmJektn82+kTYq5JFSPWa/HgmccEdZLW9FVv8s/DaOy+QjKj4tVwtJaDKlXWEOljf1U0d3yXgmrrWPc1btA2VpaPzpDwvJXWq2cy2awL4w3bq+uxoOlgmfiEJnn619OZ83HUla86nI0eV7apOLgmThE5unHF6f14m6d4y1HfKUIRp8lu+LymozHmbZfV073dEty9hRyV1jK5rpo5zTI2euO3xdh9ZWLxVSHst4FytbS+tHpEJanHDG9U+V3MhzX9WwtnbT0hmEQBBOHyCzvnM1wlrassN6f5gaiBncD4xCZJuoF+8Kj78IJYc3C3/vt05zEuNOiD+1ANgSrNo09q4R1qh46Mdo+LSOstmoluJvsKEmNot7tvCvCGqkmhchzb5tcoGwtrR+dBmH1U3cE6xCW/2s5cz4vOkFZd3eWjFeatqy7O+FmTleOTerystl6x8G+Zsvl7cDOWCWh76Qk715KaI8/HaeKTaPVu4T02lby45iYcKMO8BspZjl0kl8ncuGDpM7+eyIsSjceKNaKbZMLlK2l9aPTMo4mGGtUfUtYqTG6vvndlvFKNy3LlhFKt8G5+XoOCGvaYu1fp+u/amf7mcEpO4pRhF2m1CrmsQ4VPqwd5UezoyKsTARXJz2qNE4gzvP60DuL1xhsfs5pmpmHqTk6g+YIa6eUsNikkDj+uJOJSNa6QDv5GlbRjy79Zodpwgo3kdtsknSrIPnHSfSMhek7T87pKpnJMDn/qwFQelXT9bbcjqAIJ9Dv7uxsK2bHnLF2i+jjEN8HaiU/ltvDTBrxDo1EbyUGpZ+mFJNoVH0qvLgVP0QBxNuDUSJhIieJlxsg/akMXr+t6H8kwu5FBx21Ux9p94SlvipCFYoTpFefjkenHcVADa0LpKil86NLv9nYwbYdHGVEP8Lt9eilYcv4ru47IKyHZggr7sOx5hQtaRu8eqt6LraEZ9tF/uiusvFie5eTWjdlPmz1T89OezuBCzHTe9tVDo4+VfVS9zMPJdp7fWZVeukVhKXqOznNjgOKDkpfbntNEVa3YJx2wRC13bRGp3OBFLV0fnSZN7udaBIfpP7obSsmyFbbEt67pis+PFq83vxyTVe/bl6p3tKdAK4Y39V4PTdjvgoYq/UiyuakxvsNRVhAv58/pCbx0UweeyfLJDslow8HhYR1VhggkdvS0mlshTUqJyxFrkQ7m0emcYEUtXR+dJk320kcPbcZsdYCy8I4MJPh0dUyjSsnLju1NCgSkN+gnhtbwyj3ly0xpGlUHEqabZDe5n+GPdUf+I5ycM9O9iOxUzQNPdd5JJmhUzjevrtVPCHWPWHlXBV1J8FW5m21S8bFJy+QopbGjy7zZvnfk0FwX1Vd+bT+76fLfeHDs0LWnbjjq4miUenaobDEBsy/RT1XQyh66kVWJ+ngUbbItj3l3ir4pT/jnzJPtZjqKJcGO9kD7hSNy9gtu0s4Sn+OU5qXMhhl0OBdwryrUshYA1Xiq8YFUtTS+NFl32w3yYfTrsGfEh2aetYLnqlFV3NlvcrjufTHhfn6Pg12Fq5u3dH4Ll9vnzRb7/t3d4SlXmTtDHPNy+q8o+QSLFJwu9nR8B3VR/Oln2UnMdrPRgRmPhbbfZ1ewsTneCd9V/E0Q9jsblcThJVzVYomhQxyIqrLL5CiVvmPLvtmp72U12K4UycOK7UR9HMZnl7cSlls1n263tKFlEWJy9Eqjq22nHg52czTsFPx/Ka5eoHX/fhaOGx+TvXZ73TPVGmRXpfPY++knuN16e5Sb/2Jj4Ph+Kw8OcGdfzQ9/9HttNNw0I4yftlDXn83EcQ71uslpMj6ncEs+9QB5+JW32u2NSf/quRc3+henDpTX+MCZWuV/uhUb9brtqI25/U6atpPrGR3+9OKv4zrCRP3jEKsS1ls/o6sN6WHFhPLUhaFyMjGappT4aCZkBKQ5cEVD7mpF6fMHG85Dkfud9utVtufbVwQx3026HVarU5voPzrOewH3+yfOT7R4BTavbIySWYITs1/b7khecG73/efcOqJd4tx8M7b3bK4dN0LZP9H5/U77XZrv9Xu9D0LMjs3ddqVsph4pWq2tu7JIu8Vl/W5BG9XWmJikqr52WW92+M3iZf5+MhZygDvGilv+wOZDiy63hkRpuux79hr0qFxYendJtsnWnShM7f5PB0vM3dbLzFBB4QFwvrcUHQOMmXcUl8hJS4r69Fo6aUdi4NMXFY2VtOcivxMY9Pd2ULkR8R/JalpYb3ebPhmAX4gLOCNV1eK7dtyaiEH66WsHq2y5hYsDqRU5XQqXj2uRGGmsRlITMqJiP/6z9JRvfQcChAWCOsTI3cgDhfI60pZjP3yB/A8LKxJWUy8+nNV3qyjyDQ27Ish+0J+Iw41z9isd3n4hkMoQFhAsyhkovvpsxVXFpPEipmPeK2WlMXEq+KIeBn6Xq975iv1xRQ3OlODcq28GVbv4ujgAIQFwtoQvDzphrAXjAMrF69W2vWYLWtZffLzUt8+T7asyt0zcnyXTkQ82bLmFup9Pzo4AGGBsDYESx0KYlr5y1OtUTm69STdzCpJWZNZynilOaeCMo0NrQV3Ri4r5pyqW+9aPakehAXC+pSrK90V0/20hpRFmzyDei/Vg2dIl9Lup2a2rKuv1UNdtFdozJZlHjxD9W5z6AqEBcISG3NrsMxAZditQyEyFesZBs9QiIxRm8+vm+dq3TMU6jI3eSHZspZV6yWMVyAsEJbYNOOVLoUYdOvQUqlCvVfz4BlaKhlPtCBbloGURUulhamETrasSvVmw3y6AmGBsDZ5dZWlLN19odwN1qynGzwj9fNKEfFyToV294zsi1lWMa+TLcu8XiFdgbAMsb8GCEt8MOOVthylY3Egq3zleguT4BkKkflzVXdOhQ4BUahL1QRkkqPM6l0W0xUICxCbYrzSveG3mt/bXo8VUmSpIkXNgU8TC3bTUimLQl3qTJiQtiyDehdHBwcgLEDAeKWVDvMiNKbYk0e+Zj2yZRUGz1CITN3cUukkLbQokDXhpmb4grRladb7Xk5XICxAbJLxSteWlb90ooWRjXrL0m4duTCa14/TIlvW9bdSMclCvBVxUb6UJetdHx8cgLAAGK/MKESzidlavZfCbh3Zh2NpkMWv60VJE/PK6mAJee9vVVLvVo+uQFiA2NRbgyUC1WuWkuQKzEU9RfCMDJGxmK/8K7ZHKKQlGeoyt5d3LG1ZiuAZWa/IeAXCAsSGG680KeRlqg6RsV7vVR08E2/gjI1Xmras9Coq3sAtLq1OlJC2rHTwTFxvNtSmKxAWgNVVPmVxKSsWr1zW41JWLF5VMl5p2rK4tBSHuiztD8CRtiwePCPrmdAVCAsQm2m80vMcyOAZGSLjqN4iJWVJ8eqPk/lgsS1LSksy1MXN6PnYliWDZ2S9SyO6AmEBYlONV3q2rDB4RobIuKsXU2QYPCNDZJ6cTWCNF3Dzy79ZqMvE2UTU2JYVBs/IehdHBwcgLEDAeGVhaNdasnp+isnLaT1py5pN4hAZlwOjyePweB6Hutw4HOBMtqw7We+7MV2BsACxwcYr7bSshuoteb257TmGuR4HR3MFi+YM6huvQFgAjFe3xmlZDdV7EcKq8UrT42DNeKWdlnVbia5AWMAHxey2Eczeqt7NRSOQocaXfzWCy7heRb4CYQEfdonlnj7YYPtG6rEp0VbGgeknLtsZz6U/vqvqjhCEBQjcIiwd3/Um9Z6u3NLV78dkvck3t3TFxneFuDgEYQFiozyjDnWle5p9+lb1hF2Le+ou4c0ycxvDXkdOUQIy/QUYHoKwAEjvduXvt6z3fP3LEV1dz1X1nEnvTG7n+PcYhAVgX2h1d/b88PTcZL2nCY1AdSVlseHRqXp3TrxYNL4r6AeSkTLC3IsFwgI+OOb2e/vY6uM5dLpz9d1tvdB9xeYJ6mUoVx4eHc1HTNRz0UvICDFyujMCQy8hsGFS1vzeSSsyN4tyE6nlejQuzO9UjLeA3NRpMVwmmbjs02Ps9uL1FnalLEpAZltOvkWcHSOtAYCUVbUjh2nD/LDMRGq1HhOvEooVM3XadJFS4jKjx3Q9i1IWZ6anH4wJv/ygjaiBixSEBUDKUopJr+l7gnzp5aBeJvaK5gnaszgw8WqRZkFe79qSlMXkqszCjS+9tKUsEBaAWCwSk1aFqYCMsuzUo+O9qjKSaZ5gXoZyZfFqqbr/yOvZkLJkAjILlklm+0mKfNWUskBYgEDw6Hp3RnSUp6xziqlbjyZA56f0XTGKqStlycTlHHqM6tmTstgKKpf+GKXp5SSDsIBPg+XTvZU+nFXRho9v4urU42JZ0YaPb+Jq5TfQncDVo169WvkNPJuhKGbrnPzvN8cgLABSlqmYVHaQp2e79cpS+phNqrqUdaV/EFbvunK3zrdrbT2M6VzfD98dYY2HI9WXnvc+fuMbOo/paPohzzvz82vopQYWh4eafTEaHMRsWRXrMbFMI/aK2aQqSlm/71ZCf3o0q7esNpCCiVN35cs0ZssqTXh3QFjeMIL6I3S211Z8OdrbG70HvmrqPLp73Q953kGlVtWXpn70rijL3HLAY6j0Xs1sWZXqrZTOAq2svaW5xYE5FjRTAVm9ufm+UCYgaxskmPlhetw0YfX31midvCFhjYYzg2fP1n/8m/rgd/Y6vGwThDUeeu+ZsMx+XsJm8AztzgxCRRPZflVDZAxaBROkU1W8WlSqZxo8Q+JVwnhVotCTLasweMYJYbU6AVp7e31dwhLDoeWzaO+NTXYr8VlZP4+ceifjRNnaKD/vM9VP4/0QltnPy6KUxfpizNZKD0bbSBU9moUxMJuUiZR19afQyaBVzyR4hkJkDG8zspuKBcEzTgirt/4Qqf7s5xCWdVQkrIYFvQbLbhJh6QfBEOu8mmfH0Iu165FY9mquRpFN6lWX637fvYrK41ipnnbwDIXIVFC/SPnKD55xSVj+L2H/zQirZfQB8N6GsJose/K+CatllbA0u2fIWlDRVEWUpVdP7gYrjkclW5bWbvKn3NfVrqclRpEUVdF3SrasvOAZp4TVC6Tl8WCw/sQMvPVv7XjQ7Q5m/Jd4Nlh/PT7pd3onyejFM/+hQfzrfNKT3w9eFByqH39v1Pe/OAuIYOALaf2w8HAwFLORXzp1Hvy4w0F3rzUYnLDzKKwTPzg78d+HfNDr01dBjfHQ/8rzj+r1O30vPL1O/LaDs2JlgzPu+vWyn9lUmfD8xicD1Smy885eupNBe68zGAwTlynLRsF31pvL4BRHfXYw/230zpKEFTznrNcNLujzGSs8Ds4icy3k9n8wmCYvGPt5NbkvlLuz1dyCPcGgnhV7QrmURf6EPxbqlQfPUIhM9fmGZMtSd+u4Jywv/g3v7J1FDDVqBZJ822OENd6L/sB67VCub7NP7rgTKfhD/n1v/SIvPFRrxNX+zjjYjIYIH+wP/RedpM+DH3ewfmH2PJR1RPxg+KT99Qd8sB9+dbJeW56d+F97wfs7Cw/V95c49Nb6wXKHyoqTfVYvuWlMlAm+9N9mW3GK/Lw74/Sli/61N0hcpnStbvSd3vpq9gfsy/XZdoacsPzn9Nfvuseeexa9m/Xl4tciPMf9vZPUBWM/L9FY8AxZC+o1BpItq6yegbNAi4aKg2euHm3XK141UYhMvUZEsmWp9oVOCasTfCyzhNXqn5wNWnutcYaw/N/lzsnQXwy05S2jZ/+LwXDQ2dv3P5k+b/hfnHT2Wl70Iv+PenCodrTnaZ2NvZO2/6lkf7H7e929/XZnmD4PftzhoLde6sTnUVRHMkmnexI8JxLq+nvtE887aUUfxrZftdXuhKuKdv/sxP84D4K33d+PNmYhYVFZb3//xBufdaN7hynC4mX8L/0Dd3qKU1yfd384Hvb22tPUWzzx/xOtsNhlyvzgOsF31m/B/6o9ODvxSewsurp73eBH00kSVjs6if3B+rkBrY739waj8ai7Jmd+LaJzHKQvmJMVVnEQzL0lukrYsrTq1Z43SDapgm4dCpGpPY6V6hXI6CSZ39WNeiBbliJ4xiVhjfaDD1mGsKIPwH8jgStJWL3o4zzt0FrmZK8Tklc/+FPc2es9R0u3TvSiaDsV/PkOHgy/+m/4az9dLzn8s9k/W+tFifNIHNf/E98W7DwK60gm6a+Xke1I2omWOHv74/BD2vLWW97oNb312x5EZ9GPXhyXPVlfssFYQVi8zFiujDKnGJ33YP3kfuYt9uWB2GVK3mmMDn0SnZR/s3dKlrGAhMJfoW6SsKLntKN3HZxUuFKLl5lr8pbXwj/weC1spi6Y/HmJRoJnSEyyErtAtqzSegsbocdkk8oJnvk5eU4nXtmplyNlkXhlJZmGDpcJnnFoa2hHn7XsCiu+h9hKE9bz/v5/o4/pjDmWoi3XdCx/uf1P235AA/E+KNh0sGeKFGH1hIqw+HHThFVcR3BqCz/KXkADg/joA/qsMtvG3t7zmvRmWcIa5AriqTLjmDOVp+i/xVmsjM/SbzEmrMRlyik5ZRcuegepH1vqb1N/vTQ8SSwR1xUT18Lnq+6aNxMXzBVhqRlJiknPtoKtyJZVXM9WRjvZpFRymBSerAVpUT3Vfk/u4gyMV7q2rJSU5dI4utebFRBW9NlLENZIcRtpf2/KbnS1JY2dsA9zN/yd73EJiBFWX0lY/Lhpwiquk2KS6APZjh0cg/ADKaktfrs+wUSL3IhxMius/WEJYUVl5JfKU5R88RxWSb5FWmG1SxykiVNcXzdaNqc0rARRDRM/wEH0Gn4tZp31qi99wdwRVjYI5mHmYvi8vGGoqLeq7CzQsEllunVkiIzVqFKql5ay5K09q1Glco+ZDJ5xQlgd3puTR1gi3DAmCOskq+HEH/T173ZHtrb02ac3+msdCOPtzvr2VxlhJY6bJqziOmkmCZcI+37p9bqyU0RYYl9FWM++RNXytapxAWGFZeSXylMcrNe2nU4gJqXeoiQgfpmS+K+vqoUvThLWPm3WSwgr/qZ30u8GzuEkYfnvtis1/NQFc0hYKc+CDHVZ2Z6AI4lJXe/1/rftaPZXBTFJ8cpdvQQxSWKp2HaoYcviwTNORfcywhqmCGuQJayhmrB6KiIZ9zvBjafuTIOwhnqE1dMkrOe9+PPXCRRxU8LybQnhqSvvEpYQVk9FWJ3OKP0W5YXglyl5rVvx0jhLWF0Dwpp15RI7tcLyH9mPvkpfMKeExYJgpPNqNXcw/kbeCFTUu3cwFlXapGTwjExAXj26rPdI2eyPFgP/cm1ZFDzzpoTlGa6wTtiyYqAkEt9x1Qo/RLVWWOV1MkzS2vOSvm0zwoqWJW3lXUIlYSlPcZBoqc5ZYSUuU2J91fLvEnqKLaHpCmvg3zQcjVVbwtDcEYntqQvmmLBiaUmKSQtHU5xJrUrWczXFWapVUYHUlw7rRcEzMkRm4mQ6GLNlRcEzhxdNEFYkN6cJywt/RUs1LH5njgTfdrA6UxLJmgRUhJU4j73EByZJWDp1uLg0lOauOoQVCuvjAg2Ln4ryFFOHS77FfpKhhplr7a/IpkoNa18wLtQgrPhepULDCr/bZW64xggrWFJJ55XLofOxLYvXe5pcOENsk/KlLCleNVHP3wHKPdu1I7rigr4fPHM4fBbuCWu2Nio9t9aEtb6TFW1qEoQ1a62VWG8wE3wBERzG95n73x/GH6JZhkjGI7aSyhJW6jz4cdOEVVxHMkkc8BB8zuUW7WxYgbCehzH5eFnC4mXkqShPUV6/6E0l32J8IRKXSdU5M1YRVuxCCFZIZYQV3xbsKwlr7RtNXTD3hOV/pNcf55enW5eQtqy4Xm3jlaZN6uWl2XrzuSXjlaYt6+HB/z/3hOV/bkJ/T39/TVj7/efI280MUOsP4sC3wUcO7RO2sTmJyKIXft+Lvj8QaSIZt/fPiAhnGcJKnUfiuGkfVlEdYpLuOBJ+Qu+R/5/IuhkYXE0JqxN7kwKvgtduj3LLyM+18hQH64aA3tpQwt/iumTyMp21yPDuhd5cMe3uKwjLf0dhPd9KX0pYUb34lDPX4iSsk7pgswYIa61FP93fOgYfYmjHeKWdXtV8vT9u6So9KqwBwvKzmtp93yItt4S9dr/XilpSgo9Dh3Rt303qP7ff4lqOb7ls+S8P3Yf+XfH9br/bipzcKSLx7RS+l7u3tin6elCnlyCs5HkkjhueRodsA4V1JJOctPp9/4Rb6x4j/yWD3n5sltQirLis38vin1o/enF/j13AVBkiLOUpztrRe1x7zBNv8SRQ5Eepy9TZoz8N/hf7/km0+z6zDzKE5buA9zr+j0ZjhTUKK3T3/cV0x1Nci856bc0vmPx5ucbcOV1Fvva43o1z+ohuDb5VPbtDV/M9Dg0Slv9nPLgpNZaENQsb23rTmI9YD99/wxtM+/1Zws5DrW+zftiA1p8KBZEMO6wfL+jcayelm8R5JI8btsKxG4KFdeRaLDxCZ72LG4ZtfK0zEw0rLiu83r7slzzZyy9DhKU+xVlkguuNs5duGpzfMHWZenvMRjoO+wE7Uy9cGqUIS4yC1++f6dgawkvhO8v64eYyey0i13zigsmfl2u8PDXAWDzC9Pqne/6gVIbG6zWwwEossRrJdJ95o3EqXjI3/nLsZb439Ub0kDfMf60flV4Y4Zk6j8RxVUHPXrEffBw8ieo9B96zWfVrJF/c5SSSKaM8RSKy5Hmr3yJdptn+PjeX/tcreM8z/8i62za/bPlT612wGpTlmq8eEmkj0yvX/HGVGBDw5L7eE6/nUnHPTKkQmJojqmbvuRJdxvvtZ9MyVc9muNcTmK3jyD9qdQaq1nTUN6rnwoKlHF0IwnqPhNXbHwlzwtqvUuq/7dZYYEy0Xbp6zdZbulOWKJXhDest3ClZfJ49COs9EpY3GJqWCdJZOpUWWANvQ3981vtystNRVzO21Fq4sRpIY3vIUoxLFm6cWLze4pJxyaMbKYtPY/XrgbDe4wrLvMwovlUJCINuHafiVbiI47tDF9ISE5PCzkE2N8J1vbBzkI0frDFzVWsaa1TvnxUIq6pI3oxerFXGn+A1w0/E/No+2O4kXGX2nIyyVvabkdmxr+KYUXrs0WG9WLZiApO75mdBYafnICxgY/Fqc1/IpqMmVH226lratBz8vFavpq4e2CbRUT3eOUgh7FVmrmpNY+X1QFjABsN0BqrOdNTMTUhGWXNr0hJNR810DlIIu5t6aR8Dcx2YzlzVmcaarAfCAjYadiwOjJMUzlQKfbclLV1xTsouoyZkzPpju56ic5BC2M1mrupMY03XA2EBm43VrPa+kKaj5u0yWXfha/3YUZqOmtc5SHMjLNcrzXTXn7mqM401Ww+EBWBfeG+pD6dg2D2FvtcNdv/F+3B+ue/WYfUKItsphL1utw4jP0U9EBYAPD/Z2A2W2FHZDcNZDWlpIm8Il0TEM4tnnXwsWquV2EOZxfOuRrcOTWNV1gNhAUB1KYumo2q45xllVQ0wpumoGpHtzJZVv56Ga4H5EKp269A01px6ICwAKJ6BWpQiszJr9iHKqtQ9Q4smzYh4smXVrafHQGTLqtStQ4u03HoOCGtsYLoeR7EB6/8Ib4xPDvBRpCweIvNgvoM0lpaYLKV/r5FsWc+T6vX0I9vJlmUsZTHxKr+eA8La39MfOb6OSFr/Z1CthRcA3mBfyKin4uvMgmcoRMZMkiJblpmlgqwMZgEyZMty8Tr7hPWsJixPGZCUIaxnfGwA8QG6dWhzZxwJSLYsg24d6osxj2yXtqxK9e7MV0p35sEztJksrudgheWdzJQ5pGelhDU7QQsv8KZ41dWiXuu095AtS1NaIjGpUmQ72bI0u3WoXiWPAm3uNKUsEq/K6jUmuusQVkbgGuITBIimUxzuDUJkqlq4yJalETxDoS6VLVykR2l061C9AuNVCQNJW5ZG8AyFyJTXa4ywesaEFQwKxucHeHdSlhShauUA0p6yTFqSYtKyjmmdFk3a9Wrl8tGiqSx4RobI6NRzQFgnYSqcNzgRXr/TjSYMBhNhuoN1XNxJr9M7URFW8BoRBct1eyddf/RKtMfsd7uDsTz4s//6vgzlHA263X68kxz1O73BFB85QNScuaoRIlM7tlRSVqG0JMWk17rxNNKWVRg8I+vVjouRtqzCI+k9yyVhtePpOMNwrEs4cWovwjCabEejXJKEFUtZ3ejZ63E3g/Aw+/E0qLNw6Es8nSqaEhPJ/OPoda0RPnKAo0BSGSJjJWVZUlZu8IwMddE0Xmnaspa5W0tZz0ZQu1TSc4NnZIiMbj2XhNXun5z446sC3hkMWusVlj9Dqj8cD3vRPD0lYfkzQs/G3sl6tnF/r33iBV+tB/75i7ahP2svHL/pf7M1ODuJhtv508O6Z+PRYH8f0j0gnATPSOeVrTkWD8XSkhTLbeWHSluW+l6jrDexNApH2rLUwTNSvNKu55CworHrg/Ucu3g6XWdteoiGE6sIa7YfDVyPht3FM9K9cCqyf5juelL7IJxwF08xDcdCd9cT7tr4vAEOpCzJLjbH7siDZjlJiklPFhPapS2roJ7NyV3SXpUNnpEhMgb1XK6wBA8lXxOWt9eaxTM3Z2rC8taviOeeDwRjuvZ6LxiN8BzE3wxe0Ip4LiA8LLEA68EzMkTG8ixWactKBcHIUJe55QEWsS0rJWXJend2B0pIW1YqeEaGyBjVc05YPo94jLDiGcHiOVyBFRHWMCSs9pqG1guothzb3A1HjtKtRzlb2ae2E3zaALvdOrIP59X+vB1py2KuBRnqsrj+ZX/2zTzjypL1HIxylrYsdmzVY++FsEaMsPwdYidCKMErNay1eBVx0v5eO3p+O6S6mLBOwm/Gi6poQba/PnKLptMDgJXgGblxczQebJoKnolDZJ6vfzmdNR9LZzGFVTZeadqy4uCZOETGuN7bEVanM8oV3Vsnw2EknvsLsXb8/F6GsPYYYQ0lYXU6WGEBNqWsOETG6QDWFQXBxKEuyxtnM5x/xR6HP6xeEwNR//lKITIV6jVPWF2RaxyNX9OPjAxnbEeZPHhMWG1GWN5a3QcAu5jNnNNVgrLu7iwZr8q6BV+T9azP6coxXIUDUavWa5qwhslbeErCGndb/cFgbRXtJB3yScLiatV/9/cQTgN8xPH2ioA/S8arEo/DPa/3j1O6Sg0xrFyvacKayXt5/XEeYfW4kWoQq/RnwyxhyW8GDq9ufMtwgJuEwPucrqMfPfPknK6SETKT878aAKVlVa3XGGF15O291pB8WOsF1zApuu+zpudxa68XUJvXCmksSVhTX1+fxtYrX3UfPMOHBXyIMdF5ayxhdTxXKWHJyLyrb00Q1reruvUaI6xeIJ77P46Z35nT7vtW9bBlx/cidPryP/EKK2q3abUH/40cqPvdQWRmTxOW/5+9/d6guxdSnN+m0wq/QG8O8D4ylKsmLgcK1s0v13QlVSxL47kMxndVrtcYYfktOXt703AvGNJRb7w2vIe7uug/69cMW+vWw6h9Zxg2H7bOFBqW/82oXzGiqEH4wjZ2hIB4f+PATMaF2RjPVWptuFkm6zlwYOUkINeo9xZDKLzhcFhAKsO9KOFhPFqz07P//OEsb6nujYbDZ0rQGmJ5BXxEIetBEbZrsyUn0+U8z9a7dihksYH2deq9w6k5HXm3b2CQDg8ADWDuiLIeGH080Vz4yuO5yneD6nqubhXS+C5fb5/UqPcOCau9F2vuXfTYAJvgbuB+humEhbBXHM9VbnSn3eA8Wc+Jd5TNWBU3/qrq/KZyvXdIWP3Q6D4c+sFXbYTxAeLjZSibdj9z+viZDGHXylCuPMw57lTk9R5tS1mUgCwPrnjo4xLWf9f5ff79PzhBgU8vZTHxisnsbCigZU8Wea/48o3XsytlMfFK1fxsWO9dTn72Tnyj+5k3w0cD+Oz7QrYbTO3+KITdZDyX/viudEQ8r2dPymLu9nk6XmZeoR5G1QOAOSyFzNC8L9WECRnCXpChXFm8UrT+sHoLO/vCv38sSKz6mu0uXBjXA2EBgLCWoWwGcl7ldA6ybr/5xKp49VRWT51pbAZSqpbqNdTXf5aG9UBYAPA2UhYTr/Ibcah5praUxQ6VH2LKnjSp2a3zjewL+Y041KyjVw+EBQAuxoGVO69Wev5QGcJeT8qSCchlIaZUr1bezFfqwyludKaGaJ16ICwAsD8OrFy8WnHjlV4Ie9F4rrK8ProJWN7xQ/XmVaUsOb4rMl6V3Ee80a8HwgIACxnKZnh6Lt+cqULYq0pZ9HotIyqrd1fJ4hAnIGu6rJgtq6weCAsARLPBMxQio93fzGxS5sEzV4/CdNg9q2ceBEO6lHZ/M7NlFdcDYQFAo8EzFCJj1HZDNinD4Bl64cqkM5FeZhgEQyEyc5MXki2rsB4ICwBEc8EzFCKjvdrJ2qQMgmdoqbR6uKpazyAIhpZKC1PJnmxZBfVAWADQnMVBWhkqRbaTTUo3eIb6cJ5q1dPtnpF9OMsqZnmyZeXWA2EBgGgoeIZCZKomIJNNSmd799uY4PLr6RAQhchUTUAm+SunHggLAJppMKS2wTrBfNImVaqAkQpVZ9i9rFcaBEMhMnUmWkhblroeCAsARAPBMxQiM63ZZCNtUoXBMz8nC2Fn2L2sV2hRIGvCTc2wB2nLUtUDYQFAA1KWFK/m9eOtyCaVL0xJ8crCsHuqly9lSfHKQpwWcV+2HggLAJzvC+Vu8NlW6sJzYbeOFK8sBZZSvbwm5pXVQRbyXmOmHggLAITb4BkZImMx71gKVIrgGRkiY+yc0KinCIKRITJze/nK0paVqgfCAgDhNHgmdl5ZpI+ETSrdrRNv4FZ2J1jIeukgmHgDt7i0OsFC2rIS9UBYAOBSynp4rmG80rRJcSlLilcP7urxIJg4RGZpf+COtGWxeiAsAHAXPCNDZNyMno9tUlLK+n23cpEDn64ng2BkiIybUffSlhXX+wLCAgBXwTMyRMbdRNTYJhUGz8gQGff1wiAYGSIzcTaBNbZlrev9AWEBgKPgmThEZupwgDPZpOaTWLyaT342UO/uPA6RuXE4MJpsWVE9EBYAOIVb+kgNFRT1faKm9azPMSyaawjCAgCn66xrx3SVSq96dk1X6XQu13SVSssCYQGAQ9xcNIKbt6p3+VcjuARhAUAzO0L39MH3aE3XszEOTH9cGAgLABzDjcNAOXveoYMiv97km1u6YuPCQFgA4Byvdi3uueO73qre0l5HTlHiMggLAERD0rsjKZyN73rLes6kdya3g7AAoDHMnEhLkxnbeU4mT66lLC5eXZ/LSBlRdRyY/riwsN4EhAUADeHRfm/fY8rtlXBIua13FznPGaG46CVM1fN97yAsAGgGFsNlkgnIzCz663rRRD25BeRbtoVdKYsSl/mWE4QFAB/QRcq8m0nFiqtMzxMn9Z5+MGb68uPJhZTFmZDXA2EBQHOYWtqnXU1F7jRnmidoz1LBrAyZhRRfCl1bkrKYPJasB8ICgAaRk2lsaC2Q47vEq+p4v+9fXdVbqlL6vpL1YGVDypKJy9l6ICwA+FhSFhOTclMBrxjF2KyXR0eMYmpLWWzFlq0HwgKAhrGoIy3R+K7iDR/fxE0u7NQrir06n9jJb+DZDIp6ICwAEB+nW4fxUFlKH7NlWalXpk8x3em6crfOt+vieiAsAPgwUhYTkzRitpgta/VYt95d+bKJ2bKW1QZSMDEspx4ICwDeRMoytzjI8V3aKX3MlrU079Zh9TQNC8yMMDffF8rE5YJ6ICwAEB8ieIbWSwatgsyWVb1ewnhVopiTLcs0eIbEq4J6ICwA+AhSFolJhvMNmS3rT6V6hrf92E0+k+AZCpEprAfCAgDx7oNnKNTl1Vz9IsqqUK+CGkVKlHbwzBf2ksJ6ICwAEO88eIb2dRXHsV49rky6g1i9aj5QsmVpiV8kfZXWA2EBgHjfwTMUIlPDnvCg64bg4lX1eYNkyyoPnqEQmfJ6ICwAEO85eIZCXeqNRyVblm69eo2BZMsqXjVRiIxOPRAWAIj3261DfTH15xvGI1D16t3VjV4gW1aBjE4SvV49EBYAvNvgGQp1sTIelZyked06sp6VpBjSpnIOV/oEEBYAiI8SPCNDZKxltBMDqtR7aWUwMF7p2rJU+z25a9SvB8ICAPEuu3VkX8zS5hQcuefL7AtlPavRoXLPl7kBKG8lmtQDYQHAe5SyJLG83v+2PahrqUoqlUR2aTmcXdqyEsQkicysHggLAMS7C56RoS4VjVeatizZrUP17M+SYGupR8qCf6xWD4QFAOK9deuQmORoirO0ZaXqTZxM62K2rCh4RobIGNcDYQHAO5OypJj0NLlwhniV5XfryHrXjuiKC+z+DlDuESvUA2EBwPvCy4st45Vee3Nc787V+OaULWs+r1EPhAUA71LOcjVtnnsc5g1Mm8+ZO1+xHggLAN4hbpzTVYibuJ7dIaj5Hoe69UBYACA+9cxVrXS/BhZYiSVW1XogLAB4l3CpuKdTGYRjxT0zpaJyPRAWALxT3F851dz/pOu5sGCpUhnq1ANhAYD4rDNXC+iKhkMLYW0GqlZwcq16ICwAEO/4XqETKevXzStjRZrsXG8Gqt501Pkl4y7jeiAsAPicM1c1IhvWnYq/2XLLhZTFxKtF0DnIxg+a1gNhAYD4hDNXtYY5i4ereIcoJ6Za7yakgHexjI/NHjOrB8ICgE2Sstgw58SNSEZjbuJlfFx9U4W+I14GACBlqXeDTK9KD1al0Hd7UhYXr9KNzmyjqF8PhAUAGyNlMeeVovXnJ/u2HSmLcdLNeUHou349EBYAbIiUxXZ904l6l3kt92+r+jl+TKh6LMt0160HwgKADyJl1dsX0jDnoh0m69aZ19sX/v1jodGHQ6HvevVAWADwUTCf2GgbfC7W8Gmwvb8uqs5XJF7NizV1pspr1ANhAcDnl7JInVre/C6/kSjXYpNv1ejq2yRhvNIMfdeoB8ICgM8uZdGces2JFmTLqjSSghhoqWeyIrWrrB4ICwA+t5RFw5xXj1fmAr2xlPX3j7nKeKUZ+l5SD4QFAJ9ZypLzcEz3k2TLMpOySLwymzBBFoiieiAsAPjEUhatlKaTyoPtDaQsEq9uzquGvhfVA2EBwAeUsvSGQf+OBxCKeRVPxC9py1rqdc+QeFXJK0+2rNx6ICwAEB8yQ/mXvpWhcuAyBTtoZBoT31QOXP5b2rJyDgHCAoDPKWXJHV2t5mmyZd2V7PHO7/SMV7rN0sp6ICwA+Kh4uNKwMrze/a6b7/CqkWksE5CXdXt6aF+pqAfCAgDx6YJnpJVhZSMYXtqycoNg5LrISpqWtGVl64GwAOADY6EaD01WBlt5pfJmo1JMpxCZiaW8UmnLStcDYQGA+FwWB8kuNieFSVvWdcZy8O3aQbyytGUl64GwAOBjY/X4W2llmE+sDrCQtqxUu83Xf9a7zzu7AyykLStRD4QFAB+/W+dXJlJ0cf3L/qDoRaZ7RvbhOBgdLW0SrB4ICwDEp7E4xKug5+tfTmfbx5aD87V49fTDyURDmZYV1/sBwgKAz4A/VzTMeXn3+8IRpC3ryt+nfbtqbgBrUM/XtUBYAPA5cHdnFCFT25Z1eWnJeKVpywrrgbAAQHyqwKyrC8dgQwwdjDEszIYHYQGAQCRp5XEWk/O/GgClZYGwAOCTSVkNENYf84i+OojFMhAWAHwuvN78ck1Xv25eqd7SneBOwvsSW0IAEJ81eOanS7qixBnhzIGVM7sQhAUAn1HImrjjKzbQXggHLTkFw6NBWADwOfHoSMq6emS0yKjL1a1CGVrjY3INwgIAsVnBM/XEq6XgEfGTqaDxg18cukZFGBEfhEKAsABAbEzwTL3u5wVrBfqZmlNRLcW9WLx6FOlBOmjNAQB4ssy8V1zW5xK8XSmLiVd/0PwMAGLTgmfqNeSscnabbJ9o0fXO3O2JiHgQFgB8Zinrpx0rgyQlRWM1zakQCzv7wr9/LEgc+4oAPwAQmK2jb2WYl3Qqsu5CszHRZcOjl+k1GwgLACBlaYpX+Y0/1KxjMCa6bHi0ovEHhAUAGBOtJV4V+1HJUVorb4aGfCkbq0FYACAwJjo3YnTJjVclO0dpy5pXn/w8Z8YrDFIFAEhZVcQrrYkWzJZ1V8niIIdH57q6QFgAIBA8U6xLafdTM1uWefAMhcjk91ODsABAoFunKETG6IVkyzIMnqEQmXnBC0FYAIDgmYKlkvFEC7JlGQTPUIjMolCyB2EBgEDwTN4tv0oR8WTL0u3WkX04yxKzPAgLADYJOiN1KESmauIyyV863ToUIlMqfIGwAABSllqFqhMEKNdopcEzFCKjMdEChAUAAsEzihCZac2mHmnLKgyeoRCZG53tIwgLAAS6dTJ9OPP6cVpky8qXsqR4pRmnBcICALGBwTNXhX04lgZZyHuNOcEzMkRG+34iCAsABKSsRIiMxXxlKYgpgmdkiMxc37EFwgKAzcRzatMXb+CWd9Zi/xK2rHTwTCxeLUx6pUFYACAgZUnxqpLxStOWxYNn4hCZpVlKKQgLAMTGZyhL8crNqPvYliWDZ2SIjGnHIQgLAMSGZyjLEBl3E1hjW1YYPCNDZCbGmQ72CWvmeTnfGY+D//PG6edOvYZOAAAAkQmeicWrqcOB0WTLujuPQ2RuKkTQ2CescXeg/sa02/VPedgdpp/b73qNnAAAAAXE9fPCKfgQQ1F1jmGDhDXr9WZKwhrUJSzv5CUscOKBsABAuA1ysGDLMgpyeCvCiqAgrNo46T5HRzsBYQFAFdxcNIKbuN5lxcj390xYXj9iIBAWAHyEcWD6icuVx4G5IazxcBjt8tYSe/SfUAyPCWs2GnqziFs8bxZJ5V78Mv8Vo5PhSb8fPNcbnpzEDwfPmMXPOBuGB/d8YvO88cwbdgdBCUlYwZOniVMbDUfxq4fxP/3q/uPeS/j8EX5xAQFXlhOwcWGi8jgwJ4R11vUxGIdrH4+WVb0eEdao5z+l5601rHH4spPgZeEiaTbo9vrd7ln0T/mwz0y9nv8q/58v9PBJ9K9x+J+uJKzpIHgyW89Nwyf2hiJ+TfTPQXcUfNEfh4/1p/jFBTYUr3Yt7mnD+2u6nmGGsjPC6p14U28Q0kYeYXk+W4zHowEnrOBlPo+NwpcNn8U4FOP9f479o/WDp/T6nngZdQPtfuSvpv7rFxnlrbBeBj1/1eSxO5CD7ok3HvWjg0anOAof7o/Gwen2w4dO8HsLCIwDs4xfJLdzmEvvLgirH/53zQxqwlrfGEyssMKXjULG6Hdfwu+eBN8M/vkyjp8XUljwTSZXDSINy+Ma1jBko3UF9q/xyTh+ouj3nuNTmfbC/8QnDwCbiZkTKWsyowrX5zJSRpiPA3MnuofMlEdYvX7C1jCWL4v+Ez4zJqyRtEUMRJKDhIj4RUVYg170jF5Pqv1yrXW2PmZ4dmsa7HdniacDwGbi0X4v4SMjqMjpfkePvHUvYUxYIX3kEFb8nCxhzeiR6KmeryudDKfR6uckxJraAjE+n7B6vejJvXCFRrtTwYxfYYE1YQ0iwuqDsACB4Bmbu0GZuMy2gDQkRyNDuSnCGlQmrJGvK3nDXqiAe4NepI/7ulc/gs9LvsDV9f9VQFjd9ZP7syRLJQjrBIQFAA5dpMwrKp5+MGb68uOpipT1NiusabdfSFj+s8Ibd7H8NOz5T0n4q/rd4UxuLVWElWEetsI6wQoLAIowtbQvvJrmL6Ro+IT+ODCHhBVq42sTQ1bD6s0yojsjLM+/h5hoYR4Fr+r1ot3dWIpXRRpWxENinHasjumfXMMCYQEAYXVvweIgQ2tYsEwiIVkOe87LUG7G1hCmMgSLolggH6QJ6yTilpM8DUveq3s5OWEKfsR+wfEj8vLyCWsUHc/rBcaHYeh2CDeHnn+QcbR4i14NwgIAF1IWE69y6UiGuutKWU5sDb1hsIkL2OOl3x2MRoM+EZZPJCezgM4GI++kn0NYJ6FcNfAN7jNfpjoZnYTs51sPTvwXhcTj///QO+v3eyf/DR1WgRfeC+T5SJwPV06D4DQCdoukrvAl0QNDXxQLDuqBsABAVBkHVp7NQBu+otir84kwyW9wsiUc9mIbeeDc9E3vbEs47YcpM17gVB/kbQnHvci27tsPpqGlvT+KPFSBP/1kFiYzhE750XodFzwzdL9HzBR89XzSi/32AyaMDcKd5qgv/wnCAgBhu1uH9eGU6VPMlnX97W0SR30B6oX9O+85uS/vnUXPCDX1sefNWDhffOApezgH8TPi0ED/1VMqjyYcAHAjZTHx6q582cRsWcuygRTvMiJ5uBbMsd4BgLeWsswtDnJcmLZhgdmy5sWveKeEFbVADxEUAwDigwXPUIhMwnhVDGbLKgyeeZeENY5cn93ofiMAAOKjSFkkXi3MwhiYLasgeOZ9Ts3xkxdOBifDUpEKAADxjoJnKERmefnVNDqGbFn5wTMY8wUAgLASPEMhMqt/vlbJEyVbVp74BcICAMBK8AyFyEzO/6oIsmWpg2dAWAAAiPrBMxQic12ZrpK2LNUqDYQFAICo261DfTh3FQd4KWxZCtkehAUAgKgXPEMhMn/q0lXSlpU5HAgLAABRK3hGhsgYGK90bVmp/SUICwAAUaNbR/bhLC4t0VXClpW84QjCAgBAVJaypHhVwXilacviRAjCAgBAVAyekSEyFY1XmrYsCp4BYQEAIKp168g+nMn5X04gbVlR8My3KxAWAACiipQlxatrR3TFbVn+jjPYI4KwAACogpcXS8YrTVvWPEiBAGEBAFAdf9zSVXqIIQgLAIDKsOlkKPI4gLAAAPgIC6zEEguEBQBADbhU3DNTKkBYAADUghMLlnJ0IQgLAIDaWLhTsvg8exAWAAA28OhGyvr7xyNjxUsQFgAAVlA+A9Uc30i8CjsV/d0hCAsAAAtw1/wsKHz0HIQFAIAVzG3uC//+Iccb8k5FEBYAAMKWlGWLr5h4lfBNgLAAALCGiRUp65ucnZPuVARhAQAgLEpZX+pbGZYCme4AAIj3363D+nAUEfEgLAAA7OKuRrfO+V2hHRWEBQCAbVTt1vn6T4lLAoQFAIB4F9061IeT258IwgIAQLwDKYuJV/kR8SAsAADE2wfPUIhM0etAWAAAiLcOnqEQmeKIeBAWAADibaUsEq/KNpIgLAAAxFsGz1CIjMJ4BcICAEC8n+AZGSKjsxwDYQEAIN4seEaGyOjF04CwAAAQbxQ8I0NkdPV5EBYAAOJtgmekeDXRdUCAsAAAEG8RPCNDZAwMWyAsAABE88EzMkTmzsQSD8ICAEA03a0j+3AMO3hAWAAAiIaDZ+IQmXLjFQgLAADxlsEzcYhMhUgHEBYAAE0iHIgqKs4FA2EBACDec2M0CAsAgDfFpGKKMggLAIDGcfUNhAUAgPjc48BAWAAAiI8yDgyEBQCA+AAZyiAsAADEhxoHBsICAEB8lHFgICwAAMRHkbJAWAAAiI8iZYGwAAAQH8X1DsICAEB8FCkLhAUAgPgI48AC/D+HUDIT7LdhoAAAAABJRU5ErkJggg==",
    contractor: "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",
    project: "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",
    address: "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",
    neighborhood: "iVBORw0KGgoAAAANSUhEUgAABLAAAAJ2CAMAAAB4notuAAAAwFBMVEX////6+/vn6u3R1tzJ1uPH0Nq9x9JMw/+tusedq7n5cxb0cRaRo7SJmqpHuPJNnct5jJ9sgJM6gq1Pc45mbncNbslhaXM7ZYQMbMYMZroLZ71UWWI/V24wSmIcU3geP1sYNE8SQnISMUwMXqwLVp0LTYsOQnQQQHAPP24PPWsOOmQNN18NNFoPM1QPM1EMM1gNMlQOMVELMVUOLkwMLk4LLlANLEoLLEoLKkgKK0kLKUYLKUUMKUQKKUYKKUUKKEWGCRxYAAB72klEQVR42u1djVvaztZUVArvBQW1WntB0GoraOsHiOJe5P//r9587e5Jskl2k11QnHnuc39VISehZro7mTNniwEAYB3zx78eHufRl4+jCycYPcYKJL50WO/m7LuHs5vYl/aRKHA22sKvFgA4wHL2+Dhbhn+eji+cYTwNa7zf39zcv6+u3uL3z5+/F+Gfx7++O8OvcaweCAsAHFFWRFcvDukjoJCXsM7b22rrvUT/vb/67hRX96QeCAsAnO4Nb/9cOMaf2/n66j1f//juGD+un0U5EBYAOMSdc/oIKORuXfXc01VIWSAsAFgBXm9XQSC3r+uq93y1Asb6cfUMwgKAlWA6ck0fo+k6693+cs1Xv24ZtoQAsCIsH5xSyOhhueZ6v89c0tXZb1oPhAUArrFwpyz9uVusv97cnZL143oeKwXCAgD3mDuyGoznhKUIl6yg3vyacMmTI2vD1ROtB8ICgE8sZREx6f3h5uLi5l5S1rPbegt/H3j2e+FUyiLiVVjvZgnCAoAVSVk3dunjRopJQrYaPcnvPTmsx1txPAqRlPLTLl39JHTIZbJfICwAWJWUZdPT+edWvZoS3X6WpSxaj7bi8NYZDy82pawf1y+qeiAsAFgZ7HXNjOXtnOwcHE/d1ktu/sjGzZ6URcSrWD0QFgCsEHakpdFzLicRyrJeT9U5yLv9/MWQFYvD2TirHggLAFYJL1WhspjEUxmyOwflgshuvYzOQdLtZ0HKIuJVqh4ICwDYirt1/lQTk141jvTHWrcOOdI0W6T6cT3VeJWeeJV3JBAWAKwaswrS0ngm1jL5aydi8aySjyXXavPr3LXTT2nLuq9gcfh1n1sPhAUAq8dTSWlp9BQzXhVt5Rb26i2KG3CILatsAqlIGM2qB8ICAPZJunXkokmzX1DasqrW02Mgacsq1a0j+3Ay64GwAOCTBM+QUJeRcQg7ex2Xr6efgSxtWcbBMyREJrseCAsA2Gfo1pF9MWaSlPQ4lK1n1nUjbVku3gfCAgD28YNnZKiLuRlUUFapeuaR7cKWZRA8I0Nk8uuBsADgw0tZUkwqF9kuHvUZ13sup0U9m0lZUrwqqgfCAgD2wYNnRKhLaQuXNFO9mNQrbamSZiqdbh3Rh1NcD4QFAB9byhJi0qKKaZ0smnTrFRivCuzqYtFUJGUJ8UqnHggLAD5y8IwIdXmvGk8jbFm5wTOi3qJq8rGwZeV26/yUr9KpB8ICgI8bPCNCXawEtQtbVnbQjahnY/i8sGVlBs+IEBndeiAsAGAfNXhGiOW28kOFLaugnq3h88KWpZayhHilXQ+EBQDsYwbPiFCXqcWEduFxmGbXsxl3LBSqdPCMCJExqAfCAgD2EYNnRKjLi+WBEpyyElKWqHdveaAEt2UlpCwhXhnVA2EBAPt4wTPChzC/tT+yi+/8iCtL1Hu2P7JL2LKIa0H4HgzrgbAAgH244BkeIvN662TCoKAnvnrjFDZ1M2FQ0BMPnuEhMsb1QFgAwD5Y8AwPdVnc3Vw4wh/ucXgm9SoZrzRtWTdnMkSmRD0QFgB8LNzfWzJeFU3teo/XW7geOR9RZDAQtWw9EBYAsM/dGF3a4yAHDVoyXummZZWvB8ICALap03X0p+GMf31fAWRaVtl6ICwAAGGx0dkqCOtsVLUeCAsAPiLe7/64piuhYgWKkpvng/FnhYvK9UBYAMA2JEO5ZHxD2Uzj0gnIFeqBsADgo2I6dsdXty/percOhSwy0L5KPRAWALCNGwdW/ICQ0KIcbM9cPSqU47s8vX1coR4ICwDYho0DKza6L2IxEXJORbnxXPoJyIzdeZ2DV3el64GwAIB99gzlssOcRaci+dbTlW2+EiEy/sF/hHrWU8l6ICwA2KhxYPpWBmXzs3Upi4hXz7T5+blUPRAWALCv43q/ke72REQ8eWq4tNekI8d3ebGj8XiZ65cS9UBYAPCJM5RLi1cKEhSh79akLCJezdPB7j9/z43rgbAAgH3aDOXS4pV6m0m6C21IWVKpymh0Fg3R2vVAWADAvkS3DhGvstmPvKhqe6FsHGSjzEP9GpnVA2EBwCaMAyse8vXOtKZHS49D7niuwgAsuXjKZyLJazr1QFgAsPlSFnkIWBxiKinrpfzk5xdqvCrYOd7p1wNhAcDGS1lSvNIzosrXl5tIwedOCONVUZvhk249EBYAbLiUNXpipsPuyYrMPAhGhshoT5ggtqz8eiAsAGCbHDwj/VVLk85E+TbDIBgZIvNiEtkubVm59UBYAMA2OHhGLJWWjyNTmX5hHgQjQ2TmppK9tGXl1ANhAQDb2OCZ0bRKf4+0Zel2z4g+nFITJqQtK7MeCAsA2IYGz0jCKZusJW1ZOkEwMkRmVNLDJW1ZGfVAWADANjJ4RqpQVVzywuNQ2D0j+3CqWE6FLUtdD4QFAGwTg2fGc2Zn2L2grPzuGWFNuKvY1CNsWap6ICwA2MDgGSFe2Rh2L2xZ2VKWEK+eqifDS1tWuh4ICwDYpgXPiBAZS4Glwpa1zGpiXhoarzRtWal6ICwA2LBuHREio+0TNbBlKaQlIV4ZGa80bVmJeiAsAGAb1a3DN3BLuxMshC0rKS3xDdz8tzW6itmyYvVAWADANqhbRxgRHkf2R+0s008B+VO9xW/rA3eELYvUA2EBwOYEz9zcL13kwCfZUATBiBCZkZORhsKWxev9AGEBwKZIWUIbdzeBlXscgiAYESIzdjaBlS/gonrPICwA2BApi4tXLw4HRkvKur/iITJ3V98dgtuywnogLADYKMxv/1y4xTg25d6C8Uo7LQuEBQBss4IcXNNVPC3r+doxXSXSskBYALBBuLtYCUSo8fX3leAahAUAyFCuvid8unJPV2RPCMICAIZxYOXGhQUYn7mlq7MxW5eG1dtrDvALBQBO8W6vIyd3XBizMQ7MYFzYqglr0Nza2tpuXxoQnI+hSQn+X/+N/awjRmcw+3DkOT73MMYdB7APKr0TuZ1i6kp6/3E9jVdaHWFNOttbAWrH2u8J3tHTfnm/sVUPWarjv7Gu+IsMziB8TW9nuzP5WL9nh988HOJ+Az6olEXFq+l4TMjk3o3T/V5WuP3lm0hXRlgntS2BvZ4Lwhq2/ZdvtwZahNWvB+TZfQNhAeyrZiiXHRfGCZES2I39XsIbQohXoe99RYQV0oOEppRlQljDnejYtYEGYfW2+Zms/Bfpwtv2jeK7wDkIC2Arz1AuGTDDiDn1z+1cftPuvlAmLlO312oIa9bcSkBPynK+wtpewwpr3yOlg/ii6i8IC3AhZVncFxLxKqaQUVXr2Z7pXY4LiytkKyCs1/Op/3wwSVk6UpZrDatlIOj3DfV/EBbAPnCGsuFuUMpVqVRAOb9QfxyY9rgwf+H2c6V5WOf73/ZPvSs6riUpKyIXe4QlnxLqEJbRU8J+sOE8AWEBbBMylMvOJ2TvDzeqRGZhdVjaiMUSicvpmC3XhDU+8O/BbwcXjF22t5OUVSRlGRMWMyEsEzS2QFjA15SyiHiVSX+E0ipLWUS8WqaUfLeE9S+4AwMc3kVGrLiUlW8s+DiEVbNGWBffKGHNDkBYAFvnOLBCK8Ncy0NP/O/VunVIH44iZsslYb2e7n+T2D+cKaWsk2LCGnb2atu1uhC9em0P/Ktj/4uQ1Fo+hgrC6jV2tms7bW89Jwmr57+4E/y4Gx5i0vXK7DS6dCfYaex4XLXd2N6uewjLTE8PD/b39w8Ozonn92/wvf2D0xl5+yh64SE3g54fHu6HH4aH2d/oq2/+Vxdpwno89d7+bf/g8B9uOoCtpVuHiFdFqYDEllVeyiLilfIgW07Fqzj2/XsyKWXlau8hYfX5W3aiHWTb/6JBN2sB8VwGLxqkCOuywddzPUJY3cARFrwgYNGu8EU0uLY+JCvCbb7Qez2U13XAiWghl5L754Jv5De/Hf6VSyiO6Yh+dZoiLMn3+1h1AdWkrKdS3To3cqen40SVtqyS3TqkD+f+arWj6iPxivLVaXAyMSlru+O5G/6ev+YSlqS42qAEYV3KVd32IIewGuJl0aHf4uaxLktzzrdzsrGLf4/9ixH2/tSUsGKvBWMB1seBFffhLAxTAYkt68VcyhKJyzkxW1vOxStxy3l37PA//xlSKavhscvMW7HIVYmCsKjw1ShBWB3y/nY2YbXJy8LVVDckyWa7EVDmdvC28/hVHVBu2d8njLVIMPahIWGdRsc8AGMBbB3dOnK9ZNCaSGxZplKWFK9yWhO33ItX4Y1969PV//3f//3nv//jUtZOT24cD0aZhLVVa3d73SahEiPCGoYHqXdPjjvRpk9JWJ7l1CsTLqrqUmgPjjwJqrf8Pwb8cXj+7++5zy4HE0li/q4vXFfuP3Jy2j+8mNxFl/g31LAOYhrWYZaGNRZ7zr/ha0a444AVSllSRDccx0psWSbBMzJEZp43jnVrFeJVsIL63399vuKUdVwL2vhGB0mVJ01Y0T7wWHbSGBFWuE5q092hkrAikSrcGAaCe0CqkZoVnIj/lxdcTviPyMV+yFeBUSHimfmB/PPht4O/ZHN4TlZO4inhv28ZTwmDPx68kj/jfgPYqoJnZIiM0nhVpHy9m0pZUrwqmG+4tRLx6lXSVUBZHmNcDsXaQSjLUyVh8ad2TU4aZoTVkMTkLe2yCatFXzHkf2pSW4P3APA2ONPom7OQr4Kd3f6MuBaiF5zfKuwKeoQ1Dzgu+kdnErzoEfcbYCF4xmhfV9J3Km1ZWsEzMkRmWdRCbZ2wLtLilf9QntCVj/8mHrdFlPUvz4clycaIsGKkN8kR3cNXSFk+RljBZtLjpymV1VXuqXfKNByUpPQI65wSY7gPPcfdBlhA8cxCKV5VsEM86wfPyBCZ4vmGzldY0ZP/+Arrv8qNY9puFCOsofBumhDWYIse47WQsGTNPhHu38TqLpLcDk/PpzE6OaRG9iS5nBsTVnwXeADZHWArCp6RITLVxrFKW1b+qkmGyOi4txxrWMHjv5Md3805/M//EQ0rvXFUye5xp3vw1bEhYfVj3nYTwgq3gcG3Jy2x2jolZxztYVOXEj7y8+nIF9k97JcjLMVjRgBgLrt1ZB9O9QhAsVLL6daRfTj3Wg8VnTwlnEVPCX3xKnwiGCjsIWX5xoa060FtbFAQVteQsHrlCasTtzWE33w9SFph2X4GuSSusiphQXUHmOtuHSFeWRnHKm1ZGcEzMkRGd76hIx9WIKf7W7w+t2P6HgZvX+jr7QrXw+GEfTzCeo0bRzuRDBbjkpF6heWTznj/GwgL+KhQqemiD8daJryU71X7PdGHo58J78zpfuH3zw2pq73h8cTwfyrx6uCWMV3COqm0JWQmhMWGDerJJ5e2L5tm5sKaReFd0GPYNHjge6wOS2pYsWPCiAU43ReKR3sLm1N3hC0rFTwjQmRyjVcrbH6edGqJlNFhXATK2w2mCUvK5x0DwhrGYhaMVljssuv1XIfrw04iCOfvxXm4sLrIylgIKWdaUnQ/xZoKYKucrSPEqxLGK01bVkzKEuLVwihBa2sVc3JkL6AvZcVXWIHOpUVY0iHVpdaqeoGtoUbZaGhCWF4T43ZeEs1BJK+ryeWAiO/mhBW6Q3BPAWw13To8RMZK4F+mLUt26/A+nKXh7Aq3eViDRjJNxpeyZkTDUvnbE4TVoUupHUFd22GmwqSmYxzdiRLkTwwIa1iTyziC84MZpZdTTjpix3Z4mrI3mPuwEu6I88N33F0Ac9WtI8QrV1OjhS0rlLKEeDU2zaFxnTja20lSli9lcYv7wQUrThwNe2ZCZ0HoRw91qeZMuN5ThNVNtubUA3qLgmr0CMunxVoqPfBcGDDehZ0z+MPBXbjsPYx4hninwieLB+nVlvej3Nac/QtBcjA1AMxRt44IkZmOL5yB27K8bh3Rh1MiNst5pvtbt5YamOORx8WBL16962S6e2zTOWnXaI7CTiQsHbd2tpSEFaykavV6N1wo+V+0TjqN7S0DwgpXY9t7fnJfvdHu9qUN68CX2MMu5gnvzfFai07PTw/FyihkHO8S5+cHgUjv6e+yd8czZ5GVlO/VeuRH95MBuWb/zTvm+eE+bFiAw1v0zeXs1bQt6+XFxHi1asKKx+BJKev9NN06WBwvE3XKHJM9plJ07/M4Gf14mRRhDZIKXP0klS5Dl0OJRKxzHg+z76cxfBOtNot9VTJNFOaQfn/SiwoATjB3Nd1emZalb7xaPWGlx6hGyTJMc8yXXKLtRFmgb3KjeaIkLFaXhDVr6AX4pUT3biqBvp98ZHAwTwaOyseeJIT077kkLMFEIWFN9wlhzWig1jn4ClgZ7pzTVfgoktcrO6liRZOfk8HIRoQl7FA7w9Sqrau2NXALVZAqIxhrp2/mw+onBThf8r89IPkSj1KKT31TGt259WE/1roU6Vj8eH9JI2bIeBcke+cWtxTA1p3iYHEaa9mZqysirHgwck133nLHnw7hMVC/tUOHUISDKLxv+QI+GULR8cFJrdft8O+HQyia/hf+i9uhAO+/+JgOoYjX9ESsulc0xE509v73F+feaAkvXfTwfBZ3ynpSlSdukVXvefitv9H4iUO+SlqMTr2vxCPAv/7PIq//+7n/Ix72cBsdE8kyAPssM1e1BlqUHlSxtbLPQzTpGM1bXiPa1GX/Fm5MT/B7DTDMXK04jbXCzNWtFX4gocWh3v8cf30DYk4V1q4ufq0BhpmrlaaxMlZh5uoqCYvNOtu1T7NG8Z9E1simr1V2qCsAsK8xc1VrGuv8Wk52Np+5urXaz2MwYZ+JsLaa/Hxfu76KVbvErzQAKauCeBV0Dp7J8YOmUtYW/oYyEFq5thstT4NvRolYbXwsANt4Kct687MQr0Tn4NnNstzMVRBWJlpJG1bU3wMADDNXS0xjjXUO/pJzD0xmroKwstGOW91rnVd8JgDDzNVy01hTm79ftyWkLBBWDobdcCtYq+00OicTfCAAw8zVcrNzlJ2DV/fMdOYqCAsAAFZ+5qrONNaszsEf18+GUhYICwAAVhRIWiXOPS+yXc5Q1Qt2B2EBAKDGrIKUNZ5J41Xu2umntGUVz1wFYQEAwMrNXNWZxqoR2U5sWYWBySAsAACY1W4d2YejGdkubVlF3TogLAAAmM3gGSle6Ue2S1tWfvAMCAsAAGavW0f24Zh13UhbVt77QFgAADBbwTMyRMY8sl3YsnKCZ0BYAAAwO1KWFK9KRbZLW1amlAXCAgCAWQmeESEy07KR7dKWldGtA8ICAIBZkLKEeFVgvMqHtGUppSwQFgAArHLwjAiRWZRJPlbaslTdOiAsAABYxeAZESKjabzStGWlg2dAWAAAsGrBMyJEZvzruxUIW1ZSygJhAQDAqgTPiBCZW0t0FbNlxYNnQFgAALDywTMiRMbceKVny4pJWSAsAABY2eAZESLzXNbJoGHLIi4JEBYAAKxk8AwPkZnap6uYLYsHz1yDsAAAYKWCZ3iITCXjlaYty3/66OlaICwAAMrg/t6S8UrTlnX92/s/EBYAAOVhxXilm5YFwgIAoALGv76vADItC4QFAEBpjM5WQVhnIxAWAADVsXDzfDD+rHCBLSEAAFaQn2lcna6unkkxEBYAANVw61DIIgPtQVgAAJTFeCz/7OpR4dkNqXcLwgIAoBTuvM7BqzvGNMdzlRSv5vF6TyAsAACM8RTqVj+unsi3bPOV4uBozQEAwBCk0VnOjbAtZRHx6hnNzwAAlMNLvHPw5/ULKx7PZd6Qs1TWA2EBAKCPeTpo/efvuWUpi4hXiXogLAAAdJHR6CwalO1IWVK8StUDYQEAoIlRpkr1a2StvVA2DirqgbAAAGDVG50lz6jGc+kHYMnFmqoeCAsAAKZnvCrYyd1Jnbz05OeX/HogLAAAmKbxqqjtT4hP5SZS8LkT2fVAWAAAMG3jlebciDLBMzJEJrseCAsAAGZgvCoKYX8pFzwjQ2Ty6oGwAABgRsarItl8bh48I0Nk8uuBsAAAYIbGK825EdrdOqIPp6geCAsAAGZsvCogoJFJ8IwMkSmsB8ICAIBZnzAhbFmF3TqyD0ejHggLAABWynilacvK79YRVgiteiAsAABYOeOVri0rW8oS4pVmPRAWAACsrPFK05a1zGqaXhrWA2EBAMDKG680bVkKKUuIVwb1QFgAALAqxitNW1ZSyuIbRqN6ICwAAFg145WmLYs+BeRPEQ3rgbAAAGBVjVd6tiwRPCNCZEzrgbAAAGB2sveKbVlB8IwIkTGvB8ICAIDZMF7p2bLur3iITJl6ICwAAJgV45V2Wlb5eiAsAABsGa+007LK1gNhAQDArr+vBNdV64GwAABwMWk+d/Z82XogLAAAfIzP3NLV2dhCPRAWAACs8ngug/FdVeqBsAAAiDB1Jb3/uJ7aqQfCAoBcvD4+vq6UNMbj6Srr3f4SES8e7t043e9lhYuDg4vy9UBYAJBHV9OHv38fpm+rqvcyvvAwfmErNYteEUK5sd9LeCOPPj785uFwXLYeCAsAslWdiUdXPh4m76uoN7/9cxHgz+18FfXuuXmTOKSKM41Nd4PyUv4GdBVQ1t9y9UBYAJC5O4voKqQs96s5TlchZb2u1NtOVaZne6Z3Ob6LsX+H+98E9g//lakHwgIAJd4nhK58PM6WTldz9zcXMdzcL9gqve0/yVLo1pKUReSxCaWrkLIm5vVAWACgoqvZ498UHFLW+0OCrgLKenC2EVXuw+Q8waxMY9MgLPF5vZ4m6CqgrNNX03ogLABIYfmioCuHlLV8GF0oMXpYrjSlj+jjlaUsIl69nyvoKqCs83ezeiAsAEjSx2sGXQWU5UBaes6gq4Cynu1fX96DuV9jS906pA/n/OBbJg7OjeqBsACAJYxXf3Nhm7Km44tc2LZlFaXmEd2pvJRFDnKRQ1cBZV0Y1ANhAYAJXf21bMt6KaAr27YsHQ6StqyS3TqkD2d8+K0Q0pZVWA+EBQAJn2gxrNmy5tTJkA1rtqz7K9PgqhdzKUskIFPjVQFl/dWsB8ICgJRPVIeybBuviijrdaUpfcSWZSplSfHq3+H+N00QW1ZuPRAWAETQpysrDwxTxqt8VLZlGa6ViC3LJAhGhshM9OkqYcvKqQfCAgCm8ok6piyl8aqAsqrYskqMR5W2LG0pS4pXSuNVAWUJW1Z2PRAWAGT4RB1SVqbxKh+lbVklx6Oe3SxNgmDkPjLTeFVAWcKWlVUPhAUAmT5RDcp6tW28KqCs59WOR5W2rOIgGBkic37wrSSkLUtdD4QFMDgZ/laAOWVNxxcVYG7LqjYeVTqq8oNgpEn+ojRdxW1ZqnogLAB0VQ2GtqyXSnRlbsuqPh5V2LJyumdkH8748FtFCFuWoh4ICwBdVYWBLWuu72SwYsuyMh5V2rIygmBkiMzfynQVs2Wl6oGwAPhEbVCWbeOVFVuWtfGoUk5XOeXFrvHf4f43K5C2rEQ9EBbA4BO1AI0HhobGq8q2rPm1xSk4wpaVCoIRITITW3QVs2XF64GwgC+KpU260qCsEsarSrasxW/L4ezClhWTloR4VcJ4pWnLovVAWACcDNYo68W28aq0LWt542AsqrBlye4Z3odT0nilacuS9UBYwFfE3AFd5Xkcnh3QVZ4ta+xkWhexZYXSkhCvzg++OYGwZYX1zkYgLIDh0aBjypqOL5xBZcu6dURXlKO87hnRh3PhiK6oLSuqB8ICvhrepn9dImXLenFIVypb1v3Vd6fgtqyXF1vGKz1bVlAPhAV8LbxPH/46RsyWNbflZNC0ZT27mjavTMuyZbzSTcsCYQFfCy/O6SqgLLHouXNOVwFl3fF67ukqpCxe73D/2wqwfwjCAr7ofnAFjPUweZNW0VUQlrSRWpyBqjUddRULLLrEAmEBX42yHl3zVVx3n45c09VouirFPTVgwsPowDVdHYwYtoQAw0NCN3SV9I86sWDlmLGWv89c0hWZjurQgqUcXQjCAr4kljNnlPWo6oNeuFOy/twtNMc621KvFH3XE3dKFp1nD8ICvhRLkaWP9b4cbmlYEJYiXDJ3ZG0Yz9X1nhxZG8h01P/997//E1/cOZKyDu8IKx6CsIAvtah6nMnlz2LqVLwKOgdpt58LKYuIV2E90hDtwutOxKv//fc///d//yGU5cI8SkasBp2K3u4QhAV8pT3g44tcZdneF5JjC9mKCExL+83PinpPy4ozULWmoy59uvLxn//KevabnyX9cpnsAIQFfC2V/XHuxkP6MFkqOwdJt9/Cpof0z+1CXe+RVZiBqjUdlfUjugooqy8XkVb3hYdy+Ug6FUFYwFd7KEg2bva6dEg/TrJzkHT72evSIf04OfXsSVlEvBoSugooayh+dGuNsg5v1ZtNEBbAvpxTlLCLHYsD4UAVJxF2sRPbQJZtynqSskZWLA5yOmqKrhKUZcfisH8utbg4B4KwAPb1xqOSp3nLWeV94YN8/JjROUi6/d6rx47e3L8XdSpKirQgZRHxavhfBV/5UtaQMWs5fnKgatpID8IC2FccPk8yFSp265Aj5US2kxD2isHuekcir5pW69aRce7sUk1XIWVdMhHsXnE3+I9lR8SDsAD2Ne2hxJH+OrWxGyyIbCeeg1kFKWs806xHLKVVunXkdNT/ZdNVSFnC4zCuYHE4GOfaUUFYwJd1s1PKeqwaiqwR2U5sWU8lpazRk0k9SZFlA5PldNQCukpQVlkpS4pXGVtLEBbwhZtvJGUty+TOPAjnlWa/oLRllerWkYsm3XrCllWqW0f24SyL6Spuy5qVkbL2T2dF/YkgLIB95fZmuaN7M+3WISEy+s/+5PM98+AZEiKjX+9RBs+UD5Hpa9FV3JZlHjwjQ2SyI+JBWMAXT2OQlFX2fWaR7dJzYNatI/twytYzk7JkH85Qm67iHgez4BkZIpPX5QPCAtgXj+gjj/n0u3XkZtLcDCo8BwbBM3IzWaLe1Dx4RobImNFVjLIMgmdkiEx+RDwIC2BfwHilG8L+Pnk0C5EpFdkubVmaUpYUr8pFxAuK1JSypHg1/K8xX1FblmbwjAyRKdpIgrAA9iWMV0WUxUSKw4N+iExpS5W0SekEz4gQGQv1dLp1RB/OZRm6ituydIJnRIjMv0J+A2EBDLl8sT1ekZQlxKtFFdO69BwUSVlCvKpUTy7SioJnhHj1v7J0Ffc4FAXPiBAZneUYCAsAXSUoK3eMvQiRea8aFyNsWbnBMyJEpno9TpG53TqiD6cSXcUoKzd4RoTI6PX0gLAA0FWasrL2hSJExkpQu1DSM4NnRIiMnXrclpUdPMNDZJZV6Spmy8oOnuEhMrr6PAgLYJgrkd7uqYNnxPPEZ0v5ocKWpX72J8Rya/Uec8dDC/Gqb4GuYrYsdfCMCJE513VAgLAA0JWSstIHFT+aWkxoF56DNCcJNnNSL+3KEiEyQ0t0FfM4pJdQog/HIF4ZhAUwzEZV2rISwTMiRObF8kAJvoxKBM+IEBnr9abclfVTKV7ZpCtKWQmRSoTIjE0s8SAsgH0945WmLYtQoaCx+a31kV3ClkVcC8KH4KCeoEgiZYkQmeF/LfMVsWXR4BkeImPYwQPCAthXNF5p2rJ48AzfDb7eOpkwKOiJB8/wEBnX9bgri4fIXNqnq5gtiwfP8BCZf6YTDUFYAMNA1JwHhr6UxUNkFvc3F44gPAd+8AwPkVncOav3h9fzM5R5iMz/3NBVzONwvi/FqxIDWEFYAOgqn7JmM0tGKE1b1v39autdXzunqxhlBQNRy4Ypg7AA0FVxwJ8lI5Rug/M66rmlq8QQQ6PGaBAWwOBkMIuQeXZOH/G0rFXX6zunq3ha1nnJFGUQFgDC0iCsx9UQyOO6COu/qyGs/1bNUAZhAZ90S/jy4JquHl7oFubuj2v6+HP3vtJ6JGPeuYKVyHwvPQ4MhAV8VrxNnFIWSUAum2lcNgF5JfXIVB0WObDc8pWcXchKZiiDsADsC4uHOTPmoEUmZ1rzSurdvqTrDR0usv4zTNcbHYCwgC+Fl0dXDwgJLRLqenIkLcnxXR5NTVdQ70HWGMs59M6kLClexesZS1kgLOBzS1kTB5QlE5DD2AYZ+l5uPJfJ7sxfVZHVlpt6t7KeH9twdedWyqLi1V283szQOwrCAj45FlPbUtZ0kTz4A/nW3Po+TSQgeyvG29SGzUE9efDnsJvwx9WTw30h2Q0+XaXq3R1+JsJ6HZ//M3rDbHQxNXrD+/j8b1wYuBjNLJz53/PxO9hiA6UsIl6pmp+Nx3Ppj+9SNj/br/cs6ZE2Pz87oixCV8/qegbpMg4I69RrFQru5INvB8E3BIEeht8Neh95EOE+zXT2Xhk0nY6i17J9PlNjFgup552T/ND7fALjfnRg7xyibqX34OHpwbncQB8Eb+AsGVY4OBzFLyJx4NPoS3Gmoe9t/zSirFsRmSGPeRo/kdQHAdi0OFijrEdpZUjsNh8n8if2mmaI2zyx+yP7RIv1bmS9eSJeRkzKsel6J+72+XVWvXd9i4MTwgpv1mLCuuWneZpPWOIWH+/Hk7/Eofcf1YQ1OUhwBBf59scsXuFcRVj8wKfiy4v4zw8mIKyPQVl29oUP02UOCRIysyQtEVJSdA4Sn5StelK8UswoPPu9sCxlEfFqkVtverhWwgpuc0JYhwGCW/fCo4z982BBM/PY5PD03F80XWQR1v75+blPv8FKZ+b94fDcf0PEN94bvJ/7q51DNWEdBhVOD/jXHuPt+0fwTnHGK3hn5v18/y5BWPTAp0Fd/23h8c+9P4SHPeSEdRBeY/BT/8fntyrCIh8EwCzH+FkQr8Q2bDlXrtke54KybMTqSTFpqX4cKELYbdfLmAJ9drO0uS+Uu8HlzVlBvdvDNRJWcB8TwprQF3BW8W/74AYf8Z2XgrAOOH1w3qBv5G+YcCJJEtZt9IN/++HaRxzpkK/qonecJ5Y9iQPz43kM9R7R3GP09W1Uh779TnyZJKwJiOXjSllEvMo+FHlR1e4ZIiZlH0rrRcb17jOHE/6SnoOq7YWycTBnshipp9Ve6ISwvMJjDcLyXhbu5P5ma1gxwvLecMfXRe/0DfsZhEVXWv4i7p0T122S4vgPEmeynyIsf2F2wc/vNOI9ENYHCXB4sNKHk898krKW1eYSLvX8odLjULGe2F8+X/3QGUtoay5hxmouXW9xur8ewroI7nNCWOcBkoSVIAn5ytP4lvA8xSqH0R4xooC7xOvPyUJqTInjr2ASfqh9eZJ/04R1F19hLaJ3nfP1GWfW23DLeH7+WkBYsQ8C+Djx7qQPp/AY5IGhhUnMGns9uZOzUe+5cFr91T2zN/k5ZzWXrvfvcC2ENQ4IIym676sJ69xXdU7jqnRSdD+cpAhrRFShfU4LhKDjS7KIYkZ5hHURJ6zowFw7PwylrsMYDXFCE6L7YwFhxT4IwMW+cFptN6gVEf8gjaWzUtLSWBhrtCLbReh7WSlLUt5LIV3FPQflpCwpXj0b1hsfrIOwJh4fvGoS1qH8WSZhfQt9DSrCij13s0lY0WPA99hTwoMZCGvzpCzSh6PbT/0gPQ7mwTMyREZ7xUQe75lLWbLvZ5438zlOIS/lu3VkH85Uh64S9fK7ddwQVkAQhRpWtMI6OCCSuErD8h95HmZtCf13c1tESsMy2hLexQnrwEc0Rtv3lh0cfCNPC9JbQmhYnzR4RvbhvJvYuR5n7+WCYGSIjFFkuwh9N6+3yHYW5I2sn5eTsqR4lTBe6dbLDZ5xRFje2ma/kLAOv+3PI/U9l7Co+P4Yo5vgDbfcqZovut/SN/5NVjhQi+6M8I6nYEWkJvjpHKL7pw+eEU03xpnLMkHZJAhGiEnGGcjSY1qqHhv9+m4EaZMyCZ4RITJG9BivlxM844qwLqQ9NJOwuLb+t2CFxV6l9h3ww0Xc1nAoWCFJWHzLNiUVLmJEkm9riBGWON+A9yZ0ywnC+qz7QilezR+rSF+6QTDykV8Zk4I0JpjXuzWkq+AB3shUypLi1ahSvczgGVeEFQg2iaeEowRhTQIf6MI/t/0846jwbwZvuLjzV4wj8ga5xFIaR8//+QcQe7j907sL3zg6IRX8kx0VEpZcYvnWDe+wh8Q4mklYwePDC9UHAbiEznpJWtfLergkZemsl6SYVDbpShKQVj0RInN79b0UpE1KZ18oxavxr6r1MqQsZ4TlLZsKW3PO+Q+yCYvr1H9jb+B8EL3hMLFeIqr4fkw8J8L3eVFrTpqw5BLrnfP//p2CsOKtOfJ60ZrDVjsS+lG3D6eKS154HAq7Z6SYVCWYT1CWQb37knQVeA7udKUsKV7d2ainHlrojLDYYTFhRS3E54WEtT+K9XWLXuboDbffEhK63In9Da56/3ARt9OKLubs5mcFYS14jxB7jQ77j4Gw2OcMnnkQfTgV82lk9Ex+EIwIkXm5tZQVqlkv3yda/ABPRMHk7wvFbvDJVj1V8My642WmF2OGeBlg5VKW2Mu9VW+blk7S7CAYESJjYfi8dIFq1NN2FujYpLIpS9DVs8166eAZBPgB7OsFz4gHfJYCS0X0TEYQjHjAZzvlIaOeCJExchbkeA54FExG8IwIkXmxXC8VPAPCAjZcykqvoIRR3eL0aGHLUlCScH0u7u3lWnFbVl49bZ+ojudgnillCfHKRb3JIQgLYF85eIZv4JZzu0ml/JFjsnuG98Us7U6UENEzWfWMjVCaNqnkvpDvBl3ViwXPgLCAryVlCfHK/owwcWjqsRLeKfuzo0WLj7Le6Nd3yxA2KRo8I0JkHNYjwTMgLOArBc+IZZCbkYacskQQjBCT3Iye59J6ut7YOn3QKBixLxS7Qbf1GJey9kFYwNcJnhHOq1frk3aSoaXBw0AhJrmbiMptWfF6t07oI7BJ3ZLgGUFX7uuFwTOHf0FYwJcJnuFksnA54174u2ZjHiLz4nCAs5SsXsb8T1V8ohoUcs+lLC5erabe+MAfPgPCAhjspHYpa7Kg9ea3fy6cgqRlWfCJ6jg7n9dXD4QFsK/VsOOYrhIBf6+u6SqRJ2rBJ6rj7Jyuqx4IC/hSmP1dCUQvxd3FSiDC3K6/rwTX66oHwgIwDsy68i6nRDsWsFLju7xOPvf0QQbNr7oeCAtAg6EjOxZz6WhQju8KMDpzSx9nifbf8SrrgbAAhnFgNvUrkUMqdTN7HTm547vkkOWf7ujj5+/FOuuBsACMA7NpanhTLupcSe9EbqdwJoUT+Xs99UBYwJfZCdK9mlune2gWHZObbeZEyhrPsurdu3Ge3zMy7F6OQF1FvYsDPwcPhAV8Jaf7W1HwTLX256TWHlPD7fcSPuXVu7EuLZ3dsMSw+6v7VdUbH4bRnSAsgH0h9xVxSJmOAzOYdS/NotTUaSkLK52AnFFvbnef9uNaHlqk9JERqC7ryTE6ICxg80HNog+TcuPA9GfdxxUrqjK93trjq9hhM+o9Xzmxm8cUK6oyWTS903r/SLo7CAtgm/5M8DFrnqA9KYuIV6mUPjkCNS/TuFxMQ1E9W13JRK5KhZj+JEshB/XiwyhAWMDXoqv41GZP/LFAWYQC31WZxTcPop7x+NT8karF9Wyk6p39XrK88ahyBKr1eskx0CAs4KvRVXwiYfVYdznrPpuOCMVUlrKIeKVTr7K0RMSkZZayfnbjpN57ajohCAtgX9LT/ji3k98gp3zle9qJH31eyeIwnpvWq9Y9Q/pi8lL65AhUe/XOD75hag7wZejqWbvjr7yURcSropQ+YpMqL2UR8cqgXvk8UCImFelTBi/VOsjFwbdvICyAwcyeXhyVdGWRnaVOk7O0SWWM5yrsw3koWa9k9wzpi9FJ6ZO2rOr1xocrGlUPAOyzxF4RJ+nSfF/4MFkapvQRm9TCvFtHJCCXqfdiLi39uH5hZuNRiS2rWr2/aroCYQFs041XmiNQzYNnJNkZtAoSm5Rp8IxcL5WrZ5pkLMUkg1ZBYst6Kl3v3+H+NxAWwL74o8GCEahmUpYUrwzHoxKblEnwjBTRy9czCZ6RoS6G06OJLWtcqt4km65AWMAXp6u4EqUdPCNDZN7N1Shpk9IOnpEhMmXqCcrSlpakmFRiPOrZ7wr1ksYrEBYAusr2OGgFz0jpq6QPVNqktHZ3cl9Xth6fEs2mOt0zcl+3LNfSLG1ZWrtJWS9tvAJhAQxhojk7vNep/mvLh4nKHV5x8IwMkalQ71HfciBDXSrYIcb6wTOy3vnBt28gLAB0ZaahP+qFyFQbjyptUvnBMzJExla9/FWTDHWp1hgoHVW69S4K6QqEBTCkiKZsWTnBMzJEpvp0CfHYL6dbR/bhWKg3Le6ekX0x1cejCluWVr3x4bdvICyAwXhVIuA4I3hGhshYGY8qbVJZwTNCvLIzjlVQZJblQIS6PNsIt5K2rIzgGRki81eLrjaYsN5OIgwN3lTmPVXRj2r2QDpsFcYrXVuWal8oxCtrGe1STld164g+HAf1VPs0sYuzltEu5XTV/lLU+3e4/+2LE9blVgQDIhiWeE9ltKKadbAOW+2jwSJbVmaO1sLmFBzhOUg9ABSPEq3WE3vMlL1KhLoYGq80bVmp4BlRb6JNVyAsEBboKtOW9U6DZ0SIzPuD5aFdwpYVk7IEsdivxynyOZ4cOi9tvNK0Zc2V9QqMVyshrOZeiBYIC4T1yegqZssSwTNCkLcSwJdpy5LBMzxExk09bsuSlgPeF7O8cTAWVdiypHTG6xUar1ZCWHvrvwlBWAxOBguRx2EB8aWrKc7ClhVKWUK8clbvMdY9I8SksZNpXcSWFUpZot75wbdvICwQ1ofAoBWi/ymHzvMHhl7wjNgjTscXzsA9B17wjAiRWUU9r3tG9MXcOqIrylG03oUpXYGwQFju0Iuu7IR9svHNyV3g0pYRSs9z8Pa22novL7aMV3q2LF5vfPjtGwgLhPVFCOt94pSuUnPn566mzSvTq1ZUjwyqfnY1bV6ZlqVvvAJhgbA2gbBenNNVvA3nzjl9hI8G11XPPV2FlMXrHe5/A2GBsL4OYb1NVsBYDzSjbxUEIpc8K6lHllgWZ6BqTUctucACYYGwPquG5VJxTw2YsDgDVWvAxErqyQhT14p7asCEh9EBCAuE9ZVEdycWLOUcMIeWKOUowdXUe05e3+8zl3RFpqOWs2CBsEBYTnHsmLASVnTLu8GXZbrewp2yRKajrqTeSA6HJkK/OyWLTEdlTCsM+YMSVq+o63fQ7/X6+QfoVyKsfm+gQ1j9E/G6chj0TvqmhDVUv0dxcv1yL+rnf/yaFz3sqV5Wd05YFWeg6j0fXM7kIPqKM1C1pqMu7gh3Oar35+6dsBThkidH1gYyHTVW7+7wExHWoL1TC15W22ln3BbdxvZW9JJOOkLhuLET/Xin0RmUIaxePTiD2l43j7CGnehEt2t1cvd1I2NkssJx2jDZa9S2o+toDTUJq8evrrbXSfJIVKEdfNUJX1drJPioRc8jfNE2PVS/GV7VTlPFdhkXnT7yyV7wuu06OXTb+yH/JdhqhC8efh4pi4hXwcDCR0JZLqQlIl4FnYM3ZPnjoh6xMwSdgzKE3Y2URcSrVD1D8+j6CKvf3N6S2FbcNG+dGnnFVi3OasNm7KfeEQamhNVvkKMfZxHWoBUrVBc/7PAbMnHYneiExB16vBe/jqEGYZ3Uc66db7ZqPm2Ss4t/BORqejvyUBGvDJrxi0+61DMuOnnkPjnPPfF3GP+rCTFwtMgqOQNVS7xazh8TSQ2lZ6BqTUcVstXowV09qu3zzkEZwl52BqrWdNSlqt4HaH7WIKzuduL3eTu5jCA3Gb+vyG3TS98T9Mc6hNWLncJ2V01YJ8kT3Wrymzr6yfZlnAYTPDZs5J6okrAmzdz3EMJqZ76KfALxKw3WZf1a4uLjdJl50Ykjxw9T66+BsLzbwKbFgYpXdPVGVl0Lm55OMh011jlINHGr9Qg9xjoHZQh7mRmoWtNRs+pNDz88Yc2ait/o5iybTpL3Y1vx063tnglhpW7KroqwOopC9WH8MuPrE77wijigv6M40ZN8whrsKd7TVRFWO4fXxNX0aynySX4r/jHlXXTsyIPEYWprISzzGaha4lVys0koy17XDLEWJDsHZQi7vXpU20+24pCNmz0pi4hXyc0mqXd7+LEJa6i4If0tBfmdPlG+gt/pHeVP5b/wGoSVXkTU0oSlJFZP9Rnk7An3YjvCXk15Hd08wlK/Z6v1liKswXYOaYurqSdfdMxSLLpT8K+JuOjYkVOLx9Z6CMuWlEU4SdGpSNnMTowCWUapOImwmZ169ICKZZQIYTebgaozHVXZqUjq6Voc1kNYdTXfkNcP1fdsRAOq1VfiAEWENVQcopN6TzujTiO2J6xN6Opom74k8zp62YSV9Z6tToqwFNRSmyVppZv+mBT/HEgKzb/o/CNHtLR6wtKfgZoXNlrUqfgwEWr4e/UYUDkdNatzkHQXWqhH6PEuw9h+/WRRyiLiVUanIuku1MzxWwthkdulVm/WyW+32CrJf7q3dxqtxk5cgDmWYnTnuNvcUxygiLDIXelViJ2EfE9/W0rVvWG/J58TnMSukz5F68YIoCX3YZ6poNfdSa1o0oTVIqua2JltDxKExT/Cxo6KecQLgkeIzT1C0TvRwXcUXF900Ykjb8fLt9dFWJXTGx4lGeWIYg/yH6eKQet/aB/On2qvMqTHp6sfxSHsVYPd9Y5EXvXv8IMS1kT8Ou+EzNAXjLMziZuk+Q3AjmsxlSTczwmdXvxUrgIKCIsssCI5+WQvTViNxE5HbtZql3RPSBXpBlXixc0vtKVmklda2YTRCO/xk9TVHaee3xFlv5akFe9jPYnXDo4VbJ8HcrE71Lzo2JFr3cQmlmwtt1fgw7K2L5Qzvth7voOePDCcVZCW5HTUgsh2OWi+kpRF2gbzieintEndV7A4yOmoBRHxpN744EMS1nH6yVMrcRs3UnTD5d3oJvbvkB2pWEli0CSsY4Wa1E4S1iB56xIm7dAX1KS2cRnbETbT4lojcaYpwkpRGtHgB0nC6qa0fnnF6Sd8bcU6rJ5YPxVeND2y+PdBivjDNRKWd0s/VhWvNBp+CGU9jcqGFMeMV5qh7+XrSQFfY8IEsUmVDUyW01E1IuJJvUIpax2E1Uj+g+2t5neU4hC5aYK7htiRBju1vmqHN9AjrGZiBaekyU561SAK1TP2hMcxQqileEUwLy+SIqxaWsoXfNzJpHxy9u3EJ7CT0tfoG08Sbyu+aHLkSfqfnJO1ElbeDFQtBpo/mr2hVPeMfFan2S8obVml6t08GNBH3CZVqltH9uFoRsTLerMCKWsNhDXZVrgB+G0T7qS6SdEmOOhO5zLWDqJqtBX8VEBYO8kVWeze7cUXH9QhNoip/+k9YWxHeKKq0oyTcZKweqprT7xIEFZfofaLI6VXYXI51Uvv3Bq6Fy2P3Em7z8j31kJYJYJniHilv6d8rBAEQ3ZnI3PB3LgeoUf9BZO0SRkHz5AQGf2IeFkvP3hmDYTF77bt2Hdja5Gm6v353XLJf+DzCWugWmDJm64Xf9FARXXd2J5Q3C011Y6wqbr+HTVhKa89wWLiI3xTrVwjI+tles0jF5aX6Qtq6F608sjiJe11E5ahlEXEKzM3l6Qss+4ZaTQ3i2yXuzqzerJN0WzChLRJ3a74fXnBM2sgrJZizyF/31v0i6Z+yVpi2ZZPWMeK1UeqNedYtT4StNCKXWkvsUjrxi6qo1wMXioJa0917ZdbsctTn1k7fvqqT6Cj+MeiETsBnYtWfrYfiLBMgmck7Rj3UUtblkEQjNzcmSvowkVlUu+ZlW4SFDYpg+AZGSJjHhEv6uUEz6yBsBrKHzbov/PbqhvdJmF1VXuqJGF1lczajC1IOgmxrRlb5NRUVvhBvHaSsGrKa4+LYWpWOUksfBSfgGp1y09gT/uiVUcWW8nmByAs7eAZqUWV8kRIW5amtCR3Z6Ui26UtS7PezX15+ojZpDSlLClePZfTvp6LgmfWQFh15fKpSW6boXL9w9SZLb2TANtGhCUeqeXlYfEVy/YeRS12bQN1T0rixt6hB9iJ80qSsLaV1x5fv6gJq7+l3rj1FFKhYmG2p33Rys+28aEIS2vBJMWrZdlgLWnL0gmCEbuz0pYqacvSqCdfXHrChLRJ6XTriD6cafV6GcEzayCsnVzCqqXvvAz0Og1Fm54eYbWUOlqCsJpbediJX2o/tt3rxtdSanRVhDXYyiWsZg5hDeK6dznC0rnoT0FYxVKWEK8q5T3IRVqRtCTEq0UV07q0ZRXVEzvISs3M0iZVtKcUIpSGc0KnnjJ4Zg2EtZ1LWNtU5enmRcOo23P0CKupQ1j13Hu3Fl+rdehX0Y6wl09YHRVh9fIJq65DWO0KhKVz0Z+EsPKJSPThLOePVTt6lhpBMCIl4b1qXIywZeXWE7Od51V7bIRNKrdb56d81ZmtegqLwxoIayuXsLaoGJNNWJ2sW0qPsBrVCWsrzhJ1+pZGXgN3wsSfIKyTfMLaWy9hbX0qwsrpsXmYvlvsmhaUlRkEI0JkrAS1C+U+u96dLfqI2aQy12oiRGZ5Y7NeOnhmDYRVK9wSFq+wMvnK5gqrkXvrbifCGd6Izb2bEJUMCKufT1gN11tCnYv+PISVZVUQz/ds5ZWKh43qZ39id/Y8sjxBIqMe31aNLOWHCpuUWsoS4tXYdr1k8MyH07B2dDQsmRKwXY8CeM1E97aJhrVzokSCO08kH/BEP3G8tvIAyqeElxY0rK4FDSvvoj8TYak4SbCLzWH34qBpThLsMrWY0C5sWYp6U8v0EVOo0sEzIkTm1kW9uMVhjU8JG0rCqus8JRRie2tQztZg9JRwJ/85JTE2tBJXtq3x8MDBU8JjC08Jd0wnEn1YwkoGzzzw/ZvlYffClpUIghEpCS9jN2MFk/WeljxCxvIgiXullCXEq3tH9WLBMx/GhxWjsZrKh55eYNEQzpI+rJ6GD2tb62J3JK10kyfVNiAs9Xu2TXxYvQqEpXPRn4ywYispQStvDubtTBYp14KwFsxvrY/sErasWL1FYYRM+cCY55RrQfgQnq/d1SPBM2sgrI7ybouZwusZ4x1yKM+MsHpbuZbOXnzFkt8U1BF9doNkxnsj/zqUhKV8z0Dtwd9WLxuHFQhL56I/HWHJfeE0oo93R+PBJongGR4i83r7x+mseb5646uuZzcTBgU98eAZHiIzdVyPB88croGwRCftRLWE6KfvIb7jEc3P9XSWgyFhqSIR0h3UOxl33EC5E+vy1UkjtZDbyTlAkrC6qmtPdFEf5zb87bAKhKVz0Z+QsMLgGa4zLSdO6Cr2wNAPguEhMov7mwtHELasoN6zBSOUpk3KfxrIQ2RWUc+Xsg4u2DriZVQddvFbW/T69uMqVy0cTrij2DWZPSWUD8NOspvxsiZwdWt91dU2+UG7qZjA7fhJDHea2YQl3tPP7OVTt0J2E36RkoSlcdGfkrC8Vc9MK6DPGmXd31syXmnasu7vLToZNGxS19errXd46t/nayCsthihkI4xb6tsR+FNui0G9CmeM/YMCUtsn3Zk4JwMoeslDtpO6F+1geJYtWjZRqd+1dOXGubxtbOHUNTT155c+h0rBkPIATbHlQhL46I/KWEZN0ZXN7/bMl7pNlTbMkLppletvp5bwqq1kuhRmUQM3pRBvf0EnzRSU7968t7YUQQ9HSdvFzVhSRN6jd9PMolYvKemMLm2EjQnr+ckvcvsKsZvhXHC3YxwvPRKiWYUpyKSd3qplGi+TyxJWBoXrUlYOx+RsF6d01U8A+LZOV3FMxnGv76vADK9atX13BJWRv9cWw5P9QmqL4cXt1Ojg3d6w9hb6vQLxaxSz5YVj3Zptvh3sgb31Du9Qa+zpxhCcUJS0fvRWHjF2nEvY/xMrEy7Fw2gT9zGx5Tch7HD1Y597um1UiM26BAK7+yHvfZeeuRpWcIqvmhNwqrHRtUff03CelwNYT2KLKmzVRDI2Whd9dZCWHQq3vbOtmo4Hu1qqe3U4lwi79daq3ty0vXbCpvJcVQN5YAqxRIrMUsmdiPSVuDtHXoerSzffXwOdH87fiHyS65RxU6kn3xPjX48zVRKjGI6zfagImEVX7QmYbW2skZHfyBXlpNnhWR4NHu/++Oarv7cvct6CzfP6+LP7hZrq7cewsqYK0i16WbebDzFmHryvUbCDa+2FSh6UPqpGzFzRGBscnx/K7tWZhNRM+WCFTvirDGxw9Rcwm5Ww08Vwiq8aE3Civ8tfxTCcuPAilkb3hKLulu3fCUTl0tmGpdOQF5DvfUQVqSg5wxjZ0NlF240L72nuE3bScrYySesYSqbpjFM34gZQ5hrPbXzPjW3PrnOUJzScYqw1O8hNaVxNHUR9cvKhFV40ZqEFb+Mj0NYbveFj6/petOxO7oiA+0Zc9Aik51kvJZ6ayIs1RprOy7OzhRLoMYsYzixd5te7iS44DifsLy5O8lR7ArCSr2KzPRTLqPiO8Ks9VKtq6a7fvZ7yFAzQlj9BLfsXbLqhFV00bqEFVuqrZ+wXl/1gmcq0dWLsl7p8Vz648I8WiTU5erRnRzf5ent49XWO79YI2Gl/xWvpR7ndRMvqUnj1lt8DdJ4o66ERvZ41RzG2hsyFWEplno7qcde/VxuPE4tWFrD2Hk0U4SVuvat+oCpCCt9ETYIq+CidQmLDZsfh7D82IbpG9MY7lxleHRmvYULKUsmLoerOLLamruQlmQCctipeHW3unr+ZIrD2/URlnfzkAi+7Yby2XdnR0lXwT0rbyn+3n4jOf253Qgl46zWmGM5cro7YWrC8o7bIuxRa5685XRjb6kehl126+RS653U0PaeN5B+O94Pc9ndo0V7yhkavs3hsiPOrn5S1ECjS1j5F61NWF5B78o+AmFFgckPhELebFMWmb8j68lvza3vC+U8nFRrjmamsWE38hNLDLv/EfuWw3o8ZcZRa44mBsedVmOv0eocD7Je0m83G/V6o91JE9qg67+53e1XOYWed5B6s1NkFTrptpv1erPd7ZWs0+8WXqriPX5R1bUnmp+P2w3vZaXPzdlFf0SZ/XGydCRlEfFK1WxtPJ5Lf1yYstnaurRExKRn2vz87L7eX9fNz4BbqNMagKzY0ce4zLR04Hon7vZkPUmRFl3vxN2e2G2SfeLy9097DTKi3ku8c/Dn9QszHwdmUG966DxeBgBhfRQoOgeJMv4+ebRjZXjPqzcTP13YSW0QITLKxmo5p6La/AmlmKSIiP/5e25ZyiL1ErPrQVggrI1eXanXUGT7tphW5yu57cuqJ9dfNmL8pFKVsWYbPS1tSktSTMpodBYNytbrJUeqgrBAWBuMzIE4VA2vKmUR9ssewPMoBfKq7YWycTDnULJZp3K7n2zky4mI/zVyUe/8YDVDKAAQFvvg/tCH6asVVxaRxPKZT/LaskrezI0Ur/L9qNLjsKgiZf2Ui6d8JpI8Y6ve+cGq5hICICzGPoDxSi+E3aOQst06D9Oldj2yc1yUn/y80LfPS8qqMIn5hRqvCnZyd5WlM1JvdLC6yc8ACGvNWOhQENHK30pJWXKVpldPbkRnpaQsnrisK4VJsavchAg+B0IzIp7YsqrWu1VPqgdhgbA2c3X1YBjCXkbKkps8/XpylWUePCN1Ke2IeGLLMg+CkaEu2hHxxJZVpd7fDLoCYYGw2MYbr3QNVIbBMzJExqyesGUZBs/IEBmjNp8/d6/lLAcy1OXFJLJd2rIWZevFjFcgLBAW+2rGK13KMujWkSEyJeq9lwieEUsl44kW0pZlEAQjQ13mphK6tGWVqpcwXoGwQFhf0HilS1m6+0KxG6xYTzd4RujnpczyYk6FdveM6IspNWFC2rLM653n0RUI63Oitxeijo+CaRqvtOUoHYuDtMqXrjc3CZ6RITJlPVyyk0eHgGSoy6ikp0rasm6M6p0ffPsGwgIYjFf6a6aXB10Vykq9QkVKNgdWCQIUdtNCKUv2xVSxgApblkG9QroCYQHs6xivdB/g5T7zk9aEivWkLSs/eEaEyFTNLRXbyvzuGWFNuKvYZCNsWZr1RsV0BcIC2FcyXunasrKXTnJhZKGe4L7s4BkRImO1BzFbWhJi0lP1pHZpy9Kod3v47RsIC4DxyoyyNJuYbdXjq6ysJmYuPb3aSnmYFzQxLw2NV5q2rGVBvb96dAXCAthXM15pPsB7T1OSWIHZrMcFMUW3jujDsZivLJykCmlJiElGxitNW1ZevTzjFQgLYF/ceKVJWUmNiq+GrNd7V2/6+AbO2Hilact6vlKLSXN7sX8xW9ZTRr184xUIC4DxSpOyqJTFxSuX9ahpgT/Vs5hSmrJlUWmJP9Vb/LY+AEfYssaqeucGdPXpCGvY9oPRBwa55H4qeRe3NYPxqoznQATPiBAZR/XmieAZESLz7GQ+GNfGRIayCHUZORkxyG1Zi1S984Nv3zaXsKJJXjXtqQjtvDFfAPvKxitNyvKlLBEi475eIGUJ8crdBFb+9DEIghGhLmNnE1H5gipez5SuPhth8clXtUvN9RWfR9XBvc1gvCr3AO91ykNknNYTEtlszENkXA6MlhLZ0xUPdbm7+u4Q3JZ1L+qNjOnqkxHWQAzKO9F7g5jjuYe7m8F4VX6yxGrqkdhmS8YrPY+DNeOVdlqWgfHqMxNWTzWPNQ9i2Cq6hGG8qmLLWlU9mZZlyXilnZb1fO2YrhJpWX9L0dVHJqxuK0DXMmENwsO2+rjnPzUmf1eC2YrrCYa8u1gJRKjx9feV4JrXK8lXH5iwotHndctbwp7ZEYAvKWClQthXX8/5jtCXsSbM4aT53NnzJXeEn4uwbIjuICyGR4TG47vWUs+No4HYsZ7i9cZnbunqbByvZ2bA+pSEZcHWAMJiG+QZdagrPcjZp+uqx+xa3LNCa5iV8VwG47vEvwCn+xtOWBaMoyAsSO9GCcgrqjdV1nMnvd++qOpNXUnvP66nqnr/DjecsJi1J40gLOwL9XZnr4/xr1zXm47HU9dS1miaVe/ejdP9nohXv0SkjL8P3Rinex2EBejgxX5vH1l9vIZO97dV1QsJaky+8zRy1ZjjY5Kqd2O/l/CGEOJVfP6gqZT1cQlrxw1hHYOwNk7KerG6T5MJyJ6qw8foUBOp5XpyXJjXqci3gNTUaTFcJilevdwqTKRzu/tCmYBM3F7EkfWx0hr6J70Cx9Ow3zvpZa+E6m4WbiCsjZKyJg9O7OZUsSImUqv1iFgWU6yIqdNoHFihlWGepsdkvWd7pnc5viuhkFFVy8BF6pCweq2dWuRCqGf5NHtN/pKdZl++0cM2dzCEPs/jUEJvSTcpd4C2k8ckr5m1qE207f2BGyO2GuEPhkP+EqY2rrZAB19JyiJi0nuSlR7JczwH9VKxV3KeYF6Gcmnxap4U9Gm9W0tSFpGr5slUwJ9k6aXdVuiMsDq1rRjqilXUyQ59xTanrM5WGs2Qi8iy640X6Kv3fD6RXfK3B8VriuMOxHePEycXfX8HZPB1YrEe5e5MmdJHKMtOPXm894ebvHmCdmKxbqR4tVA9f6T1bMRiiQTkjJgtOb+QvWtKWY4Ia7CXoobtZDvNoJF6TdeAsISNva18uhhwlA5htbeUETQ99dGBD4v3qrnFIkSG5GDlUUzVeo+TYjoi+nhlKUuE1mTQY1jPnpRFxKtllpJ/diOub6KVk+yGsE5U3JDIeBnsZL1Ek7C4jT2+BnqjKyMdwuLMVJvEN5bq9RvANjW/QT4JXOZt+Ogmrko9KpbledpHUgOaj62MzGHLJ7161bp1SB9OXszWL+l/vztcE2H1ttSgu66BktOCBY0mYan3hCd0ZaRDWPxxZGJPiB3h15KyCA8VHcTgpVoHKYq9Ijap8lIW4aGilh9Sr7yURcSrooOQl14crIOwLmsZhFUbKoIUEuhpE5Z6T9ikFKVFWMo9IXaEn9Xi8FixL0aDg4gtq2Q9IpbpOEPJ4ujhptzgiSUzGMcq65Xs1iF9OPcayzRpy1oUWRy23AUZ+zJ6p9ttEWqSj9y68ps7jVZDSl51fcJS7gljKyMtwupzOn3DjnAjRn49VLAWvOrt8ogtq1S9ZeajusKsvYV5tw5xLGga50m9F3MpSyQga8dsEVvW9HD1W8J+uMviPX/9nXQslSCPeviiXj3GLXLdU1cJS/WYXLU1yFoZXSYO6mE77cPaUVizdrAjZF8leEbuzhb65BPL9isrlhm0CpqTjmK9NC9Vz1TKkuKVQWsisWXlBs9sOXtIuH2cpgRBHN20EF+P2x80CEts/zqpeIaokB5htWOruBjvIQt+46Us0hdjtlZ6NNpGqujRLIyB2KRMgmekeGW4NiP1TIJnZIjM3GwcK7Fl5Vgctpy1Lh+rVPhugsHICmbor5cavSSL5BHWSTqxPb4y0iMsxZ6wnV67AZsYPCP7cN7Nt3aSsrTrSbHs3VyNkjapd12uu7l/Z6XHscp62lKWFK9KzDeUtqzs4BlnxtET1TM3vmLpq5JDWzWaG6NDWHxPuD1Ick/bhLBELuBJkvcwu2Kzg2ektaDkNGdJWZr13qr5QKUtS283KfZ1letp7e7kvm5ZroVa2rKygme2VtrJzImkq5oNMVBF7+USltgTCk9qJ05QmoTVSe4J+9gRfoV9odidLV8s2BMM6lUIE5U7vGIpS/oTbNQrDp6RITLl5xtKW5Y6eGZrpeFWnBKaW4WathZhnSRftBc/riZhDbYT/NlOrtwAtnHBM9JaUK0xUNJQUT0TZ4EODeUHz4yebNfLXzXJEJlqjYjSlqWSstZDWPXiKAYtwhJ7wmGcedpmhJXaEzqKtgE+TvDMgyW6im/0dOpVj+QTj/1yunVkiMzUXr2cbh3Zh3NfeZqFsGUpgmfcEtbAi44JsBcnrJ30c7lShJXcE3YT/KRLWIk9IXaEmx48I51XVmIXpC2rsN7cRuixtEllBc+MX5OJV3bqZQTPyBAZK/MNpS0rFTzjjLAG3eZOlv9TaPCVCesk7lJvJHaauoSV2BNiR7jhUpbYxb3aymiXtqz8erYy2qVNStWtI0JkHNRT7ffELs5aJryU7xPBM44Ia9jeVjbeNOOsUZmw+J6wFjtu25SwxB61hx3h5gfPPM7MfaIGDwwV9ZalnQUaNqnUA0DxaM9qVKmsl/QriBAZQ+OVpi0rHjzjhrB6Wd2EEUNt2SKseOtgL9lPo01YXXpCfbPx0gD7TMEzItRlObE8AUcQk7re+4PloV3CJhUjJiFeuas3jyeHzksbrzRtWTR4xglhnWxv5ROWtS1hPJyhnXz2qE1YQ+qz4IrWELc627TgGeG8Wr44GH8jHgQq6j04GIsq1lIyeIYnIC+fXNaT3Tq8D2d542AMq7BlyeAZJ83Pkq/2Gs0gZ3jHFWHxPeEeedjXNicssSfsu5vXA6xfyhJi0tzRFGepVsXruZriLGxSoZQlxCvn9UIpS4hXYyfTwYgtKwye2T93QVhNkZvey7A17KhTPksQFi/mGxuG28mEBX3C6spt4OU2doSbGTwjnFcuh85zjqL1puMLZ+A2KS94RiQgr6Ke160j+nBuHdEV5UQveGb/9JVtOVxgNTN9WA1LPiyyJzwWae7EjapPWJzsGuKI29gRbhplLculK5S1ZfF6Lw7pg9qk3t5WW+/lxZbxSs+W9fjoy9/2fy/4YmV7lklYHVVrTjnC4nvCplhstcsQFj/DmijSwB2+mQq8q2nzyrQsS8Yr7fSq1dd7djXdXpmW5YKw2ukMhSRh8cd5228xv7lp8zPdE+6IjWa/FGF1hYi1gx3hBuPFOV2FvnZe7845fYSPBtdVzz1dhZTlkLCaClZJON1nNYVzoEsmfRkQFt8T9vvp/kQDwuLKVSd6YLh9iZubfdUUB4vTUW3OQNVIZVh5PYszV7WmsTokrB1FvEwzwTy1QSJYWVCWNmHxY3e76RR2A8Lii8BGFzvCDaesR9d8RQZMWJyBqjUddQ31XCruqSkVLjUssjdrJ52iItFvp5+c+pVIoCkmrIggG410CruCsHayCOuYT6lWz1UFGGbrmCaROrRgKUcXrqne7zOXdEWmsbohLElGA5Yc5bzTanViotZW7Th4VbeWmKzTi4+qH2YT1knMmhpLrFEQVj02qp7Q0iTmdsWOEGOiq05HlVi4U5ZkKsMa683dKVlkGqsrwmJk+Hzn+OS46XFRQ/bq1FJjCWs7te3UtNVJarpNFmG91ZKDDfMIq6Vy3sc5FDtCzNaxMB11OSNLrbkjq8F4TliKcMkK6s2vCZc8ObI2kGmsXj1HhNVUTBtsJAiLzvmKjS6cKPkjj7Di9foFhNXbziKsk6yZrwDbyG4dp+JVsIiju0MX0hIRk4LOQTI3wonXndQLOgdlCLsbKYuIV2G9m6ULwhqmWp/rZBh0Lalrxfiql4p8KSask6wdoYqw4kusZsZKbXuCO3rjYXtfSKajij0noayl/WbkZUq2Gj3J7z05rMc7B2UIe9mZq1rTWBmXyX65aX5O0lCfLINqLKVsbaVUr9TP8wiLMk27kLBidNrMWKlhR8jgIS09HTWm6pNV18Kmp/PPrXo1NXp0I2XRerRzUIawl5m5qjWNldZzEy/T3U7R0HAv5W7v7amzHATv1fQIizJNv5Cw2LCZUZHw7AnuZoaZq+Wmo6YeQhLKstc1I6ejpjoHZQi7m3rJzR/ZuNmTsoh4FavnKMCv1xCUtcPNoVGmH23H6ZIx9tutdMBnu7FT0yCsk4wdoZqwvNc36zUVRQqCjE2tBxgsDvrilcKZ+kDYzI60JGfZKDmJUJb1eqrOQRHCbjZzVWcaa7Keu0z3k3ajXm91eqwoSblR32u0OscfoNe4qREsCLAvOnNVZzpq1jhW0l34Xj12VE5HzewclAsiu/UyOgdJt58FKYuIV6l6W/iNZUnvKHaE6NYpNTQnb9i9DH2vGrT+h/bh/NF6laU497zIdhnCXjXYPf9IICyWfoCIHeFX2xdObewGC+yo5IHhrIK0NBYhKAUR8cTiWSUfS67VCiLbf0pb1n0Fi4OcxqqsB8LK6XgEIGXphiLruOcJZZUNMJbTUTUi24ktq3o9jch2YssqG5gsp7Fm1ANhKXqKevgsMHNVL0VmadbsIymrlOVALpo0+wWlLatqPT0GkrasUt06sg8nsx4Ii6VatGv4KDBz1TBE5tF8B2kuLZFQF+0Fk7RlvY7L19OPbJe2LOPgGRIik10PhOWjueejpjSfAtgXFlFPyfeZdevIvhgzSUp6HMrWM+u6kbYsF+8DYTGSOYOBzwzdOqYhMsYPGeVjRYMgGBnqYm4GFZRVqp55ZLuwZRkEz8gQmfx6IKwUYbXweTDMXNUNkXkvE/sgbVma0pIUk8pFtotHfcb1nstpUc9mUpYUr4rqgbCShAUFi2HmqnaITNmUGmnL0gmCEaEupS1c0kz1YlKvtKVKmql0unVEH05xPRBWgrB2+vg4IGXpiVCVcgDlnrJIWhJi0qKKaZ0smnTrFRivCuzqYtFUJGUJ8UqnHggrRljbTUwjBHLH2IsQmcqxpYKycoNnRKjLe9V4GmHLyg2eEfUWVZOPhS0rt1vnp3yVTj0QFuNPCeuNVhd6OxDc0ln7QhEiYyVlWVBWZvCMCHWxEtQubFnZQTei3o2FLmZhy8oMnhEhMrr1QFgAwHSDZ8TzPVtzLB7zpSUhltvKDxW2rIJ6Y0v5ocKWpZayhHilXQ+EBQCaUpZgF5tjd8RB05wkQl2mFhPahcdhml3PZtyxUKjSwTMiRMagHggLALSCZ0SIjOVZrMKWlQiCEaEuL5YHSnDKSkhZot695YES3JaVkLKEeGVUD4QFABrBM5JW7M/bEbYs4loQPoT5rf2RXXznR1xZot6z/ZFdwpZFXAvC92BYD4QFAMXBM2Lj5mg82CQRPMNDZF5vnUwYFPTEV2+cwqZuJgwKeuLBMzxExrgeCAsAiqQsHiLjcgAr33D6QTA81GVxd3PhCH+4x+GZ1KtkvNK0Zd2cyRCZEvVAWACQj9nMOV3FKOv+3pLxqmhq13u83sL1yPmIIoOBqGXrgbAAgK13vL0i4M+S8Uq3wdmW8Uo3Lat8PRAWAKxsuo5+9Myzc7qKT8MZ//q+Asi0rLL1QFgAsIYx0VlrrHUR1uhsFYR1NqpaD4QFAM4ylMsmLvsK1t0f13QlVKxAUXLzfDD+rHBRuR4ICwCYmwzl0onLVsZz6cc3lM00Lp2AXKEeCAsAPoKQRYZHM+agJSfV5fySrnfrUMgiA+2r1ANhAYA+XhxR1iOhj6kcNF96PFfxA0J1PVePCuX4Lk9vH1eoB8ICABMpa+KAsh4ny9iqSs6NKDeeq9joLneDL/F6cxdSlkxAZuzO6xy8uitdD4QFAMxyhrJp93OcPuLzlrUylMsOcxadiuRbT1e2+UqEyPgH/xHqWU8l64GwAGCtUhYRr1TNz8bjufStDMrmZ+tSFhGvnmnz83OpeiAsAFij65242xO7P/IUz6Lr/Ua62xMR8bSevSYdOb7Lix2Nx8tcv5SoB8ICAFZiHNiD1WAZ5YQJEcKel2lcVrxSkCCpZ0nKIuLVPB3s/vP33LgeCAsAmLUMZTOIxOWsNRTp9rMR40eUqmlRPRtSllSqMhqdRUO0dj0QFgCsR8oi4lV2Iw5RnKp265BDZbMfeVHV9kLZOMhGmYf6NTKrB8ICABfjwIqdV0s9f6j0HCyr5M2IBOSiEFNZL3c8V2EAllw85TOR5DWdeiAsALA/DqzYyrDUt7MTCqk++VkjxFTWeyk/+fmFGq8Kdo53+vVAWACw8n2h3A3qSVNSfConZcn36xlR5evLTaTgcyeE8aqozfBJtx4ICwDYaoNnZIiMdmQ7WSGZS1mjJ2Y67J7UMw+CkSEy2hMmiC0rvx4ICwBWGjwjQ2SM2m6kTcoweEa+cWnSmSjfZhgEI0NkXkwi26UtK7feyglr2Oupvhx8kCHxKzqPy/7lpzzv1N/fit7KNiZ4RobIaK920jYpk+AZsVRaPo7K1jMIgpEhMnNTyV7asnLqOSCsfi+E+hY63W0ovuzv7vY/wm/eqs6jtdv6lOfNWG+3Xvatib/6LyllCfGqlHld2qR0g2dG0yr9PbKebveM6MMpNWFC2rIy6zkgrPZuhPqRNmH1dnct/+vb681MdIjoH3/756FGc7dJy1qgkcLzHvT6H5mwzP6+2OcMnpEhMmU9VdImpbO9Mye47Ho6QTAyRGZU0sMlbVkZ9ZwQVr3po76729ElLGZ9t9DYHZrsVvhZrWjXMjwaxspa4OeiVxyp/jY+DmGZ/X19yuAZGSJTJZhPeA4KFTCpQr3YqFfYPSP7cKpYToUtS13PCWG1xT/7fV3Cso6ShLViQW+FZUFYbK3BMzJEpmqOqKSQfMPpnNkZdi/q5XfPCGvCXcWmHmHLUtVzSVjeL2FnbYRVN7oBBushrAEIq9zf1+eTsoR4ZbUnMFuYEuKVjWH3ol62lCXEq6fqyfDSlpWu55Sw2r60POh0ozum049+a4fdVqs7o7/Ek05nEu2VOs32UTze+tT7Vpf/Oh+1xc/9N/mH6nB5v9/xvjjxiaDT8fajQeFep+dJRd1+8jzocXud1m690zki55Fbh39zduRdh7jPBh35Er/G5an3s7531H6nGZT0/ssv2z8rUtZ7c7fl1Uvfs4kywfkNjrqqUyTnnf7ojjqN3Uan04t9TGk28n/SY+IUex1ysIH3xWmcsPzXnLZbXe+qX2nhof8F/2TEZyG2/53uZfwDI39fmxk8I0JkXm2lLrzmavciRMZSYKmsl9XEvDQ0XmnaslL13BNWn/+GN3dPQ4bq1X1JvjEghDXcDf+B7Td25c+iX/5mqOAH99GA/tx7Uz84VL1P1f7m0N+MBvC+2dnt9Lw3HSXPgx63E71RnkduHca/GbxoL7rBu8E79o6iteVpd293d+Bf31Hwgw4L/9sIjt/xlzuyLDvaC3/YT28aY2W8Lwfe2xqKU6Tn3RwkP7rwT7vd2MeUrNUKfxL+9Xmn2CVfRtfXjBGW95pOdNVt8trTPfJXFvssgr/jvd2jxAdG/r7YBgbPiBAZi3nHQqBSdOuIEBlj54RGPYW0JMQrI+OVpi0rUc8pYTX92zJNWPX20Wm3vlsfpghrsLfb9H7mLQakF9j7otvrNnf3vJt5UI++qA/CNzXDQzXCPU/9ZNg/anh3JfkXu7Pb2t1rNHvJ86DH7XXa0VKHn0deHcEkzdaR/5rw+VzHY6bB4Kge3owNr2q90QxWFY3O0ZF3O3fr4X87grBkWe8e7vaHp63w2WGCsGgZ70v/wG3FKUbn3ekNe+3dxmXiEr2Fa7TCIh9TAp3d5ulQXIL3VaN7euSR2En46e7659Foxgmr4b/Gq9CNXtsL/xa9q+m1wrOIfRbhOXaTH9jmrLCYIniGh8hYpI+YTSq5yeQbuKXdCRaiXlJa4hu4+W9rdBWzZcXquRfdU4QVLnAuQ4ErTljt8Ha+bNR7UnppBpudjv9PcXO3/RqWaIZvOiImpHb41WXwa38ZLTm8+2LvNLIqxc4jdlzvVBuMnEduHcEknehyG6G0cxm+Zm8Q3KTRauw0ek87uuxueBad8M287FH0kXWHCsKiZYZiZZQ6xfC8u9GLO6lL7IgDkY8pviEMD30UnlQnuqLQMjbcCw89a8UJqx5xUnDV/kn5h27xZWZE3uKz8A48bITXmvjAxN8X2zRX1uOr9dTQlGuBmiSEEeHRXT36FJA/1Vv8tj5wR9iySD2HtoZGuENIr7CoehsjrNe9vdAAPpwRx1LIXZdDX6PeC3+rL/d8GvD3R3zTIbd6IQhhtZmKsOhxk4SVX0cwSbTvCl7T5guWkDOie1VerkdcrxHpzdKE1c0UxBNlxJfpUwzOuz7jn+0seYmcsGIfU0bJS/LBhVdwFP9rE4TFt49N/q9LbMXWYcnPwvt3qhX9lsQ+sM0iLBk8I0Jk3Iye5+wkgmdu7pcucuCT9UQQjAiRGTkZaShsWbzeD5fG0d32LIewwnsvRlh9xWOkvd1L8qCrIWhM7t/8RUCozRAJiBBWR0lY9LhJwsqvw+hajN+QjV0hZbUotfHL9RYSwX9nIeOkVlh7vUz2oGXEl8pTFHzxGqzr4pcoV1iNAgdp7BSjz60jl8319DG7UeFe7C+wG76HfhYzzzE7iy4n9oFtGGFFwTMiRMbdRFTuOQikLKGNu68XBMGIEJmxswmsfAEX1Xt2QlhN2puTRVje/dRLENZRWsPhN3rsvvCpo0Pu3vBfa08c2W34D7J0CCt23CRh5ddJMkmwRNjzSkfryqaKsAa83p6KsF49iaruaVWXOYQVlBFfKk+xG61tm4HilbhE/kHEPqY4vGd57eDNccLak5v1DMI6EoQV/rB/1Gn5zuEUYbWEhp/4wDaOsPx94eOr+wHOhELGXLx6WUm9+yseInN39d0huC0rrOdUdDclrG6asHr0ruuIn7dVRDLoBM/IWhMNwurlEVZBnRSTdPwlTXT/NZttc8Jik25zL/F0VFVGfqk8xY4grKb3lKGnJqzYxxT/rOt8aZwmrJYBYc1aYomdICzvO3vhV8kPbAMJi7FV0Eciqt2CT9S0ngXjlXZa1loJK9i2FK2wBvRZN11WdJVE4jmu6sFNVERYg/gz9OwVVldvhVWPm/pNCStcljTSW2KdFVZXnncr66MjHwT9mGLrq7r3lHCg2BKarrC63kPD3lC1JQzMHcFjzeQHtrGE9eqcPkzzRO3We752TFeJtCz3hDWI5OYkYQ0CbTdGWD2FhsVV5vjNEtwESiKJDpImrMR50OMmCUunDhWXAp/TSVXCCoT1YY6G1SNfKk8xcbj4JXbiDJX+rL0V2aVSw9pjhAs1CIs/q1RoWMFPW+HfwsmXIKy7i5Xgbl31rr+vBNerI6xZZFR6rUeEFT3JCtcIMcKa1CMldtCdMbqA8A/TGbIZ/7l3E81SRDKM3hvcNGnCSpwHPW6SsPLrSEcnT3a5JCue09MShPXa4+TTVxhHSRlxKspTFN8MLyp+ifyDiH1MTNE5M1QRVj+0zQU2riLC4o8F20rCGoS+0cQHtrlbQvc7wvgebdX1nq7c0xXZE7onLO++aQaPyfciwtrrvIbe7qOUD6vr2eBZ4NU5Iqr7kThqN1R5BoGekyCSQWPvSBLhJEVYifOIHTfpw8qrI5mkNQyFH/8AQ+8//peeJX5gTlhhHf+cLn23f6OXWUbc18pT7Ebu8nADF7/EqGT8YzqtS8N7P/Dmei6qPQVheVcUPFz0rPSFhBX9AvTqSsLyd4yD1Ac22VwNy5GjQTmZay31xmdu6epszFapYflrA89j7UmsfEvYbnTa9bAlxb+RfdE1uuE8l47/2jrVsjyXhGcHbwTSh/dUfK/VadVDD3WCSDyzdLPjm8f74W0SqrmSsOLnETtucBpNaRvIrSOY5Ch4f6TJeAKN95b2HjdLahEWL+uxt3dqnfDNnV3yASbKSMJSnuIk/PwaUQNQ7BKPfEW+l/iYmrvynwbviz3vJBpeh2OjmyKs3p7/vnZdY4XVCyq09rzFtN8jlPosmtHamn5g4u9rE/Fu1+KeOb5rXfUWdi3umePCVkRY3j/j/kOpoSCsWdDY1r7kfER6+C7DB0ydWczOI9vjJmH/XfjeJJH0mqQP0e/ca8Slm9h5xI8bmMfIU7jcOmIt1iUHYL3g2Vv91ETD4mVZv70nmu+OaI5YoowkLPUp8m8O0x+d/49BsGOkH1ObBv8NAwdd87IfLI0ShBVe396Rjq3hNHjpqc+NKsIahK752Acm/r4YpPeS8vc6601dSe8/rqfxSivJdJ/1e8NkinKWeXHYT4UrX9KXDzLDl8NX9vXP4zLnNPLrcIrwXyR/SXzv2azCZ8Tf3Nrt5ZRRnqIksvh5qy9Rfkwz3lug8fl58ag93W3bQOel1T6wT4aZE2lpTD6+6Xg8dS1lUfHq9peIlPFw78bpfh+rN14RYW0ihs5El+Fe49W0TNmz6e228Ve5IjzZ7+17ShJUTA13Wi+cH3hFCOXGfi/hTbLerzEI68MRVpu26WgT1l6ZUl6X+RB/lauCxXCZeAIyMYv+uZ2vop5wXxGHVHGGsulucJ6uh7mEH46wBp2eaRk/naVZaoHVGeBvcqVSlj3+IGJSTLGiKtPr2Em9mGJFVaZne6Z3OS4sXg+E9eFWWOZlevFsQeDjwlaIghzflY7ZkvMEndSbJ1P6fpKl0K0lKYvIY/F6IKyyIupq9GKtMsNef4a/kc8BK7FYcnwXe3+4USUkv7uqp4y9kvMEszKUTYOwMuuBsADgc0lZREzKpCNKMTbrZSnrZzdLa1IWEa/S9UBYALBizCtJS+O5lqed+NGt1cuLvfo1ttStQ/pwFPVAWADwiaQsIiYVxWwRW9azjXpF+hTRncpLWUUHAWEBwDqkrFLdMzdyp6fjDJW2rOVT1Xr3Gssmacsq2a1D+nAy6oGwAGAtUpZ594wY36Wd0kdsWdXqacZeEVvWi7mUJRKXc+qBsACAfYrgGbleMmgVJLas8vUMWgWJLctUypLiVU49EBYAsE8QPCNFdMP5hsSWVa7e3Gw8KrFlmQTPyBCZ3HogLABgHz54Roa6vJurX5KyStQrMW9Q2rK0payf5C259RwQ1tDAdD0MYwii/7A+OtsA9sW6df6Y7OtK+kBHT0uT7iBSr1xLs7Rlae0m5T6ysJ4Dwtrb1R85HkUkySxK/AYDXwzFwTMyRKaCPeFR1w1Bxavy8walLas4eEaGyBTXs09Yr2rC6isDklKE9YpfYIAheEYZ6lJtvqG0ZenWq9YYKB1V+asmGSKjU8/BCqt/NFPmkJ4WEtbsCC28AEO3jrIvpnokn6AsrXr3ladLCFtWTreO7MPRq7cy0V2HsFgqthK/y8CXDp4RYpKd8ahis5fVrSPqWZk3KG1ZGcEzMkRGt94HJix/UDB+kwH2dbt1RF+MtYx2Kac/5NWzltEu5XTVfk/sGvXrOSCso46/set3jrxguWYrnDDoT4RpdaK4uKN2s32kIiz/PSwMlmu1j1re6JUon67V4klz3sFf/feLtVevK3/ova/Z7l7ilx9gGxA8IxIXFjan4Ig9X2pfKOoZGq80bVmp4BkRImNSzwFhNfh0HH8y1G44cWo3RC+cbCdHucQJi0tZ4egcPjsmHP2yx6dBnQRDX/h0qnBKTCjzRyN36thIAp9fyhLE8v5wY3tQ10KVVCqI7LflcHZhy5rHk0rnZeq5JKxG5+jIG1/VCVZY9WiFNajvdnrDXjucp6ckLG9G6OlwcBSNMe7sNo4G/lfRwD9v0XbabQTDOP0f1junR+FwO296WOt02O/u7UG6B9gnD57hoS5WAvgybVkv6Xo3DsaiCluW7NbhfTim9RwSVjhjvRvNsePT6ZqR6SEcTqwirNle+M5w2J036u4yGo8XjlRu+V95Q+274QD1aKEWjIVuRRPuGvjNBz61lCXEJFdTnIUt6zleb+xkWhexZYVSlhCvjOu5XGExGkoeEdZgtz7jMzdnasIaRO/gc8+7jDAdH2IfjvDs8h/6tBWtyNgkIjwA+JzBMyLUZTq+cAa+yvK6dUS9W0d0RTnK69YRfTgl6jknLI9H+oSw+Ixg9hqswIoJq8GnioYLqIYY29wKRo7KR49itrJYxAHAZ8Tbm8tZqOlngrxedeOVni3r5aVCvVUTlrdDbIYIJHilhlXnL20FjT6N8PWNgOo4YR0FP6yTGcne6JjoyHUy6h0APqmc5WraPHVdkbmrz66mzSvTskrXWzVhdQRhNZu9TNG9ftTrheK5txBr8Ne3U4S1qySsZhMrLOCT4849Xfm44/Xc01VIWVXrrX6F1WKZxlH+nk7gh9g7JW+PH5wTVoMQVj9S9wGAYeaqabqfxRmoWtNRy9ZbNWH14o/wlIQ1bNU7nU53GAlSJ9mE1eR2LA+Xq5lsCgCrwXTsmq/GL7SeS8U9NWCidL1VE9aMy06zzjCLsNp7ZIB6l6v0p6dpwhI/7PZ9Bb4rvwCAT4+HkVPN/TlZz4UFS5XKUKXeqgnLF6h6+T4sVt8jXvVhfbftU1u/vjtIEdalp69fcutVb3ev+wofFsAwc1VnmPN7ut7cnZJFpqNWqrcywmr74vnEc0l5nTmNTqcRtux4XgRfS4/+w1dYYbtNvdENzfC7e61OaGZPEpb3n929dqe1G1Cc16ZTF18AANuEZ4VuxKu7d8KKcrJzxRmoWtNRX64JdxnXWxlheSuk3V2fgCZh+197GBneg11d+J/oPb161HoYtu/0gubD+qlCw/J+GPYrhhTVDd7YwI4QwMzVXDuDzMkMOhVvyHLLhZRFxKu5n/IuQ9+N661jCIWXc9UbZP+4txsmPAx6ka391Xt9b5bx6pl/tFcZEY8MLYBtdoqDLcOoj8dRIqlBkapQvfl5yZITJmTou2G9Dzg1p7k7EII7DFUAYFXKIsOcYw8iiQZvVcqi4tXolyr03ajeByQsaa5qEdcCAEDKspeGpWj9kaHvFqUsIl4lG53JRlG/3gckrE5gdO/1TpuhhgUAgB0pizivVK0/5Md2pCzCSXdXOaHv+vU+IGFFOXy+MD/ALyoA8BQHi86r6Vi9y7ydS2npp0Xx6ikj0112F2rW+5CTn/tHntH9tD/DbykASCmrWju0HOact8Mk3Tov1aQsIl49503NmRrVw6h6APgsqBA4Q4joNV/Dl4PtK0lZUrx6yY9s/ymJTaMeCAsAPg/KJpBKdWpxd1P8IPG96uhn+QxwXrzVI7aswnogLADYdClLzqnXnGghbVmLMlKWiBTVnTAhbVlF9UBYALDZUpa0MiyfRuYCvbGU9eP6RWW80l2S5dcDYQHARktZ43k5a4S0ZZlJWVK8MttPSgtEXj0QFgBssJQl+3DM87Wk8DUusVK6uyob+p5XD4QFAJ9QytIbBn3DBxCyl9tSjxbnZlKWFK+eyiSKSltWZj0QFgCwT5mh/EffyvBa1sIlDzEtlrKkp6r0RAt5iIx6ICwA2EwpS+zoKjVPS1vWfcG+8Ne9nvGqYJEmbFnKeiAsAPiseBxpWBne72+q5ju8a2QaiwTkRdWeHmnLUtQDYQEA27jgGWFlsJKmJWxZmUEwog9naSMYXtiy0vVAWADwiTEf51oZnkeWJ1aoLQfCyjC2lFcqHjYm64GwAIBtVvCMsDLYnBQmbFnpIBjhoLIZr5xxUBAWAHxuLJ9ulFaGl7GbMYYJkUpYGe4tD7DgtqxYPRAWAGxQt44Qr+a3f+wPip6numdEH86z/RFhwpZF6oGwAIBtjMWBr4Jeb/84nW3PV1NcvJq6mWgobFm83jUICwDYhnTrcGl8cX9z4QjCljXyngaejfjDvJ/fHUHYsvx6nq4FwgKAzcD9vVGETGVb1vW1UYRMZVvW9W/v/0BYAMAwxrCULcua8Uo3LQuEBQCIJK0wzmL86/sKIDMgQFgAAMIqTVijs1UQFhfLQFgAsFl4v/vjmq7+3L3Legs3zwfjzwoX2BICANvU4Bm3fCXn70SLuiunlPXj6pkUA2EBwKZhOnZHV2SgPWMOWnJyhkeDsABgM/HkSMoaPRFaJNTl6lGhCK3xML4FYQEA+1rBM9XEq0VsFUdWW3MXUhYZHh1ExHu+ehAWALCvEzxTaTc4z2wFqjgmumj+jjg4WnMA4OsEz1TaDU5VefJ/iARvV8oi4tUzmp8BgH214BlL7vbEbpPsE5f2mnTOfi+ZKiIehAUAkLIKUxoEKSkaq+WcCltSFhGv5vH0LRAWADCMidacqJrRqUjWXzakLClepRqrQVgAwNCto9WHk3Mo8qKq7YWycZCNfmFqDgBgTLRJmsxSz48qPQ6VBn3J4dFK5gNhAQDDmOhi8arYPi8p66X85OcXarwCYQEApKwS4pXe++Xry02k4HMnfClMTXkgLACAlFWgS2mv0Igtyzx4RobIZE+0AGEBAIPFIS9ExuiN0pZlGDwjQ2ReciLiQVgAgOCZnBAZ44kW0pZlEDwjQ2TmuZI9CAsAGIJnsvTzUhHx0pal260j+nCKJlqAsADgK0GHgGSITFkPl5S/dIJnZIjMqIjgQFgAAClLrUJVCQIUa7TCbh3Zh6NhOQVhAQBD8IwiRKZqbqmgrPxuHdGHc6fjhABhAQBD8EwqRMZqD2K2lCXEqyc9gR6EBQDsCwbP5Dcxl7bGZ9iyMoJnRIjMs64FAoQFAAxSVqwPx2K+shDEFFKWEK/yjFcgLAAA/FXUWL2BW9xbi/2L2bKSUhYXr+YmvdIgLABgkLKEEaGU8UrTlkWfAvIQmYVZSikICwDYl89QFiEybkbdczYUwTMiRGZkGJ4FwgIA9sWlLCFeuZvAyj0OQfCMCJExz/qzT1iz/iDjJ8Oh/3/9YfK1k8GKTgAAAJYKnuHilcuB0ZKy7q94iMxdiQga+4Q1aHXVP5i0WhPGeq1e8rWdVn8lJwAAgNPwd920LKZvvFofYc3a7ZmSsLqtikui/tFbUOCoD8ICALbKTNJStiwD49X6CCuEgrAq46gVfA6XrSMQFgCUwd3FSnDH612XjHz/yIQ16IQMpEtYQxAWAHzYHWF8T1hyHJgbwhr0euEub9i/ZEJp7/cJYU16p/1ZyC2D/iyUysXbvHf0jk6POh3/tYPe0REXufqnPf/FQZ3eafjqQd8TwfqDWf+01fVLCMLyXhGW57j03jLhxz/th3/0qvtfvIWvxy8uwJChfOHS28AxPvsohHXa8tC9DNY+fbmsarclYfXa3kvafalheW878t8WLJJm3Va702qd+sTWbYlvD9qttvc//5Bv8ttH4Z+GwX9agrC8N3ovJuu5SfDCdo/x94R/7Lb6/hedy6PwP/jFBb4o3u1a3JOG9/dkvTLjwFwQVvtoMBl0A9rIIizvRb3hsNehhOW97bLfDt5w1Dp9ZZfB949avaF3NJ9Ihu3OgL31WqF23+1f9rv+wdQrrLdu21s1eccTgn635RXoBY8kj7w/Trx394Nvd/qX/umG/znC7y3AIL27k9sppsbSuwvC6gT/7YR0oyaskCtYbIXVCV95FLz3Lfjpkf9D/49vl8HrhuHqyD9CP1StuiEVvTL+ek5Y0UquLwStaOE1PBp6fwxpqdN+5acyCZltGJ08AHxNzJxIWeOZrHD7S0TKeLj/9VFE956/o8sirOCPMVsD55PgP+GPI8LqC1tEN6XUh/yiIqxuWIFXYuxUur34H4Ozi0wVndYk9nIA+Jp4st9L+EQI6io+f1AvQ3kVhBXQRwZhRSsjBWHNou8MA17p+YdpdY56l+HS7ShAyFKX/VP+RxVhtdvhi9vBCi1gJ7I5HEhOjb7otmbhogu/sQBDt47F3aBIXCbuqx/XUoGfm+wLXRJWN5OwBgWE1fd0pX6v3fEXPYNuO9THPZWrE8LjpaEnunt/yiGsVvTiziTOUjHCOgJhAUCVcWDa48ISitWP66nkMX3T+3pWWJeRVJRFWN6r/Cd2vOtwcOorTEPqr+q0AoNCO5OwUsxzJLeE/I/BuYCwAIBpZygb7ganZCGVeCb4Uwyf0B8H5pCwAm2cmxjSGtYsd4XV7g36/aTdtN0Od3eXQrzK07CiVdRl0rE6lH8MdokgLABIwUoslpxPqI69OvstdotLzVgsJ7aGIJWh7etQff4YL0FYRyG3HGVpWOJZ3dvRkWCb8PEgO20POHn1swkrqtz3XVuD00HwAHAW/LTn/bF9KZ5ngrAAwIWURcSrZZayfnazNJOynNga2r2+t4nz2ePNc1r1+t0OJazu0cynM+/7R50MwjoK5Kru0YDNOr7mfhSw36V3TO9NAfF4/+8V6XTaR5eBw+oodEYcBYp+5yhYOXkVem2f3UKpK3iL942hL+e3T/tH7ciHBcICAGY6DqzQyiA3fHmxVzx5lOl16zjZEvo29vYp7wf0TO9kSzjxvnHpS+n+97O2hJft0LbuvS10undC25VvRm8fzYJkhsAp34vWcYGj3Xe/h8zkM9HrkX+Q7jAo0A3dDEHNYMUWnFafgbAAwIWURcSrIn2K2LKKpSw3iaOX/cEb//Ow3896Tdbbh+2j8J2Bpu4dQNjOZgNx4An5dhZ3DmaMkdDA2UD2Fg77aMIBgEIpq1S3zo0Ur+41lk3SllXYrfMhI5JPuQMB6x0AWLOUZd6tIxKXtWOviC3rJf8dH5SwwhboHoJiAIB9suAZGSJj0CpIbFm5UtaHJKxh6Pr0RCqkswMA+0zBMzJEZn5tFMZAbFk5wTMfc2qOl7xw1D06LRSpAABgHyh4RobIGM4bjNuysqUsjPkCAIBZCZ6RITLLmzLpfMSWlbWbBGEBAGAleEaGyJjPG0zbstTBMyAsAABY9eAZGSJzW5qu4rYs1SoNhAUAAKvarSP7cO6vvleEsGUpunVAWAAAsIrBM0K8KjtvMMOWlQqeAWEBAMAqdeuIPpypDbqK27IS+0sQFgAArELwjAiRMTReadqy4sEzICwAAFhpKUuIVyWMV5q2LCplgbAAAGBlg2d4iExJ45WmLUt264CwAABg5aQsIV6Nf313AmHLCqWssxEICwAAViZ4RoTI3DqiK2rL8rp1fnp7RBAWAABl8PZmy3ilZ8t68VMgQFgAAJTHsy0ng1ZaFggLAIDycE9XIWWBsAAAqL7AuloBY/24egZhAQBgAS4V99SUChAWAACVsPx95pKuzn4vGQgLAABbmLtTsn6QefYgLAAAbODJkbXh6omw4jUICwAA9lGlLCJeBZ2KXqsOCAsAAAsonIFqnNcgZlIwxmWyXyAsAACs4MWmlPXjWow3pJ2KICwAANhHk7KIeBXbbIKwAACwhrEVi8OZmJ2T7FQEYQEAwD6SlEXEq1SnIggLAACbqBjsLuPcVUcCYQEAYBf3FSwOv+6l8eon5hICAOAeZQOTz25ixisQFgAA7IN268g+nMyIeBAWAADsAwTPkBCZ7Ih4EBYAAGz93TqyDyfvfSAsAADYuoNnZIhMfkQ8CAsAALZeKUuKV0UR8SAsAADYWrt1RB9OsYULhAUAAFujlCXEK6XxCoQFAAD7KN06og9noSV4gbAAAGBrCp4RITJLTaspCAsAALYeKUuIV2NdBwQICwAAto7gGREiY2DYAmEBAMBWL2UJ8ereJPUPhAUAAFt18IwIkXk2azoEYQEAwFYcPMNDZIyzs0BYAACwlQbP8BAZHeMVCAsAgDUiGIjKdI1XICwAANaOZbmMPxAWAAArx7hkijIICwCAlWN0BsICAIBt9jgwEBYAAOvA9OoHCAsAALaRGcogLAAA2KcaBwbCAgCAfZZxYCAsAADYZxkHBsICAIB9FikLhAUAAPss48BAWAAAsM8iZYGwAABgn2Ic2Pfv3/8f2qeq3/f0kDoAAAAASUVORK5CYII=",
    insight: "iVBORw0KGgoAAAANSUhEUgAABLAAAAJ2CAMAAAB4notuAAAAwFBMVEX////19vfd4eXR1tzJ1uPH0du9yNJMw/+vu8ecq7j5cxb0cRaRo7SKmqpHuPJZm8F7jZ9vg5ZAgalRdI9kbngNbslkaXE+ZIIMbccMa8MMZroLZblLV2YwSmIbUHQfPVgYNE4SQnISMk8MXqsLVp0LTYsOQnQQQHAPP24PPWsOOmQNN18NNFoPM1QPM1EMM1gNMlQOMVELMVUOLkwMLk8LLlANLEoLLEoLKkgKK0kLKUYLKUUMKUQKKUYKKUUKKEWrTYDCAAB6YElEQVR42u1da0Miu7YUVAbOAeXhXGb2gDCOzgjq9oGDYg7y///V7WdWujvdnXQnjULVh71HBFaDUiaVWrUOGAAAxrF6vHPwuAq+fJz9tILZY6RA7EuL9a5/fHXw4zrypXnECvyYHeBXCwAsYLN8fFxu/H8/z39aw/zZr/F+f319/15dvfXvf/75vfb/Pf/11Rp+zSP1QFgAYImyArp6sUgfHoW8+HXe3qqt9xL8//7yq1Vc3gv1QFgAYHVvePPnp2X8uVltr97fq29fLePb1V9eDoQFABZxa50+PAq53Va9q+9fK8D3KxAWAFSA15sqCOTmdVv1/l5+s89X3y7/grAAoBI8z2zTx+x5m/Vuftnmq183DFtCAKgImwerFDJ72Gy53u9/bNLVP7/FeiAsALCNtT1l6c/tevv1VvaUrO9Xq0gpEBYA2MfKktVgvhJYSuCSCuqtrgQuebIjZX27fBLrgbAA4BNLWYKY9P5w/fPn9f26qnprdx/InaOWpCxBvPLq/bjegLAAoCIp69osfVyTmMRlq9kT3fZksV7YiuNQSIRSzIpXRIe/g3q/QFgAUJWUZdLT+edGvpri3X6GpSyxntiKE7bOOHgxKWV9v3qR1QNhAUBlMNc1M6ePc7xzcP5st1588yds3J6MdekI4lWkHggLAD6dlDXL5iSBsv6arneflNe/hd1+7mLISGzDj3laPRAWAFQJJ1WhtJgUpjKkdw7SgshsvZTOQaHbb/279L7wO4lXiXogLABgFXfr/CknJr0qPNMfY906wjM9p4tU36+eDbVDC+QnqQfCAoCqsSwhLc2XfC2TvXYSLJ5l8rForZZjDxUsnvclLA6/7jPrgbAAoHo8FZSWZk8R41XeVm5trp6Ca0HwIRRNIOUJo2n1QFgAwD5Jtw4tmhT7BcmWVbaeGgORLatQtw4t0lLrgbAA4JMEzwhi0kw7hJ29zovXU89AJluWdvCMECKTXg+EBQDsM1gcyFqgJ0mRx6FoPb2uG7Jl2XgcCAsA2McPnqFQF30zKKesQvXu9VdK9/rBMxQik10PhAUAH17KIjGpWGQ7P+rTrlfIo0DOBEUpi8SrvHogLABgHzx4hoe6FLZwkZnqRafec9HuQLJlKQTPUIhMfj0QFgB8bCmLi0nrMqZ1WjQp1yuVy0eLpjwpi4tXKvVAWADwkYNneKjLe9l4Gm7Lygye4fVKx8VwW1bmM6ndC4QFAJ8geIaHuhgJaue2rPSgG17PxPB5bstKDZ7hITKq9UBYAMA+avAMF8tN5YdyW1ZOPVPD57ktSx48w8Ur5XogLAD4oFIWF5OeDSa0c49DRj2TccdcoUoGz/AQGY16ICwAYB8xeIaHurwYHigRUlZMyuL17s0OlOC2rFjwDA+R0aoHwgIA9vGCZ7gPYXVjfmRXuPMTXFm8XslwmExblvDcsttAWADAPmXwTBgi83pjZcIgp6dw9RZS2LOdCYPclhUGz4QhMtr1QFgAwD5Y8EwY6rK+vf5pCX9Cj8NfoV4VA1Hd08AwRKZAPRAWAHws3N8bMl7lTe16j9Zb2x45H1CkNxC1aD0QFgCwz90YXdjjQIMGDRmvVNOyitcDYQEA249B0VkRMvNfXysApWUVrQfCAoAPiL/VEBaPzJv9qIKwfszK1gNhAcBHxPvtH9t0xVUsT1GyJ7iT8L4uXQ+EBQBsRzKUC8Y3FM00LpyAXKIeCAsAPqyQNbfHVzcvyXo3FoUsYaB9mXogLABgOzcOLP+AUKBFmkPPbB0V0vguR2+fl6gHwgIAtmPjwPKN7utITATNqbDjHRVmrLJbJ7bh8rZwPRAWALDPnqFcdJgz71QUbnoyLWVRAjJ/cslNICwAgCcry3slbX42LmUJ4pWs+VmzHggLANj+uN6vyd0ei4gXTg035pp0aHxXPHaUh41q1QNhAcAnzlAuLF5JSJCHvhuTsgTxapUkpX9+r7TrgbAAgH3aDOXC4pV8myl0F8ozjfVAStX6t/Q48MfvtWY9EBYA7IeURX04Gewn3KlseyE1DrJZ6lP9munVA2EBwC6MA8sf8vXOlKZHk8ehVN7MP7R4ymYi4jWVeiAsANh9KUs4BMwPMSXKeimal/yNFPXb3L0e2bLy64GwAGDnpSwSr9SMqHT/+0JSVjh3QtFlJdiy8uqBsACA7XbwzOyJ6Q67F1Zk+kEwFCKjPGFCsGVl1wNhAQDb5eAZ8ldtdDoT6WGaQTAUIvOi80CyZWXWA2EBANvh4Bm+VNo8znRl+rV+EAyFyKx0JXuyZWXUA2EBANvZ4BnqwyliiiBblmr3DO/DSTFe5ewl+cliaj0QFgCwHQ2eIcIpmqxFtiyVIBgKkZkV9HCRLSulHggLANhOBs+QClXGJc89DrndM9SHU8Zyym1Z8nogLABguxg8M18xM8PuOWVlWhTImnBbsqmH27Jk9UBYALCD3TpcvDIx7J7bstKlLC5eGYjTIu5L1gNhAQDbteAZHiJjKLCU27JSgmB4iMzfKyPpf9yWlagHwgKAHevW4SEyyj5RDVuWRFri4tWLuXxlbsuK1QNhAQDbqW6dcAO3MTvBgtuy4kEw4QZuZS72L2LLitQDYQHALklZXLx6nJkftbNJngKGp3qFjFeKtiyhHggLAHYneOb6fmMjBz5uy+JBMDxEZmZlpCG3ZYX1voOwAGBXpCyujdubwBp6HLwgGB4iM7c2gTVcwAX1/oKwAGBHpKxQvHqxODCaKOv+MgyRub38ahGhLcuvB8ICgJ3C6ubPT7uYR6bcG59jmDXXEIQFAGynghxs01U0LcuQ8Uo5LQuEBQA7hNuflYCHGl99rQRXICwAQIZy+T3h06V9uhL2hCAsAGB7nqFceNa9h/kPu3T1Y862pWGNjlsT/EIBgFW8m+vIyRwXxnhY33d7dPWdxoVVTViT1sHBQa17oUFwLqY6JcL/uw8cpz1jcAXLD0ee83MHc3ziAPZBpXdBbo8s6mxJ74LcXjVhLbq1Aw/1M+XHeI8YKd993Dxo+CzVcx/YkPwgvSvw7zOs17qLj/V71v/ioI/PG/BBpSxRvHqez4W94b0dp/s9Vbj55ZpIKyOsYf2A43hkg7CmHe/u7YkSYY0bHnn23kBYANvXDOWi48JCQhQJ7Np8L+G1QIie2+vXvCLC8umBoChl6RDWNGTE+kSBsEb8Sir/RXK3fbPoLnAFwgJY5RnKBQNmmGBO/XOzohuvjEpZlLgsbjmrIaxl6yCGWufiI6ywaltYYZ04pHQaXVTdgbAAG1KWwX2hIF5FFDJR1fprzvRO48KczafAhBUQ1uv5wj0fjFOWipRlW8Nqa8juY039H4QFsA+coVzYypBIBaT5herjwJTHhcUXbvYJ6/zky8nQeUVn9ThlBeRijrDolFCFsLROCcfe1Z+BsAC2CxnKRecTsveHa1kiM7c6bEyk+PHEZSHIpiLCmp+6n8EvJ+eMXYTHhOpSljZhMR3C0kHzAIQF7KeUJYhXqfQnUFppKUsQrzYJJd8uYf3rfQI99G8DI1ZUyso2FnwcwqobI6yfX0TCWp6AsAC2zXFguVaGldIGU9g0lspvELMZJDFbNgnrdXjyhXDSX2pLWQFhTXvHtVq9we856jgIvzpzv/BJre1iKiGsUbNeqx12nPUcEdbIvXPXpzf3KcZs0WvUa4dN8YLG3eahcxG1Zq3WcOCXWQz7pycO+ueC5/fOv+10uBQePgvu2A/NoOf9/on/ZjhY3gVffXG/+pkkrMeh8/AvzuP/xYcO2I6UJfBQXiqgYMsqLmUJ4pX0SQ6sildRnLifybiUpUBY4/Ahh8EOsut+0RQ3ax7xXHh3miQI66IZrudGAmGdeY4w7w4ei/amh8HdmqG2PhVWhLVhSMN9el2nIRGtaSnp7n4DvqEbv/TvaAkVYjETvxomCIv4/gSrLqCclPVUqFvnmnZ6Kk5UsmWti0lZ/1Afzr18mXZgWbwS+WroXUxEyvIade7OXzMJiyiuPilAWBe0qqtNMgirye8WPPVb1DzWY0nO+eKz0/I0eRv7N0LYJwtdworcF4wFGB8Hlt+Hs9ZMBRRsWQVGfvHRXhm9PgfWxSv+kXM+sdP//ncqSllNh12WzoqFViUSwhKFr2YBwuoKj++kE1ZHuJvgjTiotzpN7zpq3q3n0Vd1KnLLyYnAWOsYY/c1CWsYfU4wFsCq7dah9ZJGa6Jgy9INniHx6jmd7A7si1f+B/vGpav//Oc///2//4VS1uGINo6ns1TCckymZ8NeS6ASLcKa+k/S6A3PuvWDdMI6qLV7w15D4MU6X1ctvOptFpzxfemf/3t37rLL6YJIzN31+evKk8eQnE76Pxe3wUu88zWs04iG1U/TsOZ8z3nn32eGTxzAqgueIfFKcxyrYMvSCZ6hEJnMY8aDKsQrbwX1v/9z+cqlrNH/XCnLa+ObncZVniRhBfvAM+qk0SIsf53U8eXy43TCqo0E/4InuHukGqhZ3oW4Pzzv5fh/RH6e+HwVkJj/Zp/Sv/tfTu6EzeG5sHLip4T/fkk5JfT+efoq/BufN4BVFTxDITJS41We8vWuGzxDITI56tdBJeLVK/vfKKArj7IcxriY8rUDV5YXUsIKtCPWCklDj7CaRExhC6GUsNoBn3j3mIb/aom2BucA8Ma70uDGpX/B3s7uZCm4FoI7nN9I7ApqhLXyOC74o7Pw7vSIzxtgIHhGa19X0HdKtiyl4BkKkdnktVAbJ6zzpHjlHsoLdOViFDtuCyjr3ywfFpGNFmFFSG+RIbr79yBZfpQgrEXIHefpGQvvItOEEElKjbDORWJkp8miAFAM+TMLSbwyYYfID56hEJn8+YbWV1jByX90hTWSbhyTdqMIYXnbsoOhJmH5BDRKGkdTCIuMD2NBuH/jq7tAcusPzxcROumLRvY4uYj0o0ZY0V0gDKUAqyp4hkJkyo1jJVtW9qqJQmRU3FuWNSzv+O/s0HVzTv/7H0HDSm4cZbJ71OleC83mOoQ1jnjbFQiLagqie5uvtobJPWzipfhHfi4duSK7g5NihCU5ZgQAZrNbh/pwykcA8pVahoxOfTj3Sv54K6eEy+CU0BWv/BNBT2GfeJTlGhuSrge5sUFCWD1NwhoVJ6xu1NbgP+z1NHHVJynkEnuVICyAffRuHS5eGRnHSraslOAZCpFRDVm25MPy5HR3izcO7Ziuh8HZF7p6u8T10F+wj0dYr1HjaDeQwSJcMksnrHns9rKEhWNCwCBkajoXnoxlwpN8L9vv8T6cZ2WXqTWn+7nbPxdk6gWmT4cnpv+TiVenN4ypEla5LSHTISw2bYqefH5VP/sn1DSzCjWscxHOC3r094GnrseqX1DDijwnjFiA1X0hP9pbm5y6w21ZieAZHiKjk+9wUMXYCZ4yOo2KQFm7wSRhkXyuQ1gk1WuvsJxu6HrN95oedmNBOHc/z/294c80SbxPDTkFRPdh5JQQAJjl2TpcvCpgvFK0ZUWIiYtXem2HVRJWIGVFV1iezqVEWCPukOqJ1qpGjq2hLrLRVIewnCbGWlYSzWkgrw+lG7ZTQXzXJyzPzvUFnymAVdOtE4bIGAn8S7Vl8eAZHiKz0ZxdYTcPa9KMp8m4UtZS0LBk/vYYYXXFpdQhN3fW/EyFRU3FOHoYaGRnGoTl9vQ0JXvd06VIL8OQdPiOrT9M2BuG2oQVc0ec99/x6QKYreAZLl49W5oazQv4UhYXr+a6OTS2E0dHh3HKcqWs0OJ+eq6QOOr3zPjOAt+P7utSLY84OgdKrTmNKQUdKxKWu6KrjyTG2MCA8c7tnH574K2/7O0H6yqhX8c/WTwRVlucsF4zW3O8QB6f5HBGCDBL3To8ROZ5/tMaQluWswPkITIFYrOsZ7q/9WqJgTlTd53i7gbfVTLdHbbpnnXEvmV2GAhLZ+36gZSw/DVYo9Hjzc+19lm3eXCgQVj+aswL7ms0mp3emGxYp67ETiLVLLBlDc+Hfb4y8r/tZPytzk88kd7R36l3xzFnCSsp16v1yB9z6vL4YxDtN3QKncDVAFj8iL7ZnL2atGW9vOgYr6omrGgMHklZ78P+Qm1qjvjwlriz859LKrqPwzgZ9XiZBGFN4kzbGCY7j/pMZkI4px4lj6yCUAZvjbU+kSXTBGEOycfHvagAYAUrW9PtpWlZhafbH2xjjGqQLMMUx3xRgN9hkAX6RjedSQmLNYiwlk21AL+E6H4Wv2r3gdEjg9NVPHCUjj2FENK7c8GJdR4hrMWJQFhLMVBrCL4CKsOtdbryjyLDekUnVVQ0+TkejKxFWNwOdThNrNp6cltDaKHyUmU4Yx2O9XxY47gA50r+N0LjUf8x2Y7EbySje2h9OIncN9Cxbk6JsMKOJZ/xfgrZOzf4SAFs2ykOBqexFp25WhFhsQvRQqo8b7nrTodwGGjcPhSHUPiDKJybXAFfGELRdRGS2qjXDW/3hlDUW+4X7p07vgDv3vlMHEIRrek8cyNUsBqHwdW7t6/PndES7miI82XUKetMjHDErVXiprtg/EQ/XCWtZ0PnK37gcOd+L9ggv5+73wrDHm78JxgiWQZgn2XmqtJAi8KDKg4qez94k85Be/opfoAd0SH/NqoZG0wIAGxXZ64qTWMtMXP1oMI3xBejGuPP8eObCOZU3grdw681wDBztdQ0VsZKzFytkrDYslurfxrx2NW4asKmr110qCsAsP2Yuao0jXV1RZOd9WeuHlT7fkwW7DMR1kErvN7XM3dLWLvArzQAKauEeOV1DgrjB3WlrAP8hFLgW7lqzbajwbeCRKwO3haA7byUZbz5mYtXvHPwx/Wm2MxVEFYq2gkbVmOKdwVgmLlacBprpHPwF809ePkg8TKfHbGwiXrvFe8JwDBztdg01sTm79cN05+5CsLKwLTX9A42a/XDZvdsgTcEYJCyCopXks7Bb5f3THfmKggLAABWfOaqyjTWtM5BGkioOnMVhAUAAMsLJC0T554V2f796lmrHRqEBQCAHMsSUtZ8qWgPpUFfCjNXQVgAALBiM1dVprEquBYEW1ZuYDIICwAAZrRbh/pwFCPbyZaV160DwgIAgJkMniHxSj2ynWxZ2cEzICwAAJg5iwNZGfS6bsiWlfU4EBYAAMxU8AyFyGhHtpMtKyN4BoQFAAAzI2WReFUosp1sWalSFggLAABmJHiGh8g8F41sJ1tWSvAMCAsAAGZAyuLi1aooXUVtWVIpC4QFAAArHTzDQ2TWRZKPpbYs2TOBsAAAYCWDZ3iIjKLxStGWlQyeAWEBAMDKBc/wEJn5r69GwG1Z8eAZEBYAAKyMlMXFqxtDdBWxZUWDZ0BYAACw4sEzPETmvuBs1DxbViR4BoQFAAArGjzDQ2QKGa8UbVnCc4OwAABgBYNnwhCZ5zJOBgVbVhg8cwXCAgCAFQqeCUNkVnboKmLLck8fHV0LhAUAQBHc3xsyXinasq5+O/8BYQEAUBxGjFeqaVkgLAAASmD+62sFoLQsEBYAAIUx+1EFYf2YgbAAACiPtT3BnYT3NbaEAAAYwd/Lbzbp6tvlX6EYCAsAgHK4sShkCQPtQVgAABTFfE7/tnVU+ONaqHcDwgIAoBBunRiFy1vGmEXvqDBj1a337fIJhAUAgDaCAGOXQlh2pnEZ8Up8crTmAABQCEIzMs2NMC1lCeIVmp8BACiIWAzo96sXlj+eS78hZyOtB8ICAEAdqyQp/fN7ZVjKEsSrWD0QFgAAqlj/lh4H/vi9ZimZxkVA4lWiHggLAABFzFJVql8zY+2F1DgoqQfCAgCAlW90Jp4plTfzDy3WZPVAWAAAMDXjVc5O7pZ08m9FU5FfsuuBsAAAYIrGK2Xn1H0hKSucO5FeD4QFAABTNl4pzo0oEjxDITLp9UBYAAAwDeNVniPhpVjwDIXIZNUDYQEAwLSMV3my+Uo/eIZCZLLrgbAAAGCaxqucvR0/6VPt1uF9OHn1QFgAADBt41UOAc10gmcoRCa3HggLAABmfMIEt2XldutQH45CPRAWAACskPFK0ZaVaYkgK4RSPRAWAACsmPFK1ZaVLmVx8UqxHggLAABW1HilaMtKCZ7hITLK9UBYAACw4sYrRVuWRMri4pVGPRAWAACsjPFK0ZYVD54JN4xa9UBYAACwcsYrRVuWeAoYniJq1gNhAQDAyhqv1GxZPHiGh8jo1gNhAQDAzGTv5duyvOAZHiKjXw+EBQAAM2G8UrNl3V+GITJF6oGwAABgFuYKZs0ZLFwPhAUAgCnjlXJaVtF6ICwAANjV10pwVbYeCAsAADPjudTHdxWuB8ICAMDF/IdduvoxN1APhAUAAPNdUt/t0dV3Gt9Vph4ICwAAZll6F+T2cvVAWACQidfH59cq6z3P589V1rv5xSNeHNzbcbrfU4Wfp6c/i9cDYQFAFl09P9zdPTy/VVXvZf7TwfyFVWkW/XYpEMq1+V7Ca3r2ef+Lg/68aD0QFgCkqzoLh65cPCzeq6i3uvnz08Ofm1UV9e5D86a4ZVtdGZWyKAGZsTuPrjzKuitWD4QFAGkI6cqnLPuruZCufMp6rdTb/v2KNqJ/zZneaXwXY//2T75wnPT/LVIPhAUAUryLdOXicbmxupq7v/4ZwfX9mlUpsItLoRtDUpYgjy1EuvIpa6FfD4QFADK6Wj7eJWCRst4fYnTlUdaDtY2odB/2D1kPNiZS/HgCsrN6HMboyqOs4atuPRAWACSweZHQlUXK2jzMfkoxe9jYcVz9k6uPl5ayhBXb+7mErjzKOn/XqwfCAoA4fbym0JVHWRakpecUuvIoy7zHYZN1MPdrbia/QcxmSKMrn7K06oGwAIDFjFd3mTBty3qe/8yEaVtWXmqeoDsVl7KEJ/l5+iUTgi0rvx4ICwB06OrOsC3rJYeuTNuyFDhIsGWti0lZghg273/JBdmycuuBsAAg5hPNhzFb1kp0MqTDmC3rXm2XJ9iyCoz84qO9RONVDmXdKdYDYQFAwieqQlmmjVd5lPVaaaugYMvSDYIh8erf/skXRQi2rMx6ICwAYEmfaD5KHxgmjFfZKG3L0lwrCYd8OkEwFCKzUKermC0rox4ICwCYzCdqmbKkxqscyipjyyowHpWUKOUgGAqRkRqvciiL27LS64GwACDFJ2qRslKNV9kobMsqOB71x/VGZzdJ0tf7uTZdRW1ZafVAWACQ6hNVoKxX08arHMp6rnY8Ktmy8oNgKESmGF1FbVnyeiAsgMHJcFcC+ras5/nPEtC3ZZUbj0qOquwgGDLJ5xmvVG1ZsnogLAB0VQ6atqyXUnSlb8sqPR6VbFkZ3TMk0c/7X0qC27Ik9UBYAOiqLDRsWSt1J4MRW5aR8aikTaUEwVCIzF1puorYshL1QFgAfKImKMu08cqILctYRjvZsmROeb5r/Ld/8sUIyJYVqwfCAhh8ogagcGCoabwqbcsyGh3K93yJIBgeIrMwRVcRW1a0HggL2FNsTNKVAmUVMF6VsmWtTSRaSW1ZESLkRFbAeKVoyxLrgbAAOBmMUdaLaeNVYVvW5trCWFRuy+LKGA+ReT83TFcRWxYpcSAsYB+xskBXWbasZwt0lWXLmluZ1iXYsnxpiYtXNugqYsvy6/2YgbAAhqNBg5DZsp7nP61BZsu6sURXIkc5O06+RyxnvFKzZQX1QFjAvuHt+c4mErasF4t0JbNl3V9++2oR3Jb18mLKeKVmy/LqgbCA/cL788OdZURsWStTTgZFW5a1afMpc+fvLNNVbIghCAvYK7xYpyuPsvii59Y6XXmUdRvWMzsENd3jENbrn3ypACd9EBawp/vBChjrYfFGVtEqCItspH8vv9nnK2E6ahULLHGJBcICIGFZPSq0dUCYdlRoU3FPDJhwMDu1TVenM4YtIcBwSGiHruL+USsWrAwz1sa0YzR1OqpFC5Z0dCEIC9hLbJbWKOtR1ge9tqdk/bldW+7JSZ9nzwqGIRcMTgZhAfvFUsLSx3hfTmhpWAssJXDJypK1Yb6S13u6tCRe0XTU/41G/+Nf3FqSsvq3Aiv2QVjAXi2qHpe0/Fk/WxWvvM5BsdvPhpQliFd+PaEh2obXXRCv/jf673/+81+Bsuy05tA23u1UdHaHICxgn/aAjy+0yjK9LxSem8tWgsC0Md/8LKn3tLHf/OzUc+nKxX9HVM988/M6QYenICxgv1T2x1WZQTlZVoaNdDUlrILWJj2kf27W8nqPrMQMVKXpqGwc0JVHWWNh02Z0N7iQrd5AWMDup/SlbtzMWRyEfpx456DQ7WeuS0fox8moZ07KEsSrqUBXHmVN+bdujFFWn3afkU5FEBbA9s4pKrCLGYuDwIEyThLZZWZYvJLWo2/PjKTM0HTUBF3FKMuMlCWIV7FORRAWwPZvPKpwmrdZlt4XPtDxY0rnoNDt914+dvT6/j2vU5EoUnkGqsp0VDb9PwlfOYz1f1PGjOX40UDVpJEehAWwfRw+L3TPvJWTsiJ9OH8UQthLBrurPdMfY906QqtzCl3FKOvfkvtCHucui4gHYQFsP+2hgiP99dnEbjAnsl3wHCxLSFnzpWI9wVJapluHpqP+b5RKV/6BIfc4zEt065zOM+2oICxgb93sImU9lg1FVohsF2xZTwWlrNmTTj2iyKKByTQdNYeuYpRVVMoi8SplawnCAva4+YYoa1Mkd+aBO68U+wXJllWoW4cWTar1uC2rULcO9eFs8ukqastaFunWOekv8/oTQVgA2+f2ZtrRaUtZgnilfvZH53v6wTMkS2nUeywsZQkhMmMluorasvSDZyhEJn2BBsICdt54pRrCrrcvJKrTi2wnz4GexYGormg9PSmL+nCmynQV9TjoBc9QiExWRDwIC2B7HtEnhLCrd+vQZlLfDMo9BxrBM7SZLFDvWT94hkJk9OgqQlkawTMUIpMdEQ/CAtgeGK9UQ9jfF496ITKFItvJlqUoZZF4VSwinlOkopRF4lWGkyGDsbjHQTF4hkJk8jaSICyA7YXxKo+yGE9xeFAPkSlsqSKblErwDA+RMVBPoVuHQmQK0VWUslSCZ3iIzL+5/AbCAhhy+SJ7vDwpi4tX6zKmdfIc5ElZXLwqVY8WaXnBM1y8+t+oIF1FPQ55+0JuZVBZjoGwANBVjLIyx9jzEJn3snEx3JaVGTzDQ2TK1wspMjN4hofIlKKrCGVlBs/wEBm1nh4QFgC6SlJW2taSh8gYCWrnSnpq8AwPkTFTL7RlvaQOLwxDZDZl6Spiy0oPngnFK1V9HoQFMMyVSG735MEz/DzRVH4o3+7Jz/64WG6s3mPmeGguXo0N0FXEliUPnuEhMsrHiSAsYN+MV4q2rCQHcjZ7NpjQzj0HSU7ibGalXtKVxUNkpoboKuJxSHISF69+qhu2QFgAw2xUqS0rFjzDQ2ReDA+UCJdRseAZHiJjvN6z1JXFQ2RM0pVIWTGRiofIzHUs8SAsgO2f8UrRliV06/A+nNWN8ZFd3JYluBa4D8FCPU6RQoYyD5Ep7GRQ8DiIwTNhiIxmBw8IC2D7aLxStGWFm81wN/h6Y2XCIKenMHgmDJGxXS90ZYUhMhboKkJZYfBMGCLzr26PNAgLYBiImnFg6EpZYYjM+v76pyVwz4EbPBOGyKxvrdX7E9ZzM5TDEJn/jazQVcTjcH5C4lWBAawgLAB0lU1Zy6UhI5SiLev+vtp6V1fW6SpCWd5A1KJhyiAsAHSVH/BnyAil2uC8jXp26So2xFCrMRqEBTAYrzQjZKzTRyxCpuJ6Y+t0FU3LKhpJCsICQFgKhPVYDYFQ3F419f6CsACgki3hy4Ntunp4Ebcwt39s08ef2/dK6wkZ89YVrFjmu/MXp48tIbBXeFtYpSwhAblopnHRBORK6glTdVhgabDLVzQIjBXMUAZhAdgX5g9zZsxCi0zGtOZK6t28JOtNLS6y/jtN1pudgrCAvcLLo60DQoEWBep6siQt0fguh6aeK6j3QDXmNIee2doX/nckr6ctZYGwgM8tZS0sUBYlIPuxDRT6Xmw8l87uzF1VCastO/VuqN6943W/vLUrZYni1W20nu44MBAW8MmxfjYtZT2v40/+INy0Mr5P4wnIzorxJrFhs1CPnvyvH4xFocg29oXCbvDpMlHvtg/CYovzedp3fp4v8CGHlKUkXgk5EMJoHcMeKfJCSZufbdaTNT8bpyyBrv5SbqBY7/x0m4Q1dFqF/H85zHnKr8mpxadQn4SjMvw/WzdO63bwyNN3/+sA7spR6O+mIj/9W2bBs50HJfwKa2+VeRL0V/rFhkyIEeOZ9yfBpQ79h55TrSFo4FNZHIxR1iNZGWK7zccFfcdc04zgNo/t/oR9osF611RvFYuX4ZNyTLreBXd7bGKPUO9dvUnHCmH5H/d/TwTC6ouEcxKloICwHP3tZMEKEdbJUiSsfiQfTCSsUOI7+QnC2jUp68FMFtYmgwQFMjMkLQmkJOkcFHxSpuqReLX5/SM1zt2RssykNvz3/7h4JQmSF+ot+lslrJPXgDdCwlo41ODfGvDE+fn5MFwa+YR159x6GxLYad/Do9cq2e+7q7F+/5yKPJ47t/X9zd1JwGUhYTlEeTI8H/a/nHrfPj937+lFsc6d7/Td73w5+VdGWDd+Lbf4T3AA+2wxfgbTRtlmJV2zPa44ZZmI1SMxaSM/DuQh7KbrpUyB/nG9MbkvpN3g5vpHTr2b/hYJy12g3J0IhOWSCe0JA544DxZNHmEtT/m65yaymHLXkvEbiGMCwnKp7py2ht766Dw4mb7lj+4H9xie9JcywhIfDeydlCWIV+lP9WhOWhLEpPSnUrqTbh9OSqK7F4xF4m/Zbh3qw8mYLCbUOz/ZFmGdunu7/peTE05YzhevJ5x1ZITVJ87QJqxT76kFworcmxPWe8hP7E6uYYGwPnuAw4ORPpzsiHhhGVZuLuFGzR9KHoeS9fj+8m8qXUXGEpqaS5iymkvWWw9PtkNYLmXMnQ8+J6zFiUdJ4Z4w4IlhwA0uQYks433t4k6RsPoe24WE9ehuEfv8wURYd4mn8fem5+d9ENaed+sIfTi5EfHCgaGBScwKez3ayZmo9zdvWv23y3tmbvJzxmouWe/f/lYIy0mVP3FWWUtOWA4LzEkUd3nCVYuc/z2GBCUK9Fx0P1clrEeXAuOi++ksRlgz/x/DPtfDBEIHYe3zAB3a6ClFxD+QsXRZSFqacyO9UmQ7D30vKmUR5b3k0VXMc1BMyiLx6u/VN61689NtEJanXw0ZJ6y+u6Ra8j3hSXTMj0dQJ0QU+oTlLdaIEM9PvQonN1LCOqUTRxAWpKxoH47qCu2BPA76wTMUIqO8YhKO9/SDZ6jvZ5U18znqOXgpLmWRePWsQo+xetlSlh3Cchc5J4wTlntGeHp6ys8JvS9PAleCT1CnDpuc3BXUsPrs1d3cCU4vNh+ehg/ihPWv/4/+6SkRFjSsvQ+eoT6cdx071+PyvVgQDIXIaEW289B3/Xpr7iz48VUZ//xeFZOySLxaqdJVtF5m8IwlwnIo6pwI6zy2jvF4YshZ6MazGfTFr3UJyy1xKhKWw5LhJpNOCfmKD4QFKSvRh6OduUwJyjpBMFxM0s5AJo9poXreuAkd/OA2KZ3gGS5eadFjtF5G8IwlwmLDU4Eg+r5m1Y/wxPrEN4aGBLUKbVmFCMvf6Pm3nJ8HhNVPsTWcg7CwL4yLV6vHUgnKc90QmSKRomRM0K+XfVSXcoA305WySLyalaqXGjxji7DWcyKsxQnxwyvxxDDudP9CTnf/lDB0UqkQ1g0nLM8oulj2Q+YhwvrpGlBnXvo9CGvXobJeIut6UQ8XUZbKeonEpKJJV0RASvV4iMzN5ddCIJuUyr6QQmTmv8rWS5GybBGWuAUTj+/OiSf4EitcUfXJlyW05kgJK9qaEz6aE1ag6S/irTnBStM5wgRhsd0fCf2o2odTxiXPPQ653TMkJpUJ5uOUpVEv11mQAR4FkytlkXh1e/m1fD350MIqCMuhCT8gYR4QD/mw+iJhPQabwmKEtaAtpf9K+5LmZ8+ZdjoDYbG9D5554AbQkvk0FD2THQTDQ2RebgxlhSrW+1uCriJRMNn7Qr4bfDJVTxY8s6PxMjfkOo3hLu0bwF5JWXwv91Y+ToucpAotNgaGz5MLVKHes85RXZ5NKp2yOF0pGa9U6yWDZxDgB7D9C57hB3yGAkt59ExKEAw/4DOd8pBSj4fIrMrTVSQKJiV4hofIvBiulwieAWEBuy5lPaQa1Q1Oj+a2LAklcdfn+t5crlVoy8qqp+wT1bBJSYJneIiMjXqx4BkQFsD2LHgm3MBtVmaTSsMjx3j3TNgXszE7UYJHz6TV0zZCKdqk4vvCcDdoq14keAaEBeyXlMXFK/Mzwh5l0hIXk8zPjuYtPtJ6M6P04VHITNKtw/twLNYTLA4gLGCfgmf4Muj1+e7O3jBDHgTDxaRnK/O6QnZK1itqhMqxSd3ELA7cymC3HgulrBMQFrA/3Tq8ZfnV+KSdeFqWdxjIxSR7E1FDW1a03o0V+vBsUjdC8AwXr+zX84Nn+ncgLGBvgmdCMlnbnHHP/V3LeRgi82JxgDNJVi/z8F/3l9++WgNPr5r+NxSvqqk3P3XHyoCwAAY7qVnKWqzFequbPz+tQkjLYuV9oioU8nd79UBYANtzl4MNynpn5nyiWnmiz2aMUHk2qedt1QNhAXuF5V0l4JGAtz8rAZ/9fvW1Elxtqx4IC8A4MOPKO02JtixgJcZ3OZ189ulDGDRfdT0QFoAGQ0t2LGbT0SCdBMbsGKJi9qh5tN68ynogLIBhHJhJ/YrnkJJuZq4jJ3N8Fw1Ztqgrff+93mY9EBawl/vCB1ty+5t0UWdLehfkdhEGIhNy59tspx4IC9g7H5a9faG4G3yez4W92tKKlEXjwuL17u04z++ZMOyeRqBWUe/n6ek5CAvYpzWVMAI1LXimXPtzXGuPqOHmewmfsupdm+/tu2bRYffCCFTb9eae0/30HIQFsD1yXwkOKd1xYBqz7sksKpo6DWVhJROQU+qtzFqkeEaVuAUUt2wW69EYHRAWsPsQzaIPCwOT7bPFq4hiJapMrzfm+CrytCn1DJrQRbt5xCwqmDpt1fu3j7QGgO3PmeBj2jxBc1KWIF4lUvpoBKo5i4NgZcisZ6orWZCrEgspcSlkoV50GAUIC9gvuopObXbEHwOUJVDguyyz+PqB19Men5o9UjW/nokQ0H9+b8jC8I/s+2tb9V5jGckgLGDf6Co6kbB8rDvNuk+nI4FiSktZgnilUq+0tCSsoDZpyvqPayv13hPTCUFYANtLT/vjykx+A035yt7wCZu4VSmLw3ylW69U98w3oS8mK6WPRqCWm/Ml1pMMUwVhAbtrvFLu+CsuZQniVV5Kn2CTKi5lCTykUa94HqggJuXpUxp3VXqSn6dfvoCwAAYze3JxVNCVJewsVZqcySaVMp4rtw/noWC9dTFpSRCnFFL6BFtW+XrzfkWj6gGAfZbYK8GMsNG3OPDEZeWUPsEmtdbv1uEJyEXqveh3z3y/etHsvRFsWQUmFAr17uR0BcIC2K4brxRHoOoHz9CWUqNVULBJ6QbP0HqpWL37y6KhLhopfYIt66lwvX/7J19AWADb86PBnBGoelIWiVea41EFm5SOlEXiVfF6OsEzFOqieewnHPLNC9VbpNMVCAvYc7qKKlHKwTMUIvOur0aRTUo5eIZCZIrU45SlHARDoS4F1Kh/fpeoFzdegbAA0FW6x0GpW4ekr4I+ULJJKe3uaF9XtF44JVqte4akqE2xlmayZSmJX1Tv/TyTrkBYAEOYaHSHlz9ile5rwp6QHzxDITIl6j2qWw4o1KWEHWKuHjxD9fLoCoQF7JHxSllDf1QLkSk3HpVsUtnBMxQiY6pe9qqJQl3KNQaSo0q1ntR4BcICGFJEs21ZGcEzFCJTfroEP/bL6NahPhwD9Z7zZXSSzEuPRyVbllK9ef/LFxAWwGC8KpARkyJl0R2MjEclm1Ra8AwXr8yMY+UUmWY54KEuRkKPSZtKkc4oROZOia72jLBGZz7G+HwbwbTTPG62J+xTGa9UbVmyfSEXr4xltJOcLpOnuNBloZ5sn8Z3ccbGo5ItS7a/5PX+7Z98AWElcHjgowuuMYFx3Xs3a0P2OY8G82xZqTlaa5NTcLjnIHEAyI8Sjdbje8zEPo2HuhiNDuV7vkTwDK+3UKarCghrfNbrdHofY1EDwjKK4+DtrF/sDl1FbFnvYvAMD5F5fzA8tIvbsiJSFicW8/VCioxs+zixrE0kWkltWatoUulKyXhVJWGNu40DjsPOCIS1S5jwH+1wl+gqYsviwTNckDcSwJdqy6LgmTBExk690JbFLQc81GVzbWEsKrdl8eAZXu/9XIeurBLW6PgghnoXhLU7GPKfa4/t3BRnUqseI1/amuLM1Sq/QOxLC/UeI90zXEyaW5nWJdiyfCmL19OkK4uENW0dSHBofpU1afuIbTo7/q1nO0lYshdn+bzCr9j5WIRVznilZstygmf4HvF5/tMaQs+BEzzDQ2SqqOfsAPme7cYSXYkcJdZTMV5VRFiBIJuE8V/usXxfEtTv7CRhyV6cXXT9irWPtCW0Nr45vgvcmDJCqXkO3t6qrffyYsh4pWjLCuvN+1++fBTCSuUr858yENaWCGvLovv7wipdJebOr2xNm5emV1VU77WCafMpc+fvitCVLcKapPPVwUEbhLUbhLVVW8OLdbqKtuHcWqcP/2hwW/XMDkFN9ziE9fonXz4QYbUz+OqgNgZh7QRhbdU4+raogLEexIy+KgiEljyV1BOWWH8vv9nnK2E6asEFlh3CmtQ4OzXPRmM2GQ87fM1VH2OFtSOExT5pMkOBARMWD+ykAyYqqUcRprYV98SACQez0w9DWB0ZOZ35n7JD03+QR3LCqu0yYdW2RVgHO5B9pZ+RxSxaoqSjBKup9zf++kw7RlOnoxazYNkjrFCNrUVMDNOmc1NjarrYmZSwpgc7TFjTg8oJq/UBCStmRTe8G3zZJOut7SlLwnTUSurNaDg0Y8ZmoCoFJzOmFIZcIWGF279mYuXVXKTs64aj7JXXeDQcy+/RkBJWR5uwxqORzmZ14l5R5hUPlZ5umvHKlymvumOPsKbjkayNim/ylTfqo5HSUlrxXUrF2o61QRCvnIUcDaIvOQNVaTrq+lbgLkv1/ty+CywlcMmTHSlLnI4aqXfb/wiEdZBGDDKn47R76H8aavWG9Lxp3DkOGLB23DqL+ye5nb7pWxunrOf8txneeuzfOsomrF4jqFA/VPKJnTVr4f27kiXjpBO+pMNO/GPbFn2uZ8fe/WqNZNVpr3VIr5p/fFJf3DLyxGzc67Y9OTxwfLa7souIXdywFb7R9dY4YszlCqT4ZGfBs8Qv/oy/m434DzzykElQTij2QaQsQbzyBhY+CpRlQ1oSxCuvc/BaWP7YqCfYGbzOQWEcoBUpSxCvEvU+QGvOWMMkOmnXxBPERsIJfxZr8KmfJaScCCasmWpXlRPWRTdiwqjnXfVbL1K3FuekcUv8fi32aQxvd17oWOi0PI4b9aOvrdYJeDH1xS2EJ2ZD/00bC+LToWRLeRApenZ4ILvukaRiPXIW3Iis8nuRpznsLWTHx+5DuvQSa2XsxAVnoCqJV5vVYyypofAMVKXpqFy2mj3Yqydq+2HnIIWwW2x+FjoVxXpbb36eHChrRWcJzmlFN7mSBp/WwihhJT2u2ecCo8T9o1Jdr5Zl7hd4JVo4cng6Tb6G2pk6YXUFPlIlrEkz5U3TI6zJYeLdHMsJq2POTrwxaXEQxStx9SasutYmPZ3CdNTIakqgFaP1BHqMdA5SCHuRGahK01HT6i36H2RLeJx3x57kwyDK8uNDmZGr+WaQsIaSJ8lyXowk9xcYaylroWwtJSusuLm2LhDK8UHas6gQVu9An7CkVt+uNmGN6pnvjvCQrtGWrbdnC+JVvFPxmSjLXNeMYC2Idw5SCLu5eqK2Hx+sKmzcdGegqkxHTWw2hXo3/Q8huuf8Fko/3OICZ1rP9sobIKxeTeptHeWdSUqXP2lUc3A8SRJWM70DoCF/2Y0LJcIihlEnrJTWhI4mYZ3J381egrCa48SdJh/BlSUsoySdiiKbmZGWZtmcJLLZzDA9SlpxKIRdbwaqynRUWaeiWE9VyrJCWPSpypRTOylW+GbyeWIYmSKsUUqBeor7Io1Ca9PsK24kCKsnu/T0dadHe2qEdVyAsBrpb7QGYY1yfl7CQ5Kvo1XalfVQPmw0r1PxYcHV8PfyMaA0HTWtc1DoLjRQT6DH20v5ru/qienOQFWZjprWqSh0Fyrm+FkhLHEZctg+S/nbOa5RTtZoOh6SVn0WsyEcNLu9s06T+OnYFGEdkqo9mkxHJHW386i4dthsNw9jGozwwuuNVkNgt7M4YdW808FWs57Ucfiz1p2o1l4n/PJwqrQlFOhOmbCEx9Sdl3UsEq0GYR0K706rdUg/nsM4YdX8Uq3jWoLzt9at80hklCGKPdAhQsmg9T9iH86fcvfSpMcM8wKFsJdthxbI6Dlrag6v929/a72EcXmmIWOtZpwcuADC2//9uzTGCV14lDwqHErdWdk+LP5BPZ7GtnTyhsdRnFzOwkv2elYW9ZjSPOYf/foiRlj8OJJEscPYIWt4meMm56v0F8cJ67AAYfFLaPo/Jjq/HEWzr2ppR36Rd7PW8ZcqdA7YSzaZBovvVpLTt7IvpBlf7D3bQS8cGC5LSEs0HTUnsp0GzZeSsoS2wWwiEiye9yUsDjQdNceOKtSbn26JsGRKT701kp8ltpN+iK74megk/daiClWGsOqJ04Fpmuk1yrGjuPjjfdLPktubdvzjmNz40kpzGnnzmpHD1PqEqRGWv3Zx1mZnZ1NFwuol39ZG1GaiRFiHCQWQH4Qext8OrvrRz9RIikdRiwOJVwoNPwJlPc2KhhRHjFeKoe/F65GAr+BmF3wIRQOTaTqqgktCqJcrZR3Y7eSIiTBnku60Q4mq1RDuJf4eT2tJwaMEYY0lyynpRzPu925HF12hFauZDIh6ixHgIrHkSpBaV3KWOYpYLXIIqznKeZvjhHWYvI/3TtMTqRCWzH7Xi1VqJ+/D39RjI795myK5MwIDrR71HlCoe4bO6hT7BcmWVaje9YOmyYpsUoW6dWjRpBgRT/WWOd06lghrmaI+C8dlDclJ4iSpZwylS5ymEcLqyFZT9fQdSk92onVc7wb8tKhJHhqul2oXMdGdpS0s8xtvMgmrdibtWs4grLFsU9auiT54FcLqJP0Z9JZ3og+pS/641dmWgmcE8Up9T/lYIgiGdmfqZ38kmGvXE+hRfcFENint4BkhREY9Ip7qZQfPHNhu749vDEfxHeFE9vvdywnaOjZCWIcybmqnn1q1ZNbucZKbmCRZISiykJFDPXKxIS0eLgoRVovpElZPdt0T6cCJLMKS2nJj5SU/P3n56qQsQbzSc3M9vxazHBD16EW2065Orx61KepNmCCb1E3Fj8sKnrHXfn8mdwCEAseZ9O9qM0fPkHz8ihPWQtqhIvuExx7fymbTQ+mD2izRQSNfhnAlrDEuQlhn2oTVSn/FGoT1Jr0A/mIuUs3x/C5sG8EztFLS7qMmW5ZGEAxt7vQVdO6i0qn3XLhJkGxSGsEzFCJzr78yu88PnrGZF3J2nGFx6kk/Ja0syds0YY2jYnfsD349NYYqreWoKb342K0ywmpEiFCIPzxsdWXZCZmENdImrIZs4ahNWGPpBYyjpWSENZL+GFglwTOkRRWaaEG2LEVpiXZnhSLbyZalWO/6vjB9RJ0JilIWiVeFPBFULzV4xm7A0cRxTx3KHYKh4lE7FlGXf3ac0JPhmYuWScLic6qkl3CQGkOVtmFtSBdgrcguSMorzegDY/pfrdkbWyWsw3zrpgJhDaV7/El0sk5lhKW0YCLxalM0WItsWSpBMHx3VthSRbYshXp058KWKrJJKQTPUIjMc9FuRKqXEjxTRSLbqNcWWauWcY4oaaw7ax8nDaJGCKuXeQkHE90UinomYdWVCUti1ax33+wRVt0IYfWk71uM5CskrHwpi4tXpfIeaJGWJy3x3dm6jGmdbFl59fgOslQzMy2a8vaUXIRamakn3RdWFSE5FVJHepltN5EPxltProQZIaxuNmGNUm2jvczg4hTCqikTlvTC6iNrhFUzQljdbMLqVE9Y2UTE+3A2q8eyHT0bhSAYnpLwXjYuhtuyMuvx2c6rsnEx3CaV6YlQu5dePUm3ToWZt83InrCRzRZpYSUmCauTfQnD1NnsveyQCjlhHagTlnz52bVFWAdGCKvz8Qgro8eG1CcTXdOcslKDYHiIjJGgdq7cp9e75fRhoIuZ26RS12o8RGZzbbJeMnimQsIaRzzeKius9HGsVaywhrorrLqpFZZTqpEVIfEZV1jdrRBWmlWBn++ZGnbPDxvlZ398d2YqP5RvL1PqhduqmaH8UG6TkgfPcPFqbrpePHimyqkCDfGzw6WdMylizbROn6wXrdswSVj8PF1+Cdoa1qEhDSsIhk6sLrmB/kNqWGcfTsNKXUJxdjE57J7bspKcxNnl2WBCO7dlZdSb/7IQc5wMnuEhMjc26kWlrCoJK/LR7eSbf7iMe3hmxdYwSpXXs4fV5J0SNjPcpsqE5dZzz1jFA4czu6eEzVKENZK62rZ3SpgaPPMQ7t8MD7vntqxYEAxPSXiZ2xkrGK/3tAkjZAwPkriXBs/wEJl7swMseL1I8Iw1wpqkE9ahmr/5LZKrYtOHNdQbB5jWNNOUejKiNKZDWMFVUuR8pwRh1dMJq2nWhzWUbqPH2yOsSLcOp5U3C/N2FuuEa4FbC1Y3xkd2cVtWpN7a2vwbbpMSXBKy24zXE4JnLBHWW1MSMxz5Sz6W/kGW7sCGloyj/KE9zT1tM9vVWpcqW92ChOVMyYg7O3UIS/aHYRJ977v5zXwqrTnSd5OXf9smYdG+MNy4vVsaD7aIBc+EITKvN3+szpoPV2/hqssCfURsUmHwTBgi82xnoiGvFwbP9A8s8ZUkGH0ZzRFJazKeJA7lbDnd+ZKvnb86jByEHUeHWISDYTgPLGTLsrEOYU2k1F0vQFgyaSm27OFv9FtkGq5u87P03exEX9rWCMsPngnFq83CCl1FDgzdIJgwRGZ9f/3TErgty6v3t7qBqO5pYBgiU0U9V8o6+ckO7GU1xGID6Nz7LH1IlBuyPs5YG3SMEhbvZ4zxQy0lS24kS/drubbOaWrrdqwFSY2wurFQ+RKENcwPfVnW5NctTChTIayzZLgORRqebZ2wnNe5VAroM0ZZ9/eGjFeKtqz7e2ZnTleKTerqqtp6ffcjbjXTvTWVSej12O9pJ7aFCOlDtjYwekpIj23E5uLUhtnngMfxFYyfiNVJxs9MY7qXqnE0wlijElvCSdIJQsH0sZQq4br9VMHkcMIMwlpIJD7+jiw+AGFpN0aXN7+bMl6pNlSbMkKppldVX88CYV00hDa4s+A3VRiN0I7nKLdin4FAZJe4CEYSH1ZdSlgtGWE14oTVkgQjeJNf5AnJ5DVqJqZ+DcUr5mNRJ40YN6gQllel1p6mNim2NAiL3uZ2cnbaOKYW8hmCk2jiDQWVZSWOthJTcnpxi9f2CevVOl1FMyCerdNVNJNh/utrBaD0qqrrWSCsWCtcrX5Yr4uH8+P4ZsXxYgXqb12q4vLVBk2RqtOc9WZkVP1ZjFqOxTnt3GEQ3kTBCLWgwfisId0lJj79h8NpZJsbc3v7TzemIWIdpkxY3djsZRoINsx4camE1RKmMLtDcMRR2+N4E0LNd5/x6+ZJirXIqPqRlH3o3fSTlcn9ypdu+0dYj9UQ1iPPkvpRBYH8mG2rno0toXw6XTK6W2xAqR2KpNaO+UabXcfI2am74ywSn7a2dFjUmayXupu4KXI3h1mlXnqZIhS/+zg+N8Z5RTVJM3c+YfViZF9LzgqTvbhUwpK0Uh/GCUtItIn+JLrJgTgZLlDx0ut12ZTUD7ElfLBNV+LwaPZ++8c2Xf25fad6a3sCOAnh663Vs6JhDTMYq/GWO+QvXFJJ0hS6vQRHjKSEFX3uenzcA78ptUOopxNWz7eIo7xG6nzCSu2fpIfIXlwqYUm6NpMez5TgCgqe76oQVtq72WAfiLDsOLAi1oa32KLuxi5fUeJywUzjwgnIW6hnx9YwTv3QHU4jjoDMUNLkR60mziIcM8kSqyVdhdSTdFPPHNWcas2aSpu2G9PM1aUw+lhhSzhNefPOUqYS5RHWOH5JTcmoemkjuOhMOVQhLPm7KQT5fwjCsrsvfHxN1nue26MrYaA9YxZaZNKTjLdSz9YQio58kdWK/lJKJ6Q3x0yyU/E++ENxLTCWrTda0r/29eQThjctZKuCw5HWeI3mMnLGmOCrIdMhLHbRzqXQpgZhxZdPhxMJYck6wSOTeiKvK7UxUPZuNi/YxyCs11e14JlSdPUirVd4PJf6uDCHFgXqsnV0R+O7HL19Xm2983N7hOUOpsrOdEpbsNRFD9Sonlx5tROftmlLRlhv3SQ7CYeV9eSULcmCSIZ4RFctmpg8qme9ajUfVuI5om+L7MVlEBZp6AENyQhLPMeV+u7HxwqEJXk321kHixUSlhvb8PzGFIY7lxkenVpvbUPKosRlfxUnrLaseDmFmadep+LlbXX13MkU/Rtmsfk5ljdQbw/fZPdq18Vhq7H7TOhMqx4M/+OEIQ4T5GPhI4EHzq21eNNJr+mHIAs3TbqHkUDi3A+OeP96MuD9rFkTjR2R7yk63S+6Efo47CYm6MRfXBZhBbOjORlP5W1RPeGvR2TIV+ytyyQsNumIP9DOhH0IwgoCkx8ECnkzTVnC/B2qRzetjO8LaR5OojXHRjMhJSDzJ5fcZKdemDLTt5vWMO51281Go9nu9sYZp4q9TqvRaHV60o3YqOt+s3vG7KY4u5fgzktWfGHdlvu6OimXNTlzXvex87LPJoUvaeKUaDaOm81Wd8IMJL46F9zqnGWTwsS9l3fdpchjGP5Ah+xjQOCmx8XGkpQliFdis7UgwZv1ZJH3StpsbVxaEsQkWfOzzXp3/a3EywDANhCbMPFIpgODrnfB3R6vRxRp0PUuuNtju01hn7gx1zRD47visaM8bNRWvcgEHRAWsNuQdA4Kyvj74tGMleE9q96Sf3dtJrWBh8hIG6tpTkW5+RNSMUkSEf/P75VhKUuotxxuLcAPACpfXcnXUML2bW0gJJmUsbR6tP4yEeNHSlXKmm32tGGZmcZ6IDEpJSL+x++1pXrx0TkgLGCHkToQR1TDy0pZAvulD+B5XBmTsgTx6u8sv1mndLsfNfJlRMT/mtmol5z0BcICdhaZTPSweDXiyhIksWzmI17blMmbuSbxKtuPSh6HWKZxwXSXPCYinimVNyPUOz/98gWEBewJ3p5VQ9hLuLIeSFHPrSfsHNfFJz+v1e3zRFmFA0i/kaKeHxFPtqwXA/Vmp1++gLCAPcFapWFQ0MrfnkuNylGsRxvRZSEpa77Uk8JI7LovJC2FcyAUXVaCc6psvRv5pHoQFrCTqyvVFdPDooSURZs8jXpvxYNnSJdSjogXbFn6QTAU6qK8QhNsWWXq3aXQFQgLYDtvvFI1UGkGz1CIjF49vonUDJ6hEBmtNp8/t6/FLAcU6qLljSBb1rpovYjxCoQFsH0zXqlSlka3Di2VCtR7LxA8w5dK2hMtyJalEQRDoS4rXQmdbFmF6sWMVyAsYA+NV6qUpbov5LvBkvVUg2e4fl7ILM/nVCh3z/C+mBTjVc7ejp/06dc7z6IrEBbA9sN4pSxHqVgcyCpfuN5KJ3iGQmT+zsp28qislyjUZVbQU0W2LJXgGaqXQ1cgLIDti/FK9cBv8/KgqkKVqccpMleRoubAMkGA3G6aK2VRX0wZCyi3ZWnUOz/98gWEBTAYr5TSYd5UMpTJmlCyHtmysoNneIhM2dxSvq3MtCiQNeG2ZJMNt2Up1pvl0xUIC2D7ZLxStWWlL51oYWSgHue+9G4dvjAy2oOYLi1xMclAvBVxkUK9m/6XLyAsAMYrPcpSbGI2Vu8tu4k5lJ5eTaU8rDK1dB7qUtgan2LLSgme4fXu1OgKhAWwfTNeKR7gvScpia/ATNYLBTFJtw7vwzGYr8ydpBJpiYtJL+byjrktK6telvEKhAWwPTdeKVJWXKMKNSfj9d7lm75wA6dtvFK0ZcVdUuEGbmUuhi9iy4oHz4T1so1XICwAxitFyhKlrFC8sllPlLJC8cpgSmnCliVKS+GpXiHjlaItay6rd65BVztPWOMzHyN8sBmMV/qeAx48w0NkLNVbxYJneIjMXyvzwUJtjEtLPNRlZmXEYGjLWifq6dHVzhNWKzaZGWAwXmnZsrzgGR4iY69eSJGelMXFK3sTWMMFnCdX8VCXubWJqOGCygue4fXOT798AWGBsBiMVwaGdgWS1etzSF5W63GJbDkPQ2RsDowmiezpMgx1ub38ahGhLeue15tp0xUIC2B7bLxSTsuqpp4Q22zIeKXmcbA0VzBrzqC68QqEBcB4daedllVRvTftxCsjHgdjxivltKy7QnRlj7B6bQ89EBZgBYu7SrCsuB5nyNuflYCHGl99rQRXYb2CfGWNsJqyKeYgLOBzCFiJEPbq61nfEboy1kLcEdqnK3FPWGxHCMICGI4Ic8d3baXe88wuXV0/RevNf9ilqx/zaD1dRwMIC2Cf3DNqUVd6oNmn26rHzFrc00JrmJFxYLk9Or8T9V6HJyAsEBakd7Py9zbr2ZPeb15k9axJ74LcLuLfPggLhIV9odHd2evj82uV9Z7nNE/QlpQlDI+O1bu343S/F8SrXzxSxt2HnoKwQFh7hRfzvX3C6uPVdV89RNRwq/V8gpoLtzzNbDXmuFgk6l2b7yW8FgjRdXt9u7wvKmXZIqxDEBZQlZT1YnSfRgnIjqoTbgFFE6nhejQuzOlUDLeAoqnTYLhMXLx6uZGYSFdXRqUsSkAWtpziFnHZ335aw/CgGGFNRsOxyv3GWXebjEa5hDUZD0djfNYhZWXazcWnFUykRusJ4lVEsRJMnVrjwHKtDKskPcbr/TVneqfxXc7mU2TC71e0EdVwkZonrJFrGK0FRFH3/aNn3nfO2qKbdHHW60SMpaNm3X9Y7bA9jT5n5JGTVt1/7paMcTqHNeGbUsIadxrB9dWb3Qk+7pCypGJSIsHvUTjHs1AvEXtF8wTNWRwE8WoVF/TFejeGpCxBrkos3MSll3JboXnC6h4k0fK+0xaWXRc+pxGRnB2LD6h1IpQlPrJbo3sljPS9Oj1HcyolrPFh9NoaiJ5BLNZdLEQmJaVPoCwz9ej53h+us+YJmonFuibxai07fxTrmUjx4wnIQrBM9PucIt8VpawtEVbIGiGRTJvxh9RHcsLqRO7ViZReRJ/lcCIhrLNa4uqaWGXtAt7L5hY/kHi1SVPWRYopW+9xkU9Hgj5eWsrioTUp9OjXMydlCSuoTZqS/+Oavz61nOTtENa0HiWS+KrHWz6dyQgr/uw9ydEkMVaSsM4kVxclR4DtZ34DnQRusjZ84iauTD1RLMva8ImbuLmRkTls86RWr1R+g5jNkBWz9Yv877f9j0pYnFl8IhnVZDQikFH4yOY4QWvC6qiReIZunLBG0kIRcgT2UsoSeCjvSZ5fzdbLi70SbFLFpayZ+pMI9YpLWYJ4lfckwl3z94VbISxa5nhEMpXz1cHBKLHCaqY8tSe3S5ZOMcJa1EFYu25xeCzZF6PAQYItq2A9QSxTcYYKi6OH62KDJzZMYxwr1VsXk7IEceo+f5km2LLWed062yCsZjNKWG2639mYjUk4P4wTln8A2GwdC8J7qM6LtFdvtJqRXWYzviFsds963Vb4EPDVLo38eigTQ6W2yxNsWYXqbVKP6nKz9tb63TqCY0HROC/UKzDyi4/2Uu71EWxZi/42fFgdmQ8rpJ16LUIkfJtXH8fcU3xT2Ba4bxy9CyebTlySmnRqccJqxSv1agkhDGB7FjxDu7O1OvmI2X7PRcUyjVZBfdKRrJdWherpBs+QePWsTnaCLSszeGYbhOUtjI7b3Z4/zSZkkdo4oZ7X44+kvRtnrDaLeOudmlzWGtdjhHUY32uySQN8td9SltAXo7dWetTaRsroUS+MQbBJ6UhZs78F12ZCPZ3gGQqR0TxmFA4VM6Ss7RBWvSvYrOrJfdmkFmWWdlKH53c5Dr6WyfCjGGEFpWqRo8UuPuD7GzxDfTjv+ls7oizleiSWveurUWSTelfluuv7d1Z4HCvVUw6eoRCZAuoXKV/pwTNbIazGVNLFU2eSHsB2bDMpuUtwW4+fDIrPcxwlrJDk8IlGt07UWlBwmjNRllo9LpYV9IGSLUttN8n3daXrKYlRJEVtirVQky0rLXhmG4RVm8i4qSXeeBZlo3Z0NRVhqFrMg7WUObOaqYs5YH/3hXx3tnkxYE/QqGfEnpAvZZE/4a+BevnBMxQiU3y+Idmy5MEz2yCsQybJdYiujPhe7iLRmpOwgEafpp6V1hAuuGrYBrK9D54ha0G5xkCyZeXV03EWqNBQdvDM7Ml0vexVE4XIlGtEJFuWTMraBmFFIxykqx6uSI1TH8k5bRp5mmYWYZGKVmt0evC373HwzIMhuorYspTqlY/k48d+Gd06FCLzbK5ehoxOkvl92agHsmVJgme2T1hciD8WwI/8hqqEVZN2F8YIK26UP2yfXeBjvYdSFolJRmIXyJaVW29lIvSYbFJpwTPz13jilZl6KcEzFCJjJGSZtLBE8MzWCWtykImeImG9HagQlqR7p9ZELNbeSVlcTHo1Nc2ZbFnZ9UxltJNNSiaHceHJQj3Zfo/v4p5NZf+RLSsWPLN1whplE1ZXkbAmaoQ1kfTm1OLpW8BuB888LvV9ohoHhpJ6m8LOAgWbVOIAkB/tGY0qpXpxvwIPkTEaVcr3mNHgma0T1jCbsDqKhDVWIyw2knUT1pEvw/YmeIaHumxMT8DhxCSv9/5geGgXt0lFiImLV/bqraLJoatSbYcKtiwxeGbrhDU2Q1hTRcKKBADGO3cAtuvBM9x5tXmxMP6GHwRK6j1YGIvK11IUPBMmIG+ebNbjwTM8RGZzbWEMK7dlUfDM1gmLmOZMhrFR0d3HWbN2kBWrBeyslMXFpJWlKc6kVkXr2ZrizNUqv0DsS4v1fCmLi1dzK9PBBFuWvy88Od/+KaFKYoKGraGjNDVn3Gs16pGoP2D3g2e488rm0PnQliXWe57/tIbQJuUEz/AE5CrqOTtAvme7sURXIic6wTMnw1f2cXxYHTOE1VQf8zU94/b4Gj7Qe0BZm2LpCkVtWWG9F4v0Idqk3t6qrffyYsh4pWjLenx0/rN9wmoq6EgKhNWUrpXy5hKeJbICgV1X4J8f7ixDHGJoxnilnF5VfT1r0+3lc+63T1i9lF3ZRI+wulLqaSQIayKdUA0Ra1/wYp2ufF97WO/WOn34R4Pbqmd26Gq6x+HjEBZPCh1Gbz5saREW//JY9tycsCb1lvRCQVhsX9L9KmAsMcL0pgoCobS9quv9vfxmn6+EaazbJyy+Coq4oSbHYju0AmFx8V7knvaBxDjakq2wsCVEIKn5o0KrB3bSARNbqGdTcU9MqbBFWD0NwupJpm35/s6eDmFRUHwruGXaihutfKN7ndZyfF4PzO4MwTOG/aNGZ6CqZFZtq55px2jqNFZ7hDWKjqqfZhGW0ODXGQVD62O7RBXCGonDcs6m47NWLe4M5Y05xz4VTrmJtIFPMcZEm6ErUXBnzEKPTFoqwxbrrewpWeI8e4uEtYj6MieZhDUWfZz1Q2FGRRjzrkJYrCkxyh9GCKseqXMolB3iQ4zZOkYsDWuBFYWl1sqS1WC+ElhK4JIK6q2uBC55siNlidNYnXr2CCvGHtmEJZ0MFkkhVSIsSZNPM2pr6KXVwQKL7WG3jlXxylvEibtDG9KSICZ5nYPC3Ajb9bzOQWH8oBUpSxCvvHpOq44twprUNAgrMk9H1uKnRFgSPhrHfFgpjHUIBWsfYXpfKExH5XtOgbI25puRNwnZavZEtz1ZrBd2DlIIu8XmZwe/g3q/rM1j6OoQlnSNVesxPcJK8FEvYRxFWAPAhBSHB5NWho1U1RdWXWuTns4/N/LV1OzRjpQl1hM7BymEvcjMVaVprGI9ewNkzuoahMXOEv3IYkqVImHFGOtM4nS/SC7mWlhfMVgcSrcQvqUeQgqUZa5rhqajJjoHKYTdTr345k/YuOnOXFWZxhqtZ3PiVacZ6tr5hMUWPTENtNGdaLbmBDvRdkh8NW9EtKQ1ZySeHjqBo3BgMVgcDIpXEmfqg8BmZqSlWTYnCZT113Q9SecghbDrzVxVmcYar/eRRvSNe91287jZ7p6V2KNNzzqtRrPdy3qKs3ar2ThuNFsdnA4yWBxK7wtpOmraLlPoLnwvHztK01FTOwdpQWS2XkrnoNDtpzxzVWUaa7IeZooCGFTxYKgPJ2PYPYW+lw1a/yP24fxRupehOPesyHYKYS/bDi2Qn6QeCAsAXp9N7AZz7KjCgeGyhLQ055OCcyLiBYtnmXwsWqvl2EMFi+d9CYsDTWOV1gNhAUBxKYumoyq45wXKKhpgTNNRFSLbBVtW+XoKrgXBh1A0MJmmsabUA2EBQPYM1KwUmY1esw9RViHLAS2aFPsFyZZVtp4aA5Etq1C3Di3SUuuBsACgmJQlhsg86u8g9aUlQUxSXjCRLet1XryeemQ72bK0g2eEEJn0eiAsACi0LxSop+Dj9CwOZC3Qk6TI41C0nl7XDdmybDwOhAUATL9bhzZ32pGAZMvSCIKhUBd9MyinrEL17vVXSvf6wTMUIpNdD4QFAEw+c1UlRKZQew/ZshSlJRKTikW286M+7XqFPArkTFCUski8yqsHwgIAJpu5qhQiU9TCRbYslSAYHupS2MJFZqoXnXrPRbsDyZalEDxDITL59UBYAKAnZXERqlQOIO0p86QlLiaty5jWadGkXK9ULh8tmvKkLC5eqdQDYQEAS8xcVQiRKR1byikrM3iGh7q8l42n4baszOAZXq90XAy3ZWU+k9q9QFgAUCCQlIfIGElZ5pSVGjzDQ12MBLVzW1Z60A2vd22gi5nbslKDZ3iIjGo9EBYAMNXgGX6+Z2qOxWO2tMTFclP5odyWlVNvbig/lNuy5MEzXLxSrgfCAgBFKYuzi8mxO/xJk5zExaRngwnt3OOQUc9k3DFXqJLBMzxERqMeCAsAlIJneIiM4Vms3JYVC4LhoS4vhgdKhJQVk7J4vXuzAyW4LSsWPMNDZLTqgbAAQKFbh/fhvJuft8NtWYJrgfsQVjfmR3aFOz/BlcXrlQyHybRlCc8tuw2EBQBmgmf4xs3SeLBFLHgmDJF5vbEyYZDTU7h6Cyns2c6EQW7LCoNnwhAZ7XogLADIk7LCEBmbA1jDDacbBBOGuqxvr39awp/Q4/BXqFfFQFT3NDAMkSlQD4QFANlYLq3TVYSy7u8NGa/ypna9R+utbY+cDyjSG4hatB4ICwDYdsfbSwL+DBmvVBucTRmvVNOyitcDYQFAZdN1bEXPlJ+GM//1tQJQWlbReiAsANjCmOi0NRYzOp4rl7B4ZN7sRxWE9WNWth4ICwCsZSgXTVx2FazbP7bpiqtYnqJkT3An4X1duh4ICwBYFePAdMaFmRjPpR7fUDTTuHACcol6ICwA+AhCljA8mjELLTmJLueXZL0bi0KWMNC+TD0QFgCo48USZT0K9PFMc+ELj+fKPyCU17N1VEjjuxy9fV6iHggLALSCZyxQ1uNiE1lV0dyIYuO58o3utBt8idaz4h0VZqyyWye24fK2cD0QFgAwwxnKut3PUfqIzltWylAuOsyZdyoKNz2ZlrIoAZk/ueQmEBYAfAYpSxCvZM3Pxj1ZM+nyTaxnVsoSxCtZ87NmPRAWAGzR9S6422O7P+EUz6Dr/Zrc7bGIeLGeuSYdGt8Vjx3lYaNa9UBYAMAKjAN7MBosI50wwUPYszKNi4pXEhIU6hmSsgTxapUkpX9+r7TrgbAAgBnLUNYDT1xOW0MJ3X4mYvwEpeo5r54801gPpFStf0uPA3/8XmvWA2EBwHakLEG8Sm/EoeaZ0lKW8FTp7CfcqWx7ITUOslnqU/2a6dUDYQGAjXFg+c6rjZo/lDwHmzJ5MzwBOS/ElOqVypv5hxZP2UxEvKZSD4QFAObHgeWLVxt1O7tAIeUnPyuEmFK9l6J5yd9IUb/N3euRLSu/HggLAAxkKGuKV6960hSJT8WkLHq8mhGV7n9fSMoK504ouqwEW1ZePRAWALBqg2coREY5sl1YIekHz8yemO6we6GefhAMhcgoT5gQbFnZ9UBYAFBp8AyFyGi13ZBNSjN4hh640elMpIdpBsFQiMyLzgPJlpVZr3LCmozGsi8nk4/xy1fRdSzGi0953YxNRyNDP3q2l8EzFCKjvNpJ2qR0gmf4UmnzOCtaTyMIhkJkVrqSPdmyMupZIKzxyIf8IzQ8akq+HB8dfYhf5qquo33U/pTX7VZqFH1o7Ee/lxYHbmUoZF4nm5Rq8Az14TyXqqfaPcP7cFKMVzl7SX6ymFrPAmF1jwI0BlskrPFoqaNDBH/8q/rgt45aYtkqCMvQ+sYWYen9vNjnDJ6hEJmiCchkk1LZ3ukTXHo9lSAYCpGZFfRwkS0rpZ4Vwmq0XDSOjrqqhMWGQ8NX0Tya6uxWwqsyfh0pG6vBNFK2NPKveyj7aXwcwtL7eX3K4BkKkSkTzMc9B7kKGKlQLybq5XbPUB9OGcspt2XJ61khrE74Cyr5s59CWMZRkLAqVswqLAvCYlsNnqEQmbI5okQh2YbTFTMz7J7Xy7QokDXhtmRTD7dlyerZJCznl7C7NcJqgLCiGHxswmrsAGFlSVlcvDLaE5guTHHxysSwe14vXcri4pWBOC3ivmQ9q4TVcaXlSa8XfGJ64+C3dtprtwdL8Zd40estgr1St9UZROOth71Wpxf+Og86/Pvug9yn6oby/rjrfOHujSY9R0jreoWHvaEjFTmlY9chPu+o1z5q9HoD4Toy64Q3Lgftdo/fOOnRV26Ni6Hz5GPnWcfdVnfsXV6r3QtetnNVQlnvwU69i8SbGSvjXd9k0JNdonDdybdu0GsetXq9UeRtSmDkfmfE+CWOusKTTZwvhlHCcu8z7HgX9zoUCk/dqwh/ZPy9CAlr1OtdRN8w4ee1m8EzPETm1VTqwmumds9DZAwFllI9+dEfD5H5e2Uk/Y/bshL17BMW/w1vHQ19hho1XEm+ORYIa3rk/4EdNz25vilQw7TlK/je52gift950Nh7qsZYVPtbUzYKZH/vxu7IedAgfh3i8/aCB9J1ZNZh4Y3enRrBR7937H51PAjWlsOB8/XEfX1D76m6zhLHe8oL/1K7Ylk2OD6i9yQidkXLOF9OnJfZlFyieN2tSfyt8/911Iu8TTFctP3vdIJ3s9sTvgwuvzUSCcu5Tzd41R3hvkP/1QRvl/heeD/j46NB7A0Tfl5sB4NneIiMwbxjLlBJunV4iIy2c0KhnkRa4uLVi7l8ZW7LitWzSlgt92OZJKxGdzDsNY4a0wRhTY6PWs73mkdN8gI7X/SchcLRsfPrP2m4Xwxa/mfBeZDzR919qqb/iWoMJ+NB0/lUCn+xu0fto+NmaxS/DvF5R71OsNQJryOrDmeSVnvg3udo5L/q5mAyGTT8D2PTqdpotrxVhftMzsd54L7s7rG/MfMIi8qOj48H4+mw7Z8dxghLLON86TxxqyO5xOC6u6PpqOPTovgSB87//BWW8DYlfnCtIb0E5yu3gENiw4Cv3OtotqKE1fQv4ngg3Nf5KfbGF6N2QM7ie+FfYy/+hu3OCotJgmfCEBmD9BGxScU3meEGbmN2ggWvFw+CCTdwK3OxfxFbVqSeTcIaHbuie4Kw/A/AhS9wRQmr43+cL1q0lhkctbzNTtf9U9w66rz6S7eW/6CBcKbf8b+68H7tL4Ilh3M1x8Oo+OJfR+R5+W4luI7MOpxJusEysumtERoX/n2OJ96HNHgF4cFDJ3jZPf8quv6Dw7KD4C3rTSWEJZaZ8tVT4hL96+4Fd+4mXmKXP5HwNkW33q0L/2KawWHvBVnGpsf+Uy/bUcJqBJzkvWr3oryVWrjMDMibvxdNbw3oXUfsDeM/L7ZrrqzHV+OpoQnXgihlcfHq0V498RQwPNUrZLxStGUJ9SzaGpr+Zy25wgol2EacsF6Pj30VZ7IUHEu+prKYuhr1sf9bfdFwacDdH4WbDtrqBdsbIqwOkxGW+Lxxwsquw5kk2Hd5tNwJFyw+ZwSfVcG2cXT0GpDeMklYvVRBPFaGf5m8RO+6G8vwtS7jLzEkrMjblFLyQnjj/GvkP7bYljDcPrbCvy6RX4Qui78Xzt+pdsCbkTdstwiLgmd4iIyd0fOhTYoHz1zfb2zkwMfr8SAYHiIzszLSkNuywnrfbRpHjzrLDMLyP3sRwhpLjpEaRwvhoKvJaYz2b+4iYOCvQcYywupKCUt83jhhZddh4los/EA2w8VXz/tAcmoLn9hZSHj/X/qMk1hhHQ9T2UMsw7+UXiLni1dvXRd9ibTCauY4SCOXGLxvSd4XnzMsPIr8AHv+Y8T3YulsTJfBy4m8YTtGWEHwDA+RsTcRNfQceFIW18bt1/OCYHiIzNzaBNZwARfU+2uFsFpib04aYTFvyRAhrEFSwwk/6MHvdou3tvSET6//19oRR46areD4K4+wIs8bJ6zsOnEm8ZYIx07pYF3ZkhHWJKx3LCOsV0eiajha1UUGYbUilyK9xF6wtm213A1o7CWGb0TkbYqp7sNex3twkrA6ibdRTlj+N8eDbtt1DicIq801/NgbtnOE5QbPPL/aH+AsUMg8FK9eKql3fxmGyNxefrWI0Jbl17MquucR1ihGWL0kYY3khOV9fuJE4py7uwdP7YUCYY3UCEtaR8Ikr0fh56/lKuK6hOXYErxLb070CUu4RCKslnPKMJITVuRtir7XjXBpnCSstgZhLdt8iR0jLOeWY/+r+Bu2g4TFWBX0EYtqN+AT1a1nfI5h1lzD7RKWwgprIn7qBrkrH8dx1fA+RHmENckirIH+CqsRNfXrEpa/LGlKTwmlhCW9xEGkpXqSQlji2xRZXzXcU8KULaHOCqt3dOycEsq2hJ65ozHxt/qRN2xnCevVOn3o5omarWfIeKWcllUFYflyc5ywJp62GyGskUTDClXmqODrfQikRBI8iYywItchPm+csFTqiOLSMCFlFyEsT1ifZGhY4qVILzH2/kVfYjfKUMn3engUHHnICKsXcqECYYVnlRINy/tuW6L97yxh3f6sBLfbqnf1tRJcVUdYy8Co9NoICCs4yfI3NRHCWjSCc61Jb8nEBYT7NN0pW4bfd+SZZYJIpsFjvQ9NkrBi1yE+b5ywsuuQozO8z4WwRfO7kHU1rCGLKtFpZfilSC+R3+i/qOhLDN+IyNskW2VOZIQ19m1zno0rj7DCY8GulLAmvm809obt7pbQ/o4wukerut7TpX26EvaE9gnL+dx4/p7ucUBYx91X39s9SPiweo4N3ndoDwTVfeCTRcf7vvtZmvh/w6NEMmkeD4kIFwnCil1H5HnjPqysOsQk7akv/LhPMHX+5345bgQ+LC3Cavlf+qQ0bjbHqWX451p6ib3AEN8JDCXiSwxKRt+mYYMM72PPm+u4qI4lhOW8Iu+qHBtVLmH59ZznlhKWeyQ6Sbxhi93VsCw5DKSz5y06KNLrzX/Ypasfc1alhuXuxZrdniOxhlvCTrPbafgtKe4HuUW6tuPSce7bbYhajmO5bDgP96QP51T8uN1tOybvRZJIHDuF4+XuBDZFRw9qdSKEFb2OyPN6l9Ei20BmHc4kjne961ywr8k4As1xu9c5Ds2SSoQVlnV6WZq9Xtd/cPdIeANjZYiwpJe4aPqv8ag5TbzEgavIj2NvU+tIcGq03Ht3m12H2XsJwnIaapybuw2FFdbIq9A+dhbTrss18V60grW1+Ibxn9cu4t2sxT11fNe26q1/f7dHV99pXFhFhOX+qXXXCZywll5jW2cR8pHQw+e3sx13lxE7D7XHLbpeA1r3gkmIZNgS+vHc1rdmVLqJXEf0eb1WOOFAMLMOX4v1hCdgI7GzUJGwwrJs3DnmDx4cpZchwpJf4sI3wXWmkrfOvb5h7G3qBPtkv5bXD9hajL2lUYyw/DbP46GKrWHo39XlRhlhTXzXfOQN4z8vBum9oPy9zXrWpHdBbrdGWEksx6NpPEU5zbw4HSfClRfi3Sep4csu340zYzVj17HIuIzsOiFFuHeiXxLXe7Ys8R6FD26LJJIoI71EIjL3xnHOS6S3adk4Xqi+f8ucdyR2afk7vHJv2CfD0oq0NBfevuf5/Nm2lCWKVze/eKSMg3s7Tvf7SL15RYS1i5haE12mx81X3TJFr2Z41MGPsiI8me/te4oTVEQNt1rv3nVffbsUCOXafC/hdaye43sHYX04wuocj5g+YR0XKXXRbEzxo6wKBsNlognIgln0z82qinp8Cyhu2VZXRqUsSlwWt5wgrI9GWJPeSLeMm87SKlJr1JvgJ1mplGWOPwQxKaJYiSrT69xKvWeRmb5f0Ub0rznTO40Li9YDYX24FZZ+mVE0WxBgO29xEKwFiZgtmidopV5iISUuhW4MSVmCPBatB8IqKqJWoxcrlZmOxkv8RD4HjMRi0fgu9v5wLUtIfrdVby1L6fuHrAcbEyl+PHE5WQ+EBQCfS8oSxKRUOhIpxmS9NGX9x/XGmJQlrNiS9UBYAFAxVqWkpflKacMnbuJM1cuKvfo1N5PfIGYzSOqBsADgE0lZAg/lxWwJtiwj9fL0KUF3Ki5l5T0JCAsAtiFlFeqeuaadnoozlGxZm6ey9e7zl02CLWtdTMoSxLCUeiAsANiKlKXfPcPHdymn9Am2rHL1FHtvBFtWgZFffLRXRj0QFgCwTxE8Q+sljVZBwZZVvN6zOvkItizd4BkSrzLqgbAA4DNIWSQmac43FGxZfwvV0zz2Ew75dIJnKEQmsx4ICwDYhw+eoVCXd331iyirQL0CahQpUcrBM9+Fh2TWs0BYUw3T9cRPBwj+x8bobAPYnnXr/NHZ1xX0gc6eNjrdQUK9Yi3NZMtSEr9I+sqtZ4Gwjo96GmkBTeF/vWItvADAdjl4hkJkStgTHlXdEKJ4VXzeINmy8oNnKEQmv555wnqVE9ZYmqWUIKxX/AIDDMEz0lCXcvMNyZalWq9cYyA5qrJXTRQio1LPwgprPFhKc0iHuYS1HKCFF2Do1pH2xZSP5OOUpVTvvmz0AtmyMmR0kujV6lUmuqsQVjK2Er/LwF4Hz3Axycx4VL7ZS+vW4fWMhB6TNpUSPEMhMqr1KiOsjjZhuYOC8ZsMsP21OHBrgbGMdpLTH7LqPZvK4iNblmy/x3eN6vUsENag527sxr2BEyzXavsTBnvOpOF2L4iLG3RanYGMsNzH+Df32p1B2xm9EuTTtdth0pzz5K/O47t87zh2vtkN5bFxt9XpLfDLD7AdCJ7hiQtrk1Nw+J4vsS/k9YxGh/I9XyJ4hofI6NSzQFjNcDrO0Bvr4k2cOvIx8ifb0SiXKGGFUlbbv3cw7qbnPc1xOA3KH/oSTqfyp8T4Mr8/cgdZdsAuSFmcWN4frk0P6lrLkko5kZlItJLaslbRpNJVkXo2CavZHQyc8VXdyApr0jjqjqajzlHzIo2wnBmhw8lkEIwx7h41B95XwcC/VnswdGbteeM3nW82esOBP9zOmR7WHk7HveNjMBbAPnnwTBjqYiSAL9WW9ZKsd21hLCq3ZfHgGR4io1vPImH5M9Z7wRy7cDpdKzA9+MOJZYTlDFwf07A7Z9TdRTCX2B+p3Ha/coba97zpnuEUU28sdDuYcNfEbz7wqaUsEpMsTXHmtqxYvbmVaV2CLcuXsrh4pV3P5gqLiaHkAWFNjhrLcD7nUk5Yk+AR4dzzHhOYrhnsBf0Rnr3wmy5tBTzHFsdHWGIBnzh4hoe6PM9/WkO4ynK6dXi9G0t0JXKUswPke8QC9awTVsgjAWGFM4LZq7cCyyesZsg+/gKqycc2t72Ro3T0yGcrO9Q2wO898Gnx9mZzFmryTDCsd3/57atFcFvWy0uJelUTlrNDbPnw5qZLNaxGeNe21+jT9O/f9KguJKyB982GsJZy9ozBMzc0eoMA4IPKWbamzYuuq5cKps2nzJ0vWG97hNVqjVJF98ZgNPLFc2ch1gzv30kQ1pFAWCNOWK0WVljAJ8etfbpycRvWMzsENd3jULZe9VvCNks1joaP6fpGhiGLLaIShNU8GgkrrAZ+zQGGmatFbKQmZ6AqTUctWq9qwhpFj/CkhHXRbnR7vcE0EKSG6YQlqlUXx0cIpwF2B89z23w1fxHr2VTcEwMmCtermrCWgbuKLbvTNMLqHAvBDr1QpR8Ok4TFJXzXXN8OpaseDgmBXcDDzKrm/jdez4YFS5bKUKZeZYTV4sd7jWG2D4s1joWm52njqONS27gR+LBEwnLsWN1FaL1yRKzBK3xYAMPMVZVhzu/Jeit7SpY4z75MvcoIq+OK5w65LJzOnGbXsap7LTuOF6HV5f8LV1h+u02j2fPN8EfH7Z5vZo8TlvO/o+NOr33kUZzTptPwvsAKC2C7clZoR7y6fRdYkSY7l5uBqjYd9eVK4C7tepUR1rjhcJBLQAu//a8zDQzv3q7O/1/wmFEjaD3023dGXvOhvy6LExYbevdt+kuygf8F+ArAzNVMOwPlZHqditfCcsuGlCWIVyu3c1AYP6hbbxtDKJycq9E4KzbZT3iYjAN2enXuP1qm3Hs5GY9G4fs/zX5mAGCfP8XBlGHUxeMsltQgSVUo3/y8ofmqP+Kh75r1PuDUnNbRhAvucIACgFEpSxjmHDmIFGjMTryMg9kvWej7tuNlzGwpmdd5AwcoABiUsv4IelW89YdC381JWaJ4FW90FjaK6vU+IGF1PaP7aOQEXzURxgcA5qQswXkla/0Rvm1GyhI46fYyI/Rdvd4HJKwgh889/5vgFxUAwhQHg+LV81y+y7xZGZSyBPEqZQkldBcq1vuQk5/Hg16vNxwv8VsKACRllWuHpmHOWTtMoVvnpZyUJYhXGY3OFPquVg+j6gHgs6BE4IxARK/ZGj4NtnfWRcX5isSrHCISiE2hHggLAHZfyiJ1an17nX+Q+F529DOdAa7yt3qCLSu3HggLAHZdyqI59YoTLciWVWgkBTEQN14phr7n1gNhAcBuS1lkZdg8zfQFem0p6/vVi8x4pboky64HwgKAnZay5qti+0myZelJWSRe6e0nyQKRVQ+EBQA7LGXRSkk/X4uEr3mBldLtZdHQ96x6ICwA+IRSltow6OtwACF7uSl0tLji0tJ3PfGqkFeebFmp9UBYAMA+ZYbyH3Urw2tRCxc9hcLQCOKbwhMtvnFbVspTgLAAYDelLL6jK9U8Tbas+5x94a97E45TsmVJ64GwAOCz4nGmYGV4v78um+/wrpBpzBOQ12V7emhfKakHwgIAtnPBM9zKYCRNi9uyUoNg+LpoYyIYntuykvVAWADwibGaZ1oZTOWV8sNGqZhOITJzQ3ml/LAxXg+EBQBstywOnF1MTgrjtqxkEAx3UJmMV055UhAWAHxubJ6upVaGl7mdMYYxkYpLTvdmB1hwW1akHggLAHaoW4eLV6ubP+YHRa/CY8BviT6cwk4GBZuEUA+EBQBsZywO4Sro9eaP1dn295fRPpxnOxMNeVpWWO8KhAUAu4C/MxrmvL6//mkJ3JY1c04Df8yqG8Dq1nN0LRAWAOwG7u+1ImRK27KurgwZrxRtWVe/nf+AsACAYYxhIVuWMeOValoWCAsAGCJJi4+zmP/6WgEoAwKEBQA7JmVVQFh82M3sRxWEFYplICwA2C283/6xTVd/bt+p3tqe4E7C+xpbQgBguxo8Y5evaP5OsKi7/GaTrr5d/hWKgbAAYOeErLk9uhIG2jNmoSUnY3g0CAsAdhNPlqSs2ZNAiwJ12Toq5KE1DuY3ICwAYPsVPFNOvFpHVnHCasuKd1SYsepGxLuhECAsAGD7EzxTaje4Sm0FKprini1ePbH4IB205gAAPFl63iuxU/GPIMGblbIE8eovmp8BgO1b8Iwhd3tstynsEzfmmnT++b2RTlYFYQEApKzclAZOSpLGappTYUrKEsSrVZQEQVgAwDAmWnGiakqnorD+erosz1ckXq1//0CmOwBAyiokXqU3/lCzTun2QmocZLNfmJoDABgTrZMms1Hzo5LHoVTeDA35kjIfCAsAGMZE54tX+fZ5oqyX4pOfXwTjFQapAgCkrCLildrj6f73haSscO5EuqsLhAUADMEz2bqU8gpNsGXpB89QiEz6RAsQFgAwWByyQmS0Hki2LM3gGQqRecl4IAgLABA8kxEioz3RgmxZGsEzFCKzypTsQVgAwBA8k6afF4qIJ1uWarcO78NJGK9AWACwx1AhIAqRKZq4TPKXSvAMhcjM8ggOhAUAkLLkKlSZIEC+Rsvt1qE+HAXLKQgLABiCZyQhMmVzSzllZQbPUIjMrYoTAoQFAAzdOok+HKM9iOlSFhevFOO0QFgAwPYweCa7ibmwNT7FlpUSPMNDZP6qWuNBWADAIGVF+nAM5itzQUwiZXHx6kXdsQXCAoD9xOtcvoFb3xuL/YvYsuLBM6F4tdLplQZhAQCDlMXFq0LGK0VblngKGIbI5BmvQFgAAMQylHmIjJ1R96EtiwfP8BCZmWZ4FggLANieS1lcvLI3gTX0OHjBMzxERj/rzzxhLceTlO9Mp+5/xtP4fReTii4AAACWCJ4JxSubA6OJsu4vwxCZ2wIRNOYJa9IeyL+xaLcXjI3aI/G+Pee/3fa4kgsAAMBq+LtqWhYrPMewQsJadjpLKWH12iWXROPBm1dgMAZhAQCrMpO0kC1Lw3i1PcLyISGs0hi0vffhwq8MwgIAXdz+rAS3Yb2rgpHvH5mwJl1F6gkIawrCAoAPuyOM7gkLjgOzQ1iT4dDf5U3GF4wr7eOxQFiL8XC89AlrMl76Ujl/mPuIwXDQ7bn3nQwHg1DkGg+H7p39px6OJv4/HBFsPFmOh+2eW4ITlvN0fvkQF07NRfD8o/CfTvWpc7uzqZw4t+EXF2BwZVmBMC7Mw/zHRyGsYdtBz+WKoa+nDz2W6nSIsEYd5y6dsUdYA1fDch42cB/mkc2y1+502+2hS2w991bvn+6Sq9NxHuX8882/eeA93PvX1PtfmxPWgp7Dx8K7Y2fIwsd0Rv4/x+4X3YuB/z/84gJ7inezFve44f09Xm/9+/uHIKzuYLKY9DwuSiOsiUMc0+m4JxKW+7Bxx3vAoD18ZReeGD9sD6fOs7lEMu10J+xt1Ha1e4fqxhfO48dpK6y3XsdZNTnf4oJ+rz2YXIy8I8lh263VC2o5z+Rebtf7H7aTAIP0blFuF6EvvVshLO//XZ9u5ITlcwWLrLC6vsQ18B775n134N7T/efbhfegqb8kcp9h7KtWPZ+KXll4/5CwhmGFQVQvmw6mfNPY7bx6Kyx3+dXxmG0aXDwA7CeWVqSs+ZIq3PzikTIO7n99FNF95O7G0gir0xVIJNwSEgV59wwJa8xtEb2EUu/zi4yweh3/Hp3g/+GliP/0/j/w12Dd9iJydwDYTzyZ7yV8EgjKdV99o/mDahnKVRCWRx8phBWsjCSEtRScWUOX8hyBqTsYLYK9pgf/wY6C7vwzlbA6Hf/OHW+FxjgxMcH45XFqcHuvvfQXXfiNBRi6dQzuBnnisrAF/Hb1lwJQdcaBbYewJjmENW53x+Nhp+vxlMM5nj7u6F49H849p47o3u31MgirHdy5t4iyVISwBiAsACgzDkx5XJhzDCky0/crOjTUGAe2HcK6aHczCYt554zdsOtwMnQVpqlo2uq1vVVXJ5WwEswzoC3hgG8JscICAGbP4iBYGRILKRo+oT4OzAph9RjXxn2mkmhYnWXmCqszmoxFT9TYpZZOx9/dXXDxKkvDClZRFyRc+Q6HKb8qvzAICwASMBKLRfMJKVgmmpDMd4sbxRQ/G4TVcRlg2nHP9MbhMV6MsAY+twzSNCx+Vvc2GHB//MCnnKH7/D55jdMJK6g8dl1bE9eP6hwALr3vDt1/XvDzTBAWANiQsgTxapOmrP+43uhJWVZsDZ2RI0D5bqiu643qdUXC6g2WLp0NRuNBN4WwBr5cNZi4FtLucDzw2O/CedB4PPCIZ+DePOx2O4MLz2E18J6iNxh6zOR+5TirnHt0XHbrBszkPGTU6XhLrI77vcCHBcICAKY7DizXykAbvqzYqzB5lKnlN1jRsFwbu+8od83pjuld2BIuul7KzMR1qvfGKYR10fFt6w6j+P70nm+7cv/dGSy9ZAbPKT8K1nFtt4DrfveZyWWi16H7JL2JR0YkjHk3uIbS8ElBWABgXMoSxKs8fUqwZeVLWXYSRy/GkzdOYONx2n3SHj712W469jR15wm47Ww54U+8EG5O487JkjEhNHA5od7C6RhNOACQK2UV6ta5JvHqPn/ZJNiy1nlS1oeMSB6GDoQe1jsAsF0pS79bhycuK/feCLasnJFfH5SwvBXWcmQmLgsAAFZZ8AyFyDyrW0IFW1Zm8MyHJCxHkndMoY7M1EE6OwCwzyRlkXil5WCP2LIygmc+5tQcJ3lh4Jz45YpUAACwDxQ8QyEya53xqHFbVnrwDMZ8AQDAjATPUIjM5rpIOp9gy0oTv0BYAAAYCZ6hEBn9eYNJW5Y8eAaEBQAAKx88QyEyN4XpKmrLkq3SQFgAALCy3TrUh3N/+e1rKZAtSyLbg7AAAGAlg2e4eFV03mCKLSsRPAPCAgCAlbI4cCvD89X3r0ZAtqzY/hKEBQAAKxE8w0NkVqboKmLLigbPgLAAAGCFpSwuXhUwXinaskQiBGEBAMCKBs+EITIFjVeKtiwKngFhAQDAiklZXLya//pqBdyW5UtZP2YgLAAAWJHgGR4ic2OJrkRblrPjdPeIICwAAIrg7c2Q8UrRlvXipkCAsAAAKA4jxivltCwQFgAAxWHSyZDlcQBhAQBQfoF1+c0+X327/AvCAgDAAGwq7okpFSAsAABKYWPaMRr3j24YCAsAAFNY2VOyxHn2ICwAAEzgyY6U9e3ySWDFKxAWAADso0pZgnjldSo6rTogLAAADMBe87OD30Gn4i8QFgAARvBiNl6GjzcUOxVBWAAAMFNSlim+EsSryGYThAUAgDHMjaTM/OCzc+KdiiAsAACYQSmr9L7wO4lXiU5FEBYAAOzjtEMLrc7PmJoDAIBt3JewOPy6z7SjgrAAADCNooHJP65zXBIgLAAA2Ifo1qE+nNSIeBAWAADsAwTPCCEy6RHxICwAANj2u3WoDyfrcSAsAADYtoNnKEQmOyIehAUAANuulEXiVZ4nAoQFAADbZvAMhcg85/IbCAsAALZFKYuLVyrLMRAWAABsa8EzPERGLZ4GhAUAANtS8AwPkdkoWk1BWAAAsO0Ez3Dxaq7qgABhAQDAthE8w0NkNAxbICwAAFj1wTM8ROZexxIPwgIAgFUdPMNDZDTDaEBYAACwioNnwhCZZ90eaRAWAACs0uCZMESmQKQDCAsAgCrhDURlBeeCgbAAAKgem2IZfyAsAAAqx7xgijIICwCAyjH7AcICAIDt9jgwEBYAAOwzZCiDsAAAYJ8kQxmEBQAA+1TjwEBYAACwzzIODIQFAAD7LFIWCAsAAPZZpCwQFgAA7LOMAwNhAQDAPouUBcICAIB9hnFgLv4fSoIZXvX6SXQAAAAASUVORK5CYII=",
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
    "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" +
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
    "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" +
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
    <div class="bs-card"><div class="stat-row">
      ${entStat("Permit records", permitCount ? permitCount.toLocaleString() : "Refreshing")}
      ${entStat("Updated through", updatedThrough ? entDate(updatedThrough) : "Unavailable")}
      ${entStat("Scheduled base ingest", "Daily")}
    </div></div>
    <section class="bs-card">
      <h2>Primary source</h2>
      <p>The base feed is the Seattle Department of Construction and Inspections public building-permit dataset published through Seattle Open Data. Building Seattle reads the official machine-readable feed at <a class="ent-link" href="https://data.seattle.gov/resource/k44w-2dcq.json" rel="external">data.seattle.gov</a>.</p>
      <p>Where SDCI publishes a record-level detail URL, the corresponding permit page links directly to that official record.</p>
    </section>
    <section class="bs-card">
      <h2>Ingest and enrichment</h2>
      <p>A scheduled daily ingest upserts base permit fields. A separate enrichment job retrieves detail-page fields that are not consistently available in the open-data feed, including parcel number, review level, review milestones, contractor license details, housing-unit changes, and fuller descriptions.</p>
      <p>Dates and statuses may change as SDCI reviewers update a record. Page-level “updated through” labels report the newest source-record timestamp included in that result, not the time a reader opened the page.</p>
    </section>
    <section class="bs-card">
      <h2>Derived entities and matching confidence</h2>
      <p>Permits are the evidence records. Address pages come from normalized street addresses. Projects group permits that share an address and have related timing and work signals. Contractor and participant pages use names and license information published on permits.</p>
      <p>Entity grouping is deterministic but inferred. Similar names, shared addresses, incomplete licenses, or changed project descriptions can split one real-world entity into several pages or combine records that later need correction.</p>
    </section>
    <section class="bs-card">
      <h2>Values, units, and completion</h2>
      <p><strong>Declared permit value is not verified project cost.</strong> It can omit land, design, financing, owner-provided work, later changes, or portions filed under related permits.</p>
      <p><strong>Repeated demolition valuations are counted once in totals.</strong> SDCI often attaches a redevelopment's whole valuation to each of its demolition permits; twelve demolition permits at 4747 30th Ave NE each declare $129,000,000. When a demolition permit's value matches another permit at the same address, totals, rankings and project values count it once. Each permit's own page keeps the value SDCI declared, and construction permits are never de-duplicated, since identical values there are usually separate buildings.</p>
      <p><strong>A permit record is not a completed project or dwelling.</strong> One property can have several related permits, and applied, issued, active, expired, and completed records represent different stages. Housing-unit fields are presented as reported and can be incomplete or revised.</p>
    </section>
    <section class="bs-card">
      <h2>Analytical classifications</h2>
      <p>Insight pages use documented, reproducible rules over public permit fields. ADU/DADU classifications look for explicit accessory-dwelling language. Commercial and tenant-improvement reports use the inclusion rules printed on each page. These are research views, not official SDCI classifications.</p>
    </section>
    <section class="bs-card">
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
  const description =
    "Building Seattle turns public Seattle SDCI permit records into searchable property, contractor, project, and neighborhood views for the metro area.";
  const socialImage = `${BASE_URL}/social/insight.png`;
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "AboutPage",
        name: title,
        description,
        url: canonical,
        isPartOf: { "@type": "WebSite", name: "Building Seattle", url: `${BASE_URL}/` },
      },
      {
        "@type": "Organization",
        name: "Building Seattle",
        url: `${BASE_URL}/`,
        description,
        logo: { "@type": "ImageObject", url: `${BASE_URL}/icons/icon-512.png`, width: 512, height: 512 },
        knowsAbout: [
          "Seattle construction permits",
          "Seattle Department of Construction and Inspections records",
          "Seattle contractors",
          "Seattle neighborhood construction activity",
          "Seattle housing pipeline",
        ],
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "About", item: canonical },
        ],
      },
    ],
  }).replaceAll("<", "\\u003c");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  ${themeBootScript()}
  <link rel="preload" href="/brand/fonts/IBMPlexSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/brand/fonts/IBMPlexSans-SemiBold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/brand/tokens.css">
  <link rel="stylesheet" href="/brand/bundle.css">
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="robots" content="index,follow,max-image-preview:large">
    <link rel="canonical" href="${canonical}">
    <meta property="og:title" content="About Building Seattle | Seattle Construction Intelligence">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${canonical}">
    <meta property="og:image" content="${socialImage}">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="About Building Seattle — Seattle construction permit data">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="About Building Seattle | Seattle Construction Intelligence">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${socialImage}">
    <link rel="icon" href="/favicon.ico" sizes="32x32" type="image/png">
    <link rel="manifest" href="/site.webmanifest">
    ${renderDesignTokens()}
    <script type="application/ld+json">${jsonLd}</script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family:var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif); background: var(--bg-alt); color: var(--text); line-height: 1.7; }
        .container { box-sizing: content-box; max-width: var(--container-max); margin: 0 auto; padding: 0 1.5rem; }
        .hero { background: var(--brand-navy); color: white; padding: 5rem 0 3rem; margin-bottom: 3rem; }
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
    <a class="skip-link" href="#main-content">Skip to content</a>
    ${renderNav("about")}
    <main id="main-content">
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
                    <a href="/permits" class="btn" style="display:inline-flex;align-items:center;justify-content:center;padding:0.75rem 1.5rem;border-radius:0.5rem;font-weight:600;text-decoration:none;background:var(--accent);color:var(--on-accent);">Browse Live Permits</a>
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
  const datasetColumnCount = developmentSitesArePublic(env) ? 38 : 32;
  const canonical = `${BASE_URL}/data`;
  const title = "Seattle Permit Dataset — CSV Download | Building Seattle";
  const description =
    "Every Seattle construction permit as a ready-to-use CSV, enriched with parcel numbers, review levels, and contractor licenses. Free 100-row sample.";

  let stats = { permits: 0, contractors: 0, neighborhoods: 0, total_value: 0 };
  try {
    const row = await env.DB.prepare(
      `
      SELECT
        COUNT(*) as permits,
        SUM(${countedValueSql("permits")}) as total_value,
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
  const socialImage = `${BASE_URL}/social/insight.png`;
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Dataset",
        name: "Seattle construction permit dataset",
        description,
        url: canonical,
        creator: { "@type": "Organization", name: "Building Seattle", url: `${BASE_URL}/` },
        spatialCoverage: { "@type": "Place", name: "Seattle, Washington" },
        isAccessibleForFree: false,
        isBasedOn: "https://data.seattle.gov/",
      },
      {
        "@type": "Product",
        name: "Building Seattle permit dataset",
        description,
        url: canonical,
        brand: { "@type": "Organization", name: "Building Seattle" },
        offers: {
          "@type": "AggregateOffer",
          priceCurrency: "USD",
          lowPrice: "49",
          highPrice: "89",
          offerCount: 2,
          availability: "https://schema.org/InStock",
          url: buyUrl,
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Permit dataset", item: canonical },
        ],
      },
    ],
  }).replaceAll("<", "\\u003c");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  ${themeBootScript()}
  <link rel="preload" href="/brand/fonts/IBMPlexSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/brand/fonts/IBMPlexSans-SemiBold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/brand/tokens.css">
  <link rel="stylesheet" href="/brand/bundle.css">
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="robots" content="index,follow,max-image-preview:large">
    <link rel="canonical" href="${canonical}">
    <meta property="og:title" content="Seattle Construction Permit Dataset | Building Seattle">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${canonical}">
    <meta property="og:image" content="${socialImage}">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="Seattle construction permit dataset — Building Seattle">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="Seattle Construction Permit Dataset | Building Seattle">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${socialImage}">
    <link rel="icon" href="/favicon.ico" sizes="32x32" type="image/png">
    <link rel="manifest" href="/site.webmanifest">
    ${renderDesignTokens()}
    <script type="application/ld+json">${jsonLd}</script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family:var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif); background: var(--bg-alt); color: var(--text); line-height: 1.7; }
        .container { box-sizing: content-box; max-width: var(--container-max); margin: 0 auto; padding: 0 1.5rem; }
        .hero { background: var(--brand-navy); color: white; padding: 5rem 0 3rem; margin-bottom: 3rem; }
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
        .content a.bs-btn { font-weight: 600; text-decoration: none; }
        .content a.bs-btn--primary { color: var(--on-accent); }
        .content a.bs-btn--secondary { color: var(--ink); }
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
        a.bs-btn { text-decoration: none; }
    </style>
</head>
<body>
    <a class="skip-link" href="#main-content">Skip to content</a>
    ${renderNav("data")}
    <main id="main-content">
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
                    <div class="stat-card"><div class="num">${datasetColumnCount}</div><div class="label">Columns per record</div></div>
                </div>

                <h2>What's in it</h2>
                <p>Every construction permit filed with Seattle SDCI, cleaned and deduplicated, then enriched with data the open data portal doesn't have: <strong>parcel numbers, review levels, full detail-page descriptions, contractor license numbers, review-cycle counts, and housing unit breakdowns</strong>. One UTF-8 CSV that opens in Excel, Google Sheets, pandas, or R — plus a full data dictionary.</p>

                <h2>Try before you buy</h2>
                <p>A <strong>free 100-row sample</strong> with the same ${datasetColumnCount} columns and real enriched data is available on the product page. If it doesn't have what you need, don't buy the full version. If you do buy and it isn't useful, there's a 14-day no-questions refund.</p>

                <div class="tier-grid">
                    <div class="tier-card">
                        <h3>Foundation</h3>
                        <div class="price">$49</div>
                        <ul>
                            <li>Full CSV — every permit, ${datasetColumnCount} columns</li>
                            <li>Complete data dictionary</li>
                            <li>Free monthly updates via Gumroad</li>
                        </ul>
                        <p style="margin-top:1.5rem;"><a class="bs-btn bs-btn--secondary bs-btn--lg" href="${buyUrl}&utm_content=foundation" rel="noopener">Get Foundation</a></p>
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
                        <p style="margin-top:1.5rem;"><a class="bs-btn bs-btn--primary bs-btn--lg" href="${buyUrl}&utm_content=pro" rel="noopener">Get Pro</a></p>
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
                    <a href="${buyUrl}" class="bs-btn bs-btn--primary bs-btn--lg" rel="noopener">Get the Dataset</a>
                    <a href="/permits" class="bs-btn bs-btn--secondary bs-btn--lg">Browse the Data Live</a>
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
  const status = Number(options?.status) || 404;
  const code = String(options?.code || status);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  ${themeBootScript()}
  <link rel="preload" href="/brand/fonts/IBMPlexSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/brand/fonts/IBMPlexSans-SemiBold.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/brand/tokens.css">
  <link rel="stylesheet" href="/brand/bundle.css">
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(heading)} | Building Seattle</title>
    <meta name="description" content="${escapeHtml(message)}">
    <meta name="robots" content="noindex">
    <!-- No canonical on error responses: the page is noindex and a cross-page
         canonical on a 404 is an anti-pattern. -->
    <link rel="icon" href="/favicon.ico" sizes="32x32" type="image/png">
    <link rel="manifest" href="/site.webmanifest">
    ${renderDesignTokens()}
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family:var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif); background: var(--bg-alt); color: var(--text); line-height: 1.6; display: flex; flex-direction: column; min-height: 100vh; }
        .container { box-sizing: content-box; max-width: var(--container-max); margin: 0 auto; padding: 0 1.5rem; }
        main { flex: 1; }
        .error-section { padding-top: 8rem; padding-bottom: 6rem; text-align: center; }
        .error-section h1 { font-size: 6rem; font-weight: 800; color: var(--accent); margin-bottom: 1rem; line-height: 1; }
        .error-section h2 { font-size: 1.5rem; font-weight: 700; margin-bottom: 1rem; color: var(--primary); }
        .error-section p { color: var(--text-muted); margin-bottom: 2rem; max-width: 500px; margin-left: auto; margin-right: auto; }
        a.bs-btn { text-decoration: none; }
        .bs-btn + .bs-btn { margin-left: 0.5rem; }
    </style>
</head>
<body>
    <a class="skip-link" href="#main-content">Skip to content</a>
    ${renderNav()}
    <main id="main-content">
      <section class="error-section">
          <div class="container">
              <h1>${escapeHtml(code)}</h1>
              <h2>${escapeHtml(heading)}</h2>
              <p>${escapeHtml(message)}</p>
              <div>
                  <a href="/" class="bs-btn bs-btn--primary bs-btn--lg">Return Home</a>
                  <a href="/permits" class="bs-btn bs-btn--secondary bs-btn--lg">Browse Permits</a>
              </div>
          </div>
      </section>
    </main>
    ${renderFooter()}
</body>
</html>`;

  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

// 410 for records we deliberately no longer publish. Same template as 404 so
// error handling stays in one place; the status is what tells a crawler the
// difference between "never existed" and "removed".
function renderGone(options) {
  return render404({ ...options, status: 410, code: "410" });
}
