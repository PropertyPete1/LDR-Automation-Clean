"""sweep_reply_false_positives.py — re-judging alerts with the lineage gate.

The repair for the 2026-08-28 Angie Gonzalez incident: a lender's email on
her record ('Re: Lender Intro Irene and Angie', thread 49329) passed the
sentByPerson inbound test, paged Peter and tagged her "Replied - Paused".
These tests drive the sweep over her measured payload and the genuine-reply
shape, and pin what --commit may and may not touch.

No network: engine.fub methods are monkeypatched per test.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
from pathlib import Path

import pytest

UTC = dt.timezone.utc

_spec = importlib.util.spec_from_file_location(
    "sweep_reply_false_positives",
    Path(__file__).resolve().parents[1] / "sweep_reply_false_positives.py",
)
srfp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(srfp)  # type: ignore[union-attr]

NOW = dt.datetime.now(UTC)


def _thread_email(created, *, email_id, sent_by_person, person_id=6340,
                  thread_id=49329):
    """One email of Angie's lender thread, shaped as run 33218198212 dumped
    it: content hidden, single relatedPeople entry carrying the attribution."""
    return {
        "id": email_id,
        "created": created.isoformat(),
        "status": "Received",
        "subject": "[CONTENT HIDDEN]",
        "relatedPeople": [{"personId": person_id, "sentByPerson": sent_by_person,
                           "threadId": thread_id}],
        "threadId": str(thread_id),
        "unsubscribed": False,
    }


FALSE_REPLY_AT = NOW - dt.timedelta(hours=8)

LENDER_THREAD = [
    _thread_email(NOW - dt.timedelta(hours=7), email_id=52890, sent_by_person=False),
    _thread_email(FALSE_REPLY_AT, email_id=52889, sent_by_person=True),
    _thread_email(NOW - dt.timedelta(hours=25), email_id=52644, sent_by_person=False),
    _thread_email(NOW - dt.timedelta(hours=25, minutes=30), email_id=52642,
                  sent_by_person=False),
]


def _seed_alert(db, person_id, reply_at, *, name="Angie Gonzalez"):
    db.log("reply_detected", "alert_sent", person_id, {
        "reply_at": reply_at.isoformat(),
        "reply_channel": "email",
        "reply_snippet": "(email content hidden by FUB settings)",
        "contact_name": name,
    })


def _seed_send(db, person_id, when):
    db.log("instant_welcome_email", "sent", person_id, {"subject": "Welcome!"})
    with db.connect() as con:
        con.execute(
            "UPDATE audit_log SET created_at=? "
            "WHERE person_id=? AND action='instant_welcome_email'",
            (when.isoformat(), person_id),
        )


@pytest.fixture()
def wired(engine, tmp_db, monkeypatch):
    """Engine with recorded FUB writes and a place to hang canned reads."""
    calls = {"update_person": [], "add_note": [], "emails": [], "texts": [],
             "person": {"id": 6340, "firstName": "Angie", "lastName": "Gonzalez",
                        "tags": [{"name": "Replied - Paused"}, {"name": "Buyer"}]}}
    monkeypatch.setattr(
        engine.fub, "update_person",
        lambda pid, payload, **kw: calls["update_person"].append((pid, payload, kw)) or {})
    monkeypatch.setattr(
        engine.fub, "add_note",
        lambda pid, subject, body: calls["add_note"].append((pid, subject)) or {})
    monkeypatch.setattr(engine.fub, "get_emails", lambda pid, limit=25: calls["emails"])
    monkeypatch.setattr(engine.fub, "get_text_messages", lambda pid, limit=25: calls["texts"])
    monkeypatch.setattr(engine.fub, "get_person", lambda pid: calls["person"])
    engine._calls = calls
    return engine


def test_the_angie_shape_is_judged_false_positive_and_cleared(wired, tmp_db):
    """THE repair pin: her alert fails the lineage gate, the pause tag (and
    only the pause tag) is removed, and the void row names the reply_at."""
    _seed_send(tmp_db, 6340, NOW - dt.timedelta(hours=26))  # never synced back
    _seed_alert(tmp_db, 6340, FALSE_REPLY_AT)
    wired._calls["emails"] = list(LENDER_THREAD)

    results = srfp.run_sweep(wired, tmp_db, days=7, commit=True)

    assert [r["verdict"] for r in results] == ["false_positive"]
    assert wired._calls["update_person"] == [
        (6340, {"tags": ["Buyer"]}, {"merge_tags": False})
    ], "only the pause tag is removed; every other tag written back verbatim"
    assert [s for _, s in wired._calls["add_note"]] == \
        ["Automation: false-positive reply alert cleared"]
    rows = tmp_db.recent_audit_rows(
        ["reply_false_positive_cleared"], NOW - dt.timedelta(days=1))
    assert len(rows) == 1 and rows[0]["status"] == "completed"
    details = json.loads(rows[0]["details"])
    assert details["reply_at"] == FALSE_REPLY_AT.isoformat()
    assert details["thread_id"] == "49329"
    assert details["removed_tag"] == "Replied - Paused"


def test_dry_run_judges_but_writes_nothing(wired, tmp_db):
    _seed_send(tmp_db, 6340, NOW - dt.timedelta(hours=26))
    _seed_alert(tmp_db, 6340, FALSE_REPLY_AT)
    wired._calls["emails"] = list(LENDER_THREAD)

    results = srfp.run_sweep(wired, tmp_db, days=7, commit=False)

    assert [r["verdict"] for r in results] == ["false_positive"]
    assert wired._calls["update_person"] == []
    assert wired._calls["add_note"] == []
    assert tmp_db.recent_audit_rows(
        ["reply_false_positive_cleared"], NOW - dt.timedelta(days=1)) == []


def test_an_alert_with_thread_lineage_stands(wired, tmp_db):
    """The genuine shape: reply and our synced send share a thread, and the
    audit row sits within sync latency of the synced copy. Nothing touched."""
    sent_at = NOW - dt.timedelta(hours=2)
    reply_at = sent_at + dt.timedelta(minutes=49)
    _seed_send(tmp_db, 42, sent_at)
    _seed_alert(tmp_db, 42, reply_at, name="Stephen Herrera")
    wired._calls["emails"] = [
        _thread_email(sent_at + dt.timedelta(seconds=2), email_id=51937,
                      sent_by_person=False, person_id=42, thread_id=48666),
        _thread_email(reply_at, email_id=52004, sent_by_person=True,
                      person_id=42, thread_id=48666),
    ]

    results = srfp.run_sweep(wired, tmp_db, days=7, commit=True)

    assert [r["verdict"] for r in results] == ["stands"]
    assert wired._calls["update_person"] == []
    assert tmp_db.recent_audit_rows(
        ["reply_false_positive_cleared"], NOW - dt.timedelta(days=1)) == []


def test_a_text_alert_stands_without_thread_lineage(wired, tmp_db):
    """Texts have no threads; the gate does not apply and the alert stands."""
    reply_at = NOW - dt.timedelta(hours=3)
    _seed_alert(tmp_db, 42, reply_at, name="Test Lead")
    wired._calls["texts"] = [{"id": 7, "isIncoming": True,
                              "message": "yes, call me",
                              "created": reply_at.isoformat()}]

    results = srfp.run_sweep(wired, tmp_db, days=7, commit=True)

    assert [r["verdict"] for r in results] == ["stands"]
    assert wired._calls["update_person"] == []


def test_another_verified_inbound_blocks_the_clearing(wired, tmp_db):
    """The alerted message is third-party mail, but the lead ALSO genuinely
    replied on our thread — the pause is justified and must survive."""
    sent_at = NOW - dt.timedelta(hours=26)
    _seed_send(tmp_db, 6340, sent_at)
    _seed_alert(tmp_db, 6340, FALSE_REPLY_AT)
    wired._calls["emails"] = [
        *LENDER_THREAD,
        _thread_email(sent_at + dt.timedelta(seconds=3), email_id=60001,
                      sent_by_person=False, thread_id=50000),
        _thread_email(NOW - dt.timedelta(hours=1), email_id=60002,
                      sent_by_person=True, thread_id=50000),
    ]

    results = srfp.run_sweep(wired, tmp_db, days=7, commit=True)

    assert [r["verdict"] for r in results] == ["stands"]
    assert wired._calls["update_person"] == []


def test_a_false_positive_without_the_tag_still_gets_the_void_row(wired, tmp_db):
    """Peter already pulled the tag by hand: nothing to remove, but the void
    row must still land so NEEDS A REPLY and the scans stop trusting the
    phantom alert."""
    _seed_send(tmp_db, 6340, NOW - dt.timedelta(hours=26))
    _seed_alert(tmp_db, 6340, FALSE_REPLY_AT)
    wired._calls["emails"] = list(LENDER_THREAD)
    wired._calls["person"] = {"id": 6340, "firstName": "Angie",
                              "lastName": "Gonzalez", "tags": [{"name": "Buyer"}]}

    srfp.run_sweep(wired, tmp_db, days=7, commit=True)

    assert wired._calls["update_person"] == []
    assert wired._calls["add_note"] == [], "no tag removed — nothing to explain"
    rows = tmp_db.recent_audit_rows(
        ["reply_false_positive_cleared"], NOW - dt.timedelta(days=1))
    assert len(rows) == 1 and rows[0]["status"] == "tag_absent"


def test_an_already_voided_alert_is_skipped(wired, tmp_db):
    """Idempotent: re-running the sweep must not clear (or note) twice."""
    _seed_send(tmp_db, 6340, NOW - dt.timedelta(hours=26))
    _seed_alert(tmp_db, 6340, FALSE_REPLY_AT)
    tmp_db.log("reply_false_positive_cleared", "completed", 6340,
               {"reply_at": FALSE_REPLY_AT.isoformat()})
    wired._calls["emails"] = list(LENDER_THREAD)

    results = srfp.run_sweep(wired, tmp_db, days=7, commit=True)

    assert results == []
    assert wired._calls["update_person"] == []
    rows = tmp_db.recent_audit_rows(
        ["reply_false_positive_cleared"], NOW - dt.timedelta(days=1))
    assert len(rows) == 1, "no second void row"


def test_opt_out_trashings_are_never_auto_reversed(wired, tmp_db):
    """An opt-out row in the window is re-judged for the printout only —
    nothing is written for it however the verdict lands."""
    tmp_db.log("reply_intent_disqualification", "opt_out_trashed", 77,
               {"reply_at": (NOW - dt.timedelta(hours=5)).isoformat()})
    wired._calls["emails"] = []

    results = srfp.run_sweep(wired, tmp_db, days=7, commit=True)

    assert results == []
    assert wired._calls["update_person"] == []
    assert wired._calls["add_note"] == []
