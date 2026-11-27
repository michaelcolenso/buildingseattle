"""Python side of the shared SDCI mappings (data/sdci_mappings.json).

The same fixture file drives tests/sdci_mappings.test.js, so the scraper and
the worker give the same answers. Stdlib only: runs without httpx.
"""

import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import sdci_mappings  # noqa: E402

CASES = json.loads((ROOT / "tests" / "fixtures" / "sdci_mapping_cases.json").read_text())


class StatusMapTests(unittest.TestCase):
    def test_shared_status_fixture(self):
        for raw, expected in CASES["statuses"]:
            with self.subTest(raw=raw):
                self.assertEqual(sdci_mappings.map_status(raw), expected)

    def test_application_completed_is_pending_and_withdrawn_cancelled(self):
        self.assertEqual(sdci_mappings.map_status("Application Completed"), "pending")
        self.assertEqual(sdci_mappings.map_status("Withdrawn"), "cancelled")
        self.assertEqual(sdci_mappings.map_status("Canceled"), "cancelled")

    def test_unknown_status_is_flagged(self):
        self.assertEqual(sdci_mappings.map_sdci_status("Issued"), ("active", True))
        self.assertEqual(sdci_mappings.map_sdci_status("Brand New Status"), ("pending", False))

    def test_raw_statuses_for_lists_exact_values(self):
        self.assertIn("withdrawn", sdci_mappings.raw_statuses_for("cancelled"))
        self.assertNotIn("application completed", sdci_mappings.raw_statuses_for("completed"))


class NeighborhoodTests(unittest.TestCase):
    def test_shared_point_fixture(self):
        for lat, lng, expected in CASES["points"]:
            with self.subTest(lat=lat, lng=lng):
                self.assertEqual(sdci_mappings.detect_neighborhood(lat, lng), expected)

    def test_every_box_is_reachable(self):
        unreachable = []
        for name, min_lat, max_lat, min_lng, max_lng in sdci_mappings.NEIGHBORHOOD_BOUNDS:
            reached = any(
                sdci_mappings.detect_neighborhood(
                    min_lat + (max_lat - min_lat) * i / 20, min_lng + (max_lng - min_lng) * j / 20
                )
                == name
                for i in range(21)
                for j in range(21)
            )
            if not reached:
                unreachable.append(name)
        self.assertEqual(unreachable, [])

    def test_boxes_are_smallest_first(self):
        areas = [(b[2] - b[1]) * (b[4] - b[3]) for b in sdci_mappings.NEIGHBORHOOD_BOUNDS]
        for previous, current in zip(areas, areas[1:]):
            self.assertGreaterEqual(current, previous - 1e-12)


class ScraperUsesSharedMappingsTests(unittest.TestCase):
    def test_scraper_has_no_inline_copy(self):
        source = (ROOT / "sdci_scraper.py").read_text()
        self.assertIn("from sdci_mappings import", source)
        self.assertNotRegex(source, r'\("Ballard",\s*47\.')
        self.assertNotIn("def map_status", source)

    def test_worker_has_no_inline_copy(self):
        source = (ROOT / "worker.js").read_text()
        self.assertIn('from "./sdci_mappings.js"', source)
        self.assertIsNone(re.search(r'\["Ballard",\s*47\.', source))
        self.assertNotIn("function mapPermitStatus", source)


try:
    import httpx  # noqa: F401
except ImportError:  # pragma: no cover
    httpx = None


@unittest.skipIf(httpx is None, "sdci_scraper needs httpx")
class ScraperFeedTests(unittest.IsolatedAsyncioTestCase):
    async def test_scraper_keeps_raw_status_coordinates_zip_and_source_stamp(self):
        import sdci_scraper

        rows = [{
            "permitnum": "7000001-CN",
            "statuscurrent": "Application Completed",
            "originaladdress1": "100 MAIN ST",
            "originalzip": "98101",
            "latitude": "47.580",
            "longitude": "-122.410",
            ":updated_at": "2026-11-26T10:00:00.000Z",
        }]

        class FakeResponse:
            status_code = 200
            text = ""

            def json(self):
                return rows

        class FakeClient:
            def __init__(self, *args, **kwargs):
                self.params = []

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, params, headers, timeout):
                self.params.append(params)
                return FakeResponse()

        original = sdci_scraper.httpx.AsyncClient
        sdci_scraper.httpx.AsyncClient = FakeClient
        try:
            permits, _ = await sdci_scraper.fetch_seattle_permits(total=10, page_size=10)
        finally:
            sdci_scraper.httpx.AsyncClient = original
        permit = permits[0]
        self.assertEqual(permit["status"], "pending")
        self.assertEqual(permit["status_raw"], "Application Completed")
        self.assertEqual(permit["neighborhood"], "Alki")
        self.assertEqual((permit["lat"], permit["lng"], permit["zip"]), ("47.580", "-122.410", "98101"))
        self.assertEqual(permit["source_updated_at"], "2026-11-26T10:00:00.000Z")

    def test_status_filter_uses_exact_values(self):
        import sdci_scraper

        clause = sdci_scraper.build_status_filter("completed")
        self.assertIn("'INSPECTIONS COMPLETED'", clause)
        self.assertNotIn("APPLICATION COMPLETED", clause)


if __name__ == "__main__":
    unittest.main()
