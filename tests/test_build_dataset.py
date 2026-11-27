"""Offline tests for the Gumroad dataset build pipeline (gumroad/build_dataset.py)."""

import csv
import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
GUMROAD = REPO_ROOT / "gumroad"
sys.path.insert(0, str(GUMROAD))


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, GUMROAD / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


columns = load_module("columns")
build = load_module("build_dataset")
refresh = load_module("refresh")


def make_record(i, **overrides):
    record = {col: None for col in columns.PERMIT_COLUMNS}
    record.update({
        "permit_number": f"{7000000 + i}-CN",
        "address": f"{i} EXAMPLE ST, SEATTLE, WA",
        "neighborhood": ["Ballard", "Fremont", "Capitol Hill"][i % 3],
        "type": ["residential", "commercial"][i % 2],
        "value": i * 1000,
        "status": ["active", "completed", "new"][i % 3],
        "description": f"Project {i} — naïve café rénovation",  # non-ASCII on purpose
        "has_required_inspections": i % 2,
        "has_completed_inspections": 0,
    })
    record.update(overrides)
    return record


@pytest.fixture
def records():
    return [make_record(i) for i in range(300)]


def test_column_contract_is_38_columns():
    assert len(columns.PERMIT_COLUMNS) == 38
    assert len(set(columns.PERMIT_COLUMNS)) == 38


def test_refresh_columns_match_shared_contract():
    # refresh.py ships standalone in the Pro ZIP with its own copy — never drift
    assert refresh.PERMIT_COLUMNS == columns.PERMIT_COLUMNS


def test_development_site_export_query_and_refresh_preserve_grain(tmp_path, monkeypatch):
    import json
    import sqlite3

    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript((REPO_ROOT / "schema.sql").read_text())
    db.execute("DELETE FROM permits")
    for i, ref in enumerate([" dv0025961 ", "DV0025961", None]):
        db.execute("INSERT INTO permits (permit_number, address, parcel_number, value) VALUES (?, ?, ?, ?)",
                   (f"P-{i}", f"{i} MAIN ST", ref, (i + 1) * 10000))
    geometry = json.dumps({"type": "Polygon", "coordinates": [[[-122.3, 47.6], [-122.2, 47.6], [-122.2, 47.7], [-122.3, 47.6]]]})
    db.execute("INSERT INTO development_sites VALUES (?, ?, ?, ?, ?, ?)",
               ("DV0025961", "ACTIVE", 5000, geometry, None, "2026-11-01T00:00:00.000Z"))
    rows = [dict(row) for row in db.execute(build.PERMIT_SELECT + " ORDER BY p.permit_number")]
    db.close()
    assert len(rows) == 3
    assert sum(row["value"] for row in rows) == 60000
    assert [row["development_site_sqft"] for row in rows] == [5000, 5000, None]
    assert rows[0]["parcel_number"] == " dv0025961 "
    assert rows[0]["development_site_geometry_url"] == "https://buildingseattle.com/api/development-sites/DV0025961/geometry"

    # Exercise the API builder path and the shipped standalone refresh, not just headers.
    monkeypatch.setattr(build, "http_json", lambda *args, **kwargs: {"results": rows})
    api_records = [build.normalize_permit(row) for row in build.fetch_permits_api()]
    assert api_records == [build.normalize_permit(row) for row in rows]
    d1_path = tmp_path / "d1.csv"
    build.write_csv(d1_path, api_records, columns.PERMIT_COLUMNS)
    refreshed_path = tmp_path / "refresh.csv"
    monkeypatch.setattr(refresh, "fetch_json", lambda url: {"permits": 3})
    monkeypatch.setattr(refresh, "fetch_page", lambda page: {"results": rows})
    monkeypatch.setattr(sys, "argv", ["refresh.py", "--output", str(refreshed_path)])
    assert refresh.main() == 0
    assert refreshed_path.read_text() == d1_path.read_text()


def test_normalize_permit_projects_onto_contract():
    raw = make_record(1)
    raw["unexpected_internal_column"] = "should be dropped"
    normalized = build.normalize_permit(raw)
    assert list(normalized.keys()) == columns.PERMIT_COLUMNS


def test_sample_is_stratified_subset_and_deterministic(records):
    sample = build.build_sample(records)
    assert len(sample) == columns.SAMPLE_SIZE
    keys = {r["permit_number"] for r in sample}
    assert len(keys) == columns.SAMPLE_SIZE
    assert keys <= {r["permit_number"] for r in records}
    # top-N by value must all be present
    top = sorted(records, key=lambda r: -(r["value"] or 0))[:columns.SAMPLE_TOP_BY_VALUE]
    assert {r["permit_number"] for r in top} <= keys
    # seed-pinned: identical output on re-run
    assert [r["permit_number"] for r in build.build_sample(records)] == \
        [r["permit_number"] for r in sample]


def test_derive_contractors_no_empty_columns(records):
    for i, r in enumerate(records):
        r["contractor_name"] = f"Contractor {i % 20}"
        r["contractor_license"] = f"LIC{i % 20:05d}"
        r["contractor_specialty"] = "General Contractor"
    rows = build.derive_contractors(records)
    assert len(rows) == 20
    assert all(list(r.keys()) == columns.CONTRACTOR_COLUMNS for r in rows)
    # the 2026-07-05 release shipped 100%-empty phone/email columns — never again
    assert "phone" not in columns.CONTRACTOR_COLUMNS
    assert "email" not in columns.CONTRACTOR_COLUMNS
    for row in rows:
        assert row["permit_count"] > 0
        assert row["contractor_name"]


def test_derive_contractors_skips_blank_names(records):
    rows = build.derive_contractors(records)  # no contractor fields set
    assert rows == []


def test_compute_stats(records):
    stats = build.compute_stats(records)
    assert stats["records"] == 300
    assert stats["columns"] == 38
    assert stats["total_value"] == sum(r["value"] for r in records)
    assert stats["neighborhoods"] == 3
    assert sum(stats["statuses"].values()) == 300
    assert stats["coverage"]["permit_number"] == 1.0
    assert stats["coverage"]["parcel_number"] == 0.0


def test_csv_utf8_round_trip(tmp_path, records):
    path = tmp_path / "permits.csv"
    build.write_csv(path, records, columns.PERMIT_COLUMNS)
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 300
    assert list(rows[0].keys()) == columns.PERMIT_COLUMNS
    assert rows[1]["description"] == "Project 1 — naïve café rénovation"


def test_marked_section_replacement():
    text = "before\n<!-- BEGIN GENERATED:STATS -->\nold\n<!-- END GENERATED:STATS -->\nafter"
    out = build.replace_marked_section(text, "STATS", "new stats")
    assert "old" not in out
    assert "new stats" in out
    assert out.startswith("before\n") and out.endswith("\nafter")
    with pytest.raises(SystemExit):
        build.replace_marked_section("no markers here", "STATS", "x")


def test_shipped_dictionary_has_markers():
    text = (GUMROAD / "data-dictionary.md").read_text(encoding="utf-8")
    for marker in ("STATS", "VERSION"):
        assert f"<!-- BEGIN GENERATED:{marker} -->" in text
        assert f"<!-- END GENERATED:{marker} -->" in text


def test_changelog_prepend(tmp_path):
    path = tmp_path / "CHANGELOG.md"
    build.prepend_changelog(path, "## 2026-07 — July 19, 2026\n\n- 13,623 permits\n\n")
    first = path.read_text(encoding="utf-8")
    assert first.startswith("# Changelog")
    assert build.previous_record_count(path) == 13623
    build.prepend_changelog(path, "## 2026-08 — August 3, 2026\n\n- 14,101 permits\n\n")
    text = path.read_text(encoding="utf-8")
    assert text.index("2026-08") < text.index("2026-07")
    assert build.previous_record_count(path) == 14101


def test_counted_values_repeated_demolition_valuation_counts_once():
    rows = [
        make_record(1, permit_number="7009320-DM", address="4747 30TH AVE NE, SEATTLE, WA", value=129_000_000),
        make_record(2, permit_number="7009657-DM", address="4747 30th Ave NE,  Seattle, WA", value=129_000_000),
        make_record(3, permit_number="7100001-CN", address="10 ELM ST, SEATTLE, WA", value=13_000_000),
        make_record(4, permit_number="7100002-DM", address="10 ELM ST, SEATTLE, WA", value=13_000_000),
        make_record(5, permit_number="7200001-CN", address="20 OAK ST, SEATTLE, WA", value=450_000),
        make_record(6, permit_number="7200002-CN", address="20 OAK ST, SEATTLE, WA", value=450_000),
        make_record(7, permit_number="7300001-DM", address="30 PINE ST, SEATTLE, WA", value=25_000),
    ]
    assert build.counted_values(rows) == [129_000_000, 0, 13_000_000, 0, 450_000, 450_000, 25_000]
    stats = build.compute_stats(rows)
    assert stats["total_value"] == 129_000_000 + 13_000_000 + 900_000 + 25_000
    assert stats["declared_value"] == sum(r["value"] for r in rows)


def test_refresh_counted_values_never_drifts_from_build(records):
    rows = list(records) + [
        make_record(900, permit_number="7009320-DM", address="4747 30TH AVE NE, SEATTLE, WA", value=129_000_000),
        make_record(901, permit_number="7009657-DM", address="4747 30TH AVE NE, SEATTLE, WA", value=129_000_000),
        make_record(902, permit_number="7100002-DM", address="1 EXAMPLE ST, SEATTLE, WA", value=1000),
    ]
    assert refresh.counted_values(rows) == build.counted_values(rows)


def test_counted_values_prefer_address_id_over_address_text():
    # Same address id, differently spelled address text: still one valuation.
    rows = [
        {"id": 20, "address_id": 7, "permit_number": "7009657-DM", "address": "4747 30th Ave NE", "value": 129_000_000},
        {"id": 10, "address_id": 7, "permit_number": "7009320-DM", "address": "4747 30TH AVE NE, SEATTLE, WA", "value": 129_000_000},
        {"id": 30, "address_id": 8, "permit_number": "7300001-DM", "address": "4747 30TH AVE NE, SEATTLE, WA", "value": 129_000_000},
    ]
    # Lowest id counts (matches value_counting.js); a different address id is unrelated.
    assert build.counted_values(rows) == [0, 129_000_000, 129_000_000]
    assert refresh.counted_values(rows) == build.counted_values(rows)
    stats = build.compute_stats([build.normalize_permit(r) for r in rows], value_rows=rows)
    assert stats["total_value"] == 258_000_000


def test_rebuilding_a_version_replaces_its_changelog_entry(tmp_path):
    changelog = tmp_path / "CHANGELOG.md"
    changelog.write_text(
        "# Changelog\n\nIntro.\n\n## 2026-07 — July 19, 2026\n\n- 13,623 permits, 32 columns\n",
        encoding="utf-8",
    )
    stats = {"records": 15_551, "columns": 32, "total_value": 1, "declared_value": 2,
             "neighborhoods": 53, "statuses": {"active": 1}}
    from datetime import date
    for _ in range(2):  # two builds of the same version
        prev = build.previous_record_count(changelog, "2026-11")
        build.prepend_changelog(changelog, build.render_changelog_entry(stats, "2026-11", date(2026, 11, 8), prev), "2026-11")
    text = changelog.read_text(encoding="utf-8")
    assert text.count("## 2026-11") == 1
    assert "(+1,928 vs previous)" in text
    assert text.count("## 2026-07") == 1


def test_contractor_totals_count_repeated_demolition_valuations_once():
    rows = [
        make_record(i, permit_number=f"700932{i}-DM", address="4747 30TH AVE NE, SEATTLE, WA",
                    value=129_000_000, contractor_name="EXXEL PACIFIC INC")
        for i in range(3)
    ]
    counted = dict(zip((r["permit_number"] for r in rows), build.counted_values(rows)))
    [row] = build.derive_contractors(rows, counted)
    assert row["permit_count"] == 3
    assert row["total_project_value"] == 129_000_000


def _stage_product_dir(tmp_path):
    """Copy the tracked, hand-written product files into a scratch out dir."""
    import shutil
    out_dir = tmp_path / "gumroad"
    out_dir.mkdir()
    for name in ("data-dictionary.md", "LICENSE.txt", "README.md", "CHANGELOG.md", "refresh.py"):
        shutil.copy(GUMROAD / name, out_dir / name)
    return out_dir


def _api_rows(count):
    rows = []
    for i in range(count):
        row = make_record(i, contractor_name=f"Contractor {i % 4}")
        row.update({"id": i + 1, "address_id": i + 1})
        rows.append(row)
    return rows


def test_build_writes_paid_artifacts_only_to_dist(tmp_path, monkeypatch):
    import zipfile
    rows = _api_rows(150)
    out_dir = _stage_product_dir(tmp_path)
    monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    monkeypatch.setattr(build, "fetch_permits_api", lambda *a, **k: list(rows))
    monkeypatch.setattr(build, "fetch_api_permit_count", lambda *a, **k: len(rows))

    assert build.main(["--source", "api", "--version", "2099-01", "--out-dir", str(out_dir)]) == 0

    dist = out_dir / "dist"
    # Paid files exist only in the gitignored dist dir.
    assert (dist / "buildingseattle_permits.csv").exists()
    assert (dist / "contractors.csv").exists()
    assert not (out_dir / "buildingseattle_permits.csv").exists()
    assert not (out_dir / "contractors.csv").exists()
    # The free sample stays next to the tracked docs.
    assert (out_dir / "buildingseattle_sample.csv").exists()
    assert not (dist / "buildingseattle_sample.csv").exists()
    with zipfile.ZipFile(dist / "buildingseattle-permits-2099-01_pro.zip") as zf:
        names = set(zf.namelist())
    assert {"buildingseattle_permits.csv", "contractors.csv", "refresh.py", "VERSION.txt"} <= names
    with zipfile.ZipFile(dist / "buildingseattle-permits-2099-01_foundation.zip") as zf:
        assert "contractors.csv" not in zf.namelist()
    version_txt = (out_dir / "VERSION.txt").read_text(encoding="utf-8")
    assert "Records: 150" in version_txt


def _git(*args):
    import subprocess
    return subprocess.run(["git", "-C", str(REPO_ROOT), *args], capture_output=True, text=True)


def test_paid_csvs_are_not_tracked_and_are_gitignored():
    probe = _git("rev-parse", "--is-inside-work-tree")
    if probe.returncode != 0 or probe.stdout.strip() != "true":
        pytest.skip("not a git work tree")
    tracked = set(_git("ls-files", "gumroad").stdout.split())
    assert "gumroad/buildingseattle_permits.csv" not in tracked
    assert "gumroad/contractors.csv" not in tracked
    assert "gumroad/buildingseattle_sample.csv" in tracked
    for path in ("gumroad/buildingseattle_permits.csv", "gumroad/contractors.csv",
                 "gumroad/dist/buildingseattle_permits.csv", "gumroad/dist/x_pro.zip"):
        assert _git("check-ignore", "-q", "--no-index", path).returncode == 0, path
    assert _git("check-ignore", "-q", "--no-index", "gumroad/buildingseattle_sample.csv").returncode == 1


def test_api_build_fails_when_row_count_differs_from_api_stats(tmp_path, monkeypatch):
    rows = _api_rows(120)
    out_dir = _stage_product_dir(tmp_path)
    monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    monkeypatch.setattr(build, "fetch_permits_api", lambda *a, **k: rows[:-3])  # pagination skipped rows
    monkeypatch.setattr(build, "fetch_api_permit_count", lambda *a, **k: len(rows))
    with pytest.raises(SystemExit, match="row drift: /api/stats reports 120 permits but export has 117"):
        build.main(["--source", "api", "--out-dir", str(out_dir)])
    assert not (out_dir / "dist" / "buildingseattle_permits.csv").exists()
    # The escape hatch downgrades the mismatch to a warning.
    assert build.main(["--source", "api", "--out-dir", str(out_dir), "--allow-count-mismatch"]) == 0


def test_api_build_fails_when_live_count_moves_during_pull(tmp_path, monkeypatch):
    rows = _api_rows(110)
    out_dir = _stage_product_dir(tmp_path)
    monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    counts = iter([110, 112])
    monkeypatch.setattr(build, "fetch_permits_api", lambda *a, **k: list(rows))
    monkeypatch.setattr(build, "fetch_api_permit_count", lambda *a, **k: next(counts))
    with pytest.raises(SystemExit, match="changed during the build"):
        build.main(["--source", "api", "--out-dir", str(out_dir)])


def test_fetch_api_permit_count_reads_api_stats(monkeypatch):
    seen = []
    monkeypatch.setattr(build, "http_json", lambda url, **k: seen.append(url) or {"permits": 15814})
    assert build.fetch_api_permit_count() == 15814
    assert seen == ["https://buildingseattle.com/api/stats"]
    monkeypatch.setattr(build, "http_json", lambda url, **k: {"error": "boom"})
    with pytest.raises(SystemExit):
        build.fetch_api_permit_count()


def test_version_txt_attributes_both_sources():
    from datetime import date
    stats = {"records": 1, "columns": 38, "total_value": 1, "declared_value": 1, "neighborhoods": 1}
    text = build.render_version_txt(stats, "2026-12", date(2026, 12, 1), {})
    assert "Source: Seattle Open Data k44w-2dcq + SDCI portal detail pages" in text
    assert "services.seattle.gov/portal)" not in text


def test_refresh_exits_nonzero_and_keeps_output_when_a_page_fails(tmp_path, monkeypatch):
    rows = [make_record(i) for i in range(refresh.PER_PAGE)]
    for row in rows:
        row["development_site_fetched_at"] = None
    pages = {1: {"results": rows}, 2: None, 3: {"results": rows[:5]}}
    output = tmp_path / "fresh.csv"
    output.write_text("previous good file\n", encoding="utf-8")
    monkeypatch.setattr(refresh, "fetch_json", lambda url: {"permits": len(rows)})
    monkeypatch.setattr(refresh, "fetch_page", lambda page: pages.get(page, {"results": []}))
    monkeypatch.setattr(refresh.time, "sleep", lambda s: None)
    monkeypatch.setattr(sys, "argv", ["refresh.py", "--output", str(output)])
    assert refresh.main() == 1
    assert output.read_text(encoding="utf-8") == "previous good file\n"
    partial = tmp_path / "fresh.partial.csv"
    with open(partial, newline="", encoding="utf-8") as f:
        assert len(list(csv.DictReader(f))) == refresh.PER_PAGE


def test_refresh_partial_output_path():
    assert refresh.partial_output_path("out/fresh.csv") == "out/fresh.partial.csv"
    assert refresh.partial_output_path("fresh") == "fresh.partial.csv"
