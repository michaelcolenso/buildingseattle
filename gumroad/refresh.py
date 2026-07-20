#!/usr/bin/env python3
"""
BuildingSeattle Data Refresh Script (Pro Tier)
================================================
Pulls fresh building permit data from buildingseattle.com API
and exports it as a CSV with the same 32 columns as the product.

Usage:   python3 refresh.py [--output FILE] [--max-pages N]
Output:  buildingseattle_fresh.csv (default)

Requirements: Python 3.10+ (stdlib only — no pip installs needed)
"""
import argparse
import json
import csv
import urllib.request
import urllib.error
import time
import sys

API_BASE = "https://buildingseattle.com"
PER_PAGE = 100  # API maximum page size
DEFAULT_OUTPUT = "buildingseattle_fresh.csv"
MAX_RETRIES = 4
RETRY_DELAY = 2  # seconds, doubled per attempt
CONSECUTIVE_EMPTY_LIMIT = 3  # stop after this many empty pages in a row
RETRYABLE_HTTP = {429, 500, 502, 503, 504}

# Same 32 columns as the shipped product (see data-dictionary.md)
PERMIT_COLUMNS = [
    "permit_number", "address", "neighborhood", "type", "value", "status",
    "description", "detailed_description",
    "applied_date", "issued_date", "completed_date", "expires_date",
    "plan_review_complete_date", "ready_to_issue_date",
    "contractor_name", "contractor_specialty", "contractor_license",
    "housing_units", "housing_units_added", "housing_units_removed",
    "housing_category",
    "review_level", "primary_property_use", "work_performed_by",
    "parcel_number",
    "number_review_cycles", "total_days_plan_review", "days_out_corrections",
    "has_required_inspections", "has_completed_inspections",
    "permit_detail_url", "record_status_detail",
]


def fetch_json(url):
    """Fetch a URL, retrying transient network and rate-limit errors."""
    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "BuildingSeattle-Refresh/1.1"},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code in RETRYABLE_HTTP and attempt < MAX_RETRIES:
                last_error = e
            else:
                # Other 4xx — the server is saying no; don't hammer it
                sys.stderr.write(f"  HTTP {e.code}: {e.reason} ({url})\n")
                return None
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            last_error = e
            if attempt >= MAX_RETRIES:
                sys.stderr.write(f"  Failed after {MAX_RETRIES} attempts: {e}\n")
                return None
        delay = RETRY_DELAY * (2 ** (attempt - 1))
        sys.stderr.write(f"  Attempt {attempt} failed ({last_error}). Retrying in {delay}s...\n")
        time.sleep(delay)
    return None


def fetch_page(page):
    return fetch_json(f"{API_BASE}/api/permits?per_page={PER_PAGE}&page={page}")


def main():
    parser = argparse.ArgumentParser(
        description="Refresh BuildingSeattle permit data to a CSV.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT,
                        help=f"Output CSV path (default: {DEFAULT_OUTPUT})")
    parser.add_argument("--max-pages", type=int, default=0,
                        help="Stop after N pages (0 = fetch everything)")
    args = parser.parse_args()

    print("Refreshing BuildingSeattle permit data...")
    print(f"Source: {API_BASE}/api/permits (page size {PER_PAGE})")

    stats = fetch_json(f"{API_BASE}/api/stats")
    if stats:
        print(f"Snapshot: {stats.get('permits', '?'):,} permits in the live database "
              f"as of {stats.get('timestamp', 'now')}")
    print()

    records = []
    seen = set()
    page = 1
    empty_streak = 0
    errors = 0

    while True:
        if args.max_pages and page > args.max_pages:
            sys.stderr.write(f"  Reached --max-pages {args.max_pages}, stopping.\n")
            break

        data = fetch_page(page)

        if data is None:
            errors += 1
            if errors >= 5:
                sys.stderr.write(
                    f"\n⚠️  Too many errors ({errors}). "
                    f"Stopping. Got {len(records)} records so far.\n")
                break
            page += 1
            continue

        results = data.get("results", [])

        if not results:
            empty_streak += 1
            if empty_streak >= CONSECUTIVE_EMPTY_LIMIT:
                break
            page += 1
            continue

        empty_streak = 0  # reset — we got data

        new = 0
        for r in results:
            pn = r.get("permit_number", "")
            if pn and pn not in seen:
                seen.add(pn)
                records.append(r)
                new += 1

        sys.stderr.write(f"  Page {page}: +{new} records (total: {len(records)})")
        if len(results) < PER_PAGE:
            sys.stderr.write(" [last page]\n")
            break
        sys.stderr.write("\n")

        page += 1
        time.sleep(0.2)

    if not records:
        print("\n❌ No records fetched. Check your internet connection and try again.")
        return 1

    with open(args.output, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=PERMIT_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)

    total_value = sum(r.get("value", 0) or 0 for r in records)
    neighborhoods = len(
        set(r.get("neighborhood", "") for r in records if r.get("neighborhood")))

    print()
    print(f"✅ Done. {len(records):,} records written to {args.output}")
    print(f"   Total construction value: ${total_value:,.0f}")
    print(f"   Neighborhoods: {neighborhoods}")
    print(f"   Pages fetched: {page}")
    print(f"   Errors encountered: {errors}")

    if errors > 0:
        print(f"\n⚠️  Refresh completed with {errors} error(s). "
              f"Some records may be missing.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
