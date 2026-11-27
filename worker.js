// Cloudflare Worker - Fixed Version

import {
  buildEntityGraph,
  makeSlug,
  parseAddress,
  unaddressableAddressSql,
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
import {
  ADDRESS_MIN_INDEXABLE_PERMITS,
  ENTITY_HUBS,
  MULTI_PERMIT_PROJECT_SQL,
  ORG_INDEX_POLICY_SQL,
  addressIsIndexable,
  isPlaceholderNeighborhood,
  PUBLISHED_ORGS_CTE,
  projectIsWithinAddress,
  projectPagePolicy,
  realAddressSql,
  realNeighborhoodSql,
} from "./entity_hubs.js";
import { detectNeighborhood, legacyMapPermitStatus, mapSdciStatus, NEIGHBORHOOD_BOUNDS } from "./sdci_mappings.js";
import {
  assertFeedPage, assertMappingHealth, buildFeedQuery, cursorAfterPage, DEFAULT_COVERAGE_FLOOR, detectFullReplace,
  encodeCursor, FEED_LIMITS, feedPageUrl, fetchFeedPage, planFeedRun, SDCI_PERMIT_URL,
} from "./sdci_feed.js";
import { PERMIT_UPSERT_SQL, permitUpsertBinds, STATUS_CHANGE_INSERT_SQL, statusChangeBinds } from "./permit_upsert.js";
import { countedValueSql, countedValues } from "./value_counting.js";
import { bsIcon, bsStatusPill, bsTransition, themeBootScript, themeToggleButton, themeToggleStyles, themedLockup } from "./brand_ui.js";
import { handleMcpRequest, MCP_TOOLS } from "./mcp.js";
import {
  DATASET_RELEASE, SITE_CONTACT_EMAIL, FOOTER_LINKS,
  countLabel, formatCount, smartTitleCase, displayName, statusLabel, isClosedPermitStatus, roleLabel, roleList,
  formatCalendarDate, formatMonthYear, latestSourceEventDate, renderDatasetCta, renderAlertCta,
} from "./site_content.js";
import { getBasisResetRadar, ingestBasisResetEvent, renderBasisResetRadarBody } from "./basis_reset_routes.js";
import {
  developmentSiteJoin, developmentSiteColumns, withDevelopmentSiteFields,
  ingestDevelopmentSites, getDevelopmentSiteGeometry, renderDevelopmentSiteCard, DEVELOPMENT_SITE_SCHEMA, DEVELOPMENT_SITE_FIELDS, developmentSitesArePublic,
} from "./development_sites.js";
import {
  ALERT_CONFIRMATION_TTL_DAYS, ALERT_EMAIL_DAILY_LIMIT, ALERT_IP_HOURLY_LIMIT, ALERT_RESEND_COOLDOWN_MINUTES,
  ALERT_SEND_BATCH_LIMIT, ANON_API_MAX_PAGE, FILTER_PARAM_MAX_LENGTH, LEAD_IP_HOURLY_LIMIT, LEAD_TEXT_MAX_LENGTH,
  PERMIT_NUMBER_MAX_LENGTH, SEARCH_QUERY_MAX_LENGTH, THEME_BOOT_SCRIPT_SHA256,
  apiLimits, checkRateLimit, clientIp, isCrossSiteRequest, isJsonContentType, parseIntegerParam,
  rateLimitKey, resolveApiAccess, slimPermitRow, timingSafeEqualString, turnstileEnabled, verifyTurnstile,
} from "./security.js";
import {
  cacheControlForbidsStore, dataDay, edgeCacheControl, hardenAdminResponse, htmlCacheKeyUrl, htmlCacheVersion,
  isAdminPath, isNoindexResponse, noindexIsCacheable, pageCacheTtl,
} from "./edge_cache.js";
import { claimEntityGraphRebuild, ENTITY_GRAPH_LOCKED_CODE, entityGraphRebuildLockedError } from "./rebuild_lock.js";
import {
  clampAnalyticsDays, PAGE_VIEW_RETENTION_CRON, pageViewSampleRate, pageViewTemplatePath, recordPageView, runPageViewRetention,
} from "./page_views.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Ingest-Token, X-API-Key",
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
};
// The CSP ships as Content-Security-Policy-Report-Only (browsers report
// violations to /csp-report, which logs them, and block nothing) until
// env.CSP_ENFORCE === "1" switches it to the enforcing header (review S4:
// Rocket Loader / Email Obfuscation rewrite scripts this policy would block).
// Flip it after a week with no unexpected violations in Workers Logs; see
// docs/deploy-runbook.md.
const CSP_REPORT_PATH = "/csp-report";
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    // No 'unsafe-inline' for scripts: the only inline script is the theme
    // boot script, allowed by hash (tests/security.test.js keeps it honest).
    // Inline styles stay allowed: templates use style="" attributes widely.
    `script-src 'self' '${THEME_BOOT_SCRIPT_SHA256}' https://static.cloudflareinsights.com https://challenges.cloudflare.com`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self' https://cloudflareinsights.com https://*.cloudflareinsights.com",
    "frame-src https://maps.google.com https://www.google.com https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
    `report-uri ${CSP_REPORT_PATH}`,
  ].join("; ");

function cspHeaderName(env) {
  return env?.CSP_ENFORCE === "1" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}

// Browsers POST violation reports here (application/csp-report or
// application/reports+json). Log a trimmed line for Workers Logs and answer
// 204; never store anything.
async function handleCspReport(request) {
  const text = (await request.text().catch(() => "")).slice(0, 8192);
  let report = null;
  try {
    const parsed = JSON.parse(text);
    report = parsed?.["csp-report"] || (Array.isArray(parsed) ? parsed[0]?.body : parsed?.body) || null;
  } catch {
    report = null;
  }
  if (report && typeof report === "object") {
    const field = (...names) => String(names.map((name) => report[name]).find(Boolean) || "").slice(0, 200);
    console.warn(`CSP violation: ${JSON.stringify({
      directive: field("effective-directive", "effectiveDirective", "violated-directive"),
      blocked: field("blocked-uri", "blockedURL"),
      page: field("document-uri", "documentURL"),
      source: field("source-file", "sourceFile"),
    })}`);
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

// --- Template-wide HTML edge caching --------------------------------------
// Worker responses bypass Cloudflare's edge cache unless a Cache Rule exists.
// While the owner's dashboard Cache Rule (drafted 2026-08-16) is not yet live,
// this layer serves warm public HTML pages straight from the edge cache,
// skipping Worker execution and D1 lookups entirely — the dominant LCP cost on
// mobile (cold Worker start + D1 query + 900KB script transfer per hit).
// Keyed by URL with a version prefix: bump HTML_CACHE_VERSION after any
// template change so stale entries are bypassed.
const HTML_CACHE_VERSION = "v11";
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

// The page's own browser TTL: its max-age (permit/address pages say 3600,
// insight pages 300), clamped to [60, 86400] seconds; 0 (never cache) for
// no-store / private / no-cache. The edge TTL derives from it (edge_cache.js).
export function htmlCacheTtl(response) {
  return pageCacheTtl(response?.headers?.get("Cache-Control"));
}

function edgeHtmlCache() {
  return typeof caches !== "undefined" && caches.default ? caches.default : null;
}

// Wraps the route handler: serve warm pages from the edge cache, and store
// freshly rendered 200 text/html pages back into it. Content-negotiated
// markdown responses and non-GET requests are never cached. The cache key
// (edge_cache.js) keeps only the query parameters the route reads, plus the
// template/deploy version and the data day, so tracking or random parameters
// share the warm copy. A page is stored only when its own URL is already in
// key form, is a 200, and allows caching (never a 5xx or no-store). A noindex
// page is stored only on the entity routes (noindexIsCacheable), whose noindex
// is policy; elsewhere a transient D1 error can render a noindex "no data"
// page. Admin responses are hardened here so no route can forget it.
async function withHtmlEdgeCache(request, env, ctx, render) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (isAdminPath(path)) return hardenAdminResponse(await render());
  const cacheable =
    request.method === "GET" && isHtmlCacheablePath(path) && !wantsMarkdown(request);
  const cache = cacheable ? edgeHtmlCache() : null;
  const keyInfo = cache
    ? htmlCacheKeyUrl(url, {
        version: htmlCacheVersion(HTML_CACHE_VERSION, env, developmentSitesArePublic(env)),
        day: dataDay(),
      })
    : null;
  const key = keyInfo ? new Request(keyInfo.url, { method: "GET" }) : null;

  if (cache && key) {
    const hit = await cache.match(key);
    if (hit) {
      ctx?.waitUntil?.(logPageView(request, env, pageViewTemplatePath(path)));
      return hit;
    }
  }

  const response = await render();

  if (cache && key && !keyInfo.droppedParams && response?.status === 200) {
    const contentType = response.headers.get("Content-Type") || "";
    const ttl = htmlCacheTtl(response);
    if (contentType.includes("text/html") && ttl > 0 && !cacheControlForbidsStore(response.headers.get("Cache-Control"))) {
      const html = await response.text();
      const headers = new Headers(response.headers);
      if (isNoindexResponse(headers, html) && !noindexIsCacheable(path)) {
        return new Response(html, { status: response.status, statusText: response.statusText, headers });
      }
      // s-maxage + stale-while-revalidate also let the owner's dashboard
      // Cache Rule, once deployed, honor the same TTL.
      headers.set("Cache-Control", edgeCacheControl(ttl));
      const upgraded = new Response(html, {
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
    const secure = (response) => withCrawlerHeaders(path, withSecurityHeaders(response, env));

    if (request.method === "OPTIONS") {
      // Same-origin form endpoints never grant CORS, so other sites cannot
      // preflight a JSON POST to them.
      if (isFormPostPath(path)) return secure(new Response(null, { status: 204 }));
      return secure(new Response(null, { headers: corsHeaders }));
    }

    try {
      if (url.hostname === "www.buildingseattle.com") {
        url.hostname = "buildingseattle.com";
        // Fold the path in the same hop (N6): www + /Address/X/ is one 301,
        // not a host redirect followed by a case redirect.
        if (request.method === "GET" || request.method === "HEAD") url.pathname = canonicalRequestPath(path);
        return secure(Response.redirect(url.toString(), 301));
      }

      // One URL per page: strip a trailing slash and fold letter case with a
      // 301, so /contractors/, /Address/X and /permits/1234567-cn do not 404
      // or split signals. GET/HEAD only; a redirected POST would lose its body.
      if (request.method === "GET" || request.method === "HEAD") {
        const normalizedPath = canonicalRequestPath(path);
        if (normalizedPath !== path) {
          url.pathname = normalizedPath;
          return secure(Response.redirect(url.toString(), 301));
        }
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

      if (path === CSP_REPORT_PATH && request.method === "POST") {
        return secure(await handleCspReport(request));
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

      if (path === "/alerts/confirm" && (request.method === "GET" || request.method === "POST")) {
        return secure(await handleAlertConfirmation(request, env));
      }

      if (path === "/alerts/unsubscribe" && (request.method === "GET" || request.method === "POST")) {
        return secure(await handleAlertUnsubscribe(request, env));
      }

      // Public JSON API and MCP: resolve the caller's tier once (anonymous or
      // API key) and apply the per-tier rate limit before any D1 work.
      let apiAccess = null;
      if (isPublicApiPath(path)) {
        apiAccess = await resolveApiAccess(request, env);
        if (apiAccess.tier === "invalid") {
          return secure(apiErrorResponse("Invalid API key", 401));
        }
        if (!(await allowPublicApiRequest(request, env, apiAccess))) {
          return secure(apiErrorResponse("Too many requests. Slow down or use an API key.", 429, { "Retry-After": "60" }));
        }
      }

      if (path === "/api/permits") {
        return secure(await getPermits(request, env, { access: apiAccess }));
      }

      const siteGeometryMatch = path.match(/^\/api\/development-sites\/([^/]+)\/geometry$/);
      if (siteGeometryMatch && request.method === "GET") {
        if (!developmentSitesArePublic(env)) return secure(new Response(JSON.stringify({ error: "Boundary unavailable" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
        }));
        return secure(await getDevelopmentSiteGeometry(decodeURIComponent(siteGeometryMatch[1]), env));
      }

      if (path === "/mcp") {
        return secure(
          await handleMcpRequest(request, (name, args) => executeMcpTool(name, args, env, request.url, apiAccess), {
            allowedOrigins: env.MCP_ALLOWED_ORIGINS,
            access: apiAccess,
          }),
        );
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
          return secure(await renderBasisResetPage(env));
        } catch (error) {
          console.error("basis-reset render failed:", error);
          return secure(renderBasisResetUnavailable());
        }
      }

      if (["/contractors", "/neighborhoods", "/projects", "/addresses"].includes(path)) {
        ctx.waitUntil(logPageView(request, env, path));
        return secure(await renderEntityHubPage(path.slice(1), env, request));
      }

      if ((path === "/alerts" || path === "/alerts/") && request.method === "GET") {
        ctx.waitUntil(logPageView(request, env, "/alerts"));
        return secure(renderAlertsLandingPage());
      }

      if (path === "/privacy" || path === "/privacy/") {
        ctx.waitUntil(logPageView(request, env, "/privacy"));
        return secure(renderPrivacyPage());
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
        const daysParam = parseIntegerParam(url.searchParams.get("days"), { fallback: 7, max: 3650 });
        if (!daysParam.ok) return secure(badRequestResponse(path, "days must be a positive integer"));
        const days = clampAnalyticsDays(daysParam.value);
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
          new Response(JSON.stringify({ days, sample_rate: pageViewSampleRate(env), bots_excluded: true, total: totals[0]?.total || 0, top_pages: pages, daily: daily }), {
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
        // 409 when another rebuild holds the lock; ?force=1 overrides a
        // stale `running` marker.
        let body;
        try {
          body = await runLoggedEntityGraphRebuild(env, "admin", { force: url.searchParams.get("force") === "1" });
        } catch (error) {
          body = { ok: false, error: String(error?.message || error), locked: error?.code === ENTITY_GRAPH_LOCKED_CODE };
        }
        return secure(
          new Response(JSON.stringify(body, null, 2), {
            status: body.ok ? 200 : body.locked ? 409 : 500,
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

      // POST /ingest/refresh (delete every permit, contractor and status change,
      // then re-import) was removed: it let the shared ingest token wipe
      // production. Upserts are idempotent, so a re-sync is the weekly full
      // sweep; recovering from bad data is D1 Time Travel (see CLAUDE.md).

      if (path === "/api/user") {
        return secure(await checkAuth(request, env));
      }

      // /og-image.png, /social/*.png, /icons/icon-*.png and /favicon.ico are
      // static files in public/, served by the [assets] binding before the
      // Worker runs (cache headers in public/_headers).

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
      return secure(renderUnhandledError(error, path));
    }
    });
  },

  // Two cron triggers (wrangler.toml): page-view retention on its own quiet
  // hour, so its deletes never share an invocation or the D1 database's
  // attention with the ingest (review S7); every other trigger (the 13:00 UTC
  // one, or a manual run without a cron) is the ingest.
  async scheduled(event, env, ctx) {
    if (event?.cron === PAGE_VIEW_RETENTION_CRON) {
      ctx.waitUntil(runPageViewRetention(env));
      return;
    }
    ctx.waitUntil(runScheduledIngest(env));
  },
};

// Entity slugs are lowercase (makeSlug/slugify); SDCI permit numbers are
// digits plus an uppercase suffix.
const CASE_FOLDED_PREFIXES = ["/address/", "/project/", "/neighborhood/", "/contractor/"];
const CASE_FOLDED_PATHS = new Set([
  "/permits", "/data", "/about", "/methodology", "/contractors", "/neighborhoods", "/projects", "/addresses",
  "/insights", "/insights/plan-review", "/insights/pipeline", "/insights/housing", "/insights/adu-dadu",
  "/insights/multifamily-pipeline", "/insights/commercial-projects", "/insights/tenant-improvements",
  "/insights/map", "/insights/contractors", "/insights/network", "/insights/basis-reset", "/api-docs",
]);

// The canonical form of a request path: no trailing slash (except "/"),
// lowercase entity slugs and page routes, uppercase permit-number suffixes.
// Other paths (assets, API, verification files) are left as they are.
export function canonicalRequestPath(path) {
  // A malformed escape is answered 400 by the route; never redirect it first.
  try {
    decodeURIComponent(path);
  } catch {
    return path;
  }
  let next = path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
  const lower = next.toLowerCase();
  const permit = next.match(/^\/permits\/(.+)$/i);
  if (permit) {
    const number = permit[1];
    next = `/permits/${/^\d+-[a-z]+$/i.test(number) ? number.toUpperCase() : number}`;
  } else if (CASE_FOLDED_PREFIXES.some((prefix) => lower.startsWith(prefix)) || CASE_FOLDED_PATHS.has(lower)) {
    // Fold letters but keep percent-escapes as sent (%C3%A9 and %c3%a9 are the same byte).
    next = next.replace(/%[0-9A-Fa-f]{2}|[^%]+|%/g, (part) => (part.length === 3 && part[0] === "%" ? part : part.toLowerCase()));
  }
  return next;
}

const DISCOVERY_LINKS = [
  `<${BASE_URL}/.well-known/api-catalog>; rel="api-catalog"`,
  `<${BASE_URL}/openapi.json>; rel="service-desc"; type="application/json"`,
  `<${BASE_URL}/api-docs>; rel="service-doc"; type="text/html"`,
  `<${BASE_URL}/sitemap.xml>; rel="sitemap"; type="application/xml"`,
  `<${BASE_URL}/llms.txt>; rel="llms-txt"; type="text/plain"`,
].join(", ");

// --- Request hardening helpers (audit A1/A4/A7/A8/A15/A21, F2/F11) --------

// Same-origin POST endpoints: no CORS, JSON or form bodies only, Origin-checked.
function isFormPostPath(path) {
  return path === "/leads" || path.startsWith("/alerts/");
}

// Public read API + MCP: tiered caps and rate limits. Admin and the Access
// identity endpoint keep their own auth and are excluded.
function isPublicApiPath(path) {
  if (path === "/mcp") return true;
  return path.startsWith("/api/") && !path.startsWith("/api/admin") && path !== "/api/user";
}

function apiErrorResponse(message, status, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

// JSON for same-origin forms (leads, alerts): never Access-Control-Allow-Origin.
function formJsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

// Uses the Workers Rate Limiting bindings when configured (wrangler.toml
// [[ratelimits]]). Without a binding the API is not throttled here: a D1
// counter on every API hit would cost more than it saves; the zone rate-limit
// rule is the backstop.
async function allowPublicApiRequest(request, env, access) {
  const binding = access?.tier === "key" ? env.API_KEY_RATE_LIMITER : env.API_RATE_LIMITER;
  if (!binding || typeof binding.limit !== "function") return true;
  const key = access?.tier === "key" ? `api:${access.keyId}` : await rateLimitKey("api:ip", clientIp(request));
  try {
    const { success } = await binding.limit({ key });
    return Boolean(success);
  } catch (error) {
    console.warn("API rate limiter failed open:", error?.message || error);
    return true;
  }
}

// Last-resort handler: log the detail server-side, never return it.
function renderUnhandledError(error, path) {
  if (error instanceof URIError) {
    return badRequestResponse(path);
  }
  console.error(`Worker error on ${path}:`, error?.stack || error);
  const json = path.startsWith("/api/") || path === "/mcp" || path.startsWith("/ingest/") || path.startsWith("/admin");
  return new Response(json ? JSON.stringify({ error: "Internal Server Error" }) : "Internal Server Error", {
    status: 500,
    headers: {
      ...corsHeaders,
      "Content-Type": json ? "application/json" : "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function badRequestResponse(path, message = "Bad request") {
  const json = path.startsWith("/api/") || path === "/mcp";
  return new Response(json ? JSON.stringify({ error: message }) : message, {
    status: 400,
    headers: {
      ...corsHeaders,
      "Content-Type": json ? "application/json" : "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

function withSecurityHeaders(response, env) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  headers.delete("Content-Security-Policy");
  headers.delete("Content-Security-Policy-Report-Only");
  headers.set(cspHeaderName(env), CONTENT_SECURITY_POLICY);
  // Machine-readable JSON is for clients, not search results.
  if ((headers.get("Content-Type") || "").includes("application/json") && !headers.has("X-Robots-Tag")) {
    headers.set("X-Robots-Tag", "noindex");
  }
  // Advertise agent-discovery resources on every response (RFC 8288).
  headers.append("Link", DISCOVERY_LINKS);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// JSON and agent endpoints stay crawlable (agents fetch them) but out of the
// search index (D12). A header set, not append, so another layer setting the
// same directive cannot produce a duplicate.
const NOINDEX_PATH_PREFIXES = ["/api/", "/mcp", "/openapi.json", "/.well-known/"];

export function isNoindexMachinePath(path) {
  return NOINDEX_PATH_PREFIXES.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix));
}

function withCrawlerHeaders(path, response) {
  if (!isNoindexMachinePath(path)) return response;
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
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

// countLabel, smartTitleCase and displayName live in site_content.js.

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

// Bots skipped, humans sampled, fields truncated; never throws (page_views.js).
async function logPageView(request, env, path) {
  await recordPageView(request, env, path);
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

const ACCESS_CERTS_CACHE = { fetchedAt: 0, keys: null, promise: null, forcedRefreshAt: 0 };
const ACCESS_CERTS_TTL_MS = 60 * 60 * 1000;
// An unknown `kid` may force a certs refetch at most this often, so forged
// JWT headers cannot turn every request into an outbound fetch.
const ACCESS_CERTS_FORCED_REFRESH_MS = 60 * 1000;

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
  if (payload.iss !== `https://${teamDomain}`) return null;
  const audMatches = audience === payload.aud || (Array.isArray(payload.aud) && payload.aud.includes(audience));
  if (!audMatches) return null;

  let keys = await fetchAccessCertKeys(env);
  let key = (keys || []).find((candidate) => candidate.kid === header.kid);
  if (!key && Date.now() - ACCESS_CERTS_CACHE.forcedRefreshAt >= ACCESS_CERTS_FORCED_REFRESH_MS) {
    // One stale-cache refresh attempt (rate-limited) before rejecting an unknown key id.
    ACCESS_CERTS_CACHE.forcedRefreshAt = Date.now();
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
  // State-changing admin requests (A21): only the X-Admin-Token header counts
  // (never the Access cookie/JWT a browser attaches on its own), and a
  // cross-site Origin is refused outright.
  if (!["GET", "HEAD"].includes(request.method)) {
    if (isCrossSiteRequest(request)) return unauthorizedResponse("Cross-site admin request refused", 403);
    const configured = env.ADMIN_API_TOKEN;
    if (configured && (await timingSafeEqualString(request.headers.get(ADMIN_TOKEN_HEADER), configured))) return null;
    return unauthorizedResponse("Unauthorized admin request");
  }

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
    { href: "/projects", label: "Projects", keys: ["projects"] },
    { href: "/addresses", label: "Addresses", keys: ["addresses"] },
    { href: "/insights", label: "Insights", keys: ["insights"] },
    { href: "/data", label: "Data", keys: ["data"] },
    { href: "/api-docs", label: "API", keys: ["api"] },
  ];
  const link = ({ href, label, keys }) =>
    `<a href="${href}"${keys.includes(activePage) ? ' class="active"' : ""}>${label}</a>`;
  return `<nav class="global-nav" id="global-nav">
      <div class="container global-nav-row">
        <a href="/" class="logo">${themedLockup("Building Seattle")}</a>
        <div class="global-nav-end">
          <div class="global-nav-links" id="global-nav-links">
          ${items.map(link).join("\n          ")}
          </div>
          ${themeToggleButton()}
          <button type="button" class="global-nav-hamburger" aria-label="Menu" aria-expanded="false" aria-controls="global-nav-links">&#9776;</button>
        </div>
      </div>
    </nav>`;
}

// One footer for every template (the homepage included); the link list lives
// in site_content.js so the privacy and alerts pages can't drop off one copy.
function renderFooter() {
  const links = FOOTER_LINKS.map(({ href, label }) => `<a href="${href}">${label}</a>`).join(" &middot; ");
  return `<footer class="global-footer">
      <div class="global-footer-row">
        <div>Building Seattle &mdash; Seattle construction intelligence</div>
        <nav aria-label="Footer navigation">${links} &middot; <a href="https://buildingseattle.gumroad.com/l/seattle-permits?utm_source=buildingseattle&utm_medium=site&utm_campaign=footer" rel="noopener">Buy the dataset</a></nav>
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
  // A date-only value ("2026-09-18") is a calendar day, not UTC midnight:
  // formatting it in Pacific time printed the day before.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim());
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: includeTime ? "numeric" : undefined,
    minute: includeTime ? "2-digit" : undefined,
    timeZoneName: includeTime ? "short" : undefined,
    timeZone: dateOnly && !includeTime ? "UTC" : "America/Los_Angeles",
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

// Source freshness, one definition for every "latest permit event" and
// "updated through" label: the newest applied/issued/completed date SDCI
// reports. Row-touch timestamps (updated_at, created_at) are excluded because
// every upsert bumps them, so they showed the render date, not source activity.
const LATEST_SOURCE_EVENT_SQL =
  "NULLIF(MAX(MAX(COALESCE(completed_date, ''), COALESCE(issued_date, ''), COALESCE(applied_date, ''))), '')";

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
         ${LATEST_SOURCE_EVENT_SQL} AS latest_record_date
       FROM permits`,
    ),
    dbFirst(
      env,
      // 'degraded' (see runScheduledIngest) still ingested data, so it counts
      // for the "last ingest" label; last_feed_status surfaces it.
      `/* homepage:last-ingest */
       SELECT end_time,
         (SELECT status FROM ingest_logs WHERE run_type = 'scheduled' ORDER BY start_time DESC, id DESC LIMIT 1) AS feed_status
       FROM ingest_logs
       WHERE status IN ('success', 'degraded') AND run_type NOT IN ('entity_graph', 'development_sites')
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
    last_feed_status: ingest?.feed_status || null,
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
       SELECT COALESCE(a.display_address, p.address) AS label,
              CASE WHEN (SELECT COUNT(*) FROM permits ap WHERE ap.address_id = a.id) >= ${ADDRESS_MIN_INDEXABLE_PERMITS} THEN a.slug END AS slug,
              COUNT(*) AS active_permits, COALESCE(SUM(${countedValueSql("p")}), 0) AS total_value
       FROM permits p
       LEFT JOIN addresses a ON a.id = p.address_id
       WHERE lower(COALESCE(p.status,'')) = 'active'
         AND p.address IS NOT NULL AND trim(p.address) != ''
         AND NOT EXISTS (SELECT 1 FROM addresses pa WHERE pa.id = p.address_id AND NOT ${realAddressSql("pa")})
       GROUP BY COALESCE('id:' || a.id, p.address)
       ORDER BY active_permits DESC, total_value DESC, label ASC
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
       SELECT COALESCE(n.name, p.neighborhood) AS label, n.slug AS slug,
              COUNT(*) AS permits, COALESCE(SUM(${countedValueSql("p")}), 0) AS total_value
       FROM permits p
       LEFT JOIN address_neighborhoods an ON an.address_id = p.address_id
       LEFT JOIN neighborhoods n ON n.id = an.neighborhood_id
       WHERE ${realNeighborhoodSql("COALESCE(n.name, p.neighborhood)")}
         AND date(COALESCE(p.issued_date, p.applied_date)) >= date('now', '-30 days')
       GROUP BY COALESCE(n.slug, p.neighborhood)
       ORDER BY permits DESC, total_value DESC, label ASC
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
      const label = type === "neighborhood" ? rawLabel : displayName(rawLabel);
      // Rank rows link the indexable entity page; the noindexed /permits
      // search is only a fallback for rows the entity graph hasn't linked.
      let href = "/permits";
      let metric = "";
      if (type === "address") {
        href = row.slug ? `/address/${encodeURIComponent(row.slug)}` : `/permits?q=${encodeURIComponent(rawLabel)}`;
        metric = countLabel(row.active_permits, "active permit", "active permits");
      } else if (type === "contractor") {
        href = row.slug ? `/contractor/${encodeURIComponent(row.slug)}` : `/permits?q=${encodeURIComponent(rawLabel)}`;
        metric = countLabel(row.permits, "new active permit", "new active permits");
      } else {
        href = row.slug ? `/neighborhood/${encodeURIComponent(row.slug)}` : `/permits?neighborhood=${encodeURIComponent(rawLabel)}`;
        metric = countLabel(row.permits, "recent permit", "recent permits");
      }
      return `<a class="rank-row" href="${escapeHtml(href)}">
        <span class="rank-index">${index + 1}</span>
        <span class="rank-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(metric)}</small></span>
        <span class="rank-value">${escapeHtml(compactMetricMoney(row.total_value || 0))}<small>permit value</small></span>
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
  ${renderDesignTokens()}
  <style>
    .skip-link{position:absolute;left:-9999px;top:0;z-index:100;background:var(--brand-navy);color:#fff;padding:10px 16px;border-radius:0 0 10px 0;font-weight:800;text-decoration:none}.skip-link:focus{left:0}
    :root{--primary:var(--ink);--bg:var(--surface);--bg-alt:var(--surface-alt);--panel:var(--surface-raised);--text:var(--ink);--muted:var(--ink-muted);--border:var(--line);--soft:var(--line-subtle);--max:1200px;color-scheme:light}[data-theme="dark"]{color-scheme:dark}
    *{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:80px}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);line-height:1.55}a{color:inherit}a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:3px}button,input{font:inherit}.container{width:min(var(--max),calc(100% - 32px));margin:0 auto}.hero{padding:40px 0 32px;border-bottom:1px solid var(--soft)}.eyebrow,.section-kicker{margin:0 0 10px;color:var(--link);font-size:12px;line-height:1.2;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero h1{max-width:850px;margin:0;color:var(--primary);font-size:clamp(2.2rem,5.4vw,3.6rem);line-height:1;letter-spacing:-.04em;text-wrap:balance}.hero-copy{max-width:710px;margin:20px 0 0;font-size:clamp(1rem,2.5vw,1.18rem);color:var(--ink-secondary)}.search-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;max-width:820px;margin-top:28px}.search-form label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.hero-subactions{display:flex;flex-wrap:wrap;gap:16px;margin-top:14px;font-size:14px;font-weight:750}.hero-subactions a{text-underline-offset:4px}.hero-grid{display:grid;gap:8px}.hero-aside{margin-top:6px}.metric-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:24px;max-width:820px}@media(min-width:960px){.hero-grid{grid-template-columns:minmax(0,1.5fr) minmax(280px,.7fr);gap:56px;align-items:start}.hero-aside{margin-top:6px;padding:20px 22px;border:1px solid var(--border);border-radius:12px;background:var(--bg-alt)}.hero-aside .metric-strip{grid-template-columns:1fr;gap:18px;margin-top:0;max-width:none}.hero-aside .bs-metric{border-top-width:1px;border-top-color:var(--border);padding-top:14px}.hero-aside .bs-metric:first-child{border-top-width:3px;border-top-color:var(--ink)}.hero-aside .bs-metric__value{font-size:2rem}.hero-aside .freshness{margin-top:18px;padding-top:14px;border-top:1px solid var(--soft)}}.bs-metric:hover .bs-metric__value{color:var(--accent)}.bs-metric__value{font-size:clamp(1.25rem,5vw,1.85rem);line-height:1.05}.freshness{max-width:820px;margin:18px 0 0;flex-wrap:nowrap;align-items:flex-start}.freshness>span{flex:1;min-width:0}.freshness>.bs-icon{margin-top:1px}.freshness a{font-weight:750;text-underline-offset:3px}.section{padding:52px 0;border-bottom:1px solid var(--soft)}.section.alt{background:var(--bg-alt)}.section-head{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:22px}.section h2{margin:0;color:var(--primary);font-size:clamp(1.75rem,5vw,2.6rem);line-height:1.05;letter-spacing:-.035em}.section-deck{max-width:680px;margin:8px 0 0;color:var(--ink-secondary)}.text-link{font-weight:800;color:var(--link);text-underline-offset:4px;white-space:nowrap}.market-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.market-card{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}.market-card header{padding:18px 18px 14px;border-bottom:1px solid var(--soft)}.market-card h3{margin:0;color:var(--ink);font-size:16px}.market-card p{margin:5px 0 0;color:var(--ink-secondary);font-size:12px}.rank-row{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:10px;align-items:center;padding:13px 16px;border-bottom:1px solid var(--soft);text-decoration:none}.rank-row:last-child{border-bottom:0}.rank-row:hover strong{text-decoration:underline;text-underline-offset:3px}.rank-index{color:var(--ink-muted);font-size:12px;font-weight:800}.rank-copy{min-width:0}.rank-copy strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);font-size:13px}.rank-copy small,.rank-value small{display:block;color:var(--ink-muted);font-size:11px;font-weight:600}.rank-value{text-align:right;color:var(--ink);font-size:12px;font-weight:800}.tasks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-top:1px solid var(--border);border-left:1px solid var(--border)}.task{min-height:146px;padding:22px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);text-decoration:none;background:var(--panel)}.task:hover{background:var(--bg-alt)}.task strong{display:flex;justify-content:space-between;gap:16px;color:var(--ink);font-size:18px}.task p{max-width:48ch;margin:9px 0 0;color:var(--ink-secondary);font-size:14px}.trust{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(260px,.6fr);gap:28px;align-items:start}.trust-copy{font-size:16px}.trust-copy p{max-width:70ch}.trust-note{border-left:4px solid var(--ink);padding:4px 0 4px 18px;color:var(--ink-secondary)}.trust-meta{border:1px solid var(--border);border-radius:12px;padding:20px;background:var(--panel)}.trust-meta dl{margin:0}.trust-meta div+div{border-top:1px solid var(--soft);margin-top:12px;padding-top:12px}.trust-meta dt{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-muted)}.trust-meta dd{margin:4px 0 0;font-weight:750;color:var(--ink)}.faq{border-top:1px solid var(--border)}details{border-bottom:1px solid var(--border)}summary{list-style:none;cursor:pointer;padding:18px 2px;font-weight:800;color:var(--ink)}summary::-webkit-details-marker{display:none}summary::after{content:"+";float:right;color:var(--ink-secondary)}details[open] summary::after{content:"−"}.answer{max-width:760px;padding:0 36px 20px 2px;color:var(--ink-secondary)}.alert-panel{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:center;padding:28px;border-radius:14px;background:var(--brand-navy);color:#fff}.alert-panel h2{color:#fff}.alert-panel p{max-width:680px;margin:9px 0 0;color:#CBD3DD}.alert-button{display:inline-flex;min-height:48px;align-items:center;justify-content:center;padding:0 20px;border-radius:8px;background:#fff;color:var(--brand-navy);font-weight:850;text-decoration:none;white-space:nowrap}
    @media(max-width:780px){.hero{padding-top:40px}.search-form{grid-template-columns:1fr}.search-form .bs-btn{width:100%}.section{padding:44px 0}.section-head{display:block}.section-head .text-link{display:inline-block;margin-top:12px}.market-grid{grid-template-columns:1fr}.tasks{grid-template-columns:1fr}.trust{grid-template-columns:1fr}.alert-panel{grid-template-columns:1fr}.alert-button{width:100%}.task{min-height:auto}.rank-copy strong{white-space:normal}}
    @media(max-width:360px){.container{width:min(var(--max),calc(100% - 24px))}.metric-strip{gap:6px}.bs-metric__value{font-size:1.16rem}.bs-metric__label{font-size:11px}.hero h1{font-size:2.05rem}}
    @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
    [data-theme="dark"] .alert-panel{box-shadow:inset 0 0 0 1px var(--line)}
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  ${renderNav("home")}
  <div class="global-nav-spacer"></div>
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
          <a class="bs-metric" href="/methodology#value"><span class="bs-metric__value">${escapeHtml(compactMetricMoney(stats.total_value))}</span><span class="bs-metric__label">counted permit value</span></a>
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
        <div class="section-head"><div><p class="section-kicker">Market activity</p><h2 id="market-heading">Seattle construction activity</h2><p class="section-deck">Explicit rankings with the metric and timeframe shown. Permit values are source-reported declared values, with a demolition valuation SDCI repeats at one address counted once. They are not verified total project costs.</p></div></div>
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
        <div class="trust-copy"><p class="section-kicker">Source &amp; methodology</p><h2 id="trust-heading">Built from Seattle public records</h2><p>Building Seattle organizes Seattle Department of Construction and Inspections records into searchable permits, addresses, projects, contractors, and neighborhoods.</p><p class="trust-note">Permit values are <strong>declared permit values</strong>, not verified total project costs. Site totals count a demolition valuation SDCI repeats at one address once. Some project and entity relationships are inferred from source records and should be read with the methodology in mind.</p><p><a class="text-link" href="/methodology">Read the methodology →</a> &nbsp; <a class="text-link" href="/data">Explore the dataset →</a></p></div>
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

    <section class="section alt" aria-labelledby="alerts-heading"><div class="container"><div class="alert-panel"><div><p class="section-kicker" style="color:var(--brand-sky)">Permit alerts</p><h2 id="alerts-heading">Get the changes that matter</h2><p>Choose a permit and subscribe to its status changes. Alerts are free, start only after you confirm your email, and every message has a one-click unsubscribe.</p></div><a class="alert-button" href="/alerts">How permit alerts work</a></div></div></section>
  </main>
  ${renderFooter()}
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
    `- ${compactMetricMoney(stats.total_value)} counted permit value (repeated demolition valuations counted once)`,
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

// Shared front door for the public same-origin forms (leads, alert sign-up):
// JSON only, same-site Origin only, then a per-IP throttle: the Workers Rate
// Limiting binding as a per-minute burst limit when it exists, and the hourly
// cap in D1 always (checkRateLimit, review S2).
async function checkPublicFormRequest(request, env, { scope, binding, hourlyLimit }) {
  if (!isJsonContentType(request)) {
    return formJsonResponse({ error: "Content-Type must be application/json" }, 415);
  }
  if (isCrossSiteRequest(request)) {
    return formJsonResponse({ error: "Cross-site requests are not allowed" }, 403);
  }
  const { allowed, reason } = await checkRateLimit(env, {
    binding,
    key: await rateLimitKey(`${scope}:ip`, clientIp(request)),
    limit: hourlyLimit,
    windowSeconds: 3600,
  });
  if (!allowed) return rateLimitedFormResponse(reason, reason === "burst" ? 60 : 3600);
  return null;
}

function rateLimitedFormResponse(reason, retryAfterSeconds) {
  if (reason === "unavailable") {
    return formJsonResponse({ error: "This form is temporarily unavailable. Please try again in a few minutes." }, 503, { "Retry-After": "300" });
  }
  const wait = retryAfterSeconds <= 60 ? "a minute" : "an hour";
  return formJsonResponse(
    { error: `Too many requests from your connection. Please wait ${wait} and try again.` },
    429,
    { "Retry-After": String(retryAfterSeconds) },
  );
}

async function readJsonObject(request) {
  try {
    const data = await request.json();
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function handleLeadCapture(request, env) {
  const rejected = await checkPublicFormRequest(request, env, {
    scope: "leads",
    binding: "LEADS_RATE_LIMITER",
    hourlyLimit: LEAD_IP_HOURLY_LIMIT,
  });
  if (rejected) return rejected;

  const data = await readJsonObject(request);
  if (!data) {
    return formJsonResponse({ error: "Invalid JSON" }, 400);
  }

  const email = String(data.email || "").trim().toLowerCase();
  const company = String(data.company || "").trim();
  const interest = String(data.interest || "").trim();
  if (
    !isValidEmail(email) ||
    !company ||
    !interest ||
    company.length > LEAD_TEXT_MAX_LENGTH ||
    interest.length > LEAD_TEXT_MAX_LENGTH
  ) {
    return formJsonResponse(
      { error: `A valid email, company, and interest (up to ${LEAD_TEXT_MAX_LENGTH} characters each) are required` },
      400,
    );
  }
  const neighborhoods = String(data.neighborhoods || "").trim().slice(0, LEAD_FIELD_MAX_LENGTH) || null;
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

  return formJsonResponse({ success: true, id: crypto.randomUUID() });
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

// Every accepted sign-up gets this same answer, whether a confirmation was
// sent, throttled, suppressed or the address already subscribes (A12): the
// endpoint must not reveal who watches which permit.
const ALERT_ACCEPTED = { success: true, status: "pending_confirmation" };

async function handleAlertSubscription(request, env) {
  if (!env.EMAIL) {
    return formJsonResponse({ error: "Permit alerts are temporarily unavailable" }, 503);
  }

  const rejected = await checkPublicFormRequest(request, env, {
    scope: "alerts",
    binding: "ALERTS_RATE_LIMITER",
    hourlyLimit: ALERT_IP_HOURLY_LIMIT,
  });
  if (rejected) return rejected;

  const data = await readJsonObject(request);
  if (!data) {
    return formJsonResponse({ error: "Invalid JSON" }, 400);
  }

  const email = String(data.email || "").trim().toLowerCase();
  const permitNumber = String(data.permit_number || "").trim();
  if (!isValidEmail(email) || !permitNumber || permitNumber.length > PERMIT_NUMBER_MAX_LENGTH) {
    return formJsonResponse({ error: "A valid email and permit number are required" }, 400);
  }

  // Turnstile is enforced only when both TURNSTILE_SITE_KEY and
  // TURNSTILE_SECRET_KEY are configured (turnstileEnabled).
  let humanVerified = false;
  if (turnstileEnabled(env)) {
    humanVerified = await verifyTurnstile(env, data.turnstile_token, clientIp(request));
    if (!humanVerified) {
      return formJsonResponse({ error: "Please complete the verification and try again" }, 403);
    }
  }

  const permit = await env.DB.prepare(
    "SELECT permit_number, address, status FROM permits WHERE permit_number = ?",
  )
    .bind(permitNumber)
    .first();
  if (!permit) {
    return formJsonResponse({ error: "Permit not found" }, 404);
  }

  const suppressed = await env.DB.prepare("SELECT 1 AS suppressed FROM alert_email_suppressions WHERE email = ?")
    .bind(email)
    .first();
  if (suppressed) {
    return formJsonResponse(ALERT_ACCEPTED, 202);
  }

  const existing = await env.DB.prepare(`
    SELECT
      id,
      status,
      confirmation_sent_at,
      confirmation_sent_at > datetime('now', ?) AS recently_sent
    FROM permit_alert_subscriptions
    WHERE lower(email) = ? AND permit_number = ?
  `)
    .bind(`-${ALERT_RESEND_COOLDOWN_MINUTES} minutes`, email, permitNumber)
    .first();
  if (existing?.status === "active") {
    return formJsonResponse(ALERT_ACCEPTED, 202);
  }
  // An unsubscribed pair is only re-opened by a fresh, human-verified opt-in;
  // without Turnstile configured it stays suppressed.
  if (existing?.status === "unsubscribed" && !humanVerified) {
    return formJsonResponse(ALERT_ACCEPTED, 202);
  }
  if (existing?.status === "pending" && Number(existing.recently_sent)) {
    return formJsonResponse(ALERT_ACCEPTED, 202);
  }

  // Per-address cap across all permits, counted only when we would send. Say
  // so plainly (review S2): a silent 202 left people waiting for an email that
  // was never sent.
  const emailCap = await checkRateLimit(env, {
    key: await rateLimitKey("alerts:email", email),
    limit: ALERT_EMAIL_DAILY_LIMIT,
    windowSeconds: 86400,
  });
  if (!emailCap.allowed) {
    if (emailCap.reason === "unavailable") return rateLimitedFormResponse("unavailable");
    return formJsonResponse(
      {
        error:
          `This email address has already been sent ${ALERT_EMAIL_DAILY_LIMIT} alert confirmations today. ` +
          "Check your inbox (and spam folder) for an earlier confirmation link, or try again tomorrow.",
      },
      429,
      { "Retry-After": "86400" },
    );
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
    WHERE permit_alert_subscriptions.status != 'active'
  `)
    .bind(email, permitNumber, confirmationTokenHash, unsubscribeToken)
    .run();

  const confirmationUrl = `${BASE_URL}/alerts/confirm?token=${encodeURIComponent(confirmationToken)}`;
  const blockUrl = `${BASE_URL}/alerts/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}&scope=all`;
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
        `This link expires in ${ALERT_CONFIRMATION_TTL_DAYS} days.`,
        "",
        "You will receive email only when this permit's recorded status changes.",
        "",
        `Didn't ask for this? Ignore this email, or stop all Building Seattle email to this address: ${blockUrl}`,
      ].join("\n"),
      html: `
        <h1>Confirm your permit alert</h1>
        <p><strong>${escapeHtml(permitNumber)}</strong>: ${escapeHtml(permit.address || "Seattle permit")}</p>
        <p>Current status: ${escapeHtml(normalizeStoredStatus(permit.status))}</p>
        <p><a href="${escapeHtml(confirmationUrl)}">Confirm permit alerts</a> (expires in ${ALERT_CONFIRMATION_TTL_DAYS} days)</p>
        <p>You will receive email only when this permit's recorded status changes.</p>
        <p style="color:#666;font-size:0.9em;">Didn't ask for this? Ignore this email, or <a href="${escapeHtml(blockUrl)}">stop all Building Seattle email to this address</a>.</p>
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
    return formJsonResponse({ error: "Confirmation email could not be sent" }, 503);
  }

  return formJsonResponse(ALERT_ACCEPTED, 202);
}

// Read a token from the query string or a POSTed form body. Mail providers'
// RFC 8058 one-click POST keeps the token in the URL and sends
// "List-Unsubscribe=One-Click" as the body.
async function readAlertTokenAndScope(request) {
  const url = new URL(request.url);
  let token = url.searchParams.get("token") || "";
  let scope = url.searchParams.get("scope") || "";
  if (request.method === "POST") {
    const type = (request.headers.get("Content-Type") || "").toLowerCase();
    if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
      try {
        const form = await request.formData();
        token = String(form.get("token") || token);
        scope = String(form.get("scope") || scope);
      } catch {
        // Fall back to the query string.
      }
    }
  }
  return { token: token.slice(0, 200), scope: scope === "all" ? "all" : "permit" };
}

// GET only shows a page; the state change needs the POST from its button
// (A11), so link scanners and prefetchers cannot confirm or unsubscribe.
async function handleAlertConfirmation(request, env) {
  if (request.method === "POST" && isCrossSiteRequest(request)) {
    return renderAlertResult("Request refused", "Confirm your alert from the link in your email.", 403);
  }
  const { token } = await readAlertTokenAndScope(request);
  if (!token) {
    return renderAlertResult("Invalid confirmation link", "This confirmation link is missing its token.", 400);
  }

  const tokenHash = await hashAlertToken(token);
  const expiry = `-${ALERT_CONFIRMATION_TTL_DAYS} days`;
  const subscription = await env.DB.prepare(`
    SELECT id, permit_number
    FROM permit_alert_subscriptions
    WHERE confirmation_token_hash = ?
      AND status = 'pending'
      AND confirmation_sent_at > datetime('now', ?)
  `)
    .bind(tokenHash, expiry)
    .first();
  if (!subscription) {
    return renderAlertResult(
      "Confirmation link expired",
      "This link has already been used or is no longer valid. Return to the permit page to request a new one.",
      404,
    );
  }

  if (request.method !== "POST") {
    return renderAlertResult(
      "Confirm your permit alert",
      `Press the button to start email alerts for permit ${subscription.permit_number}.`,
      200,
      renderAlertActionForm("/alerts/confirm", token, [{ label: "Confirm permit alerts" }]),
    );
  }

  const result = await env.DB.prepare(`
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
    WHERE id = ? AND status = 'pending' AND confirmation_token_hash = ?
  `)
    .bind(subscription.id, tokenHash)
    .run();
  if (!Number(result?.meta?.changes)) {
    return renderAlertResult("Confirmation link expired", "This link has already been used.", 404);
  }

  return renderAlertResult(
    "Permit alert confirmed",
    `You will receive an email when permit ${subscription.permit_number} changes status.`,
  );
}

async function handleAlertUnsubscribe(request, env) {
  const { token, scope } = await readAlertTokenAndScope(request);
  const subscription = token
    ? await env.DB.prepare(`
      SELECT id, email, permit_number
      FROM permit_alert_subscriptions
      WHERE unsubscribe_token = ?
    `)
        .bind(token)
        .first()
    : null;

  if (!subscription) {
    return renderAlertResult("Invalid unsubscribe link", "This unsubscribe link is not valid.", 404);
  }

  if (request.method !== "POST") {
    const actions = [{ label: `Stop alerts for permit ${subscription.permit_number}` }];
    actions.push({ label: "Stop all Building Seattle email to this address", scope: "all", secondary: true });
    return renderAlertResult(
      scope === "all" ? "Stop all email to this address?" : "Stop this permit alert?",
      scope === "all"
        ? "Press the button below and Building Seattle will not email this address again, for any permit."
        : `Press the button to stop status alerts for permit ${subscription.permit_number}.`,
      200,
      renderAlertActionForm(`/alerts/unsubscribe?token=${encodeURIComponent(token)}`, token, scope === "all" ? actions.reverse() : actions),
    );
  }

  const email = String(subscription.email || "").toLowerCase();
  if (scope === "all") {
    await env.DB.prepare(`
      INSERT INTO alert_email_suppressions (email, reason, created_at)
      VALUES (?, 'user_request', datetime('now'))
      ON CONFLICT(email) DO NOTHING
    `)
      .bind(email)
      .run();
  }

  await env.DB.prepare(`
    UPDATE permit_alert_subscriptions
    SET
      status = 'unsubscribed',
      confirmation_token_hash = NULL,
      unsubscribed_at = datetime('now'),
      updated_at = datetime('now')
    WHERE ${scope === "all" ? "lower(email) = ?" : "id = ?"}
  `)
    .bind(scope === "all" ? email : subscription.id)
    .run();

  return renderAlertResult(
    "Permit alert stopped",
    scope === "all"
      ? "Building Seattle will not email this address again."
      : `You will no longer receive status alerts for permit ${subscription.permit_number}.`,
  );
}

// A3: each (subscription, change) is claimed in permit_alert_deliveries
// before the email goes out, so overlapping runs (per-batch ingest plus the
// cron) cannot send one change twice. A failed send releases its claim for
// the next run; a claim stuck in 'sending' for an hour is reclaimable.
export async function sendPendingPermitAlerts(env) {
  if (!env.EMAIL) {
    console.warn("Permit alert delivery skipped because the EMAIL binding is unavailable.");
    return { sent: 0, failed: 0, skipped: 0 };
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
      AND NOT EXISTS (SELECT 1 FROM alert_email_suppressions x WHERE x.email = lower(s.email))
      AND NOT EXISTS (
        SELECT 1 FROM permit_alert_deliveries d
        WHERE d.subscription_id = s.id AND d.change_id = sc.id AND d.status = 'sent'
      )
    ORDER BY sc.id ASC
    LIMIT ${ALERT_SEND_BATCH_LIMIT}
  `).all();

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const change of results || []) {
    const claim = await env.DB.prepare(`
      INSERT INTO permit_alert_deliveries (subscription_id, change_id, status, claimed_at)
      VALUES (?, ?, 'sending', datetime('now'))
      ON CONFLICT(subscription_id, change_id) DO UPDATE SET
        status = 'sending',
        claimed_at = datetime('now')
      WHERE permit_alert_deliveries.status = 'failed'
        OR (permit_alert_deliveries.status = 'sending' AND permit_alert_deliveries.claimed_at < datetime('now', '-1 hour'))
    `)
      .bind(change.subscription_id, change.change_id)
      .run();
    if (!Number(claim?.meta?.changes)) {
      skipped++;
      continue;
    }

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
    } catch (error) {
      failed++;
      console.error(`Permit alert delivery failed for subscription ${change.subscription_id}:`, error);
      await env.DB.prepare(`
        UPDATE permit_alert_deliveries SET status = 'failed'
        WHERE subscription_id = ? AND change_id = ? AND status = 'sending'
      `)
        .bind(change.subscription_id, change.change_id)
        .run();
      continue;
    }

    await env.DB.prepare(`
      UPDATE permit_alert_deliveries SET status = 'sent', notified_at = datetime('now')
      WHERE subscription_id = ? AND change_id = ?
    `)
      .bind(change.subscription_id, change.change_id)
      .run();
    await env.DB.prepare(`
      UPDATE permit_alert_subscriptions
      SET
        last_notified_change_id = MAX(COALESCE(last_notified_change_id, 0), ?),
        last_notified_at = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `)
      .bind(change.change_id, change.changed_at, change.subscription_id)
      .run();
    sent++;
  }

  return { sent, failed, skipped };
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

// POST form for the confirm/unsubscribe pages. Each action is a submit
// button; `scope` rides along as the button's value.
function renderAlertActionForm(action, token, actions) {
  const buttons = actions
    .map(({ label, scope, secondary }) => {
      const style = secondary
        ? "background:none;border:1px solid var(--border);color:var(--text);"
        : "";
      const scopeAttrs = scope ? ` name="scope" value="${escapeHtml(scope)}"` : "";
      return `<button type="submit" class="bs-btn ${secondary ? "" : "bs-btn--primary"}"${scopeAttrs} style="margin:0 0.75rem 0.75rem 0;${style}">${escapeHtml(label)}</button>`;
    })
    .join("");
  return `<form method="post" action="${escapeHtml(action)}" style="margin-bottom:2rem;">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      ${buttons}
    </form>`;
}

function renderAlertResult(title, message, status = 200, actionHtml = "") {
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
    ${actionHtml}
    <a href="/permits" style="color:var(--accent);font-weight:650;text-decoration:none;">Browse Seattle permits &rarr;</a>
  </main>
  ${renderFooter()}
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

// Public permit API (A4, A7, F2). Anonymous callers get a sample: at most
// ANON_API_MAX_PER_PAGE slim rows per page and ANON_API_MAX_PAGE pages. An API
// key (X-API-Key or Authorization: Bearer) unlocks full rows and depth.
async function getPermits(request, env, { access = null } = {}) {
  const siteContext = developmentSitesArePublic(env);
  const url = new URL(request.url);
  const tier = access?.tier === "key" ? "key" : "anonymous";
  const limits = apiLimits(access);
  const permitNumber = url.searchParams.get("permit");
  const neighborhood = url.searchParams.get("neighborhood");
  const type = url.searchParams.get("type");
  const status = url.searchParams.get("status");
  const q = url.searchParams.get("q");
  const pageParam = parseIntegerParam(url.searchParams.get("page"), { fallback: 1 });
  const perPageParam = parseIntegerParam(url.searchParams.get("per_page"), {
    fallback: Math.min(50, limits.maxPerPage),
    max: limits.maxPerPage,
  });
  if (!pageParam.ok) return apiErrorResponse("page must be a positive integer", 400);
  if (!perPageParam.ok) return apiErrorResponse("per_page must be a positive integer", 400);
  if (q && q.length > SEARCH_QUERY_MAX_LENGTH) {
    return apiErrorResponse(`q must be at most ${SEARCH_QUERY_MAX_LENGTH} characters`, 400);
  }
  if ([neighborhood, type, status, permitNumber].some((value) => value && value.length > FILTER_PARAM_MAX_LENGTH)) {
    return apiErrorResponse("Filter value too long", 400);
  }
  if (pageParam.value > limits.maxPage) {
    return apiErrorResponse(
      tier === "key"
        ? `page must be at most ${limits.maxPage}`
        : `Anonymous access is limited to the first ${ANON_API_MAX_PAGE} pages. Use an API key for full access, or see ${BASE_URL}/data for the full dataset.`,
      403,
    );
  }
  const page = pageParam.value;
  const perPage = perPageParam.value;
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

  const listQuery = `SELECT p.*, ${siteContext ? developmentSiteColumns() + "," : ""} c.name as contractor_name, c.slug as contractor_slug, c.specialty as contractor_specialty, c.phone as contractor_phone, c.email as contractor_email FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id ${siteContext ? developmentSiteJoin() : ""} ${where} ORDER BY p.issued_date DESC, p.id DESC LIMIT ${perPage} OFFSET ${offset}`;
  const countQuery = `SELECT COUNT(*) as total FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id ${where}`;

  const [{ results }, { total }] = await Promise.all([
    env.DB.prepare(listQuery)
      .bind(...params)
      .all(),
    env.DB.prepare(countQuery)
      .bind(...params)
      .first(),
  ]);

  const rows = (results || []).slice(0, perPage).map((row) => (siteContext ? withDevelopmentSiteFields(row) : row));
  const body = {
    total,
    page,
    per_page: perPage,
    access: tier,
    max_page: limits.maxPage,
    results: tier === "key" ? rows : rows.map(slimPermitRow),
  };
  if (tier !== "key") body.full_access = `${BASE_URL}/data`;
  return new Response(JSON.stringify(body), {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      // Keyed responses vary by caller, so they must not sit in a shared cache.
      "Cache-Control": tier === "key" ? "private, no-store" : "public, max-age=60",
      Vary: "X-API-Key, Authorization",
    },
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
  // Junk page= values from crawlers used to reach SQL as OFFSET NaN (A4).
  const pageParam = parseIntegerParam(url.searchParams.get("page"), { fallback: 1, max: 1000 });
  if (!pageParam.ok || (q && q.length > SEARCH_QUERY_MAX_LENGTH)) return badRequestResponse("/permits");
  const page = pageParam.value;
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
      `SELECT end_time FROM ingest_logs WHERE status IN ('success', 'degraded') AND run_type NOT IN ('entity_graph', 'development_sites') ORDER BY end_time DESC LIMIT 1`,
    ).first(),
    getRecentStatusChanges(env, 8),
  ]);
  const permits = permitResult?.results || [];
  const totalRaw = totalResult?.total || 0;
  const total = totalRaw || 0;
  const totalPages = Math.ceil(total / perPage);
  // Past the last page there is nothing to list: a 404, not an empty page
  // that canonicalizes to itself and sits in the index (D10).
  if (page > 1 && page > totalPages) {
    return render404({
      heading: "Page not found",
      message: "There are no more permits on this page. Start from the first page of results.",
    });
  }
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
        `<option value="${escapeHtml(item.type)}"${item.type === type ? " selected" : ""}>${escapeHtml(permitTypeLabel(item.type))}</option>`,
    )
    .join("");
  const statusOptions = statuses
    .map(
      (item) =>
        `<option value="${escapeHtml(item.status)}"${item.status === status ? " selected" : ""}>${escapeHtml(statusLabel(item.status))}</option>`,
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
      const issued = permit.issued_date ? formatCalendarDate(permit.issued_date) || "Date pending" : "Date pending";
      const contractor = permit.contractor_slug
        ? `<a href="/contractor/${encodeURIComponent(permit.contractor_slug)}" style="color:var(--accent);text-decoration:none;font-weight:600;">${escapeHtml(displayName(permit.contractor_name) || "View contractor")}</a>`
        : `<span style="color:var(--text-muted);">Contractor not linked yet</span>`;
      const address = escapeHtml(displayName(permit.address_display || permit.address) || "Unknown address");
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
          ${bsStatusPill(permit.status, statusLabel(permit.status || "new"))}
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
           pr.name as project_name,
           (SELECT n.slug FROM address_neighborhoods an JOIN neighborhoods n ON n.id = an.neighborhood_id
             WHERE an.address_id = p.address_id ORDER BY n.id LIMIT 1) AS graph_neighborhood_slug,
           (SELECT n.name FROM address_neighborhoods an JOIN neighborhoods n ON n.id = an.neighborhood_id
             WHERE an.address_id = p.address_id ORDER BY n.id LIMIT 1) AS graph_neighborhood_name
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
  const alertsOpen = !isClosedPermitStatus(permit.status);
  const permitAlertCard = alertsOpen
    ? `<div class="bs-card card-full" id="permit-alerts">
                    <div class="card-label">Status alerts</div>
                    <p style="margin:0.5rem 0 0.75rem;font-size:0.9rem;color:var(--text-muted);">Get a free email when this permit changes status. You confirm your address first, and every email has a one-click unsubscribe. <a href="/alerts" style="color:var(--accent);">How alerts work</a> &middot; <a href="/privacy" style="color:var(--accent);">Privacy</a></p>
                    <button type="button" class="bs-btn bs-btn--primary" data-open-lead-modal>${primaryLeadLabel}</button>
                </div>`
    : `<div class="bs-card card-full" id="permit-alerts">
                    <div class="card-label">Status alerts</div>
                    <p style="margin:0.5rem 0 0;font-size:0.9rem;color:var(--text-muted);">This permit is ${escapeHtml(statusLabel(permit.status).toLowerCase())}, so it has no status changes left to email about. <a href="/alerts" style="color:var(--accent);">How permit alerts work</a></p>
                </div>`;
  const timelineCard = renderPermitTimeline(permit);

  const valueFormatted = permit.value ? `$${parseInt(permit.value).toLocaleString()}` : "N/A";
  const permitDescriptor = permitSearchDescriptor(permit);
  const addressLabel = cleanFeedText(permit.address) || "Seattle";
  const permitAddressLabel = entStreet(addressLabel) || "Seattle";
  const safePermitNumber = escapeHtml(permit.permit_number || "Unknown permit");
  // Rendered only when the site key is set; enforced only when the secret is.
  // Widget only when Turnstile is fully configured (both keys; review S3).
  const turnstileSiteKey = turnstileEnabled(env) ? String(env.TURNSTILE_SITE_KEY).trim() : "";
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
  const rawTitleHighlight = permitDescriptor || rawWorkText || `${permitType} permit`;
  // Keep the <title> reasonably tight so it isn't truncated in SERPs: the
  // work highlight absorbs the overflow, but the brand suffix always ships —
  // Google truncates long titles for display on its own, so a missing brand
  // suffix is worse than a slightly long title.
  // The permit number always ships too: several permits at one address (a
  // multi-unit site, a building with many tenant improvements) otherwise share
  // the same address + work-type title and H1.
  const PERMIT_TITLE_MAX = 100;
  const brandSuffix = " | Building Seattle";
  const titlePrefix = `${titleLocation} — `;
  const permitSuffix = permit.permit_number ? ` (#${permit.permit_number})` : "";
  const highlightBudget = Math.max(20, PERMIT_TITLE_MAX - titlePrefix.length - permitSuffix.length - brandSuffix.length);
  const pageTitle = `${titlePrefix}${truncateMetaDescription(rawTitleHighlight, highlightBudget)}${permitSuffix}${brandSuffix}`;
  const safeTitle = escapeHtml(pageTitle);

  // Build the meta description with the required facts (permit number/status)
  // always intact, and the contractor included whole or not at all — never
  // truncate the tail mid-name. Only the leading work/address snippet, which
  // is already word-boundary truncated, absorbs any remaining length overflow.
  const META_MAX = 165;
  const permitCore = `Permit ${permit.permit_number} (${permit.status ? statusLabel(permit.status).toLowerCase() : "status unknown"}).`;
  const contractorSuffix = permit.contractor_name ? ` Contractor: ${displayName(permit.contractor_name)}.` : "";
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
  const permitClosed = isClosedPermitStatus(permit.status);
  const workVerb = permitClosed ? "Work was performed by" : "Work is being performed by";
  const summaryContractorHtml = permit.contractor_name
    ? ` ${workVerb} ${
        permit.contractor_slug
          ? `<a href="/contractor/${encodeURIComponent(permit.contractor_slug)}" style="color:var(--accent);text-decoration:none;font-weight:600;">${escapeHtml(displayName(permit.contractor_name))}</a>`
          : escapeHtml(displayName(permit.contractor_name))
      }.`
    : permit.work_performed_by === "Owner/Lessee"
      ? ` ${workVerb} the property owner/lessee.`
      : "";
  // Cap the lead clause so an unusually long scraped description can't turn
  // this "concise summary below the H1" into a duplicate of the full Project
  // Description card further down the page.
  const summaryWorkSnippet = rawWorkText ? truncateMetaDescription(rawWorkText, 220) : "";
  const summaryLeadText = summaryWorkSnippet
    ? summaryWorkSnippet.charAt(0).toUpperCase() + summaryWorkSnippet.slice(1)
    : `A ${permitType.toLowerCase()} project`;
  const permitSummaryHtml = `${escapeHtml(summaryLeadText)} at ${summaryAddressHtml}${neighborhoodPhrase}. Permit ${safePermitNumber} is ${escapeHtml(permit.status ? statusLabel(permit.status).toLowerCase() : "under review")}${valueFormatted !== "N/A" ? `, valued at ${valueFormatted}` : ""}.${summaryContractorHtml}`;
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
  // Link the neighborhood page the entity graph actually built for this
  // permit's address. A slug derived from the permit's free-text neighborhood
  // can name a page that does not exist (E10), and placeholder buckets such as
  // "Other Seattle" are noindex, so neither is linked.
  const neighborhoodSlug = permit.graph_neighborhood_slug && !isPlaceholderNeighborhood(permit.graph_neighborhood_name)
    ? permit.graph_neighborhood_slug
    : "";
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
      ? `<a href="/neighborhood/${encodeURIComponent(neighborhoodSlug)}" style="color:var(--accent);text-decoration:none;font-weight:600;">${escapeHtml(permit.graph_neighborhood_name)}</a> <span style="color:var(--text-muted);font-size:0.8rem;">Neighborhood</span>`
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
        .permit-title-id {
            display: block;
            font-size: 1rem;
            font-weight: 600;
            color: var(--text-muted);
            margin-top: 0.25rem;
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
	                <div class="permit-number">${safePermitType} permit</div>
	                <h1 class="permit-title">${safeAddress} <span class="permit-title-id">Permit <span class="bs-id">${safePermitNumber}</span></span></h1>
	                ${bsStatusPill(permit.status, statusLabel(permit.status))}
                <p class="permit-summary">${permitSummaryHtml}</p>
	                ${firstScreenLinks ? `<nav aria-label="Related permit records" style="display:flex;flex-wrap:wrap;gap:0.5rem 0.9rem;margin:1rem 0 0;font-size:0.84rem;">${firstScreenLinks}</nav>` : ""}
            </div>
            <div class="detail-grid">
                <h2 class="card-full" style="font-size:1.5rem;font-weight:700;margin:1.5rem 0 0;color:var(--primary);grid-column:1/-1;">Permit Timeline &amp; Status</h2>
                ${timelineCard}
                ${permitAlertCard}
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
	                        ${permit.work_performed_by === "Owner/Lessee" || !alertsOpen ? "" : `<button type="button" data-open-lead-modal style="margin-top:0.75rem;background:none;border:none;padding:0;color:var(--accent);font-size:0.875rem;font-weight:600;cursor:pointer;text-align:left;">Get an email if a contractor is attached &rarr;</button>`}
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
                ${alertsOpen ? `<button type="button" class="bs-btn bs-btn--primary" data-open-lead-modal>${primaryLeadLabel}</button>` : ""}
                ${
                  permit.contractor_slug
                    ? `<a href="/contractor/${encodeURIComponent(permit.contractor_slug)}" class="bs-btn bs-btn--secondary">View Contractor</a>`
                    : `<a href="https://www.google.com/maps/search/?api=1&query=${mapsQuery}" target="_blank" rel="noopener" class="bs-btn bs-btn--secondary">Open Map</a>`
                }
            </div>
            </div>
        </div>
    </main>

    ${alertsOpen ? `<dialog id="leadModal" class="modal" aria-labelledby="leadModalTitle" aria-describedby="leadModalDescription">
        <div class="modal-content">
            <button type="button" class="modal-close" data-close-lead-modal aria-label="Close dialog">&times;</button>
            <h3 id="leadModalTitle" style="margin-bottom:0.5rem;">${primaryLeadLabel}</h3>
            <p id="leadModalDescription" style="color:var(--text-muted);margin-bottom:1.5rem;font-size:0.9rem;">Get an email when permit ${safePermitNumber} changes status.</p>
            <form id="leadForm" data-permit-number="${escapeHtml(String(permit.permit_number || ""))}">
                <div class="form-group">
                    <label for="lead-email">Email *</label>
                    <input id="lead-email" type="email" name="email" required autocomplete="email" placeholder="you@example.com">
                    <p id="lead-error" class="lead-error hidden"></p>
                </div>
                ${turnstileSiteKey ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(turnstileSiteKey)}" style="margin-bottom:1rem;"></div>` : ""}
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
            <p style="margin:1rem 0 0;font-size:0.8rem;color:var(--text-muted);">We store your email and this permit number only to send these alerts. <a href="/privacy" style="color:var(--accent);">Privacy notice</a></p>
        </div>
    </dialog>` : ""}

    ${renderFooter()}
    ${alertsOpen && turnstileSiteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""}
    ${alertsOpen ? '<script src="/brand/permit-alert.js" defer></script>' : ""}
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
    // Same counting rule as total_value, so avg_value x permits = total_value.
    `/* api:mean-permit-value */ SELECT COALESCE(SUM(${countedValueSql("p")}), 0) * 1.0 / NULLIF(COUNT(*), 0) AS avg_value FROM permits p`,
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
      last_feed_status: stats.last_feed_status,
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
  let contractor;
  try {
    contractor = await env.DB.prepare("SELECT * FROM contractors WHERE slug = ?").bind(slug).first();
  } catch (error) {
    console.error("Contractor lookup failed:", error);
    return renderTemporarilyUnavailable();
  }

  if (!contractor) {
    // Fall back to the people_orgs-backed page so /contractor/:slug resolves the
    // whole entity graph (owners, applicants, architects, and feed contractors).
    return renderOrgContractorPage(slug, env, request);
  }

  // A D1 error while reading the curated page answers 503 (not a JSON 500, and
  // never a page whose permit count silently read as zero).
  try {
    return await renderCuratedContractorPage(contractor, slug, env, request);
  } catch (error) {
    console.error("Contractor page read failed:", error);
    return renderTemporarilyUnavailable();
  }
}

async function renderCuratedContractorPage(contractor, slug, env, request) {
  const canonical = BASE_URL + "/contractor/" + encodeURIComponent(slug);
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
      .first(),
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
  // displayName also turns SDCI shorthand backslashes ("DSN\\CNST") into
  // slashes (audit G8).
  const contractorDisplayName = displayName(contractor.name) || smartTitleCase(contractor.name);
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
        name: contractorDisplayName,
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
          { "@type": "ListItem", position: 2, name: "Contractors", item: `${BASE_URL}/contractors` },
          {
            "@type": "ListItem",
            position: 3,
            name: contractorDisplayName,
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
    <meta name="robots" content="${totalPermits === 0 ? "noindex,follow" : "index,follow,max-image-preview:large"}">
    <link rel="canonical" href="${canonical}">
    <meta property="og:title" content="${escapeHtml(contractorPageTitle)}">
    <meta property="og:description" content="${safeContractorMetaDescription}">
    <meta property="og:type" content="profile">
    <meta property="og:url" content="${canonical}">
    <meta name="twitter:card" content="summary_large_image">
    <meta property="og:image" content="${BASE_URL}/social/contractor.png">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:alt" content="${safeContractorDisplayName} | Building Seattle">
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
                <a href="/" style="color:#94a3b8;text-decoration:none;">Home</a> <span style="margin:0 0.4rem;">/</span> <a href="/contractors" style="color:#94a3b8;text-decoration:none;">Contractors</a> <span style="margin:0 0.4rem;">/</span> <span style="color:#ffffff;font-weight:600;">${safeContractorDisplayName}</span>
            </nav>
            <div style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:2rem;">
                <div style="max-width:600px;min-width:0">
                    <div style="color:#94a3b8;font-size:0.875rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem">${safeContractorSpecialty}</div>
                    <h1 style="font-size:clamp(2rem,8vw,3rem);font-weight:800;line-height:1.1;letter-spacing:-0.02em;overflow-wrap:anywhere;margin:0 0 1rem 0">${safeContractorDisplayName}</h1>
                    <p style="font-size:1.25rem;color:#94a3b8;margin:0">${escapeHtml(heroSummary)}</p>
                </div>
                ${typeof permitDays === "number" || typeof buildDays === "number" ? `<div style="display:flex; gap:1.5rem;">
                    ${typeof permitDays === "number" ? `<div style="text-align:right">
                        <div style="font-size:0.75rem; color:#94a3b8; text-transform:uppercase; margin-bottom:0.25rem">Permit Speed</div>
                        <div style="font-size:1.5rem; font-weight:700;">${permitDays}${dayUnit(permitDays)}</div>
                    </div>` : ""}
                    ${typeof buildDays === "number" ? `<div style="text-align:right">
                        <div style="font-size:0.75rem; color:#94a3b8; text-transform:uppercase; margin-bottom:0.25rem">Build Speed</div>
                        <div style="font-size:1.5rem; font-weight:700;">${buildDays}${dayUnit(buildDays)}</div>
                    </div>` : ""}
                </div>` : ""}
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
                            <div style="font-weight:700"><a href="/permits/${encodeURIComponent(p.permit_number)}">${escapeHtml(displayName(p.address) || `Permit ${p.permit_number}`)}</a></div>
                            <div style="font-size:0.875rem;color:var(--text-muted)">${escapeHtml(permitTypeLabel(p.type))} &bull; ${p.value ? `$${Number(p.value).toLocaleString("en-US")}` : "Value not reported"} &bull; ${escapeHtml(statusLabel(p.status))} &bull; Permit ${escapeHtml(p.permit_number)}</div>
                        </div>
                    `,
                      )
                      .join("")}
                    ${totalPermits > shownPermits ? `<p style="margin:1rem 0 0;font-size:0.9rem;"><a href="/permits?q=${encodeURIComponent(contractor.name)}" style="color:var(--accent);text-decoration:none;font-weight:600;">Search permits for ${safeContractorDisplayName} &rarr;</a></p>` : ""}
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
                                    `<div style="font-size:0.9rem;"><a href="/address/${encodeURIComponent(a.slug)}">${escapeHtml(displayName(a.display_address))}</a> <span style="color:var(--text-muted);font-size:0.8rem;">· ${countLabel(a.permits, "permit", "permits")}</span></div>`,
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
                ${renderAlertCta({ permits: permits.results || [], subject: contractorDisplayName })}
                ${credentialsCard}
                <div class="bs-card">
                    <h3>Market Specialization</h3>
                    <div style="margin-top:1.5rem">
                        <div style="font-size:0.875rem; color:var(--text-muted); margin-bottom:0.75rem">Top Neighborhoods</div>
                        ${marketFocus.results
                          .map(
                            (f) => `
                            <div style="display:flex; justify-content:space-between; gap:1rem; margin-bottom:0.5rem; font-size:0.9375rem">
                                <a href="/neighborhood/${encodeURIComponent(makeSlug(f.neighborhood))}" style="font-weight:600;color:var(--accent);text-decoration:none;">${escapeHtml(f.neighborhood)}</a>
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
                                <span style="background:var(--accent-soft); color:var(--link); padding:0.25rem 0.75rem; border-radius:999px; font-size:0.75rem; font-weight:600">${escapeHtml(permitTypeLabel(t.type))} &middot; ${formatCount(t.count)}</span>
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
                ${renderDatasetCta({ context: "contractor", subject: `${contractorDisplayName}'s permits`, count: totalPermits })}
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
//
// Only one rebuild runs at a time: the `running` row is inserted only when no
// other entity_graph row is `running` and recent (rebuild_lock.js); otherwise
// this throws an error with code ENTITY_GRAPH_LOCKED_CODE and changes nothing.
// `force` (admin only) skips that check.
async function runLoggedEntityGraphRebuild(env, source, { force = false } = {}) {
  const startTime = new Date();
  const stamp = (date) => date.toISOString().replace("T", " ").split(".")[0];
  let logId = null;
  let claim;
  try {
    claim = await claimEntityGraphRebuild(env.DB, { source, now: startTime, force });
  } catch (startError) {
    console.error("Could not record entity graph rebuild start; not running it:", startError);
    throw new Error(`entity graph rebuild not started: ${String(startError?.message || startError)}`);
  }
  if (claim.locked) {
    console.warn(`Entity graph rebuild (${source}) skipped: another rebuild is running`);
    throw entityGraphRebuildLockedError();
  }
  logId = claim.logId;

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
  return formatCalendarDate(d) || String(d);
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
  // Bare counts get thousands separators (audit E18); preformatted values
  // ("$1.2M", dates) pass through unchanged.
  return `<div class="bs-metric"><span class="bs-metric__value">${formatCount(value)}</span><span class="bs-metric__label">${escapeHtml(label)}</span></div>`;
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

function renderBasisResetPage(env) {
  return getBasisResetRadar(new Request("https://buildingseattle.com/api/basis-reset?limit=50"), env)
    .then(async (response) => {
      const payload = await response.json();
      const rows = payload.results || [];
      const canonical = `${BASE_URL}/insights/basis-reset`;
      const description = "Seattle properties where a lower basis and existing development work may change redevelopment economics.";
      // Every sitemapped /insights/* page carries a Dataset (the SEO monitor
      // checks for it); the radar joins the sitemap once it has scores.
      const jsonLd = JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "Dataset",
            name: "Seattle Basis Reset Radar",
            description,
            url: canonical,
            creator: { "@type": "Organization", name: "Building Seattle" },
          },
          {
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
              { "@type": "ListItem", position: 2, name: "Insights", item: `${BASE_URL}/insights` },
              { "@type": "ListItem", position: 3, name: "Basis Reset Radar", item: canonical },
            ],
          },
        ],
      }).replace(/</g, "\\u003c");
      const html = renderEntityDoc({
        title: "Basis Reset Radar | Building Seattle",
        description,
        canonical,
        jsonLd,
        // An empty radar is one sentence of copy: keep it out of the index
        // (and the sitemap, see hasBasisResetRows) until it has scores.
        noindex: rows.length === 0,
        activeNav: "insights",
        body: `${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Insights", href: "/insights" }, { label: "Basis Reset Radar" }])}
      <div class="ent-hero">
        <div class="ent-kicker">Insights</div>
        <h1>Basis Reset Radar</h1>
        <p style="color:var(--text-muted);max-width:65ch;margin:0">Properties where capital-basis changes intersect with real permit and project activity. Scores prioritize evidence; they are not appraisals or forecasts.</p>
      </div>
      ${renderBasisResetRadarBody(rows)}
      <p style="color:var(--text-muted);margin-top:1.5rem">Method: 45% observed basis reset, 35% redevelopment readiness, 20% signal strength and recency.</p>`,
      });
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
      });
    });
}

// The radar page is indexable (and sitemapped) only once it lists a score.
async function hasBasisResetRows(env) {
  const row = await env.DB.prepare(
    "SELECT 1 AS present FROM basis_reset_scores s JOIN basis_reset_events e ON e.id = s.latest_event_id LIMIT 1",
  ).first();
  return Boolean(row?.present);
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
        <td>${p.type ? escapeHtml(permitTypeLabel(p.type)) : "—"}</td>
        <td>${entMoney(p.value)}</td>
        <td>${p.status ? bsStatusPill(p.status, statusLabel(p.status)) : "—"}</td>
        <td>${entDate(p.issued_date || p.applied_date)}</td>
      </tr>`,
    )
    .join("");
  return `<div class="table-scroll" role="region" aria-label="Permits" tabindex="0"><table class="ent"><thead><tr><th>Permit</th><th>Type</th><th>Value</th><th>Status</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Newest SDCI source event (applied/issued/completed) among an entity's
// permits. Row-touch timestamps are ignored: every upsert bumps them.
export function latestPermitActivity(permits) {
  return latestSourceEventDate(permits);
}

const ENTITY_HUB_PAGE_SIZE = 48;
const ACTIVE_PERMIT_SQL =
  "lower(COALESCE(p.status, '')) IN ('active', 'pending', 'new', 'in review', 'under review')";
// MULTI_PERMIT_PROJECT_SQL and the other indexing predicates live in
// entity_hubs.js so sibling modules (basis_reset_routes.js) share them.
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

// The contractors hub selects people_orgs.type_guess as its detail line, a
// raw enum ("organization", "person"). Show what the card is instead
// (audit E16/E17); other hubs already select readable text.
function hubDetailLabel(type, detail) {
  if (type === "contractors") {
    const kind = String(detail || "").trim().toLowerCase();
    if (kind === "person") return "Contractor (individual)";
    if (!kind || kind === "organization" || kind === "contractor") return "Contractor";
    return displayName(detail);
  }
  return detail ? displayName(detail) : "Seattle construction activity";
}

function buildEntityHubQuery(type, state) {
  const config = ENTITY_HUBS[type];
  const where = [];
  const havingParts = [];
  const binds = [];
  if (config.baseWhereSql) where.push(config.baseWhereSql);
  if (config.baseHavingSql) havingParts.push(config.baseHavingSql);
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
  const freshnessPromise = getDataFreshness(env);
  let items = [];
  try {
    const result = await env.DB.prepare(query.sql).bind(...query.binds).all();
    items = result.results || [];
  } catch (error) {
    // A failed read is "ask again later", never a cached 200 noindex page.
    console.error(`entity-hub query failed for ${type}:`, error);
    return renderTemporarilyUnavailable();
  }
  if (items.length === 0) {
    // Past the last page there is nothing to publish: 404 (503 while the graph
    // is mid-rebuild). An empty unfiltered first page means the graph itself is
    // empty or unreadable, which is never a state to index or cache.
    if (state.page > 1) {
      return entityNotFound(env, { heading: "Page not found", message: `There are no more ${config.itemLabel} on this page. Start from the first page.` });
    }
    if (!state.hasFilters) return renderTemporarilyUnavailable();
  }

  const hasNext = items.length > ENTITY_HUB_PAGE_SIZE;
  items = items.slice(0, ENTITY_HUB_PAGE_SIZE);
  // Site-wide source freshness, the same value every hub and insight page
  // shows, instead of the newest item on this page (which differed per page).
  const updatedThrough = (await freshnessPromise)?.updated_through || null;
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
        <h2 style="font-size:1.05rem;margin:0 0 0.4rem;"><a class="ent-link" href="${config.pathPrefix}${encodeURIComponent(item.slug)}">${escapeHtml(displayName(item.label) || item.label)}</a></h2>
        <p style="margin:0 0 0.75rem;color:var(--text-muted);font-size:0.875rem;">${escapeHtml(hubDetailLabel(type, item.detail))}</p>
        <div style="display:flex;gap:1rem;font-size:0.8rem;font-weight:650;"><span>${countLabel(item.permit_count, "permit")}</span><span>${value}</span></div>
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
    ${items.length ? `<p style="color:var(--text-muted);">Page ${state.page}: showing ${items.length} ${config.itemLabel} from current public permit records.</p><section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1rem;">${cards}</section>${pagination}` : `<div class="bs-card"><h2>No matching ${escapeHtml(config.itemLabel)}</h2><p>No ${escapeHtml(config.itemLabel)} match these filters. <a class="ent-link" href="/${type}">View all ${escapeHtml(config.itemLabel)}</a></p></div>`}
    ${renderDataTrustNote(updatedThrough, "Hub rankings aggregate public permit records; declared value is not verified project cost.")}`;

  // Each page of a hub is self-canonical and indexable (crawlable pagination
  // is how deep entity pages are discovered), so each gets its own title and
  // description instead of sharing page 1's.
  const pageSuffix = state.page > 1 ? ` — Page ${state.page}` : "";
  return new Response(
    renderEntityDoc({
      title: `${config.title}${pageSuffix} | Building Seattle`,
      description: state.page > 1 ? `Page ${state.page}. ${config.description}` : config.description,
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
  // Bucket by upper bound so fractional values (30.5 days) land in the next
  // bucket instead of falling between 0–30 and 31–60; the bars then always
  // add up to the "based on N" count (audit G7).
  const histogram = PLAN_REVIEW_DAY_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const v of sorted) {
    const index = PLAN_REVIEW_DAY_BUCKETS.findIndex((b) => v <= b.max);
    histogram[index].count += 1;
  }
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
    // Cycle figures use the same reviewed population as the headline count
    // (audit G7), with 10 or more cycles grouped so no tail is cut off.
    safeAll(
      env,
      `SELECT CASE WHEN number_review_cycles >= 10 THEN 10 ELSE CAST(number_review_cycles AS INTEGER) END AS cycles, COUNT(*) AS cnt
       FROM permits WHERE ${reviewedWhere} AND number_review_cycles IS NOT NULL AND number_review_cycles >= 0
       GROUP BY cycles ORDER BY cycles ASC`,
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
       FROM permits WHERE ${reviewedWhere} AND number_review_cycles IS NOT NULL AND number_review_cycles >= 0`,
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
    label: t.label === "unknown" ? "Type not reported" : permitTypeLabel(t.label),
    value: t.avg_days,
    display: countLabel(t.avg_days, "day"),
    sub: countLabel(t.count, "permit"),
  }));

  const neighborhoodRows = data.by_neighborhood.map((n) => ({
    label: n.label,
    href: n.slug ? `/neighborhood/${encodeURIComponent(n.slug)}` : null,
    value: n.avg_days,
    display: countLabel(n.avg_days, "day"),
    sub: countLabel(n.count, "permit"),
  }));

  const cycleTotal = data.by_cycles.reduce((sum, c) => sum + c.count, 0);
  const cycleRows = data.by_cycles.map((c) => ({
    label: c.cycles >= 10 ? "10+ cycles" : countLabel(c.cycles, "cycle"),
    value: c.count,
    display: formatCount(c.count),
    sub: cycleTotal ? `${Math.round((c.count / cycleTotal) * 100)}%` : "",
  }));

  const reviewLevelRows = data.by_review_level.map((r) => ({
    label: r.label,
    value: r.avg_days,
    display: countLabel(r.avg_days, "day"),
    sub: countLabel(r.count, "permit"),
  }));

  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Insights", href: "/insights" }, { label: "Plan Review Times" }])}
    ${insightsStyles()}
    ${insightsTabs("plan-review")}
    <div class="ent-hero">
      <div class="ent-kicker">Insights</div>
      <h1>How long does Seattle permit plan review take?</h1>
      <p style="color:var(--text-muted);max-width:65ch;margin:0;">Based on ${countLabel(s.count, "permit")} with recorded SDCI plan-review timing. "Plan review" is the time spent in review cycles before a permit is issued.</p>
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
        ${cycleTotal ? `<p style="color:var(--text-muted);margin-top:0;font-size:0.85rem;">${formatCount(cycleTotal)} of the ${formatCount(s.count)} reviewed permits also report a cycle count.</p>` : ""}
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
             ${LATEST_SOURCE_EVENT_SQL} AS data_updated_through
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
     SELECT ${LATEST_SOURCE_EVENT_SQL} AS updated_through,
            COUNT(*) AS permit_count
     FROM permits`,
  );
}

// scope "site": updatedThrough is the site-wide newest SDCI event
// (getDataFreshness). scope "entity": the newest event among this page's own
// permits, which is activity, not freshness, so it is labelled as such.
function renderDataTrustNote(updatedThrough, extra = "", scope = "site") {
  const label = formatCalendarDate(updatedThrough);
  const freshness = !label
    ? "Freshness is shown when the source record provides a usable date."
    : scope === "entity"
      ? `Latest permit activity on record here: ${escapeHtml(label)}.`
      : `Source records updated through ${escapeHtml(label)} (newest SDCI permit event).`;
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
              ${LATEST_SOURCE_EVENT_SQL} AS updated_through
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
// the canonical NEIGHBORHOOD_BOUNDS (sdci_mappings.js, data/sdci_mappings.json). Lazy so it reads
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

// Strict reads for entity pages: a D1 error throws instead of looking like an
// empty result, so the caller can answer 503 rather than derive a 404, 410 or
// noindex from a read that never happened.
async function strictAll(env, sql, binds = []) {
  return (await env.DB.prepare(sql).bind(...binds).all()).results || [];
}
async function strictFirst(env, sql, binds = []) {
  return (await env.DB.prepare(sql).bind(...binds).first()) || null;
}

// Whether the entity graph can be trusted to say "this entity does not exist"
// or "this entity is empty" right now. Not while the latest rebuild is running
// or did not finish cleanly (slugs and links may be half-moved), and, when
// `requireLinked`, not while any permit still waits to be linked to an
// address. A failed read counts as unsettled. No rebuild row yet counts as
// settled.
async function entityGraphSettled(env, { requireLinked = false } = {}) {
  let check = null;
  try {
    check = await env.DB.prepare(
      `SELECT EXISTS(SELECT 1 FROM permits WHERE address_id IS NULL AND NOT ${unaddressableAddressSql("permits")}) AS pending,
              (SELECT status FROM ingest_logs WHERE run_type = 'entity_graph' ORDER BY id DESC LIMIT 1) AS last_rebuild`,
    ).first();
  } catch (error) {
    console.error("Entity graph integrity check failed:", error);
    return false;
  }
  if (!check) return !requireLinked;
  if (["running", "error", "partial"].includes(check.last_rebuild)) return false;
  return !requireLinked || Number(check.pending) === 0;
}

// 404 for a slug the graph does not have, unless the graph is mid-rebuild or
// unreadable, when the slug may merely be moving: then 503.
async function entityNotFound(env, options) {
  if (!(await entityGraphSettled(env))) return renderTemporarilyUnavailable();
  return render404(options);
}

// 410 for an entity row with nothing left to publish, unless the graph cannot
// vouch for that (see entityGraphSettled): then 503.
async function entityGone(env, options) {
  if (!(await entityGraphSettled(env, { requireLinked: true }))) return renderTemporarilyUnavailable();
  return renderGone(options);
}

// Address titles stay inside the 62-character SERP budget the SEO monitor
// enforces: drop the value first, then shorten the address itself.
const ADDRESS_TITLE_MAX = 62;
function fitAddressTitle(display, permitFact, money) {
  const full = `${display} — ${permitFact}${money ? ` · ${money}` : ""}`;
  if (full.length <= ADDRESS_TITLE_MAX) return full;
  const suffix = ` — ${permitFact}`;
  if (display.length + suffix.length <= ADDRESS_TITLE_MAX) return `${display}${suffix}`;
  return `${display.slice(0, Math.max(1, ADDRESS_TITLE_MAX - suffix.length - 1)).trimEnd()}…${suffix}`;
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
    return entityNotFound(env, {
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
    return entityGone(env, {
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
  // Zero-permit addresses return 410 above. A single-permit address repeats
  // its one permit page, and a city-only placeholder ("Seattle, Seattle, WA")
  // lumps unrelated permits together: both stay reachable for people but are
  // noindex,follow and left out of the sitemap and hub (addressIsIndexable).
  const noindex = !addressIsIndexable(address, permitCount);

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
  const title = fitAddressTitle(display, titlePermitFact, totalValue ? compactMetricMoney(totalValue) : "");

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
  const contractorSentence = latestContractor ? ` Contractor: ${displayName(latestContractor)}.` : "";
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
          { "@type": "ListItem", position: 2, name: "Addresses", item: `${BASE_URL}/addresses` },
          ...(neighborhood
            ? [{ "@type": "ListItem", position: 3, name: neighborhood.name, item: `${BASE_URL}/neighborhood/${encodeURIComponent(neighborhood.slug)}` }]
            : []),
          { "@type": "ListItem", position: neighborhood ? 4 : 3, name: display, item: canonical },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");

  // Empty side lists are left off the page instead of rendering placeholder
  // copy (audit E15/E21).
  const projectsHtml = projects.length
    ? `<ul class="ent-list">${projects
        .map(
          (pr) => `<li>
            <a class="ent-link" href="/project/${encodeURIComponent(pr.slug)}">${escapeHtml(pr.name)}</a>
            <div style="font-size:0.8rem;color:var(--text-muted);">${entMoney(pr.total_estimated_value)} · ${entDate(pr.first_seen_date)} – ${entDate(pr.latest_activity_date)} · confidence ${pr.confidence_score}</div>
          </li>`,
        )
        .join("")}</ul>`
    : "";

  const participantsHtml = participants.length
    ? `<ul class="ent-list">${participants
        .map(
          (o) => `<li>
            <a class="ent-link" href="/contractor/${encodeURIComponent(o.slug)}">${escapeHtml(displayName(o.name))}</a>
            <span class="pill" style="margin-left:0.4rem;">${escapeHtml(roleLabel(o.role))}</span>
            <span style="font-size:0.8rem;color:var(--text-muted);"> · ${countLabel(o.cnt, "permit")}</span>
          </li>`,
        )
        .join("")}</ul>`
    : "";

  const relatedHtml = related.length
    ? `<ul class="ent-list">${related
        .map(
          (a) => `<li><a class="ent-link" href="/address/${encodeURIComponent(a.slug)}">${escapeHtml(displayName(a.display_address))}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${countLabel(a.permits, "permit")}</span></li>`,
        )
        .join("")}</ul>`
    : "";
  const firstMonth = formatMonthYear(firstDate);
  const lastMonth = formatMonthYear(lastDate);
  const activitySpan = firstMonth && lastMonth && firstMonth !== lastMonth
    ? `Permit activity at this address runs from ${firstMonth} to ${lastMonth}`
    : firstMonth
      ? `Permit activity at this address dates to ${firstMonth}`
      : "";
  const guideSentence = `Each permit below links to its own record with status, dates, and the work description${relatedHtml ? ", and nearby addresses in the same neighborhood are listed alongside" : ""}.`;

  const body = `
    ${entBreadcrumb([
      { label: "Home", href: "/" },
      { label: "Addresses", href: "/addresses" },
      ...(neighborhood ? [{ label: neighborhood.name, href: `/neighborhood/${encodeURIComponent(neighborhood.slug)}` }] : []),
      { label: display },
    ])}
    <div class="ent-hero">
      <div class="ent-kicker">Address</div>
      <h1>${escapeHtml(display)}</h1>
      ${featuredDescriptor ? `<p style="margin:0.75rem 0 0;max-width:760px;font-size:1.05rem;line-height:1.6;color:var(--text);"><strong>${escapeHtml(featuredDescriptor)}</strong>${featuredPermit?.permit_number ? ` <span style="color:var(--text-muted);">· <a class="ent-link" href="/permits/${encodeURIComponent(featuredPermit.permit_number)}">Permit ${escapeHtml(featuredPermit.permit_number)}</a></span>` : ""}</p>` : ""}
      ${neighborhood ? `<a class="ent-link" href="/neighborhood/${encodeURIComponent(neighborhood.slug)}">${escapeHtml(neighborhood.name)}</a>` : ""}
    </div>
    <div style="max-width:var(--container-max);margin:0 auto 2.5rem;padding:0 1.5rem;">
      <div class="bs-card" style="margin-bottom:0;">
        <div style="font-size:1.05rem;line-height:1.85;color:var(--text-muted);">
          <p style="margin:0 0 1rem;">${escapeHtml(display)} is a property in Seattle${neighborhood ? `'s <a class="ent-link" href="/neighborhood/${encodeURIComponent(neighborhood.slug)}">${escapeHtml(neighborhood.name)}</a> neighborhood` : ""} with <strong style="color:var(--text);">${permitCount} construction permit${permitCount !== 1 ? "s" : ""}</strong> on record with the Seattle Department of Construction and Inspections${activePermits.length > 0 ? `, <strong style="color:var(--text);">${activePermits.length} of which ${activePermits.length === 1 ? "is" : "are"} currently active</strong>` : ""}.${totalValue > 0 ? ` The combined estimated project value across all permits is <strong style="color:var(--text);">$${parseInt(totalValue).toLocaleString()}</strong>.` : ""}</p>
          ${activitySpan ? `<p style="margin:0 0 1rem;">${activitySpan}${featuredPermit?.permit_number ? `, with the featured record filed under permit number <a class="ent-link" href="/permits/${encodeURIComponent(featuredPermit.permit_number)}">${escapeHtml(featuredPermit.permit_number)}</a>` : ""}.${latestContractor && permits[0]?.contractor_slug ? ` The latest contractor associated with this address is <a class="ent-link" href="/contractor/${encodeURIComponent(permits[0].contractor_slug)}">${escapeHtml(displayName(latestContractor))}</a>.` : ""}</p>` : ""}
          <p style="margin:0;">${guideSentence}</p>
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
            ${entStat("Active", activePermits.length)}
            ${entStat("Projects", projects.length)}
          </div>
          <div style="font-size:0.85rem;color:var(--text-muted);">${firstDate === lastDate ? `Permit date ${entDate(firstDate)}` : `First permit ${entDate(firstDate)} · Latest permit ${entDate(lastDate)}`}</div>
        </div>
        <div class="bs-card">
          <h2>Permit records (${formatCount(permitCount)})</h2>
          ${entPermitRows(permits)}
        </div>
      </div>
      <div>
        ${renderAlertCta({ permits, subject: display })}
        ${projectsHtml ? `<div class="bs-card"><h3>Inferred projects</h3>${projectsHtml}</div>` : ""}
        ${participantsHtml ? `<div class="bs-card"><h3>Contractors &amp; participants</h3>${participantsHtml}</div>` : ""}
        ${relatedHtml ? `<div class="bs-card"><h3>Nearby addresses${neighborhood ? ` in ${escapeHtml(neighborhood.name)}` : ""}</h3>${relatedHtml}<p style="margin:0.75rem 0 0;font-size:0.85rem;"><a class="ent-link" href="/addresses${neighborhood ? `?neighborhood=${encodeURIComponent(neighborhood.name)}` : ""}">All addresses${neighborhood ? ` in ${escapeHtml(neighborhood.name)}` : ""} &rarr;</a></p></div>` : ""}
        ${renderDatasetCta({ context: "address", subject: `the permits at ${entStreet(display) || display}`, count: permitCount })}
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
      body: `${body}${renderDataTrustNote(latestPermitActivity(permits), "Property totals aggregate public permit records; declared value is not verified project cost.", "entity")}`,
    }),
    { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" } },
  );
}

async function renderProjectPage(slug, env, request) {
  const selfUrl = `${BASE_URL}/project/${encodeURIComponent(slug)}`;
  // Every read that decides the status, robots or canonical is strict: a D1
  // error answers 503 instead of a cached 200 noindex or a false 404.
  let project;
  let permits;
  let participants;
  let neighborhood;
  try {
    project = await strictFirst(
      env,
      `SELECT pr.*, a.display_address, a.slug AS address_slug, a.city, a.state
       FROM projects pr LEFT JOIN addresses a ON a.id = pr.address_id WHERE pr.slug = ?`,
      [slug],
    );
    if (!project) {
      return entityNotFound(env, { heading: "Project not found", message: "We have not clustered a project under that name yet." });
    }
    [permits, participants, neighborhood] = await Promise.all([
      strictAll(
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
  } catch (error) {
    console.error("Project lookup failed:", error);
    return renderTemporarilyUnavailable();
  }
  if (permits.length === 0) {
    return entityGone(env, {
      heading: "This project has no permits on record",
      message: "The permits this project grouped are no longer in the public Seattle DCI data we publish. Try the property page or browse permits.",
    });
  }

  // projectPagePolicy (entity_hubs.js) is the JS twin of
  // MULTI_PERMIT_PROJECT_SQL, which decides what the sitemap, hub and listings
  // show. A one-permit cluster, or one holding every permit at its address,
  // repeats the address page and redirects there; a small strict subset of the
  // address is noindex; everything else is its own indexable page.
  let addressPermitCount = null;
  if (permits.length > 1 && projectIsWithinAddress(permits, project.address_id)) {
    try {
      const row = await strictFirst(env, `SELECT COUNT(*) AS total FROM permits WHERE address_id = ?`, [project.address_id]);
      addressPermitCount = row ? Number(row.total) : null;
    } catch (error) {
      console.error("Project address count failed:", error);
      return renderTemporarilyUnavailable();
    }
  }
  const policy = projectPagePolicy({
    permits,
    addressId: project.address_id,
    addressSlug: project.address_slug,
    addressPermitCount,
  });
  const addressUrl = project.address_slug ? `${BASE_URL}/address/${encodeURIComponent(project.address_slug)}` : null;
  if (policy.action === "redirect") {
    // Short-lived: the URL becomes a real page again if the project gains a
    // permit or the address gains one outside this project.
    return new Response(null, {
      status: 301,
      headers: { Location: addressUrl, "Cache-Control": "public, max-age=3600" },
    });
  }
  const noindex = policy.action === "noindex";
  const canonical = policy.canonical === "address" ? addressUrl : selfUrl;

  // "Prefix at Street" names repeat when an address has several clusters of
  // the same kind. Such pages are subsets of one address page and were the
  // next likely "duplicate, Google chose a different canonical" group, so
  // their titles and descriptions carry the lead permit.
  const leadPermit = [...permits]
    .sort((a, b) => String(a.issued_date || a.applied_date || "").localeCompare(String(b.issued_date || b.applied_date || "")) || String(a.permit_number).localeCompare(String(b.permit_number)))[0]?.permit_number || "";
  const nameTwin = await safeFirst(env, `SELECT 1 AS taken FROM projects WHERE name = ? AND id != ? LIMIT 1`, [project.name, project.id]);
  const twinPermit = nameTwin && leadPermit ? leadPermit : "";
  const title = twinPermit ? `${project.name} — Permit ${twinPermit}` : `${project.name} | Building Seattle`;

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
          { "@type": "ListItem", position: 2, name: "Projects", item: `${BASE_URL}/projects` },
          { "@type": "ListItem", position: 3, name: project.name, item: selfUrl },
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
        .join(" ")} <a class="ent-link" href="/methodology#value">How values are counted</a></p>`
    : "";
  const projectAddress = displayName(project.display_address);
  const firstMonth = formatMonthYear(project.first_seen_date);
  const lastMonth = formatMonthYear(project.latest_activity_date);
  const span = firstMonth && lastMonth && firstMonth !== lastMonth ? `${firstMonth} to ${lastMonth}` : firstMonth || lastMonth;
  // Data-driven description (audit E19) instead of one sentence per template.
  const description = truncateMetaDescription(
    `${countLabel(permits.length, "Seattle building permit")} grouped as one project${twinPermit ? ` led by permit ${twinPermit}` : ""}${projectAddress ? ` at ${projectAddress}` : ""}${projectValue ? `, ${compactMetricMoney(projectValue)} counted value` : ""}${span ? `, ${span}` : ""}. Permit records, contractors and review timing.`,
    160,
  );
  const participantsHtml = participants.length
    ? `<ul class="ent-list">${participants
        .map(
          (o) => `<li><a class="ent-link" href="/contractor/${encodeURIComponent(o.slug)}">${escapeHtml(displayName(o.name))}</a> <span class="pill" style="margin-left:0.4rem;">${escapeHtml(roleLabel(o.role))}</span></li>`,
        )
        .join("")}</ul>`
    : "";

  const body = `
    ${entBreadcrumb([
      { label: "Home", href: "/" },
      { label: "Projects", href: "/projects" },
      { label: project.name },
    ])}
    <div class="ent-hero">
      <div class="ent-kicker">Inferred project${project.confidence_score != null ? ` · match confidence ${escapeHtml(project.confidence_score)}/100` : ""}</div>
      <h1>${escapeHtml(project.name)}</h1>
      ${project.address_slug ? `<a class="ent-link" href="/address/${encodeURIComponent(project.address_slug)}">${escapeHtml(projectAddress)}</a>` : ""}
      ${neighborhood ? ` · <a class="ent-link" href="/neighborhood/${encodeURIComponent(neighborhood.slug)}">${escapeHtml(neighborhood.name)}</a>` : ""}
    </div>
    <div class="ent-grid">
      <div>
        <div class="bs-card">
          <h2>Summary</h2>
          <div class="stat-row">
            ${entStat("Permits", permits.length)}
            ${entStat("Total value", entMoney(projectValue))}
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
        ${renderAlertCta({ permits, subject: project.name })}
        ${participantsHtml ? `<div class="bs-card"><h3>Participants</h3>${participantsHtml}</div>` : ""}
        <div class="bs-card">
          <h3>About this project</h3>
          <p style="font-size:0.85rem;color:var(--text-muted);margin:0;">This project was inferred by grouping related permits at the same address.${project.confidence_score != null ? ` A match confidence of ${escapeHtml(project.confidence_score)}/100 reflects how strongly the permits appear to belong to a single effort.` : ""}${project.address_slug ? ` <a class="ent-link" href="/address/${encodeURIComponent(project.address_slug)}">Every permit at ${escapeHtml(projectAddress)}</a>.` : ""}</p>
        </div>
        ${renderDatasetCta({ context: "project", subject: "this project's permits", count: permits.length })}
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
      body: `${body}${renderDataTrustNote(latestPermitActivity(permits) || project.latest_activity_date, "Projects are inferred permit groups, not verified completed developments.", "entity")}`,
    }),
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } },
  );
}

async function renderNeighborhoodPage(slug, env, request) {
  const canonical = `${BASE_URL}/neighborhood/${encodeURIComponent(slug)}`;
  let nb;
  try {
    nb = await strictFirst(env, "SELECT * FROM neighborhoods WHERE slug = ?", [slug]);
  } catch (error) {
    console.error("Neighborhood lookup failed:", error);
    return renderTemporarilyUnavailable();
  }
  if (!nb) {
    return entityNotFound(env, { heading: "Neighborhood not found", message: "We do not track that neighborhood yet." });
  }

  // The permit list and totals decide status and robots, so they are strict;
  // the side lists degrade to empty.
  let recentPermits, projects, topContractors, totals, topAddresses;
  try {
    [recentPermits, projects, topContractors, totals, topAddresses] = await Promise.all([
      strictAll(
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
      strictFirst(
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
  } catch (error) {
    console.error("Neighborhood permit read failed:", error);
    return renderTemporarilyUnavailable();
  }

  const permitCount = Number(totals?.permits) || 0;
  const totalValue = Number(totals?.total_value) || 0;
  if (permitCount === 0) {
    return entityGone(env, {
      heading: "This neighborhood has no permits on record",
      message: "We no longer have construction permit records for this neighborhood in the public Seattle DCI data we publish. Browse all neighborhoods instead.",
    });
  }
  // "Other Seattle" / "Other" are geocoder fallbacks, not places: reachable,
  // never indexed, and kept out of the sitemap, hub and rankings.
  const noindex = isPlaceholderNeighborhood(nb.name);
  const title = `${nb.name} Building Permits, Seattle | Building Seattle`;
  const latestActivity = latestPermitActivity(recentPermits);
  // Data-driven description (audit E19): this neighborhood's own figures
  // instead of one sentence shared by every neighborhood page.
  const description = truncateMetaDescription(
    `${countLabel(permitCount, "building permit")} in ${nb.name}, Seattle${totalValue ? ` worth ${compactMetricMoney(totalValue)} in counted value` : ""}${latestActivity ? `, latest ${formatCalendarDate(latestActivity)}` : ""}. Recent permits, contractors and the busiest addresses.`,
    160,
  );
  const nbFilter = encodeURIComponent(nb.name);

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
  const viewAll = (href, label) => `<p style="margin:0.75rem 0 0;font-size:0.85rem;"><a class="ent-link" href="${href}">${label} &rarr;</a></p>`;

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
        ${entStat("Latest permit activity", latestActivity ? entDate(latestActivity) : "—")}
      </div>
      <p style="margin:0;font-size:0.8rem;color:var(--text-muted);">Total value counts a valuation SDCI repeats across related demolition permits once. <a class="ent-link" href="/methodology#value">How values are counted</a></p>
    </div>
    <div class="ent-grid">
      <div>
        <div class="bs-card">
          <h2>Recent permits</h2>
          ${entPermitRows(recentPermits)}
          ${permitCount > recentPermits.length ? viewAll(`/permits?neighborhood=${nbFilter}`, `All ${countLabel(permitCount, "permit")} in ${escapeHtml(nb.name)}`) : ""}
        </div>
        ${projects.length ? `<div class="bs-card">
          <h2>Recent projects</h2>
          ${listOrEmpty(
            projects,
            (pr) =>
              `<li><a class="ent-link" href="/project/${encodeURIComponent(pr.slug)}">${escapeHtml(pr.name)}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${entMoney(pr.total_estimated_value)} · ${entDate(pr.latest_activity_date)}</span></li>`,
            "",
          )}
          ${viewAll("/projects", "Browse all projects")}
        </div>` : ""}
      </div>
      <div>
        ${renderAlertCta({ permits: recentPermits, subject: nb.name })}
        <div class="bs-card">
          <h3>Top contractors</h3>
          ${listOrEmpty(
            topContractors,
            (c) => `<li><a class="ent-link" href="/contractor/${encodeURIComponent(c.slug)}">${escapeHtml(displayName(c.name))}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${countLabel(c.cnt, "permit")}</span></li>`,
            "No contractors on record.",
          )}
          ${topContractors.length ? viewAll(`/contractors?neighborhood=${nbFilter}`, `All contractors in ${escapeHtml(nb.name)}`) : ""}
        </div>
        <div class="bs-card">
          <h3>Most active addresses</h3>
          ${listOrEmpty(
            topAddresses,
            (a) => `<li><a class="ent-link" href="/address/${encodeURIComponent(a.slug)}">${escapeHtml(displayName(a.display_address))}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${countLabel(a.permits, "permit")}</span></li>`,
            "No addresses on record.",
          )}
          ${topAddresses.length ? viewAll(`/addresses?neighborhood=${nbFilter}`, `All addresses in ${escapeHtml(nb.name)}`) : ""}
        </div>
        ${renderDatasetCta({ context: "neighborhood", subject: `${nb.name} permits`, count: permitCount })}
      </div>
    </div>`;

  return new Response(
    renderEntityDoc({
      title,
      description,
      canonical,
      jsonLd,
      noindex,
      body: `${body}${renderDataTrustNote(latestActivity, "Neighborhood totals aggregate public permit records and do not represent completed projects or housing units.", "entity")}`,
    }),
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } },
  );
}

// People/org-backed contractor page (owners, applicants, architects, and any
// contractor not present in the curated `contractors` table). Backed by
// permit_participants so /contractor/:slug works for the whole graph.
async function renderOrgContractorPage(slug, env, request) {
  const selfUrl = `${BASE_URL}/contractor/${encodeURIComponent(slug)}`;
  let org;
  try {
    org = await strictFirst(env, "SELECT * FROM people_orgs WHERE slug = ?", [slug]);
  } catch (error) {
    console.error("People/org lookup failed:", error);
    return renderTemporarilyUnavailable();
  }
  if (!org) {
    return entityNotFound(env, {
      heading: "Contractor not found",
      message: "We do not have a profile for that contractor yet.",
    });
  }

  // The permit list, the permit count and the index policy (trade role,
  // curated duplicate) decide status, robots and canonical: strict reads.
  let permits, addresses, projects, neighborhoods, roles, countRow, indexPolicy;
  try {
    [permits, addresses, projects, neighborhoods, roles, countRow, indexPolicy] = await Promise.all([
      strictAll(
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
         WHERE pp.people_org_id = ? AND ${realNeighborhoodSql("n.name")} GROUP BY n.id ORDER BY cnt DESC LIMIT 5`,
        [org.id],
      ),
      safeAll(env, `SELECT DISTINCT role FROM permit_participants WHERE people_org_id = ?`, [org.id]),
      strictFirst(
        env,
        `SELECT COUNT(DISTINCT p.id) AS permit_count,
                COUNT(DISTINCT CASE WHEN lower(COALESCE(p.status,'')) IN ('active','pending','new') THEN p.id END) AS active_count
         FROM permit_participants pp JOIN permits p ON p.id = pp.permit_id
         WHERE pp.people_org_id = ?`,
        [org.id],
      ),
      strictFirst(env, ORG_INDEX_POLICY_SQL, [org.id]),
    ]);
  } catch (error) {
    console.error("People/org permit read failed:", error);
    return renderTemporarilyUnavailable();
  }
  if (permits.length === 0) {
    return entityGone(env, {
      heading: "No permits on record",
      message: "We no longer have construction permit records for this name in the public Seattle DCI data we publish. Try browsing contractors instead.",
    });
  }
  // Pages for owners and applicants (often private people) stay reachable but
  // noindex and out of the sitemap; only trade roles are published. When a
  // curated contractor publishes the same company under another slug, that
  // page is the canonical one.
  const noindex = !Number(indexPolicy?.has_role);
  const canonical = indexPolicy?.curated_slug
    ? `${BASE_URL}/contractor/${encodeURIComponent(indexPolicy.curated_slug)}`
    : selfUrl;

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
  const shownPermits = permits.length;
  const totalPermits = countRow ? Math.max(Number(countRow.permit_count) || 0, shownPermits) : shownPermits;
  const activeCount = countRow
    ? Number(countRow.active_count) || 0
    : permits.filter((p) => ["active", "pending", "new"].includes(p.status)).length;
  const permitListHeading = totalPermits > shownPermits
    ? `Recent permits (${shownPermits} of ${totalPermits.toLocaleString("en-US")})`
    : `Permits (${shownPermits})`;
  const roleLabels = roleList(roles);
  const isContractor = roles.some((r) => String(r.role || "").toLowerCase() === "contractor");
  const isOrg = org.type_guess === "organization";
  const name = displayName(org.name) || org.name;
  const latestActivity = latestPermitActivity(permits);
  const parent = isContractor ? { label: "Contractors", href: "/contractors" } : { label: "Permits", href: "/permits" };

  const title = `${name}: Seattle Permits | Building Seattle`;
  // Data-driven description (audit E19): this entity's own figures.
  const description = truncateMetaDescription(
    `${name}: ${countLabel(totalPermits, "Seattle building permit")} as ${roleLabels.toLowerCase()}${activeCount ? `, ${formatCount(activeCount)} active` : ""}${totalValue ? `, ${compactMetricMoney(totalValue)} counted value` : ""}. Permit records, addresses and neighborhoods.`,
    160,
  );

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      isOrg
        ? {
            "@type": "Organization",
            name,
            url: canonical,
            address: { "@type": "PostalAddress", addressLocality: "Seattle", addressRegion: "WA", addressCountry: "US" },
          }
        : { "@type": "Person", name, url: canonical },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: parent.label, item: `${BASE_URL}${parent.href}` },
          { "@type": "ListItem", position: 3, name, item: selfUrl },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");

  const listOrEmpty = (rows, fn, empty) =>
    rows.length ? `<ul class="ent-list">${rows.map(fn).join("")}</ul>` : `<p style="color:var(--text-muted);">${empty}</p>`;

  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, parent, { label: name }])}
    <div class="ent-hero">
      <div class="ent-kicker">${escapeHtml(isOrg ? "Organization" : "Person")} · ${escapeHtml(roleLabels)}</div>
      <h1>${escapeHtml(name)}</h1>
    </div>
    <div class="bs-card">
      <div class="stat-row">
        ${entStat("Permits", totalPermits)}
        ${entStat("Active", activeCount)}
        ${entStat("Total value", entMoney(totalValue))}
        ${entStat("Latest permit activity", latestActivity ? entDate(latestActivity) : "—")}
      </div>
    </div>
    <div class="ent-grid">
      <div>
        <div class="bs-card">
          <h2>${escapeHtml(permitListHeading)}</h2>
          ${entPermitRows(permits)}
        </div>
        ${projects.length ? `<div class="bs-card">
          <h2>Inferred projects</h2>
          ${listOrEmpty(
            projects,
            (pr) => `<li><a class="ent-link" href="/project/${encodeURIComponent(pr.slug)}">${escapeHtml(pr.name)}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${entMoney(pr.total_estimated_value)} · ${entDate(pr.latest_activity_date)}</span></li>`,
            "",
          )}
        </div>` : ""}
      </div>
      <div>
        ${renderAlertCta({ permits, subject: name })}
        <div class="bs-card">
          <h3>Addresses worked on</h3>
          ${listOrEmpty(
            addresses,
            (a) => `<li><a class="ent-link" href="/address/${encodeURIComponent(a.slug)}">${escapeHtml(displayName(a.display_address))}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${countLabel(a.permits, "permit")}</span></li>`,
            "No addresses on record.",
          )}
        </div>
        ${neighborhoods.length ? `<div class="bs-card">
          <h3>Most common neighborhoods</h3>
          ${listOrEmpty(
            neighborhoods,
            (n) => `<li><a class="ent-link" href="/neighborhood/${encodeURIComponent(n.slug)}">${escapeHtml(n.name)}</a> <span style="font-size:0.8rem;color:var(--text-muted);">· ${countLabel(n.cnt, "permit")}</span></li>`,
            "",
          )}
        </div>` : ""}
        ${renderDatasetCta({ context: "contractor", subject: `${name}'s permits`, count: totalPermits })}
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
      body: `${body}${renderDataTrustNote(latestActivity, "Participant matching follows names in public permit records and may combine or separate similarly named entities.", "entity")}`,
    }),
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } },
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

// Scheduled base-feed ingest. Pure feed logic (queries, cursors, retries,
// schema and mapping guards) lives in sdci_feed.js; status and neighborhood
// mappings in sdci_mappings.js (data/sdci_mappings.json, shared with
// sdci_scraper.py); the permit upsert in permit_upsert.js.
//
// Each run (1) reads the newest page by applieddate DESC and by issueddate
// DESC, so new and newly issued permits land the day they appear; (2) pulls
// records whose Socrata :updated_at moved since the last successful
// `scheduled` run (start time minus an overlap, or the cursor that run stopped
// at when it hit its page cap); (3) spends any page budget left on the weekly
// full sweep (`full_sweep` rows; resumes until it reaches the end of the
// coverage window). If (2)'s first page looks like a full dataset replace
// (detectFullReplace), the `scheduled` row is logged 'degraded' instead of
// 'success', the rest of (2)'s budget is read newest-first, and no cursor is
// kept. 'degraded' counts as a completed run for planning and freshness
// labels; /api/stats reports it as last_feed_status so the daily freshness
// check fails loudly. Pages are upserted as they arrive, so a failure keeps
// every page already written; the next run re-reads from the last success and
// the upsert is idempotent.
async function logFeedRun(env, { run_type, status, added = 0, updated = 0, unchanged = 0, error_message = null, cursor = null, start_time, end_time }) {
  const fmt = (date) => date.toISOString().replace("T", " ").split(".")[0];
  // Needs migrations/0003_permit_feed_fields.sql (cursor, records_unchanged).
  await env.DB.prepare(
    `INSERT INTO ingest_logs (run_type, source, status, records_added, records_updated, records_unchanged, error_message, cursor, start_time, end_time)
     VALUES (?, 'seattle_open_data', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(run_type, status, added, updated, unchanged, error_message, cursor, fmt(start_time), fmt(end_time))
    .run();
}

async function latestFeedRun(env, runType) {
  return env.DB.prepare(
    `SELECT start_time, cursor FROM ingest_logs
     WHERE run_type = ? AND status IN ('success', 'degraded')
     ORDER BY start_time DESC, id DESC LIMIT 1`,
  )
    .bind(runType)
    .first();
}

async function feedCoverageFloor(env) {
  const row = await env.DB.prepare(`SELECT MIN(applied_date) AS floor FROM permits WHERE applied_date IS NOT NULL`).first();
  const floor = String(row?.floor || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(floor) ? floor : DEFAULT_COVERAGE_FLOOR;
}

// options: { fetchImpl, sleep, now, limits } for tests; production passes none.
export async function runScheduledIngest(env, options = {}) {
  const startTime = new Date();
  const limits = { ...FEED_LIMITS, ...(options.limits || {}) };
  const fetchOptions = {
    fetchImpl: options.fetchImpl || fetch,
    sleep: options.sleep,
    attempts: limits.fetchAttempts,
    backoffMs: limits.backoffMs,
    appToken: env.SOCRATA_APP_TOKEN || null,
  };
  const totals = { added: 0, updated: 0, unchanged: 0, contractors: 0, unknownStatuses: new Map() };
  let incrementalLogged = false;

  try {
    const [lastIncremental, lastSweep, floor] = await Promise.all([
      latestFeedRun(env, "scheduled"),
      latestFeedRun(env, "full_sweep"),
      feedCoverageFloor(env),
    ]);
    const plan = planFeedRun({ lastIncremental, lastSweep, now: options.now || startTime, limits });
    const context = { env, floor, limits, fetchOptions, totals, contractorMap: null, seen: new Map() };

    // Newest-first pages: every run, before the :updated_at pull, so they land
    // even when that pull is stuck in a full-replace bucket (review B2).
    const newest = { pages: 0, added: 0, updated: 0, unchanged: 0, cursors: {} };
    for (const step of plan.newest) {
      const pulled = await pullFeedPages(context, step, step.maxPages);
      newest.pages += pulled.pages;
      for (const key of ["added", "updated", "unchanged"]) newest[key] += pulled[key];
      newest.cursors[step.field] = pulled.cursor;
    }

    const incremental = await pullFeedPages(context, plan.incremental, plan.incremental.maxPages, { detectReplace: true });
    let degradedPages = 0;
    if (incremental.replace) {
      // The dataset looks fully replaced: paging on :updated_at would re-read
      // the lowest permit numbers forever. Spend the rest of the incremental
      // budget newest-first, continuing the applieddate page read above.
      const budget = plan.incremental.maxPages - incremental.pages;
      const cursor = newest.cursors.applieddate;
      if (budget > 0 && cursor) {
        const more = await pullFeedPages(context, { mode: "newest", field: "applieddate", cursor }, budget);
        degradedPages = more.pages;
        for (const key of ["added", "updated", "unchanged"]) incremental[key] += more[key];
      }
    }
    const replaceNote = incremental.replace
      ? `degraded: ${incremental.replace.rows} of the first ${limits.pageSize}-row :updated_at page share :updated_at ` +
        `${incremental.replace.stamp}, ${incremental.replace.gapMinutes} min after the watermark; looks like a full ` +
        `dataset replace. Read newest-first instead; older permits refresh in the weekly sweep.`
      : null;
    await logFeedRun(env, {
      run_type: "scheduled",
      status: incremental.replace ? "degraded" : "success",
      added: incremental.added + newest.added,
      updated: incremental.updated + newest.updated,
      unchanged: incremental.unchanged + newest.unchanged,
      error_message: [replaceNote, unknownStatusNote(totals.unknownStatuses)].filter(Boolean).join(" | ").slice(0, 1000) || null,
      cursor: incremental.replace ? null : encodeCursor(incremental.cursor),
      start_time: startTime,
      end_time: new Date(),
    });
    incrementalLogged = true;
    if (incremental.replace) console.warn(`Scheduled ingest degraded: ${replaceNote}`);

    const pagesUsed = newest.pages + incremental.pages + degradedPages;
    let sweep = null;
    if (plan.sweep) {
      const sweepStart = new Date();
      const pages = Math.max(plan.sweep.maxPages, limits.maxPagesPerRun - pagesUsed);
      try {
        sweep = await pullFeedPages(context, plan.sweep, pages);
        await logFeedRun(env, {
          run_type: "full_sweep",
          status: "success",
          added: sweep.added,
          updated: sweep.updated,
          unchanged: sweep.unchanged,
          cursor: encodeCursor(sweep.cursor),
          start_time: sweepStart,
          end_time: new Date(),
        });
      } catch (error) {
        console.error("Full sweep failed:", error);
        await logFeedRun(env, { run_type: "full_sweep", status: "error", error_message: error.message, start_time: sweepStart, end_time: new Date() });
      }
    }

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

    const summary = {
      added: totals.added,
      updated: totals.updated,
      unchanged: totals.unchanged,
      contractors: totals.contractors,
      newest: { pages: newest.pages },
      incremental: { pages: incremental.pages + degradedPages, complete: !incremental.cursor || Boolean(incremental.replace) },
      degraded: Boolean(incremental.replace),
      sweep: sweep ? { pages: sweep.pages, complete: !sweep.cursor } : null,
      unknown_statuses: Object.fromEntries(totals.unknownStatuses),
      alerts_sent: alertDelivery.sent,
      entity_graph: graph ? { ok: graph.ok, unlinked: graph.unlinked } : { ok: false, error: true },
    };
    console.log(`Scheduled ingest complete: ${JSON.stringify(summary)}`);
    return summary;
  } catch (error) {
    console.error("Scheduled ingest failed:", error);
    if (!incrementalLogged) {
      await logFeedRun(env, {
        run_type: "scheduled",
        status: "error",
        added: totals.added,
        updated: totals.updated,
        unchanged: totals.unchanged,
        error_message: error.message,
        start_time: startTime,
        end_time: new Date(),
      });
    }
    throw error;
  }
}

function unknownStatusNote(unknownStatuses) {
  if (!unknownStatuses.size) return null;
  const list = [...unknownStatuses].map(([value, count]) => `${value || "(empty)"} x${count}`).join(", ");
  return `warning: unmapped SDCI statuses stored as pending: ${list}`.slice(0, 500);
}

// Pull up to `maxPages` pages for one plan step, upserting each page. With
// detectReplace, a first page that looks like a full dataset replace is
// upserted and then ends the step (result.replace set, cursor dropped).
async function pullFeedPages(context, step, maxPages, { detectReplace = false } = {}) {
  const { env, floor, limits, fetchOptions, totals } = context;
  const result = { pages: 0, added: 0, updated: 0, unchanged: 0, cursor: step.cursor, replace: null };
  let cursor = step.cursor;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const query = buildFeedQuery({ mode: step.mode, field: step.field, since: step.since, cursor, floor, pageSize: limits.pageSize });
    const page = await fetchFeedPage(feedPageUrl(query, limits.feedUrl || SDCI_PERMIT_URL), fetchOptions);
    result.pages++;
    if (!page.length) {
      cursor = null;
      break;
    }
    assertFeedPage(page);
    // The newest-first pages, the incremental pull and the sweep overlap; a
    // row already written in this run with the same :updated_at is skipped.
    const fresh = page.filter((row) => context.seen?.get(row.permitnum) !== row[":updated_at"]);
    for (const row of fresh) context.seen?.set(row.permitnum, row[":updated_at"]);
    const { permits, contractors } = normalizeSdciPermits(fresh, totals.unknownStatuses);
    assertMappingHealth(permits, { minRows: limits.mappingGuardMinRows, maxRatio: limits.mappingGuardMaxOtherRatio });

    if (contractors.length) {
      await upsertScheduledContractors(env, contractors);
      context.contractorMap = null;
      totals.contractors += contractors.length;
    }
    if (!context.contractorMap) context.contractorMap = await loadContractorMap(env);
    const counts = await upsertScheduledPermits(env, permits, context.contractorMap);
    for (const key of ["added", "updated", "unchanged"]) {
      result[key] += counts[key];
      totals[key] += counts[key];
    }

    if (detectReplace && pageIndex === 0) {
      result.replace = detectFullReplace(page, step, limits);
      if (result.replace) {
        cursor = null;
        break;
      }
    }
    cursor = cursorAfterPage(step.mode, page, step.field);
    if (page.length < limits.pageSize) {
      cursor = null;
      break;
    }
  }
  result.cursor = cursor;
  return result;
}

function normalizeSdciPermits(rawPermits, unknownStatuses = new Map()) {
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

    const statusRaw = cleanFeedText(item.statuscurrent);
    const mappedStatus = mapSdciStatus(statusRaw);
    if (!mappedStatus.known) {
      unknownStatuses.set(statusRaw, (unknownStatuses.get(statusRaw) || 0) + 1);
    }

    permits.push({
      permit_number: permitNumber,
      contractor_name: contractorName && !["n/a", "none"].includes(contractorName.toLowerCase()) ? contractorName : "",
      applicant_name: "",
      address: address || "Seattle, WA",
      neighborhood: detectNeighborhood(item.latitude, item.longitude),
      type: classifyPermitType(item.permitclass, item.permittypemapped),
      value: extractValue(item.estprojectcost),
      status: mappedStatus.status,
      status_raw: statusRaw,
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
      lat: item.latitude,
      lng: item.longitude,
      zip: item.originalzip,
      source_updated_at: item[":updated_at"] || null,
    });
  }

  return { permits, contractors: [...contractorsBySlug.values()] };
}

async function upsertScheduledContractors(env, contractors) {
  for (let i = 0; i < contractors.length; i += 100) {
    // The feed's contractorcompanyname / permitclass only seed a contractor.
    // An existing row keeps its name (the enrichment ingest sets the L&I
    // business name) and gets a specialty only if it has none, so the two
    // writers no longer overwrite each other every day.
    const batch = contractors.slice(i, i + 100).map((contractor) =>
      env.DB.prepare(
        `
      INSERT INTO contractors (name, slug, specialty)
      VALUES (?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        specialty = excluded.specialty,
        updated_at = CURRENT_TIMESTAMP
      WHERE contractors.specialty IS NULL AND excluded.specialty IS NOT NULL
    `,
      ).bind(contractor.name, contractor.slug, contractor.specialty || null),
    );

    if (batch.length) {
      await env.DB.batch(batch);
    }
  }
}

async function loadContractorMap(env) {
  const { results } = await env.DB.prepare("SELECT id, name FROM contractors").all();
  const map = new Map();
  for (const contractor of results || []) {
    const key = String(contractor.name || "").toLowerCase();
    if (key) map.set(key, contractor.id);
  }
  return map;
}

// Decide whether a status difference is a real change worth an alert. Rows
// written before status_raw existed hold the old substring-cascade mapping; if
// that old mapping of the incoming raw value equals the stored status, only
// the mapping changed (e.g. "Application Completed" completed -> pending) and
// no permit_status_changes row is written.
function statusChangeFor(existing, permit, incomingStatus) {
  if (!existing) return null;
  const previousStatus = normalizeStoredStatus(existing.status);
  if (previousStatus === incomingStatus) return null;
  if (existing.status_raw == null && permit.status_raw !== undefined
      && legacyMapPermitStatus(permit.status_raw) === previousStatus) {
    return null;
  }
  return { permit_number: permit.permit_number, previous_status: previousStatus, new_status: incomingStatus };
}

// Upsert normalized permits in chunks of 100 (D1 caps bound parameters per
// statement at 100, and the ADU reclassification binds one per permit).
// Returns { added, updated, unchanged }: "unchanged" rows matched a stored
// permit but no tracked column differed, so the row (and updated_at) was not
// written.
async function upsertScheduledPermits(env, permits, contractorMap = null) {
  const counts = { added: 0, updated: 0, unchanged: 0 };
  const contractors = contractorMap || (await loadContractorMap(env));

  for (let i = 0; i < permits.length; i += 100) {
    const batchPermits = permits.slice(i, i + 100);
    const permitNumbers = batchPermits.map((permit) => permit.permit_number).filter(Boolean);
    const existing = await getExistingPermitStatuses(env, permitNumbers);
    const statusChanges = [];

    const statements = batchPermits.map((permit) => {
      const incomingStatus = normalizeStoredStatus(permit.status);
      const change = statusChangeFor(existing.get(permit.permit_number), permit, incomingStatus);
      if (change) statusChanges.push(change);
      const contractorId = permit.contractor_name ? contractors.get(permit.contractor_name.toLowerCase()) || null : null;
      return env.DB.prepare(PERMIT_UPSERT_SQL).bind(...permitUpsertBinds(permit, { contractorId, status: incomingStatus }));
    });

    const reclassifyStatement = buildAduReclassificationStatement(env, permitNumbers);
    if (reclassifyStatement) statements.push(reclassifyStatement);
    statements.push(...buildStatusChangeStatements(env, statusChanges));

    const results = statements.length ? await env.DB.batch(statements) : [];
    batchPermits.forEach((permit, index) => {
      if (!existing.has(permit.permit_number)) counts.added++;
      else if (Number(results[index]?.meta?.changes ?? 1) > 0) counts.updated++;
      else counts.unchanged++;
    });
  }

  return counts;
}

async function getExistingPermitStatuses(env, permitNumbers) {
  const existing = new Map();
  if (!permitNumbers.length) {
    return existing;
  }

  const placeholders = permitNumbers.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT permit_number, status, status_raw FROM permits WHERE permit_number IN (${placeholders})`,
  )
    .bind(...permitNumbers)
    .all();

  for (const row of results || []) {
    existing.set(row.permit_number, row);
  }

  return existing;
}

function buildStatusChangeStatements(env, statusChanges) {
  return statusChanges.map((change) => env.DB.prepare(STATUS_CHANGE_INSERT_SQL).bind(...statusChangeBinds(change)));
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
  if (!data || typeof data !== "object" || !data.permit_number || !data.address) {
    return new Response(JSON.stringify({ error: "permit_number and address are required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const incomingStatus = normalizeStoredStatus(data.status);
  const existingPermit = await env.DB.prepare(`SELECT status, status_raw FROM permits WHERE permit_number = ?`)
    .bind(data.permit_number)
    .first();

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

  const statements = [env.DB.prepare(PERMIT_UPSERT_SQL).bind(...permitUpsertBinds(data, { contractorId, status: incomingStatus }))];
  const reclassifyStatement = buildAduReclassificationStatement(env, [data.permit_number]);
  if (reclassifyStatement) statements.push(reclassifyStatement);
  const change = statusChangeFor(existingPermit, data, incomingStatus);
  if (change) statements.push(...buildStatusChangeStatements(env, [change]));
  await env.DB.batch(statements);

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// One request writes one D1 batch; the ADU reclassification binds one
// parameter per permit and D1 allows 100 per statement.
const INGEST_PERMIT_BATCH_MAX_ITEMS = 100;

async function ingestPermitBatch(request, env) {
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
  if (items.length > INGEST_PERMIT_BATCH_MAX_ITEMS) {
    return new Response(
      JSON.stringify({ error: `items must hold at most ${INGEST_PERMIT_BATCH_MAX_ITEMS} permits per request` }),
      { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const invalid = items.findIndex((item) => !item || typeof item !== "object" || !item.permit_number || !item.address);
  if (invalid !== -1) {
    return new Response(JSON.stringify({ error: `items[${invalid}] needs permit_number and address` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Same upsert, change detection and counting as the scheduled ingest.
    const counts = await upsertScheduledPermits(env, items);

    await logIngest(env, {
      run_type: "permit",
      source: "scraper",
      status: "success",
      records_added: counts.added,
      records_updated: counts.updated,
      start_time: startTime,
      end_time: new Date(),
    });

    return new Response(JSON.stringify({ processed: items.length, ...counts }), {
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
        "Read-only access to aggregated Seattle construction permit and contractor data. Anonymous access returns a sample (/api/permits: up to 25 summary rows per page, first 10 pages); send an X-API-Key header for full rows and paging.",
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
            {
              name: "per_page",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
              description: "Results per page. Anonymous callers are capped at 25 and the first 10 pages.",
            },
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
        ${endpoint("GET", "/api/permits", "Query permits with optional filters and pagination. Returns { total, page, per_page, results[] }.", [param("neighborhood", "Filter by neighborhood."), param("type", "Filter by permit type."), param("status", "Filter by permit status."), param("q", "Free-text search across address, description, permit number, neighborhood, and contractor name."), param("page", "Page number (default 1). Anonymous callers can read the first 10 pages."), param("per_page", "Results per page (1-100 with an API key, default 50; anonymous callers get at most 25 summary rows). Send an X-API-Key header for full rows.")].join(""))}
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

// Thrown for failures whose message is safe to show an MCP client.
function mcpToolError(message) {
  const error = new Error(message);
  error.expose = true;
  return error;
}

async function executeMcpTool(name, args, env, requestUrl, access = null) {
  let response;
  if (name === "search_permits") {
    const url = new URL("/api/permits", requestUrl);
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    response = await getPermits(new Request(url), env, { access });
  } else if (name === "list_contractors") {
    response = await getContractors(new Request(new URL("/api/contractors", requestUrl)), env);
  } else {
    response = await getStats(env);
  }
  if (!response.ok) {
    // 400/403 bodies are our own validation text (no internals); surface them.
    if (response.status === 400 || response.status === 403) {
      const body = await response.json().catch(() => ({}));
      throw mcpToolError(String(body.error || "Request not allowed"));
    }
    throw new Error(`request failed with status ${response.status}`);
  }
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
  "/alerts",
  "/privacy",
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
  // Only indexable addresses: more than one permit and a real street
  // (addressIsIndexable). Single-permit and city-only pages are noindex.
  addresses: {
    numbered: true,
    urlPrefix: "/address/",
    statsSql: `/* sitemap:stats:addresses */
      SELECT
        COUNT(*) AS total,
        substr(MAX(lastmod), 1, 10) AS lastmod
      FROM (
        SELECT
          a.id,
          MAX(COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at, a.updated_at)) AS lastmod
        FROM addresses a
        JOIN permits p ON p.address_id = a.id
        WHERE ${realAddressSql("a")}
        GROUP BY a.id
        HAVING COUNT(p.id) >= ${ADDRESS_MIN_INDEXABLE_PERMITS}
      )`,
    rowsSql: `/* sitemap:rows:addresses */
      SELECT
        a.slug,
        substr(MAX(COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at, a.updated_at)), 1, 10) AS lastmod
      FROM addresses a
      JOIN permits p ON p.address_id = a.id
      WHERE ${realAddressSql("a")}
      GROUP BY a.id, a.slug
      HAVING COUNT(p.id) >= ${ADDRESS_MIN_INDEXABLE_PERMITS}
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
        WHERE ${MULTI_PERMIT_PROJECT_SQL}
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
      WHERE ${MULTI_PERMIT_PROJECT_SQL}
      GROUP BY pr.id, pr.slug
      HAVING COUNT(DISTINCT pp.permit_id) > 1
      ORDER BY pr.slug
      LIMIT ? OFFSET ?`,
  },
  // Curated contractors with at least one permit (zero-permit ones render
  // noindex), plus people_orgs in PUBLISHED_ORGS_CTE: a trade role
  // (contractor/architect, not private owners/applicants), a slug the curated
  // table does not own, and no curated twin under another slug.
  contractors: {
    numbered: true,
    urlPrefix: "/contractor/",
    statsSql: `/* sitemap:stats:contractors */
      WITH ${PUBLISHED_ORGS_CTE}
      SELECT
        COUNT(*) AS total,
        substr(MAX(lastmod), 1, 10) AS lastmod
      FROM (
        SELECT slug, MAX(lastmod) AS lastmod
        FROM (
          SELECT c.slug, c.updated_at AS lastmod
          FROM contractors c
          WHERE EXISTS (SELECT 1 FROM permits cp WHERE cp.contractor_id = c.id)
          UNION ALL
          SELECT c.slug, COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at) AS lastmod
          FROM contractors c
          JOIN permits p ON p.contractor_id = c.id
          UNION ALL
          SELECT o.slug, o.updated_at AS lastmod
          FROM published_orgs o
          UNION ALL
          SELECT o.slug, COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at) AS lastmod
          FROM published_orgs o
          JOIN permit_participants pp ON pp.people_org_id = o.id
          JOIN permits p ON p.id = pp.permit_id
        )
        GROUP BY slug
      )`,
    rowsSql: `/* sitemap:rows:contractors */
      WITH ${PUBLISHED_ORGS_CTE}
      SELECT slug, substr(MAX(lastmod), 1, 10) AS lastmod
      FROM (
        SELECT c.slug, c.updated_at AS lastmod
        FROM contractors c
        WHERE EXISTS (SELECT 1 FROM permits cp WHERE cp.contractor_id = c.id)
        UNION ALL
        SELECT c.slug, COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at) AS lastmod
        FROM contractors c
        JOIN permits p ON p.contractor_id = c.id
        UNION ALL
        SELECT o.slug, o.updated_at AS lastmod
        FROM published_orgs o
        UNION ALL
        SELECT o.slug, COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at) AS lastmod
        FROM published_orgs o
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
      JOIN permits p ON p.address_id = an.address_id
      WHERE ${realNeighborhoodSql("n.name")}`,
    rowsSql: `/* sitemap:rows:neighborhoods */
      SELECT
        n.slug,
        substr(MAX(COALESCE(p.updated_at, p.last_enriched_at, p.issued_date, p.created_at)), 1, 10) AS lastmod
      FROM neighborhoods n
      JOIN address_neighborhoods an ON an.neighborhood_id = n.id
      JOIN permits p ON p.address_id = an.address_id
      WHERE ${realNeighborhoodSql("n.name")}
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
    try {
      if (await hasBasisResetRows(env)) staticPaths = [...staticPaths, "/insights/basis-reset"];
    } catch (error) {
      console.error("Basis reset sitemap availability query failed:", error);
    }
    const entries = staticPaths.map((staticPath) => ({
      loc: origin + staticPath,
      lastmod: permitStats.lastmod,
    }));
    return renderSitemapUrlSet(entries);
  }

  // Own-property lookup: "constructor" & co. must not resolve (A4).
  const section = Object.hasOwn(SITEMAP_SECTIONS, type) ? SITEMAP_SECTIONS[type] : null;
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

function socialImageForCanonical(canonical) {
  const path = new URL(canonical).pathname;
  if (path.startsWith("/permits/")) return "permit";
  if (path.startsWith("/contractor")) return "contractor";
  if (path.startsWith("/project")) return "project";
  if (path.startsWith("/address")) return "address";
  if (path.startsWith("/neighborhood")) return "neighborhood";
  return "insight";
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
      <p>Dates and statuses may change as SDCI reviewers update a record. “Updated through” labels report the newest applied, issued or completed date in the SDCI records we hold, site-wide, so every page shows the same value. Property, project, neighborhood and participant pages also show the latest permit activity among their own records. Neither is the time a reader opened the page or the time we last re-saved a row.</p>
    </section>
    <section class="bs-card">
      <h2>Derived entities and matching confidence</h2>
      <p>Permits are the evidence records. Address pages come from normalized street addresses. Projects group permits that share an address and have related timing and work signals. Contractor and participant pages use names and license information published on permits.</p>
      <p>Entity grouping is deterministic but inferred. Similar names, shared addresses, incomplete licenses, or changed project descriptions can split one real-world entity into several pages or combine records that later need correction.</p>
    </section>
    <section class="bs-card" id="value">
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

// GET /alerts: what the free per-permit alerts do and how to start one. The
// subscribe/confirm/unsubscribe handlers live under /alerts/* and are
// separate; this page only explains them and sends people to a permit.
function renderAlertsLandingPage() {
  const canonical = `${BASE_URL}/alerts`;
  const title = "Seattle Permit Status Alerts | Building Seattle";
  const description =
    "Free email alerts when a Seattle building permit changes status in SDCI records. Confirm once, one email per change, one-click unsubscribe.";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebPage", name: title, description, url: canonical },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Permit alerts", item: canonical },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");
  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Permit alerts" }])}
    <div class="ent-hero">
      <div class="ent-kicker">Free alerts</div>
      <h1>Seattle permit status alerts</h1>
      <p style="color:var(--text-muted);max-width:68ch;margin:0;">Follow a single permit and get an email when Seattle SDCI records a new status for it: applied to issued, issued to completed, or expired. Alerts are free.</p>
    </div>
    <div class="ent-grid">
      <div>
        <section class="bs-card">
          <h2>How it works</h2>
          <ol style="margin:0;padding-left:1.25rem;">
            <li><strong>Find the permit.</strong> Search by address, permit number or contractor, or open a permit from any property, project, contractor or neighborhood page.</li>
            <li><strong>Choose &ldquo;Email Me Permit Updates&rdquo;</strong> on the permit page and enter your email address.</li>
            <li><strong>Confirm.</strong> We send one confirmation email. Nothing else is sent until you click its link.</li>
            <li><strong>Get one email per status change.</strong> Changes are picked up by the daily ingest, so an email arrives within about a day of SDCI updating the record.</li>
          </ol>
          <form class="bs-search" action="/permits" method="get" role="search" style="margin-top:1.25rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
            <label for="alerts-search" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);">Find a permit to watch</label>
            <input class="bs-input" id="alerts-search" name="q" type="search" placeholder="Address or permit number" style="flex:1;min-width:12rem;">
            <input type="hidden" name="status" value="active">
            <button class="bs-btn bs-btn--primary" type="submit">Find an active permit</button>
          </form>
        </section>
        <section class="bs-card">
          <h2>What you won't get</h2>
          <ul style="margin:0;padding-left:1.25rem;">
            <li>Alerts for completed, expired or canceled permits: there is no next status to report, so those pages don't offer one.</li>
            <li>Marketing email. The address is used for the alerts you confirmed.</li>
            <li>Alerts for a whole contractor, address or neighborhood. Alerts follow one permit at a time for now.</li>
          </ul>
        </section>
      </div>
      <div>
        <section class="bs-card">
          <h3>Stop any time</h3>
          <p style="margin:0;font-size:0.9rem;color:var(--text-muted);">Every alert email has a one-click unsubscribe link that ends that permit's alerts.</p>
        </section>
        <section class="bs-card">
          <h3>Your data</h3>
          <p style="margin:0;font-size:0.9rem;color:var(--text-muted);">We store your email address, the permit you follow and the dates you confirmed or unsubscribed. See the <a class="ent-link" href="/privacy">privacy notice</a>.</p>
        </section>
        <section class="bs-card">
          <h3>Need every permit at once?</h3>
          <p style="margin:0 0 0.5rem;font-size:0.9rem;color:var(--text-muted);">The downloadable dataset has ${DATASET_RELEASE.records.toLocaleString("en-US")} permits in one CSV.</p>
          <a class="ent-link" href="/data?utm_source=buildingseattle&amp;utm_medium=site&amp;utm_campaign=alerts_page">See the dataset &rarr;</a>
        </section>
      </div>
    </div>`;
  return new Response(
    renderEntityDoc({ title, description, canonical, jsonLd, noindex: false, body, activeNav: "alerts" }),
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=86400" } },
  );
}

// GET /privacy: what the site collects. Factual description of the code paths
// (alerts, leads, page views, Cloudflare Web Analytics); the owner should
// review the wording before launch.
function renderPrivacyPage() {
  const canonical = `${BASE_URL}/privacy`;
  const title = "Privacy Notice | Building Seattle";
  const description =
    "What Building Seattle collects: alert email addresses, optional form fields, page-view logs and cookieless Cloudflare Web Analytics, and how to reach us.";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebPage", name: title, description, url: canonical },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${BASE_URL}/` },
          { "@type": "ListItem", position: 2, name: "Privacy", item: canonical },
        ],
      },
    ],
  }).replace(/</g, "\\u003c");
  const contact = `<a class="ent-link" href="mailto:${SITE_CONTACT_EMAIL}">${SITE_CONTACT_EMAIL}</a>`;
  const body = `
    ${entBreadcrumb([{ label: "Home", href: "/" }, { label: "Privacy" }])}
    <div class="ent-hero">
      <div class="ent-kicker">Privacy</div>
      <h1>Privacy notice</h1>
      <p style="color:var(--text-muted);max-width:68ch;margin:0;">Building Seattle publishes public permit records. This page covers the information the site collects about visitors and subscribers.</p>
    </div>
    <section class="bs-card">
      <h2>Permit alert subscriptions</h2>
      <p>When you sign up for a permit alert we store your email address, the permit number, the subscription status, and when you confirmed, were last emailed, or unsubscribed. The address is used to send the confirmation email and the status-change alerts you confirmed. Each alert carries a one-click unsubscribe link; unsubscribing stops further alerts for that permit.</p>
    </section>
    <section class="bs-card">
      <h2>Forms</h2>
      <p>If you send us a request through a site form, we store the fields you submit (such as email, company, interest and neighborhoods), the form's source and your browser's user-agent string, and use them to answer the request.</p>
    </section>
    <section class="bs-card">
      <h2>Server logs and analytics</h2>
      <p>For pages we log the path, the referring page, the browser's user-agent string, the country Cloudflare reports for the request, and the time. Aggregate traffic is also measured with Cloudflare Web Analytics, which does not use cookies. Cloudflare hosts the site and processes requests, including IP addresses, as our infrastructure provider.</p>
      <p>The site sets no cookies of its own. Your light/dark theme choice is kept in your browser's local storage and never sent to us.</p>
    </section>
    <section class="bs-card">
      <h2>Third parties</h2>
      <p>Permit pages embed a Google Maps view, so your browser requests map tiles from Google when you open one. Dataset purchases are handled by Gumroad under its own privacy policy; we receive the order details Gumroad shares with sellers.</p>
    </section>
    <section class="bs-card">
      <h2>Permit records</h2>
      <p>Names and addresses on permit, property and contractor pages come from public Seattle SDCI records. To report an error or ask about a record, contact us; the official record is maintained by SDCI.</p>
    </section>
    <section class="bs-card">
      <h2>Contact</h2>
      <p>Questions or requests about your information, including deleting an alert subscription: ${contact}.</p>
    </section>`;
  return new Response(
    renderEntityDoc({ title, description, canonical, jsonLd, noindex: false, body, activeNav: "privacy" }),
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=86400" } },
  );
}

function renderAboutPage() {
  const canonical = `${BASE_URL}/about`;
  const title = "About Building Seattle — Construction Permit Intelligence";
  const description =
    "Building Seattle turns public City of Seattle SDCI permit records into searchable property, contractor, project, and neighborhood pages.";
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
                <p>Construction permit intelligence for the City of Seattle — tracking who's building what, where, and with whom.</p>
            </div>
        </section>
        <section class="content">
            <div class="container">
                <h2>What Building Seattle does</h2>
                <p>Building Seattle collects, organizes, and publishes construction permit data from the <strong>Seattle Department of Construction and Inspections</strong> (SDCI). Permits in the public feed — from tenant improvements and residential additions to major commercial projects — are ingested, enriched, and made searchable.</p>
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
                <p>A scheduled ingest runs daily to pick up new permit applications, issuances, and status updates from SDCI. The <a href="/methodology">methodology and sources page</a> documents refresh timing, entity matching, classifications, and known limitations.</p>

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
                <p>Building Seattle covers building permits for addresses within the City of Seattle, sourced from SDCI's public open-data feed. It does not cover the rest of King County or other cities in the metro area. The site holds recent permit activity rather than the city's full historical archive; the current downloadable dataset (release ${escapeHtml(DATASET_RELEASE.version)}) covers applications dated ${escapeHtml(formatCalendarDate(DATASET_RELEASE.appliedFrom, { month: "long" }))} to ${escapeHtml(formatCalendarDate(DATASET_RELEASE.appliedThrough, { month: "long" }))}. Permit types include commercial, residential, industrial, demolition, and more.</p>

                <h2>Get in touch</h2>
                <p>Building Seattle is an independent project. For questions, corrections, or data inquiries, email <a href="mailto:${SITE_CONTACT_EMAIL}">${SITE_CONTACT_EMAIL}</a>. The <a href="/privacy">privacy notice</a> explains what the site collects.</p>

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

// /data sells the shipped release, so every figure here comes from
// DATASET_RELEASE (site_content.js, mirrored from gumroad/VERSION.txt), not
// live D1 counts, which drift from the file buyers download.
async function renderDataPage(env) {
  const release = DATASET_RELEASE;
  // With site context switched off, the development-site columns are withheld.
  const datasetColumnCount = developmentSitesArePublic(env)
    ? release.columns
    : release.columns - DEVELOPMENT_SITE_FIELDS.length;
  const canonical = `${BASE_URL}/data`;
  const coverage = `${formatCalendarDate(release.appliedFrom, { month: "long" })} to ${formatCalendarDate(release.appliedThrough, { month: "long" })}`;
  const exportDate = formatCalendarDate(release.exportDate, { month: "long" });
  const recordCount = release.records.toLocaleString("en-US");
  const contractorCount = release.contractors.toLocaleString("en-US");
  const valueLabel = compactMetricMoney(release.countedValue);
  const title = "Seattle Permit Dataset — CSV Download | Building Seattle";
  const description = `${recordCount} Seattle SDCI building permits applied ${formatMonthYear(release.appliedFrom)}–${formatMonthYear(release.appliedThrough)}, in one ${datasetColumnCount}-column CSV with contractor licenses and review timing. Free sample.`;
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
        version: release.version,
        dateModified: release.exportDate,
        temporalCoverage: `${release.appliedFrom}/${release.appliedThrough}`,
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

  const yes = `<span aria-label="Included">&#10003;</span>`;
  const no = `<span aria-label="Not included" style="color:var(--text-muted);">&mdash;</span>`;
  const tierRows = [
    [`Permit CSV: ${recordCount} records, ${datasetColumnCount} columns`, yes, yes],
    ["Data dictionary (every column documented)", yes, yes],
    [`Contractor CSV: ${contractorCount} contractors with licenses, specialties, permit counts and values`, no, yes],
    ["Python refresh script (standard library only) to pull newer records yourself", no, yes],
    ["Later releases pushed to your Gumroad library", yes, yes],
  ];

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
        .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin: 2rem 0 0.75rem; }
        .stat-card { background: var(--bg); border: 1px solid var(--border); border-radius: 1rem; padding: 1.5rem; text-align: center; }
        .stat-card .num { font-size: 2rem; font-weight: 800; color: var(--accent); }
        .stat-card .label { font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem; }
        .release-note { font-size: 0.9rem !important; }
        .tier-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; margin: 2rem 0; }
        .tier-card { background: var(--bg); border: 1px solid var(--border); border-radius: 1rem; padding: 2rem; }
        .tier-card.featured { border-color: var(--accent); box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
        .tier-card h3 { font-size: 1.25rem; font-weight: 700; color: var(--primary); }
        .tier-card .price { font-size: 2.25rem; font-weight: 800; color: var(--text); margin: 0.5rem 0 1rem; }
        .tier-card ul { margin-left: 1.25rem; }
        .tier-table { width: 100%; border-collapse: collapse; background: var(--bg); border: 1px solid var(--border); border-radius: 1rem; font-size: 0.95rem; }
        .tier-table th, .tier-table td { padding: 0.7rem 0.9rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; color: var(--text); }
        .tier-table th[scope="col"] { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); }
        .tier-table td.mark { text-align: center; width: 7rem; font-weight: 700; }
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
                <p>${recordCount} City of Seattle building permits, applied for ${escapeHtml(coverage)}, exported as one clean CSV. Release ${escapeHtml(release.version)}, built ${escapeHtml(exportDate)}.</p>
            </div>
        </section>
        <section class="content">
            <div class="container">
                <div class="stat-grid">
                    <div class="stat-card"><div class="num">${recordCount}</div><div class="label">Permits</div></div>
                    <div class="stat-card"><div class="num">${escapeHtml(valueLabel)}</div><div class="label">Counted permit value</div></div>
                    <div class="stat-card"><div class="num">${contractorCount}</div><div class="label">Contractors (Pro CSV)</div></div>
                    <div class="stat-card"><div class="num">${datasetColumnCount}</div><div class="label">Columns per record</div></div>
                </div>
                <p class="release-note">Figures describe the file you download (release ${escapeHtml(release.version)}, exported ${escapeHtml(exportDate)}), not the live site, which keeps updating daily. Value is SDCI's declared value with a demolition valuation repeated at one address counted once (${escapeHtml(compactMetricMoney(release.declaredValue))} before that rule); see the <a href="/methodology#value">methodology</a>.</p>

                <h2>What's in it</h2>
                <p>Building permits filed with the Seattle Department of Construction and Inspections (SDCI) for addresses in the City of Seattle, with applications dated ${escapeHtml(coverage)}. Each record is cleaned, deduplicated by permit number, and enriched with fields the open-data feed doesn't carry: <strong>SDCI property and development-site references, review levels, full detail-page descriptions, contractor license numbers, review-cycle counts, and housing-unit changes</strong>. One UTF-8 CSV that opens in Excel, Google Sheets, pandas, or R, plus a full data dictionary.</p>
                <p>It does not cover King County outside the city, and the site references are SDCI identifiers, not King County parcel numbers.</p>

                <h2>Try before you buy</h2>
                <p>A <strong>free ${release.sampleRows}-row sample</strong> with the same ${datasetColumnCount} columns and real enriched data is on the <a href="${GUMROAD_PRODUCT_URL}?${GUMROAD_UTM}&utm_content=sample" rel="noopener">Gumroad product page</a>. If it doesn't have what you need, don't buy the full version. If you do buy and it isn't useful, there's a 14-day no-questions refund.</p>

                <h2>Foundation or Pro</h2>
                <p>Both tiers include the same permit file. Pro adds the contractor table and a script to pull newer records yourself between releases.</p>
                <div class="table-scroll" role="region" aria-label="Tier comparison" tabindex="0">
                <table class="tier-table">
                    <thead><tr><th scope="col">Included</th><th scope="col">Foundation $49</th><th scope="col">Pro $89</th></tr></thead>
                    <tbody>${tierRows.map(([label, foundation, pro]) => `<tr><th scope="row" style="font-weight:500;">${escapeHtml(label)}</th><td class="mark">${foundation}</td><td class="mark">${pro}</td></tr>`).join("")}</tbody>
                </table>
                </div>

                <div class="tier-grid">
                    <div class="tier-card">
                        <h3>Foundation</h3>
                        <div class="price">$49</div>
                        <ul>
                            <li>Permit CSV: ${recordCount} records, ${datasetColumnCount} columns</li>
                            <li>Data dictionary</li>
                            <li>Later releases via Gumroad</li>
                        </ul>
                        <p style="margin-top:1.5rem;"><a class="bs-btn bs-btn--secondary bs-btn--lg" href="${buyUrl}&utm_content=foundation" rel="noopener">Get Foundation</a></p>
                    </div>
                    <div class="tier-card featured">
                        <h3>Pro</h3>
                        <div class="price">$89</div>
                        <ul>
                            <li>Everything in Foundation</li>
                            <li>Contractor CSV: ${contractorCount} contractors</li>
                            <li>Python refresh script (stdlib-only)</li>
                        </ul>
                        <p style="margin-top:1.5rem;"><a class="bs-btn bs-btn--primary bs-btn--lg" href="${buyUrl}&utm_content=pro" rel="noopener">Get Pro</a></p>
                    </div>
                </div>
                <p class="release-note">Choose the tier on the Gumroad checkout page. New releases are pushed to every buyer's Gumroad library as file updates; the <a href="/methodology">methodology</a> explains how records are built.</p>

                <h2>Who it's for</h2>
                <ul>
                    <li><strong>Material suppliers</strong> — find active job sites by neighborhood before your competitors do</li>
                    <li><strong>General contractors</strong> — see who's winning bids and which subs are active</li>
                    <li><strong>Developers</strong> — size the construction pipeline in any Seattle neighborhood</li>
                    <li><strong>Underwriters, journalists, researchers</strong> — license data, project values, and processing times with a paper trail to the source</li>
                </ul>

                <h2>Why pay for public data?</h2>
                <p>The raw records are public — the work isn't. The city publishes permits piecemeal, without contractor licenses, review levels, or detailed descriptions in the open-data feed. Our pipeline scrapes, cleans, deduplicates, and enriches every record so you don't spend a weekend doing it yourself.</p>

                <div style="display:flex;gap:1rem;margin-top:2.5rem;flex-wrap:wrap;">
                    <a href="${buyUrl}" class="bs-btn bs-btn--primary bs-btn--lg" rel="noopener">Get the Dataset</a>
                    <a href="/permits" class="bs-btn bs-btn--secondary bs-btn--lg">Browse the Data Live</a>
                </div>
                <p class="release-note" style="margin-top:1.5rem;">Questions about the data or a purchase: <a href="mailto:${SITE_CONTACT_EMAIL}">${SITE_CONTACT_EMAIL}</a>. Purchases are handled by Gumroad; see our <a href="/privacy">privacy notice</a>.</p>
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
