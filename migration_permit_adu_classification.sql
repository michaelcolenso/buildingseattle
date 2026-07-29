ALTER TABLE permits
ADD COLUMN adu_type TEXT
CHECK (adu_type IN ('ADU', 'DADU') OR adu_type IS NULL);

ALTER TABLE permits
ADD COLUMN adu_classification_version INTEGER NOT NULL DEFAULT 0;

WITH normalized AS (
  SELECT id,
         lower(
           replace(replace(replace(replace(replace(
             replace(replace(replace(replace(replace(
             replace(replace(replace(replace(replace(
             COALESCE(detailed_description, '') || ' ' ||
             COALESCE(description, '') || ' ' ||
             COALESCE(primary_property_use, '') || ' ' ||
             COALESCE(dwelling_unit_type, ''),
             '#', ' '), '+', ' '), '&', ' '), ':', ' '), ';', ' '),
             '/', ' '), '-', ' '), ',', ' '), '.', ' '), '(', ' '),
             ')', ' '), '[', ' '), ']', ' '), '?', ' '), '"', ' ')
         ) AS adu_search_text
  FROM permits
),
classified AS (
  SELECT id,
         CASE
           WHEN instr(' ' || adu_search_text || ' ', ' dadu ') > 0
             OR instr(' ' || adu_search_text || ' ', ' dadus ') > 0
             OR (' ' || adu_search_text || ' ') GLOB '* dadu[0-9]*'
             OR adu_search_text LIKE '%detached%accessory dwelling%'
             OR (' ' || adu_search_text || ' ') LIKE '%detached% adu %'
             OR (' ' || adu_search_text || ' ') LIKE '%detached% adus %'
             OR (' ' || adu_search_text || ' ') GLOB '*detached* adu[0-9]*'
             OR adu_search_text LIKE '%backyard cottage%'
           THEN 'DADU'
           WHEN instr(' ' || adu_search_text || ' ', ' aadu ') > 0
             OR instr(' ' || adu_search_text || ' ', ' aadus ') > 0
             OR (' ' || adu_search_text || ' ') GLOB '* aadu[0-9]*'
             OR instr(' ' || adu_search_text || ' ', ' adu ') > 0
             OR instr(' ' || adu_search_text || ' ', ' adus ') > 0
             OR (' ' || adu_search_text || ' ') GLOB '* adu[0-9]*'
             OR adu_search_text LIKE '%accessory dwelling%'
           THEN 'ADU'
           ELSE NULL
         END AS adu_type
  FROM normalized
)
UPDATE permits
SET adu_type = (
      SELECT classified.adu_type
      FROM classified
      WHERE classified.id = permits.id
    ),
    adu_classification_version = 2
WHERE id IN (SELECT id FROM classified);

CREATE INDEX IF NOT EXISTS idx_permits_adu_type_activity
ON permits(adu_type, issued_date, applied_date);

CREATE INDEX IF NOT EXISTS idx_permits_adu_type_neighborhood
ON permits(adu_type, neighborhood);
