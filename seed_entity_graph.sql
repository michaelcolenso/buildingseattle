-- Entity Graph Seed Script
-- Populates addresses, people_orgs, neighborhoods, and projects from existing
-- permits and contractors data.
--
-- Run AFTER migration_entity_graph.sql:
--   npx wrangler d1 execute buildingseattle --remote --file migration_entity_graph.sql
--   npx wrangler d1 execute buildingseattle --remote --file seed_entity_graph.sql

-- === Seed Normalized addresses ===
-- Slug: lowercase, strip punctuation, normalize whitespace, add -seattle-wa suffix
INSERT OR IGNORE INTO addresses (slug, normalized_address, display_address, city, state)
SELECT DISTINCT
    LOWER(
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
            TRIM(p.address),
        '.', ''), ',', ''), '#', ''), '  ', ' '), ' ', '-')
    ) || '-seattle-wa' AS slug,
    LOWER(TRIM(p.address)) AS normalized_address,
    TRIM(p.address) AS display_address,
    'Seattle' AS city,
    'WA' AS state
FROM permits p
WHERE p.address IS NOT NULL AND TRIM(p.address) != '';

-- === Backfill permits.address_id ===
UPDATE permits
SET address_id = (
    SELECT a.id FROM addresses a
    WHERE a.normalized_address = LOWER(TRIM(permits.address))
)
WHERE address IS NOT NULL AND TRIM(address) != '';

-- === Seed people_orgs from permits ===
-- Extract unique names from owner_name, applicant_name, architect_name
INSERT OR IGNORE INTO people_orgs (slug, name, normalized_name, type_guess)
SELECT DISTINCT
    LOWER(REPLACE(REPLACE(REPLACE(TRIM(t.name), '.', ''), ',', ''), ' ', '-')) || '-seattle' AS slug,
    TRIM(t.name) AS name,
    LOWER(TRIM(t.name)) AS normalized_name,
    t.role AS type_guess
FROM (
    SELECT DISTINCT owner_name AS name, 'owner' AS role FROM permits WHERE owner_name IS NOT NULL AND TRIM(owner_name) != ''
    UNION
    SELECT DISTINCT applicant_name AS name, 'applicant' AS role FROM permits WHERE applicant_name IS NOT NULL AND TRIM(applicant_name) != ''
    UNION
    SELECT DISTINCT architect_name AS name, 'architect' AS role FROM permits WHERE architect_name IS NOT NULL AND TRIM(architect_name) != ''
    UNION
    SELECT DISTINCT name AS name, 'contractor' AS role FROM contractors WHERE name IS NOT NULL AND TRIM(name) != ''
) t
WHERE LENGTH(TRIM(t.name)) > 1;

-- === Seed permit_participants ===
-- Link permits to people_orgs by role
INSERT OR IGNORE INTO permit_participants (permit_id, people_org_id, role)
SELECT p.id, po.id, 'owner'
FROM permits p
JOIN people_orgs po ON LOWER(TRIM(p.owner_name)) = po.normalized_name
WHERE p.owner_name IS NOT NULL AND TRIM(p.owner_name) != '';

INSERT OR IGNORE INTO permit_participants (permit_id, people_org_id, role)
SELECT p.id, po.id, 'applicant'
FROM permits p
JOIN people_orgs po ON LOWER(TRIM(p.applicant_name)) = po.normalized_name
WHERE p.applicant_name IS NOT NULL AND TRIM(p.applicant_name) != '';

INSERT OR IGNORE INTO permit_participants (permit_id, people_org_id, role)
SELECT p.id, po.id, 'architect'
FROM permits p
JOIN people_orgs po ON LOWER(TRIM(p.architect_name)) = po.normalized_name
WHERE p.architect_name IS NOT NULL AND TRIM(p.architect_name) != '';

-- Link permits to contractors via the existing contractor_id FK
INSERT OR IGNORE INTO permit_participants (permit_id, people_org_id, role)
SELECT p.id, po.id, 'contractor'
FROM permits p
JOIN contractors c ON p.contractor_id = c.id
JOIN people_orgs po ON LOWER(TRIM(c.name)) = po.normalized_name
WHERE p.contractor_id IS NOT NULL;

-- === Seed neighborhoods ===
INSERT OR IGNORE INTO neighborhoods (slug, name)
SELECT DISTINCT
    LOWER(REPLACE(TRIM(p.neighborhood), ' ', '-')) AS slug,
    TRIM(p.neighborhood) AS name
FROM permits p
WHERE p.neighborhood IS NOT NULL AND TRIM(p.neighborhood) != ''
  AND LOWER(TRIM(p.neighborhood)) != 'other';

-- === Seed address_neighborhoods ===
INSERT OR IGNORE INTO address_neighborhoods (address_id, neighborhood_id)
SELECT DISTINCT a.id, n.id
FROM permits p
JOIN addresses a ON a.normalized_address = LOWER(TRIM(p.address))
JOIN neighborhoods n ON n.name = TRIM(p.neighborhood)
WHERE p.neighborhood IS NOT NULL AND TRIM(p.neighborhood) != ''
  AND LOWER(TRIM(p.neighborhood)) != 'other';

-- === Seed projects (simple: one "Construction activity at [address]" per address) ===
INSERT OR IGNORE INTO projects (slug, address_id, name, description_summary, confidence_score, first_seen_date, latest_activity_date, total_estimated_value)
SELECT
    a.slug || '-project' AS slug,
    a.id AS address_id,
    'Construction activity at ' || a.display_address AS name,
    'Aggregated construction permits for ' || a.display_address AS description_summary,
    50 AS confidence_score,
    MIN(p.applied_date) AS first_seen_date,
    MAX(COALESCE(p.completed_date, p.issued_date, p.applied_date)) AS latest_activity_date,
    COALESCE(SUM(p.value), 0) AS total_estimated_value
FROM addresses a
JOIN permits p ON p.address_id = a.id
GROUP BY a.id
HAVING COUNT(p.id) > 0;

-- === Seed project_permits ===
INSERT OR IGNORE INTO project_permits (project_id, permit_id)
SELECT pr.id, p.id
FROM projects pr
JOIN addresses a ON pr.address_id = a.id
JOIN permits p ON p.address_id = a.id;

-- === Seed project_participants (aggregate from permit_participants) ===
INSERT OR IGNORE INTO project_participants (project_id, people_org_id, role)
SELECT DISTINCT pp.project_id, pp_inner.people_org_id, pp_inner.role
FROM project_permits pp
JOIN permit_participants pp_inner ON pp.permit_id = pp_inner.permit_id;
