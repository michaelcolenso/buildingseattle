# Alert Products — Pricing & Definitions (Task C1)

Status: **planning document**. No billing integration exists yet (Task C4);
`migration_alert_watches.sql` defines the schema but is not applied to
production. This documents the target shape so C2–C7 can be built against it.

## Products

| Product | What it does | Price | Build complexity |
|---|---|---|---|
| **Neighborhood Digest** | Weekly email: new + status-changed permits in chosen neighborhood(s) | Free (lead magnet) | SQL only — data ready today |
| **Contractor Watch** | Same-day email when a watched contractor (license or name) files a permit or a status changes | Pro | SQL only — no geo dependency — **build first** |
| **Address Watch** | Same-day email for permits at a watched address (exact normalized-address match); v1.1 adds radius 0.25–1 mi | Pro | Exact match is easy; radius blocked on the geocoding backlog (C2) |

## Plans

| Plan | Price | Includes |
|---|---|---|
| Free | $0 | Neighborhood digest, 1 neighborhood |
| Pro | $39/mo | 25 watches, all watch types, same-day delivery |
| Team | $79/mo | Unlimited watches + monthly CSV export of matches |

**Rationale:** Permit Ledger charges $39/mo for its entire renovation dashboard; PermitGrab is $149/mo flat. Pro at $39/mo undercuts Permit Ledger's whole product while offering Seattle-only depth (contractor license matching, address-level watches) neither Permit Ledger nor the Open Data Portal provides. Team at $79/mo stays well under PermitGrab.

**Launch pricing:** first month at $29/mo (coupon), matching the Gumroad dataset's launch-discount pattern (Task A4).

## Watch matching (for Task C5)

- `contractor` — match on `permits.contractor_license` (exact) or normalized `contractor_name`.
- `address` — match on `permits.address_id` (exact) or a normalized address string; v1.1 radius via haversine over geocoded `permits.lat/lng` (Task C2).
- `neighborhood` — match on `permits.neighborhood`.
- `permit` — existing free per-permit flow in `permit_alert_subscriptions`; unchanged, not part of this schema.

Dedupe every send through `alert_notification_log` (see `migration_alert_watches.sql`) keyed on `(watch_id, permit_number, change_id)` so a re-ingest or overlapping ingest+enrichment pass never double-sends. Free plan is gated to weekly digest only; Pro/Team get same-day sends per Task C5's cron chain.

## Dependencies / sequencing

- Builds on the existing `/alerts/*` per-permit flow, `permit_status_changes`, and `leads.neighborhoods` (kept as top-of-funnel).
- Requires PR-3 of the worker.js module split (`src/routes/alerts.js`, Task B5) to land first — Phase 3 code should live there, not be bolted onto the monolith.
- Contractor Watch and Neighborhood Digest ship without geocoding. Address Watch v1.1 radius is the only feature gated on Task C2.
- Billing (Stripe vs. Gumroad memberships) is a separate open decision — see Task C4 in the implementation plan.
