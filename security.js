// Request-hardening helpers shared by worker.js, mcp.js and the tests: rate
// limits, Origin checks, Turnstile, API access tiers and strict parameter
// parsing. They live here (not in worker.js) because worker.js may not export
// non-function names.

// --- Public API / MCP access tiers -----------------------------------------
// Anonymous callers get a sample: small pages, shallow paging, slim rows.
// A key (env.API_KEYS or the api_keys table) unlocks full rows and depth.
export const ANON_API_MAX_PER_PAGE = 25;
export const ANON_API_MAX_PAGE = 10;
export const KEY_API_MAX_PER_PAGE = 100;
export const KEY_API_MAX_PAGE = 1000;
export const SEARCH_QUERY_MAX_LENGTH = 100;
export const FILTER_PARAM_MAX_LENGTH = 100;
export const API_KEY_HEADER = "X-API-Key";

// Columns an anonymous /api/permits or MCP caller sees. Enriched fields (long
// descriptions, review metrics, development-site context, contractor contact
// details) are the paid dataset and need a key.
export const ANON_PERMIT_FIELDS = [
  "id",
  "permit_number",
  "address",
  "neighborhood",
  "type",
  "value",
  "status",
  "description",
  "applied_date",
  "issued_date",
  "expires_date",
  "completed_date",
  "permit_detail_url",
  "contractor_name",
  "contractor_slug",
];

// --- Form abuse limits -------------------------------------------------------
export const ALERT_RESEND_COOLDOWN_MINUTES = 15;
export const ALERT_EMAIL_DAILY_LIMIT = 5;
export const ALERT_IP_HOURLY_LIMIT = 10;
export const ALERT_CONFIRMATION_TTL_DAYS = 7;
export const LEAD_IP_HOURLY_LIMIT = 5;
export const LEAD_TEXT_MAX_LENGTH = 200;
export const PERMIT_NUMBER_MAX_LENGTH = 64;
export const ALERT_SEND_BATCH_LIMIT = 500;

// sha256 of brand_ui.js themeBootScript()'s body. The CSP allows exactly this
// inline script; tests/security.test.js fails if the script changes without
// this hash being updated.
export const THEME_BOOT_SCRIPT_SHA256 = "sha256-+ebqmKeWHsjrPzUREoSu9/zBxdu9CXZmyYvTCW6WVNA=";

const SITE_ORIGINS = ["https://buildingseattle.com", "https://www.buildingseattle.com"];

/**
 * Strictly parse an optional positive integer query parameter. Returns
 * { ok: true, value } (fallback when absent) or { ok: false } for anything
 * that is not plain digits or is below `min`. Values above `max` clamp.
 */
export function parseIntegerParam(raw, { fallback, min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return { ok: true, value: fallback };
  const text = String(raw).trim();
  if (!/^\d{1,9}$/.test(text)) return { ok: false };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min) return { ok: false };
  return { ok: true, value: Math.min(value, max) };
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time string comparison. Both sides are hashed first and the
 * digests compared in full, so neither the content nor the length of the
 * expected value leaks through timing.
 */
export async function timingSafeEqualString(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !provided || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Cloudflare sets CF-Connecting-IP on every request; anything else is spoofable. */
export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

export function allowedOrigins(request, extra = "") {
  const origins = new Set(SITE_ORIGINS);
  try {
    origins.add(new URL(request.url).origin);
  } catch {
    // ignore unparsable URLs
  }
  for (const value of String(extra || "").split(",")) {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (trimmed) origins.add(trimmed);
  }
  return origins;
}

/**
 * True when a browser says the request came from another site. Requests with
 * no Origin and no Sec-Fetch-Site (curl, mail providers' one-click
 * unsubscribe, server-side MCP clients) are not cross-site.
 */
export function isCrossSiteRequest(request, extraOrigins = "") {
  const origin = request.headers.get("Origin");
  if (origin) return !allowedOrigins(request, extraOrigins).has(origin);
  const site = request.headers.get("Sec-Fetch-Site");
  return Boolean(site) && !["same-origin", "same-site", "none"].includes(site);
}

export function isJsonContentType(request) {
  return (request.headers.get("Content-Type") || "").toLowerCase().includes("application/json");
}

// --- Rate limiting -----------------------------------------------------------

/**
 * Count one hit against `key`. Uses the Workers Rate Limiting binding named
 * `binding` when it is configured (its own limit/period from wrangler.toml
 * apply), otherwise a fixed-window counter in D1 (`request_rate_limits`).
 * Returns true when the request is allowed. Fails closed if D1 is unavailable,
 * because every caller guards something that sends email or stores data.
 */
export async function consumeRateLimit(env, { binding, key, limit, windowSeconds, nowMs = Date.now() }) {
  const limiter = binding ? env?.[binding] : null;
  if (limiter && typeof limiter.limit === "function") {
    try {
      const { success } = await limiter.limit({ key });
      return Boolean(success);
    } catch (error) {
      console.warn(`Rate limiter ${binding} failed; using D1 fallback:`, error?.message || error);
    }
  }
  return consumeD1RateLimit(env, key, limit, windowSeconds, nowMs);
}

export async function consumeD1RateLimit(env, key, limit, windowSeconds, nowMs = Date.now()) {
  const windowStart = Math.floor(nowMs / 1000 / windowSeconds) * windowSeconds;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO request_rate_limits (bucket_key, window_start, hits)
       VALUES (?, ?, 1)
       ON CONFLICT(bucket_key, window_start) DO UPDATE SET hits = hits + 1
       RETURNING hits`,
    )
      .bind(key, windowStart)
      .first();
    if (Math.random() < 0.02) await pruneRateLimits(env, nowMs);
    return Number(row?.hits || 0) <= limit;
  } catch (error) {
    console.error("D1 rate limiter unavailable:", error?.message || error);
    return false;
  }
}

// Opportunistic cleanup keeps the table small without a cron step; a failure
// here never affects the request being counted.
export async function pruneRateLimits(env, nowMs = Date.now()) {
  try {
    await env.DB.prepare("DELETE FROM request_rate_limits WHERE window_start < ?")
      .bind(Math.floor(nowMs / 1000) - 2 * 86400)
      .run();
  } catch (error) {
    console.warn("Rate-limit cleanup failed:", error?.message || error);
  }
}

/** Rate-limit bucket keys never store raw IPs or email addresses. */
export async function rateLimitKey(scope, value) {
  return `${scope}:${(await sha256Hex(String(value).toLowerCase())).slice(0, 32)}`;
}

// --- Turnstile ---------------------------------------------------------------

export function turnstileEnabled(env) {
  return Boolean(env?.TURNSTILE_SECRET_KEY);
}

export async function verifyTurnstile(env, token, ip) {
  if (!turnstileEnabled(env)) return false;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  if (ip && ip !== "unknown") body.append("remoteip", ip);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.success === true;
  } catch (error) {
    console.warn("Turnstile verification failed:", error?.message || error);
    return false;
  }
}

// --- API keys ----------------------------------------------------------------

export function extractApiKey(request) {
  const header = request.headers.get(API_KEY_HEADER);
  if (header) return header.trim();
  const match = (request.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : "";
}

/**
 * Resolve the caller's tier: { tier: "anonymous" } with no key,
 * { tier: "key", keyId } for a key in env.API_KEYS (comma-separated) or an
 * unrevoked row in api_keys (stored as sha256 hex), else { tier: "invalid" }.
 */
export async function resolveApiAccess(request, env) {
  const key = extractApiKey(request);
  if (!key) return { tier: "anonymous" };
  if (key.length > 256) return { tier: "invalid" };

  for (const configured of String(env?.API_KEYS || "").split(",")) {
    const candidate = configured.trim();
    if (candidate && (await timingSafeEqualString(key, candidate))) {
      return { tier: "key", keyId: `env:${(await sha256Hex(candidate)).slice(0, 12)}` };
    }
  }

  if (env?.DB) {
    try {
      const keyHash = await sha256Hex(key);
      const row = await env.DB.prepare("SELECT id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
        .bind(keyHash)
        .first();
      if (row) return { tier: "key", keyId: `db:${row.id}` };
    } catch (error) {
      // api_keys is optional; a missing table just means no stored keys.
      if (!/no such table/i.test(String(error?.message))) console.warn("API key lookup failed:", error?.message || error);
    }
  }
  return { tier: "invalid" };
}

export function apiLimits(access) {
  return access?.tier === "key"
    ? { maxPerPage: KEY_API_MAX_PER_PAGE, maxPage: KEY_API_MAX_PAGE }
    : { maxPerPage: ANON_API_MAX_PER_PAGE, maxPage: ANON_API_MAX_PAGE };
}

export function slimPermitRow(row) {
  const slim = {};
  for (const field of ANON_PERMIT_FIELDS) {
    if (Object.hasOwn(row || {}, field)) slim[field] = row[field];
  }
  return slim;
}
