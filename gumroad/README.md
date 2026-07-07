# Seattle Construction Permit Intelligence Dataset

## What You Get

**13,379 building permits** — every construction project in Seattle, scraped from the city's SDCI portal and enriched with parcel numbers, review levels, detailed descriptions, and contractor license data.

This is the dataset powering [buildingseattle.com](https://buildingseattle.com), exported as a ready-to-use CSV.

---

## Product Tier: Foundation ($49)

A single CSV file with **13,379 records** and **32 columns** covering:

| Category | Fields |
|----------|--------|
| **Project** | permit_number, type, value, status, description, detailed_description |
| **Location** | address, neighborhood, parcel_number |
| **Dates** | applied_date, issued_date, completed_date, expires_date, plan_review_complete_date, ready_to_issue_date |
| **Contractor** | contractor_name, contractor_license, contractor_specialty, work_performed_by |
| **Review** | review_level, number_review_cycles, total_days_plan_review, days_out_corrections |
| **Housing** | housing_units, housing_units_added, housing_units_removed, housing_category |
| **Inspections** | has_required_inspections, has_completed_inspections |
| **Links** | permit_detail_url (direct link to SDCI detail page), record_status_detail |

A full data dictionary (`data-dictionary.md`) is included with every column documented.

---

## Product Tier: Pro ($79)

Everything in Foundation, plus:

- **Python refresh script** (`refresh.py`) — pull fresh data from the source whenever you need it
- **Contractor-only CSV** — 2,072 contractors with license numbers, specialties, permit counts, and total project values
- **30-day data refresh guarantee** — email us within 30 days and we'll send you the latest pull for free

---

## Who This Is For

**Material suppliers** — Identify active job sites by neighborhood before your competitors knock on the door.

**General contractors** — See who's winning bids, what's being built, and which subs are active.

**Real estate developers** — Size the construction pipeline in any Seattle neighborhood.

**Insurance underwriters** — Contractor license numbers, project values, and permit statuses in one place.

**Data journalists** — $11.78 billion in construction activity with a full paper trail to the source.

**Researchers** — Housing unit trends, permit processing times, and contractor performance metrics.

---

## Data Freshness

Updated from the Seattle SDCI portal as of **July 5, 2026**. The included Python refresh script pulls fresh data on demand.

---

## Coverage

| Metric | Count |
|--------|-------|
| Total permits | 13,379 |
| Active permits | 5,632 |
| Completed permits | 5,156 |
| Residential | 10,314 |
| Commercial | 2,848 |
| Industrial | 172 |
| Neighborhoods | 53 |
| Contractors | 2,072 |
| Total construction value | **$11.78 billion** |

---

## Guarantee

**The "You Can't Lose" Guarantee:** Download the sample first (100 records, free). If the full dataset doesn't have what you need, don't buy it. If you buy it and it's not useful, we'll refund you within 14 days, no questions asked.

---

## FAQ

**Q: Where does the data come from?**
A: The Seattle SDCI (Seattle Department of Construction & Inspections) public portal at services.seattle.gov/portal. We scrape and structure it. The original source is public — we do the cleaning, deduplication, and enrichment.

**Q: Is this the same data as buildingseattle.com?**
A: Yes. This is a direct export of the same database powering that site. The site shows the latest data; this CSV is an export as of July 5, 2026.

**Q: How is this different from the Seattle Open Data Portal?**
A: The open data portal doesn't include contractor license details, parcel numbers, detailed descriptions, review levels, or permit status changes. Our enrichment pipeline adds all of that.

**Q: Can I get ongoing updates?**
A: Yes — the Pro tier includes a Python refresh script and a 30-day free refresh. For ongoing subscriptions, contact us.

**Q: What format is it in?**
A: Standard UTF-8 CSV. Opens in Excel, Google Sheets, Python (pandas), R, or any CSV reader.

**Q: Is there a sample?**
A: Yes — a 100-record sample is available for free. Same 32 columns, real enriched data.
