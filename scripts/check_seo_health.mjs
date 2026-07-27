import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://buildingseattle.com";
const MAX_CHILD_SITEMAPS = 20;
const MAX_SAMPLE_PAGES = 30;
const MAX_LINK_CHECKS = 30;

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

export async function runSeoHealthCheck(baseUrl = DEFAULT_BASE_URL) {
  const base = new URL(baseUrl);
  const checks = [];
  const discoveredPages = new Set([
    new URL("/", base).href,
    new URL("/contractors", base).href,
    new URL("/neighborhoods", base).href,
    new URL("/projects", base).href,
    new URL("/addresses", base).href,
    new URL("/insights", base).href,
    new URL("/methodology", base).href,
  ]);

  const sitemapUrl = new URL("/sitemap.xml", base).href;
  const sitemap = await fetchText(sitemapUrl);
  checks.push(result("sitemap-index-status", sitemapUrl, sitemap.response.status === 200, `HTTP ${sitemap.response.status}`));
  checks.push(result("sitemap-index-xml", sitemapUrl, /<sitemapindex\b/.test(sitemap.text), "Expected sitemapindex root"));

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
    checks.push(result("page-robots", pageUrl, Boolean(meta.robots), meta.robots || "Missing robots directive"));
    let structuredDataValid = meta.jsonLd.length > 0;
    for (const json of meta.jsonLd) {
      try {
        JSON.parse(json);
      } catch {
        structuredDataValid = false;
      }
    }
    checks.push(result("page-jsonld", pageUrl, structuredDataValid, `${meta.jsonLd.length} JSON-LD blocks`));
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

  for (const path of ["/contractors?sort=value", "/projects?view=recent", "/addresses?min_permits=5"]) {
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
  const report = await runSeoHealthCheck(baseUrl);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`SEO health: ${report.summary.passed}/${report.summary.checks} checks passed`);
  for (const failure of report.failures) {
    console.error(`FAIL ${failure.check}: ${failure.url} — ${failure.detail}`);
  }
  if (report.summary.failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}
