"""Cross-system seam tests (Part 4).

The shared suppression list is the single source of truth for BOTH codebases:
- pond-nurture-bot/config/suppression_tags.json  (Python reads at runtime)
- lifestyle-bot-dashboard/config/suppression_tags.json (TS bundled copy)
- botHelpers.ts hardcoded fallback (used only if the JSON is missing)

If these diverge, one system protects leads the other one emails.
This test FAILS on divergence.
"""
import ast
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # repo root
PY_JSON = ROOT / "pond-nurture-bot" / "config" / "suppression_tags.json"
TS_JSON = ROOT / "lifestyle-bot-dashboard" / "config" / "suppression_tags.json"
BOT_HELPERS = ROOT / "lifestyle-bot-dashboard" / "server" / "botHelpers.ts"

# There are THREE JSON copies and TWO botHelpers.ts fallbacks, not two and one.
# The nurture-dashboard pair was unguarded, and drifted: 06234ba added
# "not now - 30 day pause" there and to nurture's fallback, while
# pond-nurture-bot and lifestyle-bot-dashboard silently kept the old 20-tag
# list — so agent-bot mail ignored a tag the reply handler was setting.
ALL_JSON = [
    PY_JSON,
    TS_JSON,
    ROOT / "nurture-dashboard" / "config" / "suppression_tags.json",
]
ALL_BOT_HELPERS = [
    BOT_HELPERS,
    ROOT / "nurture-dashboard" / "server" / "botHelpers.ts",
]


def _semantic_sources(values):
    """Collapse only exact portal spelling aliases; retain all unrelated entries."""
    from fub_automation.portal import normalize_source
    result = set()
    for value in values:
        lower = value.lower()
        normalized = normalize_source(value)
        if normalized in {"realtor com", "realtordotcom", "realtor dot com"}:
            lower = "realtor.com"
        result.add(lower)
    return sorted(result)


def _ts_array_values(path, name, seen=None):
    """Read the actual fallback literals, following only named relative imports.

    A spread must resolve to an explicit constant array; unrelated strings or
    comments elsewhere in a module cannot satisfy a missing fallback entry.
    """
    seen = set() if seen is None else seen
    key = (path.resolve(), name)
    assert key not in seen, f"cyclic fallback constant: {name}"
    seen.add(key)
    source = path.read_text()
    match = re.search(rf"\b{re.escape(name)}\s*(?::[^=;]+)?=\s*\[([^\]]*)\]", source, re.DOTALL)
    if not match:
        for imports, module in re.findall(r'import\s*\{([^}]+)\}\s*from\s*[\"\'](\.[^\"\']+)[\"\']', source):
            for binding in imports.split(","):
                parts = re.split(r"\s+as\s+", binding.strip())
                if parts[-1] == name:
                    target = (path.parent / module).with_suffix(".ts")
                    return _ts_array_values(target, parts[0], seen)
        raise AssertionError(f"could not resolve fallback constant {name} in {path}")
    values = []
    for entry in match.group(1).split(","):
        entry = entry.strip()
        if not entry:
            continue
        if entry.startswith("..."):
            assert re.fullmatch(r"\.\.\.[A-Za-z_]\w*", entry), f"unsupported fallback spread: {entry}"
            values.extend(_ts_array_values(path, entry[3:], seen.copy()))
        else:
            value = ast.literal_eval(entry)
            assert isinstance(value, str), f"non-string fallback: {entry}"
            values.append(value.lower())
    return values


def test_python_and_ts_suppression_json_are_identical():
    py = json.load(open(PY_JSON))
    ts = json.load(open(TS_JSON))
    assert sorted(t.lower() for t in py["tags"]) == sorted(t.lower() for t in ts["tags"]), \
        "suppression tag lists diverged between pond-nurture-bot and lifestyle-bot-dashboard"
    assert _semantic_sources(py.get("excluded_sources", [])) == \
           _semantic_sources(ts.get("excluded_sources", [])), \
        "excluded_sources diverged between the two config copies"


def test_all_three_suppression_json_copies_are_identical():
    """Regression for the drift above: every copy must carry the same tags and
    sources. Two-way comparison let the third copy diverge unnoticed."""
    loaded = {p: json.load(open(p)) for p in ALL_JSON}
    ref_path, ref = next(iter(loaded.items()))
    for p, d in loaded.items():
        assert sorted(t.lower() for t in d["tags"]) == sorted(t.lower() for t in ref["tags"]), \
            f"tags diverged: {p.relative_to(ROOT)} vs {ref_path.relative_to(ROOT)}"
        assert _semantic_sources(d.get("excluded_sources", [])) == \
               _semantic_sources(ref.get("excluded_sources", [])), \
            f"excluded_sources diverged: {p.relative_to(ROOT)} vs {ref_path.relative_to(ROOT)}"


def test_lease_and_landlord_are_suppressed_everywhere():
    """A /lease-page or landlord lead must never enter buyer nurture.

    Deal-based 'Rule C' only silences someone who already holds a CLOSED lease
    deal (pipeline 5). A fresh lease inquiry has no deal yet, so without these
    entries it fell straight through into buyer nurture."""
    for p in ALL_JSON:
        d = json.load(open(p))
        tags = [t.lower() for t in d["tags"]]
        srcs = [s.lower() for s in d.get("excluded_sources", [])]
        assert "landlord" in tags, f"{p.relative_to(ROOT)} missing 'landlord' tag"
        assert "lease listing inquiry" in tags, f"{p.relative_to(ROOT)} missing lease tag"
        assert "lease listing inquiry" in srcs, f"{p.relative_to(ROOT)} missing lease source"
    for h in ALL_BOT_HELPERS:
        src = h.read_text().lower()
        assert "landlord" in src, f"{h.relative_to(ROOT)} fallback missing 'landlord'"
        assert "lease listing inquiry" in src, f"{h.relative_to(ROOT)} fallback missing lease"


def test_every_ts_fallback_covers_every_shared_tag():
    """Both botHelpers.ts fallbacks — not just lifestyle's — must cover the
    shared list, or a missing JSON silently weakens suppression in that project."""
    shared = [t.lower() for t in json.load(open(PY_JSON))["tags"]]
    for h in ALL_BOT_HELPERS:
        fallback = _ts_array_values(h, "_sharedSuppressionTags")
        missing = [t for t in shared if t not in fallback]
        assert not missing, f"{h.relative_to(ROOT)} fallback missing: {missing}"


def test_ts_fallback_list_covers_every_shared_tag():
    """botHelpers.ts hardcoded fallback must contain every shared tag so a
    missing JSON never silently weakens suppression."""
    shared = [t.lower() for t in json.load(open(PY_JSON))["tags"]]
    fallback = _ts_array_values(BOT_HELPERS, "_sharedSuppressionTags")
    missing = [t for t in shared if t not in fallback]
    assert not missing, f"TS fallback list missing shared tags: {missing}"


def test_excluded_sources_present_in_both_systems():
    py = json.load(open(PY_JSON))
    for s in ("new agent inquiry", "botm newsletter"):
        assert s in [x.lower() for x in py.get("excluded_sources", [])]
    ts_src = BOT_HELPERS.read_text()
    assert "new agent inquiry" in ts_src and "botm newsletter" in ts_src


def test_excluded_source_fallbacks_cover_every_shared_source():
    """The hardcoded source fallbacks lagged the JSON — 'zillow rentals' was in
    every JSON copy but in no fallback, so a failed JSON load re-enabled mail to
    Zillow Rentals leads."""
    shared = [s.lower() for s in json.load(open(PY_JSON))["excluded_sources"]]
    fallbacks = {h.relative_to(ROOT): _ts_array_values(h, "_sharedExcludedSources") for h in ALL_BOT_HELPERS}
    tree = ast.parse((ROOT / "pond-nurture-bot" / "src" / "fub_automation" / "main.py").read_text())
    lists = [node.value for node in ast.walk(tree) if isinstance(node, ast.Assign)
             and any(isinstance(target, ast.Name) and target.id == "shared_excluded_sources"
                     for target in node.targets) and isinstance(node.value, ast.List)]
    assert len(lists) == 1, "could not locate Python excluded-source fallback"
    fallbacks["pond-nurture-bot/main.py"] = ast.literal_eval(lists[0])
    for name, fallback in fallbacks.items():
        missing = [s for s in _semantic_sources(shared) if s not in _semantic_sources(fallback)]
        assert not missing, f"{name} excluded-source fallback missing: {missing}"


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


# ── excluded_sources: CONTAINS matching (audit-fix) ────────────────────────

class _FakeRules:
    def __init__(self, sources):
        self.excluded_sources = [s.lower() for s in sources]


class _Matcher:
    """Bind the real _is_excluded_source to a stub carrying only .rules."""
    def __init__(self, sources):
        self.rules = _FakeRules(sources)

    def match(self, source):
        import sys as _sys
        _sys.path.insert(0, str(ROOT / "pond-nurture-bot" / "src"))
        from fub_automation.main import RuleEngine
        return RuleEngine._is_excluded_source(self, {"source": source})


CANON_SOURCES = ["New Agent Inquiry", "BOTM Newsletter", "Zillow Rentals", "Lease Listing Inquiry"]


def test_excluded_source_matches_suffixed_variants():
    """FUB appends channel/campaign suffixes; exact matching let them all through."""
    m = _Matcher(CANON_SOURCES)
    for variant in (
        "Lease Listing Inquiry - Web",
        "lease listing inquiry",
        "LEASE LISTING INQUIRY (Website Form)",
        "Zillow Rentals - Austin",
        "New Agent Inquiry 2026",
        "  BOTM Newsletter  ",
    ):
        assert m.match(variant), f"{variant!r} should be suppressed"


def test_legit_buyer_sources_never_false_match():
    """Unrelated source rules stay intact; portal sources are tested separately."""
    m = _Matcher(CANON_SOURCES)
    for legit in (
        "Website Form",
        "Open House",
        "Referral",
        "Agent Referral",       # must not be caught by "New Agent Inquiry"
        "Newsletter Signup",    # must not be caught by "BOTM Newsletter"
        "Lease",                # shorter than the excluded entry
    ):
        assert m.match(legit) is None, f"{legit!r} must NOT be suppressed"


def test_excluded_source_empty_and_missing_are_safe():
    m = _Matcher(CANON_SOURCES)
    assert m.match("") is None
    assert m.match(None) is None
    # An empty entry in config must never match everything.
    assert _Matcher(["", "Zillow Rentals"]).match("Website Form") is None


def test_ts_recruiting_sources_match_rules_yaml():
    """botHelpers.ts RECRUITING_SOURCES must equal rules.yaml recruiting_sources:
    the SOI carve-out for imported recruits (2026-09-28) reads the list in both
    systems, and a recruit one system keeps the other must not silence."""
    import yaml

    rules = yaml.safe_load(open(ROOT / "pond-nurture-bot" / "config" / "rules.yaml"))
    expected = sorted(str(s).lower() for s in rules["recruiting_sources"])
    src = BOT_HELPERS.read_text()
    match = re.search(r"RECRUITING_SOURCES[^=]*=\s*\[([^\]]*)\]", src)
    assert match, "RECRUITING_SOURCES not found in lifestyle-bot-dashboard botHelpers.ts"
    ts = sorted(s.lower() for s in re.findall(r'"([^"]+)"', match.group(1)))
    assert ts == expected, f"recruiting sources diverged: rules.yaml {expected} vs botHelpers.ts {ts}"


def test_fallback_inspection_resolves_explicit_imported_constants(tmp_path):
    (tmp_path / "portal.ts").write_text('export const PORTAL_SOURCE_NAMES: readonly string[] = ["zillow", "realtor.com"];\n')
    helper = tmp_path / "helper.ts"
    helper.write_text('import { PORTAL_SOURCE_NAMES } from "./portal";\n'
                      'let _sharedExcludedSources: string[] | null = null;\n'
                      '_sharedExcludedSources = ["zillow rentals", ...PORTAL_SOURCE_NAMES];\n'
                      '// new agent inquiry is not a fallback entry\n')
    values = _ts_array_values(helper, "_sharedExcludedSources")
    assert values == ["zillow rentals", "zillow", "realtor.com"]
    assert "new agent inquiry" not in values
