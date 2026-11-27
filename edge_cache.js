// Pure helpers for the Worker's HTML edge cache (`withHtmlEdgeCache` in
// worker.js) and for admin response hardening. Kept out of worker.js so tests
// can import the constants (worker.js may only export functions).
//
// Audit items addressed here:
// - F4: entity pages were cached for at most an hour per data centre, so the
//   long tail of crawler traffic always rendered from D1. Pages that say
//   max-age >= 3600 are now held at the edge for a day (s-maxage) with
//   stale-while-revalidate, and the cache key rolls over once a day after the
//   13:00 UTC ingest (`dataDay`) so a day-long TTL never serves yesterday's
//   data past the next rebuild.
// - F7/A7: the key was the full URL, so utm_*, fbclid, gclid, ?cb= or any
//   random parameter made a new entry and forced a D1 render. Keys now keep
//   only the parameters the route actually reads, sorted.
// - F14: the version is the deployed Worker version (CF_VERSION_METADATA)
//   when available, so a template change can no longer serve stale HTML after
//   a deploy that forgot to bump HTML_CACHE_VERSION; no-store/private/no-cache
//   responses are never stored; noindex pages (which include the
//   "no data" pages a transient D1 error produces) are never stored.
// - A6: /admin* and /api/admin* responses are `private, no-store`, noindex,
//   and carry no CORS headers.

// Query parameters each HTML route reads. Anything else is dropped from the
// cache key. Keyed by path without a trailing slash.
export const HTML_CACHE_QUERY_PARAMS = {
  "/permits": ["page", "neighborhood", "type", "status", "q"],
  "/contractors": ["page", "sort", "activity", "permit_type", "neighborhood", "min_value"],
  "/addresses": ["page", "sort", "activity", "neighborhood", "min_value", "min_permits"],
  "/projects": ["page", "sort", "view", "min_value"],
  "/neighborhoods": ["page", "sort", "min_value"],
};

// Edge TTLs (seconds). Data changes once a day; the daily key rollover is the
// real freshness bound for long-lived pages.
export const EDGE_TTL_LONG = 86400;
export const EDGE_TTL_SHORT = 3600;
export const STALE_WHILE_REVALIDATE = 3600;
// The ingest cron runs at 13:00 UTC and the entity-graph rebuild follows it;
// the cache "data day" starts an hour later.
export const DATA_DAY_ROLLOVER_UTC_HOUR = 14;

function routeKey(path) {
  const trimmed = String(path || "/").replace(/\/+$/, "");
  return trimmed || "/";
}

export function allowedHtmlCacheParams(path) {
  return HTML_CACHE_QUERY_PARAMS[routeKey(path)] || [];
}

// The UTC date the cached data belongs to: the day rolls over at
// DATA_DAY_ROLLOVER_UTC_HOUR, after the daily ingest and rebuild.
export function dataDay(now = new Date()) {
  const shifted = new Date(now.getTime() - DATA_DAY_ROLLOVER_UTC_HOUR * 3600000);
  return shifted.toISOString().slice(0, 10);
}

// Cache-key version: the base template version, the deployed Worker version
// when the version_metadata binding exists, and the development-sites flag
// (which changes page content).
export function htmlCacheVersion(base, env, sitesPublic) {
  const deployed = String(env?.CF_VERSION_METADATA?.id || "").slice(0, 12);
  return `${base}${deployed ? `-${deployed}` : ""}${sitesPublic ? "" : "-sites-off"}`;
}

// Build the normalized cache-key URL for a request URL. Returns the key and
// whether any parameter was dropped (so the caller can serve a warm copy to a
// tracking-tagged URL without ever storing a page rendered from one).
export function htmlCacheKeyUrl(requestUrl, { version, day }) {
  const url = new URL(requestUrl);
  const allowed = new Set(allowedHtmlCacheParams(url.pathname));
  const kept = new URLSearchParams();
  let droppedParams = false;
  for (const [name, value] of url.searchParams) {
    if (allowed.has(name)) kept.append(name, value);
    else droppedParams = true;
  }
  kept.sort();
  kept.set("__bsv", version);
  kept.set("__bsd", day);
  const key = new URL(url.origin + url.pathname);
  key.search = kept.toString();
  return { url: key.toString(), droppedParams };
}

export function cacheControlForbidsStore(cacheControl) {
  return /\b(no-store|private|no-cache)\b/i.test(String(cacheControl || ""));
}

// The page's own browser TTL from its max-age, clamped to [60, 86400];
// 0 when the page must not be cached at all.
export function pageCacheTtl(cacheControl) {
  const cc = String(cacheControl || "");
  if (cacheControlForbidsStore(cc)) return 0;
  const match = cc.match(/max-age=(\d+)/);
  const ttl = match ? Number(match[1]) : 3600;
  return Math.max(60, Math.min(Number.isFinite(ttl) ? ttl : 3600, 86400));
}

// How long the edge keeps a page: a day for pages that are good for an hour
// or more (permit and entity pages), an hour for short-lived pages (home,
// hubs, insights).
export function edgeHtmlTtl(pageTtl) {
  if (!(pageTtl > 0)) return 0;
  return pageTtl >= 3600 ? EDGE_TTL_LONG : EDGE_TTL_SHORT;
}

export function edgeCacheControl(pageTtl) {
  const edgeTtl = edgeHtmlTtl(pageTtl);
  return `public, max-age=${pageTtl}, s-maxage=${edgeTtl}, stale-while-revalidate=${STALE_WHILE_REVALIDATE}`;
}

// True when the response asks search engines not to index it, by header or by
// <meta name="robots">. Only the document head is inspected.
export function isNoindexResponse(headers, html) {
  if (/noindex/i.test(headers?.get?.("X-Robots-Tag") || "")) return true;
  const head = String(html || "").slice(0, 20000);
  const headEnd = head.search(/<\/head>/i);
  const scope = headEnd >= 0 ? head.slice(0, headEnd) : head;
  return /<meta[^>]+name=["']?robots["']?[^>]*content=["'][^"']*noindex/i.test(scope)
    || /<meta[^>]+content=["'][^"']*noindex[^"']*["'][^>]*name=["']?robots/i.test(scope);
}

export function isAdminPath(path) {
  const p = String(path || "");
  return p === "/admin" || p.startsWith("/admin/") || p === "/api/admin" || p.startsWith("/api/admin/");
}

const CORS_HEADER_NAMES = [
  "Access-Control-Allow-Origin",
  "Access-Control-Allow-Methods",
  "Access-Control-Allow-Headers",
  "Access-Control-Allow-Credentials",
  "Access-Control-Expose-Headers",
  "Access-Control-Max-Age",
];

// Admin responses must never be shared by a cache or read cross-origin.
export function hardenAdminResponse(response) {
  const headers = new Headers(response.headers);
  for (const name of CORS_HEADER_NAMES) headers.delete(name);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
