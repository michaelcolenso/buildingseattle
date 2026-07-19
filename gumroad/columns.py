"""Shared column contracts for the BuildingSeattle dataset products.

This is the single source of truth for the shipped CSV schemas.
`refresh.py` (which ships standalone inside the Pro ZIP and must stay
stdlib-only/single-file) keeps its own inline copy of PERMIT_COLUMNS;
`tests/test_build_dataset.py` asserts the two lists never drift.
"""

# The 32-column permit contract, in shipped order.
PERMIT_COLUMNS = [
    "permit_number", "address", "neighborhood", "type", "value", "status",
    "description", "detailed_description",
    "applied_date", "issued_date", "completed_date", "expires_date",
    "plan_review_complete_date", "ready_to_issue_date",
    "contractor_name", "contractor_specialty", "contractor_license",
    "housing_units", "housing_units_added", "housing_units_removed",
    "housing_category",
    "review_level", "primary_property_use", "work_performed_by",
    "parcel_number",
    "number_review_cycles", "total_days_plan_review", "days_out_corrections",
    "has_required_inspections", "has_completed_inspections",
    "permit_detail_url", "record_status_detail",
]

# Contractor CSV contract. The upstream L&I source (ciwg-agsx) has no
# phone/email data, so those columns shipped 100% empty in 2026-07-05 and
# were dropped — reintroduce only once a populated source exists.
CONTRACTOR_COLUMNS = [
    "contractor_name", "license_number", "specialty",
    "permit_count", "total_project_value",
]

SAMPLE_SIZE = 100
SAMPLE_TOP_BY_VALUE = 25   # top-N by project value
SAMPLE_RANDOM_SEED = 20260705  # pinned so sample regeneration is reproducible
