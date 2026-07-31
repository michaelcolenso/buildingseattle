# Production SEO baseline — July 27, 2026

## Scope

Automated bounded crawl of `https://buildingseattle.com` using
`scripts/check_seo_health.mjs`. The run checked the sitemap index and every
advertised child sitemap, representative aggregate and detail pages, page
metadata and JSON-LD syntax, a bounded internal-link sample, and known filtered
hub URLs.

## Baseline

- 129 of 135 checks passed before the changes in this branch.
- `/sitemap.xml` returned HTTP 200 with a valid sitemap index.
- Six child sitemaps returned HTTP 200 and used only the canonical
  `https://buildingseattle.com` origin.
- The child sitemaps advertised 38,234 URLs:
  - static: 16
  - permits: 13,756
  - addresses: 10,914
  - projects: 11,332
  - contractors: 2,163
  - neighborhoods: 53
- Sampled pages had titles, descriptions, self-consistent canonical hosts, and
  parseable JSON-LD, except where listed below.
- The bounded internal-link sample returned no unexpected 404 responses.

## Baseline findings addressed by this branch

1. The representative contractor detail page omitted a robots directive.
2. Contractor, project, and address filter parameters remained indexable and
   canonicalized to the unfiltered hub.
3. The central methodology route did not exist.

This branch adds the missing contractor directive, explicitly noindexes
filtered hub states, keeps stable unfiltered pagination indexable with
self-referencing canonicals, and publishes `/methodology`.

## Search Console baseline

The sitemap submission and Google indexed, discovered, crawled, and excluded
counts require access to the site’s Google Search Console property. Record
those values here after submitting:

| Measurement | Baseline |
|---|---:|
| Sitemap submitted | Pending Search Console access |
| Sitemap status | Pending |
| Indexed pages | Pending |
| Discovered — currently not indexed | Pending |
| Crawled — currently not indexed | Pending |
| Excluded by `noindex` | Pending |
| Duplicate/canonical exclusions | Pending |

## Reproduction

```sh
node scripts/check_seo_health.mjs https://buildingseattle.com
```

The scheduled GitHub Actions workflow stores each JSON result for 90 days and
keeps a compact JSONL history between runs. Each report includes deltas from
the preceding run. A failing run opens (or updates) a single actionable GitHub
issue with the affected URLs; the workflow closes that issue automatically
after production recovers.

In addition to metadata and sitemap checks, the monitor verifies that every
entity hub has a non-zero `ItemList`, remains indexable, and that the bounded
internal-link sample stays below a 5% broken-link rate. It also probes the
approved finite set of hub filters to ensure filtered URLs remain noindexed
and canonicalized to their unfiltered hubs.

Representative indexable pages must also return a self-referencing canonical
and the Schema.org type expected for that route: `WebSite`, `CollectionPage`,
`Report`, `LocalBusiness`, `Place`, `CreativeWork`, or `AboutPage`. This turns
the repeatable portions of the production validation checklist into scheduled
regression checks; Search Console submission and index-coverage counts remain
manual because they require property access.

The same bounded run downloads the favicon, both manifest icons, and all six
entity social previews. It verifies a successful PNG response, the declared
32×32, 192×192, 512×512, or 1200×630 dimensions, and a reusable cache policy.
This catches broken social-card or install assets without relying on an
unbounded visual crawl.
