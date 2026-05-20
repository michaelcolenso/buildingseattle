ALTER TABLE contractors ADD COLUMN license_status TEXT;
ALTER TABLE contractors ADD COLUMN ubi TEXT;
ALTER TABLE contractors ADD COLUMN insurance_amount INTEGER;
ALTER TABLE contractors ADD COLUMN insurance_expires_date DATE;

ALTER TABLE permits ADD COLUMN housing_units_added INTEGER;
ALTER TABLE permits ADD COLUMN housing_units_removed INTEGER;
ALTER TABLE permits ADD COLUMN housing_units_existing INTEGER;
ALTER TABLE permits ADD COLUMN sleeping_rooms INTEGER;
ALTER TABLE permits ADD COLUMN expires_date DATE;
ALTER TABLE permits ADD COLUMN permit_detail_url TEXT;
ALTER TABLE permits ADD COLUMN contractor_license TEXT;
ALTER TABLE permits ADD COLUMN contractor_source TEXT;
ALTER TABLE permits ADD COLUMN work_performed_by TEXT;
ALTER TABLE permits ADD COLUMN review_level TEXT;
ALTER TABLE permits ADD COLUMN primary_property_use TEXT;
ALTER TABLE permits ADD COLUMN parcel_number TEXT;
ALTER TABLE permits ADD COLUMN detailed_description TEXT;
ALTER TABLE permits ADD COLUMN record_status_detail TEXT;
ALTER TABLE permits ADD COLUMN has_required_inspections INTEGER DEFAULT 0;
ALTER TABLE permits ADD COLUMN has_completed_inspections INTEGER DEFAULT 0;
ALTER TABLE permits ADD COLUMN last_enriched_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_contractors_license_number ON contractors(license_number);
CREATE INDEX IF NOT EXISTS idx_permits_contractor_license ON permits(contractor_license);
CREATE INDEX IF NOT EXISTS idx_permits_last_enriched_at ON permits(last_enriched_at);
