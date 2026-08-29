"""repair_speed_to_lead_false_positives.py — re-judging under the corrected anchor.

The 2026-08-29 incident: Sunny Chamadia (6343) was called by her assigned
agent 24 minutes after creation, yet warned and auto-returned to Peter,
because her polling timer anchored the touch check at detection (~2h after
creation). These tests drive the re-judgment over her measured state rows and
pin what --commit may and may not touch.

No network: the FUB client is a recording stub.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
from pathlib import Path

import pytest

UTC = dt.timezone.utc

_spec = importlib.util.spec_from_file_location(
    "repair_speed_to_lead_false_positives",
    Path(__file__).resolve().parents[1] / "repair_speed_to_lead_false_positives.py",
)
repair = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(repair)  # type: ignore[union-attr]

SINCE = dt.datetime(2026, 8, 28, 0, 0, tzinfo=UTC)

# Sunny's rows, as run 33264861412 dumped them.
SUNNY_CREATED = "2026-08-28T20:22:24Z"
SUNNY_CALL_AT = "2026-08-28T20:46:33Z"
TIMER_1 = "2026-08-28T22:13:23.990541+00:00"
TIMER_2 = "2026-08-28T22:31:33.006596+00:00"
WARNED = "2026-08-29T15:09:40.662524+00:00"
REASSIGNED = "2026-08-29T17:00:01.162681+00:00"
AGENT = 20
PETER = 2


class _FubStub:
    """Recording stand-in for FollowUpBossClient — reads canned, writes logged."""

    def __init__(self, *, person=None, calls=(), texts=(), emails=(), notes=()):
        self.person = person
        self._calls = list(calls)
        self._texts = list(texts)
        self._emails = list(emails)
        self._notes = list(notes)
        self.writes = []

    def get_person(self, pid):
        return self.person

    def get_calls(self, pid, limit=100):
        return list(self._calls)

    def get_text_messages(self, pid, limit=100):
        return list(self._texts)

    def get_emails(self, pid, limit=100):
        return list(self._emails)

    def get_notes(self, pid, limit=100):
        return list(self._notes)

    def update_person(self, pid, payload, merge_tags=False):
        self.writes.append(("update_person", pid, payload))
        return {}

    def add_note(self, pid, subject, body):
        self.writes.append(("add_note", pid, subject, body))
        return {}


def _audit_row(db, created_at, person_id, action, status, details=None):
    with db.connect() as con:
        con.execute(
            "INSERT INTO audit_log(created_at, person_id, action, status, details) "
            "VALUES (?, ?, ?, ?, ?)",
            (created_at, person_id, action, status, json.dumps(details or {})))


def _sunny_state(db):
    """Both punished generations plus their arm audit rows."""
    for t in (TIMER_1, TIMER_2):
        db.add_new_lead_timer(6343, AGENT, created_at=t)
    with db.connect() as con:
        con.execute("UPDATE new_lead_timers SET warned_at=?, reassigned_at=? "
                    "WHERE person_id=6343", (WARNED, REASSIGNED))
    _audit_row(db, "2026-08-28T22:13:24.002517+00:00", 6343, "new_lead_timer",
               "started_polling", {"assignedUserId": AGENT, "fub_created_at": SUNNY_CREATED})
    _audit_row(db, "2026-08-28T22:31:33.007674+00:00", 6343, "new_lead_timer",
               "started_polling", {"assignedUserId": AGENT, "fub_created_at": SUNNY_CREATED})


SUNNY_CALL = {"id": 7304, "created": SUNNY_CALL_AT, "userId": AGENT,
              "isIncoming": False, "outcome": None}


def test_sunnys_call_between_creation_and_detection_is_a_false_positive(m, tmp_db):
    _sunny_state(tmp_db)
    fub = _FubStub(calls=[SUNNY_CALL])

    verdicts = repair.judge_incidents(tmp_db, fub, SINCE)

    assert len(verdicts) == 1
    v = verdicts[0]
    assert v["person_id"] == 6343 and v["false_positive"] is True
    assert v["punishment"] == "reassigned"
    assert v["anchor_how"] == "lead_creation"
    assert v["anchor"] == m.parse_fub_datetime(SUNNY_CREATED)
    assert v["touch"]["channel"] == "call"
    assert v["touch"]["at"] == m.parse_fub_datetime(SUNNY_CALL_AT)


def test_an_untouched_lead_stays_a_legitimate_punishment(tmp_db):
    _sunny_state(tmp_db)
    fub = _FubStub()  # no calls, no texts, no notes

    verdicts = repair.judge_incidents(tmp_db, fub, SINCE)

    assert verdicts[0]["false_positive"] is False


def test_another_agents_call_is_not_the_assigned_agents_touch(tmp_db):
    _sunny_state(tmp_db)
    other_call = dict(SUNNY_CALL, userId=35)
    fub = _FubStub(calls=[other_call])

    assert repair.judge_incidents(tmp_db, fub, SINCE)[0]["false_positive"] is False


def test_the_bots_own_synced_send_is_not_a_touch(tmp_db):
    _sunny_state(tmp_db)
    send_at = "2026-08-28T21:00:00+00:00"
    _audit_row(db=tmp_db, created_at="2026-08-28T21:00:40+00:00", person_id=6343,
               action="pond_nurture", status="sent")
    bot_mail = {"id": 51937, "created": send_at, "userId": AGENT,
                "relatedPeople": [{"personId": 6343, "sentByPerson": False}]}
    fub = _FubStub(emails=[bot_mail])

    assert repair.judge_incidents(tmp_db, fub, SINCE)[0]["false_positive"] is False


def test_an_automation_note_is_not_a_touch(tmp_db):
    _sunny_state(tmp_db)
    warn_note = {"id": 9, "created": "2026-08-29T15:09:40Z", "createdById": AGENT,
                 "subject": "Automation: speed-to-lead warning"}
    fub = _FubStub(notes=[warn_note])

    assert repair.judge_incidents(tmp_db, fub, SINCE)[0]["false_positive"] is False


def test_a_touch_after_the_punishment_resolved_does_not_rewrite_history(tmp_db):
    """The agent calling AFTER the reassignment is damage control, not the
    missed first touch — the bounce was still legitimate."""
    _sunny_state(tmp_db)
    late_call = dict(SUNNY_CALL, created="2026-08-29T18:00:00+00:00")
    fub = _FubStub(calls=[late_call])

    assert repair.judge_incidents(tmp_db, fub, SINCE)[0]["false_positive"] is False


def test_punishments_before_the_window_are_left_alone(tmp_db):
    _sunny_state(tmp_db)
    fub = _FubStub(calls=[SUNNY_CALL])

    verdicts = repair.judge_incidents(
        tmp_db, fub, dt.datetime(2026, 8, 30, tzinfo=UTC))

    assert verdicts == []


def test_an_assignment_change_timer_gets_the_scan_window_anchor(m, tmp_db):
    """No historical scan observations exist, so the corrected anchor is
    detection minus the 24h walk window."""
    db = tmp_db
    db.add_new_lead_timer(7001, 9, created_at="2026-08-28T15:00:00+00:00")
    with db.connect() as con:
        con.execute("UPDATE new_lead_timers SET warned_at=? WHERE person_id=7001",
                    ("2026-08-28T16:00:00+00:00",))
    _audit_row(db, "2026-08-28T15:00:01+00:00", 7001, "new_lead_timer",
               "started_assignment_change", {"assignedUserId": 9})
    fub = _FubStub()

    v = repair.judge_incidents(db, fub, SINCE)[0]

    assert v["anchor_how"] == "detection_minus_scan_window"
    assert v["anchor"] == m.parse_dt("2026-08-28T15:00:00+00:00") - dt.timedelta(hours=24)
    assert v["punishment"] == "warned"


# ── what --commit may and may not touch ──────────────────────────────────────

def _false_positive_verdict(tmp_db, fub):
    return repair.judge_incidents(tmp_db, fub, SINCE)[0]


def test_commit_restores_the_agent_strips_the_tag_and_suppresses(m, tmp_db):
    _sunny_state(tmp_db)
    fub = _FubStub(calls=[SUNNY_CALL],
                   person={"id": 6343, "assignedUserId": PETER,
                           "tags": ["buyer", repair.REPAIR_TAG]})
    v = _false_positive_verdict(tmp_db, fub)

    status = repair.apply_repair(tmp_db, fub, v, PETER, "Tiffany Proske")

    assert status == "reassignment_reverted"
    updates = [w for w in fub.writes if w[0] == "update_person"]
    assert ("update_person", 6343, {"assignedUserId": AGENT}) in updates
    assert ("update_person", 6343, {"tags": ["buyer"]}) in updates
    notes = [w for w in fub.writes if w[0] == "add_note"]
    assert len(notes) == 1 and notes[0][2] == "Automation: speed-to-lead repair", \
        "the note must carry the Automation: prefix so it can never count as a touch"
    assert "Tiffany Proske" in notes[0][3] and "call" in notes[0][3]
    watch = tmp_db.get_assignment_watch(6343)
    assert watch and watch["assigned_user_id"] == AGENT
    rows = tmp_db.recent_audit_rows(["speed_to_lead_repair"],
                                    dt.datetime.now(UTC) - dt.timedelta(days=1))
    assert [r["status"] for r in rows] == ["reassignment_reverted"]


def test_commit_never_overwrites_a_manual_reroute(tmp_db):
    """Peter already handed the lead to someone else by hand — the repair
    strips the tag and explains, but must not move the lead."""
    _sunny_state(tmp_db)
    fub = _FubStub(calls=[SUNNY_CALL],
                   person={"id": 6343, "assignedUserId": 44,
                           "tags": [repair.REPAIR_TAG]})
    v = _false_positive_verdict(tmp_db, fub)

    status = repair.apply_repair(tmp_db, fub, v, PETER, "Tiffany Proske")

    assert status == "restore_skipped_manual_route"
    assert ("update_person", 6343, {"assignedUserId": AGENT}) not in fub.writes
    assert ("update_person", 6343, {"tags": []}) in fub.writes, "the tag still comes off"
    assert tmp_db.get_assignment_watch(6343) is None, \
        "a lead we did not move keeps its watch state untouched"


def test_commit_on_a_warned_only_lead_cancels_the_pending_timer(tmp_db):
    db = tmp_db
    db.add_new_lead_timer(7002, AGENT, created_at="2026-08-29T15:00:00+00:00")
    with db.connect() as con:
        con.execute("UPDATE new_lead_timers SET warned_at=? WHERE person_id=7002",
                    ("2026-08-29T15:40:00+00:00",))
    _audit_row(db, "2026-08-29T15:00:01+00:00", 7002, "new_lead_timer",
               "started_polling", {"assignedUserId": AGENT,
                                   "fub_created_at": "2026-08-29T14:00:00Z"})
    call = {"id": 1, "created": "2026-08-29T14:30:00Z", "userId": AGENT}
    fub = _FubStub(calls=[call], person={"id": 7002, "assignedUserId": AGENT, "tags": []})
    v = _false_positive_verdict(db, fub)
    assert v["punishment"] == "warned" and v["false_positive"]

    status = repair.apply_repair(db, fub, v, PETER, "Tiffany Proske")

    assert status == "warning_cleared"
    assert db.active_new_lead_timers() == [], "the pending 60-minute line must not fire"
    assert not any(w[0] == "update_person" for w in fub.writes), \
        "a warned-only lead was never moved — nothing to restore"


def test_judging_alone_writes_nothing(tmp_db):
    """The dry run is the judgment — it must not touch FUB or the state DB."""
    _sunny_state(tmp_db)
    with tmp_db.connect() as con:
        rows_before = con.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
    fub = _FubStub(calls=[SUNNY_CALL])

    repair.judge_incidents(tmp_db, fub, SINCE)

    assert fub.writes == []
    with tmp_db.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0] == rows_before


def test_dict_shaped_fub_tags_still_get_the_tag_stripped(tmp_db):
    """FUB returns tags as strings OR {'name': ...} objects; the strip matches
    by name and writes the kept NAMES back — object tags must not survive the
    strip or be dropped from the kept list."""
    _sunny_state(tmp_db)
    fub = _FubStub(calls=[SUNNY_CALL],
                   person={"id": 6343, "assignedUserId": PETER,
                           "tags": [{"name": "buyer"}, {"name": repair.REPAIR_TAG}]})
    v = _false_positive_verdict(tmp_db, fub)

    repair.apply_repair(tmp_db, fub, v, PETER, "Tiffany Proske")

    assert ("update_person", 6343, {"tags": ["buyer"]}) in fub.writes


def test_a_manual_reroute_keeps_the_new_agents_timer_running(tmp_db):
    """Peter re-routed the bounced lead to agent 44, whose own timer is
    legitimately live — the repair for agent 20 must not silence it."""
    _sunny_state(tmp_db)
    tmp_db.add_new_lead_timer(6343, 44, created_at="2026-08-29T18:00:00+00:00")
    fub = _FubStub(calls=[SUNNY_CALL],
                   person={"id": 6343, "assignedUserId": 44, "tags": []})
    v = _false_positive_verdict(tmp_db, fub)

    status = repair.apply_repair(tmp_db, fub, v, PETER, "Tiffany Proske")

    assert status == "restore_skipped_manual_route"
    active = tmp_db.active_new_lead_timers()
    assert [t["assigned_user_id"] for t in active] == [44], \
        "agent 44's live speed-to-lead protection was killed by agent 20's repair"


def test_generations_for_different_agents_are_judged_separately(tmp_db):
    """A lead bounced from agent 20, redistributed to agent 44 and bounced
    again holds generations for both; each verdict judges its OWN agent, and
    only the LATEST routing may be restored."""
    _sunny_state(tmp_db)  # agent 20, punished 08-29 17:00
    tmp_db.add_new_lead_timer(6343, 44, created_at="2026-08-29T18:00:00+00:00")
    with tmp_db.connect() as con:
        con.execute("UPDATE new_lead_timers SET warned_at=?, reassigned_at=? "
                    "WHERE person_id=6343 AND assigned_user_id=44",
                    ("2026-08-29T19:00:00+00:00", "2026-08-29T20:00:00+00:00"))
    _audit_row(tmp_db, "2026-08-29T18:00:01+00:00", 6343, "new_lead_timer",
               "started_assignment_change", {"assignedUserId": 44})
    fub = _FubStub(calls=[SUNNY_CALL])  # only agent 20 ever touched

    verdicts = repair.judge_incidents(tmp_db, fub, SINCE)

    assert [(v["agent_id"], v["false_positive"]) for v in verdicts] == \
        [(20, True), (44, False)], \
        "agent 20's touch must not excuse agent 44's untouched generation"

    # And agent 20's restore is refused: agent 44 holds the later routing.
    fub2 = _FubStub(calls=[SUNNY_CALL],
                    person={"id": 6343, "assignedUserId": PETER, "tags": []})
    status = repair.apply_repair(tmp_db, fub2, verdicts[0], PETER, "Tiffany Proske",
                                 latest_routing=False)
    assert status == "restore_skipped_not_latest_routing"
    assert not any(w[0] == "update_person" and "assignedUserId" in w[2]
                   for w in fub2.writes)


def test_an_already_repaired_person_is_flagged_not_rejudged_fresh(tmp_db):
    """The commit run can be dispatched twice; the second pass must see the
    first pass's rows and leave the lead alone."""
    _sunny_state(tmp_db)
    _audit_row(tmp_db, "2026-08-29T18:30:00+00:00", 6343, repair.REPAIR_ACTION,
               "reassignment_reverted", {})
    fub = _FubStub(calls=[SUNNY_CALL])

    verdicts = repair.judge_incidents(tmp_db, fub, SINCE)

    assert verdicts[0]["already_repaired"] is True


def test_a_generation_armed_by_the_fixed_code_uses_its_stored_anchor(m, tmp_db):
    """Post-deploy re-runs: a timer that carries touch_anchor_at is judged
    against exactly that anchor, not the wider historical approximations."""
    stored = "2026-08-29T10:00:00+00:00"
    tmp_db.add_new_lead_timer(7003, AGENT, created_at="2026-08-29T12:00:00+00:00",
                              touch_anchor_at=stored)
    with tmp_db.connect() as con:
        con.execute("UPDATE new_lead_timers SET warned_at=? WHERE person_id=7003",
                    ("2026-08-29T13:00:00+00:00",))
    fub = _FubStub()

    v = repair.judge_incidents(tmp_db, fub, SINCE)[0]

    assert v["anchor_how"] == "stored_touch_anchor"
    assert v["anchor"] == m.parse_dt(stored)


def test_a_contact_note_saves_the_lead_and_names_its_text(tmp_db):
    """The 'VM and Text' shape: the repair's verdict must carry the note's
    actual text so a human can eyeball the judgment."""
    _sunny_state(tmp_db)
    note = {"id": 5, "created": SUNNY_CALL_AT, "createdById": AGENT,
            "subject": "", "body": "VM and Text"}
    fub = _FubStub(notes=[note])

    v = repair.judge_incidents(tmp_db, fub, SINCE)[0]

    assert v["false_positive"] is True
    assert v["touch"]["channel"] == "note"
    assert "VM and Text" in v["touch"]["detail"]


def test_a_bare_acknowledgment_note_does_not_save_the_lead(tmp_db):
    """'got it' proves the agent saw the alert, not that the lead heard from
    anyone — the punishment stands, and the rejected note is surfaced WITH
    its text for the human review."""
    _sunny_state(tmp_db)
    note = {"id": 5, "created": SUNNY_CALL_AT, "createdById": AGENT,
            "subject": "", "body": "got it"}
    fub = _FubStub(notes=[note])

    v = repair.judge_incidents(tmp_db, fub, SINCE)[0]

    assert v["false_positive"] is False
    assert [rn["text"] for rn in v["rejected_notes"]] == ["got it"]
