#!/usr/bin/env python3
"""Read selected public entity tables using the existing Actions D1 credential.

Fixed SELECT statements only. No ingest endpoints, subscriber tables, request
referrers, credential values, or mutations. Output is a generated artifact.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
import re

TABLES = {
    "permits": "*",
    "addresses": "*",
    "projects": "*",
    "people_orgs": "*",
    "project_permits": "*",
    "permit_participants": "*",
    "project_participants": "*",
    "neighborhoods": "*",
    "address_neighborhoods": "*",
    "contractors": "id, name, slug, specialty, description, license_number, created_at, updated_at",
}
ORDER_KEYS = {
    "project_permits": "project_id, permit_id",
    "permit_participants": "permit_id, people_org_id, role",
    "project_participants": "project_id, people_org_id, role",
    "address_neighborhoods": "address_id, neighborhood_id",
}
DB_ID = "e065e988-045f-42b5-b47a-4027c2e5c417"


def now():
    return datetime.now(timezone.utc).isoformat()


def main():
    root = Path(sys.argv[1])
    root.mkdir(parents=True, exist_ok=True)
    account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    endpoint = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{DB_ID}/query"
    queries = []

    def query(sql, params=None):
        assert sql.lstrip().upper().startswith("SELECT ")
        payload = {"sql": sql, "params": params or []}
        req = urllib.request.Request(endpoint, data=json.dumps(payload).encode(), headers={
            "Authorization": f"Bearer {token}", "Content-Type": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=90) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            # Only sanitized provider error fields, never request headers.
            try:
                errors = json.load(error).get("errors", [])
                detail = json.dumps(errors)[:1500].replace(token, "[redacted]").replace(account, "[account]")
            except (ValueError, AttributeError):
                detail = "No structured error"
            raise RuntimeError(f"D1 read failed: HTTP {error.code}; {detail}") from None
        if not result.get("success") or not result.get("result") or not result["result"][0].get("success", True):
            raise RuntimeError("D1 reported an unsuccessful read")
        queries.append({"sql": sql, "params": params or [], "observed_at": now(),
                        "meta": result["result"][0].get("meta")})
        return result["result"][0]["results"]

    def stats():
        # D1's compound-SELECT limit is lower than desktop SQLite's.
        return [query(f"SELECT '{table}' AS table_name, COUNT(*) AS n FROM {table}")[0]
                for table in TABLES]

    started = now()
    schema = query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (" + ",".join("?" for _ in TABLES) + ")", list(TABLES))
    (root / "schema.json").write_text(json.dumps(schema, indent=2) + "\n")
    before = stats()
    hashes = {}
    for table, columns in TABLES.items():
        rows = []
        while True:
            batch = query(f"SELECT {columns} FROM {table} ORDER BY {ORDER_KEYS.get(table, 'id')} LIMIT 1000 OFFSET ?", [len(rows)])
            if not batch:
                break
            rows.extend(batch)
        body = (json.dumps(rows, ensure_ascii=False) + "\n").encode()
        (root / f"{table}.json").write_bytes(body)
        hashes[table] = {"rows": len(rows), "sha256": hashlib.sha256(body).hexdigest()}
        print(f"Captured {table}: {len(rows)} rows", flush=True)
    # Non-sensitive operational outcomes; raw error text and request logs are
    # deliberately not uploaded to this public repository's Actions artifacts.
    ingest = query("SELECT run_type, source, status, records_added, records_updated, start_time, end_time, CASE WHEN error_message IS NULL THEN NULL WHEN error_message LIKE '%Too many%' THEN 'resource_limit' WHEN error_message LIKE '%timeout%' THEN 'timeout' ELSE 'other_error' END AS error_class FROM ingest_logs ORDER BY id DESC LIMIT 120")
    (root / "ingest_outcomes.json").write_text(json.dumps(ingest, indent=2) + "\n")
    after = stats()
    manifest = {"started_at": started, "finished_at": now(), "database_id": DB_ID,
                "source_commit": os.environ.get("GITHUB_SHA"), "before": before, "after": after,
                "population_stable": before == after, "tables": hashes, "queries": queries,
                "transactional_snapshot": False,
                "limitations": ["Count stability does not exclude in-place updates or offset drift",
                                "No credentials or private subscriber/request records exported"]}
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if before != after:
        raise RuntimeError("Entity populations changed during capture")
    capture_graph_logs(root, account, token)


def capture_graph_logs(root, account, token):
    """Try the same credential for graph errors; record scope denial explicitly."""
    base = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/observability/telemetry/"
    end = int(datetime.now(timezone.utc).timestamp() * 1000)
    timeframe = {"from": end - 7 * 86400000, "to": end}
    receipt = {"observed_at": now(), "timeframe": timeframe, "scope": "graph error events only"}

    def post(endpoint, payload):
        req = urllib.request.Request(base + endpoint, data=json.dumps(payload).encode(), headers={
            "Authorization": f"Bearer {token}", "Content-Type": "application/json",
        })
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.load(response)

    try:
        keys = post("keys", {**timeframe, "limit": 1000, "datasets": []})
        receipt["available_keys"] = keys.get("result")
        # The official SDK documents $metadata.service and needle. Discovery
        # above is retained so field availability can be verified independently.
        query = {"queryId": "bs-index-selection-graph-errors", "dry": True,
                 "timeframe": timeframe, "view": "events", "limit": 1000,
                 "parameters": {"datasets": [], "filters": [
                     {"key": "$metadata.service", "operation": "eq", "type": "string", "value": "buildingseattle"}],
                     "needle": {"value": "Entity graph", "matchCase": False}}}
        result = post("query", query).get("result", {})
        receipt["query"] = query
        events = result.get("events", {})
        receipt["provider_count"] = events.get("count")
        receipt["events"] = []
        for event in events.get("events", []):
            meta = event.get("$metadata", {})
            workers = event.get("$workers", {})
            row = {"timestamp": event.get("timestamp"),
                   "metadata": {k: meta[k] for k in ("id", "service", "origin", "message", "error", "level", "requestId") if k in meta},
                   "workers": {k: workers[k] for k in ("eventType", "outcome", "scriptVersion", "truncated") if k in workers}}
            # Keep error evidence, excluding all request headers and bodies.
            text = json.dumps(row).replace(token, "[redacted]").replace(account, "[account]")
            text = re.sub(r"(?i)bearer\s+[a-z0-9._-]+", "Bearer [redacted]", text)
            receipt["events"].append(json.loads(text))
        receipt["returned_count"] = len(receipt["events"])
        receipt["complete"] = receipt["provider_count"] == receipt["returned_count"]
        print(f"Graph log events returned: {receipt['returned_count']}", flush=True)
    except urllib.error.HTTPError as error:
        receipt["access_error"] = f"HTTP {error.code}"
        print(f"Graph telemetry unavailable: HTTP {error.code}", flush=True)
    (root / "graph_telemetry.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
