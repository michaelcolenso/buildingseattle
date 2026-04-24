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

# Execute D1 SQL directly
npx wrangler d1 execute buildingseattle --command "SELECT COUNT(*) FROM permits"

# Run a SQL file against D1
npx wrangler d1 execute buildingseattle --file schema.sql
```

### Python Data Pipeline

```bash
# Install dependencies (uses uv)
uv sync

# Scrape latest permits from Seattle Open Data Portal
python sdci_scraper.py

# Import scraped permits into running worker
python direct_import.py

# Run tests
pytest
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

The entire backend lives in `worker.js` (~1,270 lines). It contains:

- Path-based route dispatch at the top of `fetch()`
- **All HTML pages are inlined as template literals** — there is no separate templating engine or frontend build step
- SQL queries are built inline with parameterized bindings via the D1 `prepare().bind()` API
- CORS headers are added to every response

Key routes:
| Route | Purpose |
|---|---|
| `GET /` | Landing page |
| `GET /api/permits` | Query permits (supports `?neighborhood=`, `?type=`, `?permit=`) |
| `GET /api/contractors` | List contractors with active project counts |
| `GET /api/stats` | Aggregate counts for dashboard |
| `GET /contractor/:slug` | Contractor detail page |
| `POST /leads` / `/leads/batch` | Lead capture |
| `POST /ingest/permit` / `/ingest/permit/batch` | Data ingestion (no auth) |
| `POST /ingest/contractor` / `/ingest/contractor/batch` | Data ingestion (no auth) |

### Database Schema (schema.sql)

Three tables: `permits`, `contractors`, `leads`. Permits reference contractors via `contractor_id`. Neighborhood and permit type are inferred/normalized at ingest time.

### Neighborhood & Type Detection

Both `sdci_scraper.py` and `worker.js` contain hardcoded neighborhood name mappings and permit type classification logic. If you update one, check whether the other needs a matching update.

## Key Constraints

- **D1 database ID** is hardcoded in `wrangler.toml` — do not change without migrating data.
- **Ingest endpoints have no authentication** — they are open POST endpoints.
- The Google Maps embed in permit detail pages requires a valid API key to render.
