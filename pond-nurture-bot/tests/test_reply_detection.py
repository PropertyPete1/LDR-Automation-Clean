"""Reply detection — the inbound predicate and the duplicate-alert window.

Shipped 2026-07-12 testing `isReceived`, which FUB does not return on any
endpoint. Every message read as outgoing, so the scan reported "checking 1028
leads ... Alerts sent: 0" every ten minutes for a month without ever failing.
These tests pin the payload shape FUB actually sends, so the predicate cannot
silently stop matching again.

No network: conftest's FakeHttp stands in for requests.request.
"""
from __future__ import annotations

import datetime as dt
import json

import pytest


# ── the predicate itself ─────────────────────────────────────────────────────

def test_isincoming_is_what_fub_actually_sends(m):
    """The real contract. /v1/emails, /v1/textMessages and /v1/calls all carry
    `isIncoming`, and it is the field log_text_message POSTs back."""
    assert m.is_inbound_message({"isIncoming": True}) is True
    assert m.is_inbound_message({"isIncoming": False}) is False


def test_outgoing_bot_email_is_not_a_reply(m):
    """The shape the bot's own sends come back as — must never alert."""
    outgoing = {
        "id": 9001,
        "personId": 42,
        "isIncoming": False,
        "subject": "Following up on your home search",
        "body": "Hi there, just checking in.",
        "created": "2026-08-11T13:44:00Z",
    }
    assert m.is_inbound_message(outgoing) is False


def test_a_message_with_no_direction_field_is_not_inbound(m):
    """Absent means unknown, and unknown must not tag a lead 'Replied - Paused'
    and pause their automation."""
    assert m.is_inbound_message({}) is False
    assert m.is_inbound_message({"subject": "hi", "body": "there"}) is False


@pytest.mark.parametrize("payload", [
    {"isIncoming": True},
    {"isReceived": True},
    {"direction": "incoming"},
    {"direction": "inbound"},
    {"direction": "Inbound"},
    {"type": "received"},
])
def test_every_accepted_spelling_still_matches(m, payload):
    """The predicate is deliberately wide — the legacy keys stay accepted
    because a missed reply costs more than a redundant dict lookup."""
    assert m.is_inbound_message(payload) is True


@pytest.mark.parametrize("payload", [
    {"direction": "outgoing"},
    {"direction": "outbound"},
    {"type": "sent"},
    {"isIncoming": None},
    {"isIncoming": 0},
])
def test_outbound_spellings_never_match(m, payload):
    assert m.is_inbound_message(payload) is False


def test_scan_reply_detection_reads_the_predicate(m):
    """Guards the wiring, not the predicate: the scan must go through the
    shared helper rather than re-testing raw keys inline, which is how the two
    drifted apart in the first place."""
    import inspect
    src = inspect.getsource(m.RuleEngine.scan_reply_detection)
    assert "is_inbound_message" in src
    assert "isReceived" not in src, "inline key test reintroduced in the scan"


# ── end to end through the scan ──────────────────────────────────────────────

def _seed_send(db, person_id, when):
    """An audit row that makes the scan consider this lead."""
    db.log("pond_nurture", "sent", person_id, {})
    with db.connect() as con:
        con.execute(
            "UPDATE audit_log SET created_at=? WHERE person_id=? AND action='pond_nurture'",
            (when.isoformat(), person_id),
        )


def _fub_responses(*, emails, texts, person=None):
    """Canned responses in the order scan_reply_detection asks for them:
    GET /people (get_person), GET /emails, then GET /textMessages."""
    person = person or {"id": 42, "firstName": "Test", "lastName": "Lead", "tags": []}
    return [
        (200, {"people": [person]}),
        (200, {"emails": emails}),
        (200, {"textMessages": texts}),
    ]


@pytest.fixture()
def scan(m, engine, tmp_db, monkeypatch, fake_http):
    """The scan wired so it cannot touch the network, SMTP or FUB writes."""
    monkeypatch.setattr(engine.email, "send", lambda *a, **k: None)
    monkeypatch.setattr(engine.fub, "update_person", lambda *a, **k: {"stubbed": True})
    monkeypatch.setattr(engine.fub, "add_note", lambda *a, **k: {"stubbed": True})
    monkeypatch.setattr(engine, "user_cache_by_id", lambda: {})
    return engine


def _alerts(db):
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)
    rows = db.recent_audit_rows(["reply_detected"], since)
    return [r for r in rows if r["status"] == "alert_sent"]


def test_incoming_email_after_the_send_raises_an_alert(m, scan, tmp_db, fake_http):
    """The case that never once fired in production."""
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
    _seed_send(tmp_db, 42, sent_at)
    reply_at = sent_at + dt.timedelta(hours=1)
    fake_http.responses = _fub_responses(
        emails=[{
            "id": 1, "personId": 42,
            "isIncoming": True,
            "subject": "Re: Following up on your home search",
            "body": "Yes! Still looking in Austin. Can we talk Thursday?",
            "created": reply_at.isoformat(),
        }],
        texts=[],
    )

    scan.scan_reply_detection()

    alerts = _alerts(tmp_db)
    assert len(alerts) == 1, "an inbound email after the send must alert"
    assert json.loads(alerts[0]["details"])["reply_channel"] == "email"


def test_incoming_text_after_the_send_raises_an_alert(m, scan, tmp_db, fake_http):
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
    _seed_send(tmp_db, 42, sent_at)
    fake_http.responses = _fub_responses(
        emails=[],
        texts=[{
            "id": 7, "personId": 42,
            "isIncoming": True,
            "message": "stop by anytime",
            "created": (sent_at + dt.timedelta(minutes=30)).isoformat(),
        }],
    )

    scan.scan_reply_detection()

    assert len(_alerts(tmp_db)) == 1, "an inbound text after the send must alert"


def test_the_bots_own_outgoing_email_does_not_alert(m, scan, tmp_db, fake_http):
    """Regression the other way: pausing a lead who never replied is just as
    bad as missing one who did."""
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
    _seed_send(tmp_db, 42, sent_at)
    fake_http.responses = _fub_responses(
        emails=[{
            "id": 1, "personId": 42,
            "isIncoming": False,
            "subject": "Following up on your home search",
            "body": "Just checking in.",
            "created": (sent_at + dt.timedelta(minutes=5)).isoformat(),
        }],
        texts=[],
    )

    scan.scan_reply_detection()

    assert _alerts(tmp_db) == []


def test_reply_older_than_the_send_does_not_alert(m, scan, tmp_db, fake_http):
    """Only messages after our send are replies to it."""
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
    _seed_send(tmp_db, 42, sent_at)
    fake_http.responses = _fub_responses(
        emails=[{
            "id": 1, "personId": 42,
            "isIncoming": True,
            "subject": "old thread",
            "body": "asked months ago",
            "created": (sent_at - dt.timedelta(days=3)).isoformat(),
        }],
        texts=[],
    )

    scan.scan_reply_detection()

    assert _alerts(tmp_db) == []


# ── the duplicate-alert window ───────────────────────────────────────────────

def test_a_lead_already_alerted_on_is_not_alerted_twice(m, scan, tmp_db, fake_http):
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
    _seed_send(tmp_db, 42, sent_at)
    tmp_db.log("reply_detected", "alert_sent", 42, {"reply_channel": "email"})
    fake_http.responses = _fub_responses(
        emails=[{
            "id": 1, "personId": 42, "isIncoming": True, "subject": "Re: hi",
            "body": "yes", "created": (sent_at + dt.timedelta(hours=1)).isoformat(),
        }],
        texts=[],
    )

    scan.scan_reply_detection()

    assert len(_alerts(tmp_db)) == 1, "the pre-seeded alert must not be duplicated"


def test_an_earlier_error_does_not_suppress_the_lead_for_a_week(m, scan, tmp_db, fake_http):
    """The window was keyed on every reply_detected row, including the
    "error" rows the scan's own exception handler writes. One transient FUB
    error and that lead's replies went unseen for the next seven days."""
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
    _seed_send(tmp_db, 42, sent_at)
    tmp_db.log("reply_detected", "error", 42, {"error": "FUB API GET /emails failed 500"})
    fake_http.responses = _fub_responses(
        emails=[{
            "id": 1, "personId": 42, "isIncoming": True, "subject": "Re: hi",
            "body": "still interested", "created": (sent_at + dt.timedelta(hours=1)).isoformat(),
        }],
        texts=[],
    )

    scan.scan_reply_detection()

    assert len(_alerts(tmp_db)) == 1, "an errored scan must be retried, not skipped"


# ── classification: opt-out / auto-reply / human ─────────────────────────────
#
# Built from the real misses of 2026-08-22/23: an "UNSUBSCRIBE" reply that was
# neither trashed nor tagged, and two replies that landed 2–3 seconds after the
# send — autoresponders — that would have paged Peter as hot leads.

def _disqualifications(db):
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)
    return db.recent_audit_rows(["reply_intent_disqualification"], since)


def _autos(db):
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)
    return db.recent_audit_rows(["auto_reply_detected"], since)


def test_classify_reply_precedence(m):
    """opt_out > auto_reply > human, and opt-out cannot be shadowed by timing."""
    send = dt.datetime(2026, 8, 23, 13, 0, tzinfo=dt.timezone.utc)
    kw = m.RuleEngine._OPT_OUT_KEYWORDS
    hours_later = send + dt.timedelta(hours=1)
    seconds_later = send + dt.timedelta(seconds=2)

    assert m.classify_reply({"subject": "Re: hi", "body": "UNSUBSCRIBE"}, send, hours_later, kw) == "opt_out"
    # The compliance case that must not be lost to the auto heuristic: an
    # unsubscribe that arrives instantly is still an unsubscribe.
    assert m.classify_reply({"subject": "Re: hi", "body": "unsubscribe"}, send, seconds_later, kw) == "opt_out"
    assert m.classify_reply({"subject": "Re: hi", "body": "looks great, call me"}, send, seconds_later, kw) == "auto_reply"
    assert m.classify_reply({"subject": "Automatic reply: hi", "body": "I am away"}, send, hours_later, kw) == "auto_reply"
    assert m.classify_reply({"subject": "Re: hi", "body": "Out of office until Monday"}, send, hours_later, kw) == "auto_reply"
    assert m.classify_reply({"subject": "Re: hi", "body": "Yes, still looking!"}, send, hours_later, kw) == "human"
    # Standalone STOP is a text-message convention; an email saying only
    # "stop" has no such standard meaning and texts have no subject key.
    assert m.classify_reply({"message": "STOP"}, send, hours_later, kw) == "opt_out"
    assert m.classify_reply({"message": "stop by anytime"}, send, hours_later, kw) == "human"


def test_an_unsubscribe_reply_is_trashed_and_never_counts_warm(m, scan, tmp_db, fake_http, monkeypatch):
    """The Stephen Herrera case: 'UNSUBSCRIBE', 26 hours after a pond email.
    Compliance-critical: trash + tag, no hot-lead alert, no WARM."""
    updates = []
    monkeypatch.setattr(scan.fub, "update_person",
                        lambda pid, payload, **kw: updates.append((pid, payload)) or {})
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=26)
    _seed_send(tmp_db, 42, sent_at)
    fake_http.responses = _fub_responses(
        emails=[{
            "id": 1, "personId": 42, "isIncoming": True,
            "subject": "Re: Your next home in Austin",
            "body": "UNSUBSCRIBE",
            "created": (sent_at + dt.timedelta(hours=25)).isoformat(),
        }],
        texts=[],
    )

    scan.scan_reply_detection()

    assert _alerts(tmp_db) == [], "an unsubscribe must not page anyone as a hot lead"
    disq = _disqualifications(tmp_db)
    assert len(disq) == 1 and disq[0]["status"] == "opt_out_trashed"
    assert json.loads(disq[0]["details"])["trigger"] == "reply_detection_keyword"
    stages = [p.get("stage") for _, p in updates]
    assert "Trash" in stages, "the lead must actually be moved to Trash"
    tag_payloads = [p.get("tags") for _, p in updates if p.get("tags")]
    assert any("unsubscribed" in t and "opt-out-auto-trash" in t for t in tag_payloads)
    # And the funnel maths: a warm count over this window must be zero.
    import sqlite3 as _sq
    from fub_automation import funnel
    con = _sq.connect(tmp_db.path)
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)
    assert funnel.new_warm_today(con, since, dt.datetime.now(dt.timezone.utc)) == 0
    con.close()


def test_a_reply_seconds_after_the_send_is_classified_auto(m, scan, tmp_db, fake_http, monkeypatch):
    """The Ingrid/Claudette case: a 'reply' 2 seconds after the send is a
    machine. Logged, but no tag, no alert, no WARM."""
    updates = []
    monkeypatch.setattr(scan.fub, "update_person",
                        lambda pid, payload, **kw: updates.append((pid, payload)) or {})
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
    _seed_send(tmp_db, 42, sent_at)
    fake_http.responses = _fub_responses(
        emails=[{
            "id": 1, "personId": 42, "isIncoming": True,
            "subject": "Re: Your next home in Austin",
            "body": "Thanks for reaching out! I'll get back to you soon.",
            "created": (sent_at + dt.timedelta(seconds=2)).isoformat(),
        }],
        texts=[],
    )

    scan.scan_reply_detection()

    assert _alerts(tmp_db) == []
    assert updates == [], "an auto-reply must not tag the lead Replied - Paused"
    autos = _autos(tmp_db)
    assert len(autos) == 1 and autos[0]["status"] == "classified"
    details = json.loads(autos[0]["details"])
    assert details["seconds_after_send"] == 2.0
    assert details["reply_at"]


def test_the_same_auto_reply_is_not_relogged_every_scan(m, scan, tmp_db, fake_http):
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
    _seed_send(tmp_db, 42, sent_at)
    responses = _fub_responses(
        emails=[{
            "id": 1, "personId": 42, "isIncoming": True,
            "subject": "Automatic reply: Your next home",
            "body": "I am out of the office until Monday.",
            "created": (sent_at + dt.timedelta(minutes=10)).isoformat(),
        }],
        texts=[],
    )
    fake_http.responses = list(responses)
    scan.scan_reply_detection()
    fake_http.responses = list(responses)
    scan.scan_reply_detection()

    assert len(_autos(tmp_db)) == 1, "one auto-reply, one row, however many scans"


def test_an_auto_reply_does_not_mask_a_later_real_reply(m, scan, tmp_db, fake_http):
    """The expensive failure the old first-match loop would have had: the
    autoresponder answers first, the person answers later the same day."""
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=6)
    _seed_send(tmp_db, 42, sent_at)
    fake_http.responses = _fub_responses(
        emails=[
            {
                "id": 1, "personId": 42, "isIncoming": True,
                "subject": "Automatic reply: Your next home",
                "body": "I am out of the office.",
                "created": (sent_at + dt.timedelta(seconds=3)).isoformat(),
            },
            {
                "id": 2, "personId": 42, "isIncoming": True,
                "subject": "Re: Your next home",
                "body": "Back now — yes, let's set up a call this week.",
                "created": (sent_at + dt.timedelta(hours=5)).isoformat(),
            },
        ],
        texts=[],
    )

    scan.scan_reply_detection()

    alerts = _alerts(tmp_db)
    assert len(alerts) == 1, "the human reply must alert even though a machine answered first"
    assert "set up a call" in json.loads(alerts[0]["details"])["reply_snippet"]


def test_a_new_reply_after_a_classified_auto_still_alerts(m, scan, tmp_db, fake_http):
    """Scan 1 sees only the autoresponder; scan 2 sees a real answer as well.
    The auto classification must not have used up the lead."""
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=6)
    _seed_send(tmp_db, 42, sent_at)
    auto_email = {
        "id": 1, "personId": 42, "isIncoming": True,
        "subject": "Automatic reply: Your next home",
        "body": "I am out of the office.",
        "created": (sent_at + dt.timedelta(seconds=3)).isoformat(),
    }
    human_email = {
        "id": 2, "personId": 42, "isIncoming": True,
        "subject": "Re: Your next home",
        "body": "Following up properly now — still interested.",
        "created": (sent_at + dt.timedelta(hours=5)).isoformat(),
    }
    fake_http.responses = _fub_responses(emails=[auto_email], texts=[])
    scan.scan_reply_detection()
    assert _alerts(tmp_db) == []

    fake_http.responses = _fub_responses(emails=[auto_email, human_email], texts=[])
    scan.scan_reply_detection()

    assert len(_alerts(tmp_db)) == 1


def test_the_alert_row_carries_the_leads_own_timestamp(m, scan, tmp_db, fake_http):
    """NEEDS A REPLY measures hours waiting from when the lead wrote, not from
    when a scan happened to notice — the row has to carry that timestamp."""
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=8)
    reply_at = sent_at + dt.timedelta(hours=1)
    _seed_send(tmp_db, 42, sent_at)
    fake_http.responses = _fub_responses(
        emails=[{
            "id": 1, "personId": 42, "isIncoming": True,
            "subject": "Re: hi", "body": "yes please",
            "created": reply_at.isoformat(),
        }],
        texts=[],
    )

    scan.scan_reply_detection()

    details = json.loads(_alerts(tmp_db)[0]["details"])
    parsed = dt.datetime.fromisoformat(details["reply_at"])
    assert abs((parsed - reply_at).total_seconds()) < 1


def test_an_opted_out_lead_is_not_rescanned(m, scan, tmp_db, fake_http):
    """Once trashed for an opt-out, later scans skip the lead without even
    fetching it."""
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
    _seed_send(tmp_db, 42, sent_at)
    tmp_db.log("reply_intent_disqualification", "opt_out_trashed", 42, {})
    fake_http.responses = [(200, {})]

    scan.scan_reply_detection()

    assert fake_http.calls == [], "a disqualified lead must not cost API calls"
