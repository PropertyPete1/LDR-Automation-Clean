"""Synthetic portal regressions: no live bots, transports, or customer fixtures."""
import ast
import datetime as dt
import inspect
import json
from pathlib import Path

import pytest

from fub_automation import portal
from portal_history_fakes import complete_history

PID = 990001
ROOT = Path(__file__).resolve().parents[1]
PATHS = (
    "congrats", "closed", "long_term", "seller", "pond", "welcome", "recruiting",
)


@pytest.mark.parametrize("value", [
    "Zillow", "ZILLOW™ Premier", "prefix zillow® rentals", "Realtor.com",
    "REALTOR® . COM", "realtor com - channel", "realtordotcom", "Realtor DOT COM",
    "REALTOR℠--DOT..COM campaign", "prefix Realtor.com campaign",
])
def test_source_variants(value):
    assert portal.has_portal_provenance({"source": value})
    assert portal.has_portal_provenance({"source": "Website Form", "leadSource": value})


@pytest.mark.parametrize("value", [
    "realtor", "agent", "Realtor referral", "Agent Inquiry", "Website Form", "", None,
    "Trulia", "HotPads", "Homes.com", "Opcity", "realtor company",
    "Realtor.commercial", "Realtordotcompany", "Realtor DOT COMmercial",
])
def test_nonportal_controls(value):
    assert not portal.has_portal_provenance({"source": value})


@pytest.mark.parametrize("host,expected", [
    ("zillow.com", True), ("sub.zillow.com", True), ("realtor.com", True),
    ("www.realtor.com", True), ("evilzillow.com", False),
    ("zillow.com.example.invalid", False), ("realtor.com.example.invalid", False),
    ("notrealtor.com", False), ("example.invalid/zillow.com", False),
    ("example.invalid@zillow.com", True), ("zillow.com@example.invalid", False),
    ("zillow.com./lead", True), ("sub.realtor.com./lead", True),
    ("zillow.com.example.invalid./lead", False), ("evilrealtor.com./lead", False),
])
def test_url_hosts(host, expected):
    assert portal.portal_url("https://" + host) is expected


@pytest.mark.parametrize("value,expected", [
    ("Zillow - source", True), ("Zillow®", True), ("Realtor.com inquiry", True),
    ("REALTOR™ DOT COM - source", True), ("realtordotcom", True),
    ("not Zillow", False), ("Realtor referral", False), ("agent", False),
    ("Realtor company", False), ("Realtor.commercial", False),
    ("realtordotcompany", False), ("REALTOR℠ dot com - campaign", True),
])
def test_whole_tag_prefixes(value, expected):
    assert portal.has_portal_provenance({"tags": [value]}) is expected
    assert portal.has_portal_provenance({"tags": [{"name": value}]}) is expected


@pytest.mark.parametrize("field", ["originalSource", "eventSource", "original", "event", "originalProvenance", "eventProvenance", "events", "provenance"])
def test_explicit_loaded_provenance(field):
    value = "Zillow" if field.endswith("Source") else {"source": "Zillow"}
    if field in ("events", "provenance"):
        value = [value]
    assert portal.has_portal_provenance({"source": "Website Form", field: value})


@pytest.mark.parametrize("field", ["notes", "note", "message", "email", "emails", "body", "text", "subject", "createdVia", "sourceId", "payload", "data", "triggerSnippet"])
def test_never_communication_text_or_unmapped_fields(field):
    assert not portal.has_portal_provenance({"source": "Website Form", field: "Zillow"})
    assert not portal.has_portal_provenance({"source": "Website Form", field: {"source": "Zillow"}})


@pytest.mark.parametrize("current", [
    None, {}, [], {"id": PID}, {"id": PID + 1, "source": ""},
    {"id": PID, "source": {}}, {"id": PID, "leadSource": []},
    {"id": PID, "sourceUrl": 9}, {"id": PID, "tags": "Zillow"},
    {"id": PID, "tags": []}, {"id": PID, "tags": None},
    {"id": PID, "sourceUrl": ""}, {"id": PID, "sourceUrl": None},
    {"id": PID, "source": "", "tags": [None]},
    {"id": PID, "source": None, "leadSource": True},
    {"id": PID, "source": "", "tags": [{"tag": "Website Form"}]},
])
def test_unusable_fresh_person_fails_closed(current):
    decision = portal.portal_email_gate(PID, lambda pid: current)
    assert not decision.allowed
    assert decision.reason == portal.PORTAL_FRESH_UNAVAILABLE


def test_failed_read_with_original_portal_keeps_portal_reason():
    def loader(pid):
        raise RuntimeError("synthetic unavailable")
    decision = portal.portal_email_gate(PID, loader, {"source": "Zillow"})
    assert decision.reason == portal.PORTAL_EXCLUDED


@pytest.mark.parametrize("pid", [None, False, True, 0, -1, {}, "invalid", 1.5, 1.0,
                                   [], [PID], "0990001", "+990001", "990001.0", " 990001", "990001 ", "９９０００１", 9007199254740992])
def test_unresolvable_person_id_does_not_read(pid):
    def forbidden(_):
        raise AssertionError("unexpected synthetic read")
    decision = portal.portal_email_gate(pid, forbidden)
    assert decision.reason == portal.PORTAL_PERSON_ID_UNUSABLE


@pytest.mark.parametrize("current", [
    {"id": PID, "source": ""}, {"id": PID, "source": None},
    {"id": PID, "leadSource": ""}, {"id": PID, "leadSource": None},
    {"id": PID, "source": "Realtor referral"},
])
def test_usable_blank_and_nonportal_fresh_proceeds(current):
    assert portal.portal_email_gate(PID, lambda pid: current, event_page_loader=complete_history).allowed


@pytest.fixture
def sending(engine, monkeypatch):
    calls = {"send": 0, "note": 0, "fresh": 0, "history": 0}
    current = {"id": PID, "source": "Website Form", "tags": []}
    def load(pid):
        calls["fresh"] += 1
        value = current["value"] if "value" in current else current
        if isinstance(value, Exception):
            raise value
        return value
    monkeypatch.setattr(engine.fub, "get_person", load)
    def history(pid, **kwargs):
        calls["history"] += 1
        return complete_history(pid, **kwargs)
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page", history)
    monkeypatch.setattr(engine.email, "send", lambda *a, **k: calls.__setitem__("send", calls["send"] + 1))
    monkeypatch.setattr(engine.fub, "add_note", lambda *a, **k: calls.__setitem__("note", calls["note"] + 1))
    monkeypatch.setattr(engine.fub, "get_deals_for_person", lambda pid: [])
    for name in ("_is_lease_listing_silenced", "_has_any_deal", "was_contacted_recently"):
        monkeypatch.setattr(engine, name, lambda *a, **k: False)
    monkeypatch.setattr(engine, "_has_closed_purchase_deal", lambda *a: True)
    monkeypatch.setattr(engine, "qualifies_for_reengagement", lambda *a: True)
    monkeypatch.setattr(engine, "safe_get_notes", lambda *a: [])
    monkeypatch.setattr(engine, "get_recent_email_thread", lambda *a, **k: "")
    monkeypatch.setattr(engine, "_last_outbound_fub_email_at", lambda *a: None)
    monkeypatch.setattr(engine, "_classify_engagement", lambda *a: ("standard", None, ""))
    monkeypatch.setattr(engine, "_check_incoming_opt_out", lambda *a: None)
    monkeypatch.setattr(engine, "city_for_customer_nurture", lambda *a: "")
    monkeypatch.setattr(engine, "customer_nurture_context", lambda *a, **k: ("", "", ""))
    monkeypatch.setattr(engine.content, "extract_purchase_window", lambda *a: None)
    monkeypatch.setattr(engine.content, "should_skip_lead_llm", lambda *a: (False, ""))
    generated = {"subject": "synthetic subject", "email_body": "synthetic body"}
    for name in ("generate", "generate_congrats_email", "generate_closed_drip_email",
                 "generate_long_term_nurture_email", "generate_welcome_email", "grounded_generate"):
        monkeypatch.setattr(engine.content, name, lambda *a, **k: dict(generated))
    engine.rules.pond_nurture_sms_enabled = False
    return engine, calls, current


def invoke(engine, path, evidence=None):
    # An intentionally synthetic Gmail inbox tests that recipient domains are
    # never used as a portal classifier. No real message is created or sent.
    record = {"id": PID, "source": "Website Form", "stage": "Lead", "tags": [],
              "emails": [{"value": "portal-fixture-990001@gmail.com"}]}
    record.update(evidence or {})
    if path == "welcome":
        return engine.send_instant_welcome_email(PID, record)
    if path == "recruiting":
        record["source"] = "New Agent Inquiry"
        engine.db.enroll_recruit(PID, record["source"], dt.datetime.now(dt.timezone.utc).isoformat())
        return engine._send_recruiting_email(record, {}, dt.datetime.now(dt.timezone.utc))
    methods = {
        "congrats": "process_congrats_candidate", "closed": "process_closed_drip_candidate",
        "long_term": "process_long_term_nurture_candidate", "seller": "process_seller_nurture_candidate",
        "pond": "process_reengagement_candidate",
    }
    return getattr(engine, methods[path])(record)


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("mode", ["changed", "tag", "url", "masked", "unreadable", "malformed", "missing_source", "fractional_id", "nonportal", "blank"])
def test_every_contact_path_rechecks_current_before_send(sending, path, mode, monkeypatch):
    engine, calls, current = sending
    values = {
        "changed": {"id": PID, "source": "Zillow"},
        "tag": {"id": PID, "source": "Website Form", "tags": ["Realtor.com - source"]},
        "url": {"id": PID, "source": "Website Form", "sourceUrl": "https://sub.zillow.com/"},
        "masked": {"id": PID, "source": "Website Form", "leadSource": "Realtor dot com"},
        "unreadable": RuntimeError("synthetic unavailable"),
        "malformed": {"id": PID, "source": {}},
        "missing_source": {"id": PID, "tags": []},
        "fractional_id": {"id": PID + 0.5, "source": ""},
        "nonportal": {"id": PID, "source": "Website Form", "tags": []},
        "blank": {"id": PID, "source": "", "tags": []},
    }
    if path == "welcome":
        initial = {"id": PID, "source": "Website Form", "tags": [],
                   "emails": [{"value": "portal-fixture-990001@gmail.com"}]}
        sequence = iter([initial, values[mode]])
        def welcome_load(pid):
            calls["fresh"] += 1
            value = next(sequence)
            if isinstance(value, Exception):
                raise value
            return value
        monkeypatch.setattr(engine.fub, "get_person", welcome_load)
        monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a: [])
    else:
        current["value"] = values[mode]
    status = invoke(engine, path)
    allowed = mode in ("nonportal", "blank")
    assert status == ("dry_run_sent" if allowed else "deferred" if mode in ("unreadable", "malformed", "missing_source", "fractional_id") else "suppressed")
    assert calls["send"] == int(allowed)
    assert calls["fresh"] == (2 if path == "welcome" else 1)
    assert calls["history"] == int(allowed)
    if not allowed:
        assert calls["note"] == 0
        with engine.db.connect() as con:
            assert con.execute("SELECT COUNT(*) FROM audit_log WHERE status IN ('sent','dry_run_sent')").fetchone()[0] == 0
            assert con.execute("SELECT COUNT(*) FROM seller_send_claims").fetchone()[0] == 0
            assert con.execute("SELECT COUNT(*) FROM recruiting_send_claims").fetchone()[0] == 0


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("evidence", [
    {"leadSource": "Zillow"}, {"tags": ["Realtor.com source"]},
    {"sourceUrl": "https://zillow.com/"}, {"originalSource": "Realtor.com"},
    {"event": {"source": "Zillow"}},
])
def test_every_path_selection_rejects_loaded_portal(sending, path, evidence):
    engine, calls, current = sending
    if path == "welcome":
        current["emails"] = [{"value": "portal-fixture-990001@gmail.com"}]
    assert invoke(engine, path, evidence) == "suppressed"
    assert calls["send"] == 0 and calls["note"] == 0
    assert calls["history"] == 0


def test_gate_never_caches_and_does_not_hide_refusal(sending):
    engine, calls, current = sending
    assert engine._send_contact_email(PID, {"id": PID, "source": "Website Form"}, "synthetic", "synthetic", "synthetic").allowed
    current["source"] = "Zillow"
    decision = engine._send_contact_email(PID, {"id": PID, "source": "Website Form"}, "synthetic", "synthetic", "synthetic")
    assert not decision.allowed and calls["send"] == 1 and calls["fresh"] == 2


def test_original_portal_wins_over_current_nonportal(sending):
    engine, calls, current = sending
    decision = engine._send_contact_email(PID, {"id": PID, "source": "Zillow"}, "synthetic", "synthetic", "synthetic")
    assert decision.reason == portal.PORTAL_EXCLUDED
    assert calls["send"] == 0 and calls["fresh"] == 1


def test_recruiting_claim_released_for_original_enrollment_portal(sending):
    engine, calls, current = sending
    record = {"id": PID, "source": "New Agent Inquiry", "tags": [],
              "emails": [{"value": "portal-fixture-990001@gmail.com"}]}
    assert engine._send_recruiting_email(record, {"source": "Zillow"}, dt.datetime.now(dt.timezone.utc)) == "suppressed"
    assert calls["send"] == 0
    assert engine.db.claim_recruiting_send(PID, 1)


@pytest.mark.parametrize("case", ["missing", "malformed", "empty"])
def test_json_fallback_portal_values_match(rules, m, tmp_path, case):
    (tmp_path / "rules.yaml").write_text("{}\n")
    if case == "malformed":
        (tmp_path / "suppression_tags.json").write_text("{invalid")
    if case == "empty":
        (tmp_path / "suppression_tags.json").write_text('{"tags": [], "excluded_sources": []}')
    fallback = m.Rules.load(str(tmp_path / "rules.yaml"))
    assert sorted(fallback.excluded_sources) == sorted(rules.excluded_sources)
    config = json.loads((ROOT / "config/suppression_tags.json").read_text())
    assert {value.lower() for value in config["excluded_sources"]} == set(fallback.excluded_sources)


@pytest.mark.parametrize("field", ["source", "leadSource", "sourceUrl", "tags", "originalSource", "eventSource"])
def test_each_selection_matcher_sees_all_portal_surfaces(engine, field):
    values = {"source": "Zillow", "leadSource": "Realtor.com", "sourceUrl": "https://zillow.com/",
              "tags": ["Zillow source"], "originalSource": "Zillow", "eventSource": "Realtor.com"}
    record = {"id": PID, "source": "Website Form", "tags": []}
    record[field] = values[field]
    assert engine.is_excluded(record)
    assert engine._is_excluded_source(record) == portal.PORTAL_EXCLUDED
    assert engine._never_a_lead_email(record) == portal.PORTAL_EXCLUDED
    assert engine.recruiting_suppressed(record) == portal.PORTAL_EXCLUDED


def test_inventory_all_contact_sends_and_internal_transports(m):
    tree = ast.parse((ROOT / "src/fub_automation/main.py").read_text())
    contact = []
    direct = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            calls = [ast.unparse(n.func) for n in ast.walk(node) if isinstance(n, ast.Call)]
            if "self._send_contact_email" in calls:
                contact.append(node.name)
            if "self.email.send" in calls:
                direct.append(node.name)
    assert len(contact) == 7
    assert set(direct) == {"_send_contact_email", "send_agent_reminder_digest", "send_phase2_daily_summary",
                           "_send_bulk_assignment_digest", "_send_speed_to_lead_agent_alert",
                           "reassign_to_peter", "_handle_human_reply"}
    source = inspect.getsource(m.create_app)
    assert "(person, payload.data)" in source


@pytest.mark.parametrize("tag", portal.PORTAL_TAGS)
def test_portal_email_exclusion_does_not_disable_reply_opt_out_scan(engine, tag):
    record = {"id": PID, "source": "Zillow", "stage": "Lead", "tags": [tag]}
    assert engine.is_excluded(record)
    assert not engine._reply_scan_skips(record)
    assert not engine.is_excluded(record, portal_exclusion=False)
    record["source"] = "New Agent Inquiry"
    assert engine.recruiting_suppressed(record) == portal.PORTAL_EXCLUDED
    assert engine.recruiting_suppressed(record, portal_exclusion=False) is None
    record["tags"].append("unsubscribe")
    assert engine._reply_scan_skips(record)


def test_portal_tag_json_and_missing_fallback_match(rules, m, tmp_path):
    (tmp_path / "rules.yaml").write_text("{}\n")
    fallback = m.Rules.load(str(tmp_path / "rules.yaml"))
    config = json.loads((ROOT / "config/suppression_tags.json").read_text())
    assert set(portal.PORTAL_TAGS) <= set(config["tags"])
    assert set(portal.PORTAL_TAGS) <= set(fallback.excluded_tags)
    assert set(portal.PORTAL_TAGS) <= set(rules.excluded_tags)


@pytest.mark.parametrize("path", ["seller", "recruiting"])
def test_unreadable_refusal_does_not_consume_retry(sending, path):
    engine, calls, current = sending
    current["value"] = RuntimeError("synthetic unavailable")
    assert invoke(engine, path) == "deferred"
    current["value"] = {"id": PID, "source": "Website Form", "tags": []}
    assert invoke(engine, path) == "dry_run_sent"
    assert calls["send"] == 1


def test_refusal_audit_contains_reason_code_only(sending):
    engine, calls, current = sending
    current["value"] = RuntimeError("synthetic unavailable")
    decision = engine._send_contact_email(PID, {"id": PID, "source": "Website"}, "synthetic", "synthetic", "synthetic")
    assert not decision.allowed
    with engine.db.connect() as con:
        rows = con.execute("SELECT details FROM audit_log WHERE action='portal_email_gate'").fetchall()
    assert [json.loads(row[0]) for row in rows] == [{"reason": portal.PORTAL_FRESH_UNAVAILABLE}]
    assert calls["send"] == 0 and calls["note"] == 0


def test_any_portal_evidence_wins_even_on_malformed_fresh_response():
    current = {"id": PID, "source": {}, "leadSource": "Zillow"}
    decision = portal.portal_email_gate(PID, lambda pid: current)
    assert decision.reason == portal.PORTAL_EXCLUDED


@pytest.mark.parametrize("value,expected", [("ftp://zillow.com/", True), ("//zillow.com/", True),
                                             ("zillow.com/lead", True), ("javascript://realtor.com/", True),
                                             ("https://example.invalid/?zillow.com", False)])
def test_conservative_portal_authority_never_matches_query_only(value, expected):
    assert portal.portal_url(value) is expected


@pytest.mark.parametrize("returned_id", [None, True, False, [], [PID], {}, PID + 0.5,
                                          float(PID), "0990001", "+990001", "990001.0",
                                          "990001 ", "９９０００１", 9007199254740992])
def test_returned_identity_never_coerced(returned_id):
    decision = portal.portal_email_gate(PID, lambda _: {"id": returned_id, "source": ""})
    assert decision.reason == portal.PORTAL_FRESH_UNAVAILABLE
    assert not decision.allowed


@pytest.mark.parametrize("requested_id", [PID, str(PID)])
@pytest.mark.parametrize("returned_id", [PID, str(PID)])
def test_canonical_positive_integral_identities_proceed(requested_id, returned_id):
    calls = []
    def loader(pid):
        calls.append(pid)
        return {"id": returned_id, "source": None}
    assert portal.portal_email_gate(requested_id, loader, event_page_loader=complete_history).allowed
    assert calls == [PID]


def test_allowlisted_provenance_cycles_and_sibling_evidence():
    record = {"source": "Website Form"}
    record["original"] = record
    record["events"] = [record]
    assert not portal.has_portal_provenance(record)
    record["eventProvenance"] = {"source": "Realtor.com"}
    assert portal.has_portal_provenance(record)
    snapshots = []
    snapshots.append(snapshots)
    assert not portal.has_portal_provenance(snapshots)
    snapshots.append({"source": "Zillow"})
    assert portal.has_portal_provenance(snapshots)


@pytest.mark.parametrize("field", ["original", "event", "originalProvenance", "eventProvenance"])
def test_object_provenance_requires_an_object(field):
    assert not portal.has_portal_provenance({field: "Zillow"})
    assert not portal.has_portal_provenance({field: [{"source": "Zillow"}]})


@pytest.mark.parametrize("field", ["events", "provenance"])
def test_loaded_record_arrays_require_an_array(field):
    assert not portal.has_portal_provenance({field: "Zillow"})
    assert not portal.has_portal_provenance({field: {"source": "Zillow"}})
    assert not portal.has_portal_provenance({field: [[{"source": "Zillow"}]]})
    assert not portal.has_portal_provenance({field: [{"body": "Zillow", "data": {"source": "Zillow"}}]})
    assert portal.has_portal_provenance({field: [{"eventProvenance": {"sourceUrl": "https://realtor.com./"}}]})


def test_explicit_event_metadata_not_arbitrary_payload():
    event = {"source": "Zillow", "body": "synthetic"}
    assert not portal.has_portal_provenance({"data": event})
    assert portal.has_portal_provenance(({"source": "Website Form"}, event))


@pytest.mark.parametrize("current", [
    {"id": True, "source": "Zillow"}, {"id": PID + 0.5, "source": {}, "tags": ["Zillow"]},
    {"id": PID, "tags": ["Realtor.com"]}, {"id": PID, "sourceUrl": "https://zillow.com./"},
])
def test_known_portal_evidence_precedes_malformed_fresh_validation(current):
    assert portal.portal_email_gate(PID, lambda _: current).reason == portal.PORTAL_EXCLUDED


def test_fresh_gate_is_immediately_before_identity_free_transport(sending, monkeypatch):
    engine, calls, current = sending
    trace = []
    monkeypatch.setattr(engine.fub, "get_person", lambda _: trace.append("fresh") or dict(current))
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page",
                        lambda pid, **kw: trace.append("history") or complete_history(pid, **kw))
    monkeypatch.setattr(engine.email, "send", lambda *a, **k: trace.append("transport"))
    assert engine._send_contact_email(PID, {"id": PID, "source": "Website"}, "synthetic", "synthetic", "synthetic").allowed
    assert trace == ["fresh", "history", "transport"]
    current["source"] = "Zillow"
    assert not engine._send_contact_email(PID, {"id": PID, "source": "Website"}, "synthetic", "synthetic", "synthetic").allowed
    assert trace == ["fresh", "history", "transport", "fresh"]


@pytest.mark.parametrize("evidence", [{"source": "Zillow", "tags": ["zillow"]},
                                      {"source": "Realtor.com", "tags": ["realtor dot com"]},
                                      {"source": "Website Form"}])
@pytest.mark.parametrize("fresh", [{"id": PID, "source": "Zillow"}, {"id": PID, "tags": []}])
def test_portal_email_refusal_does_not_disable_existing_sms_lane(sending, monkeypatch, evidence, fresh):
    engine, calls, current = sending
    engine.rules.pond_nurture_sms_enabled = True
    current["value"] = fresh
    texts = []
    monkeypatch.setattr(engine, "_check_mysql_sms_today", lambda _: False)
    monkeypatch.setattr(engine.fub, "log_text_message", lambda *a: texts.append(a))
    record = {"id": PID, "source": "Website Form", "stage": "Lead", "tags": [],
              "emails": [{"value": "synthetic@example.invalid"}], "phones": [{"value": "2025550100"}]}
    record.update(evidence)
    assert engine.process_reengagement_candidate(record) == "dry_run_sent"
    assert calls["send"] == 0 and len(texts) == 1
    with engine.db.connect() as con:
        details = json.loads(con.execute("SELECT details FROM audit_log WHERE action='pond_nurture' AND status='dry_run_sent'").fetchone()[0])
    assert details["channels"] == ["sms"]
