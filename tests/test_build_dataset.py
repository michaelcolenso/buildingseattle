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


def test_column_contract_is_32_columns():
    assert len(columns.PERMIT_COLUMNS) == 32
    assert len(set(columns.PERMIT_COLUMNS)) == 32


def test_refresh_columns_match_shared_contract():
    # refresh.py ships standalone in the Pro ZIP with its own copy — never drift
    assert refresh.PERMIT_COLUMNS == columns.PERMIT_COLUMNS


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
    assert stats["columns"] == 32
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
