# Index-selection investigation — pre-implementation report (2026-10-22)

**Status: investigation complete to the limit of the inputs reachable from this session.
No application code has been changed, nothing is committed, nothing is deployed.**
This document is the "before implementation" gate. It contains one supported defect, one
falsified premise, and four decisions/inputs that are needed before a rollout can be judged.

Labels used throughout: **[M]** measured fact · **[I]** inference · **[H]** hypothesis (untested) ·
**[X]** falsified · **[B]** blocked (input not reachable) · **[P]** proposed, not implemented.
Nothing here is labelled implemented, tested-in-CI, deployed, or externally verified, because none of it is.

## 1. Verdict

1. **The premise needs correcting. [M]** The decline in URLs earning impressions is not specific to
   BuildingSeattle. Four-week average of distinct URLs with impressions, first four full weeks
   (06-15..07-06) vs last four (09-21..10-12): buildingseattle **-44%**, nobodynamed -62%,
   recalledrides -83%, nursinghomegrade -87% (same Cloud project, different code and data).
   BuildingSeattle declined *least*. A common-mode component (new-site exploration decay, or demand)
   is the leading explanation **[I]**; I found no BuildingSeattle-specific excess decline.
2. **"Survivors rank unusually well" is explained by query mix, not ranking strength. [M]+[I]**
   87% of impressions (11,191 of 12,830) and 334 of 338 clicks come from *anonymized* (rare) queries,
   at position 7.75 with 42% of impressions at position <=3. Queries Google does name rank at 44-64.
   Weighted position per template is flat week to week (permits ~5-7, projects ~5, addresses ~7-9).
   Rare exact-match queries (a permit number, a street address) face little competition **[I]**; the
   anonymized text cannot be inspected, so that remains inference. (My earlier chat figure that
   "average position improved" used the site table's `sum_top_position`, a different metric. Retracted.)
3. **One real, measured defect exists and is not an SEO opinion: entity links are truncated. [M]**
   44.2% of permits (6,731 / 15,231) have `address_id` and `project_id` NULL; the linked set is *exactly*
   the first 8,500 permits by id. 4,976 of 12,026 address rows therefore have zero linked permits and
   answer **410 "no permits on record"** although live permits exist at them.
4. **That defect does not explain the decline in URLs-with-impressions. [M]** The orphan-address class
   is flat (~39 -> ~42 URLs/week) while currently-valid sitemapped pages fell 316 -> 157/week.
5. **Why the cap is 8,500 is not established. [B]** The repo's own `rebuildEntityGraph`, run through
   `worker.js` on all permits, links 100% with 0 orphan addresses (section 4, F5). Production
   therefore differs from that code path or is being cut off; confirming needs Workers Logs.
6. **No indexability score should be built. [X]** Best single permit feature has AUC 0.576.

**Not answerable from here [B]:** why Google selects some entities and rejects others, in the sense of
cohorts B (crawled-not-indexed) and C (discovered-not-indexed). Those need the Page Indexing per-URL
lists or URL Inspection API; neither is reachable (section 2).

## 2. Inputs: reached vs not reached

| Input | Status |
|---|---|
| Repo, routing, git history | Reached. Note `site_worker.js` was merged into `worker.js` on 2026-09-25, so `git log -S` on `worker.js` cannot see earlier history of moved code; whole-history search used. |
| Live production responses | Reached. 1,976 URLs probed 2026-10-22 ~04:00-05:00 UTC without following redirects. |
| Sitemaps | Reached. 26,147 URLs across 6 child sitemaps. |
| Full permit set incl. `address_id`/`project_id` | Reached via public `/api/permits` (15,231 rows; the API exposes the link columns). |
| GSC bulk export (BigQuery `overlorded.searchconsole_buildingseattle`) | Reached. 2026-06-02..2026-10-19, 140/140 days, 5,268 URLs with impressions. |
| Sibling-property exports (same project) | Reached; used as control. |
| D1 directly | **[B]** No Cloudflare credential in session. Substituted: public API + rebuilt expected graph. |
| Cloudflare request logs / Workers Logs / Googlebot crawl data | **[B]** Same reason. Googlebot crawl allocation and historical 404/redirect counts are unmeasured. |
| Page Indexing per-URL lists (cohorts A/B/C labels) | **[B]** Prior exports (`docs/search-drilldown-2026-09-27.md`) are referenced but the zips were not committed and are not in Drive. |
| URL Inspection API | **[B]** No GSC API credential. |
| Inbound-link counts, crawl depth, content fingerprints | Not collected (needs a crawl; low value until labels exist). |

Dataset: `url_inventory.csv` (27,673 rows x 42 columns; sitemap + GSC + live probe + permit features +
expected-graph address/project fields). Probed subset only: 1,976 URLs. Columns above that were not
collected are blank, not zero.

## 3. Hypothesis scorecard

| Hypothesis | Result | Evidence |
|---|---|---|
| **URL churn** (indexed entities get new slugs, old URLs 404) | **Real but small [M]** | 36 URLs with impressions now 404 (27 `/project/`, 9 `/address/`): 57 impressions, 0 clicks. 565 addresses with impressions now 410. 922 single-permit projects (1,900 impressions, 62 clicks) now `canonical` to `/address/` (deliberate, #77). **Zero redirects exist anywhere in 1,976 probes.** Project slugs are not preserved across rebuilds (only address/org slug maps are passed to `buildEntityGraph`). Decomposition of the decline: churn classes (410, 404, canonicalized) = ~19% of it; 81% is still-valid pages. |
| **Entity weakness** (sparse/ambiguous entities rejected) | **Not supported for permits [X]; untestable for addresses [B]** | AUC (impression vs none): `ddesc_len` .576, `enriched` .556, `has_parcel` .556, `logval` .550, `desc_len` .540, `has_contractor` .534, `linked` .510. Nothing separates the groups. Impression rate by template/status varies only 5-13%. |
| **Near duplication** | **Untested [H]** | No fingerprints collected. Structural duplication known: single-permit project = address content (already addressed by #77). |
| **Internal authority** | **Untested directly [H]; weak indirect [M]** | Unlinked permits have no address/project link on their page. Impression rate: unlinked 10.4% vs linked 11.2% overall; at the id boundary (+/-500 permits, same creation week) 16.6% vs 22.2% (z~2.2) but it vanishes at +/-2000 (14.6% linked vs 14.7% unlinked) and is mixed within applied-month strata (-0.8 pt, +4.0, +2.9 pts). Not a dominant effect. |
| **Inventory overload** | **Untested [B]** | Needs Googlebot logs. Sitemap = 26,147 URLs; 3,742 (14.3%) ever had an impression in 140 days; 28-day rates 1.0-5.2% by template. |
| **Sitemap selection** | **Supported in a narrow, uncomfortable sense [M]** | Address sitemap membership equals "has >=1 linked permit" *exactly* (7,050 = 7,050; 0 exceptions either way). It is a by-product of the link cap, not a quality rule. All 15,232 permits are included regardless of any feature. But features that could discriminate do not exist (row above). |
| Premise: indexed population is declining | **Not shown [M]** | Proxy (URLs with impressions) -44%, less than all three siblings. Coverage-report trend after 2026-09-27 not available; the earlier doc reports indexed flat at 27,656 for 2026-09-18..09-27 (not verified by me). |
| Premise: survivors rank unusually well | **Explained by query mix [M]+[I]** | See verdict 2. |

Candidate mechanism **tested and rejected [X]**: "the rebuild has a fixed call budget; growth in permits
shrinks the linked prefix over time". Calibrated on today's state (budget 1,552 D1 calls) it predicts
0 orphan addresses on 2026-06-19, yet the 2026-09-27 export shows 1,196 `noindex`-excluded URLs (99%
addresses) last crawled in a 2026-06-19/20 burst (`docs/search-drilldown-2026-09-27.md`), i.e. empty
addresses already existed in June. It also predicts a gradual rise (217 -> 2,082 -> 3,534 ->
4,976) that I could not check against URL-level data. Discarded.

## 4. Evidence for the defect

- **F1 [M]** Of 15,231 permits, 8,500 are linked and 6,731 are not. In id order the link state is a single
  run: ids 31577..128289 linked, 128290..867508 not (2 runs total, 0 interleaving).
- **F2 [M]** The boundary is count-based, not date-based: 200 permits share the created-at second
  2026-05-28 13:00:49; 93 are linked and 107 are not. 8,500 = 170 x the 50-statement `runEntityBatch` chunk.
- **F3 [M]** The pure builder (`entity_graph.js`) maps all 15,231 permits to 12,026 addresses and 12,550
  projects. D1 contains that full set: 150 of 150 sampled never-linked address slugs return **410, not
  404** (the route returns 404 when no `addresses` row exists, `worker.js` `renderAddressPage`), and a
  non-existent slug returned 404.
- **F4 [M]** Sitemap addresses (7,050) = addresses with >=1 linked permit; the other 4,976 are orphans.
  565 of the 574 address URLs with impressions that are absent from the sitemap return 410 (9 return 404).
  Weekly, ~40 of these URLs still get impressions, including after the 2026-09-29 410 change.
- **F5 [M]** `POST /admin/build-graph` executed through the real `worker.js` against all 15,234 permits in
  a `node:sqlite` D1 shim: 1,688 D1 calls, 3.4 s, `linked_address = 15,234`, `orphan_addresses = 0`.
  So the logic at HEAD is correct; production linking is truncated by something outside that logic **[I]**.
- **F6 [M, code]** `rebuildEntityGraph` first runs `UPDATE permits SET address_id=NULL, project_id=NULL`, then
  `DELETE`s addresses/projects/people_orgs/neighborhoods and re-inserts them across ~1,680 sequential
  D1 calls, relinking permits last. A failure after the delete phase leaves a prefix-linked graph.
  `runScheduledIngest` catches a rebuild error with `console.error` and still logs the ingest as
  `success`. Entity row ids are therefore reissued on every rebuild (live ids are ~1.53M for 7,050 rows);
  only address and org *slugs* are preserved. Project slugs are not.
- **F7 [M, code]** `safeAll`/`safeFirst` return `[]`/`null` on *any* D1 error. On `/address/:slug` an error
  makes `permits = []`, which takes the `permitCount === 0` branch and returns **410**. A transient D1
  fault can therefore serve a permanent-removal status for a good address. Nothing shows this has
  happened; it is a latent hazard, not an observed cause.
- **F8 [M, doc]** `docs/project-dedupe-2026-09-27.md` describes empty addresses as ones whose permits are
  "left on record"/gone from the SDCI feed. The data says otherwise for the 4,976: the permits exist
  (e.g. `/api/permits?q=4100 densmore` returns 2) and are simply not linked. The 410 copy ("We no longer
  have construction permit records for this address") is false for these.

## 5. Rejected alternatives

- **Mass `noindex`, sitemap removal, canonical or redirect changes:** not supported. Permit-level features
  do not discriminate (AUC <= .576), so any pruning rule would be arbitrary; the sibling control says the
  headline decline is mostly outside our control.
- **An "indexability score" with fitted weights:** rejected for the same reason. Revisit only after
  cohort B/C labels exist and a model beats AUC ~0.65 out of sample.
- **Redirecting 410 addresses to a hub or the nearest address:** would create soft-404-like mappings for
  pages that should simply work again.
- **Growing-call-budget explanation:** failed its out-of-sample check (section 3).
- **Treating #77 (single-permit project canonicalization) as the cause:** it moved ~19% of the weekly
  decline at most, and it is a deliberate consolidation; its effect on Google's treatment is observable
  only with "Alternate page with proper canonical tag" counts, which I do not have.

## 6. Proposed fix [P — not implemented]

**Principle: make entity linkage correct, incremental and observable; change no URL scheme, canonical,
robots or sitemap rule.**

1. **Incremental, idempotent linking** in `rebuildEntityGraph` (`worker.js`): compute the desired
   permit -> address/project mapping exactly as today (`entity_graph.js` unchanged), upsert
   addresses/projects/people_orgs/neighborhoods by their natural keys (`normalized_address`, project
   `slug`, `normalized_name`) instead of `DELETE` + `INSERT`, and `UPDATE permits` only where the
   current link differs. Steady-state cost then scales with *new/changed* permits, not total permits,
   so there is nothing left to truncate, and entity row ids become stable (the permanent-ID goal) as a
   side effect. Needs additive unique indexes (migration below).
2. **Preserve project slugs** the same way address/org slugs are preserved today (pass the previous
   `projects.slug` set to `buildEntityGraph`), so a project URL cannot change because its cluster did.
3. **Make failure visible:** rebuild returns `{expected_linked, linked, unlinked}`; `runScheduledIngest`
   logs `partial`/`error` when `unlinked > 0`; `/admin/entity-report` and `scripts/check_seo_health.mjs`
   report the same number.
4. **Do not answer 410 on an uncertain graph:** `/address/:slug` returns 410 only when the address has no
   permits *and* graph integrity is known-good; if `unlinked > 0` or the query errored it returns
   `503` + `Retry-After` + `no-store`. Fix the false 410 copy.

Files: `worker.js` (`rebuildEntityGraph`, `runScheduledIngest`, `renderAddressPage`, `entityGraphReport`,
`safeAll` call sites on the address path), a new `migration_entity_unique_keys.sql`,
`scripts/check_seo_health.mjs`, tests (below). Not touched: `entity_graph.js` slug/clustering logic,
`MULTI_PERMIT_PROJECT_SQL`, sitemap generators, canonical/robots output.

**Effect on indexable inventory:** relinking grows sitemapped addresses from 7,050 to up to 12,026
(+4,976) and links ~6,731 more permit pages to their address/project. That is exactly the
"inventory overload" risk the brief warns about, and it is why the rollout below is controlled instead
of global.

**Migration / URL compatibility:** no slug or path changes for any existing entity (address and org
slug maps already preserved; project slugs preserved by item 2). Statuses that change: the 4,976 orphan
addresses 410 -> 200 (treatment arm only, section 7). 410 -> 200 is a status reversal Google handles by
recrawl; the 410 behavior was committed 2026-09-29 (#77; production confirmed serving it; before that these were 200 + `noindex`, per
git `8d9d20b`). The 922 canonicalized projects and 36 404s are untouched. The 0-redirect finding is
left as-is: no old URL maps to a different new URL, so there is nothing to redirect.

## 7. Controlled rollout [P]

**Question tested:** does restoring a correctly linked, indexable address page for a previously orphaned
address improve its index selection relative to leaving it as is?

**Population:** the 4,976 orphan addresses (live permits, zero linked). **Assignment:** deterministic,
stratified by first-permit month x (1 vs 2+ permits), alternating within stratum by
`sha256("bs-relink-2026-10|" + path)`. Result: **2,491 treatment / 2,485 holdout**; balance (treatment /
holdout): first-permit month 2026-05 1,642/1,641, 06 174/173, 07 200/199, 08 183/182, 09 169/168, 10 123/122;
1-permit 2,225/2,223, 2+ 266/262; mean permits 1.133/1.130; with prior impressions 277/288; permits
behind each arm 2,822/2,808. Assignment file: `cohort_assignment.csv` (scratch; regenerate with the recipe).

- **Treatment:** link integrity restored (items 1-4), address page 200/indexable, included in the address
  sitemap, linked from its permit pages.
- **Holdout:** unchanged for 28 days — permits stay unlinked, page stays 410, not in sitemap. This
  deliberately keeps a false 410 live on 2,485 addresses for 28 more days (they have had it since
  2026-09-29 and were `noindex` before that). Decision needed (section 9).
- **Everything else (guardrail cohort):** the 3,742 sitemapped URLs that have ever had impressions.
  Fix items 1-4 do not alter their output; any change is a regression.
- Item 1 (incremental linking) ships to everyone because it is a correctness fix; only the *arm
  assignment of orphan addresses* is withheld, via a temporary env-gated skip list that is deleted at day 28.

## 8. Test, rollback, measurement

**Test plan [P].** `node --test tests/*.test.js` + `pytest tests/` in CI (existing `test.yml`).
New: (a) rebuild at 15k-permit scale links 100% (reuse `scripts/seo_investigation/rebuild_local.mjs`
harness shape); (b) second rebuild is a no-op: 0 row changes, identical ids and slugs;
(c) injected failure after the upsert phase leaves previous links intact; (d) project slugs stable when a
cluster gains a permit; (e) `/address/:slug` -> 410 only when graph integrity is good and permits are
genuinely absent, otherwise 503 + `Retry-After`; (f) canonical/robots/JSON-LD/sitemap output byte-identical
for a fixture of existing 200 URLs (golden test); (g) historical-URL test: every one of the 5,268 GSC URLs
resolves to the same status class as today except the treatment-arm addresses.

**Rollback [P].** The unique-key migration is additive (`DROP INDEX` reverses it). Behavioural rollback is
a revert of `worker.js`; stale links are harmless because the old code deletes and rebuilds them. The
holdout skip list is an env var; clearing it ends the experiment. Bump `HTML_CACHE_VERSION` on deploy and
on rollback so edge-cached 410s/200s do not linger.

**Measurement plan [P].** Primary window 28 days after deploy; checkpoints day 3, 7, 14. Judged only on
external evidence:

| Metric | Baseline (measured unless noted) | Target |
|---|---|---|
| Index rate, treatment vs holdout (URL Inspection `Indexed`, all 4,976 inspected at day 0 and 28; ~2,000/day quota, so 3 days) | **[B]** unmeasured; holdout is the baseline | Treatment - holdout >= +2 pp with 95% CI lower bound > 0 (MDE at n~2,490/arm and ~6% base: ~1.9 pp) |
| Crawled-not-indexed rate (same inspections, `coverageState`) | **[B]** | Treatment <= holdout |
| Discovered-not-indexed rate | **[B]** | Treatment <= holdout |
| Impression rate (>=1 impression in 28 d), sitemapped addresses | 3.18% (224 / 7,050), trailing 4 wks to 10-18 | Treatment > holdout; weak metric (1.7 impr per URL) |
| Impressions / clicks per URL-with-impression, addresses | 1.71 impr, 9 clicks / 224 URLs | No decline vs guardrail |
| Old-URL 404/410 frequency (Cloudflare logs) | **[B]** unmeasured. Live probe: 565 x 410, 36 x 404, 0 redirects among GSC-known off-sitemap URLs | Treatment-arm 410s -> 0; no new 404s on guardrail URLs |
| Redirect correctness | 0 redirects exist; none required | Still 0 unintended redirects (probe all 5,268 GSC URLs weekly) |
| Googlebot crawl allocation by template (logs) | **[B]** unmeasured | Report only; no target until a baseline exists |
| Indexed sitemap ratio (Sitemaps report, per child sitemap) | **[B]** not exported | Report only |
| Guardrail: impressions/clicks on the 3,742 existing URLs | Trailing 4 wks, in-sitemap valid URLs: address 382 impr/9 clk, permits 365/21, project 44/2, contractor 163/6 | Judge as difference-in-differences against the sibling properties' weekly impressions (common-mode control); fail if BuildingSeattle falls >20% *relative* to siblings |

A positive result requires the treatment-vs-holdout primary metric **and** a passing guardrail. A null
primary with a passing guardrail means: ship the correctness fix (it is still right), conclude that
restoring orphan addresses does not by itself improve selection, and stop pursuing entity-link repair as
an SEO lever.

## 9. Decisions and inputs needed

1. **Holdout:** accept leaving 2,485 correctly-linkable addresses on 410 for 28 days to get a clean
   answer? (Alternative: fix everyone now, forgo causal evidence, judge by before/after only — weaker
   given the sibling-site common-mode decline.)
2. **GSC API access (OAuth, `webmasters.readonly`)** or fresh Page Indexing per-URL exports + the Sitemaps
   report. Without it cohorts B and C cannot be built and the primary metric cannot be measured.
3. **Cloudflare API token** (Workers Logs read, D1 read, analytics/log access) to (a) read the
   `Entity graph rebuild failed:` / limit-exceeded evidence for the 8,500 cap, (b) pull Googlebot
   request, 404 and redirect history, and (c) run read-only D1 counts instead of the public-API proxy.
4. **Deploy path:** `wrangler.toml` says GitHub auto-deploys; confirm it deploys from `main` and that I
   may push a branch and open a PR. Nothing has been pushed.

## 10. Reproduction

`scripts/seo_investigation/` (README there). Key numbers re-derivable with: `permit_features.py` (AUCs,
boundary rates), `graph_dump.mjs` (expected graph, 12,026 addresses, 4,976 orphans), `rebuild_local.mjs`
(F5), `budget_model.mjs` (rejected mechanism), `probe.py` (live statuses), `gsc_queries.sql`.
Verified this session: `permit_features.py` reproduces the AUC and boundary figures; all scripts pass
syntax checks. Not verified: the packaged scripts end-to-end from a clean checkout (paths were rewritten
after they ran in a scratch layout).
