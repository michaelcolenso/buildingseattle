// Shared display helpers and page-content constants for the server-rendered
// templates in worker.js. Pure functions and frozen data only, so tests can
// import them directly. (worker.js may not export non-function values; see
// CLAUDE.md, so constants shared with tests live here.)

// ---------------------------------------------------------------------------
// Shipped Gumroad dataset release.
//
// UPDATE ON EVERY DATASET RELEASE. After `python3 gumroad/build_dataset.py`,
// copy the new values from gumroad/VERSION.txt (records, columns, export date,
// value totals, neighborhoods), the row count of gumroad/contractors.csv, and
// the first/last applied_date in gumroad/buildingseattle_permits.csv.
// tests/site_content.test.js fails when these drift from the committed files.
// The /data page reads these values instead of live D1 counts, because buyers
// receive the shipped file, not the live database.
// ---------------------------------------------------------------------------
export const DATASET_RELEASE = Object.freeze({
  version: "2026-11",
  exportDate: "2026-11-08",
  records: 15581,
  columns: 38,
  contractors: 2367,
  neighborhoods: 53,
  countedValue: 11250805473,
  declaredValue: 14599801224,
  appliedFrom: "2024-05-15",
  appliedThrough: "2026-11-06",
  sampleRows: 100,
});

// Contact address that already exists in the codebase (the alert sender,
// ALERT_EMAIL_FROM in worker.js). No other address is published.
export const SITE_CONTACT_EMAIL = "alerts@buildingseattle.com";

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "1 permit", "2 permits", "1,276 permits". */
export function countLabel(count, singular, plural = `${singular}s`) {
  const n = Number(count) || 0;
  const word = new Intl.PluralRules("en-US").select(n) === "one" ? singular : plural;
  return `${n.toLocaleString("en-US")} ${word}`;
}

/** Thousands separators for any numeric value; non-numbers pass through. */
export function formatCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value.toLocaleString("en-US");
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value).toLocaleString("en-US");
  return value;
}

// SDCI source text arrives in ALL CAPS ("2704 S HINDS ST, SEATTLE, WA").
// Render title case while keeping directionals, unit types and common business
// suffixes uppercase.
const TITLECASE_KEEP_UPPER = new Set(["NE", "NW", "SE", "SW", "N", "S", "E", "W", "LLC", "LLP", "INC", "CO", "USA", "US", "WA", "ADU", "DADU", "HVAC", "IID", "IV", "III", "II"]);

export function smartTitleCase(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\b[a-z][a-z0-9&.'/()-]*/g, (word) => {
      const upper = word.toUpperCase();
      if (TITLECASE_KEEP_UPPER.has(upper)) return upper;
      return word.replace(/(^|[\s/('-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
    });
}

/**
 * One display form for entity names and addresses on every template: SDCI
 * shorthand backslashes ("DSN\CNST") become slashes, whitespace collapses, and
 * ALL-CAPS (or all-lowercase) source text is title-cased. Mixed-case names
 * are kept as written ("McKinstry Co").
 */
export function displayName(value) {
  const text = String(value ?? "").replace(/\\+/g, "/").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const letters = text.replace(/[^A-Za-z]/g, "");
  const isAllCaps = letters && letters === letters.toUpperCase();
  const isAllLower = letters && letters === letters.toLowerCase();
  return isAllCaps || isAllLower ? smartTitleCase(text) : text;
}

const STATUS_LABELS = {
  new: "New",
  pending: "Pending",
  active: "Active",
  completed: "Completed",
  complete: "Completed",
  expired: "Expired",
  canceled: "Canceled",
  cancelled: "Canceled",
  withdrawn: "Withdrawn",
  closed: "Closed",
  "in review": "In review",
  "under review": "Under review",
};

/** Human label for a stored permit status enum ("active" -> "Active"). */
export function statusLabel(status, fallback = "Unknown") {
  const key = String(status ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!key) return fallback;
  return STATUS_LABELS[key] || `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

// Statuses for which a status-change alert has nothing left to report.
const CLOSED_STATUSES = new Set(["completed", "complete", "closed", "expired", "canceled", "cancelled", "withdrawn", "finaled"]);

export function isClosedPermitStatus(status) {
  return CLOSED_STATUSES.has(String(status ?? "").trim().toLowerCase());
}

const ROLE_LABELS = {
  contractor: "Contractor",
  owner: "Owner",
  applicant: "Applicant",
  architect: "Architect",
  participant: "Participant",
};

/** Human label for a permit participant role ("owner" -> "Owner"). */
export function roleLabel(role) {
  const key = String(role ?? "").trim().toLowerCase();
  if (!key) return "Participant";
  return ROLE_LABELS[key] || `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

/** "Contractor, Owner" from a list of role rows or strings, deduplicated. */
export function roleList(roles) {
  const labels = [...new Set((roles || []).map((r) => roleLabel(typeof r === "string" ? r : r?.role)))];
  return labels.length ? labels.join(", ") : "Participant";
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Format a source date. Date-only values ("2026-09-18") are calendar dates and
 * format as that same day; parsing them as UTC midnight and formatting in
 * Pacific time printed the previous day. Timestamps format in Seattle time.
 */
export function formatCalendarDate(value, { month = "short", includeYear = true } = {}) {
  if (!value) return "";
  const source = value instanceof Date ? value : String(value).trim();
  const dateOnly = typeof source === "string" && DATE_ONLY.test(source);
  let date;
  if (source instanceof Date) date = source;
  else if (dateOnly) date = new Date(`${source}T00:00:00Z`);
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(source)) date = new Date(`${source.replace(" ", "T")}Z`);
  else date = new Date(source);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month,
    day: "numeric",
    year: includeYear ? "numeric" : undefined,
    timeZone: dateOnly ? "UTC" : "America/Los_Angeles",
  }).format(date);
}

/** "March 2026" for a source date, keeping date-only values on their day. */
export function formatMonthYear(value) {
  if (!value) return "";
  const source = String(value).trim();
  const dateOnly = DATE_ONLY.test(source.slice(0, 10));
  const date = new Date(dateOnly ? `${source.slice(0, 10)}T00:00:00Z` : source);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", timeZone: "UTC" });
}

/**
 * Newest source event date (applied, issued or completed) across permit rows.
 * Row-touch timestamps (updated_at, created_at) are ignored: every upsert bumps
 * them, so they report when we last wrote the row, not when the record changed.
 */
export function latestSourceEventDate(permits) {
  return (permits || [])
    .flatMap((permit) => [permit?.completed_date, permit?.issued_date, permit?.applied_date])
    .filter((value) => value && !String(value).startsWith("1900"))
    .map((value) => String(value).slice(0, 10))
    .sort()
    .at(-1) || null;
}

// ---------------------------------------------------------------------------
// Conversion blocks shared by entity pages
// ---------------------------------------------------------------------------

/**
 * One concise dataset call to action for an entity page. `context` names the
 * page type and becomes utm_content, so /data visits can be attributed.
 */
export function renderDatasetCta({ context, subject, count }) {
  const recordPhrase = count
    ? `${countLabel(count, "permit", "permits")} like the ${count === 1 ? "one" : "ones"} on this page`
    : "every permit on this site";
  const lead = subject
    ? `Need ${escapeHtml(subject)} in a spreadsheet?`
    : "Need this in a spreadsheet?";
  return `<aside class="bs-card ent-cta" aria-label="Download the dataset">
      <h3 style="margin:0 0 0.35rem;">${lead}</h3>
      <p style="margin:0 0 0.75rem;font-size:0.9rem;color:var(--text-muted);">The Seattle permit dataset has ${escapeHtml(recordPhrase)} in one CSV: ${DATASET_RELEASE.records.toLocaleString("en-US")} records, ${DATASET_RELEASE.columns} columns, release ${escapeHtml(DATASET_RELEASE.version)}. Free ${DATASET_RELEASE.sampleRows}-row sample.</p>
      <a class="ent-link" href="/data?utm_source=buildingseattle&amp;utm_medium=site&amp;utm_campaign=entity_cta&amp;utm_content=${encodeURIComponent(context)}">See the dataset &rarr;</a>
    </aside>`;
}

/**
 * Alert entry point for an entity page. Alerts are per permit, so the block
 * points at the newest permit that can still change status. With none, it
 * explains alerts and links the landing page instead of offering a dead end.
 */
export function renderAlertCta({ permits = [], subject }) {
  const open = (permits || []).find((p) => p?.permit_number && !isClosedPermitStatus(p.status));
  const where = subject ? ` at ${escapeHtml(subject)}` : "";
  if (open) {
    return `<aside class="bs-card ent-cta" aria-label="Permit alerts">
      <h3 style="margin:0 0 0.35rem;">Get status-change emails</h3>
      <p style="margin:0 0 0.75rem;font-size:0.9rem;color:var(--text-muted);">Free alerts${where}: confirm your email once and we send a note when the permit moves through SDCI review. One-click unsubscribe.</p>
      <a class="ent-link" href="/permits/${encodeURIComponent(open.permit_number)}#permit-alerts">Watch permit ${escapeHtml(open.permit_number)} &rarr;</a>
      <span style="font-size:0.8rem;color:var(--text-muted);"> &middot; <a class="ent-link" href="/alerts">How alerts work</a></span>
    </aside>`;
  }
  return `<aside class="bs-card ent-cta" aria-label="Permit alerts">
      <h3 style="margin:0 0 0.35rem;">Permit alerts</h3>
      <p style="margin:0 0 0.75rem;font-size:0.9rem;color:var(--text-muted);">No open permits${where} to watch right now. Alerts follow one permit at a time.</p>
      <a class="ent-link" href="/alerts">How permit alerts work &rarr;</a>
    </aside>`;
}

// ---------------------------------------------------------------------------
// Footer links (one list for every template, homepage included)
// ---------------------------------------------------------------------------

export const FOOTER_LINKS = Object.freeze([
  { href: "/permits", label: "Permits" },
  { href: "/contractors", label: "Contractors" },
  { href: "/neighborhoods", label: "Neighborhoods" },
  { href: "/projects", label: "Projects" },
  { href: "/addresses", label: "Addresses" },
  { href: "/insights", label: "Insights" },
  { href: "/alerts", label: "Alerts" },
  { href: "/data", label: "Dataset" },
  { href: "/methodology", label: "Methodology" },
  { href: "/api-docs", label: "API" },
  { href: "/about", label: "About" },
  { href: "/privacy", label: "Privacy" },
]);
