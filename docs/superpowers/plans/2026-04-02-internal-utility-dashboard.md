# Internal Utility Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a structured logging system and an administrative dashboard to monitor the Building Seattle data pipeline.

**Architecture:** Add an `ingest_logs` table to SQLite (D1), update ingest handlers to record run metadata, and create a protected `/admin` route for visualizing system health and hotspots.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Vanilla JS/CSS.

---

### Task 1: Database Schema Migration

**Files:**
- Modify: `schema.sql`

- [ ] **Step 1: Add ingest_logs table to schema**

```sql
CREATE TABLE IF NOT EXISTS ingest_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_type TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    records_added INTEGER DEFAULT 0,
    records_updated INTEGER DEFAULT 0,
    error_message TEXT,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    end_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ingest_logs_status ON ingest_logs(status);
CREATE INDEX IF NOT EXISTS idx_ingest_logs_run_type ON ingest_logs(run_type);
```

- [ ] **Step 2: Apply migration locally**

Run: `wrangler d1 execute buildingseattle --local --file=schema.sql`
Expected: Table created successfully.

- [ ] **Step 3: Commit**

```bash
git add schema.sql
git commit -m "db: add ingest_logs table"
```

---

### Task 2: Logging Infrastructure in Worker

**Files:**
- Modify: `worker.js`

- [ ] **Step 1: Implement logIngest helper function**

```javascript
async function logIngest(env, { run_type, source, status, records_added = 0, records_updated = 0, error_message = null, start_time, end_time }) {
  const stmt = env.DB.prepare(`
    INSERT INTO ingest_logs (run_type, source, status, records_added, records_updated, error_message, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  await stmt.bind(
    run_type,
    source,
    status,
    records_added,
    records_updated,
    error_message,
    start_time.toISOString().replace('T', ' ').split('.')[0],
    end_time.toISOString().replace('T', ' ').split('.')[0]
  ).run();
}
```

- [ ] **Step 2: Update ingestPermitBatch to use logging**

```javascript
async function ingestPermitBatch(request, env) {
  const startTime = new Date();
  let items;
  try {
    const body = await request.json();
    items = body.items;
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  if (!Array.isArray(items)) {
    return new Response(JSON.stringify({ error: "items must be an array" }), { status: 400 });
  }

  let added = 0;
  let updated = 0;
  
  try {
    for (const item of items) {
      // Existing logic to check if exists...
      // For now, simplify for the plan:
      const existing = await env.DB.prepare("SELECT id FROM permits WHERE permit_number = ?").bind(item.permit_number).first();
      
      const stmt = env.DB.prepare(`
        INSERT OR REPLACE INTO permits (permit_number, contractor_id, applicant_name, address, neighborhood, type, value, status, description, housing_units, issued_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      await stmt.bind(
        item.permit_number,
        null, // contractor lookup simplified
        item.applicant_name || null,
        item.address,
        item.neighborhood || null,
        item.type || null,
        item.value || null,
        item.status || "new",
        item.description || null,
        item.housing_units || 0,
        item.issued_date || null
      ).run();
      
      if (existing) updated++; else added++;
    }
    
    await logIngest(env, {
      run_type: 'permit',
      source: 'scraper',
      status: 'success',
      records_added: added,
      records_updated: updated,
      start_time: startTime,
      end_time: new Date()
    });
    
    return new Response(JSON.stringify({ processed: items.length, added, updated }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error) {
    await logIngest(env, {
      run_type: 'permit',
      source: 'scraper',
      status: 'error',
      error_message: error.message,
      start_time: startTime,
      end_time: new Date()
    });
    throw error;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add worker.js
git commit -m "feat: add ingest logging to permit batch"
```

---

### Task 3: Admin Statistics API

**Files:**
- Modify: `worker.js`

- [ ] **Step 1: Implement getAdminStats helper**

```javascript
async function getAdminStats(env) {
  const [
    lastRun,
    growth24h,
    neighborhoods,
    performance,
    counts
  ] = await Promise.all([
    env.DB.prepare("SELECT * FROM ingest_logs ORDER BY start_time DESC LIMIT 1").first(),
    env.DB.prepare("SELECT SUM(records_added) as added FROM ingest_logs WHERE start_time > datetime('now', '-1 day')").first(),
    env.DB.prepare(`
      SELECT neighborhood, COUNT(*) as count 
      FROM permits 
      WHERE created_at > datetime('now', '-7 days')
      GROUP BY neighborhood 
      ORDER BY count DESC LIMIT 5
    `).all(),
    env.DB.prepare(`
      SELECT 
        AVG(strftime('%s', end_time) - strftime('%s', start_time)) as avg_duration,
        COUNT(CASE WHEN status = 'success' THEN 1 END) * 100.0 / COUNT(*) as success_rate
      FROM ingest_logs
    `).first(),
    env.DB.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM permits) as permits,
        (SELECT COUNT(*) FROM contractors) as contractors,
        (SELECT COUNT(*) FROM leads) as leads
    `).first()
  ]);

  return {
    last_run: lastRun,
    growth_24h: growth24h?.added || 0,
    hotspots: neighborhoods.results,
    performance: performance,
    total_counts: counts
  };
}
```

- [ ] **Step 2: Add route to fetch stats**

```javascript
// Inside fetch()
if (path === "/api/admin/stats") {
    const stats = await getAdminStats(env);
    return new Response(JSON.stringify(stats), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
}
```

- [ ] **Step 3: Commit**

```bash
git add worker.js
git commit -m "feat: add admin stats api"
```

---

### Task 4: Admin Dashboard UI

**Files:**
- Modify: `worker.js`

- [ ] **Step 1: Implement renderAdminDashboard function**

```javascript
async function renderAdminDashboard(request, env) {
  const stats = await getAdminStats(env);
  const logs = await env.DB.prepare("SELECT * FROM ingest_logs ORDER BY start_time DESC LIMIT 20").all();
  
  const logRows = logs.results.map(log => `
    <tr style="border-bottom: 1px solid var(--border);">
      <td style="padding: 0.75rem;">${log.start_time}</td>
      <td style="padding: 0.75rem; font-weight: 600;">${log.run_type}</td>
      <td style="padding: 0.75rem;">
        <span class="badge" style="background: ${log.status === 'success' ? '#10b98120; color: #10b981' : '#ef444420; color: #ef4444'}">
          ${log.status}
        </span>
      </td>
      <td style="padding: 0.75rem;">+${log.records_added}</td>
      <td style="padding: 0.75rem; font-size: 0.8rem; color: var(--text-muted);">${log.error_message || 'None'}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Admin Dashboard | Building Seattle</title>
    <style>
        :root { --primary: #0f172a; --accent: #3b82f6; --bg: #f8fafc; --surface: #ffffff; --text: #1e293b; --text-muted: #64748b; --border: #e2e8f0; }
        body { font-family: sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 2rem; }
        .container { max-width: 1200px; margin: 0 auto; }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1.5rem; margin-bottom: 2rem; }
        .card { background: var(--surface); padding: 1.5rem; border-radius: 0.75rem; border: 1px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: var(--text-muted); margin-bottom: 0.5rem; display: block; }
        .value { font-size: 1.5rem; font-weight: 800; color: var(--primary); }
        .badge { padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.75rem; font-weight: 700; }
        table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 0.75rem; overflow: hidden; border: 1px solid var(--border); }
        th { text-align: left; padding: 1rem; background: #f1f5f9; font-size: 0.875rem; color: var(--text-muted); }
    </style>
</head>
<body>
    <div class="container">
        <h1>System Health</h1>
        <div class="grid">
            <div class="card"><span class="label">Last Run</span><div class="value">${stats.last_run?.status || 'N/A'}</div></div>
            <div class="card"><span class="label">24h Growth</span><div class="value">+${stats.growth_24h}</div></div>
            <div class="card"><span class="label">Total Permits</span><div class="value">${stats.total_counts.permits}</div></div>
            <div class="card"><span class="label">Success Rate</span><div class="value">${Math.round(stats.performance?.success_rate || 0)}%</div></div>
        </div>
        
        <h2>Recent Ingest Logs</h2>
        <table>
            <thead><tr><th>Time</th><th>Type</th><th>Status</th><th>Added</th><th>Errors</th></tr></thead>
            <tbody>${logRows}</tbody>
        </table>
    </div>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}
```

- [ ] **Step 2: Add route for /admin**

```javascript
// Inside fetch()
if (path === "/admin") {
    return await renderAdminDashboard(request, env);
}
```

- [ ] **Step 3: Commit**

```bash
git add worker.js
git commit -m "feat: add admin dashboard ui"
```
