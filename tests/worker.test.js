import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.js";

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

function createEnv() {
  const permits = structuredClone(samplePermits);
  const contractors = structuredClone(sampleContractors);
  const leads = [];
  const ingestLogs = [];

  return {
    _state: { permits, contractors, leads, ingestLogs },
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

            if (sql.includes("INSERT OR REPLACE INTO permits")) {
              const existingIndex = permits.findIndex((permit) => permit.permit_number === params[0]);
              const permit = {
                id: existingIndex >= 0 ? permits[existingIndex].id : permits.length + 1,
                permit_number: params[0],
                contractor_id: params[1],
                applicant_name: params[2],
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
              };
              if (existingIndex >= 0) {
                permits[existingIndex] = permit;
              } else {
                permits.push(permit);
              }
              return { success: true };
            }

            if (sql.includes("INSERT INTO contractors")) {
              return { success: true };
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
