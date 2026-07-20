#!/usr/bin/env python3
"""
Export all BuildingSeattle permits from the live API to JSONL.
"""
import json, urllib.request, time, sys, os

OUTPUT = "buildingseattle_full_export.jsonl"
API_URL = "https://buildingseattle.com/api/permits?limit=50&page={}"

def main():
    # Check for resume
    processed = set()
    last_page = 0
    if os.path.exists(OUTPUT):
        with open(OUTPUT) as f:
            for line in f:
                try:
                    rec = json.loads(line)
                    processed.add(rec.get("permit_number", ""))
                    last_page = max(last_page, rec.get("_page", 0))
                except:
                    pass
        print(f"Resuming: {len(processed)} records already exported (up to page {last_page})", file=sys.stderr)
    
    page = last_page + 1
    total_exported = len(processed)
    consecutive_empty = 0
    
    while consecutive_empty < 3:
        url = API_URL.format(page)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Hermes/1.0"})
            resp = urllib.request.urlopen(req, timeout=15)
            data = json.loads(resp.read())
            results = data.get("results", [])
            
            if not results:
                consecutive_empty += 1
                print(f"Page {page}: empty (consecutive: {consecutive_empty})", file=sys.stderr)
                page += 1
                time.sleep(0.25)
                continue
            
            consecutive_empty = 0
            new_records = 0
            out = open(OUTPUT, "a")
            for r in results:
                pn = r.get("permit_number", "")
                if pn not in processed:
                    r["_page"] = page
                    out.write(json.dumps(r) + "\n")
                    processed.add(pn)
                    new_records += 1
            out.close()
            
            total_exported += new_records
            if page % 20 == 0:
                print(f"Page {page}: +{new_records} new (total: {total_exported})", file=sys.stderr)
            
            page += 1
            time.sleep(0.2)
            
        except Exception as e:
            print(f"Error page {page}: {e}", file=sys.stderr)
            consecutive_empty += 1
            time.sleep(2)
    
    print(f"\nDone. Total records: {total_exported}", file=sys.stderr)
    print(json.dumps({"total": total_exported}))

if __name__ == "__main__":
    main()
