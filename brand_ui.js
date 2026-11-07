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

// ---------- Theme (brand pass 4) ----------
// The page follows the OS colour scheme until the visitor picks a theme with
// the nav toggle; the choice is stored in localStorage under "bs-theme".
// tokens.css carries the dark values under [data-theme="dark"].

/**
 * Inline <script> for the top of <head>: sets data-theme on <html> before
 * first paint, follows OS changes while no choice is stored, and syncs every
 * .theme-toggle's aria-pressed. The toggle stays hidden until this has run.
 */
export function themeBootScript() {
  return `<script>(function(){var d=document.documentElement,k="bs-theme",t="",m=window.matchMedia?matchMedia("(prefers-color-scheme: dark)"):0;try{t=localStorage.getItem(k)||"";}catch(e){}function dark(){return t==="dark"||(t!=="light"&&!!(m&&m.matches));}function sync(){var on=String(dark());document.querySelectorAll(".theme-toggle").forEach(function(b){b.setAttribute("aria-pressed",on);});}function apply(){d.setAttribute("data-theme",dark()?"dark":"light");sync();}apply();if(m&&m.addEventListener)m.addEventListener("change",function(){if(!t)apply();});document.addEventListener("DOMContentLoaded",sync);document.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest(".theme-toggle"):0;if(!b)return;t=dark()?"light":"dark";try{localStorage.setItem(k,t);}catch(x){}apply();});})();</script>`;
}

const MOON = "<path d=\"M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z\"/>";
const SUN = "<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8\"/>";

function strokeSvg(body, className) {
  return `<svg class="bs-icon ${className}" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter">${body}</svg>`;
}

/** Toggle button; clicks are handled by themeBootScript. aria-pressed = dark theme on. */
export function themeToggleButton() {
  return `<button type="button" class="theme-toggle" aria-label="Dark theme" aria-pressed="false" title="Toggle dark theme">${strokeSvg(MOON, "theme-toggle__moon")}${strokeSvg(SUN, "theme-toggle__sun")}</button>`;
}

/** CSS for the toggle (works inside any template's <style>). */
export function themeToggleStyles() {
  return `.theme-toggle{display:none;place-items:center;width:40px;height:40px;padding:0;border:1px solid var(--line);border-radius:var(--radius-sm);background:transparent;color:var(--ink-secondary);cursor:pointer}
      [data-theme] .theme-toggle{display:inline-grid}
      .theme-toggle:hover{background:var(--surface-alt);color:var(--ink)}
      .theme-toggle__sun,[data-theme="dark"] .theme-toggle__moon{display:none}
      [data-theme="dark"] .theme-toggle__sun{display:block}
      .bs-themed-lockup>img.lockup-dark,[data-theme="dark"] .bs-themed-lockup>img.lockup-light{display:none}
      [data-theme="dark"] .bs-themed-lockup>img.lockup-dark{display:block}`;
}

/** Header lockup that swaps to the reversed artwork in the dark theme. */
export function themedLockup(alt = "Building Seattle", width = 209, height = 24) {
  return `<span class="bs-themed-lockup"><img class="lockup-light" src="/brand/lockup.svg" alt="${escapeAttr(alt)}" width="${width}" height="${height}"><img class="lockup-dark" src="/brand/lockup-dark.svg" alt="${escapeAttr(alt)}" width="${width}" height="${height}"></span>`;
}
