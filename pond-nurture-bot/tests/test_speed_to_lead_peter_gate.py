"""Peter's rule, end to end through both triggers (2026-09-27).

A speed-to-lead timer arms ONLY when Peter assigned the lead to an agent:
he added it and assigned it (poll_new_leads), or he reassigned it
(scan_assignment_changes). An agent adding their own contact, a routing by
anyone else, or an assigner FUB's fields cannot name never arms — and an
unknown assigner leaves an audit row the daily summary counts.

Payload shapes are the ones the read-only probe measured: the poll's list
page carries no createdById/updatedById (only the full record does), an
import stamps `updated` in the same second as `created`, and the UI's
add-and-assign lands 4 seconds later. Mocked HTTP only.
"""
from __future__ import annotations

import datetime as dt
import json

import pytest

UTC = dt.timezone.utc
PETER, STEVEN, LAILA = 2, 1, 35


def _now() -> dt.datetime:
    return dt.datetime.now(UTC)


def _lead(pid, agent, *, created, updated, via, created_by, updated_by, **extra):
    full = {
        "id": pid, "firstName": "Test", "lastName": f"Lead{pid}", "stage": "Lead",
        "tags": [], "phones": [], "emails": [], "assignedUserId": agent,
        "assignedPondId": None, "created": created.isoformat(),
        "updated": updated.isoformat(), "createdVia": via,
        "createdById": created_by, "updatedById": updated_by,
    }
    full.update(extra)
    return full


def _list_stub(full):
    """What GET /people returns without fields=allFields: no actor ids."""
    return {k: v for k, v in full.items() if k not in ("createdById", "updatedById")}


@pytest.fixture()
def gate_engine(engine, monkeypatch):
    sent = []
    monkeypatch.setattr(engine.email, "send", lambda *a, **k: sent.append((a, k)) or None)
    monkeypatch.setattr(engine, "user_cache_by_id", lambda: {
        LAILA: {"name": "Laila Maria", "email": "laila@example.com"},
        STEVEN: {"name": "Steven Van Orden", "email": "steven@example.com"},
    })
    engine.sent = sent
    return engine


def _timers(db):
    return [int(t["person_id"]) for t in db.active_new_lead_timers()]


def _rows(db, action):
    return db.recent_audit_rows([action], _now() - dt.timedelta(days=1))


# ── new leads (poll_new_leads) ───────────────────────────────────────────────

def test_peter_adding_and_assigning_a_lead_arms(gate_engine, tmp_db, fake_http):
    created = _now() - dt.timedelta(minutes=10)
    full = _lead(9661, STEVEN, created=created, updated=created + dt.timedelta(seconds=4),
                 via="Manually", created_by=PETER, updated_by=PETER)
    fake_http.responses = [
        (200, {"people": [_list_stub(full)]}),  # the createdAfter poll page
        (200, {"people": [full]}),              # the full record
        (200, {"notes": []}),                   # untouched
    ]

    gate_engine.poll_new_leads()

    assert _timers(tmp_db) == [9661]
    assert [r["status"] for r in _rows(tmp_db, "new_lead_timer")] == ["started_polling"]
    assert len(gate_engine.sent) == 1, "Steven gets the instant alert"


def test_an_agent_adding_their_own_contact_never_arms(gate_engine, tmp_db, fake_http):
    """Leads 9599-9659 (2026-09-27): Steven imported his own contacts."""
    created = _now() - dt.timedelta(minutes=10)
    full = _lead(9601, STEVEN, created=created, updated=created,
                 via="Import", created_by=STEVEN, updated_by=STEVEN)
    fake_http.responses = [
        (200, {"people": [_list_stub(full)]}),
        (200, {"people": [full]}),
    ]

    gate_engine.poll_new_leads()

    assert _timers(tmp_db) == []
    assert gate_engine.sent == [], "no 'contact within 30 min' page"
    rows = _rows(tmp_db, "new_lead_timer")
    assert [r["status"] for r in rows] == ["skipped_not_peter"]
    details = json.loads(rows[0]["details"])
    assert details["reason"] == "assigned_by_non_peter"
    assert details["why"] == "added_by_agent_themselves" and details["assigner_id"] == STEVEN
    assert details["evidence"]["createdVia"] == "Import"


def test_a_gate_skip_is_remembered_across_polls(gate_engine, tmp_db, fake_http):
    """~96 polls a day see the same lead: one row, and no re-fetch."""
    created = _now() - dt.timedelta(minutes=10)
    full = _lead(9601, STEVEN, created=created, updated=created,
                 via="Import", created_by=STEVEN, updated_by=STEVEN)
    fake_http.responses = [
        (200, {"people": [_list_stub(full)]}),
        (200, {"people": [full]}),
        (200, {"people": [_list_stub(full)]}),  # the next poll's page
    ]

    gate_engine.poll_new_leads()
    calls_after_first = len(fake_http.calls)
    gate_engine.poll_new_leads()

    assert len(fake_http.calls) == calls_after_first + 1
    assert len(_rows(tmp_db, "new_lead_timer")) == 1


def test_an_unreadable_lead_is_unknown_audited_and_asked_again(gate_engine, tmp_db, fake_http):
    """No full record = no assigner evidence: never arm, always audit, and
    ask again next tick rather than remembering a failed read."""
    created = _now() - dt.timedelta(minutes=10)
    full = _lead(9700, LAILA, created=created, updated=created,
                 via="Manually", created_by=PETER, updated_by=PETER)
    fake_http.responses = [
        (200, {"people": [_list_stub(full)]}),
        (500, {"errorMessage": "boom"}),
        (200, {"people": [_list_stub(full)]}),
        (500, {"errorMessage": "boom"}),
    ]

    gate_engine.poll_new_leads()
    gate_engine.poll_new_leads()

    assert _timers(tmp_db) == []
    rows = _rows(tmp_db, "new_lead_timer")
    assert [r["status"] for r in rows] == ["skipped_assigner_unknown"] * 2
    details = json.loads(rows[0]["details"])
    assert details["reason"] == "assigner_unknown" and details["why"] == "person_unreadable"


# ── reassignments (scan_assignment_changes) ──────────────────────────────────

def _moved(pid, to_agent, by):
    now = _now()
    return _lead(pid, to_agent, created=now - dt.timedelta(days=30),
                 updated=now - dt.timedelta(minutes=1), via="API",
                 created_by=PETER, updated_by=by)


def test_peter_reassigning_a_lead_to_an_agent_arms(gate_engine, tmp_db, fake_http):
    tmp_db.upsert_assignment_watch(42, STEVEN)
    lead = _moved(42, LAILA, by=PETER)
    fake_http.responses = [
        (200, {"people": [_list_stub(lead)]}),  # the -updated walk
        (200, {"people": [lead]}),              # the full record
        (200, {"notes": []}),
    ]

    gate_engine.scan_assignment_changes()

    assert _timers(tmp_db) == [42]
    assert [r["status"] for r in _rows(tmp_db, "new_lead_timer")] == ["started_assignment_change"]
    assert len(gate_engine.sent) == 1, "Laila gets the instant alert"


def test_a_non_peter_reassignment_never_arms(gate_engine, tmp_db, fake_http):
    """Steven (a Broker) routed the lead: FUB names him as the last editor."""
    tmp_db.upsert_assignment_watch(42, PETER)
    lead = _moved(42, LAILA, by=STEVEN)
    fake_http.responses = [
        (200, {"people": [_list_stub(lead)]}),
        (200, {"people": [lead]}),
    ]

    gate_engine.scan_assignment_changes()

    assert _timers(tmp_db) == []
    assert gate_engine.sent == []
    details = json.loads(_rows(tmp_db, "assignment_change")[0]["details"])
    assert details["reason"] == "assigner_unknown"
    assert details["why"] == "last_edit_by_non_peter" and details["assigner_id"] == STEVEN
    assert tmp_db.get_assignment_watch(42)["assigned_user_id"] == LAILA, \
        "the watch still learns the new pair"


def test_the_automations_own_write_on_peters_key_does_not_arm(gate_engine, tmp_db, fake_http):
    """The bot writes on Peter's key: its own tag at the last-edit moment
    stamps updatedById=2 and must not read as Peter routing the lead."""
    tmp_db.upsert_assignment_watch(42, STEVEN)
    tmp_db.log("reply_detected", "alert_sent", 42, {})
    lead = _moved(42, LAILA, by=PETER)
    fake_http.responses = [
        (200, {"people": [_list_stub(lead)]}),
        (200, {"people": [lead]}),
    ]

    gate_engine.scan_assignment_changes()

    assert _timers(tmp_db) == []
    details = json.loads(_rows(tmp_db, "assignment_change")[0]["details"])
    assert details["why"] == "last_edit_may_be_automation"


def test_an_unreadable_change_is_re_asked_on_the_next_walk(gate_engine, tmp_db, fake_http):
    tmp_db.upsert_assignment_watch(42, STEVEN, first_seen_at="2026-09-01T00:00:00+00:00")
    lead = _moved(42, LAILA, by=PETER)
    fake_http.responses = [
        (200, {"people": [_list_stub(lead)]}),
        (500, {"errorMessage": "boom"}),
    ]

    gate_engine.scan_assignment_changes()

    assert _timers(tmp_db) == []
    details = json.loads(_rows(tmp_db, "assignment_change")[0]["details"])
    assert details["reason"] == "assigner_unknown" and details["why"] == "person_unreadable"
    watch = tmp_db.get_assignment_watch(42)
    assert watch["assigned_user_id"] == STEVEN, "the old pair is back, so the change re-detects"
    assert watch["first_seen_at"] == "2026-09-01T00:00:00+00:00"


def test_the_cleanups_restore_is_never_re_armed(gate_engine, tmp_db, fake_http):
    """The gate cleanup puts a bounced lead back with its agent — an
    assignment change the scan must treat as the automation's own move."""
    tmp_db.upsert_assignment_watch(42, PETER)
    tmp_db.log("speed_to_lead_gate_cleanup", "restored", 42, {"agent_id": STEVEN})
    lead = _moved(42, STEVEN, by=PETER)
    fake_http.responses = [(200, {"people": [_list_stub(lead)]})]

    gate_engine.scan_assignment_changes()

    assert _timers(tmp_db) == []
    assert json.loads(_rows(tmp_db, "assignment_change")[0]["details"])["reason"] \
        == "automation_move"


# ── never silent: the daily summary counts the gate ──────────────────────────

def test_the_daily_summary_counts_unknown_assigners(gate_engine, tmp_db, fake_http, monkeypatch):
    tmp_db.log("assignment_change", "skipped", 42, {
        "reason": "assigner_unknown", "why": "last_edit_by_non_peter",
        "new_assigned_user_id": LAILA})
    tmp_db.log("new_lead_timer", "skipped_not_peter", 43, {
        "reason": "assigned_by_non_peter", "why": "added_by_agent_themselves"})
    tmp_db.log("new_lead_timer", "started_polling", 44, {})
    captured = {}

    def _capture(to_email, subject, body, **kwargs):
        captured["body"] = body
        captured["html"] = kwargs.get("html_body", "")

    monkeypatch.setattr(gate_engine.email, "send", _capture)
    fake_http.responses = [(200, {})]

    gate_engine.send_phase2_daily_summary()

    assert "1 armed · 1 not Peter's assignment · 1 assigner unknown" in captured["body"]
    assert "FUB ID 42 — last edited by someone other than Peter" in captured["body"]
    assert "assigner unknown" in captured["html"]
