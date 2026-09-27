# Basis Reset Radar

Basis Reset Radar identifies Seattle properties where a sale, foreclosure, note sale, recapitalization, developer exit, JV solicitation, or permit-ready listing materially changes the economics of redevelopment.

## V1 thesis

Permits tell us what somebody wanted to build. Basis resets identify cases where the capital structure changed enough that a previously marginal redevelopment may become viable.

The radar ranks records using three independently inspectable components:

1. **Reset magnitude (45%)** — observed decline from prior basis to current sale/listing basis. Missing basis is explicitly unknown, never treated as zero.
2. **Redevelopment readiness (35%)** — existing linked project/permit activity, issued permits, and demolition completion.
3. **Signal strength (20%)** — event type, source confidence, and recency.

The score is a prioritization heuristic, not an appraisal or forecast. Historical outcomes should later calibrate the weights.

## Event model

Every event requires a source URL, date, event type, and confidence. Events attach to an existing entity-graph address or project. This prevents a second property identity system from drifting away from permits.

Supported signals: sale, listing, foreclosure, note sale, recapitalization, developer exit, JV solicitation, permit-ready sale, valuation.

## Data-source order

Prefer: King County recorded transactions/public records; Seattle/SDCI project and permit records; broker listings; then credible reporting. News can discover a signal, but public records should replace it as the canonical source when available.

## Next integration

- ingestion endpoint protected by the existing ingest token;
- resolver from parcel/address to entity-graph address/project;
- materialize `basis_reset_scores` after event ingestion;
- public `/insights/basis-reset` leaderboard and detail timeline;
- scheduled discovery for large basis declines, foreclosure/note-sale events, and permit-ready project listings;
- outcome tracking: construction start, new permit, sale, or no action at 6/12/24 months.
