#!/usr/bin/env python3
"""
Push enrichment results to BuildingSeattle Worker ingest endpoint.
"""
import json, requests, time, sys

BATCH_URL = "https://buildingseattle.com/ingest/permit/enrichment/batch"

def push_batch(items, batch_num):
    """Push a batch of enrichment items to the Worker."""
    payload = {"items": items}
    try:
        resp = requests.post(BATCH_URL, json=payload, timeout=30)
        data = resp.json()
        return {
            "batch": batch_num,
            "status": resp.status_code,
            "permits_updated": data.get("permits_updated", 0),
            "contractors_upserted": data.get("contractors_upserted", 0),
        }
    except Exception as e:
        return {"batch": batch_num, "error": str(e)}

def main():
    with open('sdci_enrichment_20260705.jsonl') as f:
        records = [json.loads(line) for line in f if not json.loads(line).get('error')]
    
    # Map enrichment fields to the format expected by the worker
    # (from normalizeEnrichmentItem in worker.js)
    mapped = []
    for r in records:
        item = {
            "permit_number": r.get("permit_number"),
        }
        if r.get("work_location"):
            item["address"] = r["work_location"]
        if r.get("project_value"):
            item["value"] = int(str(r["project_value"]).replace(",", "").replace("$", ""))
        if r.get("review_level"):
            item["review_level"] = r["review_level"].split("Application")[0].split("Permit")[0].strip()
        if r.get("primary_property_use"):
            item["primary_property_use"] = r["primary_property_use"].split("Project")[0].split("LARGE")[0].strip()
        if r.get("parcel_number"):
            item["parcel_number"] = r["parcel_number"]
        if r.get("work_performed_by"):
            item["work_performed_by"] = r["work_performed_by"].split("Contractor")[0].strip()
        if r.get("project_description"):
            item["detailed_description"] = r["project_description"][:500]
        if r.get("record_status"):
            item["record_status_detail"] = r["record_status"]
        if r.get("applicant_name"):
            item["applicant_name"] = r["applicant_name"]
        if r.get("owner_name"):
            item["owner_name"] = r["owner_name"]
        mapped.append(item)
    
    total = len(mapped)
    batch_size = 100
    success = 0
    failures = 0
    
    for i in range(0, total, batch_size):
        batch = mapped[i:i+batch_size]
        bn = i // batch_size
        result = push_batch(batch, bn)
        
        if result.get("error"):
            print(f"Batch {bn}: ✗ {result['error']}", file=sys.stderr)
            failures += 1
        else:
            print(f"Batch {bn}: ✓ {len(batch)} items → {result['permits_updated']} updated, {result['contractors_upserted']} contractors", file=sys.stderr)
            success += 1
        
        time.sleep(0.5)
    
    print(f"\nDone: {success} batches succeeded, {failures} failed", file=sys.stderr)

if __name__ == '__main__':
    main()
