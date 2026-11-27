# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Building Seattle** is a construction intelligence platform aggregating Seattle permit data and contractor information. It runs entirely on Cloudflare's edge infrastructure.

## Commands

### Cloudflare Worker (Backend)

```bash
# Local development server
npx wrangler dev

# Deploy to Cloudflare
npx wrangler deploy

# Read-only query against production D1
npx wrangler d1 execute buildingseattle --remote --command "SELECT COUNT(*) FROM permits"

# Fresh local database from the full schema
npx wrangler d1 execute buildingseattle --local --file schema.sql

# Schema changes: see "Database migrations" below
npx wrangler d1 migrations list buildingseattle --remote
```

### Python Data Pipeline

```bash
# Install dependencies (uses uv)
uv sync --extra dev

# Scrape latest permits from Seattle Open Data Portal
python sdci_scraper.py

# Import scraped permits into running worker (requires INGEST_API_TOKEN)
python direct_import.py

# Run Python tests (one file / one test)
uv run --extra dev pytest tests/
uv run --extra dev pytest tests/test_direct_import.py -k name
```

### JS Tests

```bash
npm test                                   # node --test tests/*.test.js
node --test tests/entity_graph.test.js     # single file
node --test --test-name-pattern="name" tests/worker.test.js   # single test
node --check worker.js                     # syntax check (CI runs this too)
```

CI (`.github/workflows/test.yml`) runs `node --check worker.js`, all Node tests, and pytest on every push. Secrets for local `wrangler dev` go in `.dev.vars` (gitignored).

Scheduled workflows (`enrich-daily`, `development-sites`, `data-freshness`) end with the reusable `.github/workflows/notify-failure.yml` job, which opens or comments on a `[Workflow failure] <name>` issue and closes it on the next success. `data-freshness.yml` runs `python3 scripts/check_freshness.py` daily against the public `/api/stats` (fails if `latest_record_date` is >4 days or `last_ingest_at` >36 h old). Third-party actions are pinned to full commit SHAs (Dependabot keeps them current); pass dispatch inputs through `env:`, never inline `${{ }}` in `run:`.

### Gumroad Dataset Build

```bash
# Rebuild every shipped dataset artifact (CSVs, dictionary, VERSION,
# CHANGELOG, Foundation/Pro ZIPs) from a fresh snapshot. Paid CSVs and ZIPs
# land in gitignored gumroad/dist/ — never commit them
python3 gumroad/build_dataset.py

# D1-snapshot source (drift-checked against live COUNT(*)); falls back to
# public API pagination if CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN unset
python3 gumroad/build_dataset.py --source api
```

## Architecture

### Stack

- **Runtime:** Cloudflare Workers (JS, edge-deployed)
- **Database:** Cloudflare D1 (serverless SQLite, bound as `DB`)
- **Data pipeline:** Python 3.10+ async scripts

### Core Data Flow

```
Seattle Open Data Portal (data.seattle.gov)
  → sdci_scraper.py        (fetch, normalize, write seattle_permits.jsonl)
  → direct_import.py       (POST batch to /ingest/permit)
  → worker.js              (ingest endpoints write to D1)
  → D1 database            (permits + contractors tables with joins)
  → web/API responses      (GET endpoints serve HTML or JSON)
```

### worker.js Structure

The backend lives in `worker.js` (~10,500 lines). Pure/shared logic is split into sibling modules: `entity_graph.js` (see Entity Graph), `adu.js` (ADU/DADU classification), `entity_hubs.js` (hub-page SEO config), `value_counting.js` (how permit values are summed: a valuation SDCI repeats across a project's demolition permits counts once; use `countedValueSql()` in any `SUM` of value), `brand_ui.js` (server-rendered design-system pieces: status pills, icons; styles in `public/brand/bundle.css`), `basis_reset.js` + `basis_reset_routes.js` (Basis Reset Radar, see `docs/basis-reset-radar.md`), `mcp.js` (MCP server at `/mcp`, tests in `tests/mcp.test.js`), and `security.js` (rate limits, Origin checks, Turnstile, API-key tiers, strict param parsing; tests in `tests/security.test.js`). `worker.js` contains:

- Path-based route dispatch at the top of `fetch()`
- **All HTML pages are inlined as template literals** — there is no separate templating engine or frontend build step
- SQL queries are built inline with parameterized bindings via the D1 `prepare().bind()` API
- CORS headers are added to every response
- `withHtmlEdgeCache` (helpers in `edge_cache.js`) caches public 200 HTML in `caches.default`. The key keeps only the query params a route reads (`HTML_CACHE_QUERY_PARAMS`; add a param there when a page starts reading one), plus the deploy version (`CF_VERSION_METADATA`), `HTML_CACHE_VERSION`, the development-sites flag and a data day that rolls over at 14:00 UTC. Pages with `max-age>=3600` live a day at the edge, shorter ones an hour. Non-200 (so never a 5xx), `no-store`/`private` pages and pages rendered from URLs with extra params are never stored. Noindex pages are stored only on the entity routes (`/address/`, `/project/`, `/contractor/`, `/neighborhood/`; `noindexIsCacheable`), whose noindex is publishing policy and which answer 503 + `no-store` when a deciding read fails; elsewhere (insights, `/permits`, hubs) a swallowed read error can render a noindex "no data" page, so those stay uncached. `/admin*` and `/api/admin*` are always `private, no-store` with no CORS.
- `page_views.js` owns first-party page-view logging: bots are skipped, humans sampled at `PAGE_VIEW_SAMPLE_RATE`, and its own cron (`30 9 * * *`, `PAGE_VIEW_RETENTION_CRON`; `scheduled()` dispatches on `event.cron`) prunes rows older than 90 days in bounded batches, never in the same invocation as the ingest.
- **Do not add non-function named exports to `worker.js`.** The Workers runtime rejects them and `wrangler dev` fails at startup. Constants/SQL fragments shared with tests go in a sibling module (this is why `adu.js` and `entity_hubs.js` exist).
- A daily cron (`0 13 * * *`, `scheduled()` in `worker.js`; any trigger other than the retention cron) ingests base permits, rebuilds the entity graph, and sends pending alerts. `.github/workflows/enrich-daily.yml` enriches permits an hour later (`scripts/enrich_unenriched.py`): new permits plus a bounded rotation of stale ones (status changed since the last enrichment, or still open and enriched >30 days ago; queue SQL in `scripts/enrichment_queue.py`). It posts to `https://buildingseattle.com` (override with `WORKER_URL`), never workers.dev.
- The base-feed ingest is incremental (`sdci_feed.js`): each run first reads the newest page by `applieddate DESC` and by `issueddate DESC` (so a new permit never waits for the sweep), then pulls records whose Socrata `:updated_at` moved since the last successful `scheduled` run (its start minus 2 h, keyset `:updated_at, permitnum`), then spends leftover page budget on a weekly full sweep (`run_type = 'full_sweep'`, keyset `permitnum`, applied dates since the earliest permit in D1). Both cap pages per run and resume from `ingest_logs.cursor`. Retries, a schema guard and a mapping guard fail a run loudly. Set the optional secret `SOCRATA_APP_TOKEN` (a data.seattle.gov app token) to send `X-App-Token` and get Socrata's higher throttle. If the incremental pull's first page looks like a full dataset replace (most rows share one `:updated_at` far past the watermark; `detectFullReplace`), the run logs `status = 'degraded'` with the reason in `error_message`, keeps no cursor, and spends the rest of its budget newest-first; older permits then refresh only in the weekly sweep. `degraded` counts as a completed run for planning and the "last ingest" labels; `/api/stats` reports it as `last_feed_status`, and `scripts/check_freshness.py` fails on it unless `FRESHNESS_ALLOW_DEGRADED=1`. The upsert (`permit_upsert.js`) only writes, and only bumps `updated_at`, when a tracked column changed, and never lets an older `source_updated_at` overwrite a newer row.
- There is no wipe endpoint: `POST /ingest/refresh` and `direct_import.py --replace-all` were removed (they let the shared ingest token delete production). Upserts are idempotent, so a re-sync is the next full sweep. To recover from bad data, restore D1 with Time Travel (`npx wrangler d1 time-travel info buildingseattle`, then `npx wrangler d1 time-travel restore buildingseattle --timestamp=<ISO time before the damage>`), then rebuild the graph.

Key routes:
| Route | Purpose |
|---|---|
| `GET /` | Landing page |
| `GET /api/permits` | Query permits (supports `?neighborhood=`, `?type=`, `?permit=`) |
| `GET /api/contractors` | List contractors with active project counts |
| `GET /api/stats` | Aggregate counts for dashboard |
| `GET /contractor/:slug` | Contractor detail page (curated `contractors` table, falls back to `people_orgs`) |
| `GET /address/:slug` | Address / property entity page |
| `GET /project/:slug` | Inferred project entity page |
| `GET /neighborhood/:slug` | Neighborhood entity page |
| `GET /data` | Gumroad dataset landing page (pricing, live stats, buy links) |
| `GET /sitemap.xml` | Sitemap index for all public page types |
| `GET /sitemaps/:section[-:page].xml` | Category child sitemap; dynamic sections split at 45,000 URLs |
| `POST /leads` / `/leads/batch` | Lead capture |
| `POST /ingest/permit` / `/ingest/permit/batch` | Data ingestion (requires `X-Ingest-Token`) |
| `POST /ingest/contractor` / `/ingest/contractor/batch` | Data ingestion (requires `X-Ingest-Token`) |
| `POST /ingest/permit/enrichment/batch` | Enrichment ingest from `scripts/enrich_unenriched.py` (requires `X-Ingest-Token`) |
| `POST /alerts/subscribe` | Per-permit status-change alert opt-in (double opt-in) |
| `GET /alerts/confirm` | Confirm alert subscription |
| `GET`/`POST /alerts/unsubscribe` | One-click unsubscribe (`List-Unsubscribe` compliant) |
| `GET /api/{status-changes,basis-reset,plan-review,pipeline,housing,adu-dadu,map,contractor-scorecards,network}` | JSON behind the `/insights/*` pages |
| `GET`/`POST /mcp` | MCP server (tools defined in `mcp.js`) |
| `POST /ingest/basis-reset` | Basis Reset event ingest (requires `X-Ingest-Token`) |
| `POST /admin/build-graph` | Rebuild the derived entity graph (admin auth) |
| `GET /admin/entity-report` | Entity-graph validation report JSON (admin auth) |

### Database Schema (schema.sql)

Core source tables: `permits`, `contractors`, `leads`. Permits reference contractors via `contractor_id`. Neighborhood and permit type are inferred/normalized at ingest time. `schema.sql` is the **complete** current schema (no seed rows); `tests/schema_migrations.test.js` fails if it differs from `migrations/0000_baseline.sql` plus every later numbered migration. Production enforces the schema's foreign keys (D1 default), e.g. a permit cannot be deleted while `project_permits` / `permit_participants` rows point at it.

### Database migrations

Schema changes use `wrangler d1 migrations` (`migrations_dir = "migrations"` on the `DB` binding in `wrangler.toml`; wrangler tracks applied files in the `d1_migrations` table).

- `migrations/0000_baseline.sql` is production's schema as read from `sqlite_master` on 2026-11-27 (idempotent `IF NOT EXISTS`). Production already has it; it is only *marked* applied there (bootstrap below).
- New change: `npx wrangler d1 migrations create buildingseattle <snake_name>` (creates the next `migrations/NNNN_<snake_name>.sql`), write additive/idempotent SQL, mirror it in `schema.sql` in the same commit, run `npm test`, then `npx wrangler d1 migrations apply buildingseattle --local` before `--remote`.
- Never edit a migration that production has applied; add a new one. Never run `schema.sql` or a migration file against production with `d1 execute --file`.
- `migrations/legacy/` holds the old hand-applied `migration_*.sql` files for history only (wrangler reads `migrations/*.sql`, not subdirectories). Its README says which ones production has; `migration_alert_watches.sql` was never applied and nothing uses it.

**One-time production bootstrap: run it BEFORE merging.** Pushing `main` deploys immediately, and the new code fails against an unmigrated database: the first cron dies on `no such column: cursor`, and the alert and keyed API routes return 500. Old code runs fine on the migrated schema. The full ordered release checklist, with every owner step and which ones are reversible, is `docs/deploy-runbook.md`. The database part, in order (do not run the baseline itself):

```bash
# 0. Restore point, plus pre-checks (see the runbook for details)
npx wrangler d1 time-travel info buildingseattle            # keep the bookmark
npx wrangler d1 export buildingseattle --remote --no-data --output prod-schema.sql   # diff against 0000_baseline.sql
npx wrangler d1 execute buildingseattle --remote --command "SELECT source_url, event_type, event_date, COUNT(*) FROM basis_reset_events GROUP BY 1,2,3 HAVING COUNT(*) > 1"   # must be 0 rows before 0001
# 1. Create wrangler's tracking table (same DDL wrangler uses) and mark the baseline applied
npx wrangler d1 execute buildingseattle --remote --command "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0000_baseline.sql');"
# 2. Confirm: 0000_baseline.sql must NOT be listed; 0001_hot_query_indexes.sql (and later) should be
npx wrangler d1 migrations list buildingseattle --remote
# 3. Apply the pending migrations (wrangler asks for confirmation)
npx wrangler d1 migrations apply buildingseattle --remote
# 4. Verify, then merge
npx wrangler d1 execute buildingseattle --remote --command "SELECT name, applied_at FROM d1_migrations ORDER BY id"
```

If step 2 lists `0000_baseline.sql`, stop: step 1 did not take, and applying would re-run the baseline (harmless because every statement is `IF NOT EXISTS`, but it should not be needed). The same rule holds for every later migration: apply it with `migrations apply --remote` before merging the code that needs it.

### Entity Graph

Permits are raw evidence. The primary user-facing entities are **addresses**,
**projects** (inferred clusters of permits at an address), **people_orgs**
(contractors/owners/applicants/architects), and **neighborhoods**. These derived
tables are linked from `permits` via `permits.address_id` / `permits.project_id`.

- Pure, testable derivation logic lives in `entity_graph.js` (`buildEntityGraph`,
  address/name normalization, slug generation, project clustering). Tests:
  `tests/entity_graph.test.js`.
- `worker.js` loads permits, runs `buildEntityGraph`, and persists the result in
  `rebuildEntityGraph(env)` — invoked after the scheduled ingest and via
  `POST /admin/build-graph`.
- The entity-graph tables are part of `schema.sql` / the migrations baseline (originally `migrations/legacy/migration_entity_graph.sql`).
- The rebuild is incremental and non-destructive: it diffs the desired graph against stored rows, relinks only
  changed permits, and deletes entities last, so a failure never unlinks live pages. Outcomes are logged in
  `ingest_logs` as `run_type = 'entity_graph'` (`running` while it works, then `success` / `partial` / `error`);
  `/address/:slug` answers 503 (not 410) for an address with no permits while any permit is unlinked or the
  latest rebuild is `running`, `error` or a `partial` that ended less than 6 hours ago
  (`PARTIAL_REBUILD_UNSETTLED_HOURS`). After that window a `partial` counts as settled and only permits written since
  it ended count as unlinked, so a rebuild that ends `partial` every day cannot hold entity URLs at 503 forever. Every entity route (address, project, neighborhood, contractor, hubs) answers
  503 + `Retry-After` + `no-store` when a read that decides its status or robots fails, and 404s an unknown slug only
  while the graph is settled (`entityGraphSettled`).
- Which entity URLs are published (indexable, sitemapped, listed in hubs) is decided once, in `entity_hubs.js`
  (`projectPagePolicy`/`MULTI_PERMIT_PROJECT_SQL`, `addressIsIndexable`, placeholder neighborhoods/addresses, org
  roles). Pages, sitemaps and hubs all read it; `tests/indexing_policy.test.js` asserts every sitemapped URL answers
  200, index, self-canonical.
- After a bulk import, rebuild: `curl -X POST -H "X-Admin-Token: $ADMIN_API_TOKEN" https://buildingseattle.com/admin/build-graph`
- Only one rebuild runs at a time (`rebuild_lock.js`): a rebuild starts only if no `entity_graph` row is `running` and younger than 30 minutes; otherwise `/admin/build-graph` answers 409 and the cron skips. A run that died leaves its `running` row, which blocks for at most 30 minutes; `POST /admin/build-graph?force=1` overrides it.
- Validation report: `node scripts/entity_report.mjs` (or `GET /admin/entity-report`).

### Neighborhood & Type Detection

SDCI status and neighborhood mappings live in one file, `data/sdci_mappings.json`, read by `sdci_mappings.js` (worker) and `sdci_mappings.py` (scraper); `tests/fixtures/sdci_mapping_cases.json` holds both test suites to the same answers. Statuses map by exact `statuscurrent` value (unknown values become `pending` and are logged in the run's `ingest_logs.error_message`); the raw value is kept in `permits.status_raw`, and `scripts/sql/status_backfill.sql` recomputes statuses after a map edit. Neighborhood boxes are approximate rectangles tried smallest first (accurate assignment would need the City's neighborhood polygons). Permit type classification is still duplicated in `sdci_scraper.py` and `worker.js`; keep those in sync by hand.

### Gumroad Dataset (gumroad/)

`gumroad/build_dataset.py` is the single source of truth for the shipped Gumroad
product — rebuild every artifact (permit/sample/contractor CSVs, data dictionary,
VERSION.txt, CHANGELOG.md, Foundation/Pro ZIPs) with one command. **The repo is
public:** the paid full permit CSV, contractor CSV and ZIPs are written only to
gitignored `gumroad/dist/` and uploaded to Gumroad; only the free 100-row sample
is tracked (see `docs/gumroad-dataset-in-git-history.md`). Column contracts
live in `gumroad/columns.py`; `refresh.py` (ships standalone inside the Pro ZIP)
keeps its own inline copy that tests assert never drifts. The scripts this
pipeline superseded (`export_full.py`, `generate_csv.py`, the old requests-based
`enrich_sdci.py`, and other one-off import/push helpers) live in `scripts/legacy/`
for reference only. Despite its name, root `sdci_detail_probe.py` is live: the
enrichment scripts import its parser and fetchers.

### SEO Tooling

Search indexing is a major concern (programmatic entity pages + sitemaps). `scripts/check_seo_health.mjs` runs daily in `.github/workflows/seo-health.yml` against production (tests: `tests/seo_health.test.js`; it enforces e.g. required homepage links and filter-URL canonical policy). `scripts/seo_investigation/` is a separate, manually-run analysis toolkit with its own `requirements.txt` and generated `.seo_data/` (gitignored); see its README and the dated findings in `docs/`. `url_inspection.py` there is stdlib-only and tested by `tests/test_url_inspection.py`.

### Alerts

`/alerts/*` is a free, per-permit status-change email subscription (double
opt-in, one-click unsubscribe) backed by `permit_alert_subscriptions` and
`permit_status_changes`. `sendPendingPermitAlerts` runs after each scheduled
ingest. This is the free top-of-funnel product; there is no paid alert tier yet.

Abuse controls: sign-up is JSON-only, same-origin (no CORS), throttled per IP
(the `ALERTS_RATE_LIMITER` binding as a per-minute burst limit when it exists,
plus the hourly cap in a D1 counter, `request_rate_limits`, always; `/leads`
works the same way) and per address (daily cap; over it the sign-up answers 429
with a message that says so), with a resend cooldown, a suppression list
(`alert_email_suppressions`) and optional Turnstile, which is on only when both
`TURNSTILE_SITE_KEY` (renders the widget) and `TURNSTILE_SECRET_KEY` (verifies)
are set; one alone is ignored with a warning. If the D1 counter is down the
forms fail closed with a 503. Every other accepted sign-up answers the same 202. GET `/alerts/confirm` and `/alerts/unsubscribe` only render a page;
the state change is the page's POST (RFC 8058 one-click POST still works).
Confirmation links expire after 7 days. Each alert is claimed in
`permit_alert_deliveries` before sending, so overlapping runs never double-send.
Tables: `migrations/0002_security_hardening.sql` (newer migrations live in
`migrations/`).

### Public API tiers

`/api/permits` and the MCP `search_permits` tool give anonymous callers a sample
(25 slim rows per page, first 10 pages; constants in `security.js`). An
`X-API-Key` (or `Authorization: Bearer`) matching `env.API_KEYS` (comma list) or
an unrevoked sha256 in `api_keys` unlocks full rows and paging. `/api/contractors`
and MCP `list_contractors` drop contractor `phone` and `email` for anonymous
callers (`slimContractorRow`); keyed answers are `private, no-store`. `API_RATE_LIMITER`
/ `API_KEY_RATE_LIMITER` throttle `/api/*` and `/mcp` when bound. JSON responses
carry `X-Robots-Tag: noindex`. The CSP forbids inline scripts except the theme
boot script (allowed by hash, `THEME_BOOT_SCRIPT_SHA256`) and all inline `on*`
handlers; page behaviour goes in static files under `public/brand/`. It ships as
`Content-Security-Policy-Report-Only` (violations go to `POST /csp-report`, which
logs a `CSP violation:` line to Workers Logs) until the var `CSP_ENFORCE = "1"`
switches it to the enforcing `Content-Security-Policy`. Flip it after a week of
traffic with no unexpected violations (Rocket Loader off first); a var change is a
new deployment version, so the HTML edge cache starts fresh with the new header.

## Key Constraints

- `AGENTS.md` carries overlapping repo guidelines (style: 2-space indent, semicolons, double quotes in JS; snake_case Python). Keep the two files consistent. Design/brand direction for HTML pages is in `.impeccable.md`.
- Admin endpoints use `X-Admin-Token` (`env.ADMIN_API_TOKEN`), separate from `X-Ingest-Token`. Admin POSTs accept only that header (not Cloudflare Access) and refuse cross-site Origins.
- **D1 database ID** is hardcoded in `wrangler.toml` — do not change without migrating data.
- **Ingest endpoints require the `X-Ingest-Token` header** (checked against `env.INGEST_API_TOKEN`) — they are not open.
- The Google Maps embed in permit detail pages requires a valid API key to render.
- Generated data/SQL artifacts (JSONL exports, `sql_*.sql` chunks, `.b64` images) are gitignored — never commit them; regenerate via the relevant script.
