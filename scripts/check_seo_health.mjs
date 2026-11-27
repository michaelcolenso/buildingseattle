import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://buildingseattle.com";
const MAX_CHILD_SITEMAPS = 20;
const MAX_SAMPLE_PAGES = 80;
// URLs drawn at random from every child sitemap per run. The draw is seeded
// by the UTC date (or SEO_SAMPLE_SEED), so a failing run can be replayed and
// successive days cover different URLs.
const SAMPLE_PER_SITEMAP = 3;
// Entity templates whose sitemapped URLs must never answer 200 noindex: that is
// the signature of a failed lookup cached as a page (audit D1).
const ENTITY_PATH_PREFIXES = ["/address/", "/project/", "/neighborhood/", "/contractor/", "/permits/"];
const MAX_LINK_CHECKS = 30;
const ENTITY_HUB_PATHS = ["/contractors", "/neighborhoods", "/projects", "/addresses"];
// Public pages the homepage must link to, so no important page is orphaned
// (reachable only from the sitemap). "/about" regressed this way once.
const REQUIRED_HOME_LINKS = [
  "/about",
  "/permits",
  "/contractors",
  "/neighborhoods",
  "/projects",
  "/addresses",
  "/insights",
  "/data",
  "/methodology",
  "/api-docs",
];
// Path probed to prove the shared not-found template stays a real 404.
const NOT_FOUND_PROBE_PATH = "/seo-monitor-404-probe";
const FILTER_POLICY_PATHS = [
  "/contractors?activity=active", "/contractors?permit_type=construction", "/contractors?min_value=1000000",
  "/contractors?neighborhood=capitol-hill", "/projects?view=recent", "/projects?view=active",
  "/addresses?min_permits=5", "/addresses?activity=recent90", "/addresses?activity=recent365",
  "/addresses?min_value=1000000",
  "/neighborhoods?activity=recent",
];
// [path, expected width, expected height] for every binary image route worker.js serves.
const IMAGE_ASSETS = [
  ["/og-image.png", 1200, 630],
  ["/social/permit.png", 1200, 630],
  ["/social/contractor.png", 1200, 630],
  ["/social/project.png", 1200, 630],
  ["/social/address.png", 1200, 630],
  ["/social/neighborhood.png", 1200, 630],
  ["/social/insight.png", 1200, 630],
  ["/icons/icon-32.png", 32, 32],
  ["/icons/icon-192.png", 192, 192],
  ["/icons/icon-512.png", 512, 512],
];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function pngDimensions(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (data.length < 24) return null;
  if (PNG_SIGNATURE.some((byte, index) => data[index] !== byte)) return null;
  // Bytes 12-15 are the chunk type; the first chunk of a valid PNG must be IHDR.
  if (String.fromCharCode(data[12], data[13], data[14], data[15]) !== "IHDR") return null;
  const readUint32 = (offset) =>
    ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
  const width = readUint32(16);
  const height = readUint32(20);
  if (!width || !height) return null;
  return { width, height };
}

// <url> entries with their <lastmod>, for the stability check.
export function xmlEntries(xml) {
  return [...String(xml).matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => ({
    loc: match[1].match(/<loc>([^<]+)<\/loc>/)?.[1]?.replaceAll("&amp;", "&").trim() || null,
    lastmod: match[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim() || null,
  })).filter((entry) => entry.loc);
}

// URLs whose <lastmod> differs between two fetches of the same sitemap. A
// lastmod that moves without a content change teaches crawlers to ignore it.
export function unstableLastmods(firstXml, secondXml) {
  const before = new Map(xmlEntries(firstXml).map((entry) => [entry.loc, entry.lastmod]));
  return xmlEntries(secondXml)
    .filter((entry) => before.has(entry.loc) && before.get(entry.loc) !== entry.lastmod)
    .map((entry) => entry.loc);
}

function hashSeed(seed) {
  let hash = 2166136261;
  for (const char of String(seed)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

// Deterministic sample of `count` distinct items for a given seed (mulberry32
// driving a partial Fisher-Yates shuffle); the input array is not modified.
export function seededSample(items, count, seed) {
  const pool = [...items];
  let state = hashSeed(seed);
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const take = Math.min(Math.max(0, count), pool.length);
  for (let index = 0; index < take; index += 1) {
    const pick = index + Math.floor(next() * (pool.length - index));
    [pool[index], pool[pick]] = [pool[pick], pool[index]];
  }
  return pool.slice(0, take);
}

export function isEntityPath(pathname) {
  return ENTITY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// robots.txt must advertise the sitemap and must not block the whole site.
export function robotsTxtProblems(text, baseUrl) {
  const problems = [];
  const lines = String(text).split(/\r?\n/).map((line) => line.trim());
  const sitemapLine = `sitemap: ${new URL("/sitemap.xml", baseUrl).href}`.toLowerCase();
  if (!lines.some((line) => line.toLowerCase() === sitemapLine)) problems.push("Missing Sitemap line");
  if (lines.some((line) => /^disallow:\s*\/\s*$/i.test(line))) problems.push("Disallow: / blocks the site");
  return problems;
}

export function xmlLocations(xml) {
  return [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) =>
    match[1].replaceAll("&amp;", "&").trim(),
  );
}

export function htmlMetadata(html) {
  const source = String(html);
  const content = (name, value) => {
    const patterns = [
      new RegExp(`<${name}[^>]+${value}=["']([^"']+)["'][^>]*>`, "i"),
      new RegExp(`<${name}[^>]+content=["']([^"']+)["'][^>]+${value}=["'][^"']+["'][^>]*>`, "i"),
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match) return match[1];
    }
    return null;
  };
  const canonical = source.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i)
    || source.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i);
  const title = source.match(/<title>([^<]+)<\/title>/i);
  const jsonLd = [...source.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1].trim());
  return {
    title: title?.[1]?.trim() || null,
    description: content("meta", "name=[\"']description") || source.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] || null,
    robots: source.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i)?.[1] || null,
    canonical: canonical?.[1] || null,
    jsonLd,
    links: [...source.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)].map((match) => match[1]),
  };
}

export function entityHubItemCount(jsonLdBlocks) {
  for (const block of jsonLdBlocks) {
    try {
      const value = JSON.parse(block);
      const nodes = Array.isArray(value?.["@graph"]) ? value["@graph"] : [value];
      const itemList = nodes.find((node) => node?.["@type"] === "ItemList");
      if (itemList && Number.isFinite(Number(itemList.numberOfItems))) return Number(itemList.numberOfItems);
    } catch {
      // Invalid JSON-LD is reported separately by the page metadata check.
    }
  }
  return null;
}

export function summarizeHistory(entries, report) {
  const previous = entries.at(-1);
  if (!previous) return { previous_generated_at: null, failed_delta: null, checks_delta: null };
  return {
    previous_generated_at: previous.generated_at || null,
    failed_delta: report.summary.failed - Number(previous.summary?.failed || 0),
    checks_delta: report.summary.checks - Number(previous.summary?.checks || 0),
  };
}

export function schemaTypes(jsonLdBlocks) {
  const types = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const type = value["@type"];
    for (const item of Array.isArray(type) ? type : [type]) {
      if (typeof item === "string") types.add(item);
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const block of jsonLdBlocks) {
    try {
      visit(JSON.parse(block));
    } catch {
      // Syntax failures are reported by page-jsonld.
    }
  }
  return [...types];
}

// Contractor URLs serve curated contractors (LocalBusiness) and people/org
// pages (Organization or Person), so that route accepts any of the three.
export function expectedSchemaTypes(pathname) {
  if (pathname.startsWith("/contractor/")) return ["LocalBusiness", "Organization", "Person"];
  const type = expectedSchemaType(pathname);
  return type ? [type] : [];
}

export function expectedSchemaType(pathname) {
  if (pathname === "/") return "WebSite";
  if (ENTITY_HUB_PATHS.includes(pathname) || pathname === "/insights") return "CollectionPage";
  if (pathname.startsWith("/insights/")) return "Dataset";
  if (pathname.startsWith("/permits/")) return "Report";
  if (pathname.startsWith("/contractor/")) return "LocalBusiness";
  if (pathname.startsWith("/address/")) return "Place";
  if (pathname.startsWith("/project/")) return "CreativeWork";
  if (pathname.startsWith("/neighborhood/")) return "CollectionPage";
  if (pathname === "/methodology") return "AboutPage";
  if (pathname === "/about") return "AboutPage";
  if (pathname === "/data") return "Dataset";
  if (pathname === "/api-docs") return "TechArticle";
  return null;
}

// Maximum <title> length per route. Google truncates around 60 characters, so
// dynamic templates must spend their budget on the address/record rather than
// pushing the brand suffix out of the SERP snippet. Permit pages intentionally
// allow a longer title so the brand suffix always survives.
export function titleBudget(pathname) {
  if (pathname === "/") return 62;
  if (pathname.startsWith("/address/")) return 62;
  if (pathname.startsWith("/neighborhood/")) return 70;
  if (pathname.startsWith("/project/")) return 70;
  if (pathname.startsWith("/contractor/")) return 70;
  if (pathname.startsWith("/permits/")) return 92;
  return 70;
}

// <title> text is measured after decoding the entities that inflate raw length
// (e.g. "&amp;"), so a 58-character title is not counted as 62.
export function decodedTitleLength(title) {
  const decoded = String(title || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ");
  return decoded.length;
}

function result(check, url, ok, detail) {
  return { check, url, ok, detail };
}

function sameCanonicalHost(url, baseUrl) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

// Redirects are never followed: a sitemapped or linked URL that 301s is a
// finding, not something to look through.
async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "BuildingSeattle-SEO-Monitor/1.0" },
    redirect: "manual",
  });
  return { response, text: await response.text() };
}

async function fetchAsset(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "BuildingSeattle-SEO-Monitor/1.0" },
    redirect: "follow",
  });
  return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}

export async function runSeoHealthCheck(baseUrl = DEFAULT_BASE_URL, { seed = new Date().toISOString().slice(0, 10) } = {}) {
  const base = new URL(baseUrl);
  const checks = [];
  // Pages that came from a sitemap: they must answer 200 directly, index.
  const sitemappedPages = new Set();
  const discoveredPages = new Set([
    new URL("/", base).href,
    ...ENTITY_HUB_PATHS.map((path) => new URL(path, base).href),
    new URL("/insights", base).href,
    new URL("/methodology", base).href,
  ]);

  const sitemapUrl = new URL("/sitemap.xml", base).href;
  const sitemap = await fetchText(sitemapUrl);
  checks.push(result("sitemap-index-status", sitemapUrl, sitemap.response.status === 200, `HTTP ${sitemap.response.status}`));
  checks.push(result("sitemap-index-xml", sitemapUrl, /<sitemapindex\b/.test(sitemap.text), "Expected sitemapindex root"));

  const robotsUrl = new URL("/robots.txt", base).href;
  const robots = await fetchText(robotsUrl);
  const robotsProblems = robotsTxtProblems(robots.text, base.href);
  checks.push(result("robots-txt-status", robotsUrl, robots.response.status === 200, `HTTP ${robots.response.status}`));
  checks.push(result("robots-txt-directives", robotsUrl, robotsProblems.length === 0, robotsProblems.join("; ") || "Sitemap advertised; site crawlable"));

  for (const [path, expectedWidth, expectedHeight] of IMAGE_ASSETS) {
    const assetUrl = new URL(path, base).href;
    const asset = await fetchAsset(assetUrl);
    const dimensions = pngDimensions(asset.bytes);
    const contentType = asset.response.headers.get("content-type") || "";
    const cacheControl = asset.response.headers.get("cache-control") || "";
    checks.push(result("image-status", assetUrl, asset.response.status === 200, `HTTP ${asset.response.status}`));
    checks.push(result("image-content-type", assetUrl, /^image\/png\b/i.test(contentType), contentType || "Missing Content-Type"));
    checks.push(result("image-dimensions", assetUrl, dimensions?.width === expectedWidth && dimensions?.height === expectedHeight, dimensions ? `${dimensions.width}x${dimensions.height}` : "Invalid PNG"));
    checks.push(result("image-cache", assetUrl, /(?:max-age=\d+|immutable)/i.test(cacheControl), cacheControl || "Missing Cache-Control"));
  }

  const childSitemaps = xmlLocations(sitemap.text).slice(0, MAX_CHILD_SITEMAPS);
  checks.push(result("sitemap-child-count", sitemapUrl, childSitemaps.length > 0, `${childSitemaps.length} child sitemaps`));
  for (const childUrl of childSitemaps) {
    const validHost = sameCanonicalHost(childUrl, base.href);
    checks.push(result("sitemap-child-host", childUrl, validHost, validHost ? "Canonical host" : "Unexpected host"));
    if (!validHost) continue;
    const child = await fetchText(childUrl);
    const locations = xmlLocations(child.text);
    checks.push(result("sitemap-child-status", childUrl, child.response.status === 200, `HTTP ${child.response.status}`));
    checks.push(result("sitemap-child-xml", childUrl, /<urlset\b/.test(child.text), `${locations.length} URLs`));
    const canonicalUrls = locations.every((location) => sameCanonicalHost(location, base.href));
    checks.push(result("sitemap-url-hosts", childUrl, canonicalUrls, canonicalUrls ? "All canonical" : "Unexpected host found"));
    const again = await fetchText(childUrl);
    const moved = unstableLastmods(child.text, again.text);
    checks.push(result("sitemap-lastmod-stable", childUrl, moved.length === 0, moved.length ? `${moved.length} lastmod values changed between fetches, e.g. ${moved[0]}` : "Stable"));
    for (const location of seededSample(locations, SAMPLE_PER_SITEMAP, `${seed}:${childUrl}`)) {
      if (!sameCanonicalHost(location, base.href)) continue;
      sitemappedPages.add(location);
      discoveredPages.add(location);
    }
  }

  // Sitemap samples first, so the page budget never crowds them out.
  const samplePages = [...new Set([...sitemappedPages, ...discoveredPages])].slice(0, MAX_SAMPLE_PAGES);
  const internalLinks = new Set();
  const homeLinks = new Set();
  for (const pageUrl of samplePages) {
    const page = await fetchText(pageUrl);
    const meta = htmlMetadata(page.text);
    const pathname = new URL(pageUrl).pathname;
    const location = page.response.headers.get("location");
    checks.push(result("page-status", pageUrl, page.response.status === 200, location ? `HTTP ${page.response.status} -> ${location}` : `HTTP ${page.response.status}`));
    if (sitemappedPages.has(pageUrl)) {
      checks.push(result("sitemap-url-direct", pageUrl, page.response.status === 200 && !location, location ? `Redirects to ${location}` : `HTTP ${page.response.status}`));
      if (isEntityPath(pathname)) {
        const softNoindex = page.response.status === 200 && /noindex/i.test(meta.robots || "");
        checks.push(result("sitemap-entity-not-noindex", pageUrl, !softNoindex, meta.robots || "Missing robots directive"));
      }
    }
    checks.push(result("page-title", pageUrl, Boolean(meta.title), meta.title || "Missing title"));
    const budget = titleBudget(pathname);
    if (meta.title && budget) {
      const titleLength = decodedTitleLength(meta.title);
      checks.push(result("page-title-length", pageUrl, titleLength <= budget, `${titleLength} chars (budget ${budget}): ${meta.title}`));
    }
    checks.push(result("page-description", pageUrl, Boolean(meta.description), meta.description || "Missing description"));
    checks.push(result("page-canonical", pageUrl, sameCanonicalHost(meta.canonical, base.href), meta.canonical || "Missing canonical"));
    const expectedCanonical = new URL(new URL(pageUrl).pathname, base).href;
    checks.push(result("page-canonical-self", pageUrl, meta.canonical === expectedCanonical, meta.canonical || "Missing canonical"));
    checks.push(result("page-robots", pageUrl, Boolean(meta.robots), meta.robots || "Missing robots directive"));
    checks.push(result("page-indexable", pageUrl, !/noindex/i.test(meta.robots || ""), meta.robots || "Missing robots directive"));
    let structuredDataValid = meta.jsonLd.length > 0;
    for (const json of meta.jsonLd) {
      try {
        JSON.parse(json);
      } catch {
        structuredDataValid = false;
      }
    }
    checks.push(result("page-jsonld", pageUrl, structuredDataValid, `${meta.jsonLd.length} JSON-LD blocks`));
    const requiredTypes = expectedSchemaTypes(pathname);
    if (requiredTypes.length) {
      const types = schemaTypes(meta.jsonLd);
      const expected = requiredTypes.join(" or ");
      checks.push(result("page-schema-type", pageUrl, requiredTypes.some((type) => types.includes(type)), types.length ? `Found ${types.join(", ")}; expected ${expected}` : `Missing ${expected}`));
    }
    if (pageUrl === new URL("/", base).href) {
      for (const href of meta.links) homeLinks.add(href);
    }
    if (ENTITY_HUB_PATHS.includes(new URL(pageUrl).pathname)) {
      const itemCount = entityHubItemCount(meta.jsonLd);
      checks.push(result("entity-hub-populated", pageUrl, itemCount !== null && itemCount > 0, itemCount === null ? "Missing ItemList count" : `${itemCount} items`));
      checks.push(result("entity-hub-indexable", pageUrl, !/noindex/i.test(meta.robots || ""), meta.robots || "Missing robots directive"));
    }
    for (const href of meta.links) {
      try {
        const link = new URL(href, pageUrl);
        if (link.origin === base.origin && !link.search && internalLinks.size < MAX_LINK_CHECKS) {
          internalLinks.add(link.href);
        }
      } catch {
        // Ignore malformed links here; metadata checks remain actionable.
      }
    }
  }

  for (const linkUrl of internalLinks) {
    const response = await fetch(linkUrl, {
      headers: { "User-Agent": "BuildingSeattle-SEO-Monitor/1.0" },
      redirect: "manual",
    });
    const location = response.headers.get("location");
    checks.push(result("internal-link", linkUrl, response.status < 400, location ? `HTTP ${response.status} -> ${location}` : `HTTP ${response.status}`));
  }


  const internalLinkChecks = checks.filter((check) => check.check === "internal-link");
  const brokenLinks = internalLinkChecks.filter((check) => !check.ok);
  const brokenRate = internalLinkChecks.length ? brokenLinks.length / internalLinkChecks.length : 0;
  checks.push(result("internal-link-404-rate", base.href, brokenRate <= 0.05, `${brokenLinks.length}/${internalLinkChecks.length} broken (${(brokenRate * 100).toFixed(1)}%)`));

  // Orphan guard: every important public page must be reachable from the
  // homepage footer/nav, not just from sitemap.xml.
  for (const path of REQUIRED_HOME_LINKS) {
    const linked = homeLinks.has(path) || homeLinks.has(`${path}/`);
    checks.push(result("homepage-link-coverage", new URL(path, base).href, linked, linked ? "Linked from /" : "Not linked from homepage"));
  }

  // The shared not-found template must stay a real 404 (no soft 404) with a
  // noindex directive and no cross-page canonical.
  const notFoundUrl = new URL(NOT_FOUND_PROBE_PATH, base).href;
  const notFound = await fetchText(notFoundUrl);
  const notFoundMeta = htmlMetadata(notFound.text);
  checks.push(result("notfound-status", notFoundUrl, notFound.response.status === 404, `HTTP ${notFound.response.status}`));
  checks.push(result("notfound-noindex", notFoundUrl, /noindex/i.test(notFoundMeta.robots || ""), notFoundMeta.robots || "Missing robots directive"));
  checks.push(result("notfound-no-canonical", notFoundUrl, !notFoundMeta.canonical, notFoundMeta.canonical || "No canonical (expected)"));

  for (const path of FILTER_POLICY_PATHS) {
    const url = new URL(path, base).href;
    const page = await fetchText(url);
    const meta = htmlMetadata(page.text);
    checks.push(result("filtered-page-noindex", url, /noindex/i.test(meta.robots || ""), meta.robots || "Missing robots directive"));
    checks.push(result("filtered-page-canonical", url, meta.canonical === new URL(path.split("?")[0], base).href, meta.canonical || "Missing canonical"));
  }

  const failures = checks.filter((check) => !check.ok);
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    base_url: base.href,
    sample_seed: seed,
    limits: {
      child_sitemaps: MAX_CHILD_SITEMAPS,
      sample_per_sitemap: SAMPLE_PER_SITEMAP,
      sample_pages: MAX_SAMPLE_PAGES,
      internal_links: MAX_LINK_CHECKS,
    },
    summary: { checks: checks.length, passed: checks.length - failures.length, failed: failures.length },
    failures,
    checks,
  };
}

async function main() {
  const baseUrl = process.argv[2] || process.env.SEO_BASE_URL || DEFAULT_BASE_URL;
  const outputPath = process.env.SEO_REPORT_PATH || "seo-health-report.json";
  let report;
  try {
    report = await runSeoHealthCheck(baseUrl, process.env.SEO_SAMPLE_SEED ? { seed: process.env.SEO_SAMPLE_SEED } : {});
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report = {
      version: 1,
      generated_at: new Date().toISOString(),
      base_url: new URL(baseUrl).href,
      limits: {},
      summary: { checks: 1, passed: 0, failed: 1 },
      failures: [result("monitor-runtime", new URL(baseUrl).href, false, detail)],
      checks: [result("monitor-runtime", new URL(baseUrl).href, false, detail)],
    };
  }
  const historyPath = process.env.SEO_HISTORY_PATH;
  let history = [];
  if (historyPath) {
    try {
      history = (await readFile(historyPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  report.trend = summarizeHistory(history, report);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (historyPath) {
    const historyEntry = { generated_at: report.generated_at, summary: report.summary };
    await appendFile(historyPath, `${JSON.stringify(historyEntry)}\n`, "utf8");
  }
  console.log(`SEO health: ${report.summary.passed}/${report.summary.checks} checks passed`);
  for (const failure of report.failures) {
    console.error(`FAIL ${failure.check}: ${failure.url} — ${failure.detail}`);
  }
  if (report.summary.failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}
