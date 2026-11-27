-- Current SDCI development-site context; IDs are not King County tax PINs.
CREATE TABLE IF NOT EXISTS development_sites (
    site_id TEXT PRIMARY KEY NOT NULL CHECK (site_id = UPPER(TRIM(site_id)) AND length(site_id) BETWEEN 1 AND 20),
    status TEXT,
    lot_sqft INTEGER CHECK (lot_sqft IS NULL OR lot_sqft > 0),
    boundary_geojson TEXT CHECK (boundary_geojson IS NULL OR json_valid(boundary_geojson)),
    source_updated_at TEXT,
    fetched_at TEXT NOT NULL
);
