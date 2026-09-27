-- Basis Reset Radar: event history + materialized opportunity scores.
CREATE TABLE IF NOT EXISTS basis_reset_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address_id INTEGER,
  project_id INTEGER,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'sale','listing','foreclosure','note_sale','recapitalization',
    'developer_exit','jv_solicitation','permit_ready_sale','valuation'
  )),
  event_date DATE NOT NULL,
  prior_basis INTEGER,
  current_basis INTEGER,
  asking_price INTEGER,
  source_url TEXT NOT NULL,
  source_name TEXT,
  source_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (source_type IN ('public_record','listing','news','manual')),
  confidence INTEGER NOT NULL DEFAULT 70 CHECK (confidence BETWEEN 0 AND 100),
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (address_id) REFERENCES addresses(id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  CHECK (address_id IS NOT NULL OR project_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS basis_reset_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address_id INTEGER,
  project_id INTEGER,
  latest_event_id INTEGER NOT NULL,
  reset_pct REAL,
  reset_score INTEGER NOT NULL,
  readiness_score INTEGER NOT NULL,
  signal_score INTEGER NOT NULL,
  opportunity_score INTEGER NOT NULL,
  explanation TEXT,
  scored_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (address_id) REFERENCES addresses(id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (latest_event_id) REFERENCES basis_reset_events(id),
  CHECK (address_id IS NOT NULL OR project_id IS NOT NULL),
  UNIQUE (address_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_basis_reset_events_date ON basis_reset_events(event_date DESC);
CREATE INDEX IF NOT EXISTS idx_basis_reset_events_address ON basis_reset_events(address_id);
CREATE INDEX IF NOT EXISTS idx_basis_reset_events_project ON basis_reset_events(project_id);
CREATE INDEX IF NOT EXISTS idx_basis_reset_events_type ON basis_reset_events(event_type);
CREATE INDEX IF NOT EXISTS idx_basis_reset_scores_opportunity ON basis_reset_scores(opportunity_score DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_basis_reset_scores_address_only
ON basis_reset_scores(address_id) WHERE project_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_basis_reset_scores_project
ON basis_reset_scores(project_id) WHERE project_id IS NOT NULL;
