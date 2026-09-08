"""The opt-out ledger (opt_outs) and the pre-send check it feeds.

An opt-out used to live only as FUB tags and an audit row. Tags get cleared
by hand ("remove the tag to resume automation" is the documented path) and
records get deleted; the ledger is the bot's own memory of who asked it to
stop, stamped with the moment THEY wrote. Everything that sends consults it.
"""
from __future__ import annotations

import datetime as dt
import json

import pytest

UTC = dt.timezone.utc


@pytest.fixture()
def quiet(engine, monkeypatch):
    monkeypatch.setattr(engine.fub, "update_person", lambda *a, **k: {"stubbed": True})
    monkeypatch.setattr(engine.fub, "add_note", lambda *a, **k: {"stubbed": True})
    return engine


def test_the_ledger_keeps_the_earliest_moment_and_the_first_record(tmp_db):
    tmp_db.record_opt_out(1931, "2026-09-08T17:20:00+00:00", "email", "reply_detection_keyword", "Unsubscribe")
    tmp_db.record_opt_out(1931, "2026-09-09T09:00:00+00:00", "email", "pre_send_keyword", "unsubscribe again")
    assert tmp_db.opted_out_at(1931) == "2026-09-08T17:20:00+00:00"
    tmp_db.record_opt_out(1931, "2026-09-08T16:59:00+00:00", "text", "ai_intent", "stop")
    assert tmp_db.opted_out_at(1931) == "2026-09-08T16:59:00+00:00"
    assert tmp_db.opted_out_ids() == {1931}
    assert tmp_db.opted_out_at(1) is None


def test_is_excluded_honours_the_ledger_even_when_fub_tags_are_clean(quiet, tmp_db):
    clean = {"id": 42, "stage": "Lead", "tags": [], "emails": [{"value": "ka@example.com"}]}
    assert quiet.is_excluded(clean) is False
    tmp_db.record_opt_out(42, "2026-09-08T17:20:00+00:00", "email", "reply_detection_keyword", "Unsubscribe")
    quiet._opted_out_cache = None  # a fresh engine, as every workflow run is
    assert quiet.is_excluded(clean) is True
    assert quiet.is_excluded({"id": 43, "stage": "Lead", "tags": []}) is False
    assert quiet.is_excluded({"stage": "Lead", "tags": []}) is False, "no id, no verdict"


def test_the_pond_send_path_is_closed_by_the_ledger(quiet, tmp_db):
    """process_reengagement_candidate's first, cheapest gate."""
    tmp_db.record_opt_out(42, "2026-09-08T17:20:00+00:00", "email", "reply_detection_keyword", "Unsubscribe")
    quiet._opted_out_cache = None
    person = {"id": 42, "stage": "Lead", "tags": [], "assignedPondId": 2,
              "emails": [{"value": "ka@example.com"}]}
    assert quiet.process_reengagement_candidate(person) == "suppressed"
    rows = tmp_db.recent_audit_rows(["pond_nurture"], dt.datetime.now(UTC) - dt.timedelta(days=1))
    assert rows and rows[0]["status"] == "suppressed"


def test_the_pre_send_check_sees_a_sent_by_person_reply(quiet, tmp_db, fake_http):
    """It tested isIncoming, which this account never sends on emails, so it
    was blind to every inbound EMAIL. sentByPerson is the real field."""
    written = dt.datetime.now(UTC) - dt.timedelta(hours=20)
    fake_http.responses = [
        (200, {"emails": [{
            "id": 7, "created": written.isoformat(), "status": "Received",
            "subject": "Re: Your next home in Austin", "body": "Unsubscribe",
            "relatedPeople": [{"personId": 42, "sentByPerson": True, "threadId": 1}],
        }]}),
        (200, {"textMessages": []}),
    ]
    person = {"id": 42, "firstName": "Ka", "lastName": "Cp", "stage": "Lead", "tags": [],
              "emails": [{"value": "ka@example.com"}]}

    assert quiet._check_incoming_opt_out(42, person) == "opt_out_trashed"

    rows = tmp_db.recent_audit_rows(["pond_nurture"], dt.datetime.now(UTC) - dt.timedelta(days=1))
    assert rows[0]["status"] == "opt_out_trashed"
    details = json.loads(rows[0]["details"])
    assert details["trigger_source"] == "Inbound Email"
    assert details["opted_out_at"] == written.isoformat()
    assert tmp_db.opted_out_at(42) == written.isoformat()


def test_the_pre_send_check_still_honours_the_legacy_isincoming_shape(quiet, tmp_db, fake_http):
    fake_http.responses = [
        (200, {"emails": [{"id": 7, "isIncoming": True, "subject": "Re: hi", "body": "please remove me",
                           "created": dt.datetime.now(UTC).isoformat()}]}),
        (200, {"textMessages": []}),
    ]
    assert quiet._check_incoming_opt_out(42, {"id": 42, "emails": [{"value": "a@b.c"}]}) == "opt_out_trashed"


def test_the_pre_send_check_ignores_hidden_content_it_cannot_read(quiet, tmp_db, fake_http):
    """A placeholder is not the lead's words in either direction: it must
    not trash, and it must not be mistaken for a clean bill either."""
    now = dt.datetime.now(UTC)
    hidden = {"id": 8, "created": now.isoformat(), "status": "Received",
              "subject": "[CONTENT HIDDEN]", "bodyExcerpt": "[CONTENT HIDDEN]",
              "relatedPeople": [{"personId": 42, "sentByPerson": True}]}
    fake_http.responses = [(200, {"emails": [hidden]}), (200, {"textMessages": []})]
    assert quiet._check_incoming_opt_out(42, {"id": 42, "emails": [{"value": "a@b.c"}]}) is None
    assert tmp_db.opted_out_at(42) is None


def test_the_pre_send_check_short_circuits_on_the_ledger(quiet, tmp_db, fake_http):
    tmp_db.record_opt_out(42, "2026-09-08T17:20:00+00:00", "email", "reply_detection_keyword", "Unsubscribe")
    quiet._opted_out_cache = None
    assert quiet._check_incoming_opt_out(42, {"id": 42}) == "suppressed"
    assert fake_http.calls == [], "no FUB call is needed to honour our own record"


def test_a_standalone_stop_text_still_trashes_and_a_stop_by_does_not(quiet, tmp_db, fake_http):
    now = dt.datetime.now(UTC).isoformat()
    fake_http.responses = [
        (200, {"emails": []}),
        (200, {"textMessages": [{"id": 1, "isIncoming": True, "message": "Stop by Tuesday?", "created": now}]}),
    ]
    assert quiet._check_incoming_opt_out(42, {"id": 42}) is None
    fake_http.responses = [
        (200, {"emails": []}),
        (200, {"textMessages": [{"id": 2, "isIncoming": True, "message": "STOP", "created": now}]}),
    ]
    assert quiet._check_incoming_opt_out(43, {"id": 43}) == "opt_out_trashed"
    assert tmp_db.opted_out_at(43) == now
