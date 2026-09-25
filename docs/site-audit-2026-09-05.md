# Building Seattle site audit and improvement plan

**Audit date:** 2026-09-05  
**Scope:** production site, Worker templates and routing, public data surfaces, technical SEO, accessibility, performance, and conversion utility  
**Production origin:** `https://buildingseattle.com`

## Executive summary

Building Seattle already has an unusually strong technical foundation for a small civic-data product. It server-renders useful permit and entity pages, exposes crawlable hubs and sitemaps, uses consistent canonical URLs, publishes methodology and API documentation, and compresses its HTML efficiently. The current opportunity is not a cosmetic redesign. It is to turn a broad collection of data views into a faster, measurable research workflow and a more deliberate organic-search architecture.

The highest-priority issue is performance observability and cache verification. Sampled production HTML had a time to first byte (TTFB) of **205–494 ms**, while the responses did not expose `s-maxage`, `CF-Cache-Status`, or an equivalent cache-hit signal. The code contains an edge HTML cache, but production headers did not prove that it is active. Before optimizing markup, the team should instrument real-user Core Web Vitals and make cache status observable.

The highest utility opportunity is a unified search and research workflow. Users can search permits, browse four entity hubs, read ten insight views, consume an API, subscribe to permit alerts, and buy a dataset, but these capabilities are distributed across pages without saved searches, comparison, export, or a clear transition from discovery to monitoring. The highest SEO opportunity is to convert the existing entity graph into stronger internal-link modules and genuinely differentiated neighborhood and project pages, while controlling low-information URLs.

### Recommended outcome for the next 90 days

1. Establish a production performance and conversion baseline.
2. Prove that public HTML is served from cache and reduce D1 work on high-traffic routes.
3. Launch saved searches/alerts and lightweight CSV export as the primary utility loop.
4. Strengthen entity-page uniqueness, related links, and sitemap quality controls.
5. Validate improvements with field Core Web Vitals, Search Console, Bing Webmaster Tools, and task-completion analytics rather than one-off lab scores.

## Method and limitations

This was a code-informed production audit, not a substitute for Search Console, Cloudflare analytics, or a moderated user study.

### Evidence collected

- Inspected the Worker route map, shared templates, page queries, cache wrapper, security headers, metadata, structured data, robots rules, sitemap generation, page-view logging, and automated tests.
- Requested representative production routes: `/`, `/permits`, `/insights`, `/contractors`, `/about`, `/data`, `/api/stats`, `/robots.txt`, and `/sitemap.xml`.
- Recorded HTTP status, HTML transfer size, content type, TTFB, total request time, compression, and response cache headers.
- Parsed representative HTML for heading structure, controls, links, images, scripts, titles, canonicals, descriptions, and robots directives.
- Attempted the repository's production SEO health monitor and Google PageSpeed Insights.

### Constraints

- The PageSpeed Insights API returned `429 RESOURCE_EXHAUSTED`; no Lighthouse scores are claimed in this report.
- Node's production SEO monitor failed at its first network request in this environment (`fetch failed`), although `curl` requests to the same origin succeeded. The failure is an audit-environment warning, not evidence of a production outage.
- No Google Search Console, Bing Webmaster Tools, Cloudflare Web Analytics, D1 query analytics, revenue data, or funnel data was available.
- TTFB figures are a small, single-region sample from the audit environment, not statistically valid field data.
- Visual and keyboard behavior should still be verified in real desktop and mobile browsers. This pass did not claim WCAG conformance.

## Current product and route inventory

### Primary visitor journeys

| Intent | Current entry points | Existing strengths | Main friction |
| --- | --- | --- | --- |
| Find a permit | `/`, `/permits`, `/permits/:id` | Address/permit/contractor query; neighborhood, type, and status filters; detailed permit history | No autocomplete, saved search, comparable records, or direct export |
| Research a place | `/addresses`, `/neighborhoods`, detail pages, map | Entity hubs and cross-linked permit records | Neighborhood pages need stronger unique interpretation and adjacent-area navigation |
| Research a builder | `/contractors`, `/contractor/:slug`, contractor insight and network views | Permit activity, entity graph, credentials, network data | Identity confidence and role interpretation are not prominent enough; no comparison workflow |
| Understand the market | `/insights` and ten insight routes | Useful proprietary aggregates and methodology notes | Reports lack a common date-range/filter model and downloadable results |
| Monitor activity | Permit alert form on detail pages | Existing subscribe/confirm/unsubscribe backend | Monitoring is tied to an individual record rather than a reusable search or geography |
| Use the data elsewhere | `/data`, `/api-docs`, OpenAPI, MCP, Gumroad dataset | Excellent machine-readable surface area | Free API, paid dataset, and page-level export are not presented as one graduated path |

### Crawlable inventory

The production sitemap index exposed static, permit, address, project, contractor, and neighborhood child sitemaps, all on the canonical host. At audit time, every child sitemap reported `2026-09-04` as its latest modification date. The static sitemap is conditionally filtered to avoid publishing the ADU/DADU insight when its backing data is unavailable, which is a good quality-control pattern.

## Performance audit

### Production measurements

These are unthrottled transfer observations, not Core Web Vitals:

| Route | Status | Raw HTML | Brotli transfer | TTFB |
| --- | ---: | ---: | ---: | ---: |
| `/` | 200 | 28,395 B | 6,978 B | 494 ms |
| `/permits` | 200 | 72,645 B | 8,799 B | 206 ms |
| `/insights` | 200 | 18,954 B | 4,624 B | 401 ms |
| `/contractors` | 200 | 38,953 B | 6,060 B | 230 ms |
| `/about` | 200 | 11,939 B | not sampled | 255 ms |
| `/data` | 200 | 13,425 B | not sampled | 305 ms |
| `/api/stats` | 200 | 252 B | not sampled | 414 ms |

### What is working

- Pages are server-rendered and useful without waiting for client-side application bootstrapping.
- Brotli reduces the sampled high-traffic HTML responses to roughly **4.6–8.8 KB**.
- The site uses no external webfont or large editorial image in the sampled HTML, limiting render-blocking dependencies.
- Public pages set explicit browser cache lifetimes, and immutable image routes use long-lived caching.
- Independent D1 queries are frequently grouped with `Promise.all`, reducing avoidable serial latency.
- Reduced-motion behavior exists for the animated homepage skyline.

### Findings

#### P0 — Production cache behavior is not verifiable

The Worker implements an HTML Cache API wrapper and intends to add both `max-age` and `s-maxage` after caching a rendered response. Sampled production responses only exposed `Cache-Control: public, max-age=...`; they did not expose `s-maxage` or `CF-Cache-Status`. This could mean the deployed code predates the cache wrapper, the Cache API is unavailable on the route, an intermediary strips headers, or cache writes are not completing. Any of those explanations should be resolved before lower-value front-end optimization.

**Action:** add a safe `Server-Timing` cache descriptor or `X-Building-Seattle-Cache: HIT|MISS|BYPASS`, deploy the current cache wrapper, and inspect Cloudflare cache analytics. Do not expose internal errors or cache keys.

**Acceptance criteria:**

- Warm anonymous requests show an observable cache hit.
- P75 origin/Worker TTFB is under 200 ms for `/`, `/permits`, entity hubs, and entity detail pages.
- Cache keys ignore tracking parameters but preserve content-changing filter and pagination parameters.
- Ingest completion either purges affected keys or the documented freshness SLA remains acceptable.

#### P0 — No field Core Web Vitals or route-level latency baseline

The current first-party analytics records page path, referrer, user agent, and country, but not LCP, INP, CLS, cache status, response time, search usage, result clicks, alert completion, or dataset conversion. Optimization cannot be prioritized reliably without field evidence.

**Action:** adopt privacy-conscious Web Analytics plus a small real-user measurement endpoint or analytics beacon. Record route templates rather than sensitive queries and never store search text, email addresses, or full referrer query strings.

**Acceptance criteria:** 28 days of route-level P75 LCP, INP, CLS, TTFB, cache hit rate, and error rate, segmented by mobile/desktop and template family.

#### P1 — D1 query cost is the likely server-side bottleneck

The homepage and aggregate views run several database queries per render. Edge caching is therefore the first lever. After it is verified, use D1 query analytics and `EXPLAIN QUERY PLAN` against the slowest high-volume statements. Do not add speculative indexes: indexes increase ingestion cost and storage.

**Action:** log coarse per-query-family durations with `Server-Timing`; review query plans for permit search, hub counts, sitemap statistics, and homepage aggregates; precompute only stable aggregates that remain slow after indexing and caching.

#### P1 — High-result pages render more DOM than necessary

The sampled permit browser returned 72.6 KB of raw HTML and 133 links. Compression makes transfer cheap, but parsing, layout, and assistive-technology navigation still scale with DOM complexity. The contractor hub rendered nearly 50 `h2` elements because every result card is a section-level heading.

**Action:** retain SSR and pagination, lower card headings to `h3` where the results section owns the `h2`, consider 20–30 results per page on mobile, and measure before introducing client-side virtualization.

#### P2 — Template CSS and behavior remain repeated inline

Shared tokens/navigation/footer are extracted, but each document still repeats the shared CSS and carries page CSS inline. This is fast on the first navigation and tiny after compression, but it prevents cross-page browser caching and makes a strict CSP harder because styles and event handlers require `'unsafe-inline'`.

**Action:** after performance data exists, move stable shared CSS and navigation behavior to versioned static assets. Keep above-the-fold route-specific CSS inline only if lab and field testing show a benefit.

#### P2 — Homepage animation needs explicit performance budgets

The canvas skyline is distinctive and honors reduced motion, but animation work can affect low-end mobile responsiveness even when its transfer cost is small.

**Action:** pause when the document is hidden or canvas is outside the viewport; cap device pixel ratio; measure long tasks and INP; provide a static rendering for constrained devices if needed.

## Utility and user-experience audit

### What is working

- Navigation now exposes permits, contractors, neighborhoods, insights, data, and API consistently.
- Search and filters are server-side forms, so results remain linkable and functional without JavaScript.
- Entity hubs create multiple useful entry points instead of forcing all research through permits.
- Methodology notes distinguish declared value, permit status, inferred projects, and participant matching from stronger real-world claims.
- API documentation, OpenAPI, MCP discovery, `llms.txt`, and a paid dataset serve technical users unusually well.

### Findings and substantive improvements

#### P0 — Make “search → inspect → monitor” the primary loop

The site currently optimizes discovery but not return use. Turn any permit query into a saved watch that preserves neighborhood, permit type, status, minimum value, and keywords. Send a preview before subscription, require confirmation, and link every email to a stable results page.

**First release:** “Save this search” on `/permits`; human-readable watch summary; daily/weekly frequency; confirm/unsubscribe; empty-state guidance; privacy copy.

**Success measures:** search-to-result click rate, saved-search start/completion rate, 30-day subscriber retention, and email click-through. Do not use raw page views as the primary measure.

#### P1 — Add progressive search assistance

The global homepage search and permit search accept broad terms, but do not explain recognized entities or prevent zero-result dead ends.

**Action:** add server-backed suggestions for permit number, normalized address, contractor, and neighborhood; label each suggestion type; support keyboard navigation; preserve a standard form-submit fallback. On no results, suggest removing filters, show possible address normalization, and link to Seattle SDCI source search.

#### P1 — Add export and comparison at the point of research

Users should not have to choose between copying cards and buying the complete dataset.

**Action:** offer a capped CSV export of the current filtered result set with visible freshness, field definitions, source attribution, and a link to the full dataset. Add a two-to-four-item comparison for contractors and neighborhoods, using shareable query URLs rather than account state initially.

#### P1 — Clarify entity identity and data confidence

Contractor and project views are inferred from public participant records. Place a compact provenance panel near the title: source, updated-through date, participant role, license match status, and whether the entity grouping is exact or normalized. Provide a correction/contact path.

#### P1 — Unify insight controls and explanations

Insight pages should share date range, geography, permit-type definitions, freshness, download, and “how calculated” affordances. A reusable insight shell reduces learning cost and makes comparisons credible.

#### P2 — Improve information scent and mobile task completion

- Add “recently viewed” locally in the browser; do not transmit it without consent.
- Make status language human-readable and pair color with text/icons.
- Expose active filters as removable chips and provide result counts before submission where inexpensive.
- Keep search/filter controls reachable after scrolling on mobile, but avoid a large sticky block that obscures results.
- Make the alert call to action contextual: “Notify me when this permit changes” on detail pages and “Notify me about matching permits” on results.

## Accessibility audit

### Positive foundations

- Documents declare English, use one primary `h1`, render native links/forms, and include labels on the permit filters.
- Shared styles provide a visible `:focus-visible` outline.
- The navigation menu button has an accessible name.
- The home animation checks reduced-motion preference.

### Priority gaps

#### P0 — Mobile navigation state is not communicated

The menu button initializes `aria-expanded="false"`, but its inline click handler only toggles a CSS class. It does not update `aria-expanded`, close on Escape, return focus, or identify the controlled menu with `aria-controls`.

**Action:** replace the inline handler with shared progressive-enhancement JavaScript; synchronize expanded state; close on Escape/outside click; ensure focus order remains logical.

#### P1 — Add automated and manual accessibility gates

No accessibility test runner is present. Add axe checks for representative static and data-backed templates, then manually test keyboard-only use, VoiceOver/NVDA landmarks and form errors, 200% zoom, 320 CSS-pixel width, forced colors, and reduced motion.

#### P1 — Correct result heading hierarchy

Repeated `h2` card titles make long hub pages noisy for screen-reader heading navigation. Use a results-section `h2` and card `h3` elements, while preserving meaningful link text.

#### P1 — Verify contrast and non-color status cues

Muted text, pills, maps, and chart palettes require measured contrast in light/dark and forced-colors modes. Every status/change must remain understandable without color.

#### P2 — Announce async outcomes

Alert subscription, validation, and any future autocomplete should expose errors next to fields, move focus to a summary when appropriate, and use a restrained `aria-live` region for non-navigation updates.

## SEO audit

### What is working

- Production pages are server-rendered and returned with correct 200/404 semantics.
- Sampled primary pages had a title, description, canonical, and robots directive.
- The production sitemap index and child locations use `https://buildingseattle.com` and fresh `lastmod` values.
- Filtered hub and permit views are designed to be `noindex,follow` with canonical links to their clean hub, reducing faceted-navigation duplication.
- Permit pages use `Report`; contractor pages use `LocalBusiness`; entity hubs use `CollectionPage`/`ItemList`; the homepage supplies `Organization`, `WebSite`, FAQ, and breadcrumbs.
- `robots.txt` allows public crawling, blocks administrative/ingest/alert paths, advertises the sitemap, and clearly states the site's AI-use preference.
- Social images, web manifest, icons, API catalog, OpenAPI, MCP metadata, and `llms.txt` are present.

### Findings

#### P0 — Establish search-performance evidence before creating more pages

The repository has strong template coverage but no available evidence of impressions, query clusters, indexed-page counts, duplicate canonicals, crawl waste, or conversions by landing page.

**Action:** verify all sitemap children in Search Console and Bing Webmaster Tools; export 16 months of query/page/device/country data; classify queries into permit lookup, address, contractor, neighborhood, market insight, and dataset/API intent; compare indexed counts with sitemap counts.

**Decision rule:** do not mass-produce editorial pages until a query cluster has demand, the page answers a distinct task, and the underlying data clears a minimum completeness threshold.

#### P1 — Increase unique value on long-tail entity pages

Entity pages should not be indexable merely because a row exists. Define indexability thresholds per entity type (for example: valid name/address, recent activity, and enough linked permits). Add concise, data-derived interpretation: activity trend, dominant permit types, meaningful comparisons with city/neighborhood medians, and related entities. Keep statements factual and disclose inference.

#### P1 — Strengthen internal-link architecture

Use the entity graph to add bounded, relevant link modules:

- Permit → address, project, contractor, neighborhood, and similar permits.
- Address → permits, inferred project, neighborhood, nearby active addresses.
- Contractor → active projects, neighborhoods, specialties, comparable contractors.
- Neighborhood → current projects, active addresses, contractors, insight pages.
- Insight → underlying entity hubs and reproducible filtered permit searches.

Avoid sitewide link clouds. Cap modules, rank relevance, and ensure every indexed URL is reachable through HTML links rather than only a sitemap.

#### P1 — Make sitemap QA operational

The sitemap implementation is mature, but production monitoring must run reliably. Add CI/local checks with a mock origin and schedule the live monitor in an environment whose Node networking is known to work. Alert on HTTP/XML errors, noncanonical hosts, invalid or future `lastmod`, more than 50,000 URLs per file, abrupt URL-count changes, and indexable pages missing self-canonicals.

#### P1 — Align metadata with search intent, not just length

Titles are generally descriptive, but templated long-tail titles should lead with the differentiator users search: address + permit type, contractor + Seattle permit activity, or neighborhood + current development. Monitor rewrites and click-through rather than enforcing arbitrary character counts. Keep descriptions factual and include the updated-through date only when reliably maintained.

#### P2 — Add structured data only where it represents visible content

Maintain current `Report`, `Place`, `LocalBusiness`, `CreativeWork`, collection, and breadcrumb markup, but validate sampled production output after every template change. Do not add speculative rating/review markup. Add `Dataset` markup to `/data` only when license, temporal coverage, variables, distribution format, creator, and download/purchase details are visible and accurate.

#### P2 — Build a small editorial layer around proven demand

Candidate pages include plan-review time, ADU/DADU activity, multifamily pipeline, commercial projects, tenant improvements, and neighborhood construction trends—the current insight system already covers most of these themes. Improve those canonical reports rather than creating near-duplicate blog posts. Each report should contain methodology, update date, key findings, a chart/table, links to underlying records, and author/editor responsibility.

#### P2 — Complete trust and local-business signals

Strengthen About and Methodology with editorial ownership, contact/correction process, update cadence, source links, known limitations, and changelog. If Building Seattle has a real public business identity/address, represent it consistently; do not fabricate a local address solely for SEO.

## Security, privacy, and reliability observations

- The Worker applies HSTS, CSP, MIME sniffing protection, referrer policy, permissions policy, and clickjacking protection. This is a strong baseline.
- CSP still permits inline scripts/styles because templates embed both. Moving shared behavior/assets out of HTML would allow nonce/hash-based enforcement later.
- Page-view storage includes user agent, country, and referrer. Establish a retention policy, truncate/normalize referrers, document analytics in privacy copy, and avoid logging query text or alert tokens.
- Health checks should cover HTML and API error rates, ingest freshness, sitemap generation duration, D1 failures, alert delivery, and data staleness—not only metadata.

## Prioritized implementation roadmap

### Phase 0 — Baseline and safety (week 1)

| Deliverable | Owner | Effort | Acceptance signal |
| --- | --- | ---: | --- |
| Route-level RUM and conversion events | Engineering/product | M | 28-day dashboard for CWV and primary funnel events |
| Observable HTML cache status | Engineering | S | Repeated requests demonstrate HIT/MISS/BYPASS correctly |
| Search Console/Bing/Cloudflare baseline | Growth/engineering | S | Saved baseline of queries, indexed URLs, crawl errors, cache ratio |
| Accessibility smoke suite and manual checklist | Engineering/design | M | Representative templates pass automation; manual issues logged |
| Privacy/retention decision for analytics | Product/legal | S | Written event schema and retention period |

### Phase 1 — Speed and core research workflow (weeks 2–4)

| Deliverable | Effort | Dependencies | Target |
| --- | ---: | --- | --- |
| Deploy/verify edge HTML caching and versioned invalidation | M | Phase 0 metrics | P75 TTFB <200 ms on cacheable templates |
| Profile and tune top D1 query families | M | Timing instrumentation | P95 Worker duration reduced without ingest regression |
| Saved filtered-search alerts | L | Existing alert backend | Measurable completed subscriptions from search |
| Search zero-state and typed suggestions | M | Entity lookup endpoint | Higher result click-through; keyboard accessible |
| Correct nav ARIA and result heading hierarchy | S | None | Manual keyboard/screen-reader checklist passes |

### Phase 2 — Differentiation and organic growth (weeks 5–8)

| Deliverable | Effort | Dependencies | Target |
| --- | ---: | --- | --- |
| Filtered CSV export with limits | M | Abuse controls, event tracking | Export usage and dataset upsell measured |
| Contractor/neighborhood comparison | M | Shareable parameter model | Comparison completion and share rate |
| Related-entity modules | M | Entity confidence ranking | More meaningful internal clicks; bounded link count |
| Entity indexability thresholds | M | Search Console baseline | Fewer low-value indexed URLs, no loss of qualified clicks |
| Common insight shell and downloads | L | Filter definitions | Consistent report UX and reproducible data |

### Phase 3 — Platform hardening (weeks 9–12)

| Deliverable | Effort | Dependencies | Target |
| --- | ---: | --- | --- |
| Extract stable shared CSS/JS | M | RUM baseline | No CWV regression; stricter CSP becomes feasible |
| Scheduled SEO/sitemap/data-freshness monitor | M | Reliable network runner | Actionable alerts and stored trend history |
| Dataset structured data and changelog | S | Product metadata | Valid markup matching visible content |
| Editorial upgrades to proven insight pages | L | Query-cluster evidence | Growth in qualified non-brand clicks and downstream actions |

## Measurement framework

### North-star task

**Qualified research sessions:** a visitor searches or enters through an entity/insight page and then completes at least one high-intent action: opens a permit/entity detail, saves a search, exports results, reads methodology/API docs, or visits the dataset offer.

### Performance metrics

- P75 LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 by template and device.
- P75 cached TTFB < 200 ms; P95 origin Worker duration tracked separately.
- HTML cache hit rate, D1 query count/duration per route, 5xx rate, and data freshness lag.

### Utility metrics

- Search submit → result click rate and zero-result rate.
- Alert start → confirmed subscription rate and unsubscribe rate.
- Export completion, comparison completion, and repeat visitor rate.
- API-doc click-through and dataset-offer conversion by landing-page class.

### SEO metrics

- Valid indexed URLs versus eligible sitemap URLs by type.
- Non-brand clicks, impressions, click-through rate, and average position by intent cluster.
- Pages with impressions but no meaningful engagement; crawled-not-indexed and duplicate canonical counts.
- Internal clicks from hubs/related modules to long-tail records.

### Guardrails

- Never trade data accuracy or provenance for a higher page count.
- Never index search/filter combinations by default.
- Never collect raw search queries, email addresses, or alert tokens in analytics.
- No performance change ships without comparing field or representative lab data before and after.
- No new structured data ships unless it matches content visible to users.

## Verification checklist for implementation PRs

1. Run `node --check worker.js` and `npm test`.
2. Run `uv run --extra dev pytest tests/` for changes that touch ingestion, normalization, or dataset output.
3. Exercise `/api/permits`, `/api/stats`, modified routes, cache HIT/MISS behavior, and error cases under `npx wrangler dev`.
4. Test representative templates at 320 px, 200% zoom, keyboard only, reduced motion, and a screen reader.
5. Validate canonical, robots, JSON-LD, social image, and internal links on deployed preview and production URLs.
6. Compare pre/post RUM and D1 timings after enough traffic; do not infer field success from a single synthetic run.

