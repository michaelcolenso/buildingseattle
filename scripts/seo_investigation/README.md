# Index-selection investigation (2026-10-22) — reproducibility

Findings: `docs/index-selection-investigation-2026-10-22.md`. Data is generated and gitignored (`.seo_data/`).

Order: `gsc_queries.sql` (export to CSV) -> `sm_load.py` (needs sitemap XML in `.seo_data/sm/`, fetched from
`/sitemap.xml` children) -> `pull_permits.py` (all permits from `/api/permits`) -> `recon.py` ->
`probe.py` (live status/canonical/robots for a path list) -> `graph_dump.mjs` (expected entity graph from
`entity_graph.js`) -> `permit_features.py` -> `budget_model.mjs` -> `rebuild_local.mjs` (runs the real
`/admin/build-graph` through `worker.js` against a node:sqlite D1 shim over the full permit set).
Paths were rewritten from a scratch directory to `.seo_data`; the scripts have only been run in that layout.
