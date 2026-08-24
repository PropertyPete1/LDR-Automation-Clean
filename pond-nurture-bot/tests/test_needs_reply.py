"""NEEDS A REPLY — the daily summary's list of leads waiting on a human.

The #1 thing Peter opens the daily email for: every inbound reply with no
outbound response yet — name, snippet, hours waiting, FUB link. Real human
replies only; auto-replies are classified out by the scan and opt-outs leave
the list the moment their disqualification row lands.

No network: conftest's FakeHttp stands in for requests.request.
"""
from __future__ import annotations

import datetime as dt
import json

import pytest

UTC = dt.timezone.utc


def _reply_row(db, person_id, reply_at, *, status="alert_sent", name="Joe Muñoz",
               snippet="Yes — is the house on Elm still available?"):
    db.log("reply_detected", status, person_id, {
        "reply_channel": "email",
        "reply_snippet": snippet,
        "reply_at": reply_at.isoformat(),
        "contact_name": name,
    })


def _no_messages(fake_http):
    """FUB shows no outbound after any reply: everything stays waiting."""
    fake_http.responses = [(200, {})]


@pytest.fixture()
def quiet_engine(m, engine, monkeypatch):
    """Engine whose outbound surfaces are stubbed and recorded."""
    sent = []
    monkeypatch.setattr(
        engine.email, "send",
        lambda *a, **k: sent.append((a, k)) or None)
    engine._sent_emails = sent
    return engine


# ── the collector ────────────────────────────────────────────────────────────

def test_an_unanswered_reply_is_listed_with_hours_waiting(quiet_engine, tmp_db, fake_http):
    reply_at = dt.datetime.now(UTC) - dt.timedelta(hours=41)
    _reply_row(tmp_db, 42, reply_at)
    _no_messages(fake_http)

    needs = quiet_engine._collect_needs_reply()

    assert len(needs) == 1
    entry = needs[0]
    assert entry["person_id"] == 42
    assert entry["name"] == "Joe Muñoz"
    assert "Elm" in entry["snippet"]
    assert 40.5 < entry["hours_waiting"] < 41.5


def test_an_outbound_message_after_the_reply_clears_the_lead(quiet_engine, tmp_db, fake_http):
    """'Replied - Paused' blocks the bot, so ANY outbound after the reply is a
    human answering — including Peter replying from Gmail, which FUB's mailbox
    sync logs to the lead's timeline."""
    reply_at = dt.datetime.now(UTC) - dt.timedelta(hours=30)
    _reply_row(tmp_db, 42, reply_at)
    fake_http.responses = [
        (200, {"emails": [{
            "id": 5, "personId": 42, "isIncoming": False,
            "subject": "Re: the house on Elm",
            "body": "It is! Want to see it Saturday?",
            "created": (reply_at + dt.timedelta(hours=3)).isoformat(),
        }]}),
        (200, {"textMessages": []}),
    ]

    assert quiet_engine._collect_needs_reply() == []


def test_an_outbound_message_before_the_reply_does_not_clear_it(quiet_engine, tmp_db, fake_http):
    """The bot's own send that TRIGGERED the reply must not read as an answer."""
    reply_at = dt.datetime.now(UTC) - dt.timedelta(hours=30)
    _reply_row(tmp_db, 42, reply_at)
    fake_http.responses = [
        (200, {"emails": [{
            "id": 5, "personId": 42, "isIncoming": False,
            "subject": "Your next home in Austin",
            "body": "Hi Joe, just checking in.",
            "created": (reply_at - dt.timedelta(hours=2)).isoformat(),
        }]}),
        (200, {"textMessages": []}),
    ]

    assert len(quiet_engine._collect_needs_reply()) == 1


def test_an_opt_out_never_appears(quiet_engine, tmp_db, fake_http):
    """They replied to leave; nobody owes them an answer."""
    reply_at = dt.datetime.now(UTC) - dt.timedelta(hours=20)
    _reply_row(tmp_db, 42, reply_at, name="Stephen Herrera", snippet="UNSUBSCRIBE")
    tmp_db.log("reply_intent_disqualification", "opt_out_trashed", 42, {})
    _no_messages(fake_http)

    assert quiet_engine._collect_needs_reply() == []


def test_backfilled_rows_count_like_live_alerts(quiet_engine, tmp_db, fake_http):
    """The retro repair writes status='backfilled' — those leads have been
    waiting longer than anyone and must not be invisible for it."""
    reply_at = dt.datetime.now(UTC) - dt.timedelta(days=2, hours=7)
    _reply_row(tmp_db, 42, reply_at, status="backfilled")
    _no_messages(fake_http)

    needs = quiet_engine._collect_needs_reply()

    assert len(needs) == 1
    assert needs[0]["hours_waiting"] > 48


def test_a_fub_error_keeps_the_lead_listed(quiet_engine, tmp_db, fake_http, monkeypatch):
    """Fail open in the direction that costs a glance, not a lead."""
    _reply_row(tmp_db, 42, dt.datetime.now(UTC) - dt.timedelta(hours=10))

    def _boom(*a, **k):
        raise RuntimeError("FUB 500")

    monkeypatch.setattr(quiet_engine.fub, "get_emails", _boom)

    assert len(quiet_engine._collect_needs_reply()) == 1


def test_longest_waiting_first(quiet_engine, tmp_db, fake_http):
    now = dt.datetime.now(UTC)
    _reply_row(tmp_db, 1, now - dt.timedelta(hours=5), name="Newer")
    _reply_row(tmp_db, 2, now - dt.timedelta(hours=50), name="Older")
    _no_messages(fake_http)

    needs = quiet_engine._collect_needs_reply()

    assert [e["name"] for e in needs] == ["Older", "Newer"]


def test_two_replies_from_one_lead_are_one_entry(quiet_engine, tmp_db, fake_http):
    """Joe replied at 02:47 and again at 02:52 — one waiting thread, aged from
    the most recent reply."""
    now = dt.datetime.now(UTC)
    _reply_row(tmp_db, 42, now - dt.timedelta(hours=48, minutes=5))
    _reply_row(tmp_db, 42, now - dt.timedelta(hours=48))
    _no_messages(fake_http)

    needs = quiet_engine._collect_needs_reply()

    assert len(needs) == 1
    assert 47.5 < needs[0]["hours_waiting"] < 48.5


def test_format_hours_waiting(m):
    assert m.format_hours_waiting(41.4) == "41h"
    assert m.format_hours_waiting(47.9) == "48h"
    assert m.format_hours_waiting(55.0) == "2d 7h"
    assert m.format_hours_waiting(0.2) == "0h"


# ── the section in the daily email ───────────────────────────────────────────

def _summary_bodies(engine):
    """(plain, html) of the daily summary the engine just sent."""
    assert engine._sent_emails, "no summary email was sent"
    args, kwargs = engine._sent_emails[-1]
    plain = kwargs.get("body") or (args[2] if len(args) > 2 else "")
    return str(plain), str(kwargs.get("html_body") or "")


def test_the_summary_leads_with_the_needs_reply_section(quiet_engine, tmp_db, fake_http):
    reply_at = dt.datetime.now(UTC) - dt.timedelta(hours=41)
    _reply_row(tmp_db, 42, reply_at)
    _no_messages(fake_http)

    quiet_engine.send_phase2_daily_summary()

    plain, html = _summary_bodies(quiet_engine)
    for body in (plain, html):
        assert "NEEDS A REPLY" in body
        assert "Joe Muñoz" in body
        assert "41h" in body
        assert "Elm" in body
    assert "https://www.followupboss.com/2/people/view/42" in html
    # The one section Peter reads first sits above the metrics block.
    assert html.index("NEEDS A REPLY") < html.index("QUICK METRICS")


def test_an_empty_backlog_renders_the_all_clear_line(quiet_engine, tmp_db, fake_http):
    """The section degrades to an explicit all-clear, never to absence — its
    absence must always mean a bug."""
    # Something for the day so the summary sends at all.
    tmp_db.log("pond_nurture", "sent", 7, {"city": "Austin"})
    _no_messages(fake_http)

    quiet_engine.send_phase2_daily_summary()

    plain, html = _summary_bodies(quiet_engine)
    assert "NEEDS A REPLY — none" in plain
    assert "NEEDS A REPLY — none" in html


def test_a_waiting_lead_makes_an_otherwise_quiet_day_send(quiet_engine, tmp_db, fake_http):
    """No sends, no reassignments, no alerts today — but somebody is waiting.
    The quiet-day gate must not swallow the email."""
    _reply_row(tmp_db, 42, dt.datetime.now(UTC) - dt.timedelta(hours=30))
    _no_messages(fake_http)

    quiet_engine.send_phase2_daily_summary()

    plain, _ = _summary_bodies(quiet_engine)
    assert "NEEDS A REPLY — 1 lead(s)" in plain


def test_auto_replies_appear_only_as_a_count(quiet_engine, tmp_db, fake_http):
    tmp_db.log("pond_nurture", "sent", 7, {"city": "Austin"})
    tmp_db.log("auto_reply_detected", "classified", 9, {
        "reply_at": dt.datetime.now(UTC).isoformat(),
        "reply_snippet": "I am out of the office.",
        "contact_name": "Ingrid",
    })
    _no_messages(fake_http)

    quiet_engine.send_phase2_daily_summary()

    plain, html = _summary_bodies(quiet_engine)
    assert "1 auto-reply classified" in plain
    assert "1 auto-reply classified" in html
    assert "Ingrid" not in plain, "auto-replies are a count, not a call to action"


def test_a_bot_send_after_the_reply_does_not_read_as_an_answer(quiet_engine, tmp_db, fake_http):
    """The blind-fortnight case: the reply was missed, so 'Replied - Paused'
    was never applied and the bot kept mailing the lead. That automated send —
    present in FUB's log AND in our audit rows at (almost) the same moment —
    must not clear them from the list. Only a human's outbound does."""
    reply_at = dt.datetime.now(UTC) - dt.timedelta(days=3)
    bot_send_at = reply_at + dt.timedelta(days=1)
    _reply_row(tmp_db, 42, reply_at, status="backfilled")
    # The audit record of the bot's send, one sync-minute off FUB's copy.
    tmp_db.log("pond_nurture", "sent", 42, {"city": "Austin"})
    with tmp_db.connect() as con:
        con.execute(
            "UPDATE audit_log SET created_at=? WHERE action='pond_nurture' AND person_id=42",
            ((bot_send_at + dt.timedelta(seconds=45)).isoformat(),),
        )
    fake_http.responses = [
        (200, {"emails": [{
            "id": 5, "personId": 42, "isIncoming": False,
            "subject": "Your next home in Austin",
            "body": "automated pond nurture",
            "created": bot_send_at.isoformat(),
        }]}),
        (200, {"textMessages": []}),
    ]

    needs = quiet_engine._collect_needs_reply()

    assert len(needs) == 1, "an automated send is not an answer"
