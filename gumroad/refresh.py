#!/usr/bin/env python3
"""
BuildingSeattle Data Refresh Script (Pro Tier)
================================================
Pulls fresh building permit data from buildingseattle.com API
and exports it as a CSV.

Usage:   python3 refresh.py
Output:  buildingseattle_fresh.csv

Requirements: Python 3.10+ (stdlib only — no pip installs needed)
"""
import json
import csv
import urllib.request
import urllib.error
import time
import sys

API_URL = "https://buildingseattle.com/api/permits?limit=50&page={}"
OUTPUT = "buildingseattle_fresh.csv"
MAX_RETRIES = 3
RETRY_DELAY = 2  # seconds
CONSECUTIVE_EMPTY_LIMIT = 3  # stop after this many empty pages in a row


def fetch_page(page: int) -> dict | None:
    """Fetch one page of results, with retries on transient errors."""
    url = API_URL.format(page)
    last_error = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "BuildingSeattle-Refresh/1.0"},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            # Don't retry 4xx/5xx — the server is saying no
            sys.stderr.write(f"  HTTP {e.code} on page {page}: {e.reason}\n")
            return None
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            last_error = e
            if attempt < MAX_RETRIES:
                sys.stderr.write(
                    f"  Page {page} attempt {attempt} failed: {e}. "
                    f"Retrying in {RETRY_DELAY}s...\n"
                )
                time.sleep(RETRY_DELAY * attempt)
            else:
                sys.stderr.write(
                    f"  Page {page} failed after {MAX_RETRIES} attempts: {e}\n"
                )

    return None


def main():
    print("Refreshing BuildingSeattle permit data...")
    print(f"Source: {API_URL.replace('{}', '1')}")
    print()

    records = []
    seen = set()
    page = 1
    empty_streak = 0
    errors = 0

    while True:
        data = fetch_page(page)

        if data is None:
            errors += 1
            if errors >= 5:
                sys.stderr.write(
                    f"\n⚠️  Too many errors ({errors}). "
                    f"Stopping. Got {len(records)} records so far.\n"
                )
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

        sys.stderr.write(
            f"  Page {page}: +{new} records (total: {len(records)})"
        )

        # Warn if API is returning fewer records than page size suggests
        if len(results) < 50:
            sys.stderr.write(" [last page]")
        sys.stderr.write("\n")

        if len(results) < 50:
            break

        page += 1
        time.sleep(0.2)

    if not records:
        print("\n❌ No records fetched. Check your internet connection and try again.")
        return 1

    # Write CSV — use the same 32 columns as the product
    columns = [
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

    with open(OUTPUT, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)

    total_value = sum(r.get("value", 0) or 0 for r in records)
    neighborhoods = len(
        set(r.get("neighborhood", "") for r in records if r.get("neighborhood"))
    )

    print()
    print(f"✅ Done. {len(records):,} records written to {OUTPUT}")
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
