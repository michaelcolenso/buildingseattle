-- 0000_baseline.sql: the production D1 schema as of 2026-11-27.
--
-- Read from production `sqlite_master` (read-only) and copied verbatim,
-- with `IF NOT EXISTS` added so the file is idempotent. Column order and the
-- odd line breaks are production's own: most columns arrived through
-- `ALTER TABLE ... ADD COLUMN` in the ad-hoc files now kept in
-- migrations/legacy/. D1-internal tables (`_cf_KV`, `sqlite_sequence`) are
-- left out.
--
-- Production already has every object below. Do NOT run this file against
-- production: mark it as applied instead (see "Database migrations" in
-- CLAUDE.md). On a fresh local database, `wrangler d1 migrations apply`
-- runs it like any other migration.
--
-- Known oddities kept on purpose so the baseline matches production:
-- - `watchlists` exists in production with no code that reads or writes it
--   (0 rows on 2026-11-27). Dropping it is a separate, deliberate change.
-- - `permits.updated_at` has no DEFAULT (it was added by ALTER TABLE).
-- - `addresses.normalized_address` is indexed but not UNIQUE.

CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    company TEXT NOT NULL,
    interest TEXT NOT NULL,
    neighborhoods TEXT,
    source TEXT,
    user_agent TEXT,
    status TEXT DEFAULT 'new',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contractors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    specialty TEXT,
    description TEXT,
    license_number TEXT,
    bonding_capacity TEXT,
    years_active INTEGER,
    specialties TEXT,
    phone TEXT,
    email TEXT,
    website TEXT,
    address TEXT,
    active_projects INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
, license_status TEXT, ubi TEXT, insurance_amount INTEGER, insurance_expires_date DATE);

CREATE TABLE IF NOT EXISTS permits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    permit_number TEXT UNIQUE,
    contractor_id INTEGER,
    address TEXT NOT NULL,
    neighborhood TEXT,
    type TEXT,
    value INTEGER,
    status TEXT,
    description TEXT,
    issued_date DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, owner_name TEXT, owner_address TEXT, applicant_name TEXT, architect_name TEXT, housing_units INTEGER DEFAULT 0, applied_date DATE, completed_date DATE, housing_units_added INTEGER, housing_units_removed INTEGER, housing_units_existing INTEGER, sleeping_rooms INTEGER, expires_date DATE, permit_detail_url TEXT, contractor_license TEXT, contractor_source TEXT, work_performed_by TEXT, review_level TEXT, primary_property_use TEXT, parcel_number TEXT, detailed_description TEXT, record_status_detail TEXT, has_required_inspections INTEGER DEFAULT 0, has_completed_inspections INTEGER DEFAULT 0, last_enriched_at DATETIME, updated_at DATETIME, zoning TEXT, housing_category TEXT, dwelling_unit_type TEXT, parent_permit_number TEXT, related_mup TEXT, number_review_cycles INTEGER, total_days_plan_review INTEGER, days_out_corrections INTEGER, address_id INTEGER REFERENCES addresses(id), project_id INTEGER, lat REAL, lng REAL, zip TEXT, plan_review_complete_date DATE, ready_to_issue_date DATE, adu_type TEXT CHECK (adu_type IN ('ADU', 'DADU') OR adu_type IS NULL), adu_classification_version INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (contractor_id) REFERENCES contractors(id)
);

CREATE INDEX IF NOT EXISTS idx_contractors_slug ON contractors(slug);
CREATE INDEX IF NOT EXISTS idx_contractors_specialty ON contractors(specialty);
CREATE INDEX IF NOT EXISTS idx_permits_neighborhood ON permits(neighborhood);
CREATE INDEX IF NOT EXISTS idx_permits_status ON permits(status);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

CREATE TABLE IF NOT EXISTS ingest_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_type TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    records_added INTEGER DEFAULT 0,
    records_updated INTEGER DEFAULT 0,
    error_message TEXT,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    end_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ingest_logs_status ON ingest_logs(status);
CREATE INDEX IF NOT EXISTS idx_ingest_logs_run_type ON ingest_logs(run_type);

CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    referrer TEXT,
    user_agent TEXT,
    country TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views(path);
CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views(created_at);

CREATE TABLE IF NOT EXISTS permit_status_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    permit_number TEXT NOT NULL,
    previous_status TEXT,
    new_status TEXT NOT NULL,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_permit_status_changes_changed_at ON permit_status_changes(changed_at);
CREATE INDEX IF NOT EXISTS idx_permit_status_changes_permit_number ON permit_status_changes(permit_number);
CREATE INDEX IF NOT EXISTS idx_contractors_license_number ON contractors(license_number);
CREATE INDEX IF NOT EXISTS idx_permits_contractor_license ON permits(contractor_license);
CREATE INDEX IF NOT EXISTS idx_permits_last_enriched_at ON permits(last_enriched_at);
CREATE INDEX IF NOT EXISTS idx_permits_updated_at ON permits(updated_at);

CREATE TABLE IF NOT EXISTS watchlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    company TEXT NOT NULL,
    interest TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_value TEXT NOT NULL,
    entity_label TEXT,
    cadence TEXT DEFAULT 'daily',
    filters_json TEXT,
    source TEXT,
    status TEXT DEFAULT 'active',
    last_briefed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_watchlists_email ON watchlists(email);
CREATE INDEX IF NOT EXISTS idx_watchlists_status ON watchlists(status);
CREATE INDEX IF NOT EXISTS idx_watchlists_entity ON watchlists(entity_type, entity_value);
CREATE INDEX IF NOT EXISTS idx_permits_zoning ON permits(zoning);
CREATE INDEX IF NOT EXISTS idx_permits_parent_permit_number ON permits(parent_permit_number);
CREATE INDEX IF NOT EXISTS idx_permits_contractor_id ON permits(contractor_id);

CREATE TABLE IF NOT EXISTS addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    normalized_address TEXT NOT NULL,
    display_address TEXT NOT NULL,
    city TEXT DEFAULT 'Seattle',
    state TEXT DEFAULT 'WA',
    zip TEXT,
    lat REAL,
    lng REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_addresses_slug ON addresses(slug);
CREATE INDEX IF NOT EXISTS idx_addresses_normalized ON addresses(normalized_address);

CREATE TABLE IF NOT EXISTS people_orgs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    type_guess TEXT DEFAULT 'unknown',  -- contractor, owner, applicant, architect, developer, engineer, unknown
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_people_orgs_slug ON people_orgs(slug);
CREATE INDEX IF NOT EXISTS idx_people_orgs_normalized ON people_orgs(normalized_name);
CREATE INDEX IF NOT EXISTS idx_people_orgs_type ON people_orgs(type_guess);

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    address_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description_summary TEXT,
    confidence_score INTEGER DEFAULT 50,
    first_seen_date DATE,
    latest_activity_date DATE,
    total_estimated_value INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (address_id) REFERENCES addresses(id)
);

CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
CREATE INDEX IF NOT EXISTS idx_projects_address ON projects(address_id);

CREATE TABLE IF NOT EXISTS project_permits (
    project_id INTEGER NOT NULL,
    permit_id INTEGER NOT NULL,
    PRIMARY KEY (project_id, permit_id),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (permit_id) REFERENCES permits(id)
);

CREATE INDEX IF NOT EXISTS idx_project_permits_permit ON project_permits(permit_id);

CREATE TABLE IF NOT EXISTS permit_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    permit_id INTEGER NOT NULL,
    people_org_id INTEGER NOT NULL,
    role TEXT NOT NULL,  -- owner, applicant, architect, contractor, work_performed_by
    UNIQUE(permit_id, people_org_id, role),
    FOREIGN KEY (permit_id) REFERENCES permits(id),
    FOREIGN KEY (people_org_id) REFERENCES people_orgs(id)
);

CREATE INDEX IF NOT EXISTS idx_permit_participants_permit ON permit_participants(permit_id);
CREATE INDEX IF NOT EXISTS idx_permit_participants_people ON permit_participants(people_org_id);
CREATE INDEX IF NOT EXISTS idx_permit_participants_role ON permit_participants(role);

CREATE TABLE IF NOT EXISTS project_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    people_org_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    UNIQUE(project_id, people_org_id, role),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (people_org_id) REFERENCES people_orgs(id)
);

CREATE INDEX IF NOT EXISTS idx_project_participants_project ON project_participants(project_id);
CREATE INDEX IF NOT EXISTS idx_project_participants_people ON project_participants(people_org_id);

CREATE TABLE IF NOT EXISTS neighborhoods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_neighborhoods_slug ON neighborhoods(slug);

CREATE TABLE IF NOT EXISTS address_neighborhoods (
    address_id INTEGER NOT NULL,
    neighborhood_id INTEGER NOT NULL,
    PRIMARY KEY (address_id, neighborhood_id),
    FOREIGN KEY (address_id) REFERENCES addresses(id),
    FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id)
);

CREATE INDEX IF NOT EXISTS idx_permits_address_id ON permits(address_id);

CREATE TABLE IF NOT EXISTS permit_alert_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    permit_number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'unsubscribed')),
    confirmation_token_hash TEXT,
    unsubscribe_token TEXT NOT NULL UNIQUE,
    confirmation_sent_at DATETIME,
    confirmed_at DATETIME,
    unsubscribed_at DATETIME,
    last_notified_change_id INTEGER,
    last_notified_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (email, permit_number),
    FOREIGN KEY (permit_number) REFERENCES permits(permit_number)
);

CREATE INDEX IF NOT EXISTS idx_permit_alert_subscriptions_status
    ON permit_alert_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_permit_alert_subscriptions_permit
    ON permit_alert_subscriptions(permit_number);
CREATE INDEX IF NOT EXISTS idx_permit_alert_subscriptions_email
    ON permit_alert_subscriptions(email);
CREATE INDEX IF NOT EXISTS idx_permits_project_id ON permits(project_id);
CREATE INDEX IF NOT EXISTS idx_permits_plan_review_complete_date ON permits(plan_review_complete_date);
CREATE INDEX IF NOT EXISTS idx_permits_adu_type_activity ON permits(adu_type, issued_date, applied_date);
CREATE INDEX IF NOT EXISTS idx_permits_adu_type_neighborhood ON permits(adu_type, neighborhood);
CREATE INDEX IF NOT EXISTS idx_address_neighborhoods_nb ON address_neighborhoods(neighborhood_id);

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

CREATE TABLE IF NOT EXISTS development_sites (
    site_id TEXT PRIMARY KEY NOT NULL CHECK (site_id = UPPER(TRIM(site_id)) AND length(site_id) BETWEEN 1 AND 20),
    status TEXT,
    lot_sqft INTEGER CHECK (lot_sqft IS NULL OR lot_sqft > 0),
    boundary_geojson TEXT CHECK (boundary_geojson IS NULL OR json_valid(boundary_geojson)),
    source_updated_at TEXT,
    fetched_at TEXT NOT NULL
);
