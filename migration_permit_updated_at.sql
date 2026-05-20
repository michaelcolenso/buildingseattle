ALTER TABLE permits ADD COLUMN updated_at DATETIME;
UPDATE permits SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_permits_updated_at ON permits(updated_at);
