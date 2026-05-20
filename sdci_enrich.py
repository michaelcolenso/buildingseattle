#!/usr/bin/env python3
"""Enrich permits from SDCI detail pages and post them to the Worker."""

import argparse
import asyncio
import json
from pathlib import Path

import httpx

from direct_import import ingest_headers, post_batch_with_retries
from sdci_detail_probe import (
    DEFAULT_INPUT,
    enrich_with_license_data,
    load_permits,
    run_probe,
)


DEFAULT_WORKER_URL = "http://localhost:8787"
DEFAULT_OUTPUT = "sdci_permit_enrichments.jsonl"
ENRICHMENT_ENDPOINT = "/ingest/permit/enrichment/batch"


def pick_enrichment_targets(permits, limit, missing_contractors_only=True):
    """Pick recent permits worth enriching from local scrape output."""
    targets = []
    seen = set()
    for permit in permits:
        permit_number = permit.get("permit_number")
        if not permit_number or permit_number in seen:
            continue
        if missing_contractors_only and (permit.get("contractor_name") or "").strip():
            continue
        targets.append(permit_number)
        seen.add(permit_number)
        if len(targets) >= limit:
            break
    return targets


def flatten_enrichment(result):
    """Flatten probe output into the Worker enrichment contract."""
    application_info = result.get("application_info") or {}
    other_info = result.get("other_info") or {}
    disclosure = result.get("contractor_disclosure") or {}
    lookup = result.get("contractor_license_lookup") or {}

    return {
        "permit_number": result.get("permit_number"),
        "permit_detail_url": result.get("detail_url"),
        "record_status_detail": result.get("record_status"),
        "expires_date": result.get("expiration_date"),
        "detailed_description": result.get("project_description_detail"),
        "review_level": application_info.get("Review Level"),
        "primary_property_use": application_info.get("Choose the Primary Property Use"),
        "work_performed_by": disclosure.get("performing_work"),
        "contractor_license": disclosure.get("contractor_license"),
        "contractor_name": lookup.get("businessname"),
        "contractor_license_status": lookup.get("licensestatusdesc"),
        "contractor_ubi": lookup.get("ubi"),
        "contractor_insurance_amount": lookup.get("insuranceamt"),
        "contractor_insurance_expires_date": lookup.get("expirationdate"),
        "parcel_number": result.get("parcel"),
        "housing_units_existing": other_info.get("Number of Existing Units"),
        "housing_units_removed": other_info.get("Number of Removed Units"),
        "housing_units_added": other_info.get("Number of Added Units"),
        "sleeping_rooms": other_info.get("Number of Sleeping Rooms"),
        "has_required_inspections": result.get("has_required_inspections", False),
        "has_completed_inspections": result.get("has_completed_inspections", False),
    }


def write_jsonl(path, rows):
    Path(path).write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")


async def post_enrichments(url, enrichments, batch_size, retries):
    async with httpx.AsyncClient() as client:
        return await import_batch_items(client, url, enrichments, batch_size, retries)


async def import_batch_items(client, url, items, batch_size, retries):
    headers = ingest_headers()
    if not headers:
        raise RuntimeError("INGEST_API_TOKEN is required in the environment or .dev.vars")

    processed = 0
    for idx in range(0, len(items), batch_size):
        batch = items[idx : idx + batch_size]
        response = await post_batch_with_retries(
            client,
            url,
            ENRICHMENT_ENDPOINT,
            batch,
            headers,
            retries,
        )
        if response.status_code != 200:
            raise RuntimeError(f"Batch {idx // batch_size + 1} failed - HTTP {response.status_code}: {response.text[:300]}")
        payload = response.json()
        processed += payload.get("processed", len(batch))
        print(
            f"  Batch {idx // batch_size + 1}: "
            f"{payload.get('processed', len(batch))}/{len(batch)} processed, "
            f"{payload.get('contractors_linked', 0)} linked"
        )
    return processed


def build_parser():
    parser = argparse.ArgumentParser(description="Enrich Seattle permits using SDCI detail pages and WA L&I licenses.")
    parser.add_argument("url", nargs="?", default=DEFAULT_WORKER_URL, help=f"Worker base URL. Defaults to {DEFAULT_WORKER_URL}.")
    parser.add_argument("--input", default=DEFAULT_INPUT, help=f"Permit JSONL input. Defaults to {DEFAULT_INPUT}.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help=f"Enrichment JSONL output. Defaults to {DEFAULT_OUTPUT}.")
    parser.add_argument("--limit", type=int, default=200, help="Number of permits to enrich. Defaults to 200.")
    parser.add_argument("--permit", action="append", help="Specific permit number to enrich. May be passed multiple times.")
    parser.add_argument("--batch-size", type=int, default=25, help="Records per Worker ingest request. Defaults to 25.")
    parser.add_argument("--concurrency", type=int, default=4, help="Concurrent SDCI/L&I requests. Defaults to 4.")
    parser.add_argument("--retries", type=int, default=4, help="Retries per Worker batch. Defaults to 4.")
    parser.add_argument("--include-existing-contractors", action="store_true", help="Also enrich records already carrying contractor_name in the base feed.")
    parser.add_argument("--no-post", action="store_true", help="Only write the JSONL output; do not post to the Worker.")
    return parser


async def main():
    args = build_parser().parse_args()
    if args.permit:
        permit_numbers = args.permit
    else:
        permits = load_permits(args.input)
        permit_numbers = pick_enrichment_targets(
            permits,
            args.limit,
            missing_contractors_only=not args.include_existing_contractors,
        )

    print(f"Enriching {len(permit_numbers)} permits...")
    results = await run_probe(permit_numbers, args.concurrency)
    results = await enrich_with_license_data(results, args.concurrency)
    successful = [result for result in results if "error" not in result]
    errors = [result for result in results if "error" in result]
    enrichments = [flatten_enrichment(result) for result in successful]
    write_jsonl(args.output, enrichments)

    license_count = sum(1 for item in enrichments if item.get("contractor_license"))
    contractor_count = sum(1 for item in enrichments if item.get("contractor_name"))
    print(f"Wrote {len(enrichments)} enrichments to {args.output}")
    print(f"Found {license_count} contractor licenses; resolved {contractor_count} contractor names")
    if errors:
        print(f"Errors: {len(errors)}")

    if not args.no_post:
        print(f"Posting to {args.url}{ENRICHMENT_ENDPOINT}...")
        processed = await post_enrichments(args.url, enrichments, args.batch_size, args.retries)
        print(f"Posted {processed}/{len(enrichments)} enrichments")


if __name__ == "__main__":
    asyncio.run(main())
