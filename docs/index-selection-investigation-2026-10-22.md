# Index-selection investigation — findings and fix (2026-10-22, rev 5)

**Status: investigation complete to the limit of reachable inputs. Rev 5 implements the section 6 fix in code
(branch `claude/entity-rebuild-incremental`); it is tested locally, not merged, not deployed, not verified in
production.** Rev 2 used Cloudflare D1, Workers Logs and zone analytics and disproved two of rev 1's claims (section 0).
Rev 3 added the Search Console Coverage and Performance exports of 2026-10-21 (section 3b).
Rev 4 adds the per-URL drilldown exports of the same date (section 3c), which let me test the noindex lead
and build the crawled-not-indexed and discovered-not-indexed cohorts.
Rev 5 records the 2026-10-22 heal check and the implementation of section 6 (section 6a).

Labels: **[M]** measured · **[I]** inference · **[H]** untested hypothesis · **[X]** falsified (a mechanism contradicted by direct evidence) · **[U]** unresolved: no support in the current evidence, not ruled out · **[B]** blocked ·
**[P]** proposed, not implemented · **[C]** implemented in code and covered by tests run locally (`npm test`); not deployed.
Nothing below is labelled passed-in-CI, deployed, or externally verified, because none of it is.

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
5. **Ingest run duration is not a failure signal** (I briefly suspected the 184 s run on 09-21). Durations range
   33-711 s all summer and the healed 10-15 run took 133 s.

6. **The 2026-10-22 13:00 UTC run healed the 10-21 failure on its own. [M]** After the run: D1 shows 15,273
   permits, 0 with `address_id IS NULL` (was 6,731), 0 addresses without permits (was 4,976), 12,055 addresses,
   12,582 projects; latest `ingest_logs` row id 1213 `success` at 13:06:23. Workers Logs for 12:58-13:25 UTC has
   `Scheduled ingest complete: 42 added, 4958 updated, 0 alerts sent` and no `Entity graph rebuild` error event.
   Zone analytics, all 410s by minute (not path-filtered, all clients): 16 between 12:51 and 12:58 (the unhealed
   10-21 state), 31 between 13:00 and 13:05 (the rebuild window, peaking at 11 in 13:03), none from 13:06 to 14:00.
   The run ended 13:06:23. So the window was observed again and 410s stopped when the run finished. This fits the
   verdict below: the defect is intermittent (one failed run in the 7 observable days) while the destructive window
   recurs every night.

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
2. **Indexed pages are declining, modestly, and the growing sink is Google's selection, not our status codes. [M]**
   Coverage export (chart 07-23..10-11, reasons as of 10-21): Indexed 28,201 -> 25,757 (-8.7%), Not indexed
   10,014 -> 13,194 (+32%). 62% of the loss is one step (-1,514 on 09-21) that no deployment (none between
   09-05 and 09-25) explains. Since 09-27: Indexed -1,899; *Crawled - currently not indexed* +1,649;
   *Discovered* -2,045; *Not found* +201; *Alternate canonical* +56. The bucket that grew is crawled-not-indexed,
   not 404/410, so the nightly 410 window and the 10-21 failure cannot account for it (and the chart ends
   10-11, before 10-21).
3. **At least 1,644 listed URLs are excluded although the pages are valid today, and the timing implicates our own
   transient states. [M] for the facts, [I] for causation.** From the per-URL drilldowns (listed URLs, section 3c):
   - *Excluded by noindex* (1,252; 1,000 listed): 994 of the 1,000 are valid pages now (987 once the 7 single-permit
     project URLs, which are canonicalized duplicates and correctly not indexed, are set aside), and for **all 980
     valid addresses the permits were already in the database before Google's last crawl** (721 crawled 06-19/20).
     Before #77 an address with no linked permits was served as 200 + `noindex`, which is what the nightly
     rebuild window or an incomplete graph produces.
   - *Not found (404)* (791 listed): **664 (84%) exist today** - 475 permit pages crawled 05-12/13 *before their
     database rows existed* (rows created 05-14 07:32) and never retried; 156 addresses crawled in Sep-Oct with
     permits present; 25 neighborhoods crawled in June (re-created nightly); 8 projects (7 of them single-permit duplicates). Only 127 are gone,
     mostly regenerated project slugs.
   - Together **1,644 listed URLs (987 noindex + 657 not found; 6.4% of the 25,757 indexed count) are measured
     candidates** for recovery by fixing the cause
     and then prompting a recrawl. If the 252 noindex URLs hidden by the export cap resemble the listed ones the
     total would be about 1,900 (7.4%); that is an extrapolation, since Google's capped list is not known to be a
     random sample. Per-URL causation is inferred from timing, not proven.
4. **In the exported samples, the crawled-not-indexed and discovered rows look like Google's selection and a
   crawl backlog, not defects; the unexported rows are unexamined. [M] for the samples, [H] beyond them.**
   Only 1,000 of 6,481 *Crawled - not indexed* and 1,000 of 4,607 *Discovered* URLs were exported, and Google does
   not say how the cap picks them, so these findings describe the listed rows only. (The noindex and 404 buckets show
   that unexamined rows can hide defects: those looked fine in aggregate until the URLs were checked.)
   *Crawled - not indexed (1,000 listed):* 93% permit pages, 96% last crawled in July (959; median 07-06) and not
   revisited in 3.5 months. Against permits that have impressions (a proxy for indexed - see the caveat in 3c),
   once matched on permit-number decile no content feature separates them (observed AUC <= 0.60; about 0.62 if 16% of the proxy group is itself CNI, an estimate that assumes the
   capped list is representative - see the sensitivity in 3c); the raw gap is permit age (AUC 0.71) because the July sweep reached older
   permits. 46 of 929 listed CNI permits (5%) earned impressions earlier, so they were indexed and then dropped.
   *Discovered (1,000 listed):* never crawled; permits, addresses and projects, the permits being the newest
   (36% enriched vs 99.8%) - consistent with a backlog of new URLs, not a quality verdict.
   Not tested for the other ~5,500 CNI and ~3,600 discovered URLs: a full export or the URL Inspection API is needed.
   The 09-21 step (all five buckets, daily charts) is a whole-bucket fact and does not depend on the samples.
5. **The defect does not explain the decline in URLs with impressions. [M]** That decline (-44%, 4-wk average) is
   common-mode: sibling properties in the same Cloud project fell 62-87% over the same weeks. Googlebot's
   own crawl log shows why a decay is expected: 35,554 requests in the two weeks of Jun 8 and Jun 15 (an
   initial sweep of the newly published entity pages), 667 the week after, low thousands since.
6. **"Survivors rank unusually well" is query mix. [M]+[I]** 87% of impressions and 334/338 clicks are on
   anonymized (rare) queries at position 7.75; named queries rank 44-64. Retracted from rev 0: "average
   position improved" came from the site table's `sum_top_position`, a different metric.
7. **There is no data basis to build an indexability score yet. [U]** No permit-level feature separates URLs with impressions
   from those without (best AUC 0.576), and the indexed-vs-crawled-not-indexed comparison is limited by its impression
   proxy (section 3c), so entity weakness is unresolved rather than ruled out. Without a signal there is nothing to
   derive thresholds from; revisit with the Indexed list or URL Inspection labels.
8. **Narrower, but still open [B]:** which entities Google rejects and why. The Coverage export is
   now covers noindex, crawled-not-indexed, 404 and discovered (1,000-row cap each). Still missing: the **Indexed**
   list, the remaining 252 noindex URLs, the Sitemaps report and URL Inspection API, so a true indexed-vs-rejected
   comparison is limited to permits with impressions as the 'indexed' proxy.
9. **Defensible change:** make the rebuild non-destructive and incremental, and stop reporting a failed
   rebuild as success. That is justified by measured correctness defects, and it is now tied to a concrete
   recoverable cohort (item 3). **It is not claimed to reverse the overall indexed-URL decline** (item 4); the
   recovery is bounded by 1,644 measured URLs (about 1,900 if extrapolated; section 6, 'Recovery sequence').

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
| GSC Coverage + Performance UI exports (2026-10-21, uploaded) | **Reached.** Coverage: daily Indexed/Not-indexed chart 07-23..10-11 and reasons table; summary only, no URL lists. Performance: 91-day chart, Pages (1,000 rows), Queries (named only). |
| GSC Page Indexing per-URL drilldowns (2026-10-21, uploaded): noindex 1,000 of 1,252; crawled-not-indexed 1,000 of 6,481; not found 791 of 791; discovered 1,000 of 4,607; alternate canonical 56 of 56; each with its own daily chart | **Reached** (capped at 1,000 rows each). |
| Indexed per-URL list; Sitemaps report; URL Inspection API | **[B]** |
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

- **E14 [M]** `ingest_logs` has no scheduled-run row on 2026-09-22 and 2026-09-29 (cron skipped or invocation
  died before logging; graph state those days unknown) and none for 2026-06-18..07-08. Run duration is not a
  failure proxy (E-correction 5).
- **E15 [M]** UI Performance export (07-20..10-19: 194 clicks, 5,581 impressions) matches the BigQuery **site**
  table (194, 5,583). The BigQuery **url** table sums to 7,500 impressions / 203 clicks because it counts per URL;
  use the site table for site totals. UI weekly clicks are flat (~15/week, range 6-21) while impressions fell
  523 -> 327/week.

- **E16 [M]** Drilldown lists vs this analysis (`drilldown.py`): see section 3c for validity-today and crawl-timing
  counts per bucket.
- **E17 [M]** Share of Googlebot-UA requests landing in the 10 minutes after 13:00 UTC (the rebuild window), by month:
  Jun 695/39,799 (1.7%), Jul 179/15,112 (1.2%), Aug 13/3,175, Sep 47/5,373 (0.9%), Oct 69/8,388 (0.8%) - against
  0.7% if crawling were uniform over the day. 1,003 hits since June, 432 of them on `/address/*`.

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

## 3b. Index-state evidence from the uploaded Coverage and Performance exports

**Daily series (Coverage chart, summary-level):**

| Date | Indexed | Not indexed | Known (sum) | Note |
|---|---:|---:|---:|---|
| 07-23 | 28,201 | 10,014 | 38,215 | start of series |
| 09-18 | 27,656 | 13,277 | 40,933 | gradual: Indexed -602, Not indexed +2,813 in 8 weeks |
| 09-21 | 26,142 | 12,533 | 38,675 | **step: Indexed -1,514, Not indexed -744, known -2,258** |
| 10-09 | 25,757 | 13,194 | 38,951 | Indexed -347, Not indexed +494 on 10-09; flat to 10-11 |

Total change 07-23 -> 10-09: Indexed -2,444 (-8.7%), Not indexed +3,180 (+32%). Excluding the 09-21 step the
Indexed decline is -930 (-3.3%). The step is not explained by any deployment (Worker deployments: 09-05, then
09-25) or by a logged event; it looks like a Google-side re-evaluation and removal from the known set [I].

**Reasons, 09-27 (earlier report) vs 10-21 (this export):**

| Reason | 09-27 | 10-21 | Change |
|---|---:|---:|---:|
| Crawled - currently not indexed | 4,832 | 6,481 | +1,649 (+34%) |
| Discovered - currently not indexed | 6,652 | 4,607 | -2,045 (-31%) |
| Not found (404) | 590 | 791 | +201 |
| Excluded by 'noindex' | 1,196 | 1,252 | +56 |
| Alternate page with proper canonical | 0 | 56 | +56 |
| Redirect / robots | 6 / 0 | 6 / 1 | 0 / +1 |
| **Not indexed total** | 13,277 | 13,194 | -83 |
| **Indexed** | 27,656 | 25,757 | -1,899 (-6.9%) |

Shares of known URLs (38,951) on 10-11: indexed 66.1%, crawled-not-indexed 16.6%, discovered-not-indexed 11.8%,
noindex 3.2%, 404 2.0%. The reasons sum to exactly the chart's last Not-indexed value (13,194).

**Reading:** the Indexed losses went mainly into *Crawled - currently not indexed* (+1,649) rather than
404/410 (+201), i.e. Google fetched pages and declined to keep them. The discovered bucket shrank by 2,045,
consistent with commit #77 (09-29) removing ~9,800 never-crawled single-permit project URLs from the sitemap
[I]; only 56 have reached "Alternate canonical" so far. The three largest index-loss weeks (wk of 08-03,
-307; 09-21, -1,514; 10-05, -347) fall at or just after the three biggest recent Googlebot crawl weeks (07-20:
5,675; 09-21: 2,969; 10-05: 3,288). With n=3 that is an observation, not evidence; the weekly correlation
over 10 weeks is weak and driven by the 09-21 step.

**The noindex lead (tested in section 3c).** 1,252 URLs (about 99% addresses by the earlier report) are
"Excluded by noindex". Until commit #77, `renderAddressPage` returned **200 with `noindex`** whenever an address had
no linked permits, which is exactly what a valid address looks like during the nightly rebuild window or a failed
run. Googlebot swept addresses on 2026-06-12 (8,111 address requests, 7,828 of them 13:00-17:00 UTC, 374 inside
the first 12 minutes of the 13:00 hour) and again on 06-19/20 (442 + 709 requests, about the size of the
1,196-URL bucket). If the graph was incomplete when those pages were fetched, valid addresses were recorded as
noindex and, per the earlier report, not recrawled since. I cannot see the graph state in June directly; section 3c
tests the lead against the exported list.

## 3c. Per-URL drilldowns (Coverage exports, 2026-10-21)

Lists are capped at 1,000 rows, so noindex (1,252), crawled-not-indexed (6,481) and discovered (4,607) are
samples; Not found (791) is complete. "Valid today" means the URL exists in the expected entity graph / permit set
(an address is valid if it has at least one permit now).

| Bucket (listed) | Templates | Valid today | Last crawled |
|---|---|---|---|
| Excluded by noindex (1,000) | address 986, project 7, neighborhood 7 | 994 (99.4%) | 06: 877, 07: 55, 09: 66, 10: 2 |
| Crawled - not indexed (1,000) | permits 929, contractor 48, project 16, address 5 | 948 of 948 checkable (contractor, api, insights, hub pages cannot be checked) | 07: 959 (median 07-06), 08: 17, 09: 5, 10: 19 |
| Not found (791) | permits 475, address 192, project 96, neighborhood 25, other 3 | **664 (83.9%)** | 05: 472, 06: 35, 07: 49, 08: 22, 09: 107, 10: 101 |
| Discovered (1,000) | permits 473, address 400, project 76, contractor 45, other 6 | 952 of 953 checkable | never crawled |
| Alternate canonical (56) | project 56 | 56 | 09-29 .. 10-09 |

**Noindex.** 980 of 986 listed addresses are valid; the first permit at every one of them was created in the
database (2026-05-14 .. 06-17) **before** the date Google last crawled it, and 721 were crawled on 06-19/20. A page
with permits present only renders as empty-and-`noindex` if the permit link was missing at that moment. The 06-12
sweep overlaps the rebuild's 13:00 UTC start (374 requests in the first 12 minutes), but the 06-19/20 crawl does
not (3 requests a day in the window), so for the 721 pages crawled then an incomplete graph on those days - as on
10-21 - is the more likely cause. `ingest_logs` has no scheduled rows for 06-18..07-08 (E14), so I cannot see that
period's graph state; this stays an inference.

**Not found.** The 475 valid permit pages were crawled 05-12/13; their database rows have `created_at` 2026-05-14
07:32:07-10, so Google got a genuine 404 for pages that did not exist yet and has not retried in five months.
The 156 valid addresses were crawled in Sep-Oct with permits in the database; the nightly rebuild deletes and
re-inserts `addresses` (E8) and `safeFirst` turns any D1 error into "not found", either of which yields a 404 on a
valid page. The 25 neighborhoods (all crawled in June) are deleted and re-created nightly. 88 of the 96 project
404s are genuinely gone (regenerated slugs, E11).

**Crawled - not indexed vs indexed vs discovered, permits only** (A = URL has impressions, 1,604; B = listed
crawled-not-indexed, 881 after removing 46 that also have impressions; C = listed discovered, 473):

| Comparison | Raw AUC (age is a confound) | Matched on permit-number decile |
|---|---|---|
| A vs B: permit age (applied date) | 0.709 | 0.602 |
| A vs B: value / description length / status active | 0.576 / 0.535 / 0.603 | 0.572 / 0.524 / 0.568 |
| A vs B: contractor present / enriched | 0.446 / 0.499 | 0.470 / 0.500 |
| A vs C: detailed description / enriched / contractor | 0.826 / 0.818 / 0.699 | 0.782 / 0.770 / 0.663 |

**Proxy caveat.** A is "has at least one impression in 140 days", not "currently indexed". The CNI list is capped at
1,000 of 6,481, so impression-bearing URLs among the other ~5,100 CNI permits are still counted in A. Estimate: 46 of
929 listed CNI permits (5.0%) have impressions; if the unlisted ones match, about 252 of the 1,604 permits in cohort A (16%), after the 46 known overlaps are
excluded, would themselves be currently CNI. That is an assumption, since the capped list is not known to be representative.
Contamination pulls the observed AUC toward 0.5. With a fraction c of A that looks like B,
true AUC = (observed - 0.5c) / (1 - c). **This is a sensitivity analysis, not a bound**, because c is unknown and
nothing here limits it: for an observed 0.60 the true value is 0.62 at c = 0.16 (the estimate above), 0.64 at
c = 0.30 and 0.70 at c = 0.50. So the matched comparison cannot rule out a content separation; it shows only that
none is visible in this proxy at the estimated contamination. A clean indexed-versus-rejected comparison needs the
Indexed export or URL Inspection labels.

In the proxy comparison A and B show no content separation beyond a matched AUC of 0.60 once age is matched. C differs from A on enrichment (36% vs 99.8% enriched,
median detailed description empty) because C is the newest permits (permit numbers 7.15M median vs 7.09M),
fetched into the sitemap before the daily enrichment run. Within the listed rows C looks like a discovery lag, not a quality signal.

**The 09-21 step by bucket (daily charts):** Discovered -2,273, Crawled-not-indexed +1,306, Not found +156,
noindex +58, Alternate canonical +9, Indexed -1,514. Google processed a batch of previously uncrawled URLs and
at the same time removed 2,258 URLs from the known set. No deployment or logged event coincides.

## 4. Hypothesis scorecard

| Hypothesis | Result |
|---|---|
| **URL churn** (entities get new slugs; old URLs 404) | **Small [M].** 28 project slugs and 9 addresses (E11); ~10 Googlebot-relevant 404s in the last week. Larger real churn is *transient status flapping* (E3, E6), not slug change. |
| **Entity weakness** | **No support in the current evidence for permits, not ruled out [U]** (E10; matched A-vs-B AUC <= 0.60 in a contaminated proxy, section 3c). Untestable for addresses/projects [B]. |
| **Near duplication** | **Partly structural [M].** Single-permit project = address content (handled by #77). No fingerprints collected for the rest [H]. |
| **Internal authority** | **Untested directly [H].** Link status shows no meaningful permit-level effect (E10). |
| **Inventory overload** | **Consistent, not proven [I].** E13: 37% of crawl on a template of mostly canonical duplicates; Googlebot crawl collapsed after the June sweep. Needs index-state labels to test. |
| **Sitemap selection** | **Brittle [M].** Address sitemap membership equals "has a linked permit", so it changes with the rebuild's success: 12,026 on a normal day, 7,050 after 10-21. Permit sitemap includes all 15,232 regardless of features. |
| Premise: indexed population declining | **Confirmed, modest [M].** Indexed -8.7%, Not indexed +32% (07-23 -> 10-09/11); one step explains 62%. Proxy (URLs with impressions) -44%, less than all three siblings. Sibling Coverage trends not available [B]. |
| Premise: survivors rank unusually well | **Query mix [M]+[I].** |

## 5. Rejected alternatives

- **Mass `noindex`, sitemap pruning, canonical or redirect changes:** not recommended now. The data show no feature
  that separates accepted from non-accepted URLs (E10, 3c), so a rule would have no evidence-derived thresholds. This
  is an absence of support, not proof that no separating feature exists; it can change with clean index labels.
- **An "indexability score":** not built, for the same reason; the brief requires thresholds derived from observed data.
- **"Constant cap / shrinking call-budget" explanations of the linking failure:** disproved by E2-E5
  (single failed run; no platform limit; code links 100%).
- **Platform-limit explanation (subrequests, CPU):** disproved by E5.
- **Redirecting 410 addresses:** they are valid pages; the right fix is to stop serving 410 for them.

## 6. The fix (proposal; implementation status in 6a)

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

Files (as proposed): `worker.js` (`rebuildEntityGraph`, `runScheduledIngest`, `renderAddressPage`, `entityGraphReport`),
new `migration_entity_unique_keys.sql`, `scripts/check_seo_health.mjs`, tests. Untouched: `entity_graph.js`
slug/clustering logic, `MULTI_PERMIT_PROJECT_SQL`, sitemap generators, canonical/robots/JSON-LD output.
What was actually built differs in four places; see 6a.

**URL compatibility / migration:** no URL changes. Existing address, org and (now) project slugs are
preserved; the only status changes are valid addresses that today flap to 410 returning 200 continuously.
Nothing redirects, so there is no redirect table to migrate.

**Recovery sequence for the 1,644 valid-but-excluded listed URLs [P].** Ordering matters: prompting a recrawl before the
rebuild is fixed would let the next nightly window re-poison the same pages.
1. Deploy section 6 items 1-4.
2. Require 7 consecutive healthy nights: zero 410/404 on valid `/address/*` and `/neighborhood/*` in the 13:00
   window (zone analytics) and `unlinked = 0` after every run.
3. Then split the recoverable cohort (valid today, listed in the noindex or 404 bucket, and sitemappable - single-permit projects are canonicalized
   duplicates and excluded (14 URLs): **1,644 URLs**,
   `drilldown.py`, recipe `sha256("bs-recrawl-2026-10|" + path)` alternating within bucket x template) into
   **824 nudge / 820 natural**. Balance (nudge/natural): noindex address 490/490, 404 address 78/78, 404 permits
   238/237, 404 neighborhood 13/12, noindex neighborhood 4/3, 404 project 1/0; last-crawl months match. Nudge = raise `<lastmod>` for those URLs in
   the sitemap (the only per-URL lever; do not use bucket-level "Validate fix" for either arm). Natural = leave alone.
4. Judge at day 28: primary = share of each arm whose URL Inspection verdict is Indexed **[B: needs the API]**;
   fallback = exit from the bucket in a fresh export, valid only while the bucket lists under 1,000 rows (noindex does
   not yet, 1,252), so that fallback is unreliable for noindex. At about 830 per arm and a 10% base rate the
   minimum detectable difference is about 4 points.

## 6a. Implementation status (rev 5) [C]

**Changed files:** `worker.js`, `entity_graph.js`, `scripts/entity_report.mjs`, `tests/entity_rebuild.test.js` (new),
`tests/entity_graph.test.js`, `tests/empty_address.test.js`. Untouched: sitemap generators, canonical/robots/JSON-LD,
`MULTI_PERMIT_PROJECT_SQL`, all other page templates, cron schedule, wrangler config.

1. **Incremental rebuild [C].** `rebuildEntityGraph` computes the graph exactly as before, reads the stored rows
   (errors now throw; the old `safeAll` swallowed them), and applies a diff in this order: insert/update entities ->
   relink only permits whose stored link differs -> add/remove join rows -> delete entities nothing references
   (guarded by `NOT EXISTS`) -> verify against the database. It never writes `address_id = NULL` and never deletes
   a row before its replacement exists. Surviving rows keep their ids. It refuses to run (throws) if the permits read
   is empty while entities exist. A membership change (insert the new join row, delete the old one) is committed in
   one D1 batch per owning permit/project/address, so a failure leaves each owner with its old rows or its new rows,
   never both; relinks are still applied in 50-statement batches (see the residual-risk note below).
2. **Project slugs [C].** `buildEntityGraph` takes `projectSlugByPermit` + `reservedProjectSlugs`: a project inherits
   the stored slug of the project that held most of its permits (largest overlap first, each slug claimed once);
   the rest mint as before and cannot collide with a stored slug. Falls back to `project_permits` for permits whose
   own link was lost. Neighborhood slugs are preserved by name the same way. With no options the output is unchanged.
3. **Failure visible [C].** The result now carries `ok`, `expected_linked`, `linked`, `unlinked`, `project_unlinked`
   and per-table `changes`, measured from the database after the run. Cron and `POST /admin/build-graph` write an
   `ingest_logs` row with `run_type = 'entity_graph'` and status `success` / `partial` / `error`; the admin route
   answers 500 unless `ok`. `ok` means every permit in the snapshot read at the start is linked; the result also
   carries `snapshot_stale` (permit count moved during the run, e.g. an ingest route inserted a permit), and
   such permits wait for the next run, as every permit written by `/ingest/*` already did (those routes never
   link). Edits to an existing permit's address during a run are not detected. `/admin/entity-report` gains an `integrity` block (null, not 0, when a check query fails)
   and `scripts/entity_report.mjs` prints `permits without address link`.
4. **No 410 on an uncertain graph [C].** `/address/:slug` answers 503 + `Retry-After: 3600` + `Cache-Control: no-store`
   when the address lookup or permit read throws, or when an address has no permits while any permit is still
   unlinked or the latest `entity_graph` rebuild ended `error`/`partial` (it may have stopped part-way through
   relinking; no rebuild row yet counts as clean). 410 remains for a verified-empty address; 404 remains for an unknown slug. 503s are not edge-cached
   (only 200s are).

**Deviations from the section 6 proposal, and why**
- **No `migration_entity_unique_keys.sql`.** The diff is computed in JS from the stored rows, so no new index is
  needed and nothing has to be applied to D1 before deploy. Trade-off: two concurrent rebuilds (cron + manual POST)
  are not prevented by a constraint; the existing `slug UNIQUE` makes the loser fail loudly rather than corrupt.
- **Separate log row, not `partial` on the ingest row.** The homepage "last updated" and the ingest success rate
  read `status = 'success'`; marking the ingest `partial` because the graph failed would make fresh permit data
  look stale. The graph outcome is its own row instead. Because every reader of `ingest_logs` would otherwise
  count those rows, the homepage and permits-page freshness queries and the admin stats (last run, 24h growth,
  success rate) now exclude `run_type = 'entity_graph'`; the admin log list still shows them. Found while
  auditing the change (a manual `/admin/build-graph` would have refreshed "last updated", and a first rebuild
  would have added its 12k new addresses to "24h growth"); covered by a test.
- **`scripts/check_seo_health.mjs` unchanged.** It already requires HTTP 200 on sampled sitemap pages, which a false
  410/503 on a sampled address would fail; the unlinked count is exposed by `/admin/entity-report` and
  `entity_report.mjs` instead.
- **`HTML_CACHE_VERSION` not bumped.** No 200-page template changed, and error responses are never cached.

**What the tests show (local, `npm test`: 173 pass, 0 fail) [C]**
- `tests/entity_rebuild.test.js` runs the real rebuild on SQLite with the production schema: first run links 100%;
  a second run issues zero writes and keeps every id and slug; after every committed batch no permit that was linked
  before is unlinked or dangling; a D1 error injected at the first relink leaves every prior link and address id/slug
  intact, logs `error`, and the next run heals; relink statements silently dropped -> `partial`, HTTP 500; empty
  permits read -> refuses, graph untouched; project slug survives a rename and an earlier destructive run.
- Against the pre-change `worker.js` all 9 fail (some only because the old result lacks the new fields, so this
  is a weak check); with only project-slug preservation disabled, the three slug-dependent tests fail (measured).
- `tests/empty_address.test.js`: 410 only with a clean integrity check; 503 on pending unlinked permits, on a failed
  address lookup, permit read or integrity read; unknown slug still 404.
- At the real 15,231-permit scale (scratchpad copy of the live permits, SQLite shim, **not D1**): first run
  links 15,231/15,231 with 1,694 D1 round trips and 83,763 write statements (about what the old nightly run did every night);
  an unchanged rebuild takes **11 round trips and 0 writes**; healing a third of permits unlinked rewrites only those
  5,070 links; a fully wiped graph rebuilds to 15,231/15,231 with identical addresses.

**Not done:** no CI run, no deploy, no production run, no measurement against live D1. D1 timing, batch limits and
Worker CPU for the first post-deploy run are untested (that run does the same work as the old nightly rebuild).
Project and neighborhood pages still use `safeFirst`, so a D1 outage there still yields 404 rather than 503; out of
scope here because the false-410 defect was on address pages.

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
| Site-level index state (Coverage, 10-11): indexed / crawled-not-indexed / discovered-not-indexed / 404 / noindex | 25,757 / 6,481 / 4,607 / 791 / 1,252 (66.1% / 16.6% / 11.8% of 38,951 known) | the reliability fix makes no indexing claim; watch 404 and noindex buckets for movement |
| Valid-but-excluded URLs listed in noindex + 404 buckets (section 3c) | 987 noindex + 657 not-found = 1,644 listed (about 1,900 if the 252 unlisted noindex URLs resemble the listed ones: extrapolation) | falling; judged by the nudge-vs-natural recrawl test in section 6 |
| Per-URL index rate; per-sitemap indexed ratio | **[B]** | needs URL Inspection API or the Sitemaps report |

**Power:** the exposure being removed is roughly 7 minutes a day plus one failure day in seven. Googlebot
saw 2 window hits and 22 failure-period hits. That is too small to produce a detectable change in index
state at BuildingSeattle's impression volume (~1.7 impressions per URL per 28 days). The fix itself is a
reliability change with a clean mechanical pass/fail. What *can* be tested against Google is the recovery of
the recoverable cohort (section 6): nudge versus natural recrawl, which does allow a real holdout.

## 8. Test, rollback

**Tests [P; the implemented subset is in 6a]** (`node --test tests/*.test.js`, `pytest tests/` in CI): rebuild at 15k-permit scale links
100% (reuse `scripts/seo_investigation/rebuild_local.mjs`); a second rebuild is a no-op with identical ids and
slugs; failure injected at relink batch N leaves every previous link intact; project slugs stable when a
cluster gains a permit; `/address/:slug` returns 410 only with a good integrity check, else 503 +
`Retry-After`; `runScheduledIngest` logs `partial` on a thrown rebuild; golden test that canonical/robots/
JSON-LD/sitemap output is byte-identical for a fixture of existing URLs; every one of the 5,268 GSC URLs
resolves to the same status class as in a healthy run.

**Rollback [P]:** no migration was added, so rollback is a revert of `worker.js` + `entity_graph.js`; the old
code rebuilds the graph from permits on its next run, and the extra `ingest_logs` rows (`run_type = 'entity_graph'`)
are harmless. Error responses are not cached and no 200 template changed, so no `HTML_CACHE_VERSION` bump is needed.

## 9. Decisions and inputs needed

1. **Merge and deploy the section 6 implementation (6a)?** Code is on a PR, not merged. The deploy path looks
   like GitHub auto-deploy from `main` (script modified 03:48 UTC, after #81 merged at 02:34 UTC), so merging
   deploys; that needs your explicit OK. After deploy, check that the first run logs `entity_graph / success`.
2. **Still needed from Search Console:** the **Indexed** URL list (1,000-row cap), the **Sitemaps** report (submitted
   vs indexed per child sitemap), and ideally URL Inspection API access, which would make the day-28 test in
   section 6 reliable. The drilldowns already received are in section 3c.
3. **Approve the recovery test** in section 6 (after the fix has 7 healthy nights)? It means editing sitemap
   `lastmod` for half of 1,644 URLs only.
4. Cloudflare is connected; nothing further needed there. The 10-22 heal check is recorded in section 0, item 6.

## 10. Reproduction

`scripts/seo_investigation/` (README). Cloudflare queries used: D1 `SELECT` counts of `permits` /
`addresses` / `sqlite_sequence` / `ingest_logs` / `page_views`; Workers Logs events with needle
`Entity graph rebuild failed` in a narrow window around each 13:00 UTC cron; GraphQL
`httpRequestsAdaptiveGroups` filtered to `edgeResponseStatus: 410` by minute; deployed bundle via
`workers_get_worker_code` diffed against `worker.js` after normalization. Verified this session:
`permit_features.py` reproduces E10; the local rebuild harness reproduces E5. Not verified: the packaged
scripts end-to-end from a clean checkout.
