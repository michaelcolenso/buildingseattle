# Repository Guidelines

## Project Structure & Module Organization

This repository is a Cloudflare Worker application (~8,600 lines in `worker.js`, not yet split into modules) with a Python ingestion pipeline. `worker.js` contains the full edge backend, route handling, SQL calls, and inlined HTML responses. Database schema lives in `schema.sql`; migrations are `migration_*.sql` files applied individually. Python data collection and import scripts live at the repo root in `sdci_scraper.py` and `direct_import.py`. The Gumroad dataset product lives in `gumroad/` — rebuild it with `python3 gumroad/build_dataset.py`, never hand-edit the CSVs. Superseded one-off scripts live in `scripts/legacy/`. Runtime configuration is in `wrangler.toml`, and Python dependencies are declared in `pyproject.toml`.

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
- `node --test "tests/**/*.test.js"` (or `npm test`): run Worker/JS tests.
- `python3 gumroad/build_dataset.py`: rebuild the Gumroad dataset product end to end.

## Coding Style & Naming Conventions

Match the existing style instead of introducing new patterns. In `worker.js`, use 2-space indentation, semicolons, double quotes, and small route/helper functions where practical. In Python, use 4-space indentation, snake_case names, and short docstrings for non-obvious helpers. Keep SQL parameterized through D1 `prepare().bind()`. When updating neighborhood or permit-type mapping logic, keep the Python and Worker implementations in sync.

## Testing Guidelines

Test files live under `tests/`: `worker.test.js` and `entity_graph.test.js` (Node's built-in test runner) cover the Worker and entity graph; `test_direct_import.py`, `test_sdci_enrich.py`, and `test_build_dataset.py` (pytest, some `pytest-asyncio`) cover the Python pipeline. CI (`.github/workflows/test.yml`) runs both suites plus `node --check worker.js` on every push/PR. For Worker changes, also verify locally with `npx wrangler dev` and exercise `/api/permits`, `/api/stats`, and any modified ingest route before opening a PR.

## Commit & Pull Request Guidelines

Git history is not available in this checkout, so follow short, imperative commit subjects such as `Add contractor batch import guard`. Keep commits focused by separating Worker, schema, and data-refresh changes where possible. PRs should include a concise summary, linked issue if applicable, schema or ingest notes, and screenshots for landing-page or HTML output changes.

## Security & Configuration Tips

Do not change the D1 binding or database ID in `wrangler.toml` without a migration plan. The ingest endpoints require the `X-Ingest-Token` header (checked against `env.INGEST_API_TOKEN`, set via `.dev.vars` locally — never commit that file, it's gitignored). Treat large JSONL/SQL files as generated artifacts and only commit them when a dataset refresh is intentional (and only the small current-release files in `gumroad/`, not bulk exports).
