"""backfill_ramp_state.py — durations from GitHub's record, clock from Aug 6.

The acceptance test that matters is at the bottom: after the repair, a DB
whose last week was genuinely green ADVANCES on the next maybe_advance — cap
150 → 200 — and one that was not green holds. The repair itself never writes
an advance and never moves a non-NULL clock.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest

from fub_automation import ramp

UTC = dt.timezone.utc

_spec = importlib.util.spec_from_file_location(
    "backfill_ramp_state",
    Path(__file__).resolve().parents[1] / "backfill_ramp_state.py",
)
brs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(brs)  # type: ignore[union-attr]

NOW = dt.datetime.now(UTC)


def _run(run_id, *, started, minutes, conclusion="success", status="completed"):
    return {
        "id": run_id,
        "status": status,
        "conclusion": conclusion,
        "run_started_at": started.isoformat(),
        "updated_at": (started + dt.timedelta(minutes=minutes)).isoformat(),
    }


@pytest.fixture()
def con(m, tmp_path):
    db = m.AuditDB(str(tmp_path / "audit.sqlite3"))
    connection = sqlite3.connect(db.path)
    yield connection
    connection.close()


def test_durations_come_from_successful_completed_runs_only():
    payload = {"workflow_runs": [
        _run(1, started=NOW - dt.timedelta(days=1), minutes=55.0),
        _run(2, started=NOW - dt.timedelta(days=2), minutes=91.0, conclusion="cancelled"),
        _run(3, started=NOW - dt.timedelta(days=3), minutes=10.0, status="in_progress"),
    ]}
    durations = brs.durations_from_runs(payload)
    assert [(round(m), rid) for _, m, rid in durations] == [(55, 1)]


def test_apply_durations_is_idempotent_by_run_id(con):
    durations = brs.durations_from_runs({"workflow_runs": [
        _run(11, started=NOW - dt.timedelta(days=1), minutes=52.0),
        _run(12, started=NOW - dt.timedelta(days=2), minutes=61.5),
    ]})

    assert brs.apply_durations(con, durations, commit=True) == 2
    assert brs.apply_durations(con, durations, commit=True) == 0, "re-run writes nothing"

    rows = con.execute(
        "SELECT details FROM audit_log WHERE action='daily_run_duration'").fetchall()
    assert len(rows) == 2
    minutes = sorted(json.loads(d)["minutes"] for (d,) in rows)
    assert minutes == [52.0, 61.5]


def test_dry_run_writes_nothing(con):
    durations = [(NOW.isoformat(), 50.0, 21)]
    assert brs.apply_durations(con, durations, commit=False) == 1
    assert con.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0] == 0


def test_the_seed_starts_a_null_clock_and_never_moves_a_live_one(con):
    seeded = brs.seed_last_advanced(con, brs.DEFAULT_LAST_ADVANCED, commit=True)
    assert seeded is True
    assert ramp.get_state(con)["last_advanced_at"] == brs.DEFAULT_LAST_ADVANCED

    # A second seed — or a seed after the ramp advanced on its own — is a no-op.
    later = (NOW - dt.timedelta(days=1)).isoformat()
    ramp.save_state(con, step_index=1, last_advanced_at=later,
                    last_evaluated_at=later, holding=False, hold_reason=None)
    assert brs.seed_last_advanced(con, brs.DEFAULT_LAST_ADVANCED, commit=True) is False
    assert ramp.get_state(con)["last_advanced_at"] == later, "a live clock is never touched"


def _green_week(con):
    """A genuinely healthy last-7-days: daily sends, no failures, no opt-outs."""
    for day in range(7):
        when = NOW - dt.timedelta(days=day, hours=2)
        for i in range(150):
            con.execute(
                "INSERT INTO audit_log(created_at, person_id, action, status, details) "
                "VALUES (?, ?, 'pond_nurture', 'sent', '{}')",
                (when.isoformat(), day * 1000 + i),
            )


def test_after_the_repair_a_green_week_advances_to_200(con):
    """THE acceptance test: repair + green week ⇒ the next daily run's
    maybe_advance moves the cap 150 → 200 and restarts the weekly schedule."""
    _green_week(con)
    runs = {"workflow_runs": [
        _run(100 + d, started=NOW - dt.timedelta(days=d, hours=3), minutes=55.0)
        for d in range(7)
    ]}
    brs.apply_durations(con, brs.durations_from_runs(runs), commit=True)
    brs.seed_last_advanced(con, brs.DEFAULT_LAST_ADVANCED, commit=True)

    result = ramp.maybe_advance(con, now=NOW)

    assert result["advanced"] is True
    assert result["cap"] == 200
    assert result["step_index"] == 1
    # And the weekly cadence restarts from this advance, not from Aug 6.
    state = ramp.get_state(con)
    assert state["last_advanced_at"] == NOW.isoformat()


def test_the_repair_alone_cannot_advance_a_red_week(con):
    """No sends recorded ⇒ the guardrails are unknown ⇒ the ramp holds. The
    repair supplies data, never a verdict."""
    runs = {"workflow_runs": [
        _run(200 + d, started=NOW - dt.timedelta(days=d, hours=3), minutes=55.0)
        for d in range(7)
    ]}
    brs.apply_durations(con, brs.durations_from_runs(runs), commit=True)
    brs.seed_last_advanced(con, brs.DEFAULT_LAST_ADVANCED, commit=True)

    result = ramp.maybe_advance(con, now=NOW)

    assert result["advanced"] is False
    assert result["holding"] is True
    assert result["cap"] == 150


def test_a_runtime_near_the_timeout_still_holds_after_the_repair(con):
    """The guardrail the duration rows feed: a 110-minute run inside the
    window must hold the ramp exactly as record_run_duration data would."""
    _green_week(con)
    runs = {"workflow_runs": [
        _run(301, started=NOW - dt.timedelta(days=1, hours=3), minutes=110.0),
    ]}
    brs.apply_durations(con, brs.durations_from_runs(runs), commit=True)
    brs.seed_last_advanced(con, brs.DEFAULT_LAST_ADVANCED, commit=True)

    result = ramp.maybe_advance(con, now=NOW)

    assert result["advanced"] is False
    assert result["holding"] is True
    assert "runtime" in (result["hold_reason"] or "")
