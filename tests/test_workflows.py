"""Static checks on .github/workflows (audit B4, B5, B6, B12)."""

import re
from pathlib import Path

import pytest

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"
SCHEDULED = ("enrich-daily.yml", "development-sites.yml", "data-freshness.yml", "seo-health.yml")
USES = re.compile(r"^\s*(?:-\s*)?uses:\s*(\S+)", re.MULTILINE)


def workflow_texts():
    return {path.name: path.read_text(encoding="utf-8") for path in sorted(WORKFLOWS.glob("*.yml"))}


def test_one_shot_basis_reset_workflow_is_gone():
    assert not (WORKFLOWS / "basis-reset-ingest-once.yml").exists()


def test_no_workflow_posts_through_workers_dev():
    for name, text in workflow_texts().items():
        assert not re.search(r"https?://[^\s\"']*\.workers\.dev", text), name


def test_third_party_actions_are_pinned_to_full_shas():
    for name, text in workflow_texts().items():
        for ref in USES.findall(text):
            if ref.startswith("./"):
                continue  # local reusable workflow
            assert re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", ref), f"{name}: {ref}"


def test_every_workflow_declares_permissions_and_job_timeouts():
    for name, text in workflow_texts().items():
        assert re.search(r"^permissions:", text, re.MULTILINE) or "workflow_call" in text, name
        runner_jobs = len(re.findall(r"^\s+runs-on:", text, re.MULTILINE))
        timeouts = len(re.findall(r"^\s+timeout-minutes:", text, re.MULTILINE))
        assert timeouts >= runner_jobs, f"{name}: every runner job needs timeout-minutes"


def test_scheduled_workflows_have_concurrency_and_failure_alerts():
    texts = workflow_texts()
    for name in SCHEDULED:
        text = texts[name]
        assert re.search(r"^concurrency:", text, re.MULTILINE), name
        # seo-health keeps its own issue logic; the rest use the shared notifier.
        assert "notify-failure.yml" in text or "issues.create" in text, name
        assert "issues: write" in text, name


def test_enrich_daily_uses_the_lockfile_and_no_inline_inputs():
    text = workflow_texts()["enrich-daily.yml"]
    assert "uv sync --frozen" in text
    assert "pip install" not in text
    run_blocks = text.split("run: |")[1:]
    assert run_blocks and all("${{" not in block.split("\n  notify:")[0] for block in run_blocks)


def test_workflows_parse_as_yaml():
    yaml = pytest.importorskip("yaml")
    for name, text in workflow_texts().items():
        data = yaml.safe_load(text)
        assert data.get("jobs"), name


def test_test_workflow_pins_node_for_node_sqlite_and_checks_the_bundle():
    """Review S9: node:sqlite needs Node >= 22.13; a dry-run deploy proves the bundle builds."""
    text = workflow_texts()["test.yml"]
    version = re.search(r"node-version:\s*'([^']+)'", text).group(1)
    assert version == ">=22.13.0 <23", version
    assert "npm ci" in text
    assert text.index("npm ci") < text.index("wrangler deploy --dry-run")
    assert re.search(r"npx wrangler deploy --dry-run --outdir \S+", text)
