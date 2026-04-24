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
    avg_permit_days INTEGER,
    avg_build_days INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS permits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    permit_number TEXT UNIQUE,
    contractor_id INTEGER,
    owner_name TEXT,
    owner_address TEXT,
    applicant_name TEXT,
    architect_name TEXT,
    address TEXT NOT NULL,
    neighborhood TEXT,
    type TEXT,
    value INTEGER,
    status TEXT,
    description TEXT,
    housing_units INTEGER DEFAULT 0,
    applied_date DATE,
    issued_date DATE,
    completed_date DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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

INSERT OR IGNORE INTO contractors (name, slug, specialty, description, license_number, years_active, active_projects) VALUES ('Seattle Construction Group', 'seattle-construction-group', 'General Contractor', 'Full-service commercial construction serving Greater Seattle since 2008.', 'CONTRACT1234', 16, 12);
INSERT OR IGNORE INTO contractors (name, slug, specialty, description, license_number, years_active, active_projects) VALUES ('Pacific Northwest Builders', 'pacific-northwest-builders', 'Residential Development', 'Specializing in multi-family residential and mixed-use developments.', 'CONTRACT5678', 12, 8);
INSERT OR IGNORE INTO contractors (name, slug, specialty, description, license_number, years_active, active_projects) VALUES ('Emerald City Contractors', 'emerald-city-contractors', 'Industrial Construction', 'Warehouse and manufacturing facility specialists.', 'CONTRACT9012', 20, 5);
INSERT OR IGNORE INTO permits (permit_number, contractor_id, address, neighborhood, type, value, status, issued_date) VALUES ('PERM2024001', 1, '407 Stewart St, Seattle, WA', 'Downtown', 'commercial', 62000000, 'active', '2026-03-10');
INSERT OR IGNORE INTO permits (permit_number, contractor_id, address, neighborhood, type, value, status, issued_date) VALUES ('PERM2024002', 2, '23rd & Union, Seattle, WA', 'Central District', 'residential', 15000000, 'approved', '2026-03-08');
INSERT OR IGNORE INTO permits (permit_number, contractor_id, address, neighborhood, type, value, status, issued_date) VALUES ('PERM2024003', 1, 'Ballard Warehouse District', 'Ballard', 'industrial', 8000000, 'active', '2026-03-05');

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
