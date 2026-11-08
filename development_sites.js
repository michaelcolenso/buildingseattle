// Current site context is shared by permits, independently of the entity graph.
export const DEVELOPMENT_SITE_SOURCE = "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/ArcGIS/rest/services/Development_Sites/FeatureServer/0";
export const DEVELOPMENT_SITE_PAGE = "https://www.arcgis.com/home/item.html?id=4eedf0a9a2d24b9da3547e73d142e1d2";
export const DEVELOPMENT_SITE_BASE_URL = "https://buildingseattle.com";
export const DEVELOPMENT_SITE_FIELDS = [
  "development_site_id", "development_site_sqft", "development_site_status",
  "development_site_source_updated_at", "development_site_fetched_at", "development_site_geometry_url",
];
const MAX_BATCH = 40; // Leaves room for reconciliation/logging within D1's free-plan query limit.
const MAX_GEOMETRY_BYTES = 1_000_000; // Below D1's 2 MB row limit.

export function developmentSitesArePublic(env) {
  return env.DEVELOPMENT_SITES_PUBLIC !== "false";
}

export function normalizeSiteId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim().toUpperCase();
  return /^[A-Z0-9]{1,20}$/.test(id) ? id : null;
}

export function developmentSiteJoin(permit = "p", site = "ds") {
  return `LEFT JOIN development_sites ${site} ON ${site}.site_id = UPPER(TRIM(${permit}.parcel_number))`;
}

export function developmentSiteColumns(site = "ds") {
  return `${site}.site_id AS development_site_id,
    ${site}.lot_sqft AS development_site_sqft, ${site}.status AS development_site_status,
    ${site}.source_updated_at AS development_site_source_updated_at,
    ${site}.fetched_at AS development_site_fetched_at,
    (${site}.boundary_geojson IS NOT NULL) AS development_site_has_geometry`;
}

export function withDevelopmentSiteFields(row) {
  const result = { ...row };
  for (const field of DEVELOPMENT_SITE_FIELDS) result[field] = row[field] ?? null;
  result.development_site_geometry_url = row.development_site_id && row.development_site_has_geometry
    ? `${DEVELOPMENT_SITE_BASE_URL}/api/development-sites/${encodeURIComponent(row.development_site_id)}/geometry`
    : null;
  delete result.development_site_has_geometry;
  delete result.development_site_boundary;
  return result;
}

// Accept only numeric polygon coordinates, never source-provided SVG/HTML.
export function validBoundary(geometry) {
  if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) return false;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(polygons) || !polygons.length) return false;
  let points = 0;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) return false;
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) return false;
      for (const point of ring) {
        if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) ||
            Math.abs(point[0]) > 180 || Math.abs(point[1]) >= 85 || ++points > 30000) return false;
      }
      const first = ring[0], last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) return false;
      const area = ring.slice(1).reduce((sum, point, i) =>
        sum + (ring[i][0] - first[0]) * (point[1] - first[1]) - (point[0] - first[0]) * (ring[i][1] - first[1]), 0);
      if (Math.abs(area) < 1e-14) return false;
    }
  }
  return new TextEncoder().encode(JSON.stringify(geometry)).length <= MAX_GEOMETRY_BYTES;
}

function isoTimestamp(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("Timestamps must be UTC ISO 8601 strings");
  }
  return new Date(value).toISOString();
}

export function validateSiteBatch(payload) {
  if (!payload || payload.complete !== true || !Array.isArray(payload.requested_ids) ||
      !payload.requested_ids.length || payload.requested_ids.length > MAX_BATCH || !Array.isArray(payload.sites)) {
    throw new Error(`Expected a complete batch of 1-${MAX_BATCH} requested IDs and a sites array`);
  }
  const ids = payload.requested_ids.map(normalizeSiteId);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error("Invalid or duplicate requested IDs");
  const fetchedAt = isoTimestamp(payload.fetched_at);
  if (Date.parse(fetchedAt) > Date.now() + 5 * 60 * 1000) throw new Error("Fetch timestamp is in the future");
  const seen = new Set();
  const sites = payload.sites.map(site => {
    const id = normalizeSiteId(site?.site_id);
    if (!id || !ids.includes(id) || seen.has(id)) throw new Error("Unexpected or duplicate site ID");
    seen.add(id);
    if (site.status !== null && (typeof site.status !== "string" || site.status.length > 32)) throw new Error("Invalid site status");
    if (site.lot_sqft !== null && (!Number.isSafeInteger(site.lot_sqft) || site.lot_sqft <= 0)) throw new Error("Invalid lot size");
    if (site.geometry !== null && !validBoundary(site.geometry)) throw new Error("Invalid site boundary");
    return { ...site, site_id: id, source_updated_at: isoTimestamp(site.source_updated_at, true) };
  });
  return { ids, sites, fetchedAt, missing: ids.filter(id => !seen.has(id)) };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*",
  } });
}

export async function ingestDevelopmentSites(request, env) {
  let batch;
  try {
    const text = await request.text();
    if (text.length > 8_000_000) return json({ error: "Batch is too large" }, 413);
    batch = validateSiteBatch(JSON.parse(text));
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  const { ids, sites, missing, fetchedAt } = batch;
  const start = new Date().toISOString();
  const statements = sites.map(site => env.DB.prepare(`
    INSERT INTO development_sites (site_id, status, lot_sqft, boundary_geojson, source_updated_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id) DO UPDATE SET status = excluded.status, lot_sqft = excluded.lot_sqft,
      boundary_geojson = excluded.boundary_geojson, source_updated_at = excluded.source_updated_at,
      fetched_at = excluded.fetched_at
    WHERE excluded.fetched_at >= development_sites.fetched_at
  `).bind(site.site_id, site.status, site.lot_sqft, site.geometry ? JSON.stringify(site.geometry) : null, site.source_updated_at, fetchedAt));
  if (missing.length) {
    statements.push(env.DB.prepare(`DELETE FROM development_sites WHERE site_id IN (${missing.map(() => "?").join(",")}) AND fetched_at <= ?`)
      .bind(...missing, fetchedAt));
  }
  // Logging and reconciliation commit together. A failed batch leaves both unchanged.
  statements.push(env.DB.prepare(`INSERT INTO ingest_logs
    (run_type, source, status, records_updated, start_time, end_time)
    VALUES ('development_sites', ?, 'success', ?, ?, ?)`)
    .bind(DEVELOPMENT_SITE_SOURCE, sites.length, start, new Date().toISOString()));
  try {
    await env.DB.batch(statements);
    return json({ processed: ids.length, matched: sites.length, unmatched: missing.length });
  } catch (error) {
    console.error("Development-site reconciliation failed", error);
    return json({ error: "Development-site reconciliation failed; batch rolled back" }, 500);
  }
}

export async function getDevelopmentSiteGeometry(id, env) {
  const siteId = normalizeSiteId(id);
  if (!siteId) return json({ error: "Boundary unavailable" }, 404);
  const site = await env.DB.prepare("SELECT * FROM development_sites WHERE site_id = ?").bind(siteId).first();
  if (!site?.boundary_geojson) return json({ error: "Boundary unavailable" }, 404);
  const geometry = JSON.parse(site.boundary_geojson);
  return new Response(JSON.stringify({ type: "Feature", id: site.site_id, geometry, properties: {
    development_site_id: site.site_id, development_site_sqft: site.lot_sqft,
    development_site_status: site.status, development_site_source_updated_at: site.source_updated_at,
    development_site_fetched_at: site.fetched_at, source_url: DEVELOPMENT_SITE_SOURCE,
    temporal_scope: "Current source boundary; not a versioned export snapshot",
  } }), { headers: { "Content-Type": "application/geo+json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60" } });
}

const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function renderSiteOutline(geometry, siteId) {
  if (!validBoundary(geometry)) return "";
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const projected = polygons.map(polygon => polygon.map(ring => ring.map(([lon, lat]) => [
    lon * Math.PI / 180, -Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)),
  ])));
  const points = projected.flat(2);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const scale = Math.min(288 / (maxX - minX), 188 / (maxY - minY));
  if (!Number.isFinite(scale)) return "";
  const xOffset = (320 - (maxX - minX) * scale) / 2, yOffset = (220 - (maxY - minY) * scale) / 2;
  const paths = projected.map(polygon => polygon.map(ring => ring.map(([x, y], index) =>
    `${index ? "L" : "M"}${((x - minX) * scale + xOffset).toFixed(2)},${((y - minY) * scale + yOffset).toFixed(2)}`
  ).join(" ") + " Z").join(" "));
  return `<svg viewBox="0 0 320 220" role="img" aria-label="Development-site boundary for ${escape(siteId)}" style="display:block;width:100%;max-width:320px;height:auto">${paths.map(d => `<path d="${d}" fill="var(--accent)" fill-opacity="0.15" stroke="var(--accent)" stroke-width="2" fill-rule="evenodd"/>`).join("")}</svg>`;
}

export function renderDevelopmentSiteCard(permit) {
  if (!permit.development_site_id) return `<div class="bs-card"><div class="card-label">Development site</div><p style="margin-top:0.75rem;color:var(--text-muted)">Development-site information unavailable.</p></div>`;
  let geometry = null;
  try { geometry = JSON.parse(permit.development_site_boundary || "null"); } catch { /* Omit an unusable outline. */ }
  const date = value => value ? escape(new Date(value).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "short", day: "numeric" })) : "Not supplied";
  return `<div class="bs-card"><div class="card-label">Development site</div>
    <div class="bs-card__title">${escape(permit.development_site_id)}</div>
    <dl style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-top:0.75rem">
      <dt>Site area</dt><dd>${permit.development_site_sqft ? `${Number(permit.development_site_sqft).toLocaleString("en-US")} sq ft` : "Not supplied"}</dd>
      <dt>Site status</dt><dd>${escape(permit.development_site_status || "Not supplied")}</dd>
      <dt>Source updated</dt><dd>${date(permit.development_site_source_updated_at)}</dd>
      <dt>Last checked</dt><dd>${date(permit.development_site_fetched_at)}</dd>
    </dl>${renderSiteOutline(geometry, permit.development_site_id)}
    <p style="font-size:0.8125rem;color:var(--text-muted);margin-top:0.75rem">Current SDCI site context. The outline shows the development-site boundary used for code standards.</p>
    <a href="${DEVELOPMENT_SITE_PAGE}" target="_blank" rel="noopener" style="color:var(--accent)">Official Seattle development-site data &rarr;</a>
  </div>`;
}

export const DEVELOPMENT_SITE_SCHEMA = Object.fromEntries(DEVELOPMENT_SITE_FIELDS.map(name => [name, {
  type: [name === "development_site_sqft" ? "integer" : "string", "null"],
  ...(name.endsWith("_at") ? { format: "date-time" } : {}),
  ...(name.endsWith("_url") ? { format: "uri", description: "Live geometry URL; may change or return 404 after a source refresh." } : {}),
}]));
