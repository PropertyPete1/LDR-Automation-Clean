"""Email-only portal policy must not leak into staff, inbound or timer lanes."""
import ast
import datetime as dt
import importlib.util
import inspect
from pathlib import Path

import pytest

from fub_automation.portal import PORTAL_TAGS

ROOT = Path(__file__).resolve().parents[1]
PID = 990001
AGENT = 35
UTC = dt.timezone.utc
EVIDENCE = [
    {"source": "Zillow", "tags": ["zillow"]},
    {"source": "Realtor.com", "tags": ["realtor.com"]},
    {"source": "Realtor DOT COM", "tags": ["realtor dot com"]},
    {"source": "Website Form", "leadSource": "Zillow", "tags": []},
    {"source": "Website Form", "sourceUrl": "https://sub.realtor.com./lead", "tags": []},
    {"source": "Website Form", "isZillowPACLead": True, "tags": []},
]


def person(evidence, **extra):
    record = {"id": PID, "firstName": "Synthetic", "lastName": "Fixture", "stage": "Lead",
              "source": "Website Form", "tags": [], "assignedUserId": AGENT}
    record.update(evidence)
    record.update(extra)
    return record


@pytest.mark.parametrize("evidence", EVIDENCE)
def test_nonbroadcast_internal_agent_reminder_still_selects_portal(engine, monkeypatch, evidence):
    record = person(evidence)
    engine.rules.agent_reminder_emails_enabled = True
    engine.rules.agent_reminder_broadcast_mode_enabled = False
    monkeypatch.setattr(engine.fub, "get_people", lambda **kw: [record])
    reminders = []
    monkeypatch.setattr(engine, "send_agent_reminder_digest", lambda agent, people: reminders.append((agent, people)))
    engine.scan_agent_followup()
    assert reminders == [(AGENT, [record])]


@pytest.mark.parametrize("evidence", EVIDENCE)
def test_untouched_assignment_watch_and_alert_still_include_portal(engine, monkeypatch, evidence):
    now = dt.datetime.now(UTC)
    record = person(evidence, lastActivity=(now - dt.timedelta(hours=50)).isoformat())
    monkeypatch.setattr(engine.fub, "get_people", lambda **kw: [record])
    monkeypatch.setattr(engine, "user_cache_by_id", lambda: {AGENT: {"name": "Synthetic Agent", "status": "Active"}})
    monkeypatch.setattr(engine, "lead_touched_after_creation", lambda *a: False)
    writes = []
    monkeypatch.setattr(engine.fub, "create_task", lambda *a, **kw: writes.append("task"))
    monkeypatch.setattr(engine.fub, "add_note", lambda *a, **kw: writes.append("note"))
    engine.scan_untouched_assignments()
    assert engine.db.get_assignment_watch(PID) is not None
    assert writes == []
    engine.db.upsert_assignment_watch(PID, AGENT, first_seen_at=(now - dt.timedelta(hours=25)).isoformat())
    engine.scan_untouched_assignments()
    assert writes == ["task", "note"]
    assert engine.db.get_assignment_watch(PID)["last_alert_at"] is not None


@pytest.mark.parametrize("evidence", EVIDENCE)
def test_speed_poll_preserves_timer_and_internal_alert_for_portal(engine, fake_http, monkeypatch, evidence):
    now = dt.datetime.now(UTC)
    created = now - dt.timedelta(minutes=10)
    record = person(evidence, created=created.isoformat(), updated=(created + dt.timedelta(seconds=4)).isoformat(),
                    createdVia="Manually", createdById=2, updatedById=2, assignedPondId=None)
    fake_http.responses = [(200, {"people": [record]}), (200, {"people": [record]}), (200, {"notes": []})]
    alerts = []
    monkeypatch.setattr(engine, "_send_speed_to_lead_agent_alert", lambda *a: alerts.append(a))
    engine.poll_new_leads()
    assert [int(row["person_id"]) for row in engine.db.active_new_lead_timers()] == [PID]
    assert len(alerts) == 1


@pytest.mark.parametrize("evidence", EVIDENCE)
def test_assignment_change_preserves_timer_and_internal_alert_for_portal(engine, fake_http, monkeypatch, evidence):
    now = dt.datetime.now(UTC)
    record = person(evidence, created=(now - dt.timedelta(days=30)).isoformat(),
                    updated=(now - dt.timedelta(minutes=1)).isoformat(),
                    createdVia="API", createdById=2, updatedById=2, assignedPondId=None)
    engine.db.upsert_assignment_watch(PID, 1)
    fake_http.responses = [(200, {"people": [record]}), (200, {"people": [record]}), (200, {"notes": []})]
    alerts = []
    monkeypatch.setattr(engine, "_send_speed_to_lead_agent_alert", lambda *a: alerts.append(a))
    engine.scan_assignment_changes()
    assert [int(row["person_id"]) for row in engine.db.active_new_lead_timers()] == [PID]
    assert len(alerts) == 1


@pytest.mark.parametrize("evidence", EVIDENCE)
def test_stale_agent_assignment_still_routes_portal(engine, monkeypatch, evidence):
    record = person(evidence)
    monkeypatch.setattr(engine, "_has_any_deal", lambda *a: False)
    monkeypatch.setattr(engine, "has_recent_omnichannel_touch", lambda *a: False)
    monkeypatch.setattr(engine, "user_cache_by_id", lambda: {})
    routed = []
    monkeypatch.setattr(engine.fub, "assign_to_pond", lambda *a: routed.append(a))
    monkeypatch.setattr(engine.fub, "add_note", lambda *a: None)
    assert engine.process_stale_agent_no_note_candidate(record) == "completed"
    assert routed == [(PID, int(engine.rules.stale_agent_reassign_pond_id))]


@pytest.mark.parametrize("source", ["New Agent Inquiry - channel", "Agent Scouting - channel", "BOTM Newsletter - channel",
                                    "Zillow Rentals - Austin", "Lease Listing Inquiry - Web"])
def test_portal_independent_source_mode_keeps_all_old_source_rules(engine, source):
    assert engine._is_excluded_source(person({"source": source}), portal_exclusion=False) == source


@pytest.mark.parametrize("tag", ["realtor", "agent", "unsubscribe", "unsubscribed", "do not contact", "do not email", "dnc",
                                 "manual review", "spam", "annual nurture only", "replied - paused", "bot_suppress", "landlord"])
def test_portal_independent_tag_mode_keeps_old_tag_rules(engine, tag):
    assert engine.is_excluded(person({"source": "Zillow", "tags": [tag]}), portal_exclusion=False)


@pytest.mark.parametrize("tag", PORTAL_TAGS)
def test_all_added_aliases_bypass_only_new_portal_semantics(engine, tag):
    record = person({"source": tag, "tags": [{"name": tag}]})
    assert engine.is_excluded(record)
    assert not engine.is_excluded(record, portal_exclusion=False)
    assert engine._is_excluded_source(record, portal_exclusion=False) is None
    record["tags"].append({"name": "agent"})
    assert engine.is_excluded(record, portal_exclusion=False)


def test_all_nonemail_generic_callers_explicitly_disable_new_portal_semantics(m):
    functions = {"scan_pond_responses_for_intent", "scan_all_leads_for_disqualification", "scan_email_address_updates",
                 "scan_agent_followup", "process_stale_agent_no_note_candidate", "send_phase2_daily_summary",
                 "scan_untouched_assignments", "scan_assignment_changes", "poll_new_leads", "_reply_scan_skips"}
    tree = ast.parse((ROOT / "src/fub_automation/main.py").read_text())
    checked = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef) or node.name not in functions:
            continue
        for call in ast.walk(node):
            if isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr in {"is_excluded", "_is_excluded_source"}:
                flags = {kw.arg: kw.value for kw in call.keywords}
                assert isinstance(flags.get("portal_exclusion"), ast.Constant), node.name
                assert flags["portal_exclusion"].value is False, node.name
                checked.add(node.name)
    assert checked == functions
    assert "portal_email_gate" not in inspect.getsource(m.EmailSender.send)


def test_assignment_diagnostic_uses_nonemail_poll_exclusions(engine):
    spec = importlib.util.spec_from_file_location("portal_synthetic_assignment_diagnostic", ROOT / "investigate_assignments.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    now = dt.datetime.now(UTC)
    record = person({"source": "Zillow", "tags": ["zillow"]}, created=now.isoformat())
    assert module.poll_gate_verdict(engine, record, now - dt.timedelta(days=1)) == "timer"
    record["source"] = "Zillow Rentals - Austin"
    assert module.poll_gate_verdict(engine, record, now - dt.timedelta(days=1)).startswith("GATE excluded source")
