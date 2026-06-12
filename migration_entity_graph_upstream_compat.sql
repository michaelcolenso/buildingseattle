-- Compatibility migration for databases that received the earlier entity graph
-- migration before the canonical graph builder added project and geolocation links.

ALTER TABLE permits ADD COLUMN project_id INTEGER;
ALTER TABLE permits ADD COLUMN lat REAL;
ALTER TABLE permits ADD COLUMN lng REAL;
ALTER TABLE permits ADD COLUMN zip TEXT;

CREATE INDEX IF NOT EXISTS idx_permits_project_id ON permits(project_id);
