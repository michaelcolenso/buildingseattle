# Handoff: interface sweep and permit-value counting (2026-11-05 → 2026-11-08)

For the next agent working on this repo. All state below was verified against production and the D1 database on 2026-11-08 unless marked otherwise.

## What shipped (all merged and deployed)

| PR | What it did | Verified in production |
|---|---|---|
| #89 | Added 8 interface-review skills under `.claude/skills/` (`interface-review`, `better-interface` and its 6 `better-*` domains). | Yes |
| #90 | Fixed the contractor page: true permit totals (the 10-row list had been undercounting, e.g. 10 shown vs 40 actual for Abbott), 320px reflow, contrast, skip link, `<main>` and the nav hamburger's `aria-expanded`. | Yes |
| #91 | `/permits`: the results heading now sits directly over a counted list, and empty searches say so. `/projects`: names a cluster "New construction" before "Demolition". Hub filters at 16px. | Yes |
| #92 | Site-wide: entity-page reflow, pill contrast, a native `<dialog>` alert sign-up, a Basis Reset 503 fallback, the map iframe title and network SVG semantics. | Yes |
| #97 | Fixed regressions from the brand passes (#93–#96): the 320px header, the permit timeline, breadcrumb underlines and the dark-mode `--on-accent` button. | Yes |
| #98 | **Counted permit value.** `value_counting.js`: a valuation SDCI repeats across a project's demolition (`-DM`) permits counts once in every total. Homepage $14.6B → $11.2B. | Yes |
| #99 | Rebuilt the Gumroad dataset 2026-11 with counted totals; build fixes (`address_id` grouping, counted contractor totals, idempotent CHANGELOG). | Merged; **Gumroad upload not done** (see below) |

Final production sweep after #97: all 30 page types at 1280 and 320 had 0 axe violations (WCAG 2 A/AA, 2.1 AA, 2.2 AA), no horizontal overflow and no focus hidden under the header. The dark theme was also clean (18 pages × 2 widths). **Not tested:** a real screen reader or true 200% browser zoom.

## The counting rule (read before touching any total)

`value_counting.js` is the single source:
- `countedValueSql(alias)` goes inside every SQL `SUM` of permit value.
- `countedValues(permits)` and `countedTotal()` are the JS mirror, used by the entity graph and the address and project pages.
- `gumroad/build_dataset.py` and `gumroad/refresh.py` carry Python mirrors, with a drift test.

The rule:
- A `-DM` permit's value is not counted when another permit at the same `address_id` already carries that exact value: a non-demolition permit, or a demolition with a lower id.
- Construction permits are never deduplicated, because identical values there are separate buildings, e.g. one permit per townhouse.

Each permit's own page, API row and CSV row keep SDCI's declared value.

Measured on production (15,551 permits):
- Declared: $14,594,349,177. Counted: $11,245,353,426. That removes $3.35B on 112 demolition permits.
- 95% of the repeat value is all-demolition groups.
- Construction-only repeats ($106M) were left alone on purpose.

`tests/value_counting.test.js` runs the SQL in real SQLite (`node:sqlite`) and asserts it equals the JS version. **Any new value aggregation must use `countedValueSql()`**; `CLAUDE.md` and `AGENTS.md` say so.

## Open items for the user, not the agent

1. **Upload the 2026-11 Gumroad files.** Build with `python3 gumroad/build_dataset.py --source api`; it writes `gumroad/dist/*_foundation.zip` and `*_pro.zip`, which are gitignored. Replace the 2026-07 files on Gumroad and paste `gumroad/sales-page.md` into the listing. There are no buyers yet.
2. **Admin token rotated.** `ADMIN_API_TOKEN` was replaced in Cloudflare on 2026-11-08, and the new value is saved as a network secret (`X-Admin-Token` for `buildingseattle.com`) on the personal `buildingseattle` cloud environment. Any script or `.dev.vars` still using the old value is broken.

## Recommended next work for an agent, in priority order

### 1. Bring `/insights/basis-reset` into the site shell (small, high visibility)
- **Why:** the radar now has data (`basis_reset_scores`: 2 rows, page renders 2 cards). But `renderBasisResetRadar` in `basis_reset_routes.js` still emits a standalone document: Arial, hard-coded colors, no nav, skip link, `<main>`, tokens or dark theme. Only `lang="en"` was added. It's the one page that looks like a different site.
- **Do:** render the body through the same shell as the other insights pages (`renderEntityDoc`, or the insights wrapper). The routes module can't import from `worker.js`, so either pass a render function in, or move the HTML into `worker.js` and keep data shaping in the module. Keep the 503 fallback from #92. Then run the interface sweep below on it.
- **Done when:** the page has the global nav, `<main>`, skip link and tokens; axe shows 0 violations at 1280 and 320 in light and dark; tests cover the shell.
- **Stop if:** the user wants the radar's distinct editorial look kept. Ask before restyling.

### 2. Watch the effect of the count and value corrections (no code)
- **Why:** #90 changed 2,447 contractor meta descriptions (true permit counts). #98 changed every total and the `/projects` ranking.
- **Do:** after 2–4 weeks, compare Search Console clicks and CTR for `/contractor/*` and `/projects` against the 4 weeks before 2026-11-05. That needs Search Console access, which this environment doesn't have; ask the user for an export or a connector.
- **Stop if:** there's no access. Don't infer impact without data.

### 3. Close the org-contractor 50-permit cap before it matters (small)
- **Why:** `renderOrgContractorPage` loads `LIMIT 50` permits and shows `permits.length` as the "Permits" stat, the same undercount #90 fixed on curated pages. 15 orgs have more than 50 permits (max 118). It's **latent**: every `people_orgs` slug currently also has a curated `contractors` row, so this fallback isn't served today. Its value total already uses SQL over all permits (#98).
- **Do:** add a `COUNT(DISTINCT p.id)` query for the stat and label the list "Recent permits (50 of N)", mirroring `renderContractorPage`.

### 4. Assistive-technology pass (needs a human or a real AT setup)
VoiceOver/NVDA walkthroughs of `/permits`, a permit detail page with the alert `<dialog>`, `/projects` and the contractor page; plus real 200% browser zoom. Automated axe and keyboard checks can't cover these.

### 5. Optional data-quality follow-ups (ask before changing published numbers)
- **Construction-only identical values ($106M):** each group is assumed to be separate buildings. Spot-check the largest groups (query in "Verification recipes" below). If some are also one valuation copied across permits, the rule needs a narrower extension, not a blanket dedup.
- **Project naming:** `projectNameFor` in `entity_graph.js` names clusters by keyword precedence (TI > new construction > demolition > …). Pure-demolition clusters such as UW Blakeley Village are correctly "Demolition at…".

## How the previous agent verified things (reuse these)

- **Interface sweep:** Playwright (system Chromium) plus axe-core 4.10.2 from cdnjs, run against production with a `?cb=<timestamp>` cache buster. Per page:
  - axe for WCAG 2 A/AA, 2.1 AA, 2.2 AA and best-practice
  - `scrollWidth` versus the viewport at 320
  - a 60-stop Shift+Tab walk checking the focus ring and focus hidden under a fixed or sticky header
  - **wait about 450ms per stop on the homepage**, which uses `scroll-behavior: smooth`; without the wait the check reports false "hidden" hits
- **Dark theme:** set `localStorage['bs-theme']='dark'` via an init script.
- **Templates before deploy:** import `worker.js` in Node, call `worker.fetch()` with a hand-written `env.DB` mock, write the HTML to a file and audit that. Mocks that return the wrong row shapes produce fake `link-name` failures (`/project/undefined`).
- **Production data:** the Cloudflare D1 MCP (`d1_database_query`, database id in `wrangler.toml`) works for read-only queries. Don't write through it.
- **Deploys:** merging to `main` deploys automatically through Cloudflare's Git integration, usually within a minute or two. Pages are edge-cached (up to `max-age=3600`), so check with a cache buster before concluding a deploy is missing.
- **Entity graph:** `curl -X POST https://buildingseattle.com/admin/build-graph` from the `buildingseattle` environment. The proxy injects the admin token. The daily 13:00 UTC cron also rebuilds.

## Verification recipes

```sql
-- Counted vs declared total (should match /api/stats total_value)
SELECT SUM(COALESCE(p.value,0)) AS declared,
       SUM(CASE WHEN p.permit_number LIKE '%-DM' AND p.address_id IS NOT NULL AND p.value > 0 AND EXISTS (
             SELECT 1 FROM permits q WHERE q.address_id = p.address_id AND q.value = p.value AND q.id <> p.id
               AND (q.permit_number NOT LIKE '%-DM' OR q.id < p.id))
           THEN 0 ELSE COALESCE(p.value,0) END) AS counted
FROM permits p;

-- Largest construction-only identical-value groups (follow-up 5)
SELECT address_id, value, COUNT(*) n, GROUP_CONCAT(permit_number) permits
FROM permits WHERE value > 0 AND address_id IS NOT NULL AND permit_number LIKE '%-CN'
GROUP BY address_id, value HAVING COUNT(*) > 1 ORDER BY (COUNT(*) - 1) * value DESC LIMIT 20;
```

## Lessons from this run

- **Re-sweep after unrelated merges.** The brand passes (#93–#96) landed between review rounds and introduced the 320px header and timeline regressions; a production re-sweep caught them.
- **Mark severity measurements as estimates until settled.** The homepage "42 of 60 hidden" was a measurement artifact of smooth scrolling; the real figure was 3 of 69.
- **Check the data before trusting a naming hypothesis.** The first fix for "Demolition at…" assumed those clusters were rebuilds. The top ones are genuine demolitions, and the real problem was the summed valuations.
- **Review bots on this repo (Codex) have caught real gaps.** Two of its #98 findings were genuine: the project page judged repeats per cluster, and the address and org pages summed raw values. Verify each finding and fix it rather than dismissing it.
