#!/usr/bin/env python3
"""
Generate the final BuildingSeattle CSV from the full API export.
"""
import json, csv, sys

def main():
    records = []
    seen = set()
    
    # Read full export (JSONL)
    with open('buildingseattle_full_export.jsonl') as f:
        for line in f:
            try:
                r = json.loads(line)
                pn = r.get('permit_number', '')
                if pn and pn not in seen:
                    seen.add(pn)
                    # Remove internal fields
                    r.pop('_page', None)
                    records.append(r)
            except:
                pass
    
    print(f"Unique records: {len(records)}", file=sys.stderr)
    
    if not records:
        print("No records!", file=sys.stderr)
        sys.exit(1)
    
    # Define output columns (ordered for readability)
    columns = [
        'permit_number', 'address', 'neighborhood', 'type', 'value', 'status',
        'description', 'detailed_description',
        'applied_date', 'issued_date', 'completed_date', 'expires_date',
        'plan_review_complete_date', 'ready_to_issue_date',
        'contractor_name', 'contractor_specialty', 'contractor_license',
        'contractor_phone', 'contractor_email',
        'owner_name', 'owner_address', 'applicant_name',
        'housing_units', 'housing_units_added', 'housing_units_removed',
        'housing_category', 'dwelling_unit_type',
        'review_level', 'primary_property_use', 'work_performed_by',
        'parcel_number', 'zoning',
        'number_review_cycles', 'total_days_plan_review', 'days_out_corrections',
        'has_required_inspections', 'has_completed_inspections',
        'permit_detail_url', 'record_status_detail',
        'lat', 'lng', 'zip',
    ]
    
    # Write CSV
    with open('buildingseattle_permits.csv', 'w', newline='', encoding='utf-8') as out:
        writer = csv.DictWriter(out, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(records)
    
    print(f"Wrote {len(records)} records to buildingseattle_permits.csv", file=sys.stderr)
    
    # Stats
    total_value = sum(r.get('value', 0) or 0 for r in records)
    neighborhoods = len(set(r.get('neighborhood', '') for r in records if r.get('neighborhood')))
    print(f"Total value: ${total_value:,.0f}", file=sys.stderr)
    print(f"Neighborhoods: {neighborhoods}", file=sys.stderr)

if __name__ == '__main__':
    main()
