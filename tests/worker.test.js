import assert from "node:assert/strict";
import test from "node:test";

import worker, { summarizePlanReview, percentileSorted } from "../worker.js";

const samplePermits = [
  {
    id: 1,
    permit_number: "PERM123",
    contractor_id: 9,
    address: "407 Stewart St, Seattle, WA",
    neighborhood: "Downtown",
    type: "commercial",
    value: 62000000,
    status: "active",
    description: "Tower renovation",
    issued_date: "2026-03-10",
    contractor_name: "Seattle Construction Group",
    contractor_slug: "seattle-construction-group",
    contractor_specialty: "General Contractor",
    contractor_phone: "206-555-0100",
    contractor_email: "hello@scg.test",
    owner_name: null,
    owner_address: null,
    applicant_name: null,
    architect_name: null,
  },
  {
    id: 2,
    permit_number: "PERM456",
    contractor_id: 10,
    address: "5100 Ballard Ave NW, Seattle, WA",
    neighborhood: "Ballard",
    type: "residential",
    value: 1800000,
    status: "pending",
    description: "Townhome project",
    issued_date: "2026-03-12",
    contractor_name: "Ballard Build Co",
    contractor_slug: "ballard-build-co",
    contractor_specialty: "Residential Builder",
    contractor_phone: null,
    contractor_email: null,
    owner_name: null,
    owner_address: null,
    applicant_name: null,
    architect_name: null,
  },
];

const sampleContractors = [
  {
    id: 9,
    name: "Seattle Construction Group",
    slug: "seattle-construction-group",
    specialty: "General Contractor",
    description: "Commercial builder",
    active_projects: 4,
    phone: "206-555-0100",
    email: "hello@scg.test",
    website: "https://scg.test",
  },
];

const sampleStatusChanges = [
  {
    id: 1,
    permit_number: "PERM123",
    previous_status: "pending",
    new_status: "active",
    changed_at: "2026-05-15 10:00:00",
    address: "407 Stewart St, Seattle, WA",
    neighborhood: "Downtown",
    type: "commercial",
    value: 62000000,
    issued_date: "2026-03-10",
    contractor_name: "Seattle Construction Group",
    contractor_slug: "seattle-construction-group",
  },
];

function createEnv() {
  const permits = structuredClone(samplePermits);
  const contractors = structuredClone(sampleContractors);
  const statusChanges = structuredClone(sampleStatusChanges);
  const leads = [];
  const ingestLogs = [];

  return {
    _state: { permits, contractors, statusChanges, leads, ingestLogs },
    INGEST_API_TOKEN: "test-ingest-token",
    DB: {
      prepare(query) {
        const sql = query.replace(/\s+/g, " ").trim();
        let params = [];

        const statement = {
          bind(...values) {
            params = values;
            return statement;
          },
          async all() {
            if (sql.includes("SELECT * FROM ingest_logs ORDER BY start_time DESC LIMIT 20")) {
              return { results: ingestLogs.map((log) => ({ ...log })) };
            }

            if (sql.includes("SELECT * FROM leads ORDER BY created_at DESC LIMIT 50")) {
              return { results: leads.map((lead) => ({ ...lead })) };
            }

            if (sql.includes("SELECT DISTINCT neighborhood")) {
              const neighborhoods = [...new Set(permits.map((permit) => permit.neighborhood).filter(Boolean))]
                .sort()
                .map((neighborhood) => ({ neighborhood }));
              return { results: neighborhoods };
            }

            if (sql.includes("SELECT DISTINCT type")) {
              const types = [...new Set(permits.map((permit) => permit.type).filter(Boolean))]
                .sort()
                .map((type) => ({ type }));
              return { results: types };
            }

            if (sql.includes("SELECT DISTINCT status")) {
              const statuses = [...new Set(permits.map((permit) => permit.status).filter(Boolean))]
                .sort()
                .map((status) => ({ status }));
              return { results: statuses };
            }

            if (sql.includes("SELECT id, name FROM contractors")) {
              return { results: contractors.map((contractor) => ({ id: contractor.id, name: contractor.name })) };
            }

            if (sql.includes("SELECT id, slug FROM contractors WHERE slug IN")) {
              return {
                results: contractors
                  .filter((contractor) => params.includes(contractor.slug))
                  .map((contractor) => ({ id: contractor.id, slug: contractor.slug })),
              };
            }

            if (sql.includes("SELECT permit_number, status FROM permits WHERE permit_number IN")) {
              return {
                results: permits
                  .filter((permit) => params.includes(permit.permit_number))
                  .map((permit) => ({ permit_number: permit.permit_number, status: permit.status })),
              };
            }

            if (sql.includes("SELECT permit_number FROM permits WHERE permit_number IN")) {
              return {
                results: permits
                  .filter((permit) => params.includes(permit.permit_number))
                  .map((permit) => ({ permit_number: permit.permit_number })),
              };
            }

            if (sql.includes("FROM permits p") && sql.includes("WHERE 1=1")) {
              let results = permits.map((permit) => ({ ...permit }));

              if (sql.includes("p.neighborhood = ?")) {
                results = results.filter((permit) => permit.neighborhood === params[0]);
              }

              if (sql.includes("p.type = ?")) {
                const typeParam = params[params.length - 1];
                results = results.filter((permit) => permit.type === typeParam);
              }

              results.sort((a, b) => String(b.issued_date).localeCompare(String(a.issued_date)));
              return { results };
            }

            if (sql.includes("FROM permit_status_changes sc")) {
              return {
                results: statusChanges
                  .slice()
                  .sort((a, b) => String(b.changed_at).localeCompare(String(a.changed_at)) || b.id - a.id)
                  .map((change) => ({ ...change }))
                  .slice(0, 20),
              };
            }

            if (sql.includes("WHERE p.permit_number = ?")) {
              const permit = permits.find((item) => item.permit_number === params[0]);
              return { results: permit ? [{ ...permit }] : [] };
            }

            if (sql.includes("SELECT * FROM permits WHERE contractor_id = ?")) {
              return {
                results: permits
                  .filter((permit) => permit.contractor_id === params[0])
                  .map((permit) => ({ ...permit })),
              };
            }

            throw new Error(`Unhandled all() query: ${sql}`);
          },
          async first() {
            if (sql.includes("SELECT * FROM contractors WHERE slug = ?")) {
              return contractors.find((contractor) => contractor.slug === params[0]) || null;
            }

            if (sql.includes("SELECT * FROM ingest_logs ORDER BY start_time DESC LIMIT 1")) {
              return ingestLogs[0] || null;
            }

            if (sql.includes("SELECT SUM(records_added) as added FROM ingest_logs")) {
              return { added: ingestLogs.reduce((sum, log) => sum + (log.records_added || 0), 0) };
            }

            if (sql.includes("COUNT(CASE WHEN status = 'success' THEN 1 END)")) {
              return { avg_duration: 0, success_rate: 100 };
            }

            if (sql.includes("(SELECT COUNT(*) FROM permits) as permits")) {
              return { permits: permits.length, contractors: contractors.length, leads: leads.length };
            }

            if (sql.includes("SELECT COUNT(*) as count FROM leads")) {
              return { count: leads.length };
            }

            if (sql.includes("SELECT COUNT(*) as count FROM permits")) {
              return { count: permits.length };
            }

            if (sql.includes("SELECT COUNT(*) as total FROM permits p")) {
              return { total: permits.length };
            }

            if (sql.includes("SELECT end_time FROM ingest_logs")) {
              return null;
            }

            if (sql.includes("SELECT COUNT(*) as count FROM contractors")) {
              return { count: contractors.length };
            }

            if (sql.includes("SELECT id FROM contractors WHERE name = ? COLLATE NOCASE")) {
              const contractor = contractors.find(
                (item) => item.name.toLowerCase() === String(params[0]).toLowerCase(),
              );
              return contractor ? { id: contractor.id } : null;
            }

            if (sql.includes("SELECT id FROM permits WHERE permit_number = ?")) {
              const permit = permits.find((item) => item.permit_number === params[0]);
              return permit ? { id: permit.id } : null;
            }

            if (sql.includes("SELECT status FROM permits WHERE permit_number = ?")) {
              const permit = permits.find((item) => item.permit_number === params[0]);
              return permit ? { status: permit.status } : null;
            }

            throw new Error(`Unhandled first() query: ${sql}`);
          },
          async run() {
            if (sql.includes("INSERT INTO ingest_logs")) {
              ingestLogs.push({
                run_type: params[0],
                source: params[1],
                status: params[2],
                records_added: params[3],
                records_updated: params[4],
                error_message: params[5],
              });
              return { success: true };
            }

            if (sql.includes("INSERT INTO leads")) {
              leads.push({
                email: params[0],
                company: params[1],
                interest: params[2],
              });
              return { success: true };
            }

            if (sql.includes("INSERT INTO permits") && sql.includes("ON CONFLICT(permit_number)")) {
              const existingIndex = permits.findIndex((permit) => permit.permit_number === params[0]);
              const baseFields = {
                address: params[3],
                neighborhood: params[4],
                type: params[5],
                value: params[6],
                status: params[7],
                description: params[8],
                housing_units: params[9],
                applied_date: params[10],
                issued_date: params[11],
                completed_date: params[12],
                housing_units_added: params[13],
                housing_units_removed: params[14],
                housing_category: params[15],
                dwelling_unit_type: params[16],
                zoning: params[17],
                parent_permit_number: params[18],
                related_mup: params[19],
                number_review_cycles: params[20],
                total_days_plan_review: params[21],
                days_out_corrections: params[22],
              };
              if (existingIndex >= 0) {
                const existing = permits[existingIndex];
                permits[existingIndex] = {
                  ...existing,
                  ...baseFields,
                  contractor_id: params[1] ?? existing.contractor_id,
                  applicant_name: params[2] ?? existing.applicant_name,
                  updated_at: "2026-05-16 12:00:00",
                };
              } else {
                permits.push({
                  id: permits.length + 1,
                  permit_number: params[0],
                  contractor_id: params[1],
                  applicant_name: params[2],
                  ...baseFields,
                });
              }
              return { success: true };
            }

            if (sql.includes("INSERT INTO permit_status_changes")) {
              statusChanges.push({
                id: statusChanges.length + 1,
                permit_number: params[0],
                previous_status: params[1],
                new_status: params[2],
                changed_at: "2026-05-16 12:00:00",
              });
              return { success: true };
            }

            if (sql.includes("INSERT INTO contractors") && sql.includes("license_status")) {
              const existingIndex = contractors.findIndex((contractor) => contractor.slug === params[1]);
              const contractor = {
                id: existingIndex >= 0 ? contractors[existingIndex].id : contractors.length + 20,
                name: params[0],
                slug: params[1],
                specialty: params[2],
                license_number: params[3],
                license_status: params[4],
                ubi: params[5],
                insurance_amount: params[6],
                insurance_expires_date: params[7],
              };
              if (existingIndex >= 0) {
                contractors[existingIndex] = { ...contractors[existingIndex], ...contractor };
              } else {
                contractors.push(contractor);
              }
              return { success: true };
            }

            if (sql.includes("UPDATE permits SET")) {
              const permit = permits.find((item) => item.permit_number === params[17]);
              if (permit) {
                permit.contractor_id = params[0] ?? permit.contractor_id;
                permit.permit_detail_url = params[1] ?? permit.permit_detail_url;
                permit.contractor_license = params[2] ?? permit.contractor_license;
                permit.contractor_source = params[3] ?? permit.contractor_source;
                permit.work_performed_by = params[4] ?? permit.work_performed_by;
                permit.review_level = params[5] ?? permit.review_level;
                permit.primary_property_use = params[6] ?? permit.primary_property_use;
                permit.parcel_number = params[7] ?? permit.parcel_number;
                permit.detailed_description = params[8] ?? permit.detailed_description;
                permit.record_status_detail = params[9] ?? permit.record_status_detail;
                permit.expires_date = params[10] ?? permit.expires_date;
                permit.housing_units_added = params[11] ?? permit.housing_units_added;
                permit.housing_units_removed = params[12] ?? permit.housing_units_removed;
                permit.housing_units_existing = params[13] ?? permit.housing_units_existing;
                permit.sleeping_rooms = params[14] ?? permit.sleeping_rooms;
                permit.has_required_inspections = params[15];
                permit.has_completed_inspections = params[16];
                permit.last_enriched_at = "2026-05-16 12:00:00";
              }
              return { success: true };
            }

            if (sql.includes("INSERT INTO contractors")) {
              return { success: true };
            }

            if (sql.includes("DELETE FROM permit_status_changes")) {
              const changes = statusChanges.length;
              statusChanges.length = 0;
              return { success: true, meta: { changes } };
            }

            if (sql.includes("DELETE FROM permits")) {
              const changes = permits.length;
              permits.length = 0;
              return { success: true, meta: { changes } };
            }

            if (sql.includes("DELETE FROM contractors")) {
              const changes = contractors.length;
              contractors.length = 0;
              return { success: true, meta: { changes } };
            }

            throw new Error(`Unhandled run() query: ${sql}`);
          },
        };

        return statement;
      },
      async batch(statements) {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        return results;
      },
    },
  };
}

function createCtx() {
  return {
    waitUntil() {},
  };
}

test("GET /permits renders a public permit browser instead of returning 404", async () => {
  const response = await worker.fetch(
    new Request("http://example.com/permits?neighborhood=Ballard&type=residential"),
    createEnv(),
    createCtx(),
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /text\/html/);

  const html = await response.text();
  assert.match(html, /Browse Seattle permits/i);
  assert.match(html, /action="\/permits"/);
  assert.match(html, /option value="Ballard" selected/);
  assert.match(html, /option value="residential" selected/);
  assert.match(html, /\/permits\/PERM456/);
  assert.doesNotMatch(html, /\/api\/permits\?permit=/);
  assert.match(html, /Recently changed status/);
  assert.match(html, /pending/);
  assert.match(html, /active/);
});

test("GET /admin rejects public requests before reading dashboard data", async () => {
  const response = await worker.fetch(new Request("http://example.com/admin"), createEnv(), createCtx());

  assert.equal(response.status, 401);
  assert.match(response.headers.get("Content-Type") || "", /application\/json/);
});

test("HTML and JSON responses include baseline security headers", async () => {
  const htmlResponse = await worker.fetch(new Request("http://example.com/permits"), createEnv(), createCtx());
  const jsonResponse = await worker.fetch(new Request("http://example.com/api/permits"), createEnv(), createCtx());

  for (const response of [htmlResponse, jsonResponse]) {
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
    assert.match(response.headers.get("Strict-Transport-Security") || "", /max-age=/);
  }

  assert.match(htmlResponse.headers.get("Content-Security-Policy") || "", /frame-ancestors 'none'/);
});

test("GET /api/permits honors bounded per_page requests", async () => {
  const response = await worker.fetch(new Request("http://example.com/api/permits?per_page=1"), createEnv(), createCtx());

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.per_page, 1);
  assert.equal(payload.results.length, 1);
});

test("permit browser escapes permit and contractor data before rendering HTML", async () => {
  const env = createEnv();
  env._state.permits[0].address = `<img src=x onerror=alert(1)>`;
  env._state.permits[0].description = `<script>alert("permit")</script>`;
  env._state.permits[0].contractor_name = `<b>Unsafe Contractor</b>`;

  const response = await worker.fetch(new Request("http://example.com/permits"), env, createCtx());
  const html = await response.text();

  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.doesNotMatch(html, /<script>alert\("permit"\)<\/script>/);
  assert.doesNotMatch(html, /<b>Unsafe Contractor<\/b>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(&quot;permit&quot;\)&lt;\/script&gt;/);
});

test("GET /favicon.ico returns the site icon", async () => {
  const response = await worker.fetch(new Request("http://example.com/favicon.ico"), createEnv(), createCtx());

  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /image\/png/);
});

test("summarizePlanReview computes count, mean, median, p90, and day buckets", () => {
  const values = [10, 20, 30, 40, 200, -5, null, "x"];
  const s = summarizePlanReview(values);

  assert.equal(s.count, 5); // negatives and non-numerics dropped
  assert.equal(s.median, 30);
  assert.equal(s.mean, 60); // (10+20+30+40+200)/5
  assert.equal(s.max, 200);
  assert.equal(s.histogram.length, 6);
  // 10,20,30 land in 0–30; 40 in 31–60; 200 in 181–365
  assert.equal(s.histogram[0].count, 3);
  assert.equal(s.histogram[1].count, 1);
  assert.equal(s.histogram[4].count, 1);
});

test("summarizePlanReview handles empty input without dividing by zero", () => {
  const s = summarizePlanReview([]);
  assert.equal(s.count, 0);
  assert.equal(s.mean, 0);
  assert.equal(s.median, 0);
  assert.equal(s.p90, 0);
  assert.equal(s.histogram.reduce((sum, b) => sum + b.count, 0), 0);
});

test("percentileSorted interpolates between ranks", () => {
  assert.equal(percentileSorted([10, 20, 30, 40], 50), 25);
  assert.equal(percentileSorted([5], 90), 5);
  assert.equal(percentileSorted([], 50), 0);
});

test("GET /api/plan-review returns a plan-review summary payload", async () => {
  const response = await worker.fetch(new Request("http://example.com/api/plan-review"), createEnv(), createCtx());

  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /application\/json/);
  const payload = await response.json();
  assert.ok(payload.summary, "summary present");
  assert.equal(payload.summary.histogram.length, 6);
  assert.ok(Array.isArray(payload.by_type));
  assert.ok(Array.isArray(payload.by_neighborhood));
  assert.ok(Array.isArray(payload.by_cycles));
});

test("GET /insights/plan-review renders the insights page", async () => {
  const response = await worker.fetch(new Request("http://example.com/insights/plan-review"), createEnv(), createCtx());

  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /text\/html/);
  const html = await response.text();
  assert.match(html, /plan review/i);
  assert.match(html, /Insights/);
});

test("GET /api/status-changes returns recent permit status transitions", async () => {
  const response = await worker.fetch(new Request("http://example.com/api/status-changes"), createEnv(), createCtx());

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.total, 1);
  assert.equal(payload.results[0].permit_number, "PERM123");
  assert.equal(payload.results[0].previous_status, "pending");
  assert.equal(payload.results[0].new_status, "active");
});

test("GET /permits/:permit_number hides empty people cards and removes alert CTAs", async () => {
  const response = await worker.fetch(new Request("http://example.com/permits/PERM123"), createEnv(), createCtx());

  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Request Project Updates/i);
  assert.doesNotMatch(html, /Contact Property Owner/);
  assert.doesNotMatch(html, /Watch This Project/);
  assert.doesNotMatch(html, /Property Owner/);
  assert.doesNotMatch(html, /Applicant/);
  assert.doesNotMatch(html, /Architect/);
});

test("lead modals expose accessible dialog markup and associated labels", async () => {
  const response = await worker.fetch(new Request("http://example.com/permits/PERM123"), createEnv(), createCtx());

  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="leadModalTitle"/);
  assert.match(html, /aria-label="Close dialog"/);
  assert.match(html, /<label for="lead-email">Email \*<\/label>/);
  assert.match(html, /<input[^>]+id="lead-email"/);
});

test("GET /permits/:permit_number renders enriched permit fields safely", async () => {
  const env = createEnv();
  Object.assign(env._state.permits[0], {
    review_level: "Field",
    permit_detail_url: "https://services.seattle.gov/detail/PERM123",
    detailed_description: `<script>alert("detail")</script>`,
  });

  const response = await worker.fetch(new Request("http://example.com/permits/PERM123"), env, createCtx());
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Permit Intelligence/);
  assert.match(html, /https:\/\/services\.seattle\.gov\/detail\/PERM123/);
  assert.doesNotMatch(html, /<script>alert\("detail"\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;detail&quot;\)&lt;\/script&gt;/);
});

test("POST /ingest/permit/batch rejects payloads without an items array", async () => {
  const response = await worker.fetch(
    new Request("http://example.com/ingest/permit/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": "test-ingest-token",
      },
      body: JSON.stringify({ items: null }),
    }),
    createEnv(),
    createCtx(),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "items must be an array" });
});

test("POST /ingest/permit/batch links permits to imported contractors", async () => {
  const env = createEnv();
  const response = await worker.fetch(
    new Request("http://example.com/ingest/permit/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": "test-ingest-token",
      },
      body: JSON.stringify({
        items: [
          {
            permit_number: "PERM999",
            contractor_name: "Seattle Construction Group",
            address: "123 Test St, Seattle, WA",
          },
        ],
      }),
    }),
    env,
    createCtx(),
  );

  assert.equal(response.status, 200);
  assert.equal(env._state.permits.find((permit) => permit.permit_number === "PERM999").contractor_id, 9);
});

test("POST /ingest/permit/batch records status changes for existing permits", async () => {
  const env = createEnv();
  const response = await worker.fetch(
    new Request("http://example.com/ingest/permit/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": "test-ingest-token",
      },
      body: JSON.stringify({
        items: [
          {
            permit_number: "PERM456",
            address: "5100 Ballard Ave NW, Seattle, WA",
            status: "active",
          },
        ],
      }),
    }),
    env,
    createCtx(),
  );

  assert.equal(response.status, 200);
  const change = env._state.statusChanges.find((item) => item.permit_number === "PERM456");
  assert.equal(change.previous_status, "pending");
  assert.equal(change.new_status, "active");
});

test("POST /ingest/permit preserves enrichment-only columns on re-ingest", async () => {
  const env = createEnv();
  const seeded = env._state.permits.find((permit) => permit.permit_number === "PERM456");
  seeded.parcel_number = "DV1200889";
  seeded.contractor_license = "GREENBN861QE";
  seeded.review_level = "Field";
  seeded.has_required_inspections = 1;
  seeded.last_enriched_at = "2026-05-10 09:00:00";

  const response = await worker.fetch(
    new Request("http://example.com/ingest/permit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": "test-ingest-token",
      },
      body: JSON.stringify({
        permit_number: "PERM456",
        address: "5100 Ballard Ave NW, Seattle, WA",
        value: 2200000,
        status: "active",
      }),
    }),
    env,
    createCtx(),
  );

  assert.equal(response.status, 200);
  const permit = env._state.permits.find((item) => item.permit_number === "PERM456");
  assert.equal(permit.value, 2200000, "base column should update");
  assert.equal(permit.status, "active", "base column should update");
  assert.equal(permit.parcel_number, "DV1200889", "enrichment column must survive base re-ingest");
  assert.equal(permit.contractor_license, "GREENBN861QE", "enrichment column must survive base re-ingest");
  assert.equal(permit.review_level, "Field", "enrichment column must survive base re-ingest");
  assert.equal(permit.has_required_inspections, 1, "enrichment column must survive base re-ingest");
  assert.equal(permit.last_enriched_at, "2026-05-10 09:00:00", "enrichment column must survive base re-ingest");
  assert.equal(permit.contractor_id, 10, "existing contractor_id should not be cleared when payload omits contractor_name");
});

test("POST /ingest/permit/enrichment/batch links permits from contractor license enrichment", async () => {
  const env = createEnv();
  env._state.permits.find((permit) => permit.permit_number === "PERM456").contractor_id = null;

  const response = await worker.fetch(
    new Request("http://example.com/ingest/permit/enrichment/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": "test-ingest-token",
      },
      body: JSON.stringify({
        items: [
          {
            permit_number: "PERM456",
            permit_detail_url: "https://services.seattle.gov/detail/PERM456",
            contractor_name: "Green Built Northwest LLC",
            contractor_license: "GREENBN861QE",
            contractor_license_status: "ACTIVE",
            contractor_ubi: "603448643",
            contractor_insurance_amount: "1000000.0000",
            contractor_insurance_expires_date: "2026-12-26T00:00:00.000",
            work_performed_by: "Licensed Contractor",
            review_level: "Field",
            primary_property_use: "Single Family/Duplex",
            parcel_number: "DV1200889",
            detailed_description: "Detailed SDCI project description",
            record_status_detail: "Issued",
            expires_date: "12/26/2026",
            housing_units_existing: "1",
            housing_units_added: "0",
            housing_units_removed: "0",
            sleeping_rooms: "3",
            has_required_inspections: true,
          },
        ],
      }),
    }),
    env,
    createCtx(),
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.processed, 1);
  assert.equal(payload.contractors_linked, 1);

  const contractor = env._state.contractors.find((item) => item.slug === "green-built-northwest-llc");
  assert.equal(contractor.name, "Green Built Northwest LLC");
  assert.equal(contractor.license_number, "GREENBN861QE");
  assert.equal(contractor.license_status, "ACTIVE");

  const permit = env._state.permits.find((item) => item.permit_number === "PERM456");
  assert.equal(permit.contractor_id, contractor.id);
  assert.equal(permit.contractor_license, "GREENBN861QE");
  assert.equal(permit.review_level, "Field");
  assert.equal(permit.parcel_number, "DV1200889");
  assert.equal(permit.detailed_description, "Detailed SDCI project description");
  assert.equal(permit.expires_date, "2026-12-26");
  assert.equal(permit.sleeping_rooms, 3);
  assert.equal(permit.has_required_inspections, 1);
});

test("POST /ingest/refresh clears imported permit and contractor data after explicit confirmation", async () => {
  const env = createEnv();
  const response = await worker.fetch(
    new Request("http://example.com/ingest/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": "test-ingest-token",
      },
      body: JSON.stringify({ confirm: "replace-all" }),
    }),
    env,
    createCtx(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    permits_deleted: 2,
    contractors_deleted: 1,
  });
  assert.equal(env._state.permits.length, 0);
  assert.equal(env._state.contractors.length, 0);
});

test("POST /ingest/permit rejects requests without the ingest token", async () => {
  const response = await worker.fetch(
    new Request("http://example.com/ingest/permit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        permit_number: "PERM999",
        address: "123 Test St, Seattle, WA",
      }),
    }),
    createEnv(),
    createCtx(),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized ingest request" });
});

test("POST /ingest/permit accepts requests with the configured ingest token", async () => {
  const response = await worker.fetch(
    new Request("http://example.com/ingest/permit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": "test-ingest-token",
      },
      body: JSON.stringify({
        permit_number: "PERM999",
        address: "123 Test St, Seattle, WA",
      }),
    }),
    createEnv(),
    createCtx(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
});
