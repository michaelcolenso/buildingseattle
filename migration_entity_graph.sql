-- Entity Graph Migration
-- Adds first-class entity tables: addresses, people_orgs, projects,
-- neighborhoods, and join tables for the entity graph.
--
-- Apply with:
--   npx wrangler d1 execute buildingseattle --remote --file migration_entity_graph.sql

-- === addresses ===
-- One row per unique normalized address extracted from permits.
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

-- === people_orgs ===
-- One row per unique person or organization extracted from
-- owner_name, applicant_name, architect_name, contractor_name,
-- and work_performed_by on permits.
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

-- === projects ===
-- Inferred projects: groups of permits clustered by address and similarity.
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

-- === project_permits ===
-- Many-to-many: which permits belong to which project.
CREATE TABLE IF NOT EXISTS project_permits (
    project_id INTEGER NOT NULL,
    permit_id INTEGER NOT NULL,
    PRIMARY KEY (project_id, permit_id),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (permit_id) REFERENCES permits(id)
);
CREATE INDEX IF NOT EXISTS idx_project_permits_permit ON project_permits(permit_id);

-- === permit_participants ===
-- Links permits to people_orgs with a role.
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

-- === project_participants ===
-- Links projects to people_orgs with a role.
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

-- === neighborhoods ===
-- Normalized neighborhood names extracted from permits.
CREATE TABLE IF NOT EXISTS neighborhoods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_neighborhoods_slug ON neighborhoods(slug);

-- === address_neighborhoods ===
-- Many-to-many: addresses can span multiple neighborhoods.
CREATE TABLE IF NOT EXISTS address_neighborhoods (
    address_id INTEGER NOT NULL,
    neighborhood_id INTEGER NOT NULL,
    PRIMARY KEY (address_id, neighborhood_id),
    FOREIGN KEY (address_id) REFERENCES addresses(id),
    FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id)
);

-- === address_id on permits ===
-- Add a column to back-reference permits to addresses directly,
-- as an alternative to joining through project_permits.
-- We do this with ALTER TABLE ADD COLUMN (D1 supports it).
ALTER TABLE permits ADD COLUMN address_id INTEGER REFERENCES addresses(id);
CREATE INDEX IF NOT EXISTS idx_permits_address_id ON permits(address_id);
