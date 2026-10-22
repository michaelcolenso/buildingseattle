import csv
import http.server
import importlib.util
import json
import stat
import threading
from pathlib import Path

import pytest

MODULE = Path(__file__).resolve().parents[1] / "scripts" / "seo_investigation" / "url_inspection.py"
spec = importlib.util.spec_from_file_location("url_inspection", MODULE)
ui = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(ui)


def test_read_urls_text_dedupes_and_expands_paths(tmp_path):
    f = tmp_path / "u.txt"
    f.write_text("/address/a\nhttps://x.test/permit/1\n/address/a\n\n")
    assert ui.read_urls(f, base="https://x.test/") == ["https://x.test/address/a", "https://x.test/permit/1"]


def test_read_urls_csv_with_path_column(tmp_path):
    f = tmp_path / "u.csv"
    f.write_text("p,bucket,arm\n/address/a,nf404,nudge\n/address/b,nf404,natural\n")
    assert ui.read_urls(f, base="https://x.test") == ["https://x.test/address/a", "https://x.test/address/b"]


def test_read_urls_csv_with_url_column_needs_no_base(tmp_path):
    f = tmp_path / "u.csv"
    f.write_text("url,x\nhttps://x.test/a,1\n")
    assert ui.read_urls(f) == ["https://x.test/a"]


def test_read_urls_path_without_base_is_an_error(tmp_path):
    f = tmp_path / "u.txt"
    f.write_text("/address/a\n")
    with pytest.raises(SystemExit):
        ui.read_urls(f)


def test_flatten_maps_index_status_and_tolerates_missing_fields():
    body = {
        "inspectionResult": {
            "indexStatusResult": {
                "verdict": "PASS",
                "coverageState": "Submitted and indexed",
                "lastCrawlTime": "2026-10-20T01:02:03Z",
                "googleCanonical": "https://x.test/a",
                "sitemap": ["https://x.test/s1.xml", "https://x.test/s2.xml"],
            }
        }
    }
    row = ui.flatten("https://x.test/a", 200, body)
    assert row["verdict"] == "PASS"
    assert row["coverageState"] == "Submitted and indexed"
    assert row["sitemap"] == "https://x.test/s1.xml|https://x.test/s2.xml"
    assert row["userCanonical"] == ""
    assert set(row) == set(ui.FIELDS)
    empty = ui.flatten("https://x.test/b", 400, None, "bad")
    assert empty["verdict"] == "" and empty["error"] == "bad"


def test_token_file_is_private(tmp_path):
    path = tmp_path / "t.json"
    ui._write_token(path, {"refresh_token": "r"})
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert json.loads(path.read_text()) == {"refresh_token": "r"}


class _Stub:
    """Local stand-in for the inspect endpoint: scripted per-URL responses."""

    def __init__(self, script):
        self.script = script  # inspectionUrl -> list of (status, body) consumed in order
        self.calls = []
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                assert self.headers["Authorization"] == "Bearer tok"
                assert payload["siteUrl"] == "sc-domain:x.test"
                url = payload["inspectionUrl"]
                stub.calls.append(url)
                status, body = stub.script[url].pop(0)
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/inspect"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _ok(state):
    return 200, {"inspectionResult": {"indexStatusResult": {"verdict": "PASS", "coverageState": state}}}


def _quota():
    return 429, {"error": {"code": 429, "message": "Quota exceeded", "errors": [{"reason": "rateLimitExceeded"}]}}


@pytest.fixture
def stub_env(monkeypatch):
    monkeypatch.setattr(ui.time, "sleep", lambda s: None)
    created = []

    def make(script):
        stub = _Stub(script)
        created.append(stub)
        monkeypatch.setattr(ui, "INSPECT_URL", stub.url)
        return stub

    yield make
    for stub in created:
        stub.close()


def _rows(path):
    with open(path, newline="") as fh:
        return list(csv.DictReader(fh))


def test_run_writes_rows_retries_5xx_and_records_hard_errors(tmp_path, stub_env):
    stub = stub_env({
        "https://x.test/a": [_ok("Submitted and indexed")],
        "https://x.test/b": [(503, {"error": {"message": "backend"}}), _ok("Crawled - currently not indexed")],
        "https://x.test/c": [(400, {"error": {"code": 400, "message": "not under property"}})],
    })
    out = tmp_path / "o.csv"
    counts, stopped = ui.run("sc-domain:x.test", ["https://x.test/a", "https://x.test/b", "https://x.test/c"],
                             out, lambda: "tok", limit=10, pause=0)
    rows = {r["url"]: r for r in _rows(out)}
    assert stopped == ""
    assert rows["https://x.test/a"]["coverageState"] == "Submitted and indexed"
    assert rows["https://x.test/b"]["coverageState"] == "Crawled - currently not indexed"
    assert rows["https://x.test/c"]["http_status"] == "400" and "not under property" in rows["https://x.test/c"]["error"]
    assert stub.calls.count("https://x.test/b") == 2


def test_run_stops_on_quota_keeps_results_and_resumes_without_repeating(tmp_path, stub_env):
    urls = ["https://x.test/a", "https://x.test/b", "https://x.test/c"]
    stub = stub_env({
        "https://x.test/a": [_ok("Submitted and indexed")],
        "https://x.test/b": [_quota()],
        "https://x.test/c": [],
    })
    out = tmp_path / "o.csv"
    _, stopped = ui.run("sc-domain:x.test", urls, out, lambda: "tok", limit=10, pause=0)
    assert "429" in stopped
    assert [r["url"] for r in _rows(out)] == ["https://x.test/a"]
    assert "https://x.test/c" not in stub.calls, "no calls after the quota stop"

    # next day: only the unanswered URLs are requested
    stub.script["https://x.test/b"] = [_ok("URL is unknown to Google")]
    stub.script["https://x.test/c"] = [_ok("Discovered - currently not indexed")]
    stub.calls.clear()
    _, stopped = ui.run("sc-domain:x.test", urls, out, lambda: "tok", limit=10, pause=0)
    assert stopped == ""
    assert stub.calls == ["https://x.test/b", "https://x.test/c"]
    assert [r["url"] for r in _rows(out)] == urls


def test_run_retries_urls_that_errored_last_time(tmp_path, stub_env):
    stub = stub_env({"https://x.test/a": [(400, {"error": {"message": "nope"}}), _ok("Submitted and indexed")]})
    out = tmp_path / "o.csv"
    ui.run("sc-domain:x.test", ["https://x.test/a"], out, lambda: "tok", limit=5, pause=0)
    ui.run("sc-domain:x.test", ["https://x.test/a"], out, lambda: "tok", limit=5, pause=0)
    assert stub.calls == ["https://x.test/a", "https://x.test/a"]
    assert ui.answered_urls(out) == {"https://x.test/a"}


def test_limit_caps_inspections_per_run(tmp_path, stub_env):
    stub = stub_env({f"https://x.test/{i}": [_ok("Submitted and indexed")] for i in range(5)})
    out = tmp_path / "o.csv"
    ui.run("sc-domain:x.test", [f"https://x.test/{i}" for i in range(5)], out, lambda: "tok", limit=2, pause=0)
    assert len(stub.calls) == 2
