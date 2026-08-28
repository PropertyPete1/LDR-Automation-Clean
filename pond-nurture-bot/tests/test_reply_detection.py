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
from pathlib import Path

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


# ── the daily wide sweep: replies to OLD threads ─────────────────────────────
#
# The 10-minute scan only watches leads emailed in the last 7 days. Joe Muñoz
# answered a July 4 thread on August 22 — seven weeks after his last send —
# and was structurally invisible to it. The wide sweep walks every lead FUB
# says was updated in the window instead, so thread age no longer matters.

def _sweep_responses(*, person_stub, person_detail, emails, texts):
    """Canned responses in the order scan_wide_reply_sweep asks: the -updated
    people page, then get_person, then emails, then texts."""
    return [
        (200, {"people": [person_stub]}),
        (200, {"people": [person_detail]}),
        (200, {"emails": emails}),
        (200, {"textMessages": texts}),
    ]


def test_the_sweep_catches_a_reply_to_a_seven_week_old_thread(m, scan, tmp_db, fake_http):
    """The Joe Muñoz case end to end: no audit send row anywhere near the
    reply, outbound seven weeks back, reply now — alert + tag anyway."""
    now = dt.datetime.now(dt.timezone.utc)
    old_send = now - dt.timedelta(days=49)
    reply_at = now - dt.timedelta(hours=10)
    fake_http.responses = _sweep_responses(
        person_stub={"id": 42, "updated": reply_at.isoformat()},
        person_detail={"id": 42, "firstName": "Joe", "lastName": "Muñoz", "tags": [],
                       "lastReceivedEmail": reply_at.isoformat()},
        emails=[
            {"id": 1, "personId": 42, "isIncoming": False,
             "subject": "Your home search", "body": "checking in",
             "created": old_send.isoformat()},
            {"id": 2, "personId": 42, "isIncoming": True,
             "subject": "Re: Your home search",
             "body": "Hey — yes, actually. Is the Elm house still available?",
             "created": reply_at.isoformat()},
        ],
        texts=[],
    )

    scan.scan_wide_reply_sweep()

    alerts = _alerts(tmp_db)
    assert len(alerts) == 1, "a reply to an old thread must alert"
    details = json.loads(alerts[0]["details"])
    assert "Elm" in details["reply_snippet"]
    assert details["contact_name"] == "Joe Muñoz"


def test_the_sweep_does_not_mistake_an_old_thread_reply_for_an_auto_reply(m, scan, tmp_db, fake_http):
    """With no outbound in the fetched history at all, the timing heuristic
    has no anchor and must not fire on an arbitrary epoch."""
    now = dt.datetime.now(dt.timezone.utc)
    reply_at = now - dt.timedelta(hours=5)
    fake_http.responses = _sweep_responses(
        person_stub={"id": 42, "updated": reply_at.isoformat()},
        person_detail={"id": 42, "firstName": "Joe", "lastName": "Muñoz", "tags": [],
                       "lastReceivedEmail": reply_at.isoformat()},
        emails=[{"id": 2, "personId": 42, "isIncoming": True,
                 "subject": "Re: hello", "body": "still interested",
                 "created": reply_at.isoformat()}],
        texts=[],
    )

    scan.scan_wide_reply_sweep()

    assert len(_alerts(tmp_db)) == 1
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)
    assert tmp_db.recent_audit_rows(["auto_reply_detected"], since) == []


def test_the_sweep_trashes_an_unsubscribe_on_an_old_thread(m, scan, tmp_db, fake_http, monkeypatch):
    updates = []
    monkeypatch.setattr(scan.fub, "update_person",
                        lambda pid, payload, **kw: updates.append((pid, payload)) or {})
    now = dt.datetime.now(dt.timezone.utc)
    reply_at = now - dt.timedelta(hours=3)
    fake_http.responses = _sweep_responses(
        person_stub={"id": 43, "updated": reply_at.isoformat()},
        person_detail={"id": 43, "firstName": "Stephen", "lastName": "Herrera", "tags": [],
                       "lastReceivedEmail": reply_at.isoformat()},
        emails=[{"id": 9, "personId": 43, "isIncoming": True,
                 "subject": "Re: pond email", "body": "UNSUBSCRIBE",
                 "created": reply_at.isoformat()}],
        texts=[],
    )

    scan.scan_wide_reply_sweep()

    assert _alerts(tmp_db) == []
    assert "Trash" in [p.get("stage") for _, p in updates]
    since = now - dt.timedelta(days=1)
    disq = tmp_db.recent_audit_rows(["reply_intent_disqualification"], since)
    assert len(disq) == 1 and disq[0]["status"] == "opt_out_trashed"


def test_the_sweep_skips_already_alerted_leads_without_api_cost(m, scan, tmp_db, fake_http):
    now = dt.datetime.now(dt.timezone.utc)
    tmp_db.log("reply_detected", "alert_sent", 42, {"reply_channel": "email"})
    fake_http.responses = [
        (200, {"people": [{"id": 42, "updated": now.isoformat()}]}),
    ]

    scan.scan_wide_reply_sweep()

    assert len(fake_http.calls) == 1, "only the people page — no detail fetch for a handled lead"
    assert len(_alerts(tmp_db)) == 1, "no duplicate"


def test_the_sweep_stops_at_the_window_edge(m, scan, tmp_db, fake_http):
    now = dt.datetime.now(dt.timezone.utc)
    stale = {"id": 7, "updated": (now - dt.timedelta(days=30)).isoformat()}
    fake_http.responses = [(200, {"people": [stale]})]

    scan.scan_wide_reply_sweep()

    assert len(fake_http.calls) == 1, "a stale first lead ends the walk immediately"


def test_the_daily_runner_invokes_the_wide_sweep():
    """Wiring guard: the sweep only exists if the daily run actually calls it."""
    source = (Path(__file__).resolve().parents[1] / "run_approved_daily_automation.py").read_text()
    assert "scan_wide_reply_sweep()" in source


# ── the sweep's audit-log rotation ───────────────────────────────────────────
#
# The first backfill dry run (2026-08-24, run 32757820303) proved the -updated
# walk nearly blind: FUB does not bump `updated` for synced email, so an
# old-thread reply rarely appears there. The rotation reads message histories
# for everyone WE emailed 7–60 days ago, a deterministic slice per day.

def _todays_slot_pid(m, k=0):
    """A person_id that falls in today's rotation slice (offset k slices)."""
    rotation = m.RuleEngine.WIDE_SWEEP_ROTATION_DAYS
    slot = dt.datetime.now(dt.timezone.utc).timetuple().tm_yday % rotation
    pid = slot + rotation * (5 + k)  # keep ids comfortably positive
    return pid if k == 0 else pid + 1  # +1 leaves the slice when k != 0


def test_the_rotation_catches_an_old_thread_reply_the_walk_cannot_see(m, scan, tmp_db, fake_http):
    """Joe end to end through the sweep: his record was never 'updated', but
    our audit row says we emailed him 30 days ago, and his messages hold a
    fresh reply."""
    pid = _todays_slot_pid(m)
    now = dt.datetime.now(dt.timezone.utc)
    old_send = now - dt.timedelta(days=30)
    reply_at = now - dt.timedelta(hours=20)
    _seed_send(tmp_db, pid, old_send)
    fake_http.responses = [
        (200, {}),  # the -updated walk: nothing changed on any record
        (200, {"emails": [
            {"id": 1, "personId": pid, "isIncoming": False,
             "subject": "checking in", "body": "hello", "created": old_send.isoformat()},
            {"id": 2, "personId": pid, "isIncoming": True,
             "subject": "Re: checking in",
             "body": "Yes — is the Elm house still available?",
             "created": reply_at.isoformat()},
        ]}),
        (200, {"textMessages": []}),
        (200, {"people": [{"id": pid, "firstName": "Joe", "lastName": "Muñoz", "tags": []}]}),
    ]

    scan.scan_wide_reply_sweep()

    alerts = _alerts(tmp_db)
    assert len(alerts) == 1, "the rotation must find the reply the walk cannot"
    assert "Elm" in json.loads(alerts[0]["details"])["reply_snippet"]


def test_a_lead_outside_todays_slice_costs_nothing(m, scan, tmp_db, fake_http):
    pid = _todays_slot_pid(m, k=1)  # deliberately NOT in today's slice
    _seed_send(tmp_db, pid, dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30))
    fake_http.responses = [(200, {})]

    scan.scan_wide_reply_sweep()

    assert len(fake_http.calls) == 1, "only the walk's empty page — no rotation calls"


def test_the_rotation_leaves_the_last_7_days_to_the_ten_minute_scan(m, scan, tmp_db, fake_http):
    pid = _todays_slot_pid(m)
    _seed_send(tmp_db, pid, dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2))
    fake_http.responses = [(200, {})]

    scan.scan_wide_reply_sweep()

    assert len(fake_http.calls) == 1, "a recent send belongs to the 10-minute scan"


def test_every_emailed_lead_is_covered_within_one_rotation(m):
    """The guarantee the slice math rests on: over ROTATION consecutive days,
    every person_id falls in exactly one daily slice."""
    rotation = m.RuleEngine.WIDE_SWEEP_ROTATION_DAYS
    for pid in range(1, 500):
        hits = sum(1 for day in range(rotation) if pid % rotation == day % rotation)
        assert hits == 1


# ── the account's REAL email objects (diagnosed 2026-08-24, run 32771837161) ─
#
# This FUB account returns emails with NO isIncoming/direction/type at all.
# Inbound is carried by status='Received' and relatedPeople[].sentByPerson,
# and the content-sharing setting replaces subject/body with the literal
# '[CONTENT HIDDEN]'. These tests pin the dumped payloads for Joe (id 51851)
# and Stephen (id 52004) so the predicate can never again pass on a field the
# account does not send.

def _real_inbound_email(created, *, email_id=51851, person_id=5889, thread_id=48582):
    """Joe's actual reply object, field for field, values redacted."""
    return {
        "id": email_id,
        "created": created.isoformat(),
        "date": created.isoformat(),
        "status": "Received",
        "subject": "[CONTENT HIDDEN]",
        "bodyExcerpt": "[CONTENT HIDDEN]",
        "bodyHtmlVisibleClean": "[CONTENT HIDDEN]",
        "bodyHtmlHiddenClean": "[CONTENT HIDDEN]",
        "addresses": {"to": [], "from": [], "cc": [], "bcc": []},
        "relatedPeople": [{"personId": person_id, "sentByPerson": True,
                           "threadId": thread_id}],
        "threadId": thread_id,
        "emailAccountId": 396015,
        "userId": 2,
        "read": False,
        "bounced": False,
        "unsubscribed": False,
        "hasAttachments": False,
    }


def _real_outbound_email(created, *, email_id=51937, person_id=3346, thread_id=48666):
    """A synced copy of the bot's own send, field for field (diagnostic run
    32777950427, Stephen's 13:05 pond email). NOTE status='Received' — FUB
    stamps that on everything the mailbox sync ingests, direction included."""
    return {
        "id": email_id,
        "created": created.isoformat(),
        "date": created.isoformat(),
        "status": "Received",
        "archived": True,
        "subject": "[CONTENT HIDDEN]",
        "bodyExcerpt": "[CONTENT HIDDEN]",
        "relatedPeople": [{"personId": person_id, "sentByPerson": False,
                           "threadId": thread_id}],
        "threadId": thread_id,
        "emailAccountId": 396015,
        "userId": 2,
        "bounced": False,
        "unsubscribed": False,
    }


def test_sent_by_person_not_status_decides_direction(m):
    """status='Received' appears on BOTH directions in this account — a
    predicate keyed on it classified every synced send as a reply and filled
    dry run 32772863771's plan with the bot answering itself. Only
    sentByPerson separates the two."""
    now = dt.datetime.now(dt.timezone.utc)
    assert m.is_inbound_message(_real_inbound_email(now)) is True
    assert m.is_inbound_message(_real_outbound_email(now)) is False
    assert m.is_inbound_message({"status": "Received"}) is False, \
        "status alone must never read as inbound — synced sends carry it too"
    assert m.is_inbound_message({"status": "Sent"}) is False


def test_sent_by_person_is_inbound(m):
    assert m.is_inbound_message({"relatedPeople": [{"sentByPerson": True}]}) is True
    assert m.is_inbound_message({"relatedPeople": [{"sentByPerson": False}]}) is False
    assert m.is_inbound_message({"relatedPeople": []}) is False


def test_hidden_content_is_detected_and_never_shown_as_the_leads_words(m):
    now = dt.datetime.now(dt.timezone.utc)
    hidden = _real_inbound_email(now)
    assert m.message_content_hidden(hidden) is True
    assert m.message_content_hidden({"subject": "Re: hi", "body": "yes"}) is False
    snippet = m.reply_display_snippet(hidden)
    assert "hidden" in snippet.lower() and "CONTENT HIDDEN" not in snippet


def test_fubs_own_unsubscribe_flag_is_an_opt_out_even_with_content_hidden(m):
    send = dt.datetime(2026, 8, 23, 13, 5, tzinfo=dt.timezone.utc)
    reply = send + dt.timedelta(minutes=49)
    email = _real_inbound_email(reply)
    email["unsubscribed"] = True
    assert m.classify_reply(email, send, reply, m.RuleEngine._OPT_OUT_KEYWORDS) == "opt_out"


def test_hidden_content_limitation_is_pinned(m):
    """KNOWN LIMIT until the FUB email-sharing setting is flipped: a typed
    'UNSUBSCRIBE' lives in a hidden body, so the keyword scan cannot fire and
    the reply classifies human — surfaced to Peter, not auto-trashed. This
    test exists so that limitation is a documented decision, not a surprise."""
    send = dt.datetime(2026, 8, 23, 13, 5, tzinfo=dt.timezone.utc)
    reply = send + dt.timedelta(minutes=49)
    email = _real_inbound_email(reply)  # body actually said UNSUBSCRIBE
    assert m.classify_reply(email, send, reply, m.RuleEngine._OPT_OUT_KEYWORDS) == "human"
    # Timing still classifies a machine even with content hidden.
    instant = _real_inbound_email(send + dt.timedelta(seconds=2))
    assert m.classify_reply(instant, send, send + dt.timedelta(seconds=2),
                            m.RuleEngine._OPT_OUT_KEYWORDS) == "auto_reply"


def test_the_real_payload_alerts_end_to_end(m, scan, tmp_db, fake_http):
    """Stephen's actual shape through the whole 10-minute scan: send 13:05,
    status='Received' reply 13:54, content hidden — one alert, honest
    snippet."""
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
    reply_at = sent_at + dt.timedelta(minutes=49)
    _seed_send(tmp_db, 42, sent_at)
    # One thread, as measured: Stephen's genuine reply 52004 shared threadId
    # 48666 with the synced copy of our own send — the lineage the
    # thread-verification gate now requires.
    fake_http.responses = _fub_responses(
        emails=[
            _real_outbound_email(sent_at, email_id=52003, person_id=42,
                                 thread_id=48666),
            _real_inbound_email(reply_at, email_id=52004, person_id=42,
                                thread_id=48666),
        ],
        texts=[],
    )

    scan.scan_reply_detection()

    alerts = _alerts(tmp_db)
    assert len(alerts) == 1, "the account's real payload shape must alert"
    details = json.loads(alerts[0]["details"])
    assert "hidden" in details["reply_snippet"].lower()
    assert "CONTENT HIDDEN" not in details["reply_snippet"]


def test_the_synced_copy_of_our_own_send_is_not_a_reply(m, scan, tmp_db, fake_http):
    """The exact shape that poisoned dry run 32772863771: the lead's only
    message is the mailbox-sync copy of the bot's own send, landing a couple
    of seconds after the audit row. No alert, no tag, no auto row — nothing."""
    sent_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
    _seed_send(tmp_db, 42, sent_at)
    fake_http.responses = _fub_responses(
        emails=[_real_outbound_email(sent_at + dt.timedelta(seconds=2),
                                     email_id=51937, person_id=42)],
        texts=[],
    )

    scan.scan_reply_detection()

    assert _alerts(tmp_db) == []
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)
    assert tmp_db.recent_audit_rows(["auto_reply_detected"], since) == [], \
        "the bot's own send echoing back must not even count as an auto-reply"


# ── thread lineage: the 2026-08-28 third-party false positive ────────────────
#
# "HOT LEAD REPLY: Angie Gonzalez" fired 2026-08-28 22:37 UTC, but Angie
# (FUB 6340) never replied. Run 33218198212 dumped her record: FOUR emails,
# all on one thread (49329, "Lender Intro Irene and Angie" — correspondence
# between third parties that FUB attached to her record), and the one that
# fired carried relatedPeople=[{personId: 6340, sentByPerson: True}] —
# field-for-field a genuine reply. sentByPerson is FUB's attribution, not
# proof the lead wrote anything, so an inbound email may only alert when its
# thread also holds one of OUR audit-logged sends (reply_thread_verified).

def _lender_thread_email(created, *, email_id, sent_by_person,
                         person_id=6340, thread_id=49329):
    """One email of Angie's lender thread, field for field as measured."""
    return {
        "id": email_id,
        "created": created.isoformat(),
        "date": (created + dt.timedelta(seconds=40)).isoformat(),
        "status": "Received",
        "subject": "[CONTENT HIDDEN]",
        "bodyExcerpt": "[CONTENT HIDDEN]",
        "bodyHtmlVisibleClean": "[CONTENT HIDDEN]",
        "bodyHtmlHiddenClean": "[CONTENT HIDDEN]",
        "addresses": {"to": [], "from": [], "cc": [], "bcc": []},
        "relatedPeople": [{"personId": person_id, "sentByPerson": sent_by_person,
                           "threadId": thread_id, "threadTotal": 4}],
        "threadId": str(thread_id),
        "emailAccountId": 395995,
        "userId": 1,
        "unsubscribed": False,
    }


def _angies_record(now):
    """Her four emails: the intro our agent sent by hand (never audit-logged),
    a follow-up, and the two lender emails of Aug 28 — 52889 being the one
    FUB stamped sentByPerson=True and the scan alerted on."""
    return [
        _lender_thread_email(now - dt.timedelta(hours=7),
                             email_id=52890, sent_by_person=False),
        _lender_thread_email(now - dt.timedelta(hours=8),
                             email_id=52889, sent_by_person=True),
        _lender_thread_email(now - dt.timedelta(hours=25),
                             email_id=52644, sent_by_person=False),
        _lender_thread_email(now - dt.timedelta(hours=25, minutes=30),
                             email_id=52642, sent_by_person=False),
    ]


def test_third_party_email_on_a_leads_record_must_not_alert(
        m, scan, tmp_db, fake_http, monkeypatch):
    """THE regression pin. The lender thread through the whole 10-minute scan:
    no alert, no tag, no reply_detected row (so it can never count WARM) —
    one unverified_inbound/review row and one note instead."""
    now = dt.datetime.now(dt.timezone.utc)
    _seed_send(tmp_db, 6340, now - dt.timedelta(hours=26))  # the welcome email
    updates, notes = [], []
    monkeypatch.setattr(scan.fub, "update_person",
                        lambda pid, payload, **kw: updates.append((pid, payload)) or {})
    monkeypatch.setattr(scan.fub, "add_note",
                        lambda pid, subject, body: notes.append((pid, subject)) or {})
    fake_http.responses = _fub_responses(
        person={"id": 6340, "firstName": "Angie", "lastName": "Gonzalez", "tags": []},
        emails=_angies_record(now),
        texts=[],
    )

    scan.scan_reply_detection()

    assert _alerts(tmp_db) == [], "a lender's email must never page anyone"
    assert updates == [], "a lender's email must never tag the lead Replied - Paused"
    since = now - dt.timedelta(days=1)
    assert tmp_db.recent_audit_rows(["reply_detected"], since) == [], \
        "no reply_detected row of any status — nothing here may count WARM"
    review = tmp_db.recent_audit_rows(["unverified_inbound"], since)
    assert len(review) == 1 and review[0]["status"] == "review"
    details = json.loads(review[0]["details"])
    assert details["thread_id"] == "49329"
    assert [s for _, s in notes] == ["Automation: unverified inbound email — review"]


def test_the_same_lender_email_is_not_relogged_every_ten_minutes(
        m, scan, tmp_db, fake_http, monkeypatch):
    now = dt.datetime.now(dt.timezone.utc)
    _seed_send(tmp_db, 6340, now - dt.timedelta(hours=26))
    notes = []
    monkeypatch.setattr(scan.fub, "add_note",
                        lambda pid, subject, body: notes.append(subject) or {})
    responses = _fub_responses(
        person={"id": 6340, "firstName": "Angie", "lastName": "Gonzalez", "tags": []},
        emails=_angies_record(now),
        texts=[],
    )
    fake_http.responses = list(responses)
    scan.scan_reply_detection()
    fake_http.responses = list(responses)
    scan.scan_reply_detection()

    since = now - dt.timedelta(days=1)
    assert len(tmp_db.recent_audit_rows(["unverified_inbound"], since)) == 1
    assert len(notes) == 1, "one thread, one note — however many scans run over it"


def test_a_genuine_reply_on_a_brand_new_thread_is_review_not_hot(
        m, scan, tmp_db, fake_http):
    """The gate's documented cost, pinned as a decision: a real reply whose
    thread holds no synced copy of our send (brand-new thread, or the sync
    never landed) is surfaced for review — visible, but it cannot page."""
    now = dt.datetime.now(dt.timezone.utc)
    sent_at = now - dt.timedelta(hours=2)
    _seed_send(tmp_db, 42, sent_at)
    fake_http.responses = _fub_responses(
        emails=[_real_inbound_email(sent_at + dt.timedelta(minutes=49),
                                    person_id=42, thread_id=99999)],
        texts=[],
    )

    scan.scan_reply_detection()

    assert _alerts(tmp_db) == []
    since = now - dt.timedelta(days=1)
    review = tmp_db.recent_audit_rows(["unverified_inbound"], since)
    assert len(review) == 1, "an unverifiable reply must still surface for review"


def test_a_text_reply_still_alerts_without_thread_lineage(m, scan, tmp_db, fake_http):
    """Texts have no threads — the gate does not apply to them, and the
    2026-08-28 incident was email-only. A genuine SMS reply keeps paging."""
    now = dt.datetime.now(dt.timezone.utc)
    sent_at = now - dt.timedelta(hours=2)
    _seed_send(tmp_db, 42, sent_at)
    fake_http.responses = _fub_responses(
        emails=[],
        texts=[{"id": 7, "personId": 42, "isIncoming": True,
                "message": "Yes! Call me tomorrow?",
                "created": (sent_at + dt.timedelta(hours=1)).isoformat()}],
    )

    scan.scan_reply_detection()

    alerts = _alerts(tmp_db)
    assert len(alerts) == 1
    assert json.loads(alerts[0]["details"])["reply_channel"] == "text"


def test_unverified_does_not_suppress_a_later_verified_reply(
        m, scan, tmp_db, fake_http):
    """The lender writes on Monday, Angie genuinely replies on Tuesday: the
    unverified row must not blind the scan to the real reply."""
    now = dt.datetime.now(dt.timezone.utc)
    sent_at = now - dt.timedelta(hours=26)
    _seed_send(tmp_db, 6340, sent_at)
    person = {"id": 6340, "firstName": "Angie", "lastName": "Gonzalez", "tags": []}
    fake_http.responses = _fub_responses(
        person=person, emails=_angies_record(now), texts=[])
    scan.scan_reply_detection()
    assert _alerts(tmp_db) == []

    # Tuesday: her genuine reply, on the thread of our synced send.
    fake_http.responses = _fub_responses(
        person=person,
        emails=[
            *_angies_record(now),
            _real_outbound_email(sent_at, email_id=60001, person_id=6340,
                                 thread_id=50000),
            _real_inbound_email(now - dt.timedelta(minutes=30), email_id=60002,
                                person_id=6340, thread_id=50000),
        ],
        texts=[])
    scan.scan_reply_detection()

    assert len(_alerts(tmp_db)) == 1, \
        "a verified reply after third-party mail must still alert"


def test_a_voided_alert_rearms_the_scan(m, scan, tmp_db, fake_http):
    """After the repair sweep voids a false positive
    (reply_false_positive_cleared), the lead must leave already_alerted —
    otherwise they are blind for the whole dedup window right after cleanup."""
    now = dt.datetime.now(dt.timezone.utc)
    sent_at = now - dt.timedelta(hours=26)
    _seed_send(tmp_db, 6340, sent_at)
    false_reply_at = (now - dt.timedelta(hours=8)).isoformat()
    tmp_db.log("reply_detected", "alert_sent", 6340,
               {"reply_at": false_reply_at, "contact_name": "Angie Gonzalez"})
    tmp_db.log("reply_false_positive_cleared", "completed", 6340,
               {"reply_at": false_reply_at, "removed_tag": "Replied - Paused"})
    fake_http.responses = _fub_responses(
        person={"id": 6340, "firstName": "Angie", "lastName": "Gonzalez", "tags": []},
        emails=[
            _real_outbound_email(sent_at, email_id=60001, person_id=6340,
                                 thread_id=50000),
            _real_inbound_email(now - dt.timedelta(minutes=30), email_id=60002,
                                person_id=6340, thread_id=50000),
        ],
        texts=[])

    scan.scan_reply_detection()

    assert len(_alerts(tmp_db)) == 2, \
        "the voided alert must not suppress a later genuine reply"


def test_a_voided_alert_leaves_the_needs_reply_list(m, scan, tmp_db):
    """NEEDS A REPLY and THE FLOOR read reply_detected rows; a voided false
    positive must stop showing a lead 'awaiting a human' who never wrote."""
    reply_at = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=8)).isoformat()
    tmp_db.log("reply_detected", "alert_sent", 6340,
               {"reply_at": reply_at, "contact_name": "Angie Gonzalez",
                "reply_channel": "email"})
    assert [e["person_id"] for e in scan._collect_needs_reply()] == [6340]

    tmp_db.log("reply_false_positive_cleared", "completed", 6340,
               {"reply_at": reply_at, "removed_tag": "Replied - Paused"})
    assert scan._collect_needs_reply() == []


def test_reply_thread_verified_directly(m):
    """The verifier's contract, case by case."""
    now = dt.datetime.now(dt.timezone.utc)
    reply = _real_inbound_email(now, person_id=42, thread_id=48666)
    our_send = _real_outbound_email(now - dt.timedelta(minutes=49),
                                    person_id=42, thread_id=48666)
    anchor_ts = now - dt.timedelta(minutes=49)

    # The measured genuine shape: shared thread + audit row within tolerance.
    assert m.reply_thread_verified(reply, [our_send, reply], [anchor_ts]) is True
    # Audit row outside the sync-latency tolerance: not our send.
    assert m.reply_thread_verified(
        reply, [our_send, reply],
        [anchor_ts - dt.timedelta(seconds=m.BOT_SEND_MATCH_SECONDS + 1)]) is False
    # int vs str threadId must still match — FUB mixes them across surfaces.
    int_thread = dict(our_send, threadId=48666)
    str_thread = dict(reply, threadId="48666")
    assert m.reply_thread_verified(str_thread, [int_thread, str_thread],
                                   [anchor_ts]) is True
    # A thread whose only other member is ALSO inbound proves nothing.
    other_inbound = _real_inbound_email(now - dt.timedelta(hours=1),
                                        email_id=2, person_id=42, thread_id=48666)
    assert m.reply_thread_verified(reply, [other_inbound, reply], [anchor_ts]) is False
    # No thread at all (texts; other account shapes): the gate does not apply.
    assert m.reply_thread_verified({"isIncoming": True}, [], []) is True
    # No bot sends on record: nothing can verify.
    assert m.reply_thread_verified(reply, [our_send, reply], []) is False
