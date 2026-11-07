// Server-side helpers for the buildingseattle design system components
// (public/brand/bundle.css, `bs-` classes). Pure functions so worker.js can
// render them inline and tests can import them.

// Icon paths copied from the design system's components/bundle.js
// (24px grid, 1.75 stroke, square caps, mitre joins). Only the icons the
// server templates use are carried here.
const ICON_PATHS = {
  search: "<circle cx=\"10.5\" cy=\"10.5\" r=\"6.5\"/><path d=\"m15.3 15.3 5.7 5.7\"/>",
  "arrow-right": "<path d=\"M4 12h15M13.5 6.5 19 12l-5.5 5.5\"/>",
  source: "<ellipse cx=\"12\" cy=\"5.5\" rx=\"7.5\" ry=\"2.5\"/><path d=\"M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13\"/><path d=\"M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5\"/>",
  parcel: "<path d=\"M12 5.07 22 10.85 12 16.62 2 10.85Z\"/><path d=\"M7 7.96 17 13.73M17 7.96 7 13.73\"/>",
};

const PERMIT_STATUSES = ["new", "pending", "active", "completed", "expired"];

function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]);
}

/** Inline SVG icon (stroke = currentColor). Decorative unless a label is given. */
export function bsIcon(name, size = 20, label = "") {
  const body = ICON_PATHS[name];
  if (!body) return "";
  const a11y = label ? `role="img" aria-label="${escapeAttr(label)}"` : "aria-hidden=\"true\"";
  return `<svg class="bs-icon" viewBox="0 0 24 24" width="${size}" height="${size}" ${a11y} fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter">${body}</svg>`;
}

/** Normalized permit status slug for `.bs-status[data-status]`, or "" when unknown. */
export function bsStatusSlug(status) {
  const slug = String(status ?? "").trim().toLowerCase();
  return PERMIT_STATUSES.includes(slug) ? slug : "";
}

/**
 * Status pill. `label` is the visible word (already display-ready; CSS
 * uppercases it). Unknown statuses render as a neutral pill without a tone.
 */
export function bsStatusPill(status, label) {
  const slug = bsStatusSlug(status);
  const text = label ?? (status ? String(status) : "Unknown");
  const tone = slug ? ` data-status="${slug}"` : "";
  return `<span class="bs-status"${tone}>${escapeAttr(text)}</span>`;
}

/** Two status pills joined by an arrow, e.g. NEW → ACTIVE. */
export function bsTransition(previous, next, previousLabel, nextLabel) {
  const arrowLabel = `${previousLabel ?? previous ?? "New"} to ${nextLabel ?? next ?? "Updated"}`;
  return `<span class="bs-transition" role="img" aria-label="${escapeAttr(arrowLabel)}">${bsStatusPill(previous, previousLabel)}${bsIcon("arrow-right", 14)}${bsStatusPill(next, nextLabel)}</span>`;
}
