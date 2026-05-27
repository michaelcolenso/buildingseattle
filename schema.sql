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
    license_status TEXT,
    ubi TEXT,
    insurance_amount INTEGER,
    insurance_expires_date DATE,
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
    housing_units_added INTEGER,
    housing_units_removed INTEGER,
    housing_units_existing INTEGER,
    sleeping_rooms INTEGER,
    applied_date DATE,
    issued_date DATE,
    expires_date DATE,
    completed_date DATE,
    permit_detail_url TEXT,
    contractor_license TEXT,
    contractor_source TEXT,
    work_performed_by TEXT,
    review_level TEXT,
    primary_property_use TEXT,
    parcel_number TEXT,
    detailed_description TEXT,
    record_status_detail TEXT,
    zoning TEXT,
    housing_category TEXT,
    dwelling_unit_type TEXT,
    parent_permit_number TEXT,
    related_mup TEXT,
    number_review_cycles INTEGER,
    total_days_plan_review INTEGER,
    days_out_corrections INTEGER,
    has_required_inspections INTEGER DEFAULT 0,
    has_completed_inspections INTEGER DEFAULT 0,
    last_enriched_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contractor_id) REFERENCES contractors(id)
);

CREATE TABLE IF NOT EXISTS permit_status_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    permit_number TEXT NOT NULL,
    previous_status TEXT,
    new_status TEXT NOT NULL,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contractors_slug ON contractors(slug);
CREATE INDEX IF NOT EXISTS idx_contractors_specialty ON contractors(specialty);
CREATE INDEX IF NOT EXISTS idx_contractors_license_number ON contractors(license_number);
CREATE INDEX IF NOT EXISTS idx_permits_neighborhood ON permits(neighborhood);
CREATE INDEX IF NOT EXISTS idx_permits_zoning ON permits(zoning);
CREATE INDEX IF NOT EXISTS idx_permits_parent_permit_number ON permits(parent_permit_number);
CREATE INDEX IF NOT EXISTS idx_permits_status ON permits(status);
CREATE INDEX IF NOT EXISTS idx_permits_contractor_license ON permits(contractor_license);
CREATE INDEX IF NOT EXISTS idx_permits_last_enriched_at ON permits(last_enriched_at);
CREATE INDEX IF NOT EXISTS idx_permit_status_changes_changed_at ON permit_status_changes(changed_at);
CREATE INDEX IF NOT EXISTS idx_permit_status_changes_permit_number ON permit_status_changes(permit_number);
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
