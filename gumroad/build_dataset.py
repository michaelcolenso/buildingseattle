#!/usr/bin/env python3
"""One-command reproducible build for the Gumroad dataset products.

Rebuilds every shipped artifact from a fresh snapshot of the production
database:

  gumroad/buildingseattle_permits.csv   full export, 32 columns
  gumroad/buildingseattle_sample.csv    100 rows (top-25 by value + 75 random, seed-pinned)
  gumroad/contractors.csv               contractor aggregate (no empty columns)
  gumroad/data-dictionary.md            stats/version sections regenerated in place
  gumroad/VERSION.txt                   version, counts, totals, SHA256 checksums
  gumroad/CHANGELOG.md                  entry prepended for this version
  gumroad/dist/buildingseattle-permits-YYYY-MM_foundation.zip
  gumroad/dist/buildingseattle-permits-YYYY-MM_pro.zip

Data sources (picked automatically, or force with --source):
  d1    Cloudflare D1 REST API snapshot — keyset-paginated on permit_number,
        immune to row drift while the daily 13:00 UTC ingest runs.
        Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (D1 read scope);
        BUILDINGSEATTLE_D1_ID overrides the default database ID.
  api   Public /api/permits pagination at per_page=100. Fallback when no
        Cloudflare credentials are available; dedupes by permit_number.

Usage:
  python3 gumroad/build_dataset.py                 # d1 if creds present, else api
  python3 gumroad/build_dataset.py --source api
  python3 gumroad/build_dataset.py --version 2026-08
"""

import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from columns import (  # noqa: E402
    CONTRACTOR_COLUMNS,
    PERMIT_COLUMNS,
    SAMPLE_RANDOM_SEED,
    SAMPLE_SIZE,
    SAMPLE_TOP_BY_VALUE,
)

GUMROAD_DIR = Path(__file__).resolve().parent
DEFAULT_DB_ID = "e065e988-045f-42b5-b47a-4027c2e5c417"
API_BASE = "https://buildingseattle.com"
USER_AGENT = "BuildingSeattle-Build/1.0"
D1_PAGE_SIZE = 1000
API_PER_PAGE = 100
MAX_RETRIES = 4
RETRY_BASE_DELAY = 2.0

PERMIT_SELECT = (
    "SELECT p.permit_number, p.address, p.neighborhood, p.type, p.value, p.status, "
    "p.description, p.detailed_description, p.applied_date, p.issued_date, "
    "p.completed_date, p.expires_date, p.plan_review_complete_date, p.ready_to_issue_date, "
    "c.name AS contractor_name, c.specialty AS contractor_specialty, p.contractor_license, "
    "p.housing_units, p.housing_units_added, p.housing_units_removed, p.housing_category, "
    "p.review_level, p.primary_property_use, p.work_performed_by, p.parcel_number, "
    "p.number_review_cycles, p.total_days_plan_review, p.days_out_corrections, "
    "p.has_required_inspections, p.has_completed_inspections, p.permit_detail_url, "
    "p.record_status_detail "
    "FROM permits p LEFT JOIN contractors c ON p.contractor_id = c.id "
    "WHERE p.permit_number IS NOT NULL"
)


# ---------------------------------------------------------------- fetching

def http_json(url, payload=None, headers=None, timeout=120):
    body = json.dumps(payload).encode() if payload is not None else None
    base_headers = {"User-Agent": USER_AGENT}
    if payload is not None:
        base_headers["Content-Type"] = "application/json"
    base_headers.update(headers or {})
    last = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(url, data=body, headers=base_headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            # Retry rate limits and transient server errors; fail fast otherwise.
            if e.code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES:
                last = e
            else:
                raise
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            last = e
            if attempt >= MAX_RETRIES:
                raise
        delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))
        sys.stderr.write(f"  retry {attempt}/{MAX_RETRIES - 1} in {delay:.0f}s ({last})\n")
        time.sleep(delay)
    raise RuntimeError(f"unreachable: {last}")


def fetch_permits_d1(account_id, token, db_id):
    """Keyset-paginate the full permit join out of D1 ordered by permit_number."""
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{db_id}/query"
    records = []
    cursor = ""
    while True:
        sql = (
            f"{PERMIT_SELECT} AND p.permit_number > ? "
            f"ORDER BY p.permit_number LIMIT {D1_PAGE_SIZE}"
        )
        data = http_json(url, payload={"sql": sql, "params": [cursor]},
                         headers={"Authorization": f"Bearer {token}"})
        rows = data["result"][0]["results"]
        records.extend(rows)
        sys.stderr.write(f"  d1: {len(records)} rows\n")
        if len(rows) < D1_PAGE_SIZE:
            return records
        cursor = rows[-1]["permit_number"]


def fetch_permits_api(base=API_BASE):
    """Fallback: public API pagination. Dedupes by permit_number."""
    records, seen = [], set()
    page = 1
    while True:
        data = http_json(f"{base}/api/permits?per_page={API_PER_PAGE}&page={page}")
        results = data.get("results", [])
        if not results:
            return records
        for r in results:
            pn = r.get("permit_number")
            if pn and pn not in seen:
                seen.add(pn)
                records.append(r)
        sys.stderr.write(f"  api page {page}: {len(records)} unique rows\n")
        if len(results) < API_PER_PAGE:
            return records
        page += 1
        time.sleep(0.15)


def fetch_d1_permit_count(account_id, token, db_id):
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{db_id}/query"
    data = http_json(url, payload={"sql": "SELECT COUNT(*) AS n FROM permits WHERE permit_number IS NOT NULL"},
                     headers={"Authorization": f"Bearer {token}"})
    return data["result"][0]["results"][0]["n"]


# ------------------------------------------------------------ derivations

def normalize_permit(record):
    """Project a raw row (D1 or API) onto the 32-column contract."""
    return {col: record.get(col) for col in PERMIT_COLUMNS}


def build_sample(records):
    """Stratified sample: top-N by value plus a seed-pinned random draw."""
    by_value = sorted(records, key=lambda r: (-(r.get("value") or 0), r["permit_number"]))
    top = by_value[:SAMPLE_TOP_BY_VALUE]
    top_keys = {r["permit_number"] for r in top}
    rest = sorted((r for r in records if r["permit_number"] not in top_keys),
                  key=lambda r: r["permit_number"])
    rng = random.Random(SAMPLE_RANDOM_SEED)
    draw = rng.sample(rest, min(SAMPLE_SIZE - len(top), len(rest)))
    return top + sorted(draw, key=lambda r: r["permit_number"])


def derive_contractors(records):
    """Aggregate contractor rows from the permit snapshot (count + total value).

    Grouped by contractor name; license/specialty take the most common
    non-empty value seen across that contractor's permits.
    """
    groups = {}
    for r in records:
        name = (r.get("contractor_name") or "").strip()
        if not name:
            continue
        g = groups.setdefault(name, {"licenses": Counter(), "specialties": Counter(),
                                     "count": 0, "value": 0})
        g["count"] += 1
        g["value"] += r.get("value") or 0
        if r.get("contractor_license"):
            g["licenses"][r["contractor_license"]] += 1
        if r.get("contractor_specialty"):
            g["specialties"][r["contractor_specialty"]] += 1
    rows = []
    for name, g in groups.items():
        rows.append({
            "contractor_name": name,
            "license_number": g["licenses"].most_common(1)[0][0] if g["licenses"] else "",
            "specialty": g["specialties"].most_common(1)[0][0] if g["specialties"] else "",
            "permit_count": g["count"],
            "total_project_value": g["value"],
        })
    rows.sort(key=lambda r: (-r["permit_count"], r["contractor_name"]))
    return rows


def compute_stats(records):
    statuses = Counter((r.get("status") or "unknown") for r in records)
    types = Counter((r.get("type") or "unknown") for r in records)
    coverage = {
        col: sum(1 for r in records if r.get(col) not in (None, "")) / max(1, len(records))
        for col in PERMIT_COLUMNS
    }
    return {
        "records": len(records),
        "columns": len(PERMIT_COLUMNS),
        "total_value": sum(r.get("value") or 0 for r in records),
        "neighborhoods": len({r["neighborhood"] for r in records if r.get("neighborhood")}),
        "statuses": dict(statuses.most_common()),
        "types": dict(types.most_common()),
        "coverage": coverage,
    }


# --------------------------------------------------------------- writing

def write_csv(path, rows, columns):
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


STATUS_DESCRIPTIONS = {
    "active": "Under active review or construction",
    "completed": "Work completed, permit closed",
    "new": "Application submitted, not yet in review",
    "pending": "Application pending processing",
    "expired": "Permit expired before completion",
}
TYPE_DESCRIPTIONS = {
    "residential": "Single-family, multifamily, ADU/DADU",
    "commercial": "Office, retail, industrial, institutional",
    "industrial": "Manufacturing, warehouse",
    "land": "Vacant land, land use only",
}


def render_stats_section(stats):
    lines = ["## Status Values", "", "| Status | Description | Count |",
             "|--------|-------------|-------|"]
    for status, count in stats["statuses"].items():
        desc = STATUS_DESCRIPTIONS.get(status, "")
        lines.append(f"| `{status}` | {desc} | {count:,} |")
    lines += ["", "## Permit Types", "", "| Type | Description | Count |",
              "|------|-------------|-------|"]
    for ptype, count in stats["types"].items():
        desc = TYPE_DESCRIPTIONS.get(ptype, "")
        lines.append(f"| `{ptype}` | {desc} | {count:,} |")
    return "\n".join(lines)


def render_version_section(stats, version, export_date):
    billions = stats["total_value"] / 1e9
    return "\n".join([
        "## Version",
        "",
        f"- Version: {version}",
        f"- Export date: {export_date:%B %-d, %Y}",
        f"- Records: {stats['records']:,}",
        f"- Columns: {stats['columns']}",
        f"- Total construction value: ${billions:.2f} billion",
    ])


def replace_marked_section(text, marker, replacement):
    begin, end = f"<!-- BEGIN GENERATED:{marker} -->", f"<!-- END GENERATED:{marker} -->"
    pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.DOTALL)
    if not pattern.search(text):
        raise SystemExit(f"data-dictionary.md is missing the {begin} markers")
    return pattern.sub(f"{begin}\n{replacement}\n{end}", text)


def render_version_txt(stats, version, export_date, checksums):
    lines = [
        "BuildingSeattle Permit Intelligence Dataset",
        f"Version: {version}",
        f"Records: {stats['records']:,}",
        f"Columns: {stats['columns']}",
        f"Total value: ${stats['total_value']:,}",
        f"Neighborhoods: {stats['neighborhoods']}",
        "Source: Seattle SDCI (services.seattle.gov/portal)",
        f"Export date: {export_date:%B %-d, %Y}",
        "",
        "SHA256:",
    ]
    lines += [f"  {name}  {digest}" for name, digest in checksums.items()]
    return "\n".join(lines) + "\n"


def render_changelog_entry(stats, version, export_date, previous_records=None):
    delta = ""
    if previous_records:
        diff = stats["records"] - previous_records
        delta = f" ({diff:+,} vs previous)"
    return "\n".join([
        f"## {version} — {export_date:%B %-d, %Y}",
        "",
        f"- {stats['records']:,} permits{delta}, {stats['columns']} columns",
        f"- Total construction value ${stats['total_value']:,}",
        f"- {stats['neighborhoods']} neighborhoods, "
        f"{stats['statuses'].get('active', 0):,} active permits",
        "",
    ])


def prepend_changelog(path, entry):
    header = "# Changelog\n\nAll shipped dataset versions, newest first. Buyers receive every refresh free via Gumroad file updates.\n\n"
    if path.exists():
        text = path.read_text(encoding="utf-8")
        if text.startswith("# Changelog"):
            head, _, rest = text.partition("\n## ")
            rest = ("## " + rest) if rest else ""
            path.write_text(head.rstrip("\n") + "\n\n" + entry + rest, encoding="utf-8")
            return
        path.write_text(header + entry + text, encoding="utf-8")
        return
    path.write_text(header + entry, encoding="utf-8")


def previous_record_count(changelog_path):
    if not changelog_path.exists():
        return None
    m = re.search(r"- ([\d,]+) permits", changelog_path.read_text(encoding="utf-8"))
    return int(m.group(1).replace(",", "")) if m else None


def build_zip(path, members):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for member in members:
            zf.write(member, arcname=member.name)


# ------------------------------------------------------------------ main

def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", choices=["auto", "d1", "api"], default="auto")
    parser.add_argument("--version", default=None,
                        help="Version label, default current YYYY-MM")
    parser.add_argument("--out-dir", default=str(GUMROAD_DIR),
                        help="Directory holding the product files (default gumroad/)")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    dist_dir = out_dir / "dist"
    dist_dir.mkdir(parents=True, exist_ok=True)
    export_date = dt.date.today()
    version = args.version or f"{export_date:%Y-%m}"

    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    db_id = os.environ.get("BUILDINGSEATTLE_D1_ID", DEFAULT_DB_ID).strip()

    source = args.source
    if source == "auto":
        source = "d1" if (account_id and token) else "api"
    if source == "d1" and not (account_id and token):
        raise SystemExit("--source d1 requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN")

    print(f"Building dataset version {version} from source: {source}")
    expected = None
    if source == "d1":
        expected = fetch_d1_permit_count(account_id, token, db_id)
        raw = fetch_permits_d1(account_id, token, db_id)
    else:
        raw = fetch_permits_api()

    records = [normalize_permit(r) for r in raw]
    records.sort(key=lambda r: r["permit_number"])
    if expected is not None and len(records) != expected:
        raise SystemExit(f"row drift: D1 counts {expected} permits but export has {len(records)}")

    stats = compute_stats(records)
    sample = build_sample(records)
    contractors = derive_contractors(records)

    permits_csv = out_dir / "buildingseattle_permits.csv"
    sample_csv = out_dir / "buildingseattle_sample.csv"
    contractors_csv = out_dir / "contractors.csv"
    write_csv(permits_csv, records, PERMIT_COLUMNS)
    write_csv(sample_csv, sample, PERMIT_COLUMNS)
    write_csv(contractors_csv, contractors, CONTRACTOR_COLUMNS)

    dictionary = out_dir / "data-dictionary.md"
    text = dictionary.read_text(encoding="utf-8")
    text = replace_marked_section(text, "STATS", render_stats_section(stats))
    text = replace_marked_section(text, "VERSION",
                                  render_version_section(stats, version, export_date))
    dictionary.write_text(text, encoding="utf-8")

    checksums = {p.name: sha256_file(p) for p in (permits_csv, sample_csv, contractors_csv)}
    (out_dir / "VERSION.txt").write_text(
        render_version_txt(stats, version, export_date, checksums), encoding="utf-8")

    changelog = out_dir / "CHANGELOG.md"
    prev = previous_record_count(changelog)
    prepend_changelog(changelog, render_changelog_entry(stats, version, export_date, prev))

    foundation_zip = dist_dir / f"buildingseattle-permits-{version}_foundation.zip"
    pro_zip = dist_dir / f"buildingseattle-permits-{version}_pro.zip"
    foundation_members = [permits_csv, dictionary, out_dir / "LICENSE.txt",
                          out_dir / "README.md", out_dir / "VERSION.txt",
                          out_dir / "CHANGELOG.md"]
    build_zip(foundation_zip, foundation_members)
    build_zip(pro_zip, foundation_members + [contractors_csv, out_dir / "refresh.py"])

    sample_keys = {r["permit_number"] for r in sample}
    all_keys = {r["permit_number"] for r in records}
    print()
    print("=== Build manifest ===")
    print(f"version:        {version}")
    print(f"records:        {stats['records']:,}" +
          (f" (D1 count: {expected:,})" if expected is not None else ""))
    print(f"columns:        {stats['columns']}")
    print(f"total value:    ${stats['total_value']:,}")
    print(f"neighborhoods:  {stats['neighborhoods']}")
    print(f"contractors:    {len(contractors):,}")
    print(f"sample:         {len(sample)} rows, subset of full: {sample_keys <= all_keys}")
    print("low-coverage columns (<25%):")
    for col, cov in sorted(stats["coverage"].items(), key=lambda kv: kv[1]):
        if cov < 0.25:
            print(f"  {col}: {cov:.0%}")
    for name, digest in checksums.items():
        print(f"sha256 {name}: {digest}")
    print(f"zips:           {foundation_zip.name}, {pro_zip.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
