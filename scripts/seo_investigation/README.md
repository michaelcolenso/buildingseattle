# Index-selection investigation (2026-10-22) — reproducibility

Findings: `docs/index-selection-investigation-2026-10-22.md`. Data is generated and gitignored (`.seo_data/`).

Python deps for these scripts are separate from the product's `uv` environment: `pip install -r requirements.txt`.

Order: `gsc_queries.sql` (export to CSV) -> `sm_load.py` (needs sitemap XML in `.seo_data/sm/`, fetched from
`/sitemap.xml` children) -> `pull_permits.py` (all permits from `/api/permits`) -> `recon.py` ->
`probe.py` (live status/canonical/robots for a path list) -> `graph_dump.mjs` (expected entity graph from
`entity_graph.js`) -> `permit_features.py` -> `budget_model.mjs` -> `rebuild_local.mjs` / `rebuild_local_multi.mjs` (run the real
`/admin/build-graph` through `worker.js` once / three times against a node:sqlite D1 shim over the full permit set).
Paths were rewritten from a scratch directory to `.seo_data`; the scripts have only been run in that layout.

Cloudflare-side evidence (read-only, no script): D1 SELECT counts on permits/addresses/sqlite_sequence/ingest_logs/page_views;
Workers Logs events with needle `Entity graph rebuild failed` in a narrow window around each 13:00 UTC cron (wide windows are
sampled and miss it); zone GraphQL `httpRequestsAdaptiveGroups` with `edgeResponseStatus: 410` by minute.

Drilldown analysis (needs the Search Console per-URL drilldown zips extracted to `.seo_data/dd/<name>/`): `drilldown.py`.

URL Inspection (Google's own per-URL index verdict; needs a Desktop OAuth client, see the script docstring): `url_inspection.py`
runs on your machine (stdlib only), signs in once in a browser with the read-only Search Console scope, and writes
`.seo_data/url_inspection.csv`. It is resumable and paced under the documented per-site quota (2,000/day, 600/min). Tests: `tests/test_url_inspection.py`
(local stub server; the Google sign-in itself is not covered by tests).
