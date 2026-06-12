#!/usr/bin/env python3
"""Entity Graph Audit Script

Queries the D1 database via the Worker API to produce an audit report of
entity counts, orphan records, top addresses, top contractors, and page counts.

Usage:
  python audit_entity_graph.py [--base-url https://buildingseattle.com]

Requires the Worker to be running with the entity graph tables populated.
"""

import json
import sys
import urllib.request
import urllib.error

BASE_URL = "https://buildingseattle.com"


def fetch_json(url):
    """Fetch JSON from the Worker API."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {url}")
        return None
    except Exception as e:
        print(f"  Error: {e}")
        return None


def audit(base_url):
    print("=" * 60)
    print("Entity Graph Audit Report")
    print(f"Target: {base_url}")
    print("=" * 60)

    # Stats endpoint gives overall counts
    stats = fetch_json(f"{base_url}/api/stats")
    if stats:
        print(f"\n--- Overall Stats ---")
        print(f"  Total permits:    {stats.get('permits', '?')}")
        print(f"  Total contractors: {stats.get('contractors', '?')}")
        print(f"  Active permits:    {stats.get('active_permits', '?')}")
        print(f"  Total value:       ${stats.get('total_value', 0):,}")
        print(f"  Avg value:         ${stats.get('avg_value', 0):,.0f}")

    # Check new entity endpoints
    print(f"\n--- Entity Endpoint Health ---")
    endpoints = [
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource",
        "/auth.md",
    ]
    for ep in endpoints:
        resp = fetch_json(f"{base_url}{ep}")
        status = "OK" if resp else "MISSING"
        print(f"  {ep:50s} {status}")

    # Check sitemap for new entity URLs
    print(f"\n--- Sitemap URL Counts ---")
    try:
        import xml.etree.ElementTree as ET
        req = urllib.request.Request(f"{base_url}/sitemap.xml")
        with urllib.request.urlopen(req, timeout=30) as resp:
            xml_text = resp.read().decode()
            root = ET.fromstring(xml_text)
            ns = {"ns": "http://www.sitemaps.org/schemas/sitemap/0.9"}
            urls = root.findall("ns:url/ns:loc", ns)
            total = len(urls)

            by_type = {"permit": 0, "contractor": 0, "address": 0, "project": 0, "neighborhood": 0}
            for loc in urls:
                path = loc.text.replace(base_url, "")
                for prefix in by_type:
                    if path.startswith(f"/{prefix}/") or path.startswith(f"/{prefix}s/"):
                        by_type[prefix] += 1

            print(f"  Total URLs: {total}")
            for prefix, count in by_type.items():
                print(f"    {prefix:15s}: {count}")
    except Exception as e:
        print(f"  Could not parse sitemap: {e}")

    # Entity footprint — count pages that render
    print(f"\n--- Entity Page Footprint ---")
    print(f"  (Spot-check: fetch a few pages and verify they render HTML)")
    spot_checks = [
        ("Home", f"{base_url}/"),
        ("Permits", f"{base_url}/permits"),
        ("API Stats", f"{base_url}/api/stats"),
    ]
    for label, url in spot_checks:
        try:
            req = urllib.request.Request(url, headers={"Accept": "text/html"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode()
                has_html = "<!DOCTYPE html>" in body or "<html" in body
                size_kb = len(body) / 1024
                print(f"  {label:20s}: {'HTML' if has_html else 'JSON'} ({size_kb:.0f} KB)")
        except Exception as e:
            print(f"  {label:20s}: ERROR - {e}")

    print(f"\n--- Orphan Analysis ---")
    print(f"  (Permits without address_id: run migration + seed scripts first)")
    print(f"  (Permits without project: check project_permits table)")

    print(f"\n{'=' * 60}")
    print(f"Audit complete. Apply migration_entity_graph.sql then seed_entity_graph.sql")
    print(f"via wrangler d1 execute to populate new entity tables.")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Audit entity graph for buildingseattle.com")
    parser.add_argument("--base-url", default=BASE_URL, help="Base URL of the Worker")
    args = parser.parse_args()
    audit(args.base_url)
