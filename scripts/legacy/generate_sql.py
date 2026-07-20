#!/usr/bin/env python3
"""
Generate SQL UPDATE statements from enrichment results for D1 batch push.
"""
import json, sys

def sanitize(val):
    """Escape value for SQL, handle None."""
    if val is None:
        return 'NULL'
    # Remove non-numeric characters from value fields, escape strings
    if isinstance(val, (int, float)):
        return str(val)
    s = str(val).replace("'", "''").strip()
    if s == '':
        return 'NULL'
    return f"'{s}'"

def main():
    enrichments = json.load(open('sdci_enrichment_20260705.jsonl')) if len(sys.argv) > 1 else [
        json.loads(line) for line in open('sdci_enrichment_20260705.jsonl')
    ]
    
    # Map enrichment fields to D1 columns
    field_map = {
        'work_location': 'address',
        'project_value': 'value',
        'review_level': 'review_level',
        'primary_property_use': 'primary_property_use',
        'parcel_number': 'parcel_number',
        'project_description': 'detailed_description',
        'work_performed_by': 'work_performed_by',
        'action_type': None,  # no explicit column, but useful
        'record_status': 'record_status_detail',
        'applicant_name': 'applicant_name',
        'owner_name': 'owner_name',
        'building_code': None,
    }
    
    # Fields that map to integer columns
    int_fields = {'project_value': 'value'}
    
    updates = []
    skipped = 0
    
    for rec in enrichments:
        if rec.get('error'):
            skipped += 1
            continue
        
        pn = rec.get('permit_number')
        if not pn:
            skipped += 1
            continue
        
        set_clauses = []
        
        # Map enrichment fields to DB columns
        for enrich_key, db_col in field_map.items():
            if db_col is None:
                continue
            val = rec.get(enrich_key)
            if val is None or val == '':
                continue
            
            # Clean up values that have trailing HTML noise
            # e.g. "Full + Application Completed Date: 04/10/2026..."
            # Take just the first meaningful word/segment
            if enrich_key == 'review_level':
                val = val.split('Application Completed')[0].strip()
                val = val.split('Permit Issued')[0].strip()
                # Known review levels
                for level in ['Full +', 'Full C', 'Full', 'Field', 'Dependent Building']:
                    if val.startswith(level):
                        val = level
                        break
            
            if enrich_key == 'primary_property_use':
                # Clean: "Single Family/Duplex Project Value: 75000..."
                for use in ['Single Family/Duplex', 'Multifamily', 'Commercial', 'Institutional', 'Industrial']:
                    if val.startswith(use):
                        val = use
                        break
            
            if enrich_key == 'work_performed_by':
                for w in ['Licensed Contractor', 'Owner/Lessee', 'Owner']:
                    if val.startswith(w):
                        val = w
                        break
            
            # Handle value fields that need numeric conversion
            if db_col == 'value':
                try:
                    val = int(str(val).replace(',', '').replace('$', ''))
                except:
                    continue
            
            if enrich_key == 'building_code':
                # Clean building code
                for code in ['2021 SEBC', '2021 SBC', '2021 SRC', '2021 SBC (Struct) and SRC (Arch)']:
                    if val.startswith(code):
                        val = code
                        break
            
            set_clauses.append(f"{db_col} = {sanitize(val)}")
        
        if set_clauses:
            sql = f"UPDATE permits SET {', '.join(set_clauses)} WHERE permit_number = '{pn}'"
            updates.append(sql)
    
    # Output in batches of 500 (D1 supports semicolon-separated batches)
    batch_size = 500
    total = len(updates)
    
    for i in range(0, total, batch_size):
        batch = updates[i:i+batch_size]
        sql_block = ";\n".join(batch) + ";"
        
        # Write batch to file
        batch_file = f"sql_batch_{i//batch_size:03d}.sql"
        with open(batch_file, 'w') as f:
            f.write(sql_block)
        print(f"Batch {i//batch_size}: {len(batch)} UPDATEs → {batch_file}")
    
    print(f"\nTotal: {total} UPDATE statements in {(total + batch_size - 1)//batch_size} batches")
    print(f"Skipped: {skipped} records (errors)")

if __name__ == '__main__':
    main()
