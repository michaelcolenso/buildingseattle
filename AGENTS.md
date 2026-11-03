# Repository Guidelines

## Project Structure & Module Organization

This repository is a Cloudflare Worker application (~10,500 lines in `worker.js`, with pure/shared logic split into sibling modules) with a Python ingestion pipeline. `worker.js` contains the edge backend, route handling, SQL calls, and inlined HTML responses. Sibling modules: `entity_graph.js` (entity derivation), `adu.js` (ADU/DADU classification), `entity_hubs.js` (hub-page SEO config), `basis_reset.js` and `basis_reset_routes.js` (Basis Reset Radar), and `mcp.js` (MCP server at `/mcp`). **Never add non-function named exports to `worker.js`**: the Workers runtime rejects them and `wrangler dev` fails at startup; put shared constants in a sibling module. The base schema lives in `schema.sql`; later changes are `migration_*.sql` files applied individually (a new column usually needs both a migration and a `schema.sql` update). A daily cron (`0 13 * * *`) runs the ingest, entity-graph rebuild and alert sending (the rebuild is incremental and logs its own `run_type = 'entity_graph'` row in `ingest_logs`; see `CLAUDE.md`); `.github/workflows/enrich-daily.yml` enriches permits an hour later via `scripts/enrich_unenriched.py`. Python data collection and import scripts live at the repo root in `sdci_scraper.py` and `direct_import.py`. The Gumroad dataset product lives in `gumroad/` — rebuild it with `python3 gumroad/build_dataset.py`, never hand-edit the CSVs. Superseded one-off scripts live in `scripts/legacy/`. SEO monitoring lives in `scripts/check_seo_health.mjs` (daily via `.github/workflows/seo-health.yml`) and the manual `scripts/seo_investigation/` toolkit (own `requirements.txt`, gitignored `.seo_data/`). Design/brand direction for HTML pages is in `.impeccable.md`; investigation notes are in `docs/`. Runtime configuration is in `wrangler.toml`, and Python dependencies are declared in `pyproject.toml`.

**Generated-artifact policy:** never commit generated data (JSONL exports, `sql_*.sql` import chunks, `.b64` image blobs, `gumroad/dist/`) — these are gitignored. Regenerate them via the relevant script instead.

## Build, Test, and Development Commands

- `npx wrangler dev`: run the Worker locally on Cloudflare's dev server.
- `npx wrangler deploy`: deploy the Worker.
- `npx wrangler d1 execute buildingseattle --file schema.sql`: apply the schema to D1.
- `npx wrangler d1 execute buildingseattle --command "SELECT COUNT(*) FROM permits"`: inspect live data quickly.
- `uv sync --extra dev`: install Python dependencies (including test tooling).
- `python sdci_scraper.py`: fetch permit data and write fresh JSONL files.
- `python direct_import.py`: send local JSONL records to the running Worker (requires `INGEST_API_TOKEN`).
- `uv run --extra dev pytest tests/`: run Python tests.
- `npm test` (or `node --test "tests/**/*.test.js"`): run Worker/JS tests. Single file: `node --test tests/entity_graph.test.js`; single test: add `--test-name-pattern="name"`.
- `uv run --extra dev pytest tests/test_direct_import.py -k name`: run one Python test.
- `node --check worker.js`: syntax check (CI runs it).
- `python3 gumroad/build_dataset.py`: rebuild the Gumroad dataset product end to end.

## Coding Style & Naming Conventions

Match the existing style instead of introducing new patterns. In `worker.js`, use 2-space indentation, semicolons, double quotes, and small route/helper functions where practical. In Python, use 4-space indentation, snake_case names, and short docstrings for non-obvious helpers. Keep SQL parameterized through D1 `prepare().bind()`. When updating neighborhood or permit-type mapping logic, keep the Python and Worker implementations in sync.

## Testing Guidelines

Test files live under `tests/`. Node's built-in runner covers the Worker and its modules (`worker.test.js`, `entity_graph.test.js`, `entity_rebuild.test.js` (incremental rebuild on SQLite), `empty_address.test.js` (410 vs 503), `mcp.test.js`, `basis_reset*.test.js`, `entity_hub_sql.test.js`, `project_dedupe.test.js`, `homepage.test.js`, `seo_health.test.js`, and others). Pytest (some `pytest-asyncio`) covers the Python side: `test_direct_import.py`, `test_sdci_enrich.py`, `test_build_dataset.py`, `test_basis_reset_candidates.py`, `test_url_inspection.py`. CI (`.github/workflows/test.yml`) runs both suites plus `node --check worker.js` on every push/PR. For Worker changes, also verify locally with `npx wrangler dev` and exercise `/api/permits`, `/api/stats`, and any modified ingest route before opening a PR.

## Commit & Pull Request Guidelines

Follow the existing history: short, imperative subjects, optionally prefixed with the area (e.g. `url_inspection: validate --urls before signing in`). Keep commits focused by separating Worker, schema, and data-refresh changes where possible. PRs should include a concise summary, linked issue if applicable, schema or ingest notes, and screenshots for landing-page or HTML output changes.

## Security & Configuration Tips

Do not change the D1 binding or database ID in `wrangler.toml` without a migration plan. The ingest endpoints require the `X-Ingest-Token` header (checked against `env.INGEST_API_TOKEN`), and admin endpoints require `X-Admin-Token` (`env.ADMIN_API_TOKEN`). Set both via `.dev.vars` locally — never commit that file, it's gitignored. Treat large JSONL/SQL files as generated artifacts and only commit them when a dataset refresh is intentional (and only the small current-release files in `gumroad/`, not bulk exports).
