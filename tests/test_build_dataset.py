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
