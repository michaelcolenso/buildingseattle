# Search Console drill-down analysis — September 27, 2026

## Provenance

Six Google Search Console exports for the `buildingseattle.com` property, all
pulled 2026-09-27. Raw CSVs are generated data and are deliberately not
committed.

| File | Contents |
|---|---|
| `buildingseattle.com-Coverage-2026-09-27.zip` | Page indexing summary (4 rows) |
| `buildingseattle.com-Coverage-Valid-2026-09-27.zip` | Per-URL list of the indexed bucket |
| `buildingseattle.com-Coverage-Drilldown-2026-09-27.zip` | Per-URL list, "Crawled — currently not indexed" |
| `buildingseattle.com-Coverage-Drilldown-2026-09-27 (1).zip` | Per-URL list, "Excluded by `noindex` tag" |
| `buildingseattle.com-Coverage-Drilldown-2026-09-27 (2).zip` | Per-URL list, "Discovered — currently not indexed" |
| `buildingseattle.com-Coverage-Drilldown-2026-09-27/` | Unzipped copy of the "Crawled — currently not indexed" export |

These are the per-URL drill-downs that `docs/search-baseline-2026-09-25.md`
listed as outstanding. They answer "which URLs" but not "why", so each finding
below pairs the export with a live spot check.

## The summary export added no new readings

The 2026-09-27 coverage summary matches the 2026-09-25 one on every
overlapping day: same 27,656 indexed / 13,277 not indexed, last data point
2026-09-20, same issue table. The only difference is that the 09-27 file drops
the 2026-06-26 and 2026-06-27 chart rows. Nothing has moved in the aggregate
since the baseline was recorded.

| Issue | Source | Validation | Pages |
|---|---|---|---:|
| Crawled — currently not indexed | Google systems | Failed | 4,832 |
| Discovered — currently not indexed | Google systems | Passed | 6,652 |
| Excluded by `noindex` tag | Website | Not Started | 1,196 |
| Not found (404) | Website | Not Started | 590 |
| Page with redirect | Website | Not Started | 6 |
| Blocked by robots.txt | Website | Not Started | 1 |
| Alternate page with proper canonical tag | Website | N/A | 0 |

## Sampling caveats

Each per-URL export contains exactly 1,000 URLs, which is the Search Console UI
ceiling, so the exports cover 3.6% of the indexed bucket, 20.7% of the
crawled-not-indexed bucket, 15.0% of the discovered-not-indexed bucket, and
83.6% of the `noindex` bucket. The rows are ordered by last-crawled date
descending, which makes them the **most recently crawled** URLs of each class
rather than a random sample. Treat the compositions below as evidence about
what Google is actively working through, not as exact inventory splits.

## What each bucket is made of

Template share of the 1,000 exported URLs per bucket:

| Template | Indexed | Crawled, not indexed | Discovered, not indexed | Excluded by `noindex` |
|---|---:|---:|---:|---:|
| `/permits/{number}` | 280 | 925 | 285 | 0 |
| `/address/{slug}` | 331 | 6 | 252 | 991 |
| `/project/{slug}` | 349 | 20 | 431 | 2 |
| `/contractor/{slug}` | 36 | 47 | 28 | 0 |
| `/neighborhood/{slug}` | 1 | 0 | 3 | 7 |
| Static / other | 3 | 2 | 1 | 0 |

Reading these together:

1. **"Crawled — currently not indexed" is a permit-template verdict.** 92.5% of
   the exported URLs are `/permits/` detail pages. Google crawled them, judged
   them not worth indexing, and — per the last-crawled column — largely stopped
   re-crawling: 976 of the 1,000 were last crawled in July 2026, 15 in August,
   and 9 in September.
2. **"Discovered — currently not indexed" is project-led and never crawled.**
   Every row carries `1969-12-31` in the last-crawled column, the export's
   sentinel for "never crawled". 43.1% are `/project/` URLs against 28.5%
   permits and 25.2% addresses, so the project template is the largest cohort
   Google knows about and has not bothered to fetch.
3. **The `noindex` exclusions are addresses and they are self-inflicted.**
   99.1% are `/address/` pages, all last crawled in a June 19–20, 2026 burst
   (941 of 1,000), which is the zero-permit state that `renderAddressPage`
   marks `noindex`. The live spot check below shows at least one of them now
   carries a permit and advertises `index,follow`, so this bucket is a stale
   snapshot of a template that flips state as the feed fills in.
4. **The indexed bucket is the only one where all three record templates
   coexist** (331 address, 349 project, 280 permit). For multi-permit records
   Google picks up the address and project views; for the records it declines,
   the permit URL is the one that takes the exclusion.
5. **Crawl budget is still leaking into parameterised and API URLs.**
   `https://buildingseattle.com/permits?page=2` and
   `https://buildingseattle.com/api/pipeline` both landed in the
   crawled-not-indexed export. `/data` appears in the discovered bucket.

## Record-age skew within permits

Among the 925 permit URLs in the crawled-not-indexed export, 760 begin `70`,
145 begin `71`, and 18 are older (`67`/`68`/`69`). Among the 280 permit URLs in
the indexed export, 145 begin `71`, 132 begin `70`, and 3 are older. The
declined slice skews toward lower-numbered, older permits; the indexed slice
skews recent. Nothing in the export says whether that is age, staleness, or
which records the enrichment pipeline filled.

## Live spot check

Six URLs fetched 2026-09-27, spanning the buckets:

Word counts exclude inline `<style>`/`<script>`; "main" is the text between
`id="main-content"` and `</main>`.

| URL | Status | Bytes | Body words | Main-content words | Robots |
|---|---:|---:|---:|---:|---|
| `/permits/7053245-CN` (crawled, not indexed) | 200 | 36,056 | 377 | 282 | `index,follow` |
| `/permits/7024285-CN` (crawled, not indexed) | 200 | 33,724 | 337 | 242 | `index,follow` |
| `/permits/7052080-CN` (indexed) | 200 | 31,567 | 308 | 213 | `index,follow` |
| `/address/6525-24th-ave-sw-seattle-wa` (excluded by `noindex`) | 200 | 15,969 | 346 | 297 | `index,follow` |
| `/contractor/act-construction` (crawled, not indexed) | 200 | 17,818 | 244 | — | `index,follow` |
| `/project/construction-activity-at-8068-earl-ave-nw` (crawled, not indexed) | 200 | 14,341 | 228 | 177 | `index,follow` |

The declined records are not thin because they are empty — they are thin
because most of the text is shared. A permit page renders 213–282 words of
main content, and the three sampled permit pages share 36 distinct lines
verbatim (timeline labels, "Additional Details", "Explore This Record", "Open
official SDCI detail", methodology footers, and so on) against a 124-line union
across all three. Every line on the first page also appears on at least one of
the other two; only ~40–50 lines per page are record-specific description,
valuation, contractor, parcel, and timeline data.

On top of that, each record is published three times — `/permits/{number}`,
`/address/{slug}`, and `/project/{slug}` — with the three pages cross-linking to
each other. Two of the sampled permits literally render "Project: Addition at
6030 51ST PL S" and "Project: Construction activity at 5839 18TH AVE S", which
is the same record as their sibling project page.

Incidental to the check: `/contractor/act-construction` is the one fetched
template with no `<main id="main-content">` landmark and no skip link, and
`renderContractorPage` in `worker.js` (~line 3700) confirms it. Every other
entity template has both. That is a 2,163-URL template still on the pre-audit
structure.

## What this implies

1. **The duplicate-per-record structure is the most likely cause of the
   crawled-not-indexed pile, and it is testable.** Each permit is a permit
   page, an address page, and a project page with the same underlying facts.
   Google's behaviour in these exports — indexing the address/project view and
   declining the permit view for the same record — is what near-duplicate
   consolidation looks like. Before changing anything, check whether the
   crawled-not-indexed permit URLs have a sibling address or project URL that
   *is* indexed; if that holds, the fix is canonical consolidation rather than
   more content on the permit page.
2. **Zero-permit addresses should stop costing crawl.** 1,196 URLs return
   200 + `noindex`. That state is honest but it is still a fetch. Returning
   410 for an address with no permits, or removing the internal links that
   create them, would shrink both this bucket and the crawl queue behind it.
3. **The project sitemap is advertising inventory Google will not fetch.**
   Of the 6,652 discovered-not-crawled URLs, `/project/` is the largest cohort
   in the sampled slice (43.1%), against roughly 11,300 project URLs in the
   sitemaps. Splitting or gating the project sitemap on records with more than
   one permit (the ones that are genuinely a project rather than an inferred
   single-permit group) would stop the overselling.
4. **Nothing in the last two weeks has changed the aggregate.** Indexed has
   been flat at 27,656 since 2026-09-18 while not-indexed sits at 13,277. Any
   intervention made after the 2026-09-25 baseline still has no coverage
   evidence attached to it.

## Shipped since this analysis

See `docs/project-dedupe-2026-09-27.md` for the implementation record:
single-permit project clusters — the ones Google keeps discovering and
declining — are now canonicalized onto their address page, dropped from the
projects sitemap and every internal project listing, and zero-permit addresses
answer 410 instead of a crawlable 200 + `noindex`.

## Still outstanding

- Drill-downs for **Not found (404)** (590), **Page with redirect** (6), and
  **Blocked by robots.txt** (1). All three are under the 1,000-row cap, so one
  export each would fully enumerate them.
- The **Sitemaps** report (submitted / read / indexed per child sitemap), still
  pending from `docs/seo-production-baseline-2026-07-27.md`.

## Reproduction

Exports were unzipped and read directly; no transform is stored. Reading notes
for the next pass: `Chart.csv` is `Date,Not indexed,Indexed,Impressions`, so the
wide first numeric column is the *not indexed* count; per-URL tables are
`URL,Last crawled` sorted by crawl date descending; the last line of each
`Table.csv` has no trailing newline, so `wc -l` under-reports the row count by
one (the true count is 1,000 per export); and `1969-12-31` in the last-crawled
column means never crawled.
