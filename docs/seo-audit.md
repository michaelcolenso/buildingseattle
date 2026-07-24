# Building Seattle SEO Audit

Audit date: 2026-07-24

## Executive summary

Building Seattle has a strong SEO foundation for a data-heavy local search product: pages are server-rendered, crawlable routes include canonical tags, dynamic entity pages expose structured data, and XML sitemaps cover large permit/address/project/contractor/neighborhood inventories. The biggest opportunities are to reduce duplicate/thin indexed URLs, normalize production sitemap hosts, improve image/social metadata consistency, and add stronger internal-linking hubs for high-intent local searches.

## What is working well

- **Server-rendered HTML:** The Worker returns complete HTML for the homepage, permit browser, permit detail pages, entity pages, insights pages, about, and data pages, so core content does not depend on client-side rendering.
- **Canonical tags:** Primary pages define canonical URLs, including the homepage, permit browser, permit detail pages, contractor/entity pages, insight pages, data page, and 404 page.
- **Robots and XML sitemaps:** `/robots.txt` advertises `/sitemap.xml`, while `/sitemap.xml` builds a sitemap index that fans out to static and dynamic child sitemaps.
- **Structured data:** The homepage includes Organization, WebSite/SearchAction, FAQPage, and BreadcrumbList JSON-LD. Entity and insight templates also support JSON-LD.
- **Security and trust headers:** HSTS, content sniffing protection, referrer policy, permissions policy, CSP, API catalog links, and sitemap link headers are applied consistently through `withSecurityHeaders`.
- **Index control for non-public pages:** Admin and alert result pages use `noindex,nofollow`, while 404 responses use `noindex` and HTTP 404 status.

## Priority findings and recommendations

### P0 — Fix sitemap host canonicalization risk

`renderSitemapXml` and `renderChildSitemapXml` build `<loc>` URLs from `new URL(request.url).origin`. If Cloudflare preview domains, staging domains, or `www.buildingseattle.com` hit these routes before redirect handling or via alternate hostnames, sitemap URLs can advertise a non-canonical host. Use the `BASE_URL` constant for sitemap URLs instead of request origin.

**Why it matters:** Search engines should see a single canonical sitemap host. Mixed hosts can dilute crawl signals and create avoidable duplicate URL discovery.

**Recommended change:** Replace `const origin = new URL(request.url).origin;` with `const origin = BASE_URL;` in both sitemap render functions.

### P0 — Decide whether AI training signals belong in robots.txt

`robots.txt` includes `Content-Signal: search=yes, ai-train=yes, ai-input=yes`. This explicitly permits AI training and AI input use. If that is intentional, document it. If not, change those directives to match policy.

**Why it matters:** This is a brand and data-licensing decision, not just technical SEO. It can affect how third-party AI systems interpret use of the site content.

### P1 — Add Open Graph dimensions and Twitter image metadata consistently

The homepage, permit browser, permit detail, and legacy contractor page include `og:image`, dimensions, and `twitter:image`. The generic entity document template currently includes only `og:image` and `twitter:card`. Add `og:image:width`, `og:image:height`, and `twitter:image` to `renderEntityDoc` so address, project, neighborhood, insight, and org contractor pages produce complete social preview metadata.

**Why it matters:** Complete preview metadata improves sharing consistency and can influence click-through from social/referral surfaces.

### P1 — Avoid indexing empty data-driven insight pages when partial data exists

Insight pages are passed `noindex: !hasData`, which is good. Confirm that `hasData` is strict enough for every insight page and that fallback copy is not accidentally indexed when only placeholder aggregate rows exist.

**Why it matters:** Thin indexed pages can lower site quality signals, especially if many dynamically generated pages have little unique content.

### P1 — Add indexable hub pages for entity types

The site has many dynamic entity routes (`/address/`, `/project/`, `/contractor/`, `/neighborhood/`) and sitemap coverage, but the primary nav links only to Home, Browse Permits, Insights, Data, and API. Add crawlable hub pages such as:

- `/contractors` — top contractors, specialties, license links, active neighborhoods.
- `/neighborhoods` — neighborhood index with counts, value, active projects, and housing units.
- `/projects` — recent and high-value clustered projects.
- `/addresses` — high-activity properties.

**Why it matters:** Hubs improve crawl paths, distribute PageRank to long-tail pages, and target high-intent queries like “Seattle contractors by permit activity” or “Capitol Hill construction permits.”

### P1 — Add `robots` metadata to all indexable templates explicitly

Some pages include `<meta name="robots" content="index,follow">` or `index,follow,max-image-preview:large`; entity docs omit an explicit positive robots tag unless noindexed. Add `index,follow,max-image-preview:large` to indexable templates for consistency.

**Why it matters:** This is not required for indexing, but it standardizes image preview eligibility and reduces template drift.

### P2 — Improve title and meta-description length guards

Dynamic permit descriptions concatenate address, type, neighborhood, value, status, description, and contractor. This may exceed ideal snippet length for verbose permits. Add a small meta-description truncation helper that preserves whole words around 155–170 characters.

**Why it matters:** Search engines rewrite snippets often, but concise descriptions improve SERP quality and reduce duplicate-looking snippets.

### P2 — Add structured data for permit detail pages beyond breadcrumbs

Permit detail pages currently expose BreadcrumbList JSON-LD. Consider adding `Dataset`, `CreativeWork`, or `Report` structured data with permit number, location/address, date issued/applied, status, and source attribution. Validate with Google Rich Results Test and Schema.org validator.

**Why it matters:** Permit pages are the site’s long-tail SEO engine. More specific structured data can improve machine understanding even if no rich result is guaranteed.

### P2 — Strengthen local topical content

Add editorial or semi-automated landing content for high-value local themes:

- “Seattle permit review timelines by neighborhood”
- “Seattle ADU and DADU permit tracker”
- “Seattle multifamily construction pipeline”
- “Seattle tenant improvement permits”
- “Seattle high-value commercial construction projects”

**Why it matters:** The dataset gives Building Seattle proprietary topical authority, but many commercial searches need explanatory landing pages, not only raw records.

### P2 — Add image alt/fallback strategy for OG and favicon

`/og-image.png` and `/favicon.ico` are served by the same generated PNG response. Consider adding distinct favicon sizes and a static-looking `site.webmanifest`, even if still served by the Worker.

**Why it matters:** This improves browser/search presentation and avoids edge cases where a PNG returned at `/favicon.ico` is not interpreted as expected.

### P3 — Add `lastmod` QA tests for sitemap output

Sitemap generation is query-heavy and includes multiple source tables. Add tests that verify:

- `/sitemap.xml` returns a sitemap index.
- Static sitemap includes all `SITEMAP_STATIC_PATHS`.
- Child sitemap URLs use `BASE_URL`.
- Empty sections do not create invalid page links.
- URL counts stay under 50,000 per child sitemap.

**Why it matters:** Sitemap regressions can silently reduce discoverability across thousands of URLs.

## Technical SEO checklist

| Area | Status | Notes |
| --- | --- | --- |
| Crawlability | Good | Public HTML routes are server-rendered and robots allows normal crawling. |
| Canonicals | Good with caveat | Canonicals use `BASE_URL`, but sitemap locs should also force `BASE_URL`. |
| XML sitemaps | Good | Index plus child sitemaps support large URL inventory; add tests and canonical host fix. |
| Robots.txt | Needs policy review | Technical directives are sensible, but AI-use signals require business approval. |
| Metadata | Good | Core templates include titles/descriptions; generic entity template needs complete social/image metadata. |
| Structured data | Good foundation | Homepage and entity docs include JSON-LD; permit details can be enriched. |
| Internal links | Needs improvement | Add entity hubs and more cross-links among permits, contractors, addresses, neighborhoods, and projects. |
| Duplicate content | Moderate risk | Dynamic pages must avoid indexing empty/thin records and query-parameter variants. |
| Performance | Likely good | Worker SSR is lightweight, but inline CSS and large embedded assets should be monitored. |
| Local SEO | Opportunity | Add Seattle neighborhood/theme landing pages and stronger source/about trust copy. |

## Suggested implementation roadmap

1. **Immediate technical fixes:** force sitemap `loc` values to `BASE_URL`, complete entity social metadata, and standardize robots meta tags.
2. **Quality controls:** add sitemap and metadata unit tests; add meta-description truncation for dynamic pages.
3. **Information architecture:** launch `/contractors`, `/neighborhoods`, `/projects`, and `/addresses` hub pages.
4. **Content expansion:** publish local insight landing pages powered by permit data.
5. **Validation:** run `node --check worker.js`, `npm test`, Google Search Console sitemap inspection, Rich Results Test, and a crawler pass with Screaming Frog/Sitebulb.
