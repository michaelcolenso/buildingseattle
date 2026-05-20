#!/usr/bin/env python3
"""Probe SDCI detail pages for fields not present in the base open-data feed."""

import argparse
import asyncio
import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import urlencode

import httpx
from bs4 import BeautifulSoup


DETAIL_URL = "https://services.seattle.gov/portal/customize/LinkToRecord.aspx"
LNI_CONTRACTOR_URL = "https://data.wa.gov/resource/ciwg-agsx.json"
DEFAULT_INPUT = "seattle_permits.jsonl"
DEFAULT_JSONL_OUTPUT = "sdci_detail_probe_results.jsonl"
DEFAULT_SUMMARY_OUTPUT = "sdci_detail_probe_summary.md"


def load_permits(path):
    """Load local permit JSONL records."""
    with open(path, "r") as f:
        return [json.loads(line) for line in f if line.strip()]


def pick_sample(permits, limit):
    """Pick a mixed sample of recent permits with and without contractor names."""
    with_contractors = [p for p in permits if (p.get("contractor_name") or "").strip()]
    without_contractors = [p for p in permits if not (p.get("contractor_name") or "").strip()]
    sample = []
    for bucket in (without_contractors, with_contractors):
        for permit in bucket:
            if permit.get("permit_number") and permit["permit_number"] not in {p["permit_number"] for p in sample}:
                sample.append(permit)
            if len(sample) >= limit:
                return sample
    return sample[:limit]


def detail_url(permit_number):
    return f"{DETAIL_URL}?{urlencode({'altId': permit_number})}"


def clean_text(value):
    """Normalize HTML text for compact storage."""
    return re.sub(r"\s+", " ", value or "").strip()


def text_by_id(soup, element_id):
    node = soup.find(id=element_id)
    return clean_text(node.get_text(" ")) if node else ""


def parse_label_value_pairs(scope):
    """Extract Accela label/value pairs from common two-column detail blocks."""
    pairs = {}
    labels = scope.select(".MoreDetail_ItemColASI.MoreDetail_ItemCol1 span.ACA_SmLabelBolder")
    for label_node in labels:
        value_col = label_node.find_parent(class_="MoreDetail_ItemCol1")
        if not value_col:
            continue
        value_col = value_col.find_next_sibling(class_="MoreDetail_ItemCol2")
        if not value_col:
            continue
        label = clean_text(label_node.get_text(" ")).rstrip(":")
        value = clean_text(value_col.get_text(" "))
        if label and value:
            pairs[label] = value
    return pairs


def parse_simple_detail_pairs(scope):
    """Extract compact pairs from Other Information blocks."""
    pairs = {}
    labels = scope.select(".MoreDetail_ItemCol.MoreDetail_ItemCol1 span.ACA_SmLabelBolder")
    for label_node in labels:
        value_col = label_node.find_parent(class_="MoreDetail_ItemCol1")
        if not value_col:
            continue
        value_col = value_col.find_next_sibling(class_="MoreDetail_ItemCol2")
        if not value_col:
            continue
        label = clean_text(label_node.get_text(" ")).rstrip(":")
        value = clean_text(value_col.get_text(" "))
        if label and value:
            pairs[label] = value
    return pairs


def parse_project_description(soup):
    label = soup.find(string=re.compile(r"Project Description"))
    if not label:
        return {}
    parent = label.find_parent("td") or label.find_parent("table")
    if not parent:
        return {}
    text = clean_text(parent.get_text(" "))
    text = re.sub(r"^Project Description\s*", "", text)
    parts = [part.strip() for part in re.split(r"\s{2,}", text) if part.strip()]
    return {"project_description_detail": " ".join(parts) if parts else text}


def parse_parcel(soup):
    match = re.search(r"Development Site Parcel:([A-Z0-9-]+)", soup.get_text(" "))
    return match.group(1) if match else ""


def parse_inspection_summary(soup):
    text = soup.get_text(" ")
    return {
        "has_required_inspections": "There are no required inspections" not in text,
        "has_completed_inspections": "There are no completed inspections" not in text,
    }


def parse_detail_html(permit_number, html):
    soup = BeautifulSoup(html, "html.parser")
    asi_scope = soup.find(id="trASIList") or soup
    asit_scope = soup.find(id="trASITList") or soup
    application_info = parse_label_value_pairs(asi_scope)
    other_info = parse_simple_detail_pairs(asit_scope)

    result = {
        "permit_number": permit_number,
        "detail_url": detail_url(permit_number),
        "record_number": text_by_id(soup, "ctl00_PlaceHolderMain_lblPermitNumber"),
        "record_type": text_by_id(soup, "ctl00_PlaceHolderMain_lblPermitType"),
        "record_status": text_by_id(soup, "ctl00_PlaceHolderMain_lblRecordStatus"),
        "expiration_date": text_by_id(soup, "ctl00_PlaceHolderMain_lblExpirtionDate"),
        "application_info": application_info,
        "other_info": other_info,
        "parcel": parse_parcel(soup),
        **parse_project_description(soup),
        **parse_inspection_summary(soup),
    }

    result["contractor_disclosure"] = {
        "performing_work": application_info.get("Who will be performing all the work?", ""),
        "contractor_license": application_info.get("Contractor License", ""),
        "contractor_exemption_acknowledged": application_info.get(
            "I have submitted an application for a building permit from the City of Seattle. I believe the work authorized by this permit is exempt from having a registered contractor.  I understand that I may be waiving certain rights that I might otherwise have under state law in any decision to engage an unregistered contractor to perform construction work.",
            "",
        ),
    }
    return result


async def fetch_detail(client, permit_number):
    response = await client.get(detail_url(permit_number), follow_redirects=True, timeout=45.0)
    response.raise_for_status()
    return parse_detail_html(permit_number, response.text)


async def run_probe(permit_numbers, concurrency):
    limits = httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    headers = {"User-Agent": "BuildingSeattle-DetailProbe/1.0"}
    async with httpx.AsyncClient(headers=headers, limits=limits) as client:
        semaphore = asyncio.Semaphore(concurrency)

        async def guarded_fetch(permit_number):
            async with semaphore:
                try:
                    return await fetch_detail(client, permit_number)
                except Exception as error:
                    return {"permit_number": permit_number, "error": str(error)}

        return await asyncio.gather(*(guarded_fetch(num) for num in permit_numbers))


async def resolve_license(client, license_number):
    escaped_license = license_number.replace("'", "''")
    params = {
        "$select": ",".join(
            [
                "businessname",
                "contractorlicensenumber",
                "contractorlicensetypecodedesc",
                "licensestatusdesc",
                "ubi",
                "insurancecompany",
                "insuranceamt",
                "effectivedate",
                "expirationdate",
            ]
        ),
        "$limit": "1",
        "$where": f"contractorlicensenumber = '{escaped_license}'",
    }
    response = await client.get(LNI_CONTRACTOR_URL, params=params, timeout=30.0)
    response.raise_for_status()
    rows = response.json()
    return rows[0] if rows else {}


async def enrich_with_license_data(results, concurrency):
    licenses = sorted(
        {
            r.get("contractor_disclosure", {}).get("contractor_license")
            for r in results
            if r.get("contractor_disclosure", {}).get("contractor_license")
        }
    )
    if not licenses:
        return results

    limits = httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    headers = {"User-Agent": "BuildingSeattle-DetailProbe/1.0"}
    async with httpx.AsyncClient(headers=headers, limits=limits) as client:
        semaphore = asyncio.Semaphore(concurrency)

        async def guarded_resolve(license_number):
            async with semaphore:
                try:
                    return license_number, await resolve_license(client, license_number)
                except Exception as error:
                    return license_number, {"lookup_error": str(error)}

        license_rows = dict(await asyncio.gather(*(guarded_resolve(license_number) for license_number in licenses)))

    for result in results:
        license_number = result.get("contractor_disclosure", {}).get("contractor_license")
        if license_number:
            result["contractor_license_lookup"] = license_rows.get(license_number, {})
    return results


def write_outputs(results, jsonl_output, summary_output):
    Path(jsonl_output).write_text(
        "".join(json.dumps(result, sort_keys=True) + "\n" for result in results),
        encoding="utf-8",
    )

    successful = [r for r in results if "error" not in r]
    errors = [r for r in results if "error" in r]
    performing_work = Counter(
        r.get("contractor_disclosure", {}).get("performing_work") or "Unknown" for r in successful
    )
    license_count = sum(1 for r in successful if r.get("contractor_disclosure", {}).get("contractor_license"))
    license_name_count = sum(1 for r in successful if r.get("contractor_license_lookup", {}).get("businessname"))
    parcels = sum(1 for r in successful if r.get("parcel"))
    required_inspections = sum(1 for r in successful if r.get("has_required_inspections"))
    completed_inspections = sum(1 for r in successful if r.get("has_completed_inspections"))

    lines = [
        "# SDCI Detail Probe Summary",
        "",
        f"- Probed permits: {len(results)}",
        f"- Successful detail pages: {len(successful)}",
        f"- Errors: {len(errors)}",
        f"- Contractor license values found: {license_count}",
        f"- Contractor licenses resolved to L&I business names: {license_name_count}",
        f"- Parcel IDs found: {parcels}",
        f"- Records with required inspections listed: {required_inspections}",
        f"- Records with completed inspections listed: {completed_inspections}",
        "",
        "## Performing Work",
    ]
    for label, count in performing_work.most_common():
        lines.append(f"- {label}: {count}")

    lines.extend(["", "## Sample Findings"])
    for result in successful[:10]:
        disclosure = result.get("contractor_disclosure", {})
        lines.append(
            "- "
            f"{result['permit_number']}: "
            f"status={result.get('record_status') or 'n/a'}, "
            f"expires={result.get('expiration_date') or 'n/a'}, "
            f"work={disclosure.get('performing_work') or 'n/a'}, "
            f"license={disclosure.get('contractor_license') or 'n/a'}, "
            f"name={(result.get('contractor_license_lookup') or {}).get('businessname') or 'n/a'}, "
            f"parcel={result.get('parcel') or 'n/a'}"
        )

    if errors:
        lines.extend(["", "## Errors"])
        for result in errors[:10]:
            lines.append(f"- {result['permit_number']}: {result['error']}")

    Path(summary_output).write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_parser():
    parser = argparse.ArgumentParser(description="Probe SDCI permit detail pages for richer fields.")
    parser.add_argument("--input", default=DEFAULT_INPUT, help=f"Permit JSONL input. Defaults to {DEFAULT_INPUT}.")
    parser.add_argument("--limit", type=int, default=12, help="Number of permits to probe when --permit is omitted.")
    parser.add_argument("--permit", action="append", help="Permit number to probe. May be passed multiple times.")
    parser.add_argument("--concurrency", type=int, default=3, help="Concurrent detail-page requests.")
    parser.add_argument("--skip-license-lookup", action="store_true", help="Do not resolve SDCI license numbers through WA L&I.")
    parser.add_argument("--jsonl-output", default=DEFAULT_JSONL_OUTPUT)
    parser.add_argument("--summary-output", default=DEFAULT_SUMMARY_OUTPUT)
    return parser


async def main():
    args = build_parser().parse_args()
    if args.permit:
        permit_numbers = args.permit
    else:
        permits = load_permits(args.input)
        permit_numbers = [p["permit_number"] for p in pick_sample(permits, args.limit)]

    results = await run_probe(permit_numbers, args.concurrency)
    if not args.skip_license_lookup:
        results = await enrich_with_license_data(results, args.concurrency)
    write_outputs(results, args.jsonl_output, args.summary_output)
    print(f"Wrote {args.jsonl_output}")
    print(f"Wrote {args.summary_output}")


if __name__ == "__main__":
    asyncio.run(main())
