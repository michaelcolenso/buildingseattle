"""Python side of the SDCI feed mappings (see data/sdci_mappings.json).

The worker reads the same JSON through sdci_mappings.js, so the scraper and
the scheduled ingest classify statuses and neighborhoods identically.
Stdlib only, so it imports without the scraper's HTTP dependencies.
"""

import json
from pathlib import Path

MAPPINGS_PATH = Path(__file__).resolve().parent / "data" / "sdci_mappings.json"

with MAPPINGS_PATH.open() as _f:
    SDCI_MAPPINGS = json.load(_f)

STATUS_MAP = dict(SDCI_MAPPINGS["status_map"])
UNKNOWN_STATUS = SDCI_MAPPINGS["unknown_status"]
# (name, min_lat, max_lat, min_lng, max_lng) in resolution order, smallest first.
NEIGHBORHOOD_BOUNDS = [tuple(row) for row in SDCI_MAPPINGS["neighborhood_bounds"]]
SEATTLE_BOUNDS = tuple(SDCI_MAPPINGS["seattle_bounds"])
INSIDE_SEATTLE_UNMATCHED = SDCI_MAPPINGS["inside_seattle_unmatched"]
OUTSIDE_OR_UNKNOWN = SDCI_MAPPINGS["outside_or_unknown"]


def _status_key(raw):
    return " ".join(str(raw if raw is not None else "").split()).lower()


def map_sdci_status(raw):
    """Return (status, known) for an SDCI statuscurrent value (exact match)."""
    key = _status_key(raw)
    if key in STATUS_MAP:
        return STATUS_MAP[key], True
    return UNKNOWN_STATUS, False


def map_status(raw):
    """Map an SDCI statuscurrent value to a stored status."""
    return map_sdci_status(raw)[0]


def raw_statuses_for(status):
    """Every known SDCI statuscurrent value (original casing lost) that maps to status."""
    return sorted(key for key, value in STATUS_MAP.items() if value == status and key)


def detect_neighborhood(lat, lng):
    """Neighborhood for a coordinate; boxes are tried smallest first."""
    if lat is None or lng is None or lat == "" or lng == "":
        return OUTSIDE_OR_UNKNOWN
    try:
        lat = float(lat)
        lng = float(lng)
    except (ValueError, TypeError):
        return OUTSIDE_OR_UNKNOWN
    if lat != lat or lng != lng or lat == 0 or lng == 0:  # NaN or zero
        return OUTSIDE_OR_UNKNOWN

    for name, min_lat, max_lat, min_lng, max_lng in NEIGHBORHOOD_BOUNDS:
        if min_lat <= lat <= max_lat and min_lng <= lng <= max_lng:
            return name

    min_lat, max_lat, min_lng, max_lng = SEATTLE_BOUNDS
    if min_lat <= lat <= max_lat and min_lng <= lng <= max_lng:
        return INSIDE_SEATTLE_UNMATCHED
    return OUTSIDE_OR_UNKNOWN
