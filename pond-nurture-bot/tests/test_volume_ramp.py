"""Behavioural tests for the pond volume ramp (ramp.py).

Drives the real advance/hold logic against a real SQLite state DB.
"""
from __future__ import annotations

import datetime as dt
import json
import sqlite3

import pytest

from fub_automation import ramp
from fub_automation.ramp import (
    RAMP_STEPS,
    cap_for_step,
    ensure_schema,
    evaluate_guardrails,
    get_state,
    maybe_advance,
    record_run_duration,
    resolve_daily_cap,
    status_line,
)

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 8, 20, 12, 0, tzinfo=UTC)


@pytest.fixture()
def con(monkeypatch):
    monkeypatch.delenv("POND_DAILY_CAP", raising=False)
    c = sqlite3.connect(":memory:")
    c.executescript(
        """
        CREATE TABLE audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            person_id INTEGER,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            details TEXT
        );
        """
    )
    ensure_schema(c)
    yield c
    c.close()


def _log(con, when, action, status, person_id=None, details=None):
    con.execute(
        "INSERT INTO audit_log(created_at, person_id, action, status, details) VALUES (?,?,?,?,?)",
        (when.isoformat(), person_id, action, status, json.dumps(details or {})),
    )


def _healthy_week(con, when=None, sends=200, runtime_min=40.0):
    """A week that passes every guardrail."""
    when = when or (NOW - dt.timedelta(days=3))
    for i in range(sends):
        _log(con, when, "pond_nurture", "sent", person_id=i)
    record_run_duration_at(con, when, runtime_min)


def record_run_duration_at(con, when, minutes):
    _log(con, when, ramp.RUN_DURATION_ACTION, "completed", details={"minutes": minutes})


def _start_clock(con, days_ago=8):
    """Put the ramp past its interval so advancement is due."""
    st = get_state(con)
    ramp.save_state(
        con,
        step_index=st["step_index"],
        last_advanced_at=(NOW - dt.timedelta(days=days_ago)).isoformat(),
        last_evaluated_at=None,
        holding=False,
        hold_reason=None,
    )


# ── Cap resolution ───────────────────────────────────────────────────────────


def test_starts_at_150(con):
    assert resolve_daily_cap(con) == 150
    assert RAMP_STEPS == [150, 200, 250, 300]


def test_env_override_wins_and_does_not_disturb_ramp_state(con, monkeypatch):
    monkeypatch.setenv("POND_DAILY_CAP", "75")
    assert resolve_daily_cap(con) == 75
    assert get_state(con)["step_index"] == 0, "override must not move the stored step"
    monkeypatch.delenv("POND_DAILY_CAP")
    assert resolve_daily_cap(con) == 150, "removing the override returns to the ramp"


def test_env_override_ignores_junk_and_non_positive_values(con, monkeypatch):
    for bad in ("", "abc", "0", "-5"):
        monkeypatch.setenv("POND_DAILY_CAP", bad)
        assert resolve_daily_cap(con) == 150, f"{bad!r} must not be honoured"


# ── Advancement ──────────────────────────────────────────────────────────────


def test_advances_one_step_on_a_green_week(con):
    _healthy_week(con)
    _start_clock(con)
    r = maybe_advance(con, now=NOW)
    assert r["advanced"] is True
    assert r["cap"] == 200
    assert r["guardrails"]["green"] is True


def test_first_evaluation_starts_the_clock_instead_of_advancing(con):
    """A fresh ramp must not jump on a week that predates it."""
    _healthy_week(con)
    r = maybe_advance(con, now=NOW)
    assert r["advanced"] is False
    assert r["cap"] == 150
    assert get_state(con)["last_advanced_at"] is not None


def test_does_not_advance_before_the_interval_elapses(con):
    _healthy_week(con)
    _start_clock(con, days_ago=3)
    r = maybe_advance(con, now=NOW)
    assert r["advanced"] is False
    assert r["cap"] == 150


def test_holds_on_high_opt_out_rate(con):
    """200 sends, 4 opt-outs = 2.0% > 1.5% limit."""
    _healthy_week(con)
    for i in range(4):
        _log(con, NOW - dt.timedelta(days=3), "pond_nurture", "opt_out_trashed", person_id=900 + i)
    _start_clock(con)
    r = maybe_advance(con, now=NOW)
    assert r["advanced"] is False
    assert r["holding"] is True
    assert "opt-out 2.0%" in r["hold_reason"]
    assert r["cap"] == 150


def test_holds_on_high_bounce_rate(con):
    """200 sends, 5 failures = 2.5% > 2.0% limit."""
    _healthy_week(con)
    for i in range(3):
        _log(con, NOW - dt.timedelta(days=3), "pond_nurture", "error", person_id=800 + i)
    for i in range(2):
        _log(con, NOW - dt.timedelta(days=3), "bounce_detected", "detected", person_id=850 + i)
    _start_clock(con)
    r = maybe_advance(con, now=NOW)
    assert r["advanced"] is False
    assert "bounce/failure 2.5%" in r["hold_reason"]


def test_holds_when_runtime_is_near_the_workflow_timeout(con):
    """The guardrail that stops the ramp walking into a killed run."""
    _healthy_week(con, runtime_min=85.0)  # limit is 0.8 * 90 = 72
    _start_clock(con)
    r = maybe_advance(con, now=NOW)
    assert r["advanced"] is False
    assert "runtime 85 min" in r["hold_reason"]


def test_a_week_with_no_sends_is_unknown_not_green(con):
    """Zero denominator proves nothing and must not advance the ramp."""
    record_run_duration_at(con, NOW - dt.timedelta(days=3), 40.0)
    _start_clock(con)
    r = maybe_advance(con, now=NOW)
    assert r["advanced"] is False
    assert "no sends recorded" in r["hold_reason"]


def test_missing_runtime_data_is_unknown_not_green(con):
    _healthy_week(con)
    con.execute("DELETE FROM audit_log WHERE action = ?", (ramp.RUN_DURATION_ACTION,))
    _start_clock(con)
    r = maybe_advance(con, now=NOW)
    assert r["advanced"] is False
    assert "runtime headroom unknown" in r["hold_reason"]


def test_rates_exactly_on_the_limit_do_not_hold(con):
    """'>2%' is strictly greater — 2.0% itself is still green."""
    _healthy_week(con, sends=200)
    for i in range(4):  # 4/200 = 2.0% bounce-ish, exactly the limit
        _log(con, NOW - dt.timedelta(days=3), "pond_nurture", "error", person_id=700 + i)
    _start_clock(con)
    r = maybe_advance(con, now=NOW)
    assert r["advanced"] is True, "a rate exactly at the limit is not over it"


# ── Recovery and ceiling ─────────────────────────────────────────────────────


def test_resumes_after_a_recovery_week(con):
    """Red week holds; the following green week advances again."""
    _healthy_week(con)
    for i in range(10):
        _log(con, NOW - dt.timedelta(days=3), "pond_nurture", "opt_out_trashed", person_id=600 + i)
    _start_clock(con)
    held = maybe_advance(con, now=NOW)
    assert held["advanced"] is False and held["holding"] is True

    # A clean week follows: new window, only healthy rows.
    later = NOW + dt.timedelta(days=8)
    con.execute("DELETE FROM audit_log")
    _healthy_week(con, when=later - dt.timedelta(days=2))
    recovered = maybe_advance(con, now=later)
    assert recovered["advanced"] is True
    assert recovered["holding"] is False
    assert recovered["hold_reason"] is None
    assert recovered["cap"] == 200


def test_never_advances_past_300(con):
    """Walk the whole schedule and then keep pushing."""
    now = NOW
    caps = []
    for _ in range(10):
        con.execute("DELETE FROM audit_log")
        _healthy_week(con, when=now - dt.timedelta(days=2))
        st = get_state(con)
        ramp.save_state(
            con,
            step_index=st["step_index"],
            last_advanced_at=(now - dt.timedelta(days=8)).isoformat(),
            last_evaluated_at=None,
            holding=False,
            hold_reason=None,
        )
        r = maybe_advance(con, now=now)
        caps.append(r["cap"])
        now += dt.timedelta(days=8)

    assert max(caps) == 300
    assert caps[-1] == 300
    assert get_state(con)["step_index"] == len(RAMP_STEPS) - 1


def test_never_auto_decreases_below_150(con):
    """Even a catastrophic week only holds — it never walks the ramp back."""
    _healthy_week(con)
    for i in range(150):  # a wildly red week
        _log(con, NOW - dt.timedelta(days=3), "pond_nurture", "opt_out_trashed", person_id=i)
    _start_clock(con)
    r = maybe_advance(con, now=NOW)
    assert r["cap"] == 150
    assert get_state(con)["step_index"] == 0

    # And from a higher step it holds where it is rather than dropping.
    ramp.save_state(con, step_index=2, last_advanced_at=(NOW - dt.timedelta(days=8)).isoformat(),
                    last_evaluated_at=None, holding=False, hold_reason=None)
    r2 = maybe_advance(con, now=NOW)
    assert r2["cap"] == 250, "a red week holds the current step, it does not decrease"


def test_cap_for_step_clamps_out_of_range_indices(con):
    assert cap_for_step(-5) == 150
    assert cap_for_step(99) == 300


def test_corrupt_step_index_cannot_produce_an_out_of_schedule_cap(con):
    con.execute("UPDATE volume_ramp_state SET step_index = 87 WHERE id = 1")
    assert resolve_daily_cap(con) in RAMP_STEPS


# ── Persistence ──────────────────────────────────────────────────────────────


def test_state_survives_a_reconnect(tmp_path):
    """The ramp step must outlive the process — runs are separate invocations."""
    path = tmp_path / "state.sqlite3"

    c1 = sqlite3.connect(str(path))
    c1.executescript(
        "CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, "
        "person_id INTEGER, action TEXT, status TEXT, details TEXT);"
    )
    ensure_schema(c1)
    _healthy_week(c1)
    ramp.save_state(c1, step_index=0, last_advanced_at=(NOW - dt.timedelta(days=8)).isoformat(),
                    last_evaluated_at=None, holding=False, hold_reason=None)
    r = maybe_advance(c1, now=NOW)
    assert r["cap"] == 200
    c1.commit()
    c1.close()

    c2 = sqlite3.connect(str(path))
    assert resolve_daily_cap(c2) == 200, "ramp step did not survive the reconnect"
    assert get_state(c2)["step_index"] == 1
    c2.close()


def test_ensure_schema_is_idempotent(con):
    for _ in range(3):
        ensure_schema(con)
    rows = con.execute("SELECT COUNT(*) FROM volume_ramp_state").fetchone()[0]
    assert rows == 1


# ── Status rendering ─────────────────────────────────────────────────────────


def test_status_line_matches_the_requested_footer_format(con):
    line = status_line(con)
    assert line == "Cap: 150 · Ramp: step 1 of 4 · guardrails green"


def test_status_line_shows_the_hold_reason(con):
    _healthy_week(con)
    for i in range(10):
        _log(con, NOW - dt.timedelta(days=3), "pond_nurture", "opt_out_trashed", person_id=i)
    _start_clock(con)
    maybe_advance(con, now=NOW)
    line = status_line(con)
    assert "HELD" in line and "opt-out" in line


def test_status_line_flags_a_manual_override(con, monkeypatch):
    monkeypatch.setenv("POND_DAILY_CAP", "42")
    assert "manual override" in status_line(con)


def test_digest_section_renders_hold_banner_prominently(con):
    _healthy_week(con)
    for i in range(10):
        _log(con, NOW - dt.timedelta(days=3), "pond_nurture", "opt_out_trashed", person_id=i)
    _start_clock(con)
    maybe_advance(con, now=NOW)
    g = evaluate_guardrails(con, NOW - dt.timedelta(days=7), NOW)
    html = ramp.digest_section_html(con, g)
    assert "Volume ramp held" in html
    assert "opt-out" in html


def test_guardrail_percentages_are_computed_from_real_counts(con):
    _healthy_week(con, sends=100)
    for i in range(3):
        _log(con, NOW - dt.timedelta(days=3), "pond_nurture", "opt_out_trashed", person_id=500 + i)
    g = evaluate_guardrails(con, NOW - dt.timedelta(days=7), NOW)
    assert g["sends"] == 100
    assert g["opt_outs"] == 3
    assert g["opt_out_pct"] == pytest.approx(3.0)
    assert g["green"] is False
