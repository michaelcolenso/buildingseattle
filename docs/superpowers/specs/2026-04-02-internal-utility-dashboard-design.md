# Design Spec: Internal Utility Dashboard

**Date:** 2026-04-02  
**Status:** Approved  
**Topic:** Internal Visibility and Observability for Building Seattle

## 1. Executive Summary
Building Seattle currently lacks visibility into its automated data pipeline. To improve internal utility, we are implementing a structured logging system and an administrative dashboard to monitor the health, performance, and data integrity of our construction permit and contractor scrapers.

## 2. Goals & Success Criteria
- **Visibility:** Real-time monitoring of the latest ingest runs and overall system health.
- **Historical Auditing:** Ability to review past ingest logs for troubleshooting and growth tracking.
- **Observability:** Surfacing performance metrics (duration, success rate) and error categories.
- **Hotspot Detection:** Identifying which Seattle neighborhoods are seeing the most construction activity to validate data coverage.

## 3. Architecture & Data Flow

### 3.1 Database Schema (SQLite/D1)
A new `ingest_logs` table will be added to track every data operation.

```sql
CREATE TABLE ingest_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL,       -- 'permit' or 'contractor'
  source TEXT NOT NULL,         -- 'scraper' or 'manual'
  status TEXT NOT NULL,         -- 'success' or 'error'
  records_added INTEGER DEFAULT 0,
  records_updated INTEGER DEFAULT 0,
  error_message TEXT,           -- Null if success
  start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  end_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 3.2 Ingest Integration
The existing ingest endpoints in `worker.js` and the `sdci_scraper.py` script will be updated to:
1. Log the start of an operation.
2. Track the number of records processed (added/updated).
3. Catch and log any errors that occur during the batch process.
4. Record the total duration of the run.

## 4. User Interface: Admin Dashboard (`/admin`)
The dashboard will be a restricted route in the Cloudflare Worker providing a high-level pulse on the system.

### 4.1 Key Metrics
- **System Pulse:** Last successful run time and status.
- **Data Growth (24h):** Total new records added across permits and contractors.
- **Database Stats:** Total record counts and storage size.
- **Neighborhood Hotspots:** Top 5 neighborhoods by permit growth in the last 7 days.
- **Scraper Performance:** Average run duration, success vs. failure rates.

### 4.2 Log View
A tabular view of the most recent `ingest_logs`, showing:
- Timestamp (Local time)
- Operation type (Permits/Contractors)
- Result (Success/Error badge)
- Change count (+X records)
- Error details (if applicable)

## 5. Implementation Phases
1. **Schema Migration:** Create the `ingest_logs` table.
2. **Observability Plumbing:** Update `worker.js` ingest handlers to write logs.
3. **Metric API:** Create `/api/admin/stats` to aggregate data for the dashboard.
4. **Dashboard Frontend:** Implement the `/admin` view in `worker.js` using the approved design.
5. **Scraper Update:** (Optional) Update `sdci_scraper.py` to better surface metadata if needed.

## 6. Security & Access
- The `/admin` route will be protected by Cloudflare Access (consistent with existing `/api/user` patterns).
- No sensitive PII (leads' emails, etc.) should be exposed in the high-level metrics without proper auth context.
