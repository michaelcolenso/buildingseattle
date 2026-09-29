# Duplicate-per-record consolidation — September 27, 2026

## The problem

Every permit in the graph is published at three URLs:

- `/permits/{permit_number}` — the record
- `/address/{slug}` — the property that holds it
- `/project/{slug}` — an inferred cluster of permits at that address

`entity_graph.js` clusters permits per address and emits a project for every
cluster, including clusters of one (`confidence_score` 50). With 10,914
addresses and 11,332 projects in the 2026-07-27 sitemap snapshot, and every
address producing at least one cluster, at least **8,490 of the 11,332 project
URLs are single-permit clusters** — a machine-generated restatement of a
record the address page and permit page already carry. The upper bound on
multi-permit clusters is 2,842 (13,756 permits spread over 10,914 addresses),
so between 75% and 100% of project URLs are restatements, depending on how
often clustering actually merged permits.

The Search Console drill-downs pulled 2026-09-27 agree that Google is not
interested in the extra copies: `/project/` is the largest cohort in
"discovered — currently not indexed" (43% of the sampled 1,000), and the
permit URL is the one that takes the exclusion when Google consolidates a
record it does accept. See `docs/search-drilldown-2026-09-27.md`.

## The rule

**A cluster of one permit is not a project.** It is the address page's content
under a second URL. Multi-permit clusters are the only projects that get
listed, linked, or advertised.

## What changed

`worker.js` gained one shared predicate:

```js
const MULTI_PERMIT_PROJECT_SQL =
  "(SELECT COUNT(*) FROM project_permits mpp WHERE mpp.project_id = pr.id) > 1";
```

and it is applied at every surface that can publish or link a project:

| Surface | Before | After |
|---|---|---|
| `/project/{slug}` | Self-canonical | One-permit clusters canonicalize to `/address/{slug}`; 200, `index,follow`, JSON-LD still describes the page itself |
| `/sitemaps/projects-*.xml` | All projects | Projects with ≥2 permits (`HAVING COUNT(DISTINCT pp.permit_id) > 1`) |
| `/projects` hub | All projects | Projects with ≥2 permits |
| `/address/{slug}` "Inferred projects" | All projects at the address | ≥2-permit projects |
| `/permit/{n}` "Explore This Record" | Linked its project | Links the project only when it has ≥2 permits |
| `/contractor/{slug}` and org-backed contractor pages | Listed single-permit clusters | ≥2-permit projects |
| `/neighborhood/{slug}` "Active projects" | Listed single-permit clusters | ≥2-permit projects |

Two deliberate non-changes: the entity graph still creates single-permit
projects, so those URLs keep resolving for anything already linking to them;
and the permit and address pages remain separate, indexable templates. Only
the synthetic third copy is withdrawn.

`HTML_CACHE_VERSION` went `v4` → `v5` so the edge cache serves the new
canonicals immediately.

## Companion change: empty addresses now return 410

`renderAddressPage` used to answer an address with no permits left on record
with a crawlable `200` and `noindex`. Search Console's "excluded by noindex
tag" bucket is 1,196 URLs, 99% of them addresses, all crawled in a single June
burst — crawl budget spent on pages with no content. Those addresses are
neither sitemapped nor linked internally (every address query in the worker
joins `permits`), so the route now returns `410 Gone` with the shared error
template (`renderGone`), and every address page that does render is
`index,follow`.

## Blast radius

- The project sitemap drops from 11,332 advertised URLs to at most ~2,842, and
  probably a few hundred to ~2,000 — the single largest reduction available
  without deleting content.
- No indexable page disappears: single-permit project URLs are canonicalized
  and unlinked, not removed.
- If the estimate is wrong and the project template is earning clicks on
  single-permit clusters, the change is one predicate and a cache-version
  bump away from being reverted.

## Verification

- `node --check worker.js`
- `node --test "tests/**/*.test.js"` — 9 files pass, including two new ones:
  `tests/project_dedupe.test.js` (extracts every query embedding the predicate
  from `worker.js` and executes it against `schema.sql` +
  `migration_entity_graph.sql`, asserting single-permit clusters are excluded
  and multi-permit projects survive) and `tests/empty_address.test.js` (410
  for an empty address, 200 for one with records).
- `.venv/bin/python -m pytest tests/ -q` — 18 passed.

## How to confirm against production data

Read-only D1 queries, for whoever holds a token with D1 scope:

```sql
SELECT COUNT(*) AS projects,
       SUM(CASE WHEN pc = 1 THEN 1 ELSE 0 END) AS single_permit_projects,
       SUM(CASE WHEN pc > 1 THEN 1 ELSE 0 END) AS multi_permit_projects
FROM (
  SELECT pr.id, COUNT(pp.permit_id) AS pc
  FROM projects pr LEFT JOIN project_permits pp ON pp.project_id = pr.id
  GROUP BY pr.id
);

SELECT COUNT(*) AS empty_addresses FROM (
  SELECT a.id FROM addresses a
  LEFT JOIN permits p ON p.address_id = a.id
  GROUP BY a.id HAVING COUNT(p.id) = 0
);
```

Then re-pull the Page Indexing export: expect the projects child sitemap to
advertise far fewer URLs, "discovered — currently not indexed" to shrink as the
sitemaps stop announcing the duplicates, and the canonicalized project URLs to
land under "alternate page with proper canonical tag" if Google agrees with the
consolidation.
