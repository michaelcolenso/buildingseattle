#!/usr/bin/env python3
"""Daily enrichment: top up un-enriched permits from production D1.

Pulls permit_numbers with NULL parcel_number from D1 via the Cloudflare
API, then runs the existing sdci_detail_probe + sdci_enrich pipeline in
chunks. POSTs results to the Worker's /ingest/permit/enrichment/batch
endpoint, which writes back to D1.

Intended to run from .github/workflows/enrich-daily.yml an hour after
the Worker's scheduled SDCI ingest, so new permits are enriched the
same day they land.

Required environment:
  CLOUDFLARE_ACCOUNT_ID  Cloudflare account ID
  CLOUDFLARE_API_TOKEN   Token with D1 read scope for the buildingseattle DB
  INGEST_API_TOKEN       Token expected by the Worker /ingest endpoints
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from direct_import import ingest_headers, post_batch_with_retries  # noqa: E402
from sdci_detail_probe import enrich_with_license_data, run_probe  # noqa: E402
from sdci_enrich import flatten_enrichment  # noqa: E402

DEFAULT_DB_ID = "e065e988-045f-42b5-b47a-4027c2e5c417"
DEFAULT_WORKER_URL = "https://buildingseattle.aged-morning-c8e4.workers.dev"
ENRICH_ENDPOINT = "/ingest/permit/enrichment/batch"


async def d1_query(account_id, db_id, token, sql):
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{db_id}/query"
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            url,
            headers={"Authorization": f"Bearer {token}"},
            json={"sql": sql},
        )
        response.raise_for_status()
        return response.json()["result"][0]["results"]


async def post_chunk(client, worker_url, items, batch_size, retries):
    headers = ingest_headers()
    if not headers:
        raise RuntimeError("INGEST_API_TOKEN is not set")
    processed = 0
    for idx in range(0, len(items), batch_size):
        batch = items[idx : idx + batch_size]
        response = await post_batch_with_retries(
            client, worker_url, ENRICH_ENDPOINT, batch, headers, retries
        )
        if response.status_code != 200:
            raise RuntimeError(
                f"Post failed - HTTP {response.status_code}: {response.text[:200]}"
            )
        processed += response.json().get("processed", len(batch))
    return processed


def build_parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--limit",
        type=int,
        default=300,
        help="Max permits to enrich this run. Default 300.",
    )
    p.add_argument(
        "--chunk-size",
        type=int,
        default=200,
        help="Permits per probe chunk. Default 200.",
    )
    p.add_argument(
        "--concurrency",
        type=int,
        default=3,
        help="Concurrent SDCI/L&I requests per chunk. Default 3 (polite; we have been throttled at 6).",
    )
    p.add_argument(
        "--post-batch",
        type=int,
        default=50,
        help="Records per /ingest POST batch. Default 50.",
    )
    p.add_argument(
        "--retries",
        type=int,
        default=4,
        help="Retries per /ingest POST. Default 4.",
    )
    p.add_argument(
        "--sleep",
        type=float,
        default=5.0,
        help="Seconds to sleep between chunks. Default 5.",
    )
    p.add_argument(
        "--worker-url",
        default=os.environ.get("WORKER_URL", DEFAULT_WORKER_URL),
        help="Worker base URL.",
    )
    p.add_argument(
        "--db-id",
        default=os.environ.get("BUILDINGSEATTLE_D1_ID", DEFAULT_DB_ID),
        help="D1 database ID.",
    )
    return p


async def main():
    args = build_parser().parse_args()

    account_id = os.environ["CLOUDFLARE_ACCOUNT_ID"].strip()
    token = os.environ["CLOUDFLARE_API_TOKEN"]

    sql = (
        "SELECT permit_number FROM permits "
        "WHERE parcel_number IS NULL AND permit_number IS NOT NULL "
        "ORDER BY issued_date DESC NULLS LAST "
        f"LIMIT {int(args.limit)}"
    )
    rows = await d1_query(account_id, args.db_id, token, sql)
    permits = [r["permit_number"] for r in rows if r["permit_number"]]
    total = len(permits)
    print(f"to enrich: {total} (limit={args.limit})", flush=True)

    if not total:
        print("DONE: nothing to enrich", flush=True)
        return

    total_posted = 0
    total_licenses = 0
    total_errors = 0

    async with httpx.AsyncClient(timeout=120.0) as client:
        for i in range(0, total, args.chunk_size):
            chunk = permits[i : i + args.chunk_size]
            chunk_num = i // args.chunk_size + 1
            chunk_total = (total + args.chunk_size - 1) // args.chunk_size

            results = await run_probe(chunk, args.concurrency)
            results = await enrich_with_license_data(results, args.concurrency)
            ok = [r for r in results if "error" not in r]
            errors = len(results) - len(ok)
            flat = [flatten_enrichment(r) for r in ok]
            licenses = sum(1 for f in flat if f.get("contractor_license"))

            try:
                posted = await post_chunk(
                    client, args.worker_url, flat, args.post_batch, args.retries
                )
            except Exception as exc:
                print(
                    f"chunk {chunk_num}/{chunk_total} post FAILED: {exc}",
                    flush=True,
                )
                total_errors += len(chunk)
                continue

            total_posted += posted
            total_licenses += licenses
            total_errors += errors
            print(
                f"chunk {chunk_num}/{chunk_total}: probed {len(ok)}/{len(chunk)}, "
                f"posted {posted}, licenses {licenses}, "
                f"running totals: posted={total_posted} licenses={total_licenses} errors={total_errors}",
                flush=True,
            )

            if i + args.chunk_size < total and args.sleep > 0:
                await asyncio.sleep(args.sleep)

    print(
        f"DONE: posted {total_posted}/{total}, licenses {total_licenses}, errors {total_errors}",
        flush=True,
    )


if __name__ == "__main__":
    asyncio.run(main())
