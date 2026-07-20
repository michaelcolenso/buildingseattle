# BuildingSeattle Data Dictionary

## Column Reference

Every column, its type, what it means, and a real example from the dataset.

| # | Column | Type | Coverage | Description | Example |
|---|--------|------|----------|-------------|---------|
| 1 | `permit_number` | string | 100% | Unique SDCI permit identifier | `7137849-CN` |
| 2 | `address` | string | 100% | Full street address | `2972 S GRAHAM ST, SEATTLE, WA` |
| 3 | `neighborhood` | string | 100% | Seattle neighborhood | `Hillman City` |
| 4 | `type` | string | 100% | Permit classification | `residential`, `commercial`, `industrial` |
| 5 | `value` | integer | 99% | Estimated project cost (USD) | `601717` |
| 6 | `status` | string | 100% | Current permit status | `active`, `new`, `completed`, `pending`, `expired` |
| 7 | `description` | string | 100% | Short SDCI project description | "Construct new one-family dwelling, per plan" |
| 8 | `detailed_description` | text | 84% | Full detail page description (enriched) | "Liu 2nd New Dwelling House Establish use as housing..." |
| 9 | `applied_date` | date | 100% | Application submission date | `2026-05-05` |
| 10 | `issued_date` | date | 79% | Date permit was issued | `2026-07-02` |
| 11 | `completed_date` | date | 34% | Date project completed (if done) | `2026-08-15` |
| 12 | `expires_date` | date | 75% | Date permit expires | `2027-07-02` |
| 13 | `plan_review_complete_date` | date | 16% | Date plan review completed | `2026-07-01` |
| 14 | `ready_to_issue_date` | date | 26% | Date permit ready for issuance | `2026-06-30` |
| 15 | `contractor_name` | string | 55% | Registered contractor company | `Mountain West Development Inc` |
| 16 | `contractor_specialty` | string | 55% | Contractor specialty | `General Contractor` |
| 17 | `contractor_license` | string | 59% | WA LNI license number | `MOUNTWD774CA` |
| 18 | `housing_units` | integer | 100% | Net housing units for this permit | `1` |
| 19 | `housing_units_added` | integer | 23% | Housing units added by project | `1` |
| 20 | `housing_units_removed` | integer | 23% | Housing units removed | `0` |
| 21 | `housing_category` | string | 23% | Housing type classification | `Single-Family Add/Alt` |
| 22 | `review_level` | string | 84% | SDCI review level (enriched) | `Full +`, `Full C`, `Full`, `Field` |
| 23 | `primary_property_use` | string | 84% | Property use classification (enriched) | `Single Family/Duplex`, `Multifamily` |
| 24 | `work_performed_by` | string | 80% | Who performs work | `Licensed Contractor`, `Owner/Lessee` |
| 25 | `parcel_number` | string | 84% | King County parcel number (enriched) | `DV1137945` |
| 26 | `number_review_cycles` | integer | 42% | Times through plan review | `4` |
| 27 | `total_days_plan_review` | integer | 18% | Total days in plan review | `57` |
| 28 | `days_out_corrections` | integer | 42% | Days out for corrections | `1` |
| 29 | `has_required_inspections` | boolean | 100% | Inspections required? | `1` (yes) / `0` (no) |
| 30 | `has_completed_inspections` | boolean | 100% | Inspections completed? | `1` (yes) / `0` (no) |
| 31 | `permit_detail_url` | url | 84% | Direct link to SDCI detail page | `https://services.seattle.gov/portal/...altId=7142260-CN` |
| 32 | `record_status_detail` | string | 84% | SDCI status detail text | `Reviews In Process` |

<!-- BEGIN GENERATED:STATS -->
## Status Values

| Status | Description | Count |
|--------|-------------|-------|
| `active` | Under active review or construction | 5,752 |
| `completed` | Work completed, permit closed | 5,227 |
| `new` | Application submitted, not yet in review | 1,919 |
| `pending` | Application pending processing | 457 |
| `expired` | Permit expired before completion | 268 |

## Permit Types

| Type | Description | Count |
|------|-------------|-------|
| `residential` | Single-family, multifamily, ADU/DADU | 10,503 |
| `commercial` | Office, retail, industrial, institutional | 2,898 |
| `industrial` | Manufacturing, warehouse | 177 |
| `land` | Vacant land, land use only | 45 |
<!-- END GENERATED:STATS -->

## Data Source & Methodology

1. **Base data**: Seattle Open Data Portal (data.seattle.gov) — permit numbers, addresses, dates, values, contractor names
2. **Enrichment**: SDCI detail page scraping (services.seattle.gov/portal) — detailed descriptions, parcel numbers, review levels, property use, work performer, record status

Enrichment coverage: 84% of records have parcel numbers, review levels, primary property use, and detailed descriptions. Contractor license data covers 55-59% of records (contractors without WA LNI registration are blank). Timeline and housing breakdown fields are present for records where the city published them.

<!-- BEGIN GENERATED:VERSION -->
## Version

- Version: 2026-07
- Export date: July 19, 2026
- Records: 13,623
- Columns: 32
- Total construction value: $12.03 billion
<!-- END GENERATED:VERSION -->
