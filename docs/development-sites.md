# Development-site enrichment

The first release joins permit property references to current Seattle SDCI development sites. It adds site area, site status, source/fetch timestamps, a boundary outline on permit pages, and a live GeoJSON endpoint. King County tax parcel matching and assessor enrichment are deferred.

## Source and join contract

- Source: [Seattle SDCI Development Sites](https://services.arcgis.com/ZOyb2t4B0UYuYNYH/ArcGIS/rest/services/Development_Sites/FeatureServer/0), [official dataset](https://www.arcgis.com/home/item.html?id=4eedf0a9a2d24b9da3547e73d142e1d2).
- Join `UPPER(TRIM(permits.parcel_number))` to normalized `PRCLID`. `development_sites.site_id` is the primary key, so the LEFT JOIN preserves permit grain. The raw permit column remains unchanged. It is an SDCI property reference, usually a `DV…` development-site ID, not a King County tax PIN.
- Store `PRCLSTAT`, `LOTSZ`, `LAST_UPDATED_DT`, WGS84 Polygon/MultiPolygon geometry, and the successful fetch time separately from permits. Source update dates are nullable UTC epoch milliseconds converted to ISO 8601; never substitute fetch time for an unknown source date.
- The published dataset describes ACTIVE, PRESUMED, and UPDATE sites. An absent ID means unavailable in this current layer; it does not establish that the permit expired or that a historic site never existed.
- Query the source with read-only POSTs, `f=geojson`, `outSR=4326`, and at most 100 IDs. A complete FeatureCollection may have an empty `features` array and no `properties` member. A truncated GeoJSON response reports `properties.exceededTransferLimit=true`; reject that and any top-level truncation flag. Reject malformed collections, missing required source fields, duplicate normalized IDs, and IDs outside the requested set. No publishing begins until all source reads validate.
- Missing/nonpositive lot sizes become null. Null or unusable geometry retains the valid site attributes without an outline or geometry URL. Polygon validation preserves holes and multipart geometry and bounds geometry size below D1's row limit.

The November 8, 2026 source-only dry run against the checked-in 13,623-permit CSV matched 8,710 of 8,885 referenced IDs, covering 13,073 permits. There were 175 unmatched IDs, 260 permits without a valid reference, 7 matched sites without lot size, and 1,457 without a source update date. All 8,710 matched sites had usable geometry. These are export-baseline results, not a production coverage guarantee.

## Interfaces

`POST /ingest/development-sites/batch` requires `X-Ingest-Token`. A payload contains `complete: true`, `requested_ids` (1–40 distinct normalized IDs), `sites`, and a UTC `fetched_at`. Each site contains `site_id`, nullable `status`, nullable positive `lot_sqft`, nullable `geometry`, and nullable UTC `source_updated_at`. The response acknowledges `processed`, `matched`, and `unmatched` counts.

The Worker independently validates the payload and reconciles only its requested IDs. Upserts, removal of confirmed absent cached matches, and the success log share one `DB.batch()` transaction. Later statement failures roll back the complete batch, consistent with [D1 transaction semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). Batches use at most 40 IDs to remain under D1's free-plan per-request query budget, including the log and delete. Retries reuse identical payloads. The workflow serializes runs; clients must not run overlapping import jobs. A publish failure can leave earlier batches refreshed; rerunning the importer converges without duplicating sites.

`GET /api/permits` appends six nullable fields:

1. `development_site_id`
2. `development_site_sqft`
3. `development_site_status`
4. `development_site_source_updated_at`
5. `development_site_fetched_at`
6. `development_site_geometry_url`

Unmatched permits have null enrichment fields. MCP `search_permits` inherits the same output. Geometry is excluded from list responses.

`GET /api/development-sites/{id}/geometry` returns an `application/geo+json` Feature with attribution and source/fetch dates; it returns 404 without usable geometry. URLs are **live references**, not geometry snapshots tied to a CSV export. They may resolve to a changed boundary or return 404 after refresh. A CSV consumer needing reproducible geometry must retain the Feature it retrieved.

The site outline is a numeric, server-rendered SVG projected to preserve aspect ratio. It supports holes and multiple polygons, includes an accessible label, and uses existing design tokens. Permit pages retain the existing location map and distinguish site status from permit status.

CSV columns 1–32 retain their order and names. The same six scalar fields are appended as columns 33–38. D1 exports, API exports, and the standalone refresh script share this contract. Consumers requiring exactly 32 columns must update. Site area repeats across permits: deduplicate site IDs before aggregating, and do not treat the sum as a surveyed non-overlapping land footprint.

## Running and rollout

Required for production source discovery: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` with D1 read access, and optionally `BUILDINGSEATTLE_D1_ID`. Publishing additionally requires `INGEST_API_TOKEN`. Migration/deployment require appropriately scoped Cloudflare credentials. Do not put credentials in tracked files or command arguments.

Credential-free source validation:

```sh
uv run python scripts/enrich_development_sites.py --dry-run --input-csv gumroad/buildingseattle_permits.csv
```

Production discovery and pilot commands, after credentials are configured:

```sh
uv run python scripts/enrich_development_sites.py --dry-run
uv run python scripts/enrich_development_sites.py --limit-sites 50
uv run python scripts/enrich_development_sites.py
```

1. Apply only `migration_development_sites.sql` to production with `wrangler d1 execute buildingseattle --remote --file migration_development_sites.sql`. Do not apply the base schema's sample inserts to production.
2. For an initial rollout, set `DEVELOPMENT_SITES_PUBLIC = "false"` before deployment. This allows authenticated backfill while holding the public fields, card, geometry endpoint, and 38-column product claims. The migration must precede this deployment. The released configuration is now `"true"`, following the completed rollout recorded below.
3. Run the production dry run, inspect the scoped unmatched/missing-attribute counts, then run the 50-site pilot. Confirm its matched values, nulls, and permit counts directly in D1. Run the full backfill only after the pilot checks pass. Source outages preserve last-good cached rows; complete validated absence removes only those requested site rows.
4. Regenerate the release using `python3 gumroad/build_dataset.py --source d1 --version YYYY-MM`. Review the full/sample CSVs, data dictionary, checksums, and release ZIPs. Never hand-edit generated CSVs. Existing checked-in CSVs and historical release entries remain the previous 32-column artifacts until this step succeeds.
5. Change `DEVELOPMENT_SITES_PUBLIC` to `"true"` in the Wrangler configuration and deploy. The template cache version is bumped to `v10`, and cache keys additionally distinguish the rollout flag, so pages cached during backfill cannot hide the released card. Verify matched/unmatched permit pages, the JSON/MCP fields, source timestamps, and geometry endpoint before publishing the regenerated product files through the normal release process.
6. Set the GitHub repository variable `DEVELOPMENT_SITES_ENABLED=true` to enable the new daily workflow. It runs at 7 AM Pacific standard time / 8 AM Pacific daylight time (cron `0 15 * * *`), following the existing enrichment window. Manual dispatch defaults to a dry run and supports a pilot limit.

Workflow summaries show scoped site/permit coverage, missing attributes/geometry, and publication outcome. Incomplete runs exit nonzero. Successful batch logs use `run_type='development_sites'`; these logs appear in the admin history but are excluded from permit freshness, growth, and ingest-performance statistics. No permit status alerts are triggered by a property refresh.

For rollback, set the public flag back to `"false"` and disable the workflow variable. The additive table and original permit data can remain in place; correcting a source/import bug does not require dropping schema or changing the D1 binding.

## Verification

- JavaScript tests exercise the real SQL join, matched/unmatched sites, shared sites, normalization, auth, duplicate/foreign IDs, empty-batch reconciliation, missing geometry, API/MCP rendering, rollout gating, freshness exclusions, and polygon rendering.
- A real SQLite transaction test forces failure after upserts and deletions and proves both are rolled back. The generic Worker mock does not provide that assurance.
- Python tests cover the live-observed GeoJSON contract, truncation, malformed/empty responses, nullable dates, retries, D1 discovery, dry runs, publishing acknowledgement, and export parity.
- Run `npm test`, `uv run --extra dev pytest tests/`, and `node --check worker.js`. Use isolated local Wrangler state for endpoint smoke tests and inspect matched/unmatched pages at desktop/mobile sizes and in both themes.

Production migration, deployment, backfill, release regeneration, and schedule activation are operational steps; local/source-only validation does not claim they have been completed.

## Production rollout — November 8, 2026

- Merged current main into the implementation before rollout, preserving the newer permit-value counting and page fixes. Updated the export-join test fixture to include the entity-graph migration. Validation passed: 209 JavaScript tests, 89 Python tests, Worker syntax check, and Wrangler deployment dry run. [PR #102](https://github.com/michaelcolenso/buildingseattle/pull/102) is merged.
- Applied only `migration_development_sites.sql` through the authenticated Cloudflare MCP connection, then deployed with public enrichment disabled. Existing bindings, secrets, assets, observability, and cron triggers were preserved. The local Wrangler environment token was invalid; MCP authentication worked.
- [Production dry run](https://github.com/michaelcolenso/buildingseattle/actions/runs/42524775507): 15,581 permits; 10,185 valid referenced site IDs; 9,994 matched IDs covering 15,249 permits (97.9%). There were 191 unmatched IDs covering 314 permits, and 18 permits without a valid reference. Among matched sites, 16 lacked lot size, 1,701 lacked source dates, and none lacked geometry.
- [50-site pilot](https://github.com/michaelcolenso/buildingseattle/actions/runs/42524831837): 49 cached matches covering 61 permits, zero missing lot sizes or geometry, and 22 missing source dates. Direct D1 checks matched the workflow summary; five source spot checks confirmed values and nulls. The joined permit count remained 15,581.
- [Full backfill](https://github.com/michaelcolenso/buildingseattle/actions/runs/42524928223) succeeded with zero failed batches. Direct D1 verification found 9,994 cached sites and 15,249 matched permits, with permit grain unchanged. The importer's `published_sites=10185` counts requested IDs reconciled, including confirmed absences; it is not the cached match count.
- Regenerated the November release with the repository builder from D1 rows fetched through Cloudflare MCP. A temporary transport adapter supplied the exact `PERMIT_SELECT` results to `build_dataset.py --source d1 --version 2026-11`; CSV construction, normalization, counted totals, checksums, and ZIP creation used the existing builder. The export has 15,581 rows and 38 columns, 2,367 contractors, and counted value $11,250,805,473. Verified the original 32 column names/order, match coverage, 100-row sample membership, ZIP integrity, and ZIP/CSV checksum parity.
- Enabled public enrichment. Production API/MCP checks verified matched fields, unmatched nulls, geometry attribution and timestamps, and absence of geometry in list results. Matched and unmatched permit pages passed automated browser checks at 1440px and 390px widths in light/dark themes, with no horizontal overflow or JavaScript errors. Example records: [matched](https://buildingseattle.com/permits/6605267-CN), [unmatched](https://buildingseattle.com/permits/6701099-DM), and [GeoJSON](https://buildingseattle.com/api/development-sites/DV0073550/geometry).
- Set and read back `DEVELOPMENT_SITES_ENABLED=true`. The existing daily workflow is enabled at `0 15 * * *`.

The regenerated Foundation and Pro ZIPs are in gitignored `gumroad/dist/`. Gumroad listing/file replacement is still pending; no authenticated Gumroad publishing connection is available in this workspace. Do not describe those ZIPs as uploaded to Gumroad.
