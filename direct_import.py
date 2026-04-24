#!/usr/bin/env python3
# direct_import.py - Import scraped permits and contractors into Worker API

import asyncio
import argparse
import httpx
import json
import os

CF_WORKER_URL = "http://localhost:8787"  # Default to local dev; pass URL as arg for prod
BATCH_SIZE = 100


def read_dev_var(name, path=".dev.vars"):
    """Read one key from a local Wrangler .dev.vars file."""
    try:
        with open(path, "r") as f:
            for line in f:
                stripped = line.strip()
                if not stripped or stripped.startswith("#") or "=" not in stripped:
                    continue
                key, value = stripped.split("=", 1)
                if key.strip() == name:
                    return value.strip().strip("\"'")
    except FileNotFoundError:
        return None
    return None


def ingest_headers():
    """Build optional ingest auth headers from env or local Wrangler vars."""
    token = os.environ.get("INGEST_API_TOKEN") or read_dev_var("INGEST_API_TOKEN")
    if not token:
        return None
    return {"X-Ingest-Token": token}


def build_parser():
    """Build command-line arguments for data imports."""
    parser = argparse.ArgumentParser(description="Import scraped Seattle permit data into the Worker API.")
    parser.add_argument(
        "url",
        nargs="?",
        default=CF_WORKER_URL,
        help=f"Worker base URL. Defaults to {CF_WORKER_URL}.",
    )
    parser.add_argument(
        "--replace-all",
        action="store_true",
        help="Clear imported permits and contractors before importing the local JSONL files.",
    )
    return parser


def load_jsonl(path):
    """Load newline-delimited JSON records from disk."""
    with open(path, "r") as f:
        return [json.loads(line.strip()) for line in f if line.strip()]


def chunk_items(items, batch_size):
    """Yield fixed-size slices from an in-memory list."""
    for idx in range(0, len(items), batch_size):
        yield items[idx : idx + batch_size]


async def import_batch_items(client, url, endpoint, items, label, batch_size):
    """Import records using the Worker batch endpoints."""
    total = len(items)
    if total == 0:
        print(f"\nNo {label} to import")
        return 0

    print(f"\nImporting {total} {label} in batches of {batch_size}...")
    success = 0
    failed = 0
    batches = list(chunk_items(items, batch_size))
    headers = ingest_headers()

    for idx, batch in enumerate(batches, start=1):
        try:
            response = await client.post(
                f"{url}{endpoint}",
                json={"items": batch},
                timeout=60.0,
                headers=headers,
            )
            if response.status_code == 200:
                payload = response.json()
                processed = min(payload.get("processed", len(batch)), len(batch))
                success += processed
                if idx <= 3 or idx == len(batches) or idx % 10 == 0:
                    print(f"  Batch {idx}/{len(batches)}: {processed}/{len(batch)} {label} processed")
            else:
                failed += len(batch)
                if failed <= batch_size * 2:
                    print(f"  Failed batch {idx}/{len(batches)} - HTTP {response.status_code}: {response.text[:100]}")
        except Exception as e:
            failed += len(batch)
            if failed <= batch_size * 2:
                print(f"  Error batch {idx}/{len(batches)} - {e}")

    print(f"  {label.capitalize()} imported: {success}/{total}")
    if failed:
        print(f"  Failed: {failed}")
    return success


async def replace_all_data(client, url):
    """Request a guarded full refresh before importing data."""
    print("\nClearing imported permits and contractors before import...")
    response = await client.post(
        f"{url}/ingest/refresh",
        json={"confirm": "replace-all"},
        timeout=60.0,
        headers=ingest_headers(),
    )
    if response.status_code != 200:
        raise RuntimeError(f"Full refresh failed - HTTP {response.status_code}: {response.text[:200]}")

    payload = response.json()
    print(
        "  Cleared "
        f"{payload.get('permits_deleted', 0)} permits and "
        f"{payload.get('contractors_deleted', 0)} contractors"
    )


async def import_contractors(client, url, batch_size=BATCH_SIZE):
    """Import contractors from seattle_contractors.jsonl."""
    try:
        contractors = load_jsonl("seattle_contractors.jsonl")
    except FileNotFoundError:
        print("No seattle_contractors.jsonl found, skipping contractor import")
        return 0

    return await import_batch_items(
        client,
        url,
        "/ingest/contractor/batch",
        contractors,
        "contractors",
        batch_size,
    )


async def import_permits(client, url, batch_size=BATCH_SIZE):
    """Import permits from seattle_permits.jsonl."""
    permits = load_jsonl("seattle_permits.jsonl")

    return await import_batch_items(
        client,
        url,
        "/ingest/permit/batch",
        permits,
        "permits",
        batch_size,
    )


async def main():
    args = build_parser().parse_args()
    url = args.url
    print(f"Importing to: {url}")

    async with httpx.AsyncClient() as client:
        if args.replace_all:
            await replace_all_data(client, url)
        await import_contractors(client, url)
        await import_permits(client, url)

    print(f"\nVerify at: {url}/api/permits")
    print(f"Stats at:  {url}/api/stats")


if __name__ == "__main__":
    asyncio.run(main())
