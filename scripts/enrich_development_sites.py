#!/usr/bin/env python3
"""Refresh current Seattle development sites referenced by permits.

D1 reads use CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN. Publishing uses
INGEST_API_TOKEN. --dry-run never writes to the Worker and needs no ingest token.
--input-csv permits a credential-free dry run against a local permit export.
"""

import argparse
import asyncio
from collections import Counter
import csv
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import sys

import httpx

SOURCE = "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/ArcGIS/rest/services/Development_Sites/FeatureServer/0"
DEFAULT_DB_ID = "e065e988-045f-42b5-b47a-4027c2e5c417"
FIELDS = {"PRCLID", "PRCLSTAT", "LOTSZ", "LAST_UPDATED_DT"}
SOURCE_BATCH_SIZE = 100
POST_BATCH_SIZE = 40
MAX_GEOMETRY_BYTES = 1_000_000


class RefreshError(RuntimeError):
    def __init__(self, message, summary):
        super().__init__(message)
        self.summary = summary


def normalize_site_id(value):
    if not isinstance(value, str):
        return None
    value = value.strip().upper()
    return value if re.fullmatch(r"[A-Z0-9]{1,20}", value) else None


def timestamp_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def source_timestamp(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Invalid source update timestamp")
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def valid_boundary(geometry):
    if not isinstance(geometry, dict) or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        return False
    polygons = [geometry.get("coordinates")] if geometry["type"] == "Polygon" else geometry.get("coordinates")
    if not isinstance(polygons, list) or not polygons:
        return False
    points = 0
    for polygon in polygons:
        if not isinstance(polygon, list) or not polygon:
            return False
        for ring in polygon:
            if not isinstance(ring, list) or len(ring) < 4:
                return False
            for point in ring:
                if not isinstance(point, list) or len(point) != 2:
                    return False
                if not all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in point):
                    return False
                points += 1
                if abs(point[0]) > 180 or abs(point[1]) >= 85 or points > 30000:
                    return False
            if ring[0] != ring[-1]:
                return False
            x0, y0 = ring[0]
            area = sum((a[0]-x0)*(b[1]-y0)-(b[0]-x0)*(a[1]-y0) for a, b in zip(ring, ring[1:]))
            if abs(area) < 1e-14:
                return False
    return len(json.dumps(geometry, separators=(",", ":")).encode()) <= MAX_GEOMETRY_BYTES


def parse_features(data, requested_ids):
    """Only a complete, well-formed collection can establish an absent ID."""
    if not isinstance(data, dict) or "error" in data or data.get("type") != "FeatureCollection":
        raise ValueError("ArcGIS did not return a GeoJSON FeatureCollection")
    properties = data.get("properties", {})
    if properties is not None and not isinstance(properties, dict):
        raise ValueError("Malformed collection properties")
    for container in [data, properties or {}]:
        if "exceededTransferLimit" in container and container["exceededTransferLimit"] is not False:
            raise ValueError("Incomplete ArcGIS response: exceededTransferLimit")
    features = data.get("features")
    if not isinstance(features, list):
        raise ValueError("Missing or invalid features array")
    requested = set(requested_ids)
    seen = set()
    sites = []
    for feature in features:
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise ValueError("Malformed source feature")
        props = feature.get("properties")
        if not isinstance(props, dict) or not FIELDS <= props.keys():
            raise ValueError("Source fields changed or are missing")
        site_id = normalize_site_id(props["PRCLID"])
        if not site_id or site_id not in requested or site_id in seen:
            raise ValueError("Duplicate, invalid, or unexpected site ID")
        seen.add(site_id)
        status = props["PRCLSTAT"]
        if status is not None and (not isinstance(status, str) or len(status) > 32):
            raise ValueError("Invalid site status")
        lot = props["LOTSZ"]
        if isinstance(lot, bool) or not isinstance(lot, int) or not 0 < lot <= 2**53 - 1:
            lot = None
        if "geometry" not in feature:
            raise ValueError("Source response omitted requested geometry")
        geometry = feature["geometry"]
        sites.append({
            "site_id": site_id, "status": status, "lot_sqft": lot,
            "geometry": {"type": geometry["type"], "coordinates": geometry["coordinates"]} if valid_boundary(geometry) else None,
            "source_updated_at": source_timestamp(props["LAST_UPDATED_DT"]),
        })
    return sites


async def request_json(client, method, url, *, retries=4, **kwargs):
    for attempt in range(retries + 1):
        try:
            response = await client.request(method, url, **kwargs)
            response.raise_for_status()
            return response.json()
        except (httpx.TimeoutException, httpx.NetworkError, httpx.HTTPStatusError) as exc:
            retryable = not isinstance(exc, httpx.HTTPStatusError) or exc.response.status_code in {429, 500, 502, 503, 504}
            if not retryable or attempt == retries:
                raise
            delay = min(2**attempt, 12)
            if isinstance(exc, httpx.HTTPStatusError):
                try:
                    delay = max(delay, min(float(exc.response.headers.get("Retry-After", 0)), 60))
                except ValueError:
                    pass
            await asyncio.sleep(delay)


async def read_permit_references(client, args):
    if args.input_csv:
        if not args.dry_run:
            raise ValueError("--input-csv is available only with --dry-run")
        with Path(args.input_csv).open(newline="", encoding="utf-8") as stream:
            return Counter(row.get("parcel_number", "") for row in csv.DictReader(stream))
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not account or not token:
        raise ValueError("D1 reads require CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN")
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{args.db_id}/query"
    references = Counter()
    cursor = None
    while True:
        # Keyset page distinct raw references, counting blank and malformed inputs too.
        where = "WHERE COALESCE(parcel_number, '') > ?" if cursor is not None else ""
        payload = {"sql": f"SELECT COALESCE(parcel_number, '') AS reference, COUNT(*) AS permits FROM permits {where} GROUP BY COALESCE(parcel_number, '') ORDER BY reference LIMIT 1000", "params": [cursor] if cursor is not None else []}
        data = await request_json(client, "POST", url, json=payload, headers={"Authorization": f"Bearer {token}"})
        if data.get("success") is not True or not data.get("result") or data["result"][0].get("success") is not True:
            raise ValueError("D1 reference query failed")
        rows = data["result"][0]["results"]
        for row in rows:
            references[row["reference"]] += row["permits"]
        if len(rows) < 1000:
            return references
        cursor = rows[-1]["reference"]


async def fetch_snapshot(client, ids):
    snapshots = []
    for offset in range(0, len(ids), SOURCE_BATCH_SIZE):
        batch = ids[offset:offset + SOURCE_BATCH_SIZE]
        # IDs are restricted to ASCII alphanumerics before entering the source SQL.
        where = "PRCLID IN (" + ",".join(f"'{site_id}'" for site_id in batch) + ")"
        try:
            data = await request_json(client, "POST", SOURCE + "/query", data={
                "f": "geojson", "where": where, "outFields": ",".join(sorted(FIELDS)),
                "outSR": "4326", "returnGeometry": "true", "resultRecordCount": "2000",
            })
            sites = parse_features(data, batch)
        except Exception as exc:
            raise RefreshError(str(exc), {"phase": "source", "requested_sites": len(ids),
                                         "completed_source_batches": len(snapshots), "failed_batches": 1,
                                         "published_sites": 0}) from exc
        snapshots.append({"complete": True, "requested_ids": batch, "sites": sites, "fetched_at": timestamp_now()})
    return snapshots


def publication_batches(snapshots):
    """Bound both D1 statement count and serialized body size."""
    for snapshot in snapshots:
        by_id = {site["site_id"]: site for site in snapshot["sites"]}
        ids, records, size = [], [], 0
        for site_id in snapshot["requested_ids"]:
            site = by_id.get(site_id)
            item_size = len(json.dumps(site, ensure_ascii=False).encode()) if site else 0
            if ids and (len(ids) == POST_BATCH_SIZE or size + item_size > 7_000_000):
                yield {**snapshot, "requested_ids": ids, "sites": records}
                ids, records, size = [], [], 0
            ids.append(site_id)
            if site:
                records.append(site)
            size += item_size
        if ids:
            yield {**snapshot, "requested_ids": ids, "sites": records}


async def publish_snapshot(client, worker_url, token, snapshots):
    published = 0
    for payload in publication_batches(snapshots):
        try:
            result = await request_json(client, "POST", worker_url.rstrip("/") + "/ingest/development-sites/batch",
                                        json=payload, headers={"X-Ingest-Token": token})
            if result.get("processed") != len(payload["requested_ids"]) or result.get("matched") != len(payload["sites"]):
                raise ValueError("Worker did not acknowledge the complete batch")
            published += len(payload["requested_ids"])
        except Exception as exc:
            raise RefreshError(str(exc), {"phase": "publish", "published_sites": published, "failed_batches": 1}) from exc
    return published


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit-sites", type=int, default=0, help="Pilot limit; 0 means all referenced sites")
    parser.add_argument("--input-csv", help="Read a permit CSV for a source-only dry run")
    parser.add_argument("--worker-url", default=os.environ.get("WORKER_URL", "https://buildingseattle.com"))
    parser.add_argument("--db-id", default=os.environ.get("BUILDINGSEATTLE_D1_ID", DEFAULT_DB_ID))
    return parser


async def run(args):
    if args.limit_sites < 0:
        raise ValueError("--limit-sites must be nonnegative")
    token = os.environ.get("INGEST_API_TOKEN")
    if not args.dry_run and not token:
        raise ValueError("Publishing requires INGEST_API_TOKEN")
    async with httpx.AsyncClient(timeout=90.0) as client:
        references = await read_permit_references(client, args)
        normalized = Counter()
        for raw, count in references.items():
            if normalize_site_id(raw):
                normalized[normalize_site_id(raw)] += count
        ids = sorted(normalized)
        if args.limit_sites:
            ids = ids[:args.limit_sites]
        # Complete all source reads before any reconciliation can remove cached rows.
        snapshots = await fetch_snapshot(client, ids)
        sites = [site for snapshot in snapshots for site in snapshot["sites"]]
        matched = {site["site_id"] for site in sites}
        summary = {
            "dry_run": args.dry_run, "source": SOURCE, "input_permits": sum(references.values()),
            "permits_without_valid_reference": sum(references.values()) - sum(normalized.values()),
            "requested_sites": len(ids), "matched_sites": len(matched), "unmatched_sites": len(ids) - len(matched),
            "scoped_permits": sum(normalized[id_] for id_ in ids),
            "matched_permits": sum(normalized[id_] for id_ in matched),
            "unmatched_permits": sum(normalized[id_] for id_ in ids if id_ not in matched),
            "missing_lot_size": sum(site["lot_sqft"] is None for site in sites),
            "missing_geometry": sum(site["geometry"] is None for site in sites),
            "missing_source_date": sum(site["source_updated_at"] is None for site in sites),
            "published_sites": 0,
            "failed_batches": 0,
        }
        if not args.dry_run:
            try:
                summary["published_sites"] = await publish_snapshot(client, args.worker_url, token, snapshots)
            except RefreshError as exc:
                exc.summary = {**summary, **exc.summary}
                raise
        return summary


def main():
    args = build_parser().parse_args()
    try:
        summary = asyncio.run(run(args))
    except Exception as exc:
        summary = {**getattr(exc, "summary", {}), "status": "failed", "error": str(exc), "note": "Source validation finishes before publishing. Failed publish batches roll back; previously committed batches may already be refreshed. Retry the run."}
        code = 1
    else:
        summary["status"] = "success"
        code = 0
    rendered = json.dumps(summary, indent=2)
    print(rendered)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
            stream.write("## Development-site refresh\n\n```json\n" + rendered + "\n```\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
