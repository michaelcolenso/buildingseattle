ALTER TABLE permits ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_permits_updated_at ON permits(updated_at);
