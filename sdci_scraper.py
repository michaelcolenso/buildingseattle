#!/usr/bin/env python3
# sdci_scraper.py - Fetches real Seattle permit data from Seattle Open Data Portal

import argparse
import asyncio
import httpx
from datetime import datetime
import json

# Seattle neighborhood bounding boxes (approximate lat/lng rectangles)
# Derived from general neighborhood boundaries
NEIGHBORHOOD_BOUNDS = [
    # (name, min_lat, max_lat, min_lng, max_lng)
    # — Northwest Seattle —
    ("Ballard",             47.668, 47.692, -122.410, -122.370),
    ("Crown Hill",          47.692, 47.710, -122.390, -122.370),
    ("Fremont",             47.650, 47.668, -122.370, -122.340),
    ("Phinney Ridge",       47.668, 47.692, -122.370, -122.350),
    ("Greenwood",           47.692, 47.710, -122.370, -122.340),
    ("Broadview",           47.710, 47.735, -122.370, -122.340),
    ("Bitter Lake",         47.710, 47.735, -122.360, -122.335),
    ("Magnolia",            47.630, 47.670, -122.420, -122.385),
    ("Interbay",            47.640, 47.660, -122.385, -122.365),
    # — North Seattle —
    ("Green Lake",          47.668, 47.692, -122.360, -122.325),
    ("Wallingford",         47.650, 47.668, -122.340, -122.315),
    ("Roosevelt",           47.668, 47.685, -122.325, -122.310),
    ("Maple Leaf",          47.685, 47.710, -122.325, -122.300),
    ("Northgate",           47.700, 47.720, -122.340, -122.310),
    ("Licton Springs",      47.692, 47.710, -122.345, -122.325),
    ("Haller Lake",         47.715, 47.735, -122.345, -122.320),
    ("Pinehurst",           47.720, 47.740, -122.320, -122.295),
    # — Northeast Seattle —
    ("University District", 47.650, 47.668, -122.315, -122.290),
    ("Ravenna",             47.668, 47.688, -122.310, -122.280),
    ("Wedgwood",            47.685, 47.700, -122.300, -122.280),
    ("View Ridge",          47.680, 47.695, -122.280, -122.260),
    ("Sand Point",          47.680, 47.695, -122.270, -122.250),
    ("Laurelhurst",         47.660, 47.680, -122.285, -122.265),
    ("Bryant",              47.668, 47.685, -122.290, -122.270),
    ("Meadowbrook",         47.700, 47.715, -122.300, -122.280),
    ("Lake City",           47.710, 47.735, -122.300, -122.270),
    ("Olympic Hills",       47.720, 47.740, -122.300, -122.275),
    # — Central Seattle —
    ("Queen Anne",          47.625, 47.650, -122.370, -122.345),
    ("South Lake Union",    47.620, 47.635, -122.345, -122.325),
    ("Eastlake",            47.635, 47.650, -122.335, -122.320),
    ("Capitol Hill",        47.610, 47.640, -122.325, -122.300),
    ("First Hill",          47.600, 47.615, -122.330, -122.315),
    ("Central District",    47.600, 47.620, -122.310, -122.290),
    ("Madrona",             47.608, 47.625, -122.295, -122.280),
    ("Leschi",              47.596, 47.608, -122.295, -122.280),
    ("Madison Park",        47.630, 47.645, -122.290, -122.270),
    ("Madison Valley",      47.625, 47.640, -122.300, -122.285),
    ("Montlake",            47.640, 47.655, -122.310, -122.290),
    # — Downtown —
    ("Downtown",            47.600, 47.620, -122.345, -122.325),
    ("Belltown",            47.612, 47.622, -122.355, -122.340),
    ("Pioneer Square",      47.598, 47.605, -122.340, -122.325),
    ("International District", 47.593, 47.602, -122.330, -122.315),
    # — South Seattle —
    ("SoDo",                47.565, 47.595, -122.345, -122.320),
    ("Georgetown",          47.540, 47.565, -122.340, -122.310),
    ("Beacon Hill",         47.555, 47.600, -122.315, -122.295),
    ("North Beacon Hill",   47.575, 47.600, -122.315, -122.295),
    ("Mt Baker",            47.570, 47.590, -122.295, -122.280),
    ("Columbia City",       47.555, 47.575, -122.295, -122.275),
    ("Hillman City",        47.545, 47.558, -122.295, -122.275),
    ("Rainier Beach",       47.505, 47.535, -122.275, -122.245),
    ("Seward Park",         47.530, 47.560, -122.270, -122.250),
    ("Rainier Valley",      47.520, 47.555, -122.300, -122.270),
    ("South Park",          47.520, 47.540, -122.340, -122.315),
    ("Dunlap",              47.530, 47.545, -122.280, -122.260),
    # — West Seattle —
    ("West Seattle",        47.530, 47.600, -122.420, -122.345),
    ("Admiral",             47.570, 47.585, -122.410, -122.380),
    ("Alki",                47.576, 47.592, -122.420, -122.400),
    ("White Center",        47.505, 47.530, -122.380, -122.345),
]


def detect_neighborhood(lat, lng):
    """Detect Seattle neighborhood from coordinates using bounding boxes."""
    if not lat or not lng:
        return "Other"

    try:
        lat = float(lat)
        lng = float(lng)
    except (ValueError, TypeError):
        return "Other"

    for name, min_lat, max_lat, min_lng, max_lng in NEIGHBORHOOD_BOUNDS:
        if min_lat <= lat <= max_lat and min_lng <= lng <= max_lng:
            return name

    # Within Seattle city limits but not in a named neighborhood
    if 47.49 <= lat <= 47.74 and -122.44 <= lng <= -122.24:
        return "Other Seattle"

    return "Other"


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


def map_status(status):
    """Map permit status to simplified categories."""
    if not status:
        return "new"
    s = str(status).lower()
    if "issue" in s or "active" in s or "approved" in s:
        return "active"
    elif "pending" in s or "review" in s or "applied" in s:
        return "pending"
    elif "complete" in s or "final" in s or "closed" in s:
        return "completed"
    elif "expir" in s:
        return "expired"
    elif "cancel" in s:
        return "cancelled"
    return "new"


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


STATUS_FILTER_MAP = {
    "active":   "(statuscurrent LIKE '%Issue%' OR statuscurrent LIKE '%Active%' OR statuscurrent LIKE '%Approved%')",
    "pending":  "(statuscurrent LIKE '%Pending%' OR statuscurrent LIKE '%Review%' OR statuscurrent LIKE '%Applied%')",
    "completed":"(statuscurrent LIKE '%Complete%' OR statuscurrent LIKE '%Final%' OR statuscurrent LIKE '%Closed%')",
    "expired":  "(statuscurrent LIKE '%Expir%')",
    "cancelled":"(statuscurrent LIKE '%Cancel%')",
    "new":      "(statuscurrent IS NULL OR statuscurrent = '')",
}


def build_status_filter(status):
    """Build a SODA $where clause fragment for a given simplified status."""
    if not status:
        return None
    s = status.lower().strip()
    return STATUS_FILTER_MAP.get(s)


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
                "$order": "applieddate DESC",
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
                "latitude": item.get("latitude"),
                "longitude": item.get("longitude"),
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
