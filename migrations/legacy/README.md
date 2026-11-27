# Legacy ad-hoc migrations (history only)

These files are how the production schema was built before the repo moved to
`wrangler d1 migrations` (see "Database migrations" in `CLAUDE.md`). They were
applied by hand, one at a time, with
`wrangler d1 execute buildingseattle --file <file>`, and nothing recorded
which ones ran. Keep them for history and `git blame`. **Do not apply them to
any database.** Wrangler only reads `migrations/*.sql`, so files in this
subdirectory are never picked up by `wrangler d1 migrations apply`.

Everything production actually has is captured in
`migrations/0000_baseline.sql`, read from production `sqlite_master` on
2026-11-27. Status of each file against that snapshot:

| File | In production? | Notes |
|---|---|---|
| `page_views_migration.sql` | yes | |
| `migration_ingest_logs.sql` | yes | |
| `migration_permit_import_columns.sql` | yes | |
| `migration_permit_people.sql` | yes | |
| `migration_permit_updated_at.sql` | yes | `updated_at` has no DEFAULT in production |
| `migration_permit_enrichment.sql` | yes | |
| `migration_permit_status_changes.sql` | yes | |
| `migration_permit_base_feed_columns.sql` | yes | |
| `migration_entity_graph.sql` | yes, with differences | production `addresses.normalized_address` is not UNIQUE; index names differ (`idx_projects_address`, `idx_permit_participants_people`/`_permit`/`_role`, `idx_project_participants_people`/`_project`, `idx_people_orgs_type`) |
| `migration_entity_graph_upstream_compat.sql` | yes (columns) | re-adds columns `migration_entity_graph.sql` already adds, so applying both fails with "duplicate column" |
| `migration_permit_alert_subscriptions.sql` | yes | |
| `migration_permit_review_dates.sql` | yes | |
| `migration_permit_adu_classification.sql` | yes | |
| `migration_basis_reset_radar.sql` | yes | |
| `migration_basis_reset_discovery.sql` | **no** | its `idx_basis_reset_events_source_unique` is now created by `migrations/0001_hot_query_indexes.sql` |
| `migration_development_sites.sql` | yes | |
| `migration_alert_watches.sql` | **no, and dead** | no code reads or writes `alert_watches` / `alert_notification_log`; it was a draft for a paid alert tier that never shipped. If that product is built, re-create the tables in a new numbered migration. |

Production also has a `watchlists` table (0 rows) that no file here or in
the code defines; the baseline keeps it so it matches production.
