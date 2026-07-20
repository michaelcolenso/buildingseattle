#!/bin/bash
export PATH="/home/openclaw/project-gary/backend/.venv/bin:$PATH"
cd /home/openclaw/projects/buildingseattle
exec python3 << 'PYEOF'
import json, requests, time

TOKEN = None
with open('/home/openclaw/.hermes/config.yaml') as f:
    for line in f:
        if 'Bearer cfa' in line and TOKEN is None:
            TOKEN = line.strip().split('Bearer ')[1]
            break

API = "https://api.cloudflare.com/client/v4/accounts/4e921a01da1f55b0ddb32bb38a5524ce/d1/database/e065e988-045f-42b5-b47a-4027c2e5c417/query"
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

records = [json.loads(line) for line in open('sdci_enrichment_20260705.jsonl') if not json.loads(line).get('error')]

def esc(s, n=500):
    if s is None: return ''
    return str(s).replace("'", "''")[:n]

total = len(records)
batch_size = 100

for i in range(0, total, batch_size):
    batch = records[i:i+batch_size]
    stmts = []
    for r in batch:
        pn = r['permit_number']
        parts = ['last_enriched_at = CURRENT_TIMESTAMP']
        
        if r.get('work_location'): parts.append(f"address = '{esc(r['work_location'], 200)}'")
        if r.get('project_value'):
            try: v = int(str(r['project_value']).replace(',','').replace('$','')); parts.append(f"value = {v}")
            except: pass
        if r.get('review_level'):
            rl = r['review_level'].split('Application')[0].split('Permit')[0].strip()
            parts.append(f"review_level = '{esc(rl, 50)}'")
        if r.get('primary_property_use'):
            pu = r['primary_property_use'].split('Project')[0].split('LARGE')[0].strip()
            parts.append(f"primary_property_use = '{esc(pu, 50)}'")
        if r.get('parcel_number'): parts.append(f"parcel_number = '{r['parcel_number']}'")
        if r.get('project_description'): parts.append(f"detailed_description = '{esc(r['project_description'], 500)}'")
        if r.get('work_performed_by'): parts.append(f"work_performed_by = '{esc(r['work_performed_by'], 100)}'")
        if r.get('record_status'): parts.append(f"record_status_detail = '{esc(r['record_status'], 100)}'")
        
        stmts.append(f"UPDATE permits SET {', '.join(parts)} WHERE permit_number = '{pn}';")
    
    sql = '\n'.join(stmts)
    try:
        resp = requests.post(API, json={"sql": sql}, headers=HEADERS, timeout=30)
        data = resp.json()
        if data.get('success'):
            print(f"[{i//batch_size}] ✓ {len(stmts)} records")
        else:
            err = data.get('errors',[{}])[0]
            print(f"[{i//batch_size}] ✗ {err.get('code')}: {err.get('message','')[:100]}")
    except Exception as e:
        print(f"[{i//batch_size}] ✗ {e}")
    time.sleep(0.2)

print(f"\nDone: {total} records pushed")
PYEOF
