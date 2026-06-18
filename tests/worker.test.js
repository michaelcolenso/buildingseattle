import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  summarizePlanReview,
  percentileSorted,
  summarizeDays,
  summarizeNetHousing,
  projectSeattle,
  renderPermitTimeline,
  renderProjectReviewSummary,
} from "../worker.js";

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
  const alertSubscriptions = [];
  const sentEmails = [];
  const ingestLogs = [];

  return {
    _state: { permits, contractors, statusChanges, leads, alertSubscriptions, sentEmails, ingestLogs },
    INGEST_API_TOKEN: "test-ingest-token",
    EMAIL: {
      async send(message) {
        sentEmails.push(structuredClone(message));
        return { messageId: `message-${sentEmails.length}` };
      },
    },
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
            if (sql.includes("FROM permit_alert_subscriptions s") && sql.includes("JOIN permit_status_changes sc")) {
              return {
                results: alertSubscriptions.flatMap((subscription) => {
                  if (subscription.status !== "active") return [];
                  return statusChanges
                    .filter(
                      (change) =>
                        change.permit_number === subscription.permit_number &&
                        change.id > (subscription.last_notified_change_id || 0),
                    )
                    .map((change) => {
                      const permit = permits.find((item) => item.permit_number === change.permit_number);
                      return {
                        subscription_id: subscription.id,
                        email: subscription.email,
                        permit_number: subscription.permit_number,
                        unsubscribe_token: subscription.unsubscribe_token,
                        change_id: change.id,
                        previous_status: change.previous_status,
                        new_status: change.new_status,
                        changed_at: change.changed_at,
                        address: permit?.address || null,
                      };
                    });
                }),
              };
            }

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
            if (sql.includes("SELECT permit_number, address, status FROM permits WHERE permit_number = ?")) {
              const permit = permits.find((item) => item.permit_number === params[0]);
              return permit
                ? { permit_number: permit.permit_number, address: permit.address, status: permit.status }
                : null;
            }

            if (sql.includes("FROM permit_alert_subscriptions") && sql.includes("lower(email) = ?")) {
              return (
                alertSubscriptions.find(
                  (subscription) =>
                    subscription.email.toLowerCase() === String(params[0]).toLowerCase() &&
                    subscription.permit_number === params[1],
                ) || null
              );
            }

            if (sql.includes("FROM permit_alert_subscriptions") && sql.includes("confirmation_token_hash = ?")) {
              return (
                alertSubscriptions.find(
                  (subscription) =>
                    subscription.confirmation_token_hash === params[0] && subscription.status === "pending",
                ) || null
              );
            }

            if (sql.includes("FROM permit_alert_subscriptions") && sql.includes("unsubscribe_token = ?")) {
              return alertSubscriptions.find((subscription) => subscription.unsubscribe_token === params[0]) || null;
            }

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
            if (sql.includes("INSERT INTO permit_alert_subscriptions")) {
              const existingIndex = alertSubscriptions.findIndex(
                (subscription) =>
                  subscription.email.toLowerCase() === String(params[0]).toLowerCase() &&
                  subscription.permit_number === params[1],
              );
              const subscription = {
                id: existingIndex >= 0 ? alertSubscriptions[existingIndex].id : alertSubscriptions.length + 1,
                email: String(params[0]).toLowerCase(),
                permit_number: params[1],
                status: "pending",
                confirmation_token_hash: params[2],
                unsubscribe_token: params[3],
                confirmation_sent_at: "2026-06-12 08:00:00",
                confirmed_at: null,
                unsubscribed_at: null,
                last_notified_change_id: null,
                last_notified_at: null,
              };
              if (existingIndex >= 0) {
                alertSubscriptions[existingIndex] = subscription;
              } else {
                alertSubscriptions.push(subscription);
              }
              return { success: true, meta: { changes: 1 } };
            }

            if (sql.includes("DELETE FROM permit_alert_subscriptions")) {
              const index = alertSubscriptions.findIndex(
                (subscription) =>
                  subscription.email === params[0] &&
                  subscription.permit_number === params[1] &&
                  subscription.confirmation_token_hash === params[2] &&
                  subscription.status === "pending",
              );
              if (index >= 0) alertSubscriptions.splice(index, 1);
              return { success: true, meta: { changes: index >= 0 ? 1 : 0 } };
            }

            if (sql.includes("UPDATE permit_alert_subscriptions") && sql.includes("status = 'active'")) {
              const subscription = alertSubscriptions.find((item) => item.id === params[0]);
              if (!subscription || subscription.status !== "pending") {
                return { success: true, meta: { changes: 0 } };
              }
              subscription.status = "active";
              subscription.confirmation_token_hash = null;
              subscription.confirmed_at = "2026-06-12 08:01:00";
              subscription.last_notified_change_id = statusChanges
                .filter((change) => change.permit_number === subscription.permit_number)
                .reduce((max, change) => Math.max(max, change.id), 0);
              return { success: true, meta: { changes: 1 } };
            }

            if (sql.includes("UPDATE permit_alert_subscriptions") && sql.includes("status = 'unsubscribed'")) {
              const subscription = alertSubscriptions.find((item) => item.id === params[0]);
              if (!subscription) return { success: true, meta: { changes: 0 } };
              subscription.status = "unsubscribed";
              subscription.unsubscribed_at = "2026-06-12 08:02:00";
              return { success: true, meta: { changes: 1 } };
            }

            if (sql.includes("UPDATE permit_alert_subscriptions") && sql.includes("last_notified_change_id = ?")) {
              const subscription = alertSubscriptions.find((item) => item.id === params[2]);
              if (!subscription) return { success: true, meta: { changes: 0 } };
              subscription.last_notified_change_id = params[0];
              subscription.last_notified_at = "2026-06-12 08:03:00";
              return { success: true, meta: { changes: 1 } };
            }

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
  const promises = [];
  return {
    promises,
    waitUntil(promise) {
      promises.push(Promise.resolve(promise));
    },
  };
}

function createSitemapEnv({ statsByType = {}, rowsByType = {} } = {}) {
  return {
    DB: {
      prepare(query) {
        const sql = query.replace(/\s+/g, " ").trim();
        const marker = sql.match(/\/\* sitemap:(stats|rows):([a-z]+) \*\//);
        let params = [];

        const statement = {
          bind(...values) {
            params = values;
            return statement;
          },
          async first() {
            if (!marker || marker[1] !== "stats") {
              throw new Error(`Unhandled sitemap first() query: ${sql}`);
            }
            return statsByType[marker[2]] || { total: 0, lastmod: null };
          },
          async all() {
            if (!marker || marker[1] !== "rows") {
              throw new Error(`Unhandled sitemap all() query: ${sql}`);
            }
            const limit = Number(params[0]) || 45000;
            const offset = Number(params[1]) || 0;
            return { results: (rowsByType[marker[2]] || []).slice(offset, offset + limit) };
          },
        };

        return statement;
      },
    },
  };
}

async function subscribeAndConfirm(env, permitNumber = "PERM123", email = "reader@example.com") {
  const subscribeResponse = await worker.fetch(
    new Request("http://example.com/alerts/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, permit_number: permitNumber }),
    }),
    env,
    createCtx(),
  );
  assert.equal(subscribeResponse.status, 202);

  const confirmationEmail = env._state.sentEmails.at(-1);
  const confirmationUrl = confirmationEmail.text.match(/https?:\/\/\S+\/alerts\/confirm\?token=[^\s]+/)[0];
  const confirmResponse = await worker.fetch(new Request(confirmationUrl), env, createCtx());
  assert.equal(confirmResponse.status, 200);
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

test("GET /sitemap.xml returns a category index and splits large sections", async () => {
  const env = createSitemapEnv({
    statsByType: {
      permits: { total: 45001, lastmod: "2026-06-11" },
      addresses: { total: 2, lastmod: "2026-06-12" },
      projects: { total: 0, lastmod: null },
      contractors: { total: 3, lastmod: "2026-06-10" },
      neighborhoods: { total: 1, lastmod: "2026-06-09" },
    },
  });

  const response = await worker.fetch(new Request("http://example.com/sitemap.xml"), env, createCtx());
  const xml = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /application\/xml/);
  assert.match(xml, /<sitemapindex/);
  assert.match(xml, /http:\/\/example\.com\/sitemaps\/static\.xml/);
  assert.match(xml, /http:\/\/example\.com\/sitemaps\/permits-1\.xml/);
  assert.match(xml, /http:\/\/example\.com\/sitemaps\/permits-2\.xml/);
  assert.match(xml, /http:\/\/example\.com\/sitemaps\/addresses-1\.xml/);
  assert.match(xml, /http:\/\/example\.com\/sitemaps\/contractors-1\.xml/);
  assert.match(xml, /http:\/\/example\.com\/sitemaps\/neighborhoods\.xml/);
  assert.doesNotMatch(xml, /projects-1\.xml/);
  assert.doesNotMatch(xml, /<priority>|<changefreq>/);
});

test("GET /sitemaps/permits-1.xml returns canonical URLs with accurate lastmod values", async () => {
  const env = createSitemapEnv({
    statsByType: {
      permits: { total: 2, lastmod: "2026-06-11" },
    },
    rowsByType: {
      permits: [
        { slug: "PERM 1 & A", lastmod: "2026-06-11" },
        { slug: "PERM-2", lastmod: "2026-06-12" },
      ],
    },
  });

  const response = await worker.fetch(
    new Request("http://example.com/sitemaps/permits-1.xml"),
    env,
    createCtx(),
  );
  const xml = await response.text();

  assert.equal(response.status, 200);
  assert.match(xml, /<urlset/);
  assert.match(xml, /http:\/\/example\.com\/permits\/PERM%201%20%26%20A/);
  assert.match(xml, /<lastmod>2026-06-12<\/lastmod>/);
  assert.equal((xml.match(/<url>/g) || []).length, 2);
  assert.doesNotMatch(xml, /<priority>|<changefreq>/);
});

test("GET /sitemaps/static.xml lists the public aggregate pages", async () => {
  const env = createSitemapEnv({
    statsByType: {
      permits: { total: 2, lastmod: "2026-06-11" },
    },
  });

  const response = await worker.fetch(new Request("http://example.com/sitemaps/static.xml"), env, createCtx());
  const xml = await response.text();

  assert.equal(response.status, 200);
  assert.equal((xml.match(/<url>/g) || []).length, 9);
  assert.match(xml, /http:\/\/example\.com\/insights\/network/);
  assert.match(xml, /<lastmod>2026-06-11<\/lastmod>/);
});

test("out-of-range sitemap pages return 404", async () => {
  const env = createSitemapEnv({
    statsByType: {
      permits: { total: 2, lastmod: "2026-06-11" },
    },
  });

  const response = await worker.fetch(
    new Request("http://example.com/sitemaps/permits-2.xml"),
    env,
    createCtx(),
  );

  assert.equal(response.status, 404);
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

test("summarizeDays returns count/mean/median/p90 and drops invalid values", () => {
  const s = summarizeDays([10, 20, 30, 40, null, -3, "x"]);
  assert.equal(s.count, 4);
  assert.equal(s.median, 25);
  assert.equal(s.mean, 25);
  assert.equal(s.p90, 37);

  const empty = summarizeDays([]);
  assert.deepEqual(empty, { count: 0, mean: 0, median: 0, p90: 0 });
});

test("summarizeNetHousing sums added/removed and computes net", () => {
  const s = summarizeNetHousing([
    { added: 10, removed: 2 },
    { added: 5, removed: 0 },
    { added: null, removed: "3" },
  ]);
  assert.equal(s.added, 15);
  assert.equal(s.removed, 5);
  assert.equal(s.net, 10);

  assert.deepEqual(summarizeNetHousing([]), { added: 0, removed: 0, net: 0 });
});

test("GET /api/pipeline returns a pipeline payload", async () => {
  const response = await worker.fetch(new Request("http://example.com/api/pipeline"), createEnv(), createCtx());

  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /application\/json/);
  const payload = await response.json();
  assert.ok(payload.stages, "stages present");
  assert.ok(payload.applied_to_issued, "apply→issue timing present");
  assert.ok(Array.isArray(payload.by_type));
});

test("GET /api/housing returns a housing payload", async () => {
  const response = await worker.fetch(new Request("http://example.com/api/housing"), createEnv(), createCtx());

  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /application\/json/);
  const payload = await response.json();
  assert.ok(payload.totals, "totals present");
  assert.ok(Array.isArray(payload.by_year));
  assert.ok(Array.isArray(payload.by_neighborhood));
});

test("GET /insights renders the insights index with all three reports", async () => {
  const response = await worker.fetch(new Request("http://example.com/insights"), createEnv(), createCtx());

  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /text\/html/);
  const html = await response.text();
  assert.match(html, /Plan review times/i);
  assert.match(html, /permit pipeline/i);
  assert.match(html, /Housing units tracker/i);
  assert.match(html, /href="\/insights\/pipeline"/);
});

test("GET /insights/pipeline and /insights/housing render", async () => {
  for (const path of ["/insights/pipeline", "/insights/housing"]) {
    const response = await worker.fetch(new Request(`http://example.com${path}`), createEnv(), createCtx());
    assert.equal(response.status, 200, `${path} status`);
    const html = await response.text();
    assert.match(html, /Insights/);
  }
});

test("projectSeattle maps the bounding box corners into the padded canvas", () => {
  const W = 470;
  const H = 820;
  const pad = 40;
  // North-west corner (max lat, min lng) projects to top-left of the inner area.
  const [x0, y0] = projectSeattle(47.745, -122.435, W, H, pad);
  assert.ok(Math.abs(x0 - pad) < 0.01, "min lng -> left pad");
  assert.ok(Math.abs(y0 - pad) < 0.01, "max lat -> top pad");
  // South-east corner (min lat, max lng) projects to bottom-right of inner area.
  const [x1, y1] = projectSeattle(47.5, -122.245, W, H, pad);
  assert.ok(Math.abs(x1 - (W - pad)) < 0.01, "max lng -> right pad");
  assert.ok(Math.abs(y1 - (H - pad)) < 0.01, "min lat -> bottom pad");
});

test("GET /api/map returns neighborhood aggregates", async () => {
  const response = await worker.fetch(new Request("http://example.com/api/map"), createEnv(), createCtx());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /application\/json/);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.neighborhoods));
  assert.ok("total_permits" in payload);
  assert.ok("mapped_count" in payload);
});

test("GET /api/contractor-scorecards returns ranked contractors", async () => {
  const response = await worker.fetch(
    new Request("http://example.com/api/contractor-scorecards"),
    createEnv(),
    createCtx(),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.totals, "totals present");
  assert.ok(Array.isArray(payload.top_by_permits));
  assert.ok(Array.isArray(payload.top_by_value));
});

test("GET /api/network returns nodes and edges", async () => {
  const response = await worker.fetch(new Request("http://example.com/api/network"), createEnv(), createCtx());
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.contractors));
  assert.ok(Array.isArray(payload.neighborhoods));
  assert.ok(Array.isArray(payload.edges));
});

test("GET /insights lists all six reports", async () => {
  const response = await worker.fetch(new Request("http://example.com/insights"), createEnv(), createCtx());
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Construction activity map/i);
  assert.match(html, /Contractor scorecards/i);
  assert.match(html, /Who builds where/i);
  assert.match(html, /href="\/insights\/map"/);
  assert.match(html, /href="\/insights\/network"/);
});

test("GET /insights/map, /insights/contractors, /insights/network render", async () => {
  for (const path of ["/insights/map", "/insights/contractors", "/insights/network"]) {
    const response = await worker.fetch(new Request(`http://example.com${path}`), createEnv(), createCtx());
    assert.equal(response.status, 200, `${path} status`);
    const html = await response.text();
    assert.match(html, /Insights/);
  }
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

test("GET /permits/:permit_number hides empty people cards and shows the email alert CTA", async () => {
  const response = await worker.fetch(new Request("http://example.com/permits/PERM123"), createEnv(), createCtx());

  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Email Me Permit Updates/i);
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

test("permit alert form requests only an email and posts to the alert subscription endpoint", async () => {
  const response = await worker.fetch(new Request("http://example.com/permits/PERM123"), createEnv(), createCtx());
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Email Me Permit Updates/i);
  assert.match(html, /fetch\('\/alerts\/subscribe'/);
  assert.doesNotMatch(html, /name="company"/);
  assert.doesNotMatch(html, /name="interest"/);
  assert.match(html, /Check your inbox to confirm/i);
});

test("POST /alerts/subscribe creates a pending permit subscription and sends confirmation email", async () => {
  const env = createEnv();
  const response = await worker.fetch(
    new Request("http://example.com/alerts/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Reader@Example.com", permit_number: "PERM123" }),
    }),
    env,
    createCtx(),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { success: true, status: "pending_confirmation" });
  assert.equal(env._state.alertSubscriptions.length, 1);
  assert.equal(env._state.alertSubscriptions[0].email, "reader@example.com");
  assert.equal(env._state.alertSubscriptions[0].permit_number, "PERM123");
  assert.equal(env._state.alertSubscriptions[0].status, "pending");
  assert.equal(env._state.sentEmails.length, 1);
  assert.match(env._state.sentEmails[0].subject, /Confirm permit alerts/i);
  assert.match(env._state.sentEmails[0].text, /\/alerts\/confirm\?token=/);
});

test("one email address can subscribe to multiple permits", async () => {
  const env = createEnv();

  for (const permitNumber of ["PERM123", "PERM456"]) {
    const response = await worker.fetch(
      new Request("http://example.com/alerts/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "reader@example.com", permit_number: permitNumber }),
      }),
      env,
      createCtx(),
    );
    assert.equal(response.status, 202);
  }

  assert.deepEqual(
    env._state.alertSubscriptions.map((subscription) => subscription.permit_number).sort(),
    ["PERM123", "PERM456"],
  );
});

test("confirmation activates a permit alert without replaying historical status changes", async () => {
  const env = createEnv();
  await subscribeAndConfirm(env);

  assert.equal(env._state.alertSubscriptions[0].status, "active");
  assert.equal(env._state.alertSubscriptions[0].last_notified_change_id, 1);
});

test("unsubscribe link deactivates only the selected permit alert", async () => {
  const env = createEnv();
  await subscribeAndConfirm(env, "PERM123");
  await subscribeAndConfirm(env, "PERM456");

  const firstSubscription = env._state.alertSubscriptions.find(
    (subscription) => subscription.permit_number === "PERM123",
  );
  const response = await worker.fetch(
    new Request(`http://example.com/alerts/unsubscribe?token=${firstSubscription.unsubscribe_token}`),
    env,
    createCtx(),
  );

  assert.equal(response.status, 200);
  assert.equal(firstSubscription.status, "unsubscribed");
  assert.equal(
    env._state.alertSubscriptions.find((subscription) => subscription.permit_number === "PERM456").status,
    "active",
  );
});

test("one-click unsubscribe accepts the email provider POST request", async () => {
  const env = createEnv();
  await subscribeAndConfirm(env);
  const subscription = env._state.alertSubscriptions[0];

  const response = await worker.fetch(
    new Request(`http://example.com/alerts/unsubscribe?token=${subscription.unsubscribe_token}`, {
      method: "POST",
    }),
    env,
    createCtx(),
  );

  assert.equal(response.status, 200);
  assert.equal(subscription.status, "unsubscribed");
});

test("permit status changes email confirmed subscribers and advance the delivery cursor", async () => {
  const env = createEnv();
  await subscribeAndConfirm(env);
  const emailCountBeforeChange = env._state.sentEmails.length;
  const ctx = createCtx();

  const response = await worker.fetch(
    new Request("http://example.com/ingest/permit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": "test-ingest-token",
      },
      body: JSON.stringify({
        permit_number: "PERM123",
        address: "407 Stewart St, Seattle, WA",
        status: "completed",
      }),
    }),
    env,
    ctx,
  );
  await Promise.all(ctx.promises);

  assert.equal(response.status, 200);
  assert.equal(env._state.sentEmails.length, emailCountBeforeChange + 1);
  const notification = env._state.sentEmails.at(-1);
  assert.match(notification.subject, /Permit PERM123 changed to completed/i);
  assert.match(notification.text, /pending|active/i);
  assert.match(notification.text, /unsubscribe/i);
  assert.equal(env._state.alertSubscriptions[0].last_notified_change_id, 2);
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

test("renderPermitTimeline derives City control as total plan-review days minus corrections", () => {
  const html = renderPermitTimeline({
    status: "completed",
    applied_date: "2018-01-10",
    issued_date: "2019-06-01",
    completed_date: "2021-07-04",
    total_days_plan_review: 1276,
    days_out_corrections: 921,
    number_review_cycles: 5,
  });
  assert.match(html, /Construction Permit Timeline/);
  assert.match(html, /Plan Review Days — Total/);
  assert.match(html, /1,276/);
  // City control = 1276 - 921 = 355 (the SDCI screenshot's headline number).
  assert.match(html, /Plan Review Days — City Control/);
  assert.match(html, /355/);
  assert.match(html, /All reviews complete/);
});

test("renderPermitTimeline omits review metrics that are null instead of rendering NaN/null", () => {
  const html = renderPermitTimeline({
    status: "pending",
    applied_date: "2026-05-14",
    issued_date: null,
    total_days_plan_review: null,
    days_out_corrections: null,
    number_review_cycles: 2,
  });
  assert.doesNotMatch(html, /null|NaN|undefined/);
  // No total days -> City control cannot be derived and must be absent.
  assert.doesNotMatch(html, /City Control/);
  assert.match(html, /Review Cycles/);
  assert.match(html, /In City review/);
});

test("renderPermitTimeline returns empty string when there is no date or review data", () => {
  assert.equal(renderPermitTimeline({ status: "new" }), "");
});

test("renderProjectReviewSummary aggregates across permits and hides when no review data", () => {
  assert.equal(renderProjectReviewSummary([{ applied_date: "2020-01-01" }]), "");
  const html = renderProjectReviewSummary([
    { applied_date: "2019-01-01", completed_date: "2020-01-01", total_days_plan_review: 300, days_out_corrections: 100, number_review_cycles: 2 },
    { applied_date: "2018-01-01", issued_date: "2019-01-01", total_days_plan_review: 200, days_out_corrections: 50, number_review_cycles: 1 },
  ]);
  assert.match(html, /Review timeline/);
  assert.match(html, /500/); // total plan review days 300 + 200
  assert.match(html, /350/); // city control (500 - 150)
  assert.doesNotMatch(html, /null|NaN|undefined/);
});
