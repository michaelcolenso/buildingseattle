import { BASIS_RESET_EVENT_TYPES, scoreBasisReset } from "./basis_reset.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function money(value) {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

export async function resolveBasisResetTarget(env, { project_id, address_id, address }) {
  if (project_id) {
    const project = await env.DB.prepare(
      "SELECT p.id project_id, p.address_id, p.name, a.display_address FROM projects p LEFT JOIN addresses a ON a.id=p.address_id WHERE p.id=?",
    ).bind(Number(project_id)).first();
    if (project) return project;
  }
  if (address_id) {
    const row = await env.DB.prepare(
      "SELECT id address_id, display_address FROM addresses WHERE id=?",
    ).bind(Number(address_id)).first();
    if (row) return { ...row, project_id: null, name: null };
  }
  if (address) {
    const normalized = String(address).trim().toUpperCase().replace(/\s+/g, " ");
    const row = await env.DB.prepare(
      "SELECT id address_id, display_address FROM addresses WHERE UPPER(normalized_address)=? OR UPPER(display_address)=? LIMIT 1",
    ).bind(normalized, normalized).first();
    if (row) return { ...row, project_id: null, name: null };
  }
  return null;
}

export async function ingestBasisResetEvent(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!BASIS_RESET_EVENT_TYPES.includes(body.event_type)) return json({ error: "Invalid event_type" }, 400);
  if (!body.event_date || !body.source_url) return json({ error: "event_date and source_url are required" }, 400);

  const target = await resolveBasisResetTarget(env, body);
  if (!target) return json({ error: "Could not resolve event to an existing address/project" }, 422);

  const duplicate = await env.DB.prepare(
    "SELECT id FROM basis_reset_events WHERE source_url=? AND event_type=? AND event_date=? LIMIT 1",
  ).bind(body.source_url, body.event_type, body.event_date).first();
  if (duplicate) return json({ error: "Duplicate evidence event", id: duplicate.id }, 409);

  const result = await env.DB.prepare(`
    INSERT INTO basis_reset_events
      (address_id, project_id, event_type, event_date, prior_basis, current_basis, asking_price,
       source_url, source_name, source_type, confidence, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).bind(
    target.address_id || null, target.project_id || null, body.event_type, body.event_date,
    body.prior_basis ?? null, body.current_basis ?? null, body.asking_price ?? null,
    body.source_url, body.source_name ?? null, body.source_type || "manual",
    Math.max(0, Math.min(100, Number(body.confidence ?? 70))), body.notes ?? null,
  ).first();

  const score = await materializeBasisResetScore(env, result.id);
  return json({ id: result.id, target, score }, 201);
}

export async function materializeBasisResetScore(env, eventId) {
  const event = await env.DB.prepare("SELECT * FROM basis_reset_events WHERE id=?").bind(eventId).first();
  if (!event) return null;
  const readiness = await env.DB.prepare(`
    SELECT
      COUNT(DISTINCT pp.permit_id) permit_count,
      COUNT(DISTINCT CASE WHEN lower(COALESCE(pe.status,'')) IN ('issued','active','approved') THEN pp.permit_id END) issued_count
    FROM projects p
    LEFT JOIN project_permits pp ON pp.project_id=p.id
    LEFT JOIN permits pe ON pe.id=pp.permit_id
    WHERE p.id=? OR (? IS NULL AND p.address_id=?)
  `).bind(event.project_id, event.project_id, event.address_id).first();
  const projectCountRow = await env.DB.prepare(
    "SELECT COUNT(*) project_count FROM projects WHERE address_id=?",
  ).bind(event.address_id).first();
  const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(event.event_date)) / 86400000));
  const currentBasis = event.current_basis ?? event.asking_price;
  const score = scoreBasisReset({
    priorBasis: event.prior_basis, currentBasis, eventType: event.event_type,
    confidence: event.confidence, ageDays,
    permitCount: Number(readiness?.permit_count || 0),
    projectCount: Number(projectCountRow?.project_count || 0),
    hasIssuedPermit: Number(readiness?.issued_count || 0) > 0,
  });
  await env.DB.prepare(`
    INSERT INTO basis_reset_scores
      (address_id, project_id, latest_event_id, reset_pct, reset_score, readiness_score,
       signal_score, opportunity_score, explanation, scored_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(address_id, project_id) DO UPDATE SET
      latest_event_id=excluded.latest_event_id, reset_pct=excluded.reset_pct,
      reset_score=excluded.reset_score, readiness_score=excluded.readiness_score,
      signal_score=excluded.signal_score, opportunity_score=excluded.opportunity_score,
      explanation=excluded.explanation, scored_at=CURRENT_TIMESTAMP
  `).bind(
    event.address_id, event.project_id, event.id, score.resetPct, score.resetScore,
    score.readinessScore, score.signalScore, score.opportunityScore, score.explanation,
  ).run();
  return score;
}

export async function getBasisResetRadar(request, env) {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 25)));
  const { results } = await env.DB.prepare(`
    SELECT s.*, e.event_type, e.event_date, e.prior_basis, e.current_basis, e.asking_price,
      e.source_url, e.source_name, e.confidence,
      a.slug address_slug, a.display_address, p.slug project_slug, p.name project_name
    FROM basis_reset_scores s
    JOIN basis_reset_events e ON e.id=s.latest_event_id
    LEFT JOIN addresses a ON a.id=s.address_id
    LEFT JOIN projects p ON p.id=s.project_id
    ORDER BY s.opportunity_score DESC, e.event_date DESC
    LIMIT ?
  `).bind(limit).all();
  return json({ count: results?.length || 0, results: results || [] });
}

export async function renderBasisResetRadar(env) {
  const response = await getBasisResetRadar(new Request("https://buildingseattle.com/api/basis-reset?limit=50"), env);
  const payload = await response.json();
  const rows = payload.results || [];
  const cards = rows.length ? rows.map((row) => `
    <article style="border:1px solid #d8d8d2;padding:20px;margin:0 0 14px;background:#fff">
      <div style="display:flex;justify-content:space-between;gap:18px;align-items:flex-start">
        <div><div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#666">${esc(row.event_type)} · ${esc(row.event_date)}</div>
        <h2 style="margin:6px 0 8px;font-size:24px">${esc(row.project_name || row.display_address || "Seattle property")}</h2></div>
        <strong style="font-size:34px">${row.opportunity_score}</strong>
      </div>
      <p style="margin:6px 0"><strong>${row.reset_pct == null ? "Basis unknown" : `${row.reset_pct}% reset`}</strong> · ${money(row.prior_basis)} → ${money(row.current_basis ?? row.asking_price)}</p>
      <p style="color:#555;margin:6px 0">Reset ${row.reset_score}/100 · Readiness ${row.readiness_score}/100 · Signal ${row.signal_score}/100</p>
      <p style="margin:10px 0 0"><a href="${esc(row.source_url)}" rel="nofollow">Source: ${esc(row.source_name || "evidence")}</a></p>
    </article>`).join("") : "<p>No basis-reset events have been scored yet.</p>";
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Basis Reset Radar | Building Seattle</title><meta name="description" content="Seattle properties where a lower basis and existing development work may change redevelopment economics."></head><body style="margin:0;background:#f4f3ef;color:#171714;font-family:Arial,sans-serif"><main style="max-width:980px;margin:auto;padding:48px 22px"><p><a href="/insights">← Insights</a></p><h1 style="font-size:48px;margin:20px 0 8px">Basis Reset Radar</h1><p style="font-size:19px;line-height:1.5;max-width:760px">Properties where capital-basis changes intersect with real permit and project activity. Scores prioritize evidence; they are not appraisals or forecasts.</p><div style="margin-top:32px">${cards}</div><p style="margin-top:30px;color:#666">Method: 45% observed basis reset, 35% redevelopment readiness, 20% signal strength and recency.</p></main></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
