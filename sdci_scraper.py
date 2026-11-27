#!/usr/bin/env python3
# sdci_scraper.py - Fetches real Seattle permit data from Seattle Open Data Portal

import argparse
import asyncio
import httpx
from datetime import datetime
import json

# Status and neighborhood mappings are shared with worker.js through
# data/sdci_mappings.json (see sdci_mappings.py); edit them there, not here.
from sdci_mappings import (  # noqa: E402,F401  (NEIGHBORHOOD_BOUNDS re-exported)
    NEIGHBORHOOD_BOUNDS,
    detect_neighborhood,
    map_status,
    raw_statuses_for,
)


def classify_permit_type(permitclass, permittypemapped):
    """Classify permit type using permitclass (primary) and permittypemapped (fallback)."""
    if permitclass:
        pc = permitclass.lower()
        if pc in ("commercial", "institutional"):
            return "commercial"
        elif pc in ("single family/duplex", "multifamily"):
            return "residential"
        elif pc == "industrial":
            return "industrial"
        elif pc == "vacant land":
            return "land"

    # Fallback to permittypemapped
    if permittypemapped:
        pt = permittypemapped.lower()
        if "demolition" in pt:
            return "demolition"
        if "grading" in pt:
            return "grading"
        if "roof" in pt:
            return "residential"

    return "other"


def extract_value(cost_str):
    """Extract project cost as integer."""
    if not cost_str:
        return 0
    try:
        val = str(cost_str).replace("$", "").replace(",", "").replace(" ", "")
        return int(float(val))
    except (ValueError, TypeError):
        return 0


def extract_int(raw):
    """Extract an optional integer, returning None when absent or unparseable."""
    if raw is None or raw == "":
        return None
    try:
        return int(float(str(raw).replace(",", "").strip()))
    except (ValueError, TypeError):
        return None


def clean_str(raw):
    """Normalize an optional string field, treating placeholders as empty."""
    if raw is None:
        return ""
    text = str(raw).strip()
    if text.lower() in ("n/a", "none", "null"):
        return ""
    return text


def extract_date(date_str):
    """Extract date in YYYY-MM-DD format."""
    if not date_str:
        return None

    if "T" in str(date_str):
        return date_str.split("T")[0]

    try:
        dt = datetime.strptime(str(date_str)[:10], "%Y-%m-%d")
        return dt.strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return None


def slugify(name):
    """Convert a company name to a URL-friendly slug."""
    import re
    slug = name.lower().strip()
    slug = re.sub(r'[^a-z0-9\s-]', '', slug)
    slug = re.sub(r'[\s-]+', '-', slug)
    return slug.strip('-')


def build_status_filter(status):
    """Build a SODA $where fragment selecting the raw SDCI statuses of one stored status."""
    if not status:
        return None
    s = status.lower().strip()
    if s == "new":
        return "(statuscurrent IS NULL OR statuscurrent = '' OR upper(statuscurrent) IN ({}))".format(
            ", ".join("'{}'".format(v.upper().replace("'", "''")) for v in raw_statuses_for("new"))
        )
    values = raw_statuses_for(s)
    if not values:
        return None
    return "upper(statuscurrent) IN ({})".format(
        ", ".join("'{}'".format(v.upper().replace("'", "''")) for v in values)
    )


async def fetch_seattle_permits(total=5000, page_size=1000, status_filter=None):
    """Fetch permits from Seattle Open Data Portal with pagination."""

    url = "https://data.seattle.gov/resource/k44w-2dcq.json"

    select_fields = ",".join([
        "permitnum", "permitclass", "permitclassmapped", "permittypemapped",
        "permittypedesc", "description", "housingunits", "statuscurrent",
        "originaladdress1", "originalcity", "originalstate", "originalzip",
        "contractorcompanyname", "link",
        "latitude", "longitude",
        "applieddate", "issueddate", "expiresdate", "completeddate",
        "estprojectcost", "readytoissuedate", "planreviewcompletedate",
        "zoning", "housingcategory", "dwellingunittype",
        "parentpermitnum", "relatedmup",
        "numberreviewcycles", "totaldaysplanreview", "daysoutcorrections",
        "housingunitsadded", "housingunitsremoved",
        ":updated_at",
    ])

    headers = {
        "Accept": "application/json",
        "User-Agent": "BuildingSeattle-Scraper/2.0",
    }

    where_clause = "applieddate > '2022-01-01'"
    status_where = build_status_filter(status_filter)
    if status_where:
        where_clause += f" AND {status_where}"

    all_data = []
    async with httpx.AsyncClient() as client:
        offset = 0
        while offset < total:
            batch_size = min(page_size, total - offset)
            params = {
                "$select": select_fields,
                "$limit": batch_size,
                "$offset": offset,
                "$order": "applieddate DESC, permitnum",
                "$where": where_clause,
            }

            print(f"Fetching records {offset+1}-{offset+batch_size}...")
            response = await client.get(url, params=params, headers=headers, timeout=60.0)

            if response.status_code != 200:
                print(f"Error at offset {offset}: {response.text[:300]}")
                break

            data = response.json()
            if not data:
                print(f"No more records at offset {offset}")
                break

            all_data.extend(data)
            print(f"  Got {len(data)} records (total: {len(all_data)})")

            if len(data) < batch_size:
                break  # No more pages

            offset += batch_size

    print(f"\nRetrieved {len(all_data)} total raw records")

    if not all_data:
        return [], {}

    permits = []
    contractors = {}  # slug -> contractor dict

    for idx, item in enumerate(all_data):
        try:
            # Build full address
            address_parts = [
                item.get("originaladdress1", ""),
                item.get("originalcity", "Seattle"),
                item.get("originalstate", "WA"),
            ]
            address = ", ".join(filter(None, address_parts))

            # Neighborhood from coordinates
            neighborhood = detect_neighborhood(
                item.get("latitude"), item.get("longitude")
            )

            # Type from permitclass
            permit_type = classify_permit_type(
                item.get("permitclass"), item.get("permittypemapped")
            )

            # Extract contractor
            contractor_name = (item.get("contractorcompanyname") or "").strip()
            if contractor_name and contractor_name.lower() not in ("n/a", "none", ""):
                slug = slugify(contractor_name)
                if slug and slug not in contractors:
                    contractors[slug] = {
                        "name": contractor_name,
                        "slug": slug,
                        "specialty": item.get("permitclass", "General"),
                    }

            permit = {
                "permit_number": item.get("permitnum"),
                "address": address,
                "neighborhood": neighborhood,
                "type": permit_type,
                "value": extract_value(item.get("estprojectcost")),
                "status": map_status(item.get("statuscurrent")),
                "status_raw": clean_str(item.get("statuscurrent")) or None,
                "source_updated_at": item.get(":updated_at"),
                "description": item.get("description", "No description"),
                "applied_date": extract_date(item.get("applieddate")),
                "issued_date": extract_date(item.get("issueddate")),
                "completed_date": extract_date(item.get("completeddate")),
                "housing_units": item.get("housingunits", 0),
                "housing_units_added": extract_int(item.get("housingunitsadded")),
                "housing_units_removed": extract_int(item.get("housingunitsremoved")),
                "housing_category": clean_str(item.get("housingcategory")),
                "dwelling_unit_type": clean_str(item.get("dwellingunittype")),
                "zoning": clean_str(item.get("zoning")),
                "parent_permit_number": clean_str(item.get("parentpermitnum")),
                "related_mup": clean_str(item.get("relatedmup")),
                "number_review_cycles": extract_int(item.get("numberreviewcycles")),
                "total_days_plan_review": extract_int(item.get("totaldaysplanreview")),
                "days_out_corrections": extract_int(item.get("daysoutcorrections")),
                "plan_review_complete_date": extract_date(item.get("planreviewcompletedate")),
                "ready_to_issue_date": extract_date(item.get("readytoissuedate")),
                "permit_class": item.get("permitclass", ""),
                "permit_type_detail": item.get("permittypemapped", ""),
                "zip_code": item.get("originalzip", ""),
                "zip": item.get("originalzip") or None,
                "latitude": item.get("latitude"),
                "longitude": item.get("longitude"),
                "lat": item.get("latitude"),
                "lng": item.get("longitude"),
                "contractor_name": contractor_name if contractor_name.lower() not in ("n/a", "none", "") else "",
                "applicant_name": "", # Still empty as it's not in the API
                "link": item.get("link", {}).get("url", "") if isinstance(item.get("link"), dict) else "",
            }

            if permit["permit_number"]:
                permits.append(permit)

        except Exception as e:
            print(f"Error processing item {idx}: {e}")
            continue

    return permits, contractors


def print_stats(permits, contractors):
    """Print summary statistics."""
    types = {}
    neighborhoods = {}
    statuses = {}
    total_value = 0

    for p in permits:
        types[p["type"]] = types.get(p["type"], 0) + 1
        neighborhoods[p["neighborhood"]] = neighborhoods.get(p["neighborhood"], 0) + 1
        statuses[p["status"]] = statuses.get(p["status"], 0) + 1
        total_value += p["value"]

    print(f"\n--- Summary ---")
    print(f"  Total permits: {len(permits)}")
    print(f"  Unique contractors: {len(contractors)}")
    print(f"  Total project value: ${total_value:,.0f}")

    print(f"\n  By type:")
    for t, c in sorted(types.items(), key=lambda x: x[1], reverse=True):
        print(f"    {t}: {c}")

    print(f"\n  By status:")
    for s, c in sorted(statuses.items(), key=lambda x: x[1], reverse=True):
        print(f"    {s}: {c}")

    print(f"\n  By neighborhood (top 15):")
    sorted_hoods = sorted(neighborhoods.items(), key=lambda x: x[1], reverse=True)
    for n, c in sorted_hoods[:15]:
        print(f"    {n}: {c}")

    other_count = sum(c for n, c in sorted_hoods if n in ("Other", "Other Seattle"))
    named_count = sum(c for n, c in sorted_hoods if n not in ("Other", "Other Seattle"))
    print(f"\n  Neighborhood coverage: {named_count}/{len(permits)} ({100*named_count/len(permits):.1f}%) matched to named neighborhoods")


def build_parser():
    parser = argparse.ArgumentParser(description="Scrape Seattle permits from Open Data Portal.")
    parser.add_argument(
        "--total",
        type=int,
        default=5000,
        help="Total permits to fetch. Defaults to 5000.",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=1000,
        help="Records per API page. Defaults to 1000.",
    )
    parser.add_argument(
        "--status",
        type=str,
        choices=["active", "pending", "completed", "expired", "cancelled", "new"],
        help="Only fetch permits with this status.",
    )
    return parser


async def main():
    args = build_parser().parse_args()
    permits, contractors = await fetch_seattle_permits(
        total=args.total, page_size=args.page_size, status_filter=args.status
    )

    if not permits:
        print("\nNo permits fetched from API")
        return

    # Save permits as JSONL
    permits_file = "seattle_permits.jsonl"
    with open(permits_file, "w") as f:
        for permit in permits:
            f.write(json.dumps(permit) + "\n")
    print(f"\nSaved {len(permits)} permits to {permits_file}")

    # Save contractors as JSONL
    contractors_file = "seattle_contractors.jsonl"
    with open(contractors_file, "w") as f:
        for contractor in contractors.values():
            f.write(json.dumps(contractor) + "\n")
    print(f"Saved {len(contractors)} contractors to {contractors_file}")

    print_stats(permits, contractors)

    # Sample output
    print(f"\n--- Sample permits ---")
    for p in permits[:5]:
        print(f"  {p['permit_number']}: {p['neighborhood']} | {p['type']} | ${p['value']:,} | {p['address'][:50]}")


if __name__ == "__main__":
    asyncio.run(main())
