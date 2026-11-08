"""Source contract and failure tests; all HTTP calls are mocked."""
import copy
import importlib.util
from pathlib import Path

import httpx
import pytest

spec = importlib.util.spec_from_file_location("enrich_development_sites", Path(__file__).parents[1] / "scripts/enrich_development_sites.py")
sites = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sites)

GEOMETRY = {"type": "Polygon", "coordinates": [[[-122.3, 47.6], [-122.299, 47.6], [-122.299, 47.601], [-122.3, 47.6]]]}


def collection(id_="DV0025961", **properties):
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {
        "PRCLID": id_, "PRCLSTAT": "ACTIVE", "LOTSZ": 5000, "LAST_UPDATED_DT": None, **properties,
    }, "geometry": GEOMETRY}]}


def test_normalization_and_nullable_source_fields():
    assert sites.normalize_site_id(" dv0025961 ") == "DV0025961"
    assert sites.normalize_site_id("X' OR 1=1") is None
    row = sites.parse_features(collection(LOTSZ=0), ["DV0025961"])[0]
    assert row["lot_sqft"] is None
    assert row["source_updated_at"] is None
    assert sites.source_timestamp(0) == "1970-01-01T00:00:00.000Z"
    assert sites.parse_features({"type": "FeatureCollection", "features": []}, ["DV0025961"]) == []


@pytest.mark.parametrize("bad", [
    {}, {"error": {"code": 500}}, {"type": "FeatureCollection"},
    {"type": "FeatureCollection", "features": None},
    {**collection(), "properties": {"exceededTransferLimit": True}},
    {**collection(), "exceededTransferLimit": True},
    {**collection(), "properties": {"exceededTransferLimit": "true"}},
    collection("DV9999999"), collection(""),
    {"type": "FeatureCollection", "features": collection()["features"] * 2},
])
def test_invalid_or_truncated_responses_cannot_confirm_absence(bad):
    with pytest.raises(ValueError):
        sites.parse_features(bad, ["DV0025961"])


def test_missing_schema_fields_fail_but_missing_boundary_does_not_hide_valid_site():
    data = copy.deepcopy(collection())
    del data["features"][0]["properties"]["LOTSZ"]
    with pytest.raises(ValueError, match="fields"):
        sites.parse_features(data, ["DV0025961"])
    data = copy.deepcopy(collection())
    data["features"][0]["geometry"] = None
    assert sites.parse_features(data, ["DV0025961"])[0]["geometry"] is None
    del data["features"][0]["geometry"]
    with pytest.raises(ValueError, match="omitted"):
        sites.parse_features(data, ["DV0025961"])


def test_boundary_validation_includes_holes_and_multipart():
    assert sites.valid_boundary(GEOMETRY)
    assert sites.valid_boundary({"type": "MultiPolygon", "coordinates": [GEOMETRY["coordinates"]]})
    bad = copy.deepcopy(GEOMETRY)
    bad["coordinates"][0][1][0] = float("nan")
    assert not sites.valid_boundary(bad)
    assert not sites.valid_boundary({"type": "Polygon", "coordinates": [[[0, 0]] * 4]})


@pytest.mark.asyncio
async def test_transient_request_retry_and_exhaustion(monkeypatch):
    calls = []
    async def no_sleep(_):
        pass
    monkeypatch.setattr(sites.asyncio, "sleep", no_sleep)
    def handle(request):
        calls.append(request)
        return httpx.Response(429 if len(calls) == 1 else 200, json=collection())
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        result = await sites.fetch_snapshot(client, ["DV0025961"])
    assert len(calls) == 2
    assert all(request.method == "POST" for request in calls)
    assert b"outSR=4326" in calls[-1].content
    assert result[0]["complete"] is True
    assert result[0]["sites"][0]["site_id"] == "DV0025961"
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(503))) as client:
        with pytest.raises(httpx.HTTPStatusError):
            await sites.request_json(client, "POST", sites.SOURCE, retries=1)


@pytest.mark.asyncio
async def test_source_failure_prevents_any_publishing(monkeypatch):
    async def references(client, args):
        return {f"DV{i:07d}": 1 for i in range(101)}
    async def request(client, method, url, **kwargs):
        if "/query" not in url:
            pytest.fail("Publishing began before source validation completed")
        if "DV0000100" in kwargs["data"]["where"]:
            return {"type": "FeatureCollection", "features": [], "properties": {"exceededTransferLimit": True}}
        return {"type": "FeatureCollection", "features": []}
    monkeypatch.setattr(sites, "read_permit_references", references)
    monkeypatch.setattr(sites, "request_json", request)
    monkeypatch.setenv("INGEST_API_TOKEN", "test")
    args = sites.build_parser().parse_args([])
    with pytest.raises(sites.RefreshError, match="Incomplete") as error:
        await sites.run(args)
    assert error.value.summary["published_sites"] == 0
    assert error.value.summary["failed_batches"] == 1


@pytest.mark.asyncio
async def test_publishing_scopes_batches_and_fails_incomplete_acknowledgement():
    captured = []
    def handle(request):
        import json
        body = json.loads(request.content)
        captured.append(body)
        return httpx.Response(200, json={"processed": len(body["requested_ids"]), "matched": len(body["sites"])})
    ids = [f"DV{i:07d}" for i in range(100)]
    snapshot = {"requested_ids": ids, "sites": [], "fetched_at": "2026-11-01T00:00:00.000Z", "complete": True}
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        assert await sites.publish_snapshot(client, "https://example.com", "test", [snapshot]) == 100
    assert [len(batch["requested_ids"]) for batch in captured] == [40, 40, 20]
    assert [id_ for batch in captured for id_ in batch["requested_ids"]] == ids
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, json={"processed": 0}))) as client:
        with pytest.raises(sites.RefreshError, match="acknowledge") as error:
            await sites.publish_snapshot(client, "https://example.com", "test", [snapshot])
        assert error.value.summary["phase"] == "publish"


@pytest.mark.asyncio
async def test_d1_reference_discovery_pages_without_losing_blank_or_repeated_permits(monkeypatch):
    calls = []
    async def request(client, method, url, **kwargs):
        calls.append(kwargs["json"])
        rows = [{"reference": "", "permits": 3}] + [{"reference": f"DV{i:07d}", "permits": 2} for i in range(999)] if len(calls) == 1 else [{"reference": "DV0000999", "permits": 4}]
        return {"success": True, "result": [{"success": True, "results": rows}]}
    monkeypatch.setattr(sites, "request_json", request)
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "test-account")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "test-token")
    async with httpx.AsyncClient() as client:
        result = await sites.read_permit_references(client, sites.build_parser().parse_args(["--dry-run"]))
    assert result[""] == 3
    assert result["DV0000999"] == 4
    assert sum(result.values()) == 2005
    assert calls[1]["params"] == ["DV0000998"]


def test_publication_batches_also_bound_body_size():
    snapshot = {"requested_ids": [f"DV{i:07d}" for i in range(10)],
                "sites": [{"site_id": f"DV{i:07d}", "geometry": "x" * 900000} for i in range(10)],
                "complete": True, "fetched_at": "2026-11-01T00:00:00.000Z"}
    batches = list(sites.publication_batches([snapshot]))
    assert [len(batch["requested_ids"]) for batch in batches] == [7, 3]


@pytest.mark.asyncio
async def test_dry_run_reports_permit_and_site_coverage_without_ingest_credentials(monkeypatch, tmp_path):
    source = tmp_path / "permits.csv"
    source.write_text("parcel_number\nDV0025961\n dv0025961 \nDV9999999\n\"\"\n")
    monkeypatch.delenv("INGEST_API_TOKEN", raising=False)
    async def request(client, method, url, **kwargs):
        assert url == sites.SOURCE + "/query"
        return collection()
    monkeypatch.setattr(sites, "request_json", request)
    result = await sites.run(sites.build_parser().parse_args(["--dry-run", "--input-csv", str(source)]))
    assert result["input_permits"] == 4
    assert result["requested_sites"] == 2
    assert result["matched_permits"] == 2
    assert result["unmatched_permits"] == 1
    assert result["permits_without_valid_reference"] == 1
    assert result["published_sites"] == 0
