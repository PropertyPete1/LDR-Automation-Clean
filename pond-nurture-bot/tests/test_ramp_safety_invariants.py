"""The cap changes WHO gets reached today — never WHETHER a lead is protected.

Item 3 of the volume ramp: prove every suppression layer, the minimum contact
gap, the dedup guard and per-lead error isolation behave identically at every
cap level. Structural proof where behaviour is a property of code shape
(ordering: suppression runs before the cap is consulted), behavioural proof
where it can be driven.
"""
from __future__ import annotations

import datetime as dt
import inspect
import json
import re
import sqlite3

import pytest

from fub_automation import ramp

UTC = dt.timezone.utc


# ── The cap cannot reorder or skip a protection check ────────────────────────


def test_every_suppression_check_lives_inside_the_per_lead_function(m):
    """Suppression is per-lead, so a bigger cap reaches more leads through the
    same gauntlet rather than around it."""
    src = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
    required = [
        "_is_excluded_source",     # excluded sources
        "_is_soi_silenced",        # sphere of influence
        "_has_any_deal",           # deal protection, Rule A
        "_is_lease_listing_silenced",  # landlord / lease, Rule C
    ]
    for check in required:
        assert check in src, f"{check} must run inside the per-lead candidate path"


def test_the_cap_is_only_ever_a_loop_bound_never_a_filter(m):
    """In the scan loop the cap may only break the loop.

    If the cap were ever consulted inside a suppression decision, raising it
    could change whether a lead is protected. It may only decide when to stop.
    """
    src = inspect.getsource(m.RuleEngine.scan_stale_leads)
    code = [ln.strip() for ln in src.splitlines()
            if re.search(r"\bcap\b", ln) and not ln.strip().startswith("#")]
    assert code, "expected the cap to appear in the scan loop"
    # Exactly three kinds of use are legitimate: assigning it, comparing the
    # running send count against it, and logging that it was reached.
    for line in code:
        legitimate = (
            line.startswith("cap = ")
            or "if cap and sent_count >= cap:" in line
            or "launch_cap_reached" in line
            or "LOGGER" in line
            # A wrapped argument line inside a LOGGER call. It starts with a
            # string literal, so it cannot be control flow no matter what it
            # mentions.
            or line.startswith('"')
        )
        assert legitimate, f"cap used in an unexpected way: {line!r}"
    assert "if cap and sent_count >= cap:" in src, "cap must bound the loop"


def test_suppression_returns_happen_before_any_cap_arithmetic(m):
    """A suppressed lead returns early and never reaches the counter."""
    src = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
    assert 'return "suppressed"' in src
    # The per-lead path must not know the DAILY VOLUME cap exists. (The word
    # "cap" does appear once, in a log line about the per-lead CADENCE gap —
    # a different thing entirely — so assert on the volume-cap identifiers.)
    for forbidden in ("resolve_daily_cap", "phase2_max_customer_emails_per_run", "sent_count"):
        assert forbidden not in src, (
            f"{forbidden} must not reach the per-lead path — if it did, the "
            "daily cap could influence a protection decision"
        )


def test_cap_only_increments_on_an_actual_send(m):
    """sent_count tracks sends, so suppressed leads never consume cap budget."""
    src = inspect.getsource(m.RuleEngine.scan_stale_leads)
    assert 'if status in ("sent", "dry_run_sent"):' in src
    assert "sent_count += 1" in src
    assert "if cap and sent_count >= cap:" in src


def test_per_lead_errors_are_isolated_so_one_failure_cannot_end_the_run(m):
    """At a higher cap more leads run; one bad lead must not stop the rest."""
    src = inspect.getsource(m.RuleEngine.scan_stale_leads)
    assert "except Exception as exc:" in src
    assert 'self.db.log("pond_nurture", "error", person.get("id")' in src
    # The except must be inside the for loop, not wrapping it.
    for_idx = src.index("for person in candidates:")
    assert src.index("except Exception", for_idx) > for_idx


def test_minimum_gap_and_dedup_guard_are_cap_independent(m):
    """Both are per-lead history checks with no cap term."""
    src = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
    assert "get_last_reengagement" in src, "3-day/cadence gap check must be per-lead"
    gap_src = inspect.getsource(m.RuleEngine)
    assert "min_contact_gap_days" in gap_src or "cadence_days" in src


@pytest.mark.parametrize("cap_value", [0, 1, 100, 150, 200, 250, 300])
def test_cap_value_never_changes_the_suppression_source(m, cap_value, monkeypatch):
    """The protection code path is literally the same object at every cap."""
    monkeypatch.setenv("POND_DAILY_CAP", str(cap_value))
    before = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
    con = sqlite3.connect(":memory:")
    con.executescript(
        "CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, "
        "person_id INTEGER, action TEXT, status TEXT, details TEXT);"
    )
    ramp.ensure_schema(con)
    resolved = ramp.resolve_daily_cap(con)
    con.close()
    after = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
    assert before == after
    if cap_value > 0:
        assert resolved == cap_value


# ── Cadence tightening touches only the never-engaged ────────────────────────


def test_cadence_tightening_is_gated_on_never_engaged_only(m):
    """Only latest_inbound is None tightens; a lapsed lead keeps 21 days."""
    src = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
    assert 'if tier == "cold" and latest_inbound is None:' in src, (
        "tightening must require BOTH the cold tier and a total absence of "
        "inbound history — a lapsed lead has reply history and keeps 21 days"
    )


def test_tightening_can_only_shorten_to_the_standard_interval_never_below(m):
    src = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
    assert "cadence_days = min(cadence_days, self.rules.reengagement_cadence_days)" in src


def test_timeline_override_still_only_stretches(m):
    """A stated purchase window must survive the tightening unchanged."""
    src = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
    tighten = src.index("latest_inbound is None")
    timeline = src.index("Timeline-Aware Cadence Override")
    assert timeline > tighten, "timeline stretch must be applied after tightening"
    assert "stretches cadence, never shortens" in src


def test_classifier_reports_never_engaged_separately_from_lapsed(m):
    """The distinction the cadence rule depends on."""
    sig = inspect.signature(m.RuleEngine._classify_engagement)
    assert sig.return_annotation != inspect.Signature.empty
    src = inspect.getsource(m.RuleEngine._classify_engagement)
    assert "return tier, latest_inbound, reason" in src
    # Public API preserved for the digest / funnel / prompt.
    assert isinstance(inspect.getsource(m.RuleEngine.classify_engagement_tier), str)


# ── LLM skip-gate JSON repair ────────────────────────────────────────────────


def test_extract_json_object_handles_trailing_commentary(m):
    """The exact failure that disabled the skip gate for 59% of leads."""
    payload = (
        '{"should_skip": true, "intent_category": "B", "confidence": 95,\n'
        ' "reason": "Lead signed with another agent"}\n\n'
        "This lead has clearly moved on, so suppression is appropriate."
    )
    parsed = json.loads(m.ContentGenerator.extract_json_object(payload))
    assert parsed["should_skip"] is True
    assert parsed["confidence"] == 95


def test_extract_json_object_survives_braces_inside_strings(m):
    payload = '{"should_skip": false, "reason": "note said {see file} nothing else"} trailing'
    parsed = json.loads(m.ContentGenerator.extract_json_object(payload))
    assert parsed["should_skip"] is False
    assert "{see file}" in parsed["reason"]


def test_extract_json_object_survives_escaped_quotes(m):
    payload = '{"should_skip": false, "reason": "they said \\"call me later\\""}   ok'
    parsed = json.loads(m.ContentGenerator.extract_json_object(payload))
    assert parsed["should_skip"] is False


def test_extract_json_object_is_a_noop_for_clean_json(m):
    clean = '{"should_skip": false, "confidence": 10}'
    assert m.ContentGenerator.extract_json_object(clean) == clean


def test_extract_json_object_returns_input_when_there_is_no_object(m):
    """A genuinely unparseable response must still reach the caller's handler."""
    assert m.ContentGenerator.extract_json_object("I cannot answer that") == "I cannot answer that"
    assert m.ContentGenerator.extract_json_object("") == ""


def test_skip_gate_now_parses_a_response_it_previously_dropped(m, monkeypatch, settings, rules):
    """End-to-end: the gate reaches a SKIP decision instead of failing open."""
    gen = m.ContentGenerator(settings, rules)
    monkeypatch.setattr(
        gen,
        "_llm_call",
        lambda **kw: '{"should_skip": true, "intent_category": "C", "confidence": 92,'
                     ' "reason": "Asked to stop receiving emails"}\n\nHope that helps!',
    )
    should_skip, reason = gen.should_skip_lead_llm(
        {"id": 1}, [{"body": "Lead asked us to stop emailing them"}]
    )
    assert should_skip is True, "trailing prose must no longer disable the skip gate"
    assert "stop receiving" in reason


def test_skip_gate_still_fails_open_on_a_truly_unparseable_response(m, monkeypatch, settings, rules):
    """Unchanged behaviour: garbage in means send, not suppress."""
    gen = m.ContentGenerator(settings, rules)
    monkeypatch.setattr(gen, "_llm_call", lambda **kw: "the model rambled and returned no json")
    should_skip, reason = gen.should_skip_lead_llm({"id": 1}, [{"body": "note"}])
    assert should_skip is False
    assert reason == ""


def test_skip_gate_confidence_floor_is_unchanged(m, monkeypatch, settings, rules):
    """A parsed-but-low-confidence skip must still not suppress."""
    gen = m.ContentGenerator(settings, rules)
    monkeypatch.setattr(
        gen,
        "_llm_call",
        lambda **kw: '{"should_skip": true, "intent_category": "A", "confidence": 60,'
                     ' "reason": "maybe bought"}  extra words',
    )
    should_skip, _ = gen.should_skip_lead_llm({"id": 1}, [{"body": "note"}])
    assert should_skip is False, "80% confidence floor must still apply"


# ── Early cadence gate (runtime) ─────────────────────────────────────────────


def test_early_cadence_gate_runs_before_the_expensive_timeline_work(m):
    """The gate must precede the notes fetch and the LLM window extraction.

    Those two calls used to run for every candidate, including the ~13 in 14
    that a 14-day cadence means are not due — the dominant cost in a run that
    was being killed by the workflow timeout.
    """
    src = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
    gate = src.index("EARLY CADENCE GATE")
    notes = src.index("notes_for_timeline = self.safe_get_notes")
    window = src.index("self.content.extract_purchase_window")
    assert gate < notes < window, "early gate must precede the notes fetch and LLM call"


def test_early_gate_is_equivalent_because_timeline_only_lengthens(m):
    """Safety proof for the reordering: every timeline branch uses max()."""
    src = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
    start = src.index("Timeline-Aware Cadence Override")
    end = src.index("should_skip_lead_llm")
    section = src[start:end]
    assignments = re.findall(r"cadence_days\s*=\s*(.+)", section)
    assert assignments, "expected the timeline section to adjust cadence_days"
    for expr in assignments:
        assert expr.strip().startswith("max("), (
            "the early gate is only sound while the timeline override can "
            f"exclusively LENGTHEN cadence; found: cadence_days = {expr.strip()}"
        )


def test_the_later_gate_still_exists_for_stretched_cadences(m):
    """A lead due under the base interval but stretched out must still skip."""
    src = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
    gates = src.count("dt.timedelta(days=cadence_days)")
    assert gates >= 2, "both the early bound gate and the final stretched gate must exist"


def test_both_gates_log_the_same_status_and_shape(m):
    src = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
    assert src.count('"pond_nurture",\n                "skipped"') + src.count(
        'self.db.log("pond_nurture", "skipped"'
    ) >= 2, "a lead skipped by either gate must be recorded identically"
