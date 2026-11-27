# Deploy runbook: the `audit/integration` release

This is the single ordered checklist for merging `audit/integration` into
`main`. Pushing `main` deploys production immediately, so everything in
**Before merge** must be done first. The new code fails against the old schema:
the first cron dies on `no such column: cursor` and cannot even log the
failure, and the alert and keyed `/api/permits` routes return 500. Old code
runs fine on the migrated schema, because every migration only adds things.

Each step is marked:
- **[reversible]**: it can be undone, and the undo is given.
- **[one-way]**: it cannot be undone, or undoing it is costly.

The database is `buildingseattle`. Run commands from a checkout of
`audit/integration` with `npx wrangler` logged in to the production account.

## Before merge

1. **Pick the time. [reversible]** Do not merge between 13:00 and 14:00 UTC.
   The ingest cron runs at 13:00 UTC, and the edge-cache data day rolls over in
   that hour. Leave time to watch the 13:00 run after the deploy.

2. **Take a Time Travel bookmark. [reversible]** Keep its output; it is the
   restore point for everything below.
   ```bash
   npx wrangler d1 time-travel info buildingseattle
   # restore, if ever needed:
   # npx wrangler d1 time-travel restore buildingseattle --bookmark=<bookmark>
   ```

3. **Compare prod's schema with the baseline. [reversible, read-only]**
   ```bash
   npx wrangler d1 export buildingseattle --remote --no-data --output prod-schema.sql
   diff <(grep -v '^--' migrations/0000_baseline.sql) prod-schema.sql
   ```
   The export may differ in quoting and statement order. Any table, column or
   index that prod has and the baseline lacks, or the other way round, must be
   explained before you continue.

4. **Check for duplicate Basis Reset rows. [reversible, read-only]**
   Migration 0001 adds a UNIQUE index on
   `basis_reset_events(source_url, event_type, event_date)`. If duplicates
   exist, the whole migration fails.
   ```bash
   npx wrangler d1 execute buildingseattle --remote --command "SELECT source_url, event_type, event_date, COUNT(*) AS n FROM basis_reset_events GROUP BY 1,2,3 HAVING COUNT(*) > 1"
   ```
   The query must return 0 rows. If it returns any, resolve them before
   step 6. Keep one row per group. First point any
   `basis_reset_scores.latest_event_id` that refers to a copy at the kept row,
   because foreign keys are enforced. Then delete the copies.

5. **Check how SDCI publishes the feed. [reversible, read-only]**
   Run this on two different days:
   ```
   https://data.seattle.gov/resource/k44w-2dcq.json?$select=:updated_at,count(*)&$group=:updated_at&$order=count(*) DESC&$limit=5
   ```
   If one `:updated_at` value covers most of the dataset and that value changes
   every day, SDCI republishes the whole dataset. The ingest now detects this
   and logs the run as `degraded` (B2). Note what you see; it tells you how to
   read step 18. The same response also confirms the `:updated_at` literal
   format (N4).

6. **Bootstrap `d1_migrations` and apply migrations 0001-0004. [one-way]**
   Roll back only by the bookmark from step 2. Do not run the baseline itself,
   and never apply a migration with `d1 execute --file`.
   ```bash
   # a. Create wrangler's tracking table and mark the baseline applied
   npx wrangler d1 execute buildingseattle --remote --command "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0000_baseline.sql');"
   # b. 0000_baseline.sql must NOT be listed; 0001-0004 must be
   npx wrangler d1 migrations list buildingseattle --remote
   # c. Apply (wrangler asks for confirmation)
   npx wrangler d1 migrations apply buildingseattle --remote
   # d. Verify: expect 0000_baseline.sql, 0001_hot_query_indexes.sql,
   #    0002_security_hardening.sql, 0003_permit_feed_fields.sql and
   #    0004_permit_list_id_tiebreak.sql, in that order
   npx wrangler d1 execute buildingseattle --remote --command "SELECT name, applied_at FROM d1_migrations ORDER BY id"
   ```
   If step b lists `0000_baseline.sql`, stop: step a did not take.
   Migration 0004 drops four `issued_date` indexes from 0001 and replaces them
   with versions that end in `id DESC`. The currently deployed code does not
   depend on the old names.

7. **Set secrets. [reversible]** Use `npx wrangler secret put <NAME>`, and
   undo with `npx wrangler secret delete <NAME>`.
   - `API_KEYS`: a comma-separated list of full-access keys.
   - `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`: set **both or neither**.
     With only one set, Turnstile stays off and the Worker logs a warning.
   - `SOCRATA_APP_TOKEN` (optional): sent as `X-App-Token` to raise Socrata's
     rate limit.
   - Leave the `CSP_ENFORCE` var unset. The CSP ships report-only (step 20).

8. **Give existing Pro buyers keys and the new `refresh.py`. [one-way once
   sent]** After the deploy, anonymous `/api/permits` callers get slim rows and
   a 403 past page 10. Main's `refresh.py` then exits with "Development-site
   fields are unavailable". Before merging:
   - Issue each buyer a key, either in `API_KEYS` or as a sha256 row in
     `api_keys`.
   - Send buyers `gumroad/refresh.py`. It reads `BUILDINGSEATTLE_API_KEY` or
     `--api-key` and sends `X-API-Key`.

9. **Upload the Gumroad files. [reversible]** Run
   `python3 gumroad/build_dataset.py`, then upload the ZIPs from
   `gumroad/dist/`, and the new `refresh.py` if it is listed separately.
   Re-upload older files to undo.

10. **Set the Workers Builds build. [reversible]** In the Cloudflare
    dashboard, Workers Builds:
    - Set the build command to `npm ci && npm test`.
    - Set `NODE_VERSION` to `22`. It must be at least 22.13, because the tests
      use unflagged `node:sqlite`.
    CI (`.github/workflows/test.yml`) runs the same tests plus a
    `wrangler deploy --dry-run`.

11. **Turn Rocket Loader off and check Email Obfuscation. [reversible]**
    Both are in the dashboard under Speed and Scrape Shield. Rocket Loader
    rewrites script tags, which the new CSP blocks, and the nav script may then
    not run. Email Obfuscation's script is same-origin, but confirm it on a
    page with a mailto link once the report-only CSP is live (step 20).

12. **Make the repo private, or purge the dataset from history. [one-way]**
    See `docs/gumroad-dataset-in-git-history.md`.
    - Making the repo private is reversible.
    - The history purge (`git filter-repo --invert-paths` on a mirror clone,
      then a force-push) rewrites every commit hash. It cannot be undone for
      forks or clones that already exist.

13. **Put the order in the PR description. [reversible]** State that
    migrations were applied before the merge (steps 2-6), with the time and the
    bookmark.

## Merge

14. **Merge `audit/integration` as one PR. [reversible]** To undo, revert the
    merge commit and push. The old code works on the migrated schema, so a
    revert needs no database step.

## After merge

15. **Turn off workers.dev once enrichment works on the apex. [reversible]**
    `wrangler.toml` sets `preview_urls = false`; `workers_dev` is left on because
    the apex bot rule has blocked GitHub runners with error 1010. After the merge,
    run enrich-daily by hand (workflow_dispatch). If it is green, add
    `workers_dev = false` to `wrangler.toml` in a follow-up commit. If it fails with
    1010, add a WAF skip rule for `/ingest/permit/enrichment/batch` carrying the
    ingest token, or set the repository variable `WORKER_URL` to the workers.dev
    URL until you do.
16. **Resubmit the sitemap in Search Console. [reversible]** Expect a large
    drop in submitted URLs, because thin pages are now noindex and left out of
    the sitemap. That is the policy working, not an indexing failure. Expect a
    one-time jump in `lastmod` dates too (N5).

17. **Watch the 09:30 UTC retention cron. [reversible]** It now runs on its
    own (`30 9 * * *`) and only prunes `page_views`. Optionally, during a quiet
    window, delete existing bot rows from `page_views` in batches of a few
    thousand.

18. **Watch the first 13:00 UTC ingest. [reversible]**
    Use `npx wrangler tail` or Workers Logs, and check:
    ```bash
    npx wrangler d1 execute buildingseattle --remote --command "SELECT run_type, status, cursor, records_unchanged, error_message, start_time FROM ingest_logs ORDER BY id DESC LIMIT 5"
    ```
    - The `scheduled` row has `cursor` set and `status = 'success'`.
    - `status = 'degraded'` means the run saw a full dataset replace (step 5).
      New permits still land through the newest-first pages, but the
      incremental cursor is not advanced. `scripts/check_freshness.py` fails on
      a degraded run and opens one issue. Once you have confirmed that SDCI
      does daily replaces, set `FRESHNESS_ALLOW_DEGRADED=1` for that workflow.
    - Check cron CPU time in Workers metrics (N3).
    - The next day, the homepage's last-updated date should be current.

19. **Watch alerts. [reversible]** Subscribing at `/alerts` should send one
    confirmation. A sixth request for the same email in a day gets a 429 with
    a readable message. A 503 means the D1 rate-limit table is unavailable.

20. **Enforce the CSP after a clean week. [reversible]** Search Workers Logs
    for `CSP violation:` lines. When there are none for real pages, set the var
    `CSP_ENFORCE = "1"`. The header then becomes `Content-Security-Policy`.
    Changing a var creates a new version, so the edge cache starts fresh. Undo
    by removing the var.

## Rollback

- **Code:** revert the merge commit and push. This is safe at any point
  after step 6.
- **Schema:** do not roll back unless a migration damaged data. If one did,
  run `npx wrangler d1 time-travel restore buildingseattle --bookmark=<step 2>`.
  Writes made after the bookmark are lost, and the next ingest re-fetches
  permits.
- **Secrets and dashboard settings:** each is listed with its undo above.
