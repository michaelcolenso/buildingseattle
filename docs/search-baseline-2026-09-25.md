# Search Console baseline — September 25, 2026

## Scope and provenance

Two Google Search Console exports for the `buildingseattle.com` property, both
pulled on 2026-09-25:

- **Performance on Search** — search type `Web`, range "Last 3 months"
  (2026-06-24 → 2026-09-23).
- **Coverage (Page Indexing)** — daily chart 2026-06-26 → 2026-09-20, issue
  summary as of the export. Sitemap scope is "All known pages".

Raw CSVs are generated data and are deliberately not committed. Filenames for
provenance:
`buildingseattle.com-Performance-on-Search-2026-09-25.zip` and
`buildingseattle.com-Coverage-2026-09-25.zip`.

Caveats for anyone reading numbers out of these files:

- The performance page export is capped at 1,000 rows, so it accounts for 5,370
  of the 6,476 site impressions; page-level rows also sum to 221 clicks against
  a 216-click daily total, so use the daily series for totals and the page rows
  for structure and relative CTR only.
- The coverage export is summary-level. It contains no per-URL lists, so the
  individual not-indexed and 404 URLs need an issue drill-down export.
- The 2026-07-06 coverage reading (43,951 not indexed) exceeds the entire
  sitemap inventory and is treated as a reporting artifact, not a real state.

## Search performance baseline

| Measurement | Value |
|---|---:|
| Clicks | 216 |
| Impressions | 6,476 |
| CTR | 3.34% |
| United States share | 5,750 impressions / 211 clicks |

Half-over-half: 2026-06-24 → 2026-08-08 was 123 clicks / 3,443 impressions;
2026-08-09 → 2026-09-23 was 93 clicks / 3,033 impressions. Weighted average
position was flat (17.4 → 17.8), so the click decline is demand and tail churn
rather than a ranking collapse.

Devices: desktop 116 clicks / 5,096 impressions (2.28% CTR, position 16.73);
mobile 99 / 1,341 (7.38% CTR, position 19.87); tablet 1 / 39.

Every non-US country in the top eight has zero clicks (India 70 impressions,
Vietnam 61, Mexico 57, Philippines 52, Brazil 45, United Kingdom 40, UAE 32).

## Where clicks come from

Page rows by template (from the 1,000-row page export):

| Template | Pages | Clicks | Impressions | CTR |
|---|---:|---:|---:|---:|
| Address detail | 281 | 77 | 1,189 | 6.5% |
| Permit detail | 368 | 57 | 1,663 | 3.4% |
| Project detail | 214 | 52 | 1,029 | 5.1% |
| Contractor detail | 125 | 33 | 533 | 6.2% |
| Homepage | 1 | 2 | 621 | 0.3% |
| Permit browser (`/permits`) | 1 | 0 | 153 | 0% |
| API docs | 1 | 0 | 77 | 0% |
| Insights | 4 | 0 | 61 | 0% |
| Neighborhood detail | 2 | 0 | 33 | 0% |

Record-level detail pages are roughly 94% of clicks. The homepage is the single
largest impression source and converts at 0.3%. Hub pages (`/insights`,
`/data`, `/about`, `/methodology`, `/contractors`, `/neighborhoods`,
`/projects`, `/addresses`) do not appear in the top 1,000 pages at all.

## Demand shape

- **The impression mass is on pages nobody clicks.** 691 pages rank in the top
  10 with zero clicks, carrying 3,296 impressions — 61.4% of all page-level
  impressions in the export. Examples: `/permits/7120268-CN` (55 impressions,
  position 7.71), `/project/tenant-improvement-at-1122-e-pike-st` (54, 8.91),
  `/address/4100-densmore-ave-n-seattle-wa` (31, 3.35).
- **Head terms are far away.** `seattle construction` — 448 impressions, 0
  clicks, position 75.76. `city of seattle construction permits` (10, 41.0),
  `seattle construction permits` (8, 39.25), `seattle building permits`
  (6, 35.17).
- **Address queries are numerous but tiny.** 68 of the top 192 queries are
  address-shaped and they total 114 impressions with zero clicks. No
  permit-number queries appear at all, so permit pages rank for work
  descriptions and tenant/brand phrases rather than identifiers.
- **Contractor brand and specialty demand is concentrated and under-ranked.**
  The "mckinstry" family alone is 21 query rows, 85 impressions, 0 clicks, at
  positions 57.0–98.0, and `/contractor/mckinstry-essention-llc` already exists
  with 87 impressions at 78.14. `building envelope contractors seattle` is 30
  impressions at 85.93 with `/contractor/pacific-building-envelope-inc` at
  85.93. Contractor pages convert at 6.2% when they do rank.
- **Verification-style queries resolve without a click.** The largest quoted
  queries — `"mangoapps" "760 aloha"` (27 impressions, 9.93) and `"760 aloha"
  "mangoapps"` (9, 9.67) — land on `/permits/7120268-CN`, which holds 55
  impressions at position 7.71 with zero clicks.
- **Crawl hygiene holds.** Only three parameterised URLs reached the top 1,000
  pages (`/permits?page=1|2|3`, 11 impressions combined), and no query contains
  a `?`. The `noindex`/canonical work on filtered states is working.

## Index coverage baseline

Data through 2026-09-20: **27,656 indexed**, **13,277 not indexed**, against a
known inventory of ~40,933 URLs — essentially the ~40,984 URLs the sitemaps
advertise. Google knows the full inventory and declines about a third of it.

| Issue | Source | Validation | Pages |
|---|---|---|---:|
| Crawled — currently not indexed | Google systems | Failed | 4,832 |
| Discovered — currently not indexed | Google systems | Passed | 6,652 |
| Excluded by `noindex` tag | Website | Not Started | 1,196 |
| Not found (404) | Website | Not Started | 590 |
| Page with redirect | Website | Not Started | 6 |
| Blocked by robots.txt | Website | Not Started | 1 |
| Alternate page with proper canonical tag | Website | N/A | 0 |

Non-critical issues: none. As a parse check, the issue counts sum exactly to the
13,277 not-indexed total.

Weekly series (indexed / not indexed):

| Date | Indexed | Not indexed |
|---|---:|---:|
| 2026-06-29 | 29,885 | 6,615 |
| 2026-07-13 | 28,201 | 10,014 |
| 2026-07-27 | 28,258 | 10,464 |
| 2026-08-10 | 27,944 | 11,172 |
| 2026-08-24 | 27,995 | 11,752 |
| 2026-09-07 | 27,811 | 12,883 |
| 2026-09-14 | 27,718 | 13,058 |
| 2026-09-20 | 27,656 | 13,277 |

The indexed count has drifted down ~545 since mid-July while not-indexed grew
~3,263 (+33%), accelerating to roughly +300 per week over the last month.

## What this implies

1. **The thin entity tail is confirmed, and it is the thing to prune rather
   than grow.** 11,484 URLs are crawled-or-discovered and deliberately not
   indexed; the 6,652 "discovered" ones have not even been crawled, which means
   the sitemaps are advertising inventory Google is not interested in. Gating
   single-permit address/project pages (the `noindex` mechanism already proven
   on filtered hubs) would stop overselling the sitemaps.
2. **The indexed set is the one worth optimizing.** Snippet work should target
   the page-1 zero-click cluster and the address/permit/project templates that
   already convert, not new hub or editorial pages. The informational query set
   in this window is one ADU how-to query, so more editorial is speculative.
3. **Contractor pages are the bounded content opportunity** — concentrated,
   high-intent, currently 57–98th, and converting at 6.2% when visible.
4. **Watch the indexed count as the health metric.** Clicks fell 24%
   half-over-half with flat positions; a shrinking index is the more likely
   cause than lost rankings.
5. **Two hygiene items stay open:** 590 URLs return 404 (most likely records
   removed from the SDCI feed — needs the issue drill-down to confirm none are
   internally linked), and one URL is blocked by robots.txt.

## Measurement contract for the homepage guide

The homepage "How to read Seattle construction activity" guide went live
2026-09-25T22:36Z. For that experiment's query, `seattle construction`:

| Window | Impressions | Clicks | Position |
|---|---:|---:|---:|
| 2026-08-03 → 2026-08-31 (dispatcher baseline) | 219 | 0 | 69.4 |
| 28 days following 2026-08-31 | 171 | 0 | 74.9 |
| Last 3 months (this export) | 448 | 0 | 75.76 |

Compare the next complete 28-day window against these, per the PR's contract.

## Not covered — next exports needed

- **Sitemaps report** (submitted / read / indexed per child sitemap) — the last
  rows still marked pending in `docs/seo-production-baseline-2026-07-27.md`.
- **Issue drill-downs** for "Not found (404)", "Crawled — currently not
  indexed", and "Discovered — currently not indexed" to get per-URL lists.
- **16 months of Performance** data for the site-audit P0 on search-performance
  evidence.

## Reproduction

Both exports are read directly from their CSVs; no transform is stored. Notes
for the next pass: the files are BOM-prefixed with quoted fields and escaped
quote characters, the coverage chart columns are
`Date,Not indexed,Indexed,Impressions` (so the wide first column is *not*
indexed), and the performance page export truncates at 1,000 rows.
