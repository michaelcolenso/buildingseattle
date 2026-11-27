-- Entity graph migration: turns the raw permit feed into first-class
-- addresses, people/orgs, projects and neighborhoods.
--
-- Permits remain the source-of-truth evidence records. These tables are
-- DERIVED from permits and are rebuilt by the worker's entity-graph builder
-- (POST /admin/build-graph) and kept in sync incrementally at ingest time.
--
-- Safe to run more than once (IF NOT EXISTS / additive columns).

-- ---------------------------------------------------------------------------
-- addresses / properties
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    normalized_address TEXT NOT NULL UNIQUE,
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

-- ---------------------------------------------------------------------------
-- people / organizations (contractors, owners, applicants, architects, ...)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS people_orgs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE,
    type_guess TEXT DEFAULT 'unknown',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_people_orgs_slug ON people_orgs(slug);
CREATE INDEX IF NOT EXISTS idx_people_orgs_normalized ON people_orgs(normalized_name);

-- ---------------------------------------------------------------------------
-- projects (inferred clusters of permit activity at an address)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    address_id INTEGER,
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
CREATE INDEX IF NOT EXISTS idx_projects_address_id ON projects(address_id);

-- ---------------------------------------------------------------------------
-- join tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_permits (
    project_id INTEGER NOT NULL,
    permit_id INTEGER NOT NULL,
    PRIMARY KEY (project_id, permit_id)
);
CREATE INDEX IF NOT EXISTS idx_project_permits_permit ON project_permits(permit_id);

CREATE TABLE IF NOT EXISTS permit_participants (
    permit_id INTEGER NOT NULL,
    people_org_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (permit_id, people_org_id, role)
);
CREATE INDEX IF NOT EXISTS idx_permit_participants_org ON permit_participants(people_org_id);

CREATE TABLE IF NOT EXISTS project_participants (
    project_id INTEGER NOT NULL,
    people_org_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (project_id, people_org_id, role)
);
CREATE INDEX IF NOT EXISTS idx_project_participants_org ON project_participants(people_org_id);

-- ---------------------------------------------------------------------------
-- neighborhoods
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS neighborhoods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_neighborhoods_slug ON neighborhoods(slug);

CREATE TABLE IF NOT EXISTS address_neighborhoods (
    address_id INTEGER NOT NULL,
    neighborhood_id INTEGER NOT NULL,
    PRIMARY KEY (address_id, neighborhood_id)
);
CREATE INDEX IF NOT EXISTS idx_address_neighborhoods_nb ON address_neighborhoods(neighborhood_id);

-- ---------------------------------------------------------------------------
-- permits: link to the derived entity graph + capture geo when available
-- (SQLite has no IF NOT EXISTS for ADD COLUMN; ignore "duplicate column" errors
--  when re-running.)
-- ---------------------------------------------------------------------------
ALTER TABLE permits ADD COLUMN address_id INTEGER;
ALTER TABLE permits ADD COLUMN project_id INTEGER;
ALTER TABLE permits ADD COLUMN lat REAL;
ALTER TABLE permits ADD COLUMN lng REAL;
ALTER TABLE permits ADD COLUMN zip TEXT;

CREATE INDEX IF NOT EXISTS idx_permits_address_id ON permits(address_id);
CREATE INDEX IF NOT EXISTS idx_permits_project_id ON permits(project_id);
