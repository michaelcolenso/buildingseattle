ALTER TABLE permits ADD COLUMN zoning TEXT;
ALTER TABLE permits ADD COLUMN housing_category TEXT;
ALTER TABLE permits ADD COLUMN dwelling_unit_type TEXT;
ALTER TABLE permits ADD COLUMN parent_permit_number TEXT;
ALTER TABLE permits ADD COLUMN related_mup TEXT;
ALTER TABLE permits ADD COLUMN number_review_cycles INTEGER;
ALTER TABLE permits ADD COLUMN total_days_plan_review INTEGER;
ALTER TABLE permits ADD COLUMN days_out_corrections INTEGER;

CREATE INDEX IF NOT EXISTS idx_permits_zoning ON permits(zoning);
CREATE INDEX IF NOT EXISTS idx_permits_parent_permit_number ON permits(parent_permit_number);
