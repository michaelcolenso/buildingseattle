CREATE TABLE IF NOT EXISTS permit_status_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    permit_number TEXT NOT NULL,
    previous_status TEXT,
    new_status TEXT NOT NULL,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_permit_status_changes_changed_at ON permit_status_changes(changed_at);
CREATE INDEX IF NOT EXISTS idx_permit_status_changes_permit_number ON permit_status_changes(permit_number);
