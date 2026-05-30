// Cloudflare Worker - Fixed Version

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Ingest-Token",
};
const INGEST_TOKEN_HEADER = "X-Ingest-Token";
const BASE_URL = "https://buildingseattle.com";
const ADMIN_TOKEN_HEADER = "X-Admin-Token";
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

      if (path === "/api/permits") {
        return secure(await getPermits(request, env));
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

      if (path === "/api/admin/stats") {
        const authError = requireAdminAuth(request, env);
        if (authError) return secure(authError);
        const stats = await getAdminStats(env);
        return secure(new Response(JSON.stringify(stats), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }));
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
          env.DB.prepare(`SELECT path, COUNT(*) as views FROM page_views WHERE created_at >= ? GROUP BY path ORDER BY views DESC LIMIT 10`).bind(sinceStr).all(),
          env.DB.prepare(`SELECT date(created_at) as day, COUNT(*) as views FROM page_views WHERE created_at >= ? GROUP BY day ORDER BY day DESC`).bind(sinceStr).all(),
        ]);

        return secure(new Response(JSON.stringify({ days, total: totals[0]?.total || 0, top_pages: pages, daily: daily }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }));
      }

      if (path.startsWith("/contractor/")) {
        const slug = path.split("/contractor/")[1];
        ctx.waitUntil(logPageView(request, env, "/contractor/:slug"));
        return secure(await renderContractorPage(slug, env, request));
      }

      if (path === "/ingest/permit" && request.method === "POST") {
        const authError = await requireIngestAuth(request, env);
        if (authError) {
          return secure(authError);
        }
        return secure(await ingestPermit(request, env));
      }

      if (path === "/ingest/permit/batch" && request.method === "POST") {
        const authError = await requireIngestAuth(request, env);
        if (authError) {
          return secure(authError);
        }
        return secure(await ingestPermitBatch(request, env));
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

      if (path === "/og-image.png" || path === "/favicon.ico") {
        return secure(renderOgImage());
      }

      if (path === "/robots.txt") {
        return secure(renderRobotsTxt());
      }

      if (path === "/sitemap.xml") {
        return secure(await renderSitemapXml(env, request));
      }

      return secure(render404());
    } catch (error) {
      console.error("Worker error:", error);
      return secure(new Response(
        JSON.stringify({
          error: "Internal Server Error",
          details: error.message,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      ));
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledIngest(env));
  },
};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
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
    number_review_cycles, total_days_plan_review, days_out_corrections
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  const link = (href, label, key) =>
    `<a href="${href}"${key === activePage ? ' class="active"' : ''}>${label}</a>`;
  return `<nav class="global-nav" id="global-nav">
      <div class="container global-nav-row">
        <a href="/" class="logo"><span class="logo-icon">B</span>Building Seattle</a>
        <button class="global-nav-hamburger" onclick="document.querySelector('#global-nav .global-nav-links').classList.toggle('open')" aria-label="Menu">&#9776;</button>
        <div class="global-nav-links">
          ${link("/", "Home", "home")}
          ${link("/permits", "Browse Permits", "permits")}
          ${link("/api/permits", "API", "api")}
        </div>
      </div>
    </nav>`;
}

function renderFooter() {
  return `<footer class="global-footer">
      <div class="global-footer-row">
        <div>Building Seattle &mdash; Seattle construction intelligence</div>
        <div><a href="mailto:hello@buildingseattle.com">hello@buildingseattle.com</a></div>
      </div>
    </footer>`;
}

async function handleRoot(request, env) {
  const canonical = BASE_URL + "/";
  const lastRun = await env.DB.prepare(`SELECT end_time FROM ingest_logs WHERE status = 'success' ORDER BY end_time DESC LIMIT 1`).first();
  const lastUpdated = lastRun?.end_time ? timeAgo(new Date(lastRun.end_time)) : "Recently";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Seattle Construction Permits & Contractor Intelligence | Building Seattle</title>
    <meta name="description" content="Track live Seattle construction permits, contractors, project values, and status changes from public records in one fast market-intelligence view.">
    <link rel="canonical" href="${canonical}">
    <meta property="og:title" content="Building Seattle | Seattle Construction Intelligence & Lead Generation">
    <meta property="og:description" content="Real-time Seattle construction permits, contractor profiles, and development opportunities.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${canonical}">
    <meta name="twitter:card" content="summary_large_image">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
	    <meta name="twitter:image" content="${BASE_URL}/og-image.png">
	    <link rel="icon" href="/favicon.ico" type="image/png">
    ${renderDesignTokens()}
    <style>
        :root { --primary: #0f172a; --accent: #3b82f6; --bg: #ffffff; --bg-alt: #f8fafc; --text: #1e293b; --text-muted: #64748b; --border: #e2e8f0; --steel: #475569; --amber: #f59e0b; --success: #10b981; --danger: #ef4444; --shadow: 0 22px 60px rgba(15,23,42,0.14); }
        @media (prefers-color-scheme: dark) { :root { --primary: #f8fafc; --bg: #0f172a; --bg-alt: #1e293b; --text: #e2e8f0; --text-muted: #94a3b8; --border: #334155; } }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
        .container { max-width: 1200px; margin: 0 auto; padding: 0 1.5rem; }
        nav { position: fixed; top: 0; width: 100%; background: rgba(255,255,255,0.8); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); z-index: 50; }
        @media (prefers-color-scheme: dark) { nav { background: rgba(15,23,42,0.8); } }
        .nav-container { height: 4rem; display: flex; align-items: center; justify-content: space-between; }
        .logo { font-weight: 800; font-size: 1.5rem; color: var(--primary); text-decoration: none; display: flex; align-items: center; gap: 0.5rem; }
        .logo-icon { width: 2rem; height: 2rem; background: linear-gradient(135deg, var(--accent), #1d4ed8); border-radius: 0.5rem; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; }
        .nav-links { display: none; gap: 2rem; align-items: center; }
        @media (min-width: 768px) { .nav-links { display: flex; } }
        .nav-links a { color: var(--text-muted); text-decoration: none; font-weight: 500; font-size: 0.875rem; }
        .nav-links a:hover { color: var(--accent); }
        .hamburger { display: block; background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--primary); padding: 0.25rem; }
        @media (min-width: 768px) { .hamburger { display: none; } }
        @media (max-width: 767px) {
          .nav-links { position: absolute; top: 4rem; right: 1.5rem; background: rgba(255,255,255,0.95); border: 1px solid var(--border); border-radius: 0.75rem; padding: 0.5rem 1rem; flex-direction: column; min-width: 160px; backdrop-filter: blur(12px); }
          @media (prefers-color-scheme: dark) { .nav-links { background: rgba(15,23,42,0.95); } }
          .nav-links.open { display: flex; }
        }
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
        .hero p { font-size: 1.25rem; margin-bottom: 2rem; max-width: 540px; }
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
        footer { background: var(--bg-alt); border-top: 1px solid var(--border); padding: 3rem 0; color: var(--text-muted); font-size: 0.875rem; }
        .footer-bottom { padding-top: 2rem; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 1rem; align-items: center; }
        @media (min-width: 768px) { .footer-bottom { flex-direction: row; justify-content: space-between; } }
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
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Building Seattle","url":"https://buildingseattle.com","logo":"https://buildingseattle.com/og-image.png","description":"Real-time Seattle construction permits, contractor profiles, and development opportunities."},{"@type":"WebSite","name":"Building Seattle","url":"https://buildingseattle.com","potentialAction":{"@type":"SearchAction","target":"https://buildingseattle.com/permits?neighborhood={search_term_string}","query-input":"required name=search_term_string"}},{"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://buildingseattle.com/"}]}]}</script>
</head>
<body>
    <nav id="navbar">
        <div class="container nav-container">
            <a href="/" class="logo"><div class="logo-icon">B</div>Building Seattle</a>
            <button class="hamburger" onclick="document.querySelector('#navbar .nav-links').classList.toggle('open')" aria-label="Menu">&#9776;</button>
            <div class="nav-links">
                <a href="/permits">Browse Permits</a>
                <a href="/#data">Live Data</a>
                <a href="/api/permits">Data API</a>
            </div>
        </div>
    </nav>

    <section class="hero">
        <canvas id="skyline"></canvas>
        <div class="container">
            <div class="hero-grid">
                <div class="hero-content">
                    <div class="hero-badge"><span class="ops-dot"></span><span>Now tracking live permits</span></div>
                    <h1>Construction intelligence for the Seattle metro</h1>
                    <p>Track live Seattle permits, explore active contractors, and capture opportunities without bouncing between city portals and PDFs.</p>
                    <div class="ops-strip">
                        <div class="ops-chip"><span class="ops-dot"></span><span>Seattle DCI feed</span></div>
                        <div class="ops-chip">Daily ingest</div>
                        <div class="ops-chip">Permit value radar</div>
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

    <section class="cta">
        <div class="container">
            <div class="cta-content">
                <h2>Explore active work before your competitors do</h2>
                <a class="btn btn-white" href="/permits">Browse Permits</a>
            </div>
        </div>
    </section>

    <footer>
        <div class="container">
            <div class="footer-bottom">
                <div>Building Seattle — Seattle construction intelligence</div>
                <div><a href="mailto:hello@buildingseattle.com" style="color:var(--text-muted);text-decoration:none;">hello@buildingseattle.com</a></div>
            </div>
        </div>
    </footer>

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
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
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

async function getPermits(request, env) {
  const url = new URL(request.url);
  const permitNumber = url.searchParams.get("permit");
  const neighborhood = url.searchParams.get("neighborhood");
  const type = url.searchParams.get("type");
  const status = url.searchParams.get("status");
  const q = url.searchParams.get("q");
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
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
    where += " AND (p.address LIKE ? OR p.description LIKE ? OR p.permit_number LIKE ? OR p.neighborhood LIKE ? OR c.name LIKE ?)";
    params.push(like, like, like, like, like);
  }

  const listQuery = `SELECT p.*, c.name as contractor_name, c.slug as contractor_slug, c.specialty as contractor_specialty, c.phone as contractor_phone, c.email as contractor_email FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id ${where} ORDER BY p.issued_date DESC LIMIT ${perPage} OFFSET ${offset}`;
  const countQuery = `SELECT COUNT(*) as total FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id ${where}`;

  const [{ results }, { total }] = await Promise.all([
    env.DB.prepare(listQuery).bind(...params).all(),
    env.DB.prepare(countQuery).bind(...params).first(),
  ]);

  return new Response(JSON.stringify({ total, page, per_page: perPage, results: (results || []).slice(0, perPage) }), {
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
  });
}

async function getRecentStatusChanges(env, limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  try {
    const { results } = await env.DB.prepare(`
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
    `).all();

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
    where += " AND (p.address LIKE ? OR p.description LIKE ? OR p.permit_number LIKE ? OR p.neighborhood LIKE ? OR c.name LIKE ?)";
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
    env.DB.prepare(listQuery).bind(...params).all(),
    env.DB.prepare(`SELECT DISTINCT neighborhood FROM permits WHERE neighborhood IS NOT NULL AND neighborhood != '' ORDER BY neighborhood ASC`).all(),
    env.DB.prepare(`SELECT DISTINCT type FROM permits WHERE type IS NOT NULL AND type != '' ORDER BY type ASC`).all(),
    env.DB.prepare(`SELECT DISTINCT status FROM permits WHERE status IS NOT NULL AND status != '' ORDER BY status ASC`).all(),
    env.DB.prepare(countQuery).bind(...params).first(),
    env.DB.prepare(`SELECT end_time FROM ingest_logs WHERE status = 'success' ORDER BY end_time DESC LIMIT 1`).first(),
    getRecentStatusChanges(env, 8),
  ]);
  const total = totalRaw || 0;
  const totalPages = Math.ceil(total / perPage);
  const lastUpdated = lastRun?.end_time ? timeAgo(new Date(lastRun.end_time)) : "Recently";

  const neighborhoodOptions = neighborhoods
    .map(
      (item) =>
        `<option value="${escapeHtml(item.neighborhood)}"${item.neighborhood === neighborhood ? " selected" : ""}>${escapeHtml(item.neighborhood)}</option>`,
    )
    .join("");
  const typeOptions = types
    .map((item) => `<option value="${escapeHtml(item.type)}"${item.type === type ? " selected" : ""}>${escapeHtml(item.type)}</option>`)
    .join("");
  const statusOptions = statuses
    .map((item) => `<option value="${escapeHtml(item.status)}"${item.status === status ? " selected" : ""}>${escapeHtml(item.status.charAt(0).toUpperCase() + item.status.slice(1))}</option>`)
    .join("");
  const activeFilterDesc = [q ? `search: "${q}"` : null, neighborhood, type, status].filter(Boolean).join(", ") || "All permits";
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
    <link rel="canonical" href="${BASE_URL}/permits">
    <meta property="og:title" content="Browse Seattle Construction Permits | Building Seattle">
    <meta property="og:description" content="Browse active Seattle construction permits by neighborhood and permit type.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${BASE_URL}/permits">
    <meta name="twitter:card" content="summary">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
	    <meta property="og:image:width" content="1200">
	    <meta property="og:image:height" content="630">
	    <meta name="twitter:image" content="${BASE_URL}/og-image.png">
	    <link rel="icon" href="/favicon.ico" type="image/png">
	    ${renderDesignTokens()}
	    <style>
        * { box-sizing: border-box; }
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-alt); color: var(--text); }
        .container { max-width: var(--container-max); margin: 0 auto; padding: 0 1.5rem; }
        nav { position: sticky; top: 0; z-index: 50; background: rgba(248,250,252,0.95); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); }
        .nav-row { min-height: 4.5rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
        .brand { font-weight: 800; color: var(--primary); text-decoration: none; font-size: 1.25rem; }
        .nav-links { display: flex; gap: 1rem; align-items: center; }
        .nav-links a { color: var(--text-muted); text-decoration: none; font-weight: 600; padding: 0.5rem 0; }
        .hamburger { display: none; background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--primary); padding: 0.25rem; }
        @media (max-width: 720px) {
          .hamburger { display: block; }
          .nav-links { display: none; position: absolute; top: 4.5rem; right: 1rem; background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem; padding: 0.5rem; flex-direction: column; min-width: 160px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); z-index: 100; }
          .nav-links.open { display: flex; }
        }
        .hero { padding: 3.5rem 0 2rem; }
        .hero h1 { margin: 0 0 0.75rem; font-size: clamp(2rem, 4vw, 3.25rem); line-height: 1.05; }
        .hero p { margin: 0; max-width: 720px; color: var(--text-muted); font-size: 1.05rem; }
        .filters { background: var(--surface); border: 1px solid var(--border); border-radius: 1rem; padding: 1rem; display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin: 2rem 0; }
	        label { display: block; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-bottom: 0.4rem; }
	        select, button, .secondary-link { width: 100%; border-radius: 0.75rem; border: 1px solid var(--border); padding: 0.8rem 0.9rem; font: inherit; }
	        button { background: var(--accent); color: white; font-weight: 700; cursor: pointer; border-color: var(--accent); }
	        .hamburger { width: auto; border: none; padding: 0.25rem; }
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
          .nav-row { flex-direction: row; align-items: center; }
          .permit-card-top, .permit-footer, .results-head, .status-changes-header, .change-card { flex-direction: column; align-items: stretch; }
          .change-status { justify-content: flex-start; min-width: 0; }
        }
    </style>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://buildingseattle.com/"},{"@type":"ListItem","position":2,"name":"Permits","item":"https://buildingseattle.com/permits"}]}</script>
</head>
<body>
    <nav>
        <div class="container nav-row">
            <a class="brand" href="/">Building Seattle</a>
            <button class="hamburger" onclick="document.querySelector('.nav-links').classList.toggle('open')" aria-label="Menu">&#9776;</button>
            <div class="nav-links">
                <a href="/">Home</a>
                <a href="/permits">Permits</a>
                <a href="/api/permits">API</a>
            </div>
        </div>
    </nav>
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
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

async function renderPermitDetail(permitNumber, env, request) {
  const canonical = BASE_URL + "/permits/" + encodeURIComponent(permitNumber);
  const { results } = await env.DB.prepare(
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
    .all();

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
    ["Expires", permit.expires_date ? new Date(permit.expires_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : null],
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
  const primaryLeadLabel = permit.contractor_name ? "Request Project Updates" : "Request Permit Updates";
  const leadSource = `permit_detail:${permit.permit_number}`;

  const permitType = typeMap[(permit.type || "").toLowerCase()] || (permit.type ? permit.type.charAt(0).toUpperCase() + permit.type.slice(1).toLowerCase() : "General Construction");
  const valueFormatted = permit.value ? `$${parseInt(permit.value).toLocaleString()}` : "N/A";
  const metaDesc = `${permit.address || "Seattle location"}: ${permitType} permit (${permit.status || "new"}) in ${neighborhood}. Project value: ${valueFormatted}.${permit.contractor_name ? ` Contractor: ${permit.contractor_name}.` : ""}`;
  const safePermitNumber = escapeHtml(permit.permit_number);
  const safeAddress = escapeHtml(permit.address || "Unknown Address");
  const safeNeighborhood = escapeHtml(neighborhood);
  const safePermitType = escapeHtml(permitType);
  const safeStatus = escapeHtml(permit.status || "Unknown");
  const safeMetaDesc = escapeHtml(metaDesc);
  const safeTitleAddress = escapeHtml(permit.address || "Seattle");
  const safeDescription = escapeHtml(permit.detailed_description || permit.description || "No description available for this permit.");
  const mapsQuery = encodeURIComponent(permit.address || "Seattle, WA");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
	    <title>Permit ${safePermitNumber} — ${safeTitleAddress} | Building Seattle</title>
	    <meta name="description" content="${safeMetaDesc}">
	    <link rel="canonical" href="${canonical}">
	    <meta property="og:title" content="Permit ${safePermitNumber} — ${safeTitleAddress} | Building Seattle">
	    <meta property="og:description" content="${safeMetaDesc}">
    <meta property="og:type" content="article">
    <meta property="og:url" content="${canonical}">
    <meta name="twitter:card" content="summary">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
	    <meta property="og:image:height" content="630">
	    <meta name="twitter:image" content="${BASE_URL}/og-image.png">
	    <link rel="icon" href="/favicon.ico" type="image/png">
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

        /* Navigation */
        nav {
            position: fixed;
            top: 0;
            width: 100%;
            background: rgba(255,255,255,0.9);
            backdrop-filter: blur(12px);
            border-bottom: 1px solid var(--border);
            z-index: 50;
        }
        @media (prefers-color-scheme: dark) {
            nav { background: rgba(15,23,42,0.9); }
        }
        .nav-container {
            height: 4rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .logo {
            font-weight: 800;
            font-size: 1.5rem;
            color: var(--primary);
            text-decoration: none;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        .logo-icon {
            width: 2rem;
            height: 2rem;
            background: linear-gradient(135deg, var(--accent), #1d4ed8);
            border-radius: 0.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
        }
        .back-link {
            color: var(--text-muted);
            text-decoration: none;
            font-size: 0.875rem;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            transition: color 0.2s;
        }
        .back-link:hover { color: var(--accent); }
        .hamburger { display: none; background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--primary); padding: 0.25rem; }
        .mobile-nav { display: none; position: absolute; top: 4rem; right: 1.5rem; background: rgba(255,255,255,0.95); border: 1px solid var(--border); border-radius: 0.75rem; padding: 0.5rem 1rem; flex-direction: column; min-width: 160px; backdrop-filter: blur(12px); z-index: 100; }
        @media (prefers-color-scheme: dark) { .mobile-nav { background: rgba(15,23,42,0.95); } }
        .mobile-nav.open { display: flex; }
        .mobile-nav a { color: var(--text-muted); text-decoration: none; font-size: 0.875rem; font-weight: 500; padding: 0.5rem 0; }
        .mobile-nav a:hover { color: var(--accent); }
        @media (max-width: 720px) { .hamburger { display: block; } .back-link { display: none; } }

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
	    <script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://buildingseattle.com/"},{"@type":"ListItem","position":2,"name":"Permits","item":"https://buildingseattle.com/permits"},{"@type":"ListItem","position":3,"name":"Permit ${safePermitNumber}","item":"https://buildingseattle.com/permits/${encodeURIComponent(permit.permit_number)}"}]}</script>
</head>
<body>
    <nav>
        <div class="container nav-container">
            <a href="/" class="logo">
                <div class="logo-icon">B</div>
                Building Seattle
            </a>
            <button class="hamburger" onclick="document.querySelector('.mobile-nav').classList.toggle('open')" aria-label="Menu">&#9776;</button>
            <a href="/permits" class="back-link">
                <span>&larr;</span> Back to Permits
            </a>
            <div class="mobile-nav">
                <a href="/">Home</a>
                <a href="/permits">Permits</a>
                <a href="/api/permits">API</a>
            </div>
        </div>
    </nav>
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
                <div class="card">
                    <div class="card-label">Project Details</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:0.75rem;">
                        <div><div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Value</div><div style="font-size:1.25rem;font-weight:800;color:var(--primary);">${valueFormatted}</div></div>
	                        <div><div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Type</div><div style="font-size:1rem;font-weight:600;color:var(--primary);">${safePermitType}</div></div>
	                        <div><div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Issued</div><div style="font-size:1rem;font-weight:600;color:var(--primary);">${issuedDate}</div></div>
	                        <div><div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Location</div><div style="font-size:1rem;font-weight:600;color:var(--primary);">${safeNeighborhood}</div></div>
                    </div>
                </div>

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
            <p id="leadModalDescription" style="color:var(--text-muted);margin-bottom:1.5rem;font-size:0.9rem;">Get notified about permit ${safePermitNumber} and similar Seattle projects.</p>
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
                <button type="submit" class="btn btn-primary" style="width:100%;">
                    <span id="submitText">Request Updates</span>
                    <span id="submitLoader" class="loader hidden"></span>
                </button>
            </form>
            <div id="formSuccess" class="hidden" style="text-align:center;padding:2rem;">
                <div style="font-size:3rem;margin-bottom:1rem;">&#10003;</div>
                <h4>You're on the list!</h4>
                <p style="color:var(--text-muted);">We'll email you when this project changes.</p>
            </div>
        </div>
    </div>

    <footer>
        <div class="container">
            &copy; 2026 Building Seattle. Construction intelligence for the Seattle metro.
        </div>
    </footer>
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
                source: '${leadSource}',
                neighborhoods: '${neighborhood}',
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
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
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
    env.DB.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(value) as total_value,
        AVG(value) as avg_value
      FROM permits
    `).first(),
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
    env.DB.prepare("SELECT SUM(records_added) as added FROM ingest_logs WHERE start_time > datetime('now', '-1 day')").first(),
    env.DB.prepare(`
      SELECT neighborhood, COUNT(*) as count 
      FROM permits 
      WHERE created_at > datetime('now', '-7 days')
      GROUP BY neighborhood 
      ORDER BY count DESC LIMIT 5
    `).all(),
    env.DB.prepare(`
      SELECT 
        AVG(strftime('%s', end_time) - strftime('%s', start_time)) as avg_duration,
        COUNT(CASE WHEN status = 'success' THEN 1 END) * 100.0 / COUNT(*) as success_rate
      FROM ingest_logs
    `).first(),
    env.DB.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM permits) as permits,
        (SELECT COUNT(*) FROM contractors) as contractors,
        (SELECT COUNT(*) FROM leads) as leads
    `).first(),
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

	  const logRows = logs.results.map(log => `
	    <tr style="border-bottom: 1px solid var(--border);">
	      <td style="padding: 0.75rem;">${escapeHtml(log.start_time)}</td>
	      <td style="padding: 0.75rem; font-weight: 600;">${escapeHtml(log.run_type)}</td>
	      <td style="padding: 0.75rem;">
	        <span class="badge" style="background: ${log.status === 'success' ? '#10b98120; color: #10b981' : '#ef444420; color: #ef4444'}">
	          ${escapeHtml(log.status)}
	        </span>
	      </td>
	      <td style="padding: 0.75rem;">+${Number(log.records_added || 0).toLocaleString()}</td>
	      <td style="padding: 0.75rem; font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(log.error_message || 'None')}</td>
	    </tr>
	  `).join('');

  const leadRows = leads.results.length === 0
    ? '<tr><td colspan="6" style="padding: 2rem; text-align: center; color: var(--text-muted);">No leads captured yet.</td></tr>'
    : leads.results.map(lead => `
	    <tr style="border-bottom: 1px solid var(--border);">
	      <td style="padding: 0.75rem;">${escapeHtml(lead.created_at)}</td>
	      <td style="padding: 0.75rem; font-weight: 600;">${escapeHtml(lead.email)}</td>
	      <td style="padding: 0.75rem;">${escapeHtml(lead.company)}</td>
	      <td style="padding: 0.75rem;"><span class="badge" style="background: #eff6ff; color: #3b82f6;">${escapeHtml(lead.interest)}</span></td>
	      <td style="padding: 0.75rem; font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(lead.neighborhoods || '-')}</td>
	      <td style="padding: 0.75rem; font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(lead.source)}</td>
	    </tr>
	  `).join('');

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
              <div class="card"><span class="label">Last Run</span><div class="value">${stats.last_run?.status || 'N/A'}</div></div>
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
    return render404({
      heading: "Contractor not found",
      message: "We do not have a profile for that contractor yet. Browse all linked contractors via the permits feed.",
    });
  }

  const [permits, metrics, marketFocus, projectTypes] = await Promise.all([
    env.DB.prepare("SELECT * FROM permits WHERE contractor_id = ? ORDER BY issued_date DESC LIMIT 10")
      .bind(contractor.id).all(),
    env.DB.prepare(`
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
    `).bind(contractor.id).first().catch(() => ({
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
    env.DB.prepare(`
      SELECT neighborhood, COUNT(*) as count, SUM(value) as total_value
      FROM permits 
      WHERE contractor_id = ? AND neighborhood IS NOT NULL
      GROUP BY neighborhood 
      ORDER BY count DESC 
      LIMIT 3
    `).bind(contractor.id).all(),
    env.DB.prepare(`
      SELECT type, COUNT(*) as count
      FROM permits 
      WHERE contractor_id = ? AND type IS NOT NULL
      GROUP BY type 
      ORDER BY count DESC
    `).bind(contractor.id).all(),
  ]);

	  const permitDays = metrics.avg_permit_days ? Math.round(metrics.avg_permit_days) : "—";
	  const buildDays = metrics.avg_build_days ? Math.round(metrics.avg_build_days) : "—";
	  const activeProjects = metrics.active_count || 0;
	  const completionRate = metrics.total_count ? Math.round((metrics.completed_count / metrics.total_count) * 100) : 0;
	  const reviewCycles = metrics.avg_review_cycles != null ? metrics.avg_review_cycles.toFixed(1) : "—";
	  const planReviewDays = metrics.avg_plan_review_days != null ? Math.round(metrics.avg_plan_review_days) : "—";
	  const correctionsDays = metrics.avg_corrections_days != null ? Math.round(metrics.avg_corrections_days) : "—";
	  const netHousingUnits = (metrics.units_added || 0) - (metrics.units_removed || 0);
	  const licenseStatusRaw = contractor.license_status ? String(contractor.license_status).trim() : "";
	  const licenseStatusUpper = licenseStatusRaw.toUpperCase();
	  const licenseBadgeColor = licenseStatusUpper === "ACTIVE"
	    ? "#10b981"
	    : licenseStatusUpper === "EXPIRED"
	      ? "#ef4444"
	      : "#64748b";
	  const insuranceFormatted = Number.isFinite(Number(contractor.insurance_amount)) && Number(contractor.insurance_amount) > 0
	    ? `$${Number(contractor.insurance_amount).toLocaleString()}`
	    : null;
	  const insuranceExpiry = contractor.insurance_expires_date
	    ? new Date(contractor.insurance_expires_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
	    : null;
	  const hasCredentials = Boolean(contractor.license_number || contractor.ubi || insuranceFormatted);
	  const credentialsCard = hasCredentials
	    ? `<div class="card">
	          <h3 style="margin-top:0">WA L&amp;I Credentials</h3>
	          ${licenseStatusRaw
	            ? `<div style="display:inline-block;padding:0.25rem 0.75rem;border-radius:999px;background:${licenseBadgeColor};color:#fff;font-size:0.75rem;font-weight:700;letter-spacing:0.05em;margin-bottom:1rem">${escapeHtml(licenseStatusUpper)}</div>`
	            : ""}
	          ${contractor.license_number ? `<p style="margin:0.5rem 0;font-size:0.9375rem"><span style="color:#64748b">License</span> <span style="font-weight:600;font-family:monospace">${escapeHtml(contractor.license_number)}</span></p>` : ""}
	          ${contractor.ubi ? `<p style="margin:0.5rem 0;font-size:0.9375rem"><span style="color:#64748b">UBI</span> <span style="font-weight:600;font-family:monospace">${escapeHtml(contractor.ubi)}</span></p>` : ""}
	          ${insuranceFormatted ? `<p style="margin:0.5rem 0;font-size:0.9375rem"><span style="color:#64748b">Insurance</span> <span style="font-weight:600">${escapeHtml(insuranceFormatted)}</span>${insuranceExpiry ? ` <span style="color:#94a3b8;font-size:0.8125rem">(through ${escapeHtml(insuranceExpiry)})</span>` : ""}</p>` : ""}
	          <p style="margin:1rem 0 0;font-size:0.75rem;color:#94a3b8">Verified via WA Labor &amp; Industries</p>
	        </div>`
	    : "";
	  const safeContractorName = escapeHtml(contractor.name);
	  const safeContractorSpecialty = escapeHtml(contractor.specialty || "Contractor");
	  const safeContractorDescription = escapeHtml(contractor.description || "Seattle area construction professional");
	  const safeContractorMetaDescription = escapeHtml(`${contractor.name} is a ${contractor.specialty || "construction"} contractor in Seattle with ${activeProjects} active projects and ${permits.results.length} total permits. View project history and contact information.`);
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
	          { "@type": "ListItem", position: 3, name: contractor.name, item: `${BASE_URL}/contractor/${encodeURIComponent(slug)}` },
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
	    <link rel="canonical" href="${canonical}">
	    <meta property="og:title" content="${safeContractorName} — ${safeContractorSpecialty} | Seattle | Building Seattle">
	    <meta property="og:description" content="${safeContractorMetaDescription}">
    <meta property="og:type" content="profile">
    <meta property="og:url" content="${canonical}">
    <meta name="twitter:card" content="summary">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
	    <meta property="og:image:width" content="1200">
	    <meta property="og:image:height" content="630">
	    <meta name="twitter:image" content="${BASE_URL}/og-image.png">
	    <link rel="icon" href="/favicon.ico" type="image/png">
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
            </div>
            <div>
                ${credentialsCard}
                <div class="card">
                    <h3>Market Specialization</h3>
                    <div style="margin-top:1.5rem">
                        <div style="font-size:0.875rem; color:#64748b; margin-bottom:0.75rem">Top Neighborhoods</div>
                        ${marketFocus.results.map(f => `
                            <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem; font-size:0.9375rem">
	                                <span style="font-weight:600">${escapeHtml(f.neighborhood)}</span>
                                <span style="color:#64748b">${f.count} projects</span>
                            </div>
                        `).join('')}
                    </div>
                    <div style="margin-top:1.5rem; padding-top:1.5rem; border-top:1px solid #e2e8f0">
                        <div style="font-size:0.875rem; color:#64748b; margin-bottom:0.75rem">Project Composition</div>
                        <div style="display:flex; flex-wrap:wrap; gap:0.5rem">
                            ${projectTypes.results.map(t => `
	                                <span style="background:#eff6ff; color:#3b82f6; padding:0.25rem 0.75rem; border-radius:999px; font-size:0.75rem; font-weight:600; text-transform:capitalize">${escapeHtml(t.type)}</span>
                            `).join('')}
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
                            <div style="font-size:1.5rem;font-weight:800;color:${netHousingUnits > 0 ? '#10b981' : netHousingUnits < 0 ? '#ef4444' : '#3b82f6'}">${netHousingUnits > 0 ? '+' : ''}${netHousingUnits}</div>
                            <div style="font-size:0.75rem;color:#64748b">Net Housing Units</div>
                        </div>
                    </div>

                    <div style="padding-top:1rem; border-top:1px solid #e2e8f0">
	                        ${contractor.phone ? `<p style="margin:0.5rem 0">Phone <span style="font-weight:500">${escapeHtml(contractor.phone)}</span></p>` : ""}
	                        ${contractor.email ? `<p style="margin:0.5rem 0">Email <span style="font-weight:500">${escapeHtml(contractor.email)}</span></p>` : ""}
	                        ${contractorWebsite ? `<p style="margin:0.5rem 0">Web <a href="${escapeHtml(contractorWebsite)}" target="_blank" rel="noopener" style="color:#3b82f6; text-decoration:none">${escapeHtml(contractorWebsite.replace('https://','').replace('http://',''))}</a></p>` : ""}
                    </div>
                </div>
            </div>
        </div>
    </div>
    ${renderFooter()}
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

async function logIngest(env, { run_type, source, status, records_added = 0, records_updated = 0, error_message = null, start_time, end_time }) {
  const stmt = env.DB.prepare(`
    INSERT INTO ingest_logs (run_type, source, status, records_added, records_updated, error_message, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  await stmt.bind(
    run_type,
    source,
    status,
    records_added,
    records_updated,
    error_message,
    start_time.toISOString().replace('T', ' ').split('.')[0],
    end_time.toISOString().replace('T', ' ').split('.')[0]
  ).run();
}

const SDCI_PERMIT_URL = "https://data.seattle.gov/resource/k44w-2dcq.json";
const SCHEDULED_INGEST_LIMIT = 5000;
const SCHEDULED_INGEST_PAGE_SIZE = 1000;

const NEIGHBORHOOD_BOUNDS = [
  ["Ballard", 47.668, 47.692, -122.410, -122.370],
  ["Crown Hill", 47.692, 47.710, -122.390, -122.370],
  ["Fremont", 47.650, 47.668, -122.370, -122.340],
  ["Phinney Ridge", 47.668, 47.692, -122.370, -122.350],
  ["Greenwood", 47.692, 47.710, -122.370, -122.340],
  ["Broadview", 47.710, 47.735, -122.370, -122.340],
  ["Bitter Lake", 47.710, 47.735, -122.360, -122.335],
  ["Magnolia", 47.630, 47.670, -122.420, -122.385],
  ["Interbay", 47.640, 47.660, -122.385, -122.365],
  ["Green Lake", 47.668, 47.692, -122.360, -122.325],
  ["Wallingford", 47.650, 47.668, -122.340, -122.315],
  ["Roosevelt", 47.668, 47.685, -122.325, -122.310],
  ["Maple Leaf", 47.685, 47.710, -122.325, -122.300],
  ["Northgate", 47.700, 47.720, -122.340, -122.310],
  ["Licton Springs", 47.692, 47.710, -122.345, -122.325],
  ["Haller Lake", 47.715, 47.735, -122.345, -122.320],
  ["Pinehurst", 47.720, 47.740, -122.320, -122.295],
  ["University District", 47.650, 47.668, -122.315, -122.290],
  ["Ravenna", 47.668, 47.688, -122.310, -122.280],
  ["Wedgwood", 47.685, 47.700, -122.300, -122.280],
  ["View Ridge", 47.680, 47.695, -122.280, -122.260],
  ["Sand Point", 47.680, 47.695, -122.270, -122.250],
  ["Laurelhurst", 47.660, 47.680, -122.285, -122.265],
  ["Bryant", 47.668, 47.685, -122.290, -122.270],
  ["Meadowbrook", 47.700, 47.715, -122.300, -122.280],
  ["Lake City", 47.710, 47.735, -122.300, -122.270],
  ["Olympic Hills", 47.720, 47.740, -122.300, -122.275],
  ["Queen Anne", 47.625, 47.650, -122.370, -122.345],
  ["South Lake Union", 47.620, 47.635, -122.345, -122.325],
  ["Eastlake", 47.635, 47.650, -122.335, -122.320],
  ["Capitol Hill", 47.610, 47.640, -122.325, -122.300],
  ["First Hill", 47.600, 47.615, -122.330, -122.315],
  ["Central District", 47.600, 47.620, -122.310, -122.290],
  ["Madrona", 47.608, 47.625, -122.295, -122.280],
  ["Leschi", 47.596, 47.608, -122.295, -122.280],
  ["Madison Park", 47.630, 47.645, -122.290, -122.270],
  ["Madison Valley", 47.625, 47.640, -122.300, -122.285],
  ["Montlake", 47.640, 47.655, -122.310, -122.290],
  ["Downtown", 47.600, 47.620, -122.345, -122.325],
  ["Belltown", 47.612, 47.622, -122.355, -122.340],
  ["Pioneer Square", 47.598, 47.605, -122.340, -122.325],
  ["International District", 47.593, 47.602, -122.330, -122.315],
  ["SoDo", 47.565, 47.595, -122.345, -122.320],
  ["Georgetown", 47.540, 47.565, -122.340, -122.310],
  ["Beacon Hill", 47.555, 47.600, -122.315, -122.295],
  ["North Beacon Hill", 47.575, 47.600, -122.315, -122.295],
  ["Mt Baker", 47.570, 47.590, -122.295, -122.280],
  ["Columbia City", 47.555, 47.575, -122.295, -122.275],
  ["Hillman City", 47.545, 47.558, -122.295, -122.275],
  ["Rainier Beach", 47.505, 47.535, -122.275, -122.245],
  ["Seward Park", 47.530, 47.560, -122.270, -122.250],
  ["Rainier Valley", 47.520, 47.555, -122.300, -122.270],
  ["South Park", 47.520, 47.540, -122.340, -122.315],
  ["Dunlap", 47.530, 47.545, -122.280, -122.260],
  ["West Seattle", 47.530, 47.600, -122.420, -122.345],
  ["Admiral", 47.570, 47.585, -122.410, -122.380],
  ["Alki", 47.576, 47.592, -122.420, -122.400],
  ["White Center", 47.505, 47.530, -122.380, -122.345],
];

async function runScheduledIngest(env) {
  const startTime = new Date();

  try {
    const rawPermits = await fetchSdciPermits();
    const { permits, contractors } = normalizeSdciPermits(rawPermits);

    await upsertScheduledContractors(env, contractors);
    const { added, updated } = await upsertScheduledPermits(env, permits);

    await logIngest(env, {
      run_type: "scheduled",
      source: "seattle_open_data",
      status: "success",
      records_added: added,
      records_updated: updated,
      start_time: startTime,
      end_time: new Date(),
    });

    console.log(`Scheduled ingest complete: ${added} added, ${updated} updated`);
    return { added, updated, contractors: contractors.length };
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
        "Accept": "application/json",
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

    const address = [
      item.originaladdress1 || "",
      item.originalcity || "Seattle",
      item.originalstate || "WA",
    ].filter(Boolean).join(", ");

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
      applied_date: extractDate(item.applieddate),
      issued_date: extractDate(item.issueddate),
      completed_date: extractDate(item.completeddate),
    });
  }

  return { permits, contractors: [...contractorsBySlug.values()] };
}

async function upsertScheduledContractors(env, contractors) {
  for (let i = 0; i < contractors.length; i += 100) {
    const batch = contractors.slice(i, i + 100).map((contractor) => env.DB.prepare(`
      INSERT INTO contractors (name, slug, specialty)
      VALUES (?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        specialty = COALESCE(excluded.specialty, contractors.specialty),
        updated_at = CURRENT_TIMESTAMP
    `).bind(contractor.name, contractor.slug, contractor.specialty || null));

    if (batch.length) {
      await env.DB.batch(batch);
    }
  }
}

async function upsertScheduledPermits(env, permits) {
  let added = 0;
  let updated = 0;
  const { results: allContractors } = await env.DB.prepare("SELECT id, name FROM contractors").all();
  const contractorMap = new Map((allContractors || []).map((contractor) => [contractor.name.toLowerCase(), contractor.id]));

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
      );
    });

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
    `SELECT permit_number, status FROM permits WHERE permit_number IN (${placeholders})`
  ).bind(...permitNumbers).all();

  for (const row of results || []) {
    existingStatuses.set(row.permit_number, row.status);
  }

  return existingStatuses;
}

function buildStatusChangeStatements(env, statusChanges) {
  return statusChanges.map((change) =>
    env.DB.prepare(`
      INSERT INTO permit_status_changes (permit_number, previous_status, new_status)
      VALUES (?, ?, ?)
    `).bind(
      change.permit_number,
      change.previous_status || null,
      change.new_status || "new",
    ),
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
    )
    .run();

  if (existingPermit) {
    const previousStatus = normalizeStoredStatus(existingPermit.status);
    if (previousStatus !== incomingStatus) {
      await env.DB.prepare(`
        INSERT INTO permit_status_changes (permit_number, previous_status, new_status)
        VALUES (?, ?, ?)
      `).bind(data.permit_number, previousStatus, incomingStatus).run();
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
    const { results: allContractors } = await env.DB.prepare(
      "SELECT id, name FROM contractors"
    ).all();
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
          `SELECT permit_number, status FROM permits WHERE permit_number IN (${placeholders})`
        ).bind(...chunk).all();
        for (const r of results) existingStatuses.set(r.permit_number, r.status);
      }
    }

    // 3. Build batched insert statements
    const statements = [];
    const statusChanges = [];
    for (const item of items) {
      const contractorId = item.contractor_name
        ? (contractorMap.get(item.contractor_name.toLowerCase()) || null)
        : null;
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
        )
      );
    }

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
  const contractorLicense = item.contractor_license || contractorDisclosure.contractor_license || licenseLookup.contractorlicensenumber || "";
  const contractorName = item.contractor_name || licenseLookup.businessname || "";

  return {
    permit_number: item.permit_number,
    contractor_name: contractorName ? String(contractorName).trim() : "",
    contractor_license: contractorLicense ? String(contractorLicense).trim() : "",
    contractor_license_status: item.contractor_license_status || licenseLookup.licensestatusdesc || "",
    contractor_ubi: item.contractor_ubi || licenseLookup.ubi || "",
    contractor_insurance_amount: intOrNull(item.contractor_insurance_amount || licenseLookup.insuranceamt),
    contractor_insurance_expires_date: dateOrNull(item.contractor_insurance_expires_date || licenseLookup.expirationdate),
    permit_detail_url: item.permit_detail_url || item.detail_url || null,
    work_performed_by: item.work_performed_by || contractorDisclosure.performing_work || applicationInfo["Who will be performing all the work?"] || null,
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
      env.DB.prepare(`
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
      `).bind(
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
      const { results } = await env.DB.prepare(
        `SELECT id, slug FROM contractors WHERE slug IN (${placeholders})`,
      ).bind(...chunk).all();
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
      return env.DB.prepare(`
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
      `).bind(
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
      await env.DB.batch(permitStatements.slice(i, i + 100));
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

    return new Response(JSON.stringify({
      processed: normalizedItems.length,
      permits_updated: permitsUpdated,
      contractors_upserted: contractorsUpserted,
      contractors_linked: contractorsLinked,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
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

    return new Response(JSON.stringify({
      success: true,
      permits_deleted: permitsDeleted,
      contractors_deleted: contractorsDeleted,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
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
      env.DB.prepare(`
        INSERT INTO contractors (name, slug, specialty, license_number, years_active)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
          name = excluded.name,
          specialty = excluded.specialty,
          license_number = COALESCE(excluded.license_number, contractors.license_number),
          years_active = COALESCE(excluded.years_active, contractors.years_active),
          updated_at = CURRENT_TIMESTAMP
      `).bind(
        item.name,
        item.slug,
        item.specialty || null,
        item.license_number || null,
        item.years_active || null,
      )
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


function renderRobotsTxt() {
  const body = `User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/admin/
Disallow: /ingest/
Disallow: /leads

Sitemap: ${BASE_URL}/sitemap.xml
`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain" },
  });
}

async function renderSitemapXml(env, request) {
  const origin = new URL(request.url).origin;
  const [{ results: permits }, { results: contractors }] = await Promise.all([
    env.DB.prepare("SELECT permit_number, issued_date FROM permits ORDER BY issued_date DESC").all(),
    env.DB.prepare("SELECT slug, updated_at FROM contractors").all(),
  ]);

  const staticUrls = [
    { loc: origin + "/", priority: "1.0", changefreq: "daily" },
    { loc: origin + "/permits", priority: "0.9", changefreq: "daily" },
  ];

  const permitUrls = permits.map((p) => ({
    loc: origin + "/permits/" + encodeURIComponent(p.permit_number),
    priority: "0.7",
    changefreq: "weekly",
    lastmod: p.issued_date,
  }));

  const contractorUrls = contractors.map((c) => ({
    loc: origin + "/contractor/" + encodeURIComponent(c.slug),
    priority: "0.6",
    changefreq: "weekly",
    lastmod: c.updated_at ? c.updated_at.substring(0, 10) : undefined,
  }));

  const allUrls = [...staticUrls, ...permitUrls, ...contractorUrls];

	  const urlEntries = allUrls
	    .map(
	      (u) => `  <url>
	    <loc>${escapeHtml(u.loc)}</loc>
	    <priority>${u.priority}</priority>
	    <changefreq>${u.changefreq}</changefreq>${u.lastmod ? "\n    <lastmod>" + escapeHtml(u.lastmod) + "</lastmod>" : ""}
	  </url>`,
	    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>`;

  return new Response(xml, {
    headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" },
  });
}


function renderOgImage() {
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAABLAAAAJ2EAYAAAAf0KcfAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRP//////" +
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
  const binary = Uint8Array.from(atob(pngBase64), c => c.charCodeAt(0));
  return new Response(binary.buffer, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

function render404(options) {
  const heading = options?.heading || "Page not found";
  const message = options?.message || "The page you are looking for does not exist or has been moved. Try browsing live permits or return to the homepage.";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(heading)} | Building Seattle</title>
    <meta name="description" content="${escapeHtml(message)}">
    <meta name="robots" content="noindex">
    <link rel="canonical" href="${BASE_URL}/">
    <link rel="icon" href="/favicon.ico" type="image/png">
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
