import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://buildingseattle.com";
const MAX_CHILD_SITEMAPS = 20;
const MAX_SAMPLE_PAGES = 30;
const MAX_LINK_CHECKS = 30;
const ENTITY_HUB_PATHS = ["/contractors", "/neighborhoods", "/projects", "/addresses"];
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

export function expectedSchemaType(pathname) {
  if (pathname === "/") return "WebSite";
  if (ENTITY_HUB_PATHS.includes(pathname) || pathname === "/insights") return "CollectionPage";
  if (pathname.startsWith("/permits/")) return "Report";
  if (pathname.startsWith("/contractor/")) return "LocalBusiness";
  if (pathname.startsWith("/address/")) return "Place";
  if (pathname.startsWith("/project/")) return "CreativeWork";
  if (pathname === "/methodology") return "AboutPage";
  return null;
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

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "BuildingSeattle-SEO-Monitor/1.0" },
    redirect: "follow",
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

export async function runSeoHealthCheck(baseUrl = DEFAULT_BASE_URL) {
  const base = new URL(baseUrl);
  const checks = [];
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
    if (locations[0]) discoveredPages.add(locations[0]);
  }

  const samplePages = [...discoveredPages].slice(0, MAX_SAMPLE_PAGES);
  const internalLinks = new Set();
  for (const pageUrl of samplePages) {
    const page = await fetchText(pageUrl);
    const meta = htmlMetadata(page.text);
    checks.push(result("page-status", pageUrl, page.response.status === 200, `HTTP ${page.response.status}`));
    checks.push(result("page-title", pageUrl, Boolean(meta.title), meta.title || "Missing title"));
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
    const requiredType = expectedSchemaType(new URL(pageUrl).pathname);
    if (requiredType) {
      const types = schemaTypes(meta.jsonLd);
      checks.push(result("page-schema-type", pageUrl, types.includes(requiredType), types.length ? `Found ${types.join(", ")}; expected ${requiredType}` : `Missing ${requiredType}`));
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
      redirect: "follow",
    });
    checks.push(result("internal-link", linkUrl, response.status < 400, `HTTP ${response.status}`));
  }


  const internalLinkChecks = checks.filter((check) => check.check === "internal-link");
  const brokenLinks = internalLinkChecks.filter((check) => !check.ok);
  const brokenRate = internalLinkChecks.length ? brokenLinks.length / internalLinkChecks.length : 0;
  checks.push(result("internal-link-404-rate", base.href, brokenRate <= 0.05, `${brokenLinks.length}/${internalLinkChecks.length} broken (${(brokenRate * 100).toFixed(1)}%)`));

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
    limits: {
      child_sitemaps: MAX_CHILD_SITEMAPS,
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
    report = await runSeoHealthCheck(baseUrl);
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
