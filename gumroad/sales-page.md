<!--
PRICING DECISION (2026-07-19)
- Launch at Foundation $49 / Pro $89 (Pro raised from the $79 draft).
- Rationale: 2026 comparables — Permit Ledger $39/mo, PermitStack $29–499/mo,
  PermitGrab $149/mo, Shovels ~$300+/mo, Construction Monitor $200–800/mo;
  niche one-time CSVs on Gumroad commonly $150–199. $49/$89 one-time is
  conservative and still under one month of any incumbent.
- Pro anchor justified by: refresh script + contractors CSV + free monthly
  update files pushed via Gumroad buyer notifications.
- Launch promo: coupon SEATTLE20 (20% off, first 2 weeks) instead of a lower
  list price — preserves the anchor. Revisit after 10 sales: test Foundation $69.
- Net after Gumroad fees (10% + $0.50 + ~2.9% + $0.30): ~$42.60 on $49, ~$78 on $89.
-->

# Seattle Construction Permit Intelligence Dataset

**Every building permit in Seattle. Cleaned, structured, and enriched. $49.**

---

### What's actually being built in your backyard — before your competitors find out

BuildingSeattle tracks every single construction permit filed with the City of Seattle. That's **13,623 projects**, **$12.03 billion** in construction value, across **53 neighborhoods** and **2,077 contractors** — delivered as a single CSV file you can open in Excel, Google Sheets, or drop straight into your analysis stack.

The City publishes this data piecemeal through a clunky government portal. We scraped it, cleaned it, deduplicated it, and enriched every record with data from the SDCI detail pages — parcel numbers, review levels, full descriptions, and contractor license information. You get the structured result — no scraping, no cleaning, no wasted weekends.

---

### Here's What's Inside

| Category | Example Field | Example Value |
|----------|---------------|---------------|
| **Project** | type | `residential` |
| | value | `$601,717` |
| | status | `active` |
| | description | "Construct new one-family dwelling, per plan" |
| **Location** | address | `2972 S GRAHAM ST, SEATTLE, WA` |
| | neighborhood | `Hillman City` |
| | parcel_number | `DV1137945` |
| **Contractor** | contractor_name | `Mountain West Development Inc` |
| | contractor_license | `MOUNTWD774CA` |
| | contractor_specialty | `General Contractor` |
| **Timeline** | applied_date | `2026-05-05` |
| | issued_date | `2026-07-02` |
| | plan_review_complete_date | `2026-07-01` |
| **Review** | review_level | `Full +` |
| | number_review_cycles | `4` |
| | total_days_plan_review | `57` |
| **Housing** | housing_units | `1` |
| | housing_units_added | `1` |

That's 32 columns on every record. A full data dictionary is included with the download.

---

### Who Buys This

| Customer | Why They Buy |
|----------|-------------|
| **Building material suppliers** | Find active job sites in your delivery radius before you see the dumpster arrive |
| **General contractors** | See who's winning bids. Find subs. Track competitor activity. |
| **Real estate developers** | Size the construction pipeline by neighborhood. Find infill opportunities. |
| **Insurance underwriters** | License status, project values, and contractor info — all in one CSV |
| **Data journalists** | $12.03B in construction activity with verifiable source links |
| **Market researchers** | Permit processing times by neighborhood. Housing unit trends. Contractor performance. |

---

### Why This Beats the Public Data Portal

| Feature | Seattle Open Data Portal | This Dataset |
|---------|--------------------------|--------------|
| Contractor license info | ❌ | ✅ License number + specialty |
| Parcel numbers | ❌ | ✅ 84% coverage |
| Detailed descriptions | Partial | ✅ Full SDCI detail text |
| Review levels | ❌ | ✅ Full +, Full C, Field, etc. |
| Ready to use | ❌ Requires API wrangling | ✅ CSV opens in Excel |
| Data refresh | You figure it out | ✅ Python script included (Pro) |

---

### Two Options

#### Foundation — $49
- 13,623 records, 32 columns, cleaned CSV
- Data dictionary
- 100-record sample (free)

#### Pro — $89
- Everything in Foundation
- **Python refresh script** — pull fresh data whenever you want
- **Contractor-only CSV** — 2,077 contractors with license numbers, specialties, permit counts, and total project values
- **30-day refresh guarantee** — email us for an updated pull, free

**Every buyer gets free monthly updates.** We refresh the dataset on the first business day of each month (~500 new permits/month) and push the new files to your Gumroad library — you'll get an email each time.

---

### Try Before You Buy

⚠️ **Download the free sample first.** 100 enriched records, same columns, real data. If it doesn't have what you need, don't buy the full version.

[ *Gumroad download button for sample* ]

---

### Our Guarantee

We don't think you should pay for data that isn't useful. If you buy the full dataset and it doesn't deliver what you need, email us within 14 days for a full refund. No questions, no hoops, no fine print.

The risk is entirely ours. You literally cannot lose.

---

### Quick Facts

| | |
|---|---|
| Records | 13,623 |
| Columns | 32 |
| File size | ~7.6 MB |
| Format | CSV (UTF-8) |
| Last updated | July 19, 2026 |
| Source | Seattle SDCI (services.seattle.gov/portal) |
| Neighborhoods | 53 |
| Total value | $12.03 billion |

---

### FAQ

**Is this the same data as buildingseattle.com?**
Yes. Same database, exported on July 19th. The site shows live data — this is a snapshot for offline analysis.

**Can I resell or redistribute this?**
The data is from public government sources. The cleaning and enrichment is our work. You can use it for analysis, commercial purposes, or internal use. Redistributing the raw dataset as a competing product is not permitted.

**What software do I need?**
Excel, Google Sheets, Python, R — anything that reads CSV. No special software.

**How does the refresh script work?**
The Pro tier includes a Python script that pulls fresh data and exports an updated CSV. Requires Python 3.10+. Uses only the Python standard library — no extra installs needed.

---

Get the complete picture of Seattle's construction pipeline. One CSV, $49.

[ *Buy now on Gumroad* ]
