#!/usr/bin/env python3
"""
BuildingSeattle SDCI Enrichment Scraper v4
Text-based extraction from ASP.NET portal (the data is all there, just in complex tables).
"""
import json, sys, time, re
import requests


def extract_detail(permit_number):
    """Scrape SDCI detail page — extract using text patterns."""
    url = f"https://services.seattle.gov/portal/customize/LinkToRecord.aspx?altId={permit_number}"
    
    result = {
        'permit_number': permit_number,
        'detail_url': url,
        'extracted_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
    }

    try:
        session = requests.Session()
        session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        })
        
        resp = session.get(url, timeout=30, allow_redirects=True)
        html = resp.text
        
        if len(html) < 200:
            result['error'] = 'empty_response'
            return result

        # --- Strip HTML to get visible text, preserving structure ---
        # Remove scripts, styles
        cleaned = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL)
        cleaned = re.sub(r'<style[^>]*>.*?</style>', '', cleaned, flags=re.DOTALL)
        
        # Extract all visible text with context
        # Remove all HTML tags but keep their text content
        visible_text = re.sub(r'<[^>]+>', '\n', cleaned)
        visible_text = re.sub(r'\n\s*\n', '\n', visible_text)
        lines = [l.strip() for l in visible_text.split('\n') if l.strip()]
        
        # Build a text block for pattern matching
        full_text = ' '.join(lines)
        
        # --- Record header info ---
        # Record Number, Type, Status, Expiration
        for i, line in enumerate(lines):
            if line.startswith('Record Number:'):
                result['record_number_from_page'] = line.replace('Record Number:', '').strip()
            elif line == 'Construction Permit' or line == 'Demolition Permit' or 'Permit' in line and len(line) < 30:
                if i > 0 and 'Record Number' in lines[i-1]:
                    pass
                elif any(pt in line for pt in ['Construction Permit', 'Demolition Permit', 'Blanket', 'Shoring', 'Grading']):
                    if i < len(lines) - 1 and not lines[i+1].startswith('Record'):
                        result['record_type'] = line
            elif line.startswith('Record Status:'):
                result['record_status'] = line.replace('Record Status:', '').strip()
            elif line.startswith('Expiration Date:'):
                result['expiration_date'] = line.replace('Expiration Date:', '').strip()

        # --- Work Location ---
        loc = ''
        for i, line in enumerate(lines):
            if line == 'Work Location' and i + 1 < len(lines):
                # Next line should be the address
                for j in range(i+1, min(i+5, len(lines))):
                    if lines[j] and not lines[j].startswith('Record') and len(lines[j]) > 5:
                        loc = lines[j]
                        break
        if loc:
            result['work_location'] = loc

        # --- Fields from the record detail table ---
        # These appear as "Label: Value" patterns
        field_patterns = [
            (r'Project Value\s*:\s*([0-9,]+)', 'project_value'),
            (r'Review Level\s*:\s*([^\n]+)', 'review_level'),
            (r'Action Type\s*:\s*([^\n]+)', 'action_type'),
            (r'Choose the Primary Property Use\s*:\s*([^\n]+)', 'primary_property_use'),
            (r'Intake Value:\s*New\s*:\s*([0-9,]+)', 'intake_value_new'),
            (r'Intake Value:\s*Alteration\s*:\s*([0-9,]+)', 'intake_value_alteration'),
            (r'Issue Value:\s*New\s*:\s*([0-9,]+)', 'issue_value_new'),
            (r'Issue Value:\s*Alteration\s*:\s*([0-9,]+)', 'issue_value_alteration'),
            (r'Total Intake Value\s*:\s*([0-9,]+)', 'total_intake_value'),
            (r'Total Issued Value\s*:\s*([0-9,]+)', 'total_issued_value'),
            (r'Application Completed Date\s*:\s*([0-9/]+)', 'application_completed_date'),
            (r'Permit Issued Date\s*:\s*([0-9/]+)', 'permit_issued_date'),
            (r'[Ww]hat building code was used[^:]*:\s*([^\n]+)', 'building_code'),
            (r'Specific Building Code\s*:\s*([^\n]+)', 'specific_building_code'),
            (r'Compliance Category\s*:\s*([^\n]+)', 'compliance_category'),
            (r'Where on your property are you working\s*:\s*([^\n]+)', 'work_location_detail'),
            (r'Who will be performing all the work\s*:\s*([^\n]+)', 'work_performed_by'),
            (r'Action Type\s*:\s*([^\n]+)', 'action_type'),
            (r'Actual Construction Value\s*:\s*([0-9,]+)', 'actual_construction_value'),
            (r'Total Area of Work[^:]*:\s*([0-9,]+)', 'total_area_sqft'),
        ]
        
        for pattern, key in field_patterns:
            match = re.search(pattern, full_text, re.IGNORECASE)
            if match:
                val = match.group(1).strip()
                if val and val != ':':
                    result[key] = val

        # --- Parcel Number ---
        # Format: "Development Site Parcel:XXXXXXXXX"
        p_match = re.search(r'[Pp]arcel[^:]*:\s*([A-Z0-9]{5,15})', full_text)
        if p_match:
            result['parcel_number'] = p_match.group(1)

        # --- Project Description ---
        # Look for text between "Project Description" and "Contacts"
        desc_match = re.search(r'Project Description\s*([^\n]+(?:\n[^\n]+){0,5})\s*Contacts', html, re.DOTALL)
        if desc_match:
            desc_text = re.sub(r'<[^>]+>', ' ', desc_match.group(1))
            desc_text = re.sub(r'\s+', ' ', desc_text).strip()
            if desc_text:
                result['project_description'] = desc_text

        # --- Contacts section ---
        contacts_match = re.search(r'Contacts(.*?)(?:Application Information|Other Information)', html, re.DOTALL)
        if contacts_match:
            contacts_html = contacts_match.group(1)
            # Extract text from the contacts area
            contact_text = re.sub(r'<[^>]+>', '\n', contacts_html)
            contact_lines = [l.strip() for l in contact_text.split('\n') if l.strip() and len(l.strip()) > 1]
            
            for i, line in enumerate(contact_lines):
                if line == 'Applicant' and i + 1 < len(contact_lines):
                    result['applicant_name'] = contact_lines[i + 1]
                    # Next few lines are address
                    addr_parts = []
                    for j in range(i+2, min(i+5, len(contact_lines))):
                        if contact_lines[j] not in ('Owner', 'Contractor', '') and not contact_lines[j].startswith('http'):
                            addr_parts.append(contact_lines[j])
                        else:
                            break
                    if addr_parts:
                        result['applicant_address'] = ', '.join(addr_parts)
                elif line == 'Owner' and i + 1 < len(contact_lines):
                    result['owner_name'] = contact_lines[i + 1]
                    # Owner address
                    addr_parts = []
                    for j in range(i+2, min(i+5, len(contact_lines))):
                        if contact_lines[j] not in ('Contractor', '') and not contact_lines[j].startswith('http'):
                            addr_parts.append(contact_lines[j])
                        else:
                            break
                    if addr_parts:
                        result['owner_address'] = ', '.join(addr_parts)
                elif line == 'Contractor' and i + 1 < len(contact_lines):
                    result['sdci_contractor_name'] = contact_lines[i + 1]

        result['page_size'] = len(html)
        return result

    except requests.exceptions.Timeout:
        return {'permit_number': permit_number, 'error': 'timeout', 'detail_url': url}
    except Exception as e:
        return {'permit_number': permit_number, 'error': f'{type(e).__name__}: {str(e)[:200]}', 'detail_url': url}


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', '-i', required=True)
    parser.add_argument('--output', '-o', default='sdci_enrichment_results.jsonl')
    parser.add_argument('--limit', '-n', type=int, default=None)
    parser.add_argument('--delay', '-d', type=float, default=1.0)
    parser.add_argument('--resume', '-r', action='store_true')
    args = parser.parse_args()

    permits = json.load(open(args.input))
    if args.limit:
        permits = permits[:args.limit]

    processed = set()
    if args.resume:
        try:
            with open(args.output) as f:
                for line in f:
                    rec = json.loads(line)
                    processed.add(rec.get('permit_number'))
            print(f"Resuming: {len(processed)} already processed", file=sys.stderr)
        except FileNotFoundError:
            pass

    total = len(permits)
    success = errors = 0
    out = open(args.output, 'a')

    for i, p in enumerate(permits):
        pn = p.get('permit_number') or p.get('permitnum') or ''
        if isinstance(pn, dict):
            pn = pn.get('permit_number', '')
        if not pn or pn in processed:
            continue

        result = extract_detail(pn)
        out.write(json.dumps(result) + '\n')
        out.flush()

        if result.get('error'):
            errors += 1
            print(f"[{i+1}/{total}] ✗ {pn}: {result['error']}", file=sys.stderr)
        else:
            fields = [k for k in result if k not in ('permit_number','detail_url','extracted_at','page_size','error')]
            success += 1
            print(f"[{i+1}/{total}] ✓ {pn} ({len(fields)} fields: {', '.join(fields[:8])})", file=sys.stderr)

        time.sleep(args.delay)

    out.close()
    print(f"\nDone: {success} enriched, {errors} errors, {len(processed)} skipped", file=sys.stderr)


if __name__ == '__main__':
    main()
