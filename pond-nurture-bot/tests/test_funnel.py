"""Behavioural tests for the funnel counters (funnel.py).

Seeds a real SQLite database with audit_log / engagement_tier rows spanning the
stages, then asserts the counts and rates that land in Peter's digest.

These are behavioural, not structural: every test drives the real query
functions against a real database rather than asserting on source text, so a
query that silently stops matching fails here.
"""
from __future__ import annotations

import datetime as dt
import sqlite3

import pytest

from fub_automation.funnel import (
    STAGES,
    format_funnel_html,
    format_funnel_text,
    new_warm_today,
    query_funnel,
    rate,
)

UTC = dt.timezone.utc

# Week 2 is "this week", week 1 is "last week".
WEEK2_START = dt.datetime(2026, 7, 27, tzinfo=UTC)
WEEK2_END = dt.datetime(2026, 8, 3, tzinfo=UTC)
WEEK1_START = dt.datetime(2026, 7, 20, tzinfo=UTC)
WEEK1_END = WEEK2_START


def _mk_db() -> sqlite3.Connection:
    """A database with just the two tables the funnel reads."""
    con = sqlite3.connect(":memory:")
    con.executescript(
        """
        CREATE TABLE audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            person_id INTEGER,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            details TEXT
        );
        CREATE TABLE engagement_tier (
            person_id INTEGER PRIMARY KEY,
            tier TEXT NOT NULL DEFAULT 'standard',
            last_classified_at TEXT NOT NULL,
            reason TEXT
        );
        """
    )
    return con


def _log(con, when: dt.datetime, person_id, action: str, status: str) -> None:
    con.execute(
        "INSERT INTO audit_log(created_at, person_id, action, status, details) VALUES (?,?,?,?,?)",
        (when.isoformat(), person_id, action, status, "{}"),
    )


def _tier(con, person_id: int, when: dt.datetime, tier: str = "engaged") -> None:
    con.execute(
        "INSERT OR REPLACE INTO engagement_tier(person_id, tier, last_classified_at, reason) VALUES (?,?,?,?)",
        (person_id, tier, when.isoformat(), "test"),
    )


def _mid(start: dt.datetime, days: float = 2) -> dt.datetime:
    return start + dt.timedelta(days=days)


@pytest.fixture()
def con():
    c = _mk_db()
    yield c
    c.close()


# ── Stage counting ───────────────────────────────────────────────────────────


def test_each_stage_counts_its_own_signal(con):
    """One lead per stage, each with the signal that defines that stage."""
    t = _mid(WEEK2_START)
    _log(con, t, 1, "new_lead_timer", "started")                    # COLD
    _log(con, t, 2, "pond_nurture", "sent")                         # CONTACTED
    _tier(con, 3, t)                                                # ENGAGED
    _log(con, t, 4, "reply_detected", "logged")                     # WARM
    _log(con, t, 5, "reply_detected", "alert_sent")                 # WARM + HANDED OFF

    counts = query_funnel(con, WEEK2_START, WEEK2_END)["counts"]
    assert counts["cold"] == 1
    assert counts["contacted"] == 1
    assert counts["engaged"] == 1
    # leads 4 and 5 both replied; 5 also triggered the alert
    assert counts["warm"] == 2
    assert counts["handed_off"] == 1


def test_cold_counts_both_entry_doors(con):
    t = _mid(WEEK2_START)
    _log(con, t, 1, "new_lead_timer", "started")
    _log(con, t, 2, "new_lead_timer", "started_polling")
    _log(con, t, 3, "stale_agent_pond_reassignment", "completed")
    # not an entry — a suppressed reassignment never entered anything
    _log(con, t, 4, "stale_agent_pond_reassignment", "suppressed")

    assert query_funnel(con, WEEK2_START, WEEK2_END)["counts"]["cold"] == 3


def test_contacted_counts_email_sends_only(con):
    """'completed' is a reassignment and 'sms_sent' is not email."""
    t = _mid(WEEK2_START)
    _log(con, t, 1, "pond_nurture", "sent")
    _log(con, t, 2, "closed_drip", "sent")
    _log(con, t, 3, "long_term_nurture_drip", "dry_run_sent")
    _log(con, t, 4, "pond_nurture", "sms_sent")                     # SMS, not email
    _log(con, t, 5, "stale_agent_pond_reassignment", "completed")   # reassignment
    _log(con, t, 6, "pond_nurture", "suppressed")                   # never sent
    _log(con, t, 7, "pond_nurture", "skipped")

    assert query_funnel(con, WEEK2_START, WEEK2_END)["counts"]["contacted"] == 3


def test_warm_excludes_replies_that_were_opt_outs(con):
    """An unsubscribe is a reply. Counting it warm would flatter a bad week."""
    t = _mid(WEEK2_START)
    _log(con, t, 1, "reply_detected", "logged")                        # genuinely warm
    _log(con, t, 2, "reply_detected", "logged")                        # replied...
    _log(con, t, 2, "reply_intent_disqualification", "opt_out_trashed")  # ...to leave

    counts = query_funnel(con, WEEK2_START, WEEK2_END)["counts"]
    assert counts["warm"] == 1, "opt-out reply must not count as warm"


def test_handed_off_counts_alerts_and_keyword_reassignments(con):
    t = _mid(WEEK2_START)
    _log(con, t, 1, "reply_detected", "alert_sent")
    _log(con, t, 2, "pond_keyword_reassignment", "completed")
    _log(con, t, 3, "reply_detected", "error")            # alert failed — not handed off
    _log(con, t, 4, "pond_keyword_reassignment", "error")

    assert query_funnel(con, WEEK2_START, WEEK2_END)["counts"]["handed_off"] == 2


def test_run_level_rows_with_null_person_never_inflate_counts(con):
    """Cap notices and summaries carry no person_id and are not leads."""
    t = _mid(WEEK2_START)
    _log(con, t, None, "pond_nurture", "sent")
    _log(con, t, None, "reply_detected", "alert_sent")
    _log(con, t, 42, "pond_nurture", "sent")

    counts = query_funnel(con, WEEK2_START, WEEK2_END)["counts"]
    assert counts["contacted"] == 1
    assert counts["handed_off"] == 0


# ── No double counting ───────────────────────────────────────────────────────


def test_lead_counted_warm_once_despite_many_replies_in_the_week(con):
    """Three replies from one lead in one week is one warm lead."""
    for day in (1, 3, 5):
        _log(con, _mid(WEEK2_START, day), 77, "reply_detected", "logged")

    assert query_funnel(con, WEEK2_START, WEEK2_END)["counts"]["warm"] == 1


def test_lead_warm_last_week_is_not_counted_again_this_week(con):
    """The no-double-counting-across-weeks guarantee."""
    _log(con, _mid(WEEK1_START), 77, "reply_detected", "logged")

    last_week = query_funnel(con, WEEK1_START, WEEK1_END)["counts"]
    this_week = query_funnel(con, WEEK2_START, WEEK2_END)["counts"]

    assert last_week["warm"] == 1
    assert this_week["warm"] == 0, "a lead that went warm last week is not warm again this week"


def test_windows_are_half_open_so_consecutive_weeks_tile_exactly(con):
    """An event exactly on the boundary belongs to the later week only."""
    _log(con, WEEK2_START, 88, "reply_detected", "logged")

    assert query_funnel(con, WEEK1_START, WEEK1_END)["counts"]["warm"] == 0
    assert query_funnel(con, WEEK2_START, WEEK2_END)["counts"]["warm"] == 1


def test_same_lead_can_be_warm_in_two_different_weeks(con):
    """Counted once per week, but genuinely re-engaging twice is two data points."""
    _log(con, _mid(WEEK1_START), 99, "reply_detected", "logged")
    _log(con, _mid(WEEK2_START), 99, "reply_detected", "logged")

    assert query_funnel(con, WEEK1_START, WEEK1_END)["counts"]["warm"] == 1
    assert query_funnel(con, WEEK2_START, WEEK2_END)["counts"]["warm"] == 1


def test_contacted_counted_once_despite_multiple_emails(con):
    for day in (1, 2, 4):
        _log(con, _mid(WEEK2_START, day), 55, "pond_nurture", "sent")

    assert query_funnel(con, WEEK2_START, WEEK2_END)["counts"]["contacted"] == 1


# ── Rates ────────────────────────────────────────────────────────────────────


def test_conversion_rates_compute_from_the_counts(con):
    """4 contacted, 1 warm -> 25%. 2 cold, 4 contacted -> 200% is legal (see caveat 3)."""
    t = _mid(WEEK2_START)
    for pid in (1, 2, 3, 4):
        _log(con, t, pid, "pond_nurture", "sent")
    _log(con, t, 1, "reply_detected", "alert_sent")
    _log(con, t, 10, "new_lead_timer", "started")
    _log(con, t, 11, "new_lead_timer", "started")

    result = query_funnel(con, WEEK2_START, WEEK2_END)
    assert result["counts"] == {
        "cold": 2, "contacted": 4, "engaged": 0, "warm": 1, "handed_off": 1,
    }
    assert result["rates"]["contacted_to_warm"] == 25.0
    assert result["rates"]["cold_to_contacted"] == 200.0
    assert result["rates"]["warm_to_handed_off"] == 100.0


def test_rate_is_none_not_zero_when_nothing_was_contacted(con):
    """'Nobody was emailed' must not render the same as 'nobody replied'."""
    result = query_funnel(con, WEEK2_START, WEEK2_END)
    assert result["rates"]["contacted_to_warm"] is None
    assert result["counts"]["contacted"] == 0


def test_rate_helper_rounds_to_one_decimal():
    assert rate(1, 3) == 33.3
    assert rate(2, 3) == 66.7
    assert rate(0, 5) == 0.0
    assert rate(5, 0) is None
    assert rate(0, 0) is None


# ── Daily one-liner ──────────────────────────────────────────────────────────


def test_new_warm_today_uses_the_same_definition_as_the_weekly_warm_stage(con):
    day_start = dt.datetime(2026, 7, 29, tzinfo=UTC)
    day_end = day_start + dt.timedelta(days=1)

    _log(con, day_start + dt.timedelta(hours=2), 1, "reply_detected", "logged")
    _log(con, day_start + dt.timedelta(hours=3), 2, "reply_detected", "logged")
    _log(con, day_start + dt.timedelta(hours=4), 2, "reply_intent_disqualification", "trashed")
    _log(con, day_start - dt.timedelta(hours=5), 3, "reply_detected", "logged")  # yesterday

    assert new_warm_today(con, day_start, day_end) == 1


def test_new_warm_today_is_zero_on_a_quiet_day(con):
    day_start = dt.datetime(2026, 7, 29, tzinfo=UTC)
    assert new_warm_today(con, day_start, day_start + dt.timedelta(days=1)) == 0


# ── Rendering ────────────────────────────────────────────────────────────────


def test_text_render_shows_every_stage_and_the_headline_rate(con):
    t = _mid(WEEK2_START)
    for pid in (1, 2):
        _log(con, t, pid, "pond_nurture", "sent")
    _log(con, t, 1, "reply_detected", "logged")

    this_week = query_funnel(con, WEEK2_START, WEEK2_END)
    last_week = query_funnel(con, WEEK1_START, WEEK1_END)
    out = format_funnel_text(this_week, last_week)

    assert "📈 FUNNEL — THIS WEEK" in out
    for stage in STAGES:
        assert stage.replace("_", " ").split()[0].upper() in out.upper()
    assert "50.0%" in out  # 1 warm of 2 contacted


def test_html_render_marks_deltas_and_survives_an_empty_previous_week(con):
    t = _mid(WEEK2_START)
    _log(con, t, 1, "pond_nurture", "sent")
    _log(con, t, 1, "reply_detected", "logged")

    this_week = query_funnel(con, WEEK2_START, WEEK2_END)
    html = format_funnel_html(this_week, {})  # no prior week at all

    assert "FUNNEL — THIS WEEK" in html
    assert "Contacted → Warm (headline)" in html
    assert "▲ +1" in html  # contacted went 0 -> 1
    assert "<table" in html


def test_html_render_shows_an_em_dash_for_an_undefined_rate(con):
    """A week with no sends shows '—', never '0%'."""
    html = format_funnel_html(query_funnel(con, WEEK2_START, WEEK2_END), {})
    assert "—" in html


# ── Read-only guarantee ──────────────────────────────────────────────────────


def test_funnel_queries_never_write(con):
    """Instrumentation must not mutate the audit trail it reports on."""
    t = _mid(WEEK2_START)
    _log(con, t, 1, "pond_nurture", "sent")
    _log(con, t, 1, "reply_detected", "alert_sent")
    _tier(con, 1, t)
    con.commit()

    before_audit = con.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
    before_tier = con.execute("SELECT COUNT(*) FROM engagement_tier").fetchone()[0]

    query_funnel(con, WEEK2_START, WEEK2_END)
    new_warm_today(con, WEEK2_START, WEEK2_END)

    assert con.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0] == before_audit
    assert con.execute("SELECT COUNT(*) FROM engagement_tier").fetchone()[0] == before_tier


def test_engaged_reads_the_tier_table_within_the_window(con):
    _tier(con, 1, _mid(WEEK2_START), "engaged")
    _tier(con, 2, _mid(WEEK2_START), "cold")      # wrong tier
    _tier(con, 3, _mid(WEEK1_START), "engaged")   # right tier, last week

    assert query_funnel(con, WEEK2_START, WEEK2_END)["counts"]["engaged"] == 1


# ── Daily summary wiring (behavioural, drives the real method) ───────────────


def test_daily_summary_email_carries_the_funnel_one_liner(engine, monkeypatch):
    """The daily update must surface today's warm count in both bodies.

    Drives the real send_phase2_daily_summary() and captures what it hands to
    the mail layer, so a broken import or a renamed variable fails here rather
    than silently dropping the line from Peter's inbox.
    """
    engine.rules.phase2_daily_summary_enabled = True
    engine.rules.customer_reengagement_emails_enabled = True

    # Something for the summary to report on at all...
    engine.db.log("pond_nurture", "sent", person_id=101)
    # ...one genuine warm lead...
    engine.db.log("reply_detected", "logged", person_id=202)
    # ...and one that replied only to opt out, which must NOT count.
    engine.db.log("reply_detected", "logged", person_id=303)
    engine.db.log("reply_intent_disqualification", "opt_out_trashed", person_id=303)

    captured = {}

    def _capture(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(engine.email, "send", lambda *a, **k: _capture(**k))

    engine.send_phase2_daily_summary()

    assert captured, "daily summary did not send"
    body = captured.get("body") or ""
    html = captured.get("html_body") or ""

    assert "📈 FUNNEL" in body
    assert "1 new WARM lead(s) today" in body, f"expected exactly 1 warm, got: {body[:400]}"
    assert "📈 FUNNEL" in html
    assert "1 new WARM lead(s) today" in html


def test_daily_summary_still_sends_when_the_funnel_query_fails(engine, monkeypatch):
    """Instrumentation must never cost Peter the summary itself."""
    engine.rules.phase2_daily_summary_enabled = True
    engine.rules.customer_reengagement_emails_enabled = True
    engine.db.log("pond_nurture", "sent", person_id=101)

    import fub_automation.funnel as funnel_mod

    def _boom(*a, **k):
        raise sqlite3.OperationalError("no such table: audit_log")

    monkeypatch.setattr(funnel_mod, "new_warm_today", _boom)

    captured = {}
    monkeypatch.setattr(engine.email, "send", lambda *a, **k: captured.update(k))

    engine.send_phase2_daily_summary()

    assert captured, "a failing funnel query must not suppress the daily summary"
    # Degrades to zero rather than vanishing, so the line stays stable in the email.
    assert "0 new WARM lead(s) today" in (captured.get("body") or "")
