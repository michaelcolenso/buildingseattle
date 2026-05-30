# Building Seattle — Visual/Structural Design Audit

*Generated 2026-05-30. Scope: every page rendered out of `worker.js`.*

The entire UI lives in six HTML render functions inside `worker.js`. Each
defines its own `<style>` block with no shared tokens, helper, or imported
CSS. This document catalogs the resulting inconsistencies and lists
prioritized, incremental recommendations. No code changes are proposed
beyond what is described here.

## 1. Inventory

| # | Page | Route | Render fn (line) | `<style>` span | LOC | Nav | Footer | CSS vars |
|---|---|---|---|---|---|---|---|---|
| 1 | Landing | `/` | `handleRoot` (433) | 455–571 | ~116 | yes (fixed) | yes | yes (12 tokens, full dark-mode block) |
| 2 | Permit browser | `/permits` | `renderPermitBrowser` (1300) | 1423–1475 | ~52 | yes (sticky) | **no** | yes (7 tokens, no dark mode) |
| 3 | Permit detail | `/permits/:n` | `renderPermitDetail` (1564) | 1800–2069 | ~269 | yes (fixed) | yes (centered, 2 lines) | yes (10 tokens + dark mode) |
| 4 | Admin | `/admin` | `renderAdminDashboard` (2335) | 2375–2386 | **~11** | **no** | **no** | yes (7 tokens, no dark mode) |
| 5 | Contractor | `/contractor/:slug` | `renderContractorPage` (2416) | 2554–2569 | ~15 (minified, hex-only) | yes (inline-styled, fixed) | **no** | **no** (raw hex everywhere) |
| 6 | 404 | fallthrough | `render404` (4252) | 4263–4280 | ~17 | yes (fixed, logo only — no links) | **no** | yes (6 tokens) |

Plain-text 404s sent without an HTML wrapper:

- `worker.js:1585` — `return new Response("Permit not found", { status: 404 })`
- `worker.js:2421` — `return new Response("Contractor not found", { status: 404 })`

These bypass `render404()` entirely and ship an unstyled, unbranded body.

The brief mentions a `/permits/changes` page; it does not exist. The
status-changes feed is rendered as a `<section>` inside `/permits` (worker.js:1539–1550)
and exposed only as JSON via `/api/status-changes`.

## 2. Top inconsistencies (ranked)

### F1. Primary accent blue is defined three different ways (high)

- Landing `:root --accent: #3b82f6` (line 456).
- Permit browser `:root --accent: #2563eb` (line 1424).
- Permit detail `:root --accent: #3b82f6`, hover `#2563eb` (1803–1804).
- Admin `--accent: #3b82f6` (2376).
- Contractor: no var — hex `#3b82f6` and `#eff6ff` hardcoded ≥5 times (2561, 2567, 2655–2675, 2683).
- 404 button hover `#2563eb` (4277).

**Impact:** the same "primary blue" link/button shifts a perceptible shade
as users move from `/permits` → `/permits/:n`.

### F2. Muted/secondary text token has two names AND two values (high)

- Landing/detail/admin/404 use `--text-muted: #64748b`.
- Permit browser uses `--muted: #64748b` (different name → can't share rules).
- Contractor page uses raw `#64748b` for body muted and `#94a3b8` for hero
  muted (2588, 2595, 2599–2604, 2683, 2501) — dark-mode muted leaks into a
  light hero.

**Impact:** inline contractor styles can't be retargeted from one place;
two visibly different greys appear on the contractor page alone.

### F3. Background page color drifts (high)

- Landing `--bg: #ffffff`, contractor `body{background:#f8fafc}`, admin
  `--bg: #f8fafc`, permit browser `--bg: #f8fafc`, permit detail
  `--bg: #ffffff`, 404 `--bg: #f8fafc`.

**Impact:** `/` and `/permits/:n` are pure white; `/permits`, `/admin`,
`/contractor/:slug`, `/404` are slate-50. Visiting `/permits` →
`/permits/:n` visibly brightens the page.

### F4. Nav is wildly inconsistent (high)

| Page | Position | Height | Bg blur | Hamburger | Link set |
|---|---|---|---|---|---|
| Landing (461) | `fixed` | 4rem | `blur(12px)` rgba .8 | yes, breakpoint 768px | Browse Permits / Live Data / Data API |
| Permit browser (1428) | `sticky` | 4.5rem (`min-height`) | `blur(12px)` rgba .95 | yes, breakpoint **720px** | Home / Permits / API |
| Permit detail (1835) | `fixed` | 4rem | `blur(12px)` rgba **.9** | yes, breakpoint 720px | Home / Permits / API (mobile drawer) + desktop "← Back to Permits" only |
| Admin | **no nav at all** | – | – | – | – |
| Contractor (2573) | `fixed` (inline-styled) | 4rem | `blur(10px)` rgba .9 | yes, breakpoint 768px | "Browse Permits" button + mobile drawer |
| 404 (4268) | `fixed` | 4rem | `blur(12px)` | none | logo only |

**Impact:** content slides under the nav on landing/detail/contractor but
not on `/permits` (sticky). `padding-top:5.25rem` is needed on permit
detail (2090) and isn't on contractor (relies on hero `margin-top:4rem`).
Mobile breakpoint is 768 on three pages and 720 on two — a 48-pixel dead
zone where one page is mobile and the next isn't.

### F5. Card border-radius has no scale (high)

- `.data-panel` (landing) `0.75rem` (513).
- `.permit-card` and `.change-card` (permit browser) `1rem` (1455, 1461).
- `.card` (permit detail) `0.75rem` (1951), `.permit-header` `1rem` (1899),
  `.btn` `0.5rem` (2027).
- `.card` (admin) `0.75rem` (2380).
- `.card` (contractor) `1rem` (2559); inline `.metric` `0.5rem`,
  inline `.btn` `0.5rem`.
- 404 buttons `0.5rem`.

**Impact:** `0.5 / 0.75 / 1rem` radii mix within the same view (notably
contractor nests `1rem` cards around `0.5rem` metric tiles).

### F6. `.btn` is redefined incompatibly five times (high)

- Landing (477): `padding 0.75rem 1.5rem; radius 0.5rem; font-size 0.875rem`.
- Permit detail (2021): `padding 0.875rem 1.5rem; radius 0.5rem; font-size 0.875rem; gap 0.5rem`.
- Contractor (2561): `padding 0.75rem 1.5rem; radius 0.5rem; font-weight 600` — used as a nav element "Browse Permits", hidden under 768px (2568) which kills the only nav CTA on mobile.
- 404 (4276): merged primary+base.
- Permit browser uses `button {…}` instead (1445), no `.btn` class at all — primary submit looks different from landing/detail.

**Impact:** the same CTA changes vertical rhythm between pages.

### F7. Status pill / badge color mapping is contradictory (high)

- Landing `.badge-blue` = accent blue; `.badge-green` = `#10b981` (533–534).
- Permit browser `.status-pill` is *always blue* — every permit row gets
  `rgba(37,99,235,.12)` regardless of status (1467). The status-change card
  uses the raw status (any status renders identical blue).
- Permit detail `statusColors`: active=#10b981, pending=#f59e0b,
  completed=#3b82f6, new=#8b5cf6 (1691–1697).
- Admin badges hardcoded (2347, 2363): success=#10b981, error=#ef4444,
  lead=#3b82f6.
- Contractor WA L&I credential pill (2480–2484): ACTIVE=#10b981,
  EXPIRED=#ef4444, else=#64748b.

**Impact:** the same word "Active" appears blue in `/permits`,
emerald on `/permits/:n`, and emerald on `/contractor/:slug`. Users can't
develop a consistent color → status mapping. The `pending → active` arrow
on the changes feed uses identical color for both sides.

### F8. Container width / breakpoints are inconsistent (medium)

- Container `max-width` is `1200px` on landing/permit-detail/admin/contractor/404
  but `1120px` on `/permits` (1427). Clicking from `/permits` to
  `/permits/:n` visibly widens the page ~80px on desktop.
- Responsive breakpoints: 720, 767, 768, 1024 appear ad-hoc (467, 470, 492,
  562, 1434, 1470, 1890, 1940, 1943, 2562, 2568) — no scale.

### F9. Heading sizes drift (medium)

- Hero h1: landing `3rem / 4rem md+` (493–494), permit-browser
  `clamp(2rem,4vw,3.25rem)` (1440), permit-detail h1 `2rem` (1910),
  contractor `3rem` inline (2594), 404 `6rem` (4273).
- h2: landing `2.5rem` (508); permit-detail and contractor inherit UA
  defaults.
- Several headings (admin h1/h2, contractor `<h2>`/`<h3>`) inherit browser
  defaults entirely — no font-family override beyond body, so they fall
  through to system serif on some Safari builds because
  `font-family: sans-serif` (2377) doesn't match the `-apple-system` stack
  used everywhere else.

### F10. Font stack splits — admin and contractor diverge (medium)

- Landing/permit-browser/permit-detail/404 use
  `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`.
- Admin (2377): `font-family: sans-serif` (generic only).
- Contractor (2555): includes `'Helvetica Neue', Arial` — slightly
  different fallback list than permit-detail (1827). Effectively two stacks
  across five pages.

### F11. Footer presence is random (medium)

- `/` has a rich footer (lines 653–660).
- `/permits/:n` has a centered single-line footer (2201–2205) — different
  layout, no links.
- `/permits`, `/admin`, `/contractor/:slug`, `/404` have no footer at all.

**Impact:** users hitting a contractor or 404 page can't find brand
contact info.

### F12. Hero treatments don't share a system (medium)

- Landing hero: canvas skyline + gradient overlays, dark theme, badge chip,
  ops chips, 760px min-height (480–503).
- Permit-browser hero: light, just an `<h1>+<p>`, no styling beyond margin
  (1439–1441, 1496–1499).
- Permit-detail "hero": none — only the `.permit-header` card (2098–2105).
- Contractor "seo-hero": dark gradient `#0f172a → #1e293b`, padding
  `6rem 0 3rem`, inline-styled (2557, 2586–2609). Uses `#94a3b8` (5×) for
  muted text on dark — unrelated to any token.
- 404 has no hero, just `.error-section` (4272–4275).

### F13. Recent status changes is a section, not a page (medium)

There is no `/permits/changes` route. The status-changes feed is rendered
as a `<section>` inside `/permits` (1539–1550) and exposed only as JSON via
`/api/status-changes`. The section CSS lives at 1450–1459. If a page is
intended, it doesn't exist.

### F14. WA L&I credential card breaks the contractor page's own color scheme (low)

The new credentials card (2492–2503) hardcodes `#64748b`, `#94a3b8`, `#fff`
and a per-status pill background that doesn't reuse `var(--success)` /
`var(--danger)` (there are no vars on this page). It uses
`font-family: monospace` for the license/UBI, which appears nowhere else;
the permit-detail page uses `'SF Mono', Monaco, monospace` (1904) for the
analogous permit number. Two different monospace fallbacks.

### F15. Form/input styling is reinvented per page (low)

- Landing `.form-group input, select`: padding 0.75rem, radius 0.5rem,
  `transition: border-color 0.2s`, focus highlights accent (557–558).
- Permit-browser filters: `select, button, .secondary-link` collapsed into
  one rule, padding 0.8rem 0.9rem, radius 0.75rem (1444). `<input>` not
  covered — has inline style at 1503.
- Permit-detail modal inputs: identical to landing minus the transition
  (2067).
- Admin and contractor have no forms.

### F16. Box-shadow scale is arbitrary (low)

At least 7 distinct shadows appear across the file:

- `0 22px 60px rgba(15,23,42,.14)`
- `0 14px 45px rgba(15,23,42,.06)`
- `0 16px 50px rgba(2,6,23,.22)`
- `0 8px 30px rgba(15,23,42,.04)`
- `0 4px 6px -1px rgb(0 0 0 /.1)`
- `0 1px 3px rgba(0,0,0,.1)`
- `0 4px 12px rgba(0,0,0,.08)`

No two pages share a shadow value.

## 3. Recommendations (prioritized, incremental)

1. **Add a `renderDesignTokens()` helper that returns a `<style>` string and inject it into every render fn (M).** Define
   `:root { --primary, --accent, --accent-hover, --bg, --surface, --bg-alt, --text, --text-muted, --border, --success, --warn, --danger, --shadow-sm, --shadow-md, --radius-sm, --radius-md, --radius-lg, --container-max: 1200px }`
   plus the dark-mode block once. Touches `handleRoot`,
   `renderPermitBrowser`, `renderPermitDetail`, `renderAdminDashboard`,
   `renderContractorPage`, `render404`. Rename `--muted` → `--text-muted`
   in `renderPermitBrowser`. Replace raw hexes on contractor page with vars.
2. **Standardize `--accent` on a single value (S).** Pick `#2563eb` (used
   by `/permits` and link-blue on contractor) or `#3b82f6` (the other four
   pages) and globally apply via the tokens helper. Removes F1 and F7
   drift.
3. **Extract one `renderNav(activePage)` helper (M).** Defines fixed nav,
   4rem height, `blur(12px)` rgba(255,255,255,.9), 768px hamburger
   breakpoint, same link list (Home / Permits / API / Contact). Replace the
   five hand-rolled navs. Add nav to `/admin`. Ensure
   `main { padding-top: 4.5rem }` is set everywhere so content doesn't
   slide under the nav (currently only permit detail does this manually at
   2090).
4. **Extract `renderFooter()` and call it on every page (S).** Includes
   404 and contractor.
5. **Unify `.btn` and `.btn-secondary` definitions in the tokens helper
   (S).** Pick landing's
   `padding: 0.75rem 1.5rem; border-radius: var(--radius-md); font-size: 0.875rem;`.
   Remove the inline `.btn` on contractor (line 2561) and stop hiding the
   nav CTA below 768px (2568) — promote it into the shared nav instead.
6. **Define `statusColors` once and use it everywhere (M).** Today it
   lives at lines 1691–1697 (permit detail). Move it into a top-level
   constant. Update the `/permits` status-pill (1467) so each card's pill
   color reflects status (active=success, pending=warn, completed=accent,
   new=violet, expired/cancelled=danger/muted), and use the same map for
   the status-change feed and the contractor credential pill. Resolves F7.
7. **Standardize container width on 1200px (S).** Change
   `renderPermitBrowser` line 1427 from `1120px` → `var(--container-max)`.
8. **Replace the two plain-text 404s with `render404()` (S).** Lines 1585
   and 2421 should return styled HTML 404s with a contextual message
   ("Permit not found" / "Contractor not found").
9. **Pick one mobile breakpoint and a single heading scale (S).** Settle
   on `min-width: 768px` (drop the 720 cases at 1434, 1470, 1890, 2562).
   Define `h1: 3rem / 4rem md+; h2: 2rem; h3: 1.25rem` in tokens; remove
   inline `font-size:3rem` on contractor h1 (2594) and `font-size:2rem`
   on permit-title (1910).
10. **Either build `/permits/changes` as a real page or remove the brief
    mention (S).** Currently a section inside `/permits`. If a dedicated
    page is wanted, factor a `renderStatusChangesPage` that reuses
    `renderStatusChangeCards` and the new nav/footer helpers.
11. **Collapse the shadow scale to two values (S).**
    `--shadow-sm: 0 1px 3px rgba(0,0,0,.08); --shadow-md: 0 8px 30px rgba(15,23,42,.06)`.
    Replace every literal shadow.
12. **Contractor page: convert the inline-styled hero, metrics grid, and
    credentials card to use the shared tokens (M).** After tokens land,
    remove the per-page `<style>` minified block (2554–2569) and replace
    inline color strings (`#94a3b8`, `#3b82f6`, `#eff6ff`, `#e2e8f0`) with
    vars. Touches lines 2554–2690.

## 4. Quick wins (each < 1 hour)

- **QW1.** Replace the two raw text 404s (worker.js:1585, 2421) with
  `render404()` calls — 2-line change, restores branding on dead
  permits/contractors.
- **QW2.** Rename `--muted` → `--text-muted` in `renderPermitBrowser`
  (1424, plus every usage 1441–1469) so the same variable name works
  across all pages.
- **QW3.** Change `max-width: 1120px` → `1200px` on line 1427 — eliminates
  the page-width jump between `/permits` and `/permits/:n`.
- **QW4.** Add a `<footer>` to `/admin`, `/contractor/:slug`, and `/404`
  with the same 2-line markup used at 2202–2204 — instantly fixes
  brand-presence holes.
- **QW5.** Pick one accent blue (`#2563eb`) and globally search/replace
  `#3b82f6` in `worker.js`. ~12 hits. Tightens F1/F7 even before any
  helper extraction.
