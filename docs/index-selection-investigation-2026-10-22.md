# Index-selection investigation — findings and pre-implementation plan (2026-10-22, rev 2)

**Status: investigation complete to the limit of reachable inputs. No application code changed, nothing
deployed.** Rev 2 replaces rev 1 after Cloudflare D1, Workers Logs and zone analytics became reachable and
disproved two of rev 1's claims (section 0).

Labels: **[M]** measured · **[I]** inference · **[H]** untested hypothesis · **[X]** falsified · **[B]** blocked ·
**[P]** proposed, not implemented. Nothing below is labelled implemented, passed-in-CI, deployed, or
externally verified, because none of it is.

## 0. Corrections to rev 1 (read first)

1. **"A standing cap of 8,500 linked permits since the graph launched" was wrong.** The orphan state is about
   one day old. On 2026-10-21 a single run died mid-relink (section 3, E3). Runs on 10-15..10-20 completed.
2. **The randomized treatment/holdout over 4,976 orphan addresses is withdrawn.** Those addresses are valid
   pages that the 10-21 failure orphaned; the next successful run restores them without any intervention, so
   they cannot serve as a stable cohort.
3. **Every "current disposition" label in rev 1 for address URLs (410, not-in-sitemap) was a snapshot of the
   broken 10-21 state.** All 565 of the "410" GSC addresses exist in the expected graph and are valid on a
   normal day. Only 9 address URLs and 28 project URLs are genuinely gone.
4. **"No rebuild errors in 7 days" was a sampling artifact.** Wide-window Workers Logs queries are sampled
   (`abr_level: 10`); a narrow window around the cron finds the error.

## 1. Verdict

1. **The nightly entity rebuild is destructive and non-atomic. [M]** Every night at 13:00 UTC it nulls all
   permit links, deletes and re-inserts the address/project/org tables, and relinks last, across ~1,690
   sequential D1 calls with no retry. Two consequences are measured:
   - **A ~7-minute window each night** (10-19 13:01-13:11, 10-20 13:02-13:07) in which valid
     `/address/*` pages return **410 "no permits on record"** to ordinary visitors and to bots.
   - **An intermittent partial failure.** On 10-21 the final relink threw at batch 171 of 305 (a D1 error,
     text not retained); the error was caught, logged, and the run was recorded `success`. 6,731 permits
     stayed unlinked, 4,976 of 12,026 address pages stayed 410 and dropped out of the sitemap (12,026 -> 7,050)
     until the next run. Googlebot-UA requests got 410 on 22 occasions during that period.
2. **This does not explain the decline in URLs with impressions. [M]** That decline (-44%, 4-wk average) is
   common-mode: sibling properties in the same Cloud project fell 62-87% over the same weeks. Googlebot's
   own crawl log shows why a decay is expected: 35,554 requests in the two weeks of Jun 8 and Jun 15 (an
   initial sweep of the newly published entity pages), 667 the week after, low thousands since.
3. **"Survivors rank unusually well" is query mix. [M]+[I]** 87% of impressions and 334/338 clicks are on
   anonymized (rare) queries at position 7.75; named queries rank 44-64. Retracted from rev 0: "average
   position improved" came from the site table's `sum_top_position`, a different metric.
4. **No indexability score should be built. [X]** Best permit-level feature AUC 0.576.
5. **Still unanswerable [B]:** why Google selects some entities and rejects others (cohorts B and C). The
   Page Indexing per-URL lists and URL Inspection API are not reachable.
6. **Defensible change:** make the rebuild non-destructive and incremental, and stop reporting a failed
   rebuild as success. That is justified by measured correctness defects. **It is not claimed to reverse
   the indexed-URL decline**, and no experiment I can design would detect an effect of that size (section 6).

## 2. Inputs

| Input | Status |
|---|---|
| Repo, git history, deployed bundle | Reached. Deployed `rebuildEntityGraph`, `runEntityBatch`, `runScheduledIngest` are semantically identical to the repo (normalized diff: bundler artifacts only). |
| D1 `buildingseattle` (read-only SELECTs) | **Reached.** |
| Workers Logs / observability | **Reached.** ~7-day retention (first captured cron log 10-15); 6 of the 7 runs 10-15..10-21 have a retained log line (10-16 missing). |
| Zone analytics (GraphQL adaptive) | **Reached**, ~7 days at minute resolution, rate-limited. UA-based bot filters include spoofed scanners. |
| First-party request log (`page_views`, D1, since 2026-04-20) | **Reached.** Route pattern + UA + timestamp; no status code, no verified-bot flag. |
| GSC bulk export (BigQuery `overlorded.searchconsole_*`) | Reached. 140/140 days. |
| Sitemaps, live probes, full permit set via public API | Reached (1,976 URLs probed). |
| Page Indexing per-URL lists; URL Inspection API | **[B]** |
| Inbound-link counts, crawl depth, content fingerprints | Not collected. |

## 3. Evidence ledger

- **E1 [M]** D1 (2026-10-22 ~04:30 UTC): 15,231 permits, 6,731 with NULL `address_id`/`project_id`
  (min unlinked id 128,290; max linked id 128,289); 12,026 addresses; 4,976 with no linked permit; their
  ids are the *last* 4,976 inserted (1,537,933-1,542,908).
- **E2 [M]** The last rebuild's rows are timestamped 2026-10-21 13:01:00-13:03:05 (addresses, orgs, projects).
  Join tables are complete: `project_permits` 15,231 rows, `address_neighborhoods` 12,026. Only the final
  relink is partial: 649 addresses have some permits linked and some not.
- **E3 [M]** Workers Logs, service `buildingseattle`, `scheduled`: `13:06:49.560Z Entity graph rebuild
  failed:` with stack `D1DatabaseSessionAlwaysPrimary._sendOrThrow -> runEntityBatch -> rebuildEntityGraph
  (deployed line 4409) -> runScheduledIngest`. Deployed line 4409 is the final
  `await runEntityBatch(env, permitUpdates)` (relink). `13:06:49.927Z Scheduled ingest complete`. D1
  `ingest_logs` row 1206: `success`, 13:00:01-13:06:49.
- **E4 [M]** 170 batches x 50 = 8,500 permits relinked before batch 171 threw; D1 batches are atomic, so
  the boundary is clean. The boundary splits a 200-row group created in the same second (93/107).
- **E5 [M]** The same code run through `worker.js` in a `node:sqlite` D1 shim over all permits links 100%
  on three consecutive passes (1,688 calls, ~3 s). No platform limit is implicated: the cron invocation
  recorded 5 subrequests, status `success`, 1.76 s CPU, 408 s wall.
- **E6 [M]** Zone analytics, 410 responses by minute: 10-19 and 10-20 only 13:01-13:11, then none;
  10-21 from 13:04 and continuing (~40-90/hour through the day, versus ~0 outside windows on 10-15..10-20).
- **E7 [M]** Who gets the window's 410: bingbot, Amazonbot, Applebot, SemrushBot, AhrefsBot, and ordinary
  Chrome/Safari visitors. Googlebot-UA 410s: 1 (10-17 window), 1 (10-18 window), 22 (10-21 13:00 ->
  10-22 05:00) = 24 in the retained week. UA is not verified.
- **E8 [M, code]** `runScheduledIngest` wraps the rebuild in `try/catch (console.error)` and then logs the
  run `success`. `safeAll`/`safeFirst` return empty on any D1 error, so on `/address/:slug` a failed
  permits query takes the `permitCount === 0` branch and answers **410**. Entity row ids are reissued every
  night (address ids ~1.53M for 12,026 rows). Project slugs are not preserved across rebuilds (only address
  and org slugs are).
- **E9 [M]** Permit ids are sparse (31,577-867,508 for 15,231 rows; `sqlite_sequence` 887,496) because the
  daily 5,000-row upsert consumes AUTOINCREMENT values. Unrelated to linking.
- **E10 [M, rev 1 holds]** Permit-feature separation of URLs with vs without impressions: best AUC 0.576
  (`ddesc_len`), then `enriched` .556, `has_parcel` .556, `logval` .550, `desc_len` .540, `has_contractor`
  .534, `linked` .510. Impression rate unlinked 10.4% vs linked 11.2%. (`permit_features.py`)
- **E11 [M]** Genuine entity-page URL loss among URLs that ever earned impressions: 9 addresses and 28
  project slugs return 404 (58 impressions, 0 clicks). The project slugs are regenerated each rebuild.
  922 single-permit projects (1,900 impressions, 62 clicks) canonicalize to `/address/` by design (#77).
  There are **zero redirects** anywhere in 1,976 probes.
- **E12 [M]** Googlebot-UA 404s in the retained week are almost entirely scanner paths (`/.env`,
  `/.aws/config`, `/wp-json/`); about 10 are entity pages. The UA-based "Googlebot 404 rate" is not URL churn.

### Googlebot crawl allocation baseline (E13, `page_views`, UA contains "Googlebot", unverified)

| Week starting | address | project | permits | contractor | total |
|---|---:|---:|---:|---:|---:|
| 05-04 | 0 | 0 | 9,732 | 99 | 9,841 |
| 05-18 | 0 | 0 | 9,641 | 162 | 9,818 |
| 06-08 | 10,150 | 4,802 | 523 | 22 | 15,534 |
| 06-15 | 4,274 | 11,114 | 3,985 | 602 | 20,020 |
| 06-22 | 41 | 189 | 413 | 19 | 667 |
| 07-20 | 3,474 | 1,770 | 331 | 73 | 5,675 |
| 08-24 | 49 | 62 | 151 | 27 | 306 |
| 09-21 | 1,129 | 1,128 | 640 | 61 | 2,969 |
| 10-05 | 1,488 | 1,255 | 455 | 61 | 3,288 |
| 10-12 | 1,286 | 1,034 | 579 | 35 | 2,960 |

Last four complete weeks (09-21..10-18): 11,052 requests — address 42.5%, project 37.4%, permits 17.4%,
contractor 1.8%. Requests per URL in the inventory over those four weeks: address 0.39 (12,026 URLs),
project 0.33 (12,550 URLs, only 1,562 sitemapped), permits 0.13 (15,232), contractor 0.09 (2,230).
**37% of Googlebot's recent requests go to a template where 88% of URLs are canonical duplicates** — an
observed crawl-allocation fact, consistent with the inventory-overload hypothesis but not proof of harm.

## 4. Hypothesis scorecard

| Hypothesis | Result |
|---|---|
| **URL churn** (entities get new slugs; old URLs 404) | **Small [M].** 28 project slugs and 9 addresses (E11); ~10 Googlebot-relevant 404s in the last week. Larger real churn is *transient status flapping* (E3, E6), not slug change. |
| **Entity weakness** | **Not supported for permits [X]** (E10). Untestable for addresses/projects [B]. |
| **Near duplication** | **Partly structural [M].** Single-permit project = address content (handled by #77). No fingerprints collected for the rest [H]. |
| **Internal authority** | **Untested directly [H].** Link status shows no meaningful permit-level effect (E10). |
| **Inventory overload** | **Consistent, not proven [I].** E13: 37% of crawl on a template of mostly canonical duplicates; Googlebot crawl collapsed after the June sweep. Needs index-state labels to test. |
| **Sitemap selection** | **Brittle [M].** Address sitemap membership equals "has a linked permit", so it changes with the rebuild's success: 12,026 on a normal day, 7,050 after 10-21. Permit sitemap includes all 15,232 regardless of features. |
| Premise: indexed population declining | **Not shown [M].** Proxy (URLs with impressions) -44%, less than all three siblings; Coverage trend after 09-27 unavailable [B]. |
| Premise: survivors rank unusually well | **Query mix [M]+[I].** |

## 5. Rejected alternatives

- **Mass `noindex`, sitemap pruning, canonical or redirect changes:** no feature separates accepted from
  non-accepted URLs (E10), so any rule would be arbitrary.
- **An "indexability score":** rejected for the same reason.
- **"Constant cap / shrinking call-budget" explanations of the linking failure:** disproved by E2-E5
  (single failed run; no platform limit; code links 100%).
- **Platform-limit explanation (subrequests, CPU):** disproved by E5.
- **Redirecting 410 addresses:** they are valid pages; the right fix is to stop serving 410 for them.

## 6. Proposed fix [P — not implemented]

**Principle: never mutate live entity state until the new state is ready; make failure visible; keep every
URL, canonical, robots and sitemap rule unchanged.**

1. **Non-destructive, incremental rebuild** in `rebuildEntityGraph` (`worker.js`): compute the desired graph
   as today (`entity_graph.js` unchanged), upsert addresses/projects/people_orgs/neighborhoods by natural
   key (`normalized_address`, project `slug`, `normalized_name`) instead of `DELETE` + `INSERT`, and
   `UPDATE permits` only where the link differs from what is stored. Delete only entities no longer in the
   graph. No `UPDATE permits SET address_id = NULL`. Steady-state work scales with changed permits, not total
   permits; a mid-run failure leaves the previous complete state intact; row ids become stable. Needs
   additive unique indexes (`migration_entity_unique_keys.sql`).
2. **Preserve project slugs** like address and org slugs today (pass the stored project slug set into
   `buildEntityGraph`), so a project URL cannot change because its cluster did (E11).
3. **Make failure visible:** `rebuildEntityGraph` returns `{expected_linked, linked, unlinked}`;
   `runScheduledIngest` logs `partial`/`error` when `unlinked > 0` or the rebuild throws (instead of
   `success`); `/admin/entity-report` and `scripts/check_seo_health.mjs` report the same number.
4. **Do not answer 410 on an uncertain graph:** `/address/:slug` returns 410 only when the address has no
   permits *and* an integrity check passes; on error or `unlinked > 0` it returns 503 + `Retry-After` +
   `no-store`. Fix the false 410 copy.

Files: `worker.js` (`rebuildEntityGraph`, `runScheduledIngest`, `renderAddressPage`, `entityGraphReport`),
new `migration_entity_unique_keys.sql`, `scripts/check_seo_health.mjs`, tests. Untouched: `entity_graph.js`
slug/clustering logic, `MULTI_PERMIT_PROJECT_SQL`, sitemap generators, canonical/robots/JSON-LD output.

**URL compatibility / migration:** no URL changes. Existing address, org and (now) project slugs are
preserved; the only status changes are valid addresses that today flap to 410 returning 200 continuously.
Nothing redirects, so there is no redirect table to migrate.

## 7. Evaluation — what can and cannot be shown

**A URL-level holdout is not available for this fix.** The defect hits every address page equally and the
fix is global; holding half the addresses on a destructive rebuild would mean deliberately keeping the
bug. Instead, success is judged mechanically and by difference-in-differences against the sibling
properties:

| Metric | Baseline (measured) | Target |
|---|---|---|
| Valid `/address/*` 410s per night (zone analytics, minute-level, 12:55-13:20 UTC) | 410s in the 13:00 hour (the only hour with any, 10-15..10-20): 1, 10, 5, 9, 42, 14; humans and bots | 0 |
| Days on which the rebuild leaves unlinked permits (D1 `COUNT(address_id IS NULL)`) | 1 of 7 observable days (10-21): 6,731 | 0; any non-zero logs `partial` |
| Address sitemap URLs vs expected | 12,026 normal; 7,050 on 10-21 | equal every day |
| Ingest log status when rebuild fails | `success` (wrong) | `partial`/`error` |
| Googlebot-UA 410s on valid entity pages (zone analytics) | 24 in retained week | ~0 |
| Googlebot crawl allocation by template (E13) | address 42.5% / project 37.4% / permits 17.4% / contractor 1.8% (09-21..10-18) | report only; no target without index-state labels |
| GSC impressions and clicks on existing URLs | trailing 4 wks: address 382 impr / 9 clk, permits 365/21, project 44/2, contractor 163/6 | no relative decline vs siblings > 20% |
| Indexing rate, crawled-/discovered-not-indexed rate, indexed sitemap ratio | **[B]** | cannot be judged until Page Indexing / URL Inspection access exists |

**Power:** the exposure being removed is roughly 7 minutes a day plus one failure day in seven. Googlebot
saw 2 window hits and 22 failure-period hits. That is too small to produce a detectable change in index
state at BuildingSeattle's impression volume (~1.7 impressions per URL per 28 days). The honest framing is
a reliability fix with a clean mechanical pass/fail, **not** an indexing intervention. If you want an
indexing experiment, it needs the Page Indexing labels first and a different treatment (for example,
canonical-duplicate project crawl share, section E13).

## 8. Test, rollback

**Tests [P]** (`node --test tests/*.test.js`, `pytest tests/` in CI): rebuild at 15k-permit scale links
100% (reuse `scripts/seo_investigation/rebuild_local.mjs`); a second rebuild is a no-op with identical ids and
slugs; failure injected at relink batch N leaves every previous link intact; project slugs stable when a
cluster gains a permit; `/address/:slug` returns 410 only with a good integrity check, else 503 +
`Retry-After`; `runScheduledIngest` logs `partial` on a thrown rebuild; golden test that canonical/robots/
JSON-LD/sitemap output is byte-identical for a fixture of existing URLs; every one of the 5,268 GSC URLs
resolves to the same status class as in a healthy run.

**Rollback [P]:** the unique-key migration is additive (`DROP INDEX`); behavioural rollback is a revert of
`worker.js`; stale links are harmless to the old code, which rebuilds them. Bump `HTML_CACHE_VERSION` on
deploy and rollback so cached 410s/200s do not linger.

## 9. Decisions and inputs needed

1. **Approve implementing section 6** (items 1-4)? I recommend yes: it removes a measured defect. The
   deploy path looks like GitHub auto-deploy from `main` (script modified 03:48 UTC, after #81 merged at
   02:34 UTC); please confirm I may push and merge via PR.
2. **GSC API access (`webmasters.readonly`) or fresh Page Indexing per-URL exports** — the only route to
   the actual question (why Google selects some entities).
3. Cloudflare is connected; nothing further needed there. A read-only verification is scheduled for
   13:15 UTC today to confirm the 13:00 run heals the orphans.

## 10. Reproduction

`scripts/seo_investigation/` (README). Cloudflare queries used: D1 `SELECT` counts of `permits` /
`addresses` / `sqlite_sequence` / `ingest_logs` / `page_views`; Workers Logs events with needle
`Entity graph rebuild failed` in a narrow window around each 13:00 UTC cron; GraphQL
`httpRequestsAdaptiveGroups` filtered to `edgeResponseStatus: 410` by minute; deployed bundle via
`workers_get_worker_code` diffed against `worker.js` after normalization. Verified this session:
`permit_features.py` reproduces E10; the local rebuild harness reproduces E5. Not verified: the packaged
scripts end-to-end from a clean checkout.
