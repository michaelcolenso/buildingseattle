# Repository Guidelines

## Project Structure & Module Organization

This repository is a small Cloudflare Worker application with a Python ingestion pipeline. `worker.js` contains the full edge backend, route handling, SQL calls, and inlined HTML responses. Database schema lives in `schema.sql`; `import.sql` is for bulk SQL import work. Python data collection and import scripts live at the repo root in `sdci_scraper.py` and `direct_import.py`. Generated datasets are stored as `seattle_permits.jsonl` and `seattle_contractors.jsonl`. Runtime configuration is in `wrangler.toml`, and Python dependencies are declared in `pyroject.toml`.

## Build, Test, and Development Commands

- `npx wrangler dev`: run the Worker locally on Cloudflare's dev server.
- `npx wrangler deploy`: deploy the Worker.
- `npx wrangler d1 execute buildingseattle --file schema.sql`: apply the schema to D1.
- `npx wrangler d1 execute buildingseattle --command "SELECT COUNT(*) FROM permits"`: inspect live data quickly.
- `uv sync`: install Python dependencies.
- `python sdci_scraper.py`: fetch permit data and write fresh JSONL files.
- `python direct_import.py`: send local JSONL records to the running Worker.
- `pytest`: run Python tests when present.

## Coding Style & Naming Conventions

Match the existing style instead of introducing new patterns. In `worker.js`, use 2-space indentation, semicolons, double quotes, and small route/helper functions where practical. In Python, use 4-space indentation, snake_case names, and short docstrings for non-obvious helpers. Keep SQL parameterized through D1 `prepare().bind()`. When updating neighborhood or permit-type mapping logic, keep the Python and Worker implementations in sync.

## Testing Guidelines

There are currently no committed test files. Add Python tests under `tests/` with names like `test_scraper.py` and prefer `pytest` plus `pytest-asyncio` for async code. For Worker changes, verify locally with `npx wrangler dev` and exercise `/api/permits`, `/api/stats`, and any modified ingest route before opening a PR.

## Commit & Pull Request Guidelines

Git history is not available in this checkout, so follow short, imperative commit subjects such as `Add contractor batch import guard`. Keep commits focused by separating Worker, schema, and data-refresh changes where possible. PRs should include a concise summary, linked issue if applicable, schema or ingest notes, and screenshots for landing-page or HTML output changes.

## Security & Configuration Tips

Do not change the D1 binding or database ID in `wrangler.toml` without a migration plan. The ingest endpoints are open POST routes, so avoid exposing production URLs in tests or ad hoc import scripts. Treat large JSONL files as generated artifacts and only commit them when a dataset refresh is intentional.
