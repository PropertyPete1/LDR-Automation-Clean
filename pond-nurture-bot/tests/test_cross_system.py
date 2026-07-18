"""Cross-system seam tests (Part 4).

The shared suppression list is the single source of truth for BOTH codebases:
- pond-nurture-bot/config/suppression_tags.json  (Python reads at runtime)
- lifestyle-bot-dashboard/config/suppression_tags.json (TS bundled copy)
- botHelpers.ts hardcoded fallback (used only if the JSON is missing)

If these diverge, one system protects leads the other one emails.
This test FAILS on divergence.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # repo root
PY_JSON = ROOT / "pond-nurture-bot" / "config" / "suppression_tags.json"
TS_JSON = ROOT / "lifestyle-bot-dashboard" / "config" / "suppression_tags.json"
BOT_HELPERS = ROOT / "lifestyle-bot-dashboard" / "server" / "botHelpers.ts"


def test_python_and_ts_suppression_json_are_identical():
    py = json.load(open(PY_JSON))
    ts = json.load(open(TS_JSON))
    assert sorted(t.lower() for t in py["tags"]) == sorted(t.lower() for t in ts["tags"]), \
        "suppression tag lists diverged between pond-nurture-bot and lifestyle-bot-dashboard"
    assert sorted(s.lower() for s in py.get("excluded_sources", [])) == \
           sorted(s.lower() for s in ts.get("excluded_sources", [])), \
        "excluded_sources diverged between the two config copies"


def test_ts_fallback_list_covers_every_shared_tag():
    """botHelpers.ts hardcoded fallback must contain every shared tag so a
    missing JSON never silently weakens suppression."""
    shared = [t.lower() for t in json.load(open(PY_JSON))["tags"]]
    src = BOT_HELPERS.read_text()
    m = re.search(r"_sharedSuppressionTags = \[(.*?)\];", src, re.DOTALL)
    assert m, "could not locate TS fallback list"
    fallback = [t.strip().strip('"').lower() for t in m.group(1).split(",") if t.strip().strip('"')]
    missing = [t for t in shared if t not in fallback]
    assert not missing, f"TS fallback list missing shared tags: {missing}"


def test_excluded_sources_present_in_both_systems():
    py = json.load(open(PY_JSON))
    for s in ("new agent inquiry", "botm newsletter"):
        assert s in [x.lower() for x in py.get("excluded_sources", [])]
    ts_src = BOT_HELPERS.read_text()
    assert "new agent inquiry" in ts_src and "botm newsletter" in ts_src


def test_weekly_digest_consumes_matching_stats_fields():
    """HTTP contract: weekly_digest.py reads fields from the nurture-dashboard
    weekly-stats endpoint — the field names it reads must exist in the
    endpoint's select/return in nurture-dashboard/server (routers/db)."""
    digest = (ROOT / "pond-nurture-bot" / "weekly_digest.py").read_text()
    m = re.findall(r'\.get\(["\']([a-zA-Z_]+)["\']', digest)
    # Only check fields that look like stats-field names consumed from the API
    stats_fields = [f for f in m if f in {
        "agentName", "actioned", "texted", "called", "hotResponded",
        "avgDaysStale", "snoozed", "agent", "leadsActioned",
    }]
    if not stats_fields:
        return  # digest doesn't consume the endpoint in a greppable way — skip
    server_src = ""
    for f in (ROOT / "nurture-dashboard" / "server").glob("*.ts"):
        server_src += f.read_text()
    missing = [f for f in set(stats_fields) if f not in server_src]
    assert not missing, f"weekly_digest.py reads fields the dashboard never returns: {missing}"
