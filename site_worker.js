import baseWorker from "./worker.js";

const BASE_URL = "https://buildingseattle.com";
const CACHE_CONTROL = "public, max-age=300, s-maxage=300";
const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self' https://cloudflareinsights.com https://*.cloudflareinsights.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; "),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function compactNumber(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1e9) return `${(number / 1e9).toFixed(number >= 10e9 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/, "")}B`;
  if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(number >= 10e6 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/, "")}M`;
  if (Math.abs(number) >= 1e3) return `${(number / 1e3).toFixed(number >= 10e3 ? 0 : 1).replace(/\.0$/, "")}K`;
  return Math.round(number).toLocaleString("en-US");
}

function compactMoney(value) {
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

// Display helper: SDCI source text arrives in ALL CAPS ("2704 S HINDS ST,
// SEATTLE, WA"). Render title case for readability while keeping directionals,
// unit types, and common business suffixes uppercase.
const TITLECASE_KEEP_UPPER = new Set(["NE", "NW", "SE", "SW", "N", "S", "E", "W", "LLC", "LLP", "INC", "CO", "USA", "US", "WA", "ADU", "DADU", "HVAC", "IID", "IV", "III", "II"]);
function smartTitleCase(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\b[a-z][a-z0-9&.'/()-]*/g, (word) => {
      const upper = word.toUpperCase();
      if (TITLECASE_KEEP_UPPER.has(upper)) return upper;
      return word.replace(/(^|[\s/('-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
    });
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
         COALESCE(SUM(value), 0) AS total_value,
         MAX(COALESCE(issued_date, applied_date)) AS latest_record_date
       FROM permits`,
    ),
    dbFirst(
      env,
      `/* homepage:last-ingest */
       SELECT end_time FROM ingest_logs
       WHERE status = 'success'
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
       SELECT p.address AS label, COUNT(*) AS active_permits, COALESCE(SUM(p.value), 0) AS total_value
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
       SELECT c.name AS label, c.slug, COUNT(p.id) AS permits, COALESCE(SUM(p.value), 0) AS total_value
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
       SELECT p.neighborhood AS label, COUNT(*) AS permits, COALESCE(SUM(p.value), 0) AS total_value
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
    return `<div class="empty-state">No recent status changes are available in the current data snapshot.</div>`;
  }

  return changes
    .map((change) => {
      const permit = encodeURIComponent(String(change.permit_number || ""));
      const title = change.address ? smartTitleCase(change.address) : change.permit_number || "Seattle permit";
      const metadata = [
        humanize(change.type, "Permit"),
        change.value ? `${compactMoney(change.value)} declared value` : null,
        change.changed_at ? formatDate(change.changed_at, true) : null,
      ].filter(Boolean);
      return `<a class="change-row" href="/permits/${permit}">
        <span class="transition">${escapeHtml(transitionLabel(change))}</span>
        <span class="change-title">${escapeHtml(title)}</span>
        <span class="change-meta">${escapeHtml(metadata.join(" · "))}</span>
      </a>`;
    })
    .join("");
}

function renderRanking(rows, type) {
  if (!rows.length) return `<div class="empty-state compact">No qualifying records in this snapshot.</div>`;

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
        <span class="rank-value">${escapeHtml(compactMoney(row.total_value || 0))}<small>declared</small></span>
      </a>`;
    })
    .join("");
}

export function renderHomepage(snapshot) {
  const { stats, changes, addresses, contractors30d, neighborhoods30d } = snapshot;
  const ingestLabel = stats.last_ingest_at ? formatDate(stats.last_ingest_at, true) : "Unavailable";
  const recordLabel = stats.latest_record_date ? formatDate(stats.latest_record_date) : "Unavailable";
  const title = "Seattle Construction Permits & Projects — Building Seattle";
  const description = "Search Seattle construction permits, contractor activity, neighborhoods, addresses, and recent SDCI permit changes.";
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
  <script type="application/ld+json">${structuredData}</script>
  <style>
    :root{color-scheme:light;--primary:#0f172a;--accent:#2563eb;--accent-hover:#1d4ed8;--success:#047857;--warning:#b45309;--bg:#fff;--bg-alt:#f8fafc;--panel:#fff;--text:#1e293b;--muted:#64748b;--border:#cbd5e1;--soft:#e2e8f0;--focus:#1d4ed8;--max:1200px}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.55}a{color:inherit}a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:3px}button,input{font:inherit}.container{width:min(var(--max),calc(100% - 32px));margin:0 auto}.site-header{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.96);border-bottom:1px solid var(--soft);backdrop-filter:blur(12px)}.header-inner{min-height:64px;display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:inline-flex;align-items:center;gap:10px;text-decoration:none;font-weight:800;color:#0f172a}.brand-mark{display:grid;place-items:center;width:34px;height:34px;border-radius:8px;background:#0f172a;color:#fff;font-size:16px}.nav{display:flex;align-items:center;gap:22px;font-size:14px;font-weight:700}.nav-toggle{display:none;position:relative}.nav-toggle>summary{list-style:none;cursor:pointer;font-size:20px;line-height:1;padding:9px 12px;border:1px solid var(--border);border-radius:9px;color:#0f172a;background:var(--panel)}.nav-toggle>summary::-webkit-details-marker{display:none}.nav-toggle[open]>summary{background:var(--bg-alt)}.mobile-nav{position:absolute;right:0;top:calc(100% + 8px);display:flex;flex-direction:column;gap:2px;min-width:210px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:8px;box-shadow:0 12px 32px rgba(15,23,42,.14);z-index:40}.mobile-nav a{text-decoration:none;color:#0f172a;font-weight:700;font-size:14px;padding:11px 12px;border-radius:8px}.mobile-nav a:hover{background:var(--bg-alt)}.nav a{text-decoration:none;color:#334155}.nav a:hover{text-decoration:underline;text-underline-offset:4px}.hero{padding:54px 0 36px;border-bottom:1px solid var(--soft)}.eyebrow,.section-kicker{margin:0 0 10px;color:#1d4ed8;font-size:12px;line-height:1.2;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero h1{max-width:850px;margin:0;color:var(--primary);font-size:clamp(2.2rem,8vw,4.9rem);line-height:.98;letter-spacing:-.045em}.hero-copy{max-width:710px;margin:20px 0 0;font-size:clamp(1rem,2.5vw,1.18rem);color:#475569}.search-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;max-width:820px;margin-top:28px}.search-form label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.search-form input{min-height:52px;width:100%;border:1px solid #94a3b8;border-radius:9px;padding:0 16px;background:#fff;color:#0f172a}.search-form button{min-height:52px;border:0;border-radius:9px;padding:0 24px;background:var(--accent);color:#fff;font-weight:800;cursor:pointer}.search-form button:hover{background:var(--accent-hover)}.hero-subactions{display:flex;flex-wrap:wrap;gap:16px;margin-top:14px;font-size:14px;font-weight:750}.hero-subactions a{text-underline-offset:4px}.metric-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:30px;max-width:820px}.metric{border-top:3px solid #0f172a;padding:12px 4px 0;text-decoration:none;color:inherit}.metric:hover strong{color:var(--accent)}.metric strong{display:block;color:var(--primary);font-size:clamp(1.25rem,5vw,1.85rem);line-height:1.05;letter-spacing:-.025em}.metric span{display:block;margin-top:5px;color:#475569;font-size:12px;line-height:1.35}.freshness{max-width:820px;margin:18px 0 0;color:#475569;font-size:13px}.freshness a{font-weight:750;text-underline-offset:3px}.section{padding:52px 0;border-bottom:1px solid var(--soft)}.section.alt{background:var(--bg-alt)}.section-head{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:22px}.section h2{margin:0;color:var(--primary);font-size:clamp(1.75rem,5vw,2.6rem);line-height:1.05;letter-spacing:-.035em}.section-deck{max-width:680px;margin:8px 0 0;color:#475569}.text-link{font-weight:800;color:#1d4ed8;text-underline-offset:4px;white-space:nowrap}.changes{border-top:1px solid var(--border)}.change-row{display:grid;grid-template-columns:150px minmax(0,1fr) auto;gap:16px;align-items:center;padding:17px 2px;border-bottom:1px solid var(--border);text-decoration:none}.change-row:hover .change-title{text-decoration:underline;text-underline-offset:4px}.transition{font-size:12px;font-weight:850;letter-spacing:.04em;color:#0f172a}.change-title{font-weight:800;color:#0f172a}.change-meta{font-size:13px;color:#475569;text-align:right}.empty-state{border:1px dashed #94a3b8;border-radius:10px;padding:18px;color:#475569;background:var(--bg-alt)}.empty-state.compact{font-size:14px}.market-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.market-card{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}.market-card header{padding:18px 18px 14px;border-bottom:1px solid var(--soft)}.market-card h3{margin:0;color:#0f172a;font-size:16px}.market-card p{margin:5px 0 0;color:#475569;font-size:12px}.rank-row{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:10px;align-items:center;padding:13px 16px;border-bottom:1px solid var(--soft);text-decoration:none}.rank-row:last-child{border-bottom:0}.rank-row:hover strong{text-decoration:underline;text-underline-offset:3px}.rank-index{color:#64748b;font-size:12px;font-weight:800}.rank-copy{min-width:0}.rank-copy strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#0f172a;font-size:13px}.rank-copy small,.rank-value small{display:block;color:#64748b;font-size:11px;font-weight:600}.rank-value{text-align:right;color:#0f172a;font-size:12px;font-weight:800}.tasks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-top:1px solid var(--border);border-left:1px solid var(--border)}.task{min-height:146px;padding:22px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);text-decoration:none;background:var(--panel)}.task:hover{background:var(--bg-alt)}.task strong{display:flex;justify-content:space-between;gap:16px;color:#0f172a;font-size:18px}.task p{max-width:48ch;margin:9px 0 0;color:#475569;font-size:14px}.trust{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(260px,.6fr);gap:28px;align-items:start}.trust-copy{font-size:16px}.trust-copy p{max-width:70ch}.trust-note{border-left:4px solid #0f172a;padding:4px 0 4px 18px;color:#475569}.trust-meta{border:1px solid var(--border);border-radius:12px;padding:20px;background:var(--panel)}.trust-meta dl{margin:0}.trust-meta div+div{border-top:1px solid var(--soft);margin-top:12px;padding-top:12px}.trust-meta dt{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#64748b}.trust-meta dd{margin:4px 0 0;font-weight:750;color:#0f172a}.faq{border-top:1px solid var(--border)}details{border-bottom:1px solid var(--border)}summary{list-style:none;cursor:pointer;padding:18px 2px;font-weight:800;color:#0f172a}summary::-webkit-details-marker{display:none}summary::after{content:"+";float:right;color:#475569}details[open] summary::after{content:"−"}.answer{max-width:760px;padding:0 36px 20px 2px;color:#475569}.alert-panel{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:center;padding:28px;border-radius:14px;background:#0f172a;color:#fff}.alert-panel h2{color:#fff}.alert-panel p{max-width:680px;margin:9px 0 0;color:#cbd5e1}.alert-button{display:inline-flex;min-height:48px;align-items:center;justify-content:center;padding:0 20px;border-radius:8px;background:#fff;color:#0f172a;font-weight:850;text-decoration:none;white-space:nowrap}.site-footer{padding:30px 0 42px}.footer-inner{display:flex;justify-content:space-between;gap:24px;align-items:start}.footer-brand{font-weight:850;color:#0f172a}.footer-nav{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:12px 18px;font-size:13px}.footer-nav a{color:#475569;text-underline-offset:3px}
    @media(max-width:780px){.nav{display:none}.nav-toggle{display:block}.hero{padding-top:40px}.search-form{grid-template-columns:1fr}.search-form button{width:100%}.section{padding:44px 0}.section-head{display:block}.section-head .text-link{display:inline-block;margin-top:12px}.change-row{grid-template-columns:1fr;gap:5px;padding:16px 2px}.change-meta{text-align:left}.market-grid{grid-template-columns:1fr}.tasks{grid-template-columns:1fr}.trust{grid-template-columns:1fr}.alert-panel{grid-template-columns:1fr}.alert-button{width:100%}.footer-inner{display:block}.footer-nav{justify-content:flex-start;margin-top:16px}.task{min-height:auto}.rank-copy strong{white-space:normal}}
    @media(max-width:360px){.container{width:min(var(--max),calc(100% - 24px))}.metric-strip{gap:6px}.metric strong{font-size:1.16rem}.metric span{font-size:11px}.hero h1{font-size:2.05rem}}
    @media(prefers-color-scheme:dark){:root{color-scheme:dark;--primary:#f8fafc;--bg:#0f172a;--bg-alt:#111c30;--panel:#172033;--text:#e2e8f0;--muted:#94a3b8;--border:#475569;--soft:#334155;--focus:#93c5fd}.site-header{background:rgba(15,23,42,.96)}.brand,.nav a,.hero h1,.metric strong,.section h2,.change-title,.transition,.market-card h3,.rank-copy strong,.rank-value,.task strong,.trust-meta dd,summary,.footer-brand{color:#f8fafc}.brand-mark{background:#f8fafc;color:#0f172a}.hero-copy,.freshness,.section-deck,.change-meta,.market-card p,.rank-index,.rank-copy small,.rank-value small,.task p,.trust-note,.answer,.footer-nav a{color:#cbd5e1}.search-form input{background:#172033;color:#f8fafc;border-color:#64748b}.metric{border-top-color:#f8fafc}.trust-note{border-left-color:#f8fafc}.alert-panel{background:#020617}.alert-button{background:#f8fafc;color:#0f172a}.nav-toggle>summary{color:#f8fafc;background:#172033;border-color:#475569}.mobile-nav{background:#172033;border-color:#475569}.mobile-nav a{color:#f8fafc}.mobile-nav a:hover{background:#111c30}}
    @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
  </style>
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/" aria-label="Building Seattle home"><span class="brand-mark" aria-hidden="true">B</span><span>Building Seattle</span></a>
      <nav class="nav" aria-label="Primary navigation">
        <a href="/permits">Permits</a><a href="/contractors">Contractors</a><a href="/neighborhoods">Neighborhoods</a><a href="/insights">Insights</a><a href="/data">Data</a>
      </nav>
      <details class="nav-toggle">
        <summary aria-label="Open navigation menu">&#9776;</summary>
        <nav class="mobile-nav" aria-label="Mobile navigation">
          <a href="/permits">Permits</a><a href="/contractors">Contractors</a><a href="/neighborhoods">Neighborhoods</a><a href="/insights">Insights</a><a href="/data">Data</a><a href="/api-docs">API</a>
        </nav>
      </details>
    </div>
  </header>
  <main>
    <section class="hero">
      <div class="container">
        <p class="eyebrow">Seattle SDCI permit data</p>
        <h1>Seattle construction permits, projects &amp; contractor activity</h1>
        <p class="hero-copy">Search current Seattle permit records by address, permit number, contractor, neighborhood, or project description.</p>
        <form class="search-form" action="/permits" method="get" role="search">
          <label for="home-search">Search Seattle construction permits</label>
          <input id="home-search" name="q" type="search" autocomplete="off" placeholder="Address, permit #, contractor, neighborhood…">
          <button type="submit">Search</button>
        </form>
        <div class="hero-subactions"><a href="/permits">Browse all permits →</a><a href="/projects">Explore projects →</a></div>
        <div class="metric-strip" aria-label="Current database metrics">
          <a class="metric" href="/permits?status=active"><strong>${escapeHtml(stats.active_permits.toLocaleString("en-US"))}</strong><span>active permits</span></a>
          <a class="metric" href="/contractors"><strong>${escapeHtml(stats.contractors.toLocaleString("en-US"))}</strong><span>contractors linked to permits</span></a>
          <a class="metric" href="/permits"><strong>${escapeHtml(compactMoney(stats.total_value))}</strong><span>declared permit value</span></a>
        </div>
        <p class="freshness">Seattle SDCI Open Data · Scheduled daily ingest · Last successful ingest <strong>${escapeHtml(ingestLabel)}</strong> · Latest permit event <strong>${escapeHtml(recordLabel)}</strong> · <a href="/methodology">Methodology</a></p>
      </div>
    </section>

    <section class="section" aria-labelledby="changes-heading">
      <div class="container">
        <div class="section-head"><div><p class="section-kicker">Current signal</p><h2 id="changes-heading">What changed</h2><p class="section-deck">Recent status transitions recorded in the Building Seattle permit history.</p></div><a class="text-link" href="/permits">Browse permits →</a></div>
        <div class="changes">${renderChanges(changes)}</div>
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
        <aside class="trust-meta" aria-label="Data freshness"><dl><div><dt>Source</dt><dd>Seattle SDCI Open Data</dd></div><div><dt>Ingest cadence</dt><dd>Scheduled daily</dd></div><div><dt>Last successful ingest</dt><dd>${escapeHtml(ingestLabel)}</dd></div><div><dt>Latest permit event</dt><dd>${escapeHtml(recordLabel)}</dd></div></dl></aside>
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

    <section class="section alt" aria-labelledby="alerts-heading"><div class="container"><div class="alert-panel"><div><p class="section-kicker" style="color:#93c5fd">Permit alerts</p><h2 id="alerts-heading">Get the changes that matter</h2><p>Choose a permit and subscribe to its status changes. Building Seattle already supports free per-permit alerts with confirmation and one-click unsubscribe.</p></div><a class="alert-button" href="/permits">Find a permit to watch</a></div></div></section>
  </main>
  <footer class="site-footer"><div class="container footer-inner"><div><div class="footer-brand">Building Seattle</div><div style="margin-top:4px;color:#64748b;font-size:12px">Seattle construction intelligence</div></div><nav class="footer-nav" aria-label="Footer navigation"><a href="/permits">Permits</a><a href="/contractors">Contractors</a><a href="/neighborhoods">Neighborhoods</a><a href="/projects">Projects</a><a href="/addresses">Addresses</a><a href="/insights">Insights</a><a href="/data">Dataset</a><a href="/methodology">Methodology</a><a href="/api-docs">API</a><a href="https://buildingseattle.gumroad.com/l/seattle-permits?utm_source=buildingseattle&utm_medium=site&utm_campaign=footer" rel="noopener">Buy the dataset</a></nav></div></footer>
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
    `- ${compactMoney(stats.total_value)} declared permit value`,
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

function responseWithHeaders(body, contentType, extra = {}) {
  const headers = new Headers({ "Content-Type": contentType, "Cache-Control": CACHE_CONTROL, ...SECURITY_HEADERS, ...extra });
  return new Response(body, { status: 200, headers });
}

function jsonResponse(payload) {
  return responseWithHeaders(JSON.stringify(payload), "application/json; charset=utf-8", {
    "Access-Control-Allow-Origin": "*",
  });
}

function wantsMarkdown(request) {
  const accept = request.headers.get("Accept") || "";
  return accept.includes("text/markdown") || accept.includes("application/markdown");
}

async function handleRoot(request, env) {
  const snapshot = await buildHomeSnapshot(env);
  if (wantsMarkdown(request)) return responseWithHeaders(renderHomeMarkdown(snapshot), "text/markdown; charset=utf-8");
  return responseWithHeaders(renderHomepage(snapshot), "text/html; charset=utf-8");
}

async function handleStats(env) {
  const stats = await getCanonicalStats(env);
  const avgValue = await dbFirst(env, `/* api:mean-permit-value */ SELECT AVG(value) AS avg_value FROM permits`);
  return jsonResponse({
    permits: stats.permits,
    contractors: stats.contractors,
    active_contractors: stats.active_contractors,
    active_permits: stats.active_permits,
    total_value: stats.total_value,
    avg_value: Number(avgValue?.avg_value) || 0,
    latest_record_date: stats.latest_record_date,
    last_ingest_at: stats.last_ingest_at,
    timestamp: new Date().toISOString(),
  });
}

async function handleContractors(env) {
  return jsonResponse(await getActiveContractors(env));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname === "www.buildingseattle.com") return baseWorker.fetch(request, env, ctx);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) return handleRoot(request, env);
    if (request.method === "GET" && url.pathname === "/api/stats") return handleStats(env);
    if (request.method === "GET" && url.pathname === "/api/contractors") return handleContractors(env);
    return baseWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (typeof baseWorker.scheduled === "function") return baseWorker.scheduled.call(baseWorker, controller, env, ctx);
  },
};
