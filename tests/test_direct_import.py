import unittest
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import direct_import


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = str(self._payload)

    def json(self):
        return self._payload


class FakeClient:
    def __init__(self):
        self.calls = []

    async def post(self, url, json, timeout, headers=None):
        self.calls.append({"url": url, "json": json, "timeout": timeout, "headers": headers or {}})
        items = json.get("items", [])
        return FakeResponse(200, {"processed": len(items)})


class DirectImportBatchTests(unittest.IsolatedAsyncioTestCase):
    def test_chunk_items_splits_lists_into_stable_batches(self):
        items = [{"id": idx} for idx in range(5)]

        chunks = list(direct_import.chunk_items(items, 2))

        self.assertEqual(chunks, [
            [{"id": 0}, {"id": 1}],
            [{"id": 2}, {"id": 3}],
            [{"id": 4}],
        ])

    async def test_import_contractors_uses_batch_endpoint(self):
        client = FakeClient()
        contractors = [
            {"name": "Alpha", "slug": "alpha"},
            {"name": "Beta", "slug": "beta"},
            {"name": "Gamma", "slug": "gamma"},
        ]

        with patch.object(direct_import, "load_jsonl", return_value=contractors):
            imported = await direct_import.import_contractors(client, "https://example.com", batch_size=2)

        self.assertEqual(imported, 3)
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(client.calls[0]["url"], "https://example.com/ingest/contractor/batch")
        self.assertEqual(client.calls[0]["json"]["items"], contractors[:2])
        self.assertEqual(client.calls[1]["json"]["items"], contractors[2:])

    async def test_import_batch_items_sends_ingest_token_header_when_configured(self):
        client = FakeClient()

        with patch.dict(os.environ, {"INGEST_API_TOKEN": "secret-token"}, clear=False):
            imported = await direct_import.import_batch_items(
                client,
                "https://example.com",
                "/ingest/permit/batch",
                [{"permit_number": "PERM123"}],
                "permits",
                batch_size=100,
            )

        self.assertEqual(imported, 1)
        self.assertEqual(client.calls[0]["headers"]["X-Ingest-Token"], "secret-token")

    async def test_replace_all_data_calls_guarded_refresh_endpoint(self):
        client = FakeClient()

        with patch.dict(os.environ, {"INGEST_API_TOKEN": "secret-token"}, clear=False):
            await direct_import.replace_all_data(client, "https://example.com")

        self.assertEqual(client.calls[0]["url"], "https://example.com/ingest/refresh")
        self.assertEqual(client.calls[0]["json"], {"confirm": "replace-all"})
        self.assertEqual(client.calls[0]["headers"]["X-Ingest-Token"], "secret-token")

    def test_ingest_headers_can_read_local_dev_vars(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            dev_vars = Path(tmpdir) / ".dev.vars"
            dev_vars.write_text("INGEST_API_TOKEN=local-token\n")
            original_cwd = os.getcwd()
            try:
                os.chdir(tmpdir)
                with patch.dict(os.environ, {}, clear=True):
                    headers = direct_import.ingest_headers()
            finally:
                os.chdir(original_cwd)

        self.assertEqual(headers, {"X-Ingest-Token": "local-token"})


if __name__ == "__main__":
    unittest.main()
