-- Discovery hardening: prevent duplicate evidence events from repeated scans.
CREATE UNIQUE INDEX IF NOT EXISTS idx_basis_reset_events_source_unique
ON basis_reset_events(source_url, event_type, event_date);
