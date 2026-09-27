import importlib.util
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "scripts" / "basis_reset_candidates.py"
spec = importlib.util.spec_from_file_location("basis_reset_candidates", MODULE)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)
validate_candidate = module.validate_candidate


def test_valid_candidate_can_leave_prior_basis_unknown():
    item = {
        "address": "600 Stewart St, Seattle, WA",
        "event_type": "sale",
        "event_date": "2026-09-17",
        "current_basis": 12_500_000,
        "source_url": "https://example.test/source",
        "source_type": "public_record",
    }
    assert validate_candidate(item) == []


def test_candidate_requires_existing_entity_locator():
    item = {
        "event_type": "sale",
        "event_date": "2026-09-17",
        "source_url": "https://example.test/source",
    }
    assert "candidate needs project_id, address_id, or address" in validate_candidate(item)


def test_bad_basis_is_rejected():
    item = {
        "address": "600 Stewart St",
        "event_type": "sale",
        "event_date": "2026-09-17",
        "prior_basis": 0,
        "source_url": "https://example.test/source",
    }
    assert "prior_basis must be positive" in validate_candidate(item)
