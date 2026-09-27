#!/usr/bin/env python3
"""Validate and submit Basis Reset Radar candidates to BuildingSeattle."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

EVENT_TYPES = {
    "sale", "listing", "foreclosure", "note_sale", "recapitalization",
    "developer_exit", "jv_solicitation", "permit_ready_sale", "valuation",
}
SOURCE_TYPES = {"public_record", "listing", "news", "manual"}


def validate_candidate(item: dict) -> list[str]:
    errors: list[str] = []
    for field in ("event_type", "event_date", "source_url"):
        if not item.get(field):
            errors.append(f"missing {field}")
    if item.get("event_type") not in EVENT_TYPES:
        errors.append("invalid event_type")
    if item.get("source_type", "manual") not in SOURCE_TYPES:
        errors.append("invalid source_type")
    if not any(item.get(k) for k in ("project_id", "address_id", "address")):
        errors.append("candidate needs project_id, address_id, or address")
    prior = item.get("prior_basis")
    current = item.get("current_basis", item.get("asking_price"))
    if prior is not None and (not isinstance(prior, (int, float)) or prior <= 0):
        errors.append("prior_basis must be positive")
    if current is not None and (not isinstance(current, (int, float)) or current < 0):
        errors.append("current/asking basis must be non-negative")
    confidence = item.get("confidence", 70)
    if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 100:
        errors.append("confidence must be 0..100")
    return errors


def load_candidates(path: Path) -> list[dict]:
    payload = json.loads(path.read_text())
    return payload if isinstance(payload, list) else payload.get("candidates", [])


def submit(base_url: str, token: str, item: dict) -> tuple[int, str]:
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/ingest/basis-reset",
        data=json.dumps(item).encode(),
        headers={"Content-Type": "application/json", "X-Ingest-Token": token},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("file", type=Path)
    parser.add_argument("--base-url", default="http://localhost:8787")
    parser.add_argument("--submit", action="store_true")
    args = parser.parse_args()

    candidates = load_candidates(args.file)
    bad = False
    for index, item in enumerate(candidates, 1):
        errors = validate_candidate(item)
        label = item.get("address") or item.get("project_id") or item.get("address_id")
        if errors:
            bad = True
            print(f"INVALID {index} {label}: " + "; ".join(errors))
            continue
        print(f"VALID   {index} {label}: {item['event_type']} {item['event_date']}")
        if args.submit:
            token = os.environ.get("INGEST_API_TOKEN")
            if not token:
                print("INGEST_API_TOKEN is required with --submit", file=sys.stderr)
                return 2
            status, body = submit(args.base_url, token, item)
            print(f"  -> HTTP {status} {body}")
            if status >= 300:
                bad = True
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
