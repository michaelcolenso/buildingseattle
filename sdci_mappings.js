// sdci_mappings.js
//
// Worker side of the SDCI feed mappings. The data lives in
// data/sdci_mappings.json, which sdci_mappings.py reads too, so the scheduled
// ingest (worker.js) and the scraper (sdci_scraper.py) cannot drift.
// Tests: tests/sdci_mappings.test.js and tests/test_sdci_mappings.py.

import mappings from "./data/sdci_mappings.json" with { type: "json" };

export const SDCI_MAPPINGS = mappings;

// [name, minLat, maxLat, minLng, maxLng] in resolution order (smallest first).
export const NEIGHBORHOOD_BOUNDS = mappings.neighborhood_bounds;

const STATUS_MAP = new Map(Object.entries(mappings.status_map));

function statusKey(raw) {
  return String(raw ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Map an SDCI `statuscurrent` value to a stored status. Exact match on the
 * whole (trimmed, case-folded) value: "Application Completed" is pending, not
 * completed. Returns { status, known } so callers can log unmapped values.
 */
export function mapSdciStatus(raw) {
  const key = statusKey(raw);
  if (STATUS_MAP.has(key)) return { status: STATUS_MAP.get(key), known: true };
  return { status: mappings.unknown_status, known: false };
}

export function mapPermitStatus(raw) {
  return mapSdciStatus(raw).status;
}

/**
 * The substring cascade used before the exact map. Kept only so the first
 * sweep after the switch can tell a reclassification (old mapping of the same
 * raw value) from a real status change and not email alert subscribers about
 * the former. Do not use it to store statuses.
 */
export function legacyMapPermitStatus(status) {
  const value = String(status || "").toLowerCase();
  if (!value) return "new";
  if (value.includes("issue") || value.includes("active") || value.includes("approved")) return "active";
  if (value.includes("pending") || value.includes("review") || value.includes("applied")) return "pending";
  if (value.includes("complete") || value.includes("final") || value.includes("closed")) return "completed";
  if (value.includes("expir")) return "expired";
  if (value.includes("cancel")) return "cancelled";
  return "new";
}

/**
 * Neighborhood for a coordinate. Boxes are tried smallest first, so nested
 * boxes (Alki and Admiral inside West Seattle, North Beacon Hill inside
 * Beacon Hill) win over the box around them.
 */
export function detectNeighborhood(lat, lng) {
  if (lat === null || lat === undefined || lat === "" || lng === null || lng === undefined || lng === "") {
    return mappings.outside_or_unknown;
  }
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng) || parsedLat === 0 || parsedLng === 0) {
    return mappings.outside_or_unknown;
  }
  for (const [name, minLat, maxLat, minLng, maxLng] of NEIGHBORHOOD_BOUNDS) {
    if (parsedLat >= minLat && parsedLat <= maxLat && parsedLng >= minLng && parsedLng <= maxLng) {
      return name;
    }
  }
  const [minLat, maxLat, minLng, maxLng] = mappings.seattle_bounds;
  if (parsedLat >= minLat && parsedLat <= maxLat && parsedLng >= minLng && parsedLng <= maxLng) {
    return mappings.inside_seattle_unmatched;
  }
  return mappings.outside_or_unknown;
}

/**
 * SQL CASE expression that recomputes a stored status from `status_raw`, built
 * from the same map (used by the status backfill migration; a test asserts the
 * committed SQL matches).
 */
export function statusFromRawSql(column = "status_raw") {
  const key = `lower(trim(${column}))`;
  const whens = [...STATUS_MAP.entries()]
    .map(([raw, status]) => `    WHEN '${raw.replace(/'/g, "''")}' THEN '${status}'`)
    .join("\n");
  return `CASE ${key}\n${whens}\n    ELSE '${mappings.unknown_status}'\n  END`;
}
