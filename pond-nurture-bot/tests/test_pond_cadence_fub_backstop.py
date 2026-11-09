"""Pond cadence holds even when the state DB lost its clock (2026-11-09).

From at least 2026-10-30 to 2026-11-08 no daily run's rows reached the state
branch, so reengagement_log froze at each lead's last SAVED send and the 10/14/
21-day cadence gates read stale dates. Only the 3-day FUB check still held:
leads were emailed every 3-4 days (one Austin lead Nov 1, Nov 4 and Nov 8; she
replied UNSUBSCRIBE to the third). The bot's sends sync into FUB from the
mailbox, so process_reengagement_candidate now also reads the lead's newest
OUTBOUND email on the FUB timeline and applies the same cadence to it.

Drives the real process_reengagement_candidate with the cheap gates stubbed
open and every exit recorded; nothing is sent anywhere.
"""
from __future__ import annotations

import datetime as dt

import pytest

UTC = dt.timezone.utc
NOW = dt.datetime.now(UTC)
PERSON = {"id": 880001, "firstName": "Sam", "stage": "Lead", "tags": [], "assignedPondId": 2,
          "emails": [{"value": "sam@example.com"}], "phones": []}


def outbound(days_ago: float) -> dict:
    """A synced send as FUB reports it: the lead is NOT the sender."""
    return {"id": 1, "created": (NOW - dt.timedelta(days=days_ago)).isoformat(),
            "relatedPeople": [{"personId": PERSON["id"], "sentByPerson": False}]}


def inbound(days_ago: float) -> dict:
    return {"id": 2, "created": (NOW - dt.timedelta(days=days_ago)).isoformat(),
            "relatedPeople": [{"personId": PERSON["id"], "sentByPerson": True}]}


@pytest.fixture()
def pond(engine, monkeypatch):
    calls = {"llm_review": 0, "generated": 0, "timeline": []}
    for name, value in {
        "is_excluded": False, "qualifies_for_reengagement": True, "_is_excluded_source": None,
        "_is_soi_silenced": None, "_has_any_deal": False, "_is_lease_listing_silenced": False,
        "was_contacted_recently": False, "_check_incoming_opt_out": None, "get_recent_email_thread": "",
    }.items():
        monkeypatch.setattr(engine, name, lambda *a, _v=value, **k: _v)
    monkeypatch.setattr(engine, "_classify_engagement", lambda p: ("standard", None, "test"))
    monkeypatch.setattr(engine, "safe_get_notes", lambda pid: [])
    monkeypatch.setattr(engine, "customer_nurture_context", lambda p, notes=None: ("San Antonio", "", "test"))
    monkeypatch.setattr(engine.market, "get", lambda city: "")
    monkeypatch.setattr(engine.content, "extract_purchase_window", lambda p, n: None)

    def review(person, notes):
        calls["llm_review"] += 1
        return False, ""

    def generate(*a, **k):
        calls["generated"] += 1
        raise RuntimeError("stop here: generation reached (the backstop let it through)")

    monkeypatch.setattr(engine.content, "should_skip_lead_llm", review)
    monkeypatch.setattr(engine.content, "generate", generate)

    def set_timeline(messages=None, error=None):
        def get_emails(person_id, limit=100):
            calls["timeline"].append((person_id, limit))
            if error:
                raise error
            return list(messages or [])
        monkeypatch.setattr(engine.fub, "get_emails", get_emails)

    return engine, calls, set_timeline


def last_reason(engine) -> str:
    rows = engine.db.recent_audit_rows(["pond_nurture"], NOW - dt.timedelta(days=1))
    return rows[0]["details"] if rows else ""


def test_a_send_four_days_ago_on_the_fub_timeline_holds_a_14_day_lead(pond):
    """The DB has no clock for this lead (as after the lost runs); FUB shows the
    bot's send 4 days ago. Standard tier = 14 days: skipped, before any AI
    review or generation."""
    engine, calls, set_timeline = pond
    set_timeline([outbound(4)])
    assert engine.process_reengagement_candidate(dict(PERSON)) == "skipped"
    assert "[FUB email timeline]" in last_reason(engine) and "14d" in last_reason(engine)
    assert calls["llm_review"] == 0 and calls["generated"] == 0


def test_a_send_twenty_days_ago_does_not_hold_it(pond):
    engine, calls, set_timeline = pond
    set_timeline([outbound(20)])
    with pytest.raises(RuntimeError, match="generation reached"):
        engine.process_reengagement_candidate(dict(PERSON))
    assert calls["generated"] == 1


def test_only_outbound_mail_counts_toward_the_cadence(pond):
    """The lead's own email 5 days ago is not a send; inbound recency is the
    3-day check's job, unchanged here."""
    engine, calls, set_timeline = pond
    set_timeline([inbound(5), outbound(30)])
    with pytest.raises(RuntimeError, match="generation reached"):
        engine.process_reengagement_candidate(dict(PERSON))


def test_the_newest_outbound_wins_whatever_order_fub_returns(pond):
    engine, calls, set_timeline = pond
    set_timeline([outbound(30), inbound(1), outbound(2), outbound(60)])
    assert engine.process_reengagement_candidate(dict(PERSON)) == "skipped"


def test_a_fub_error_leaves_the_existing_gates_exactly_as_they_were(pond):
    engine, calls, set_timeline = pond
    set_timeline(error=RuntimeError("FUB 500"))
    with pytest.raises(RuntimeError, match="generation reached"):
        engine.process_reengagement_candidate(dict(PERSON))


def test_a_saved_db_clock_still_gates_first_with_no_fub_call(pond):
    """When the DB does have the clock, the early DB gate decides and the FUB
    timeline is never fetched — no extra API traffic on healthy days."""
    engine, calls, set_timeline = pond
    set_timeline([outbound(40)])
    engine.db.upsert_reengagement(PERSON["id"], "email", "San Antonio", "hello")
    assert engine.process_reengagement_candidate(dict(PERSON)) == "skipped"
    assert calls["timeline"] == []
    assert "[FUB email timeline]" not in last_reason(engine)


def test_the_cadence_the_backstop_applies_is_the_tiers_own(pond, monkeypatch):
    """Engaged tier is 10 days: a send 11 days ago does not hold it, 9 days does."""
    engine, calls, set_timeline = pond
    monkeypatch.setattr(engine, "_classify_engagement", lambda p: ("engaged", None, "test"))
    set_timeline([outbound(9)])
    assert engine.process_reengagement_candidate(dict(PERSON)) == "skipped"
    assert "10d" in last_reason(engine)
    set_timeline([outbound(11)])
    with pytest.raises(RuntimeError, match="generation reached"):
        engine.process_reengagement_candidate(dict(PERSON))
