// permit_upsert.js
//
// The one permit upsert shared by the scheduled ingest and the /ingest/permit
// routes (worker.js). Two rules beyond a plain upsert:
//
// 1. updated_at (which drives sitemap lastmod and permit dateModified) moves
//    only when a tracked base-feed column actually changes. The DO UPDATE has a
//    WHERE that compares every tracked column with IS NOT, so an unchanged row
//    is not written at all (D1 reports changes = 0, counted as "unchanged").
// 2. A row the feed has stamped (source_updated_at, Socrata `:updated_at`) is
//    only overwritten by a record at least as new. A legacy JSONL record with no
//    stamp cannot roll a fresher row back.
//
// Enrichment-only columns (parcel_number, contractor_license, owner_name, ...)
// are never touched. contractor_id keeps an L&I-license link set by the
// enrichment ingest (contractor_source = 'wa_lni_license'), and applicant_name
// keeps a value when the feed sends none. Tests: tests/permit_upsert.test.js.

// [column, update expression]; `excluded.x` unless stated.
const TRACKED = [
  ["contractor_id", "CASE WHEN permits.contractor_source = 'wa_lni_license' AND permits.contractor_id IS NOT NULL THEN permits.contractor_id ELSE COALESCE(excluded.contractor_id, permits.contractor_id) END"],
  ["applicant_name", "COALESCE(excluded.applicant_name, permits.applicant_name)"],
  ["address"],
  ["neighborhood"],
  ["type"],
  ["value"],
  ["status"],
  ["status_raw"],
  ["description"],
  ["housing_units"],
  ["applied_date"],
  ["issued_date"],
  ["completed_date"],
  ["housing_units_added"],
  ["housing_units_removed"],
  ["housing_category"],
  ["dwelling_unit_type"],
  ["zoning"],
  ["parent_permit_number"],
  ["related_mup"],
  ["number_review_cycles"],
  ["total_days_plan_review"],
  ["days_out_corrections"],
  ["plan_review_complete_date"],
  ["ready_to_issue_date"],
  // Coordinates and ZIP: keep a stored value when the feed sends none.
  ["lat", "COALESCE(excluded.lat, permits.lat)"],
  ["lng", "COALESCE(excluded.lng, permits.lng)"],
  ["zip", "COALESCE(excluded.zip, permits.zip)"],
];

export const PERMIT_UPSERT_COLUMNS = ["permit_number", ...TRACKED.map(([column]) => column), "source_updated_at"];

function expressionFor([column, expression]) {
  return expression || `excluded.${column}`;
}

export function buildPermitUpsertSql() {
  const placeholders = PERMIT_UPSERT_COLUMNS.map(() => "?").join(", ");
  const sets = TRACKED.map((entry) => `    ${entry[0]} = ${expressionFor(entry)},`).join("\n");
  const changed = TRACKED.map((entry) => `(${expressionFor(entry)}) IS NOT permits.${entry[0]}`).join("\n      OR ");
  return `
  INSERT INTO permits (${PERMIT_UPSERT_COLUMNS.join(", ")})
  VALUES (${placeholders})
  ON CONFLICT(permit_number) DO UPDATE SET
${sets}
    source_updated_at = COALESCE(excluded.source_updated_at, permits.source_updated_at),
    updated_at = CURRENT_TIMESTAMP
  WHERE (permits.source_updated_at IS NULL OR excluded.source_updated_at >= permits.source_updated_at)
    AND (
      ${changed}
    )
`;
}

export const PERMIT_UPSERT_SQL = buildPermitUpsertSql();

/**
 * Run in the same batch *after* PERMIT_UPSERT_SQL. The upsert skips a row
 * whose tracked columns are unchanged, which would also leave the stored
 * source_updated_at behind; a later stale record stamped between the two
 * would then pass the guard. This advances the watermark alone, without
 * touching updated_at, and only ever forward. It writes nothing when the
 * upsert already stored the stamp.
 */
export const PERMIT_WATERMARK_SQL = `
  UPDATE permits SET source_updated_at = ?
  WHERE permit_number = ?
    AND ? IS NOT NULL
    AND (source_updated_at IS NULL OR source_updated_at < ?)
`;

export function permitWatermarkBinds(permit) {
  const stamp = textOrNull(permit.source_updated_at);
  return [stamp, permit.permit_number, stamp, stamp];
}

function intOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

export function dateOrNull(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const [, month, day, year] = match;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** Five-digit ZIP from "98108", "98108-1234" or a number; null otherwise. */
export function zipOrNull(value) {
  const match = String(value ?? "").trim().match(/^(\d{5})(?:-\d{4})?$/);
  return match ? match[1] : null;
}

/**
 * Bind values for PERMIT_UPSERT_SQL from a normalized permit (scheduled
 * ingest) or an /ingest/permit item (scraper JSONL: latitude / longitude /
 * zip_code are accepted as aliases). `status` must already be normalized.
 */
export function permitUpsertBinds(permit, { contractorId = null, status } = {}) {
  const values = {
    permit_number: permit.permit_number,
    contractor_id: contractorId,
    applicant_name: permit.applicant_name || null,
    address: permit.address,
    neighborhood: permit.neighborhood || null,
    type: permit.type || null,
    value: permit.value || null,
    status,
    status_raw: textOrNull(permit.status_raw),
    description: permit.description || null,
    housing_units: permit.housing_units || 0,
    applied_date: permit.applied_date || null,
    issued_date: permit.issued_date || null,
    completed_date: permit.completed_date || null,
    housing_units_added: intOrNull(permit.housing_units_added),
    housing_units_removed: intOrNull(permit.housing_units_removed),
    housing_category: permit.housing_category || null,
    dwelling_unit_type: permit.dwelling_unit_type || null,
    zoning: permit.zoning || null,
    parent_permit_number: permit.parent_permit_number || null,
    related_mup: permit.related_mup || null,
    number_review_cycles: intOrNull(permit.number_review_cycles),
    total_days_plan_review: intOrNull(permit.total_days_plan_review),
    days_out_corrections: intOrNull(permit.days_out_corrections),
    plan_review_complete_date: dateOrNull(permit.plan_review_complete_date),
    ready_to_issue_date: dateOrNull(permit.ready_to_issue_date),
    lat: numberOrNull(permit.lat ?? permit.latitude),
    lng: numberOrNull(permit.lng ?? permit.longitude),
    zip: zipOrNull(permit.zip ?? permit.zip_code),
    source_updated_at: textOrNull(permit.source_updated_at),
  };
  return PERMIT_UPSERT_COLUMNS.map((column) => values[column]);
}

/**
 * Status-change row for the alert feed, inserted in the same batch *after* the
 * upsert and only if the upsert really left the permit in the new status (a
 * stale record blocked by the source_updated_at guard records nothing).
 */
export const STATUS_CHANGE_INSERT_SQL = `
  INSERT INTO permit_status_changes (permit_number, previous_status, new_status)
  SELECT ?, ?, ?
  WHERE EXISTS (SELECT 1 FROM permits WHERE permit_number = ? AND status = ?)
`;

export function statusChangeBinds(change) {
  const next = change.new_status || "new";
  return [change.permit_number, change.previous_status || null, next, change.permit_number, next];
}
