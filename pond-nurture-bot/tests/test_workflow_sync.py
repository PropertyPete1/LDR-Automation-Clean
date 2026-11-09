"""Values that live in two files and must agree.

ramp.py's runtime guardrail holds the daily cap whenever a run creeps toward
the workflow's kill line — but it can only see its own constant, not GitHub's.
If daily-automation.yml's timeout-minutes moves and WORKFLOW_TIMEOUT_MINUTES
does not, the guardrail measures against the wrong ceiling: too low and the
ramp holds forever, too high and the workflow kills runs the ramp thought were
safe. Nothing else ties them together — this test is the seam.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # pond-nurture-bot/
DAILY_YML = ROOT.parent / ".github" / "workflows" / "daily-automation.yml"


def test_ramp_timeout_matches_the_daily_workflow():
    from fub_automation import ramp

    yml = DAILY_YML.read_text()
    found = re.findall(r"timeout-minutes:\s*(\d+)", yml)
    assert len(found) == 1, (
        f"expected exactly one timeout-minutes in daily-automation.yml, found {found} — "
        "if a second job was added, point this test at the automation job's value")
    assert int(found[0]) == ramp.WORKFLOW_TIMEOUT_MINUTES, (
        f"daily-automation.yml timeout-minutes={found[0]} but "
        f"ramp.WORKFLOW_TIMEOUT_MINUTES={ramp.WORKFLOW_TIMEOUT_MINUTES} — "
        "change them together (the ramp's runtime guardrail measures against this)")


def test_the_longer_timeout_does_not_move_the_ramps_runtime_hold_line():
    """2026-11-09: the daily timeout went 120 -> 240 so killed runs can finish
    their reply scans, summary and state push. The ramp's runtime hold line must
    stay at the old 96 minutes (0.8 x 120), or the longer timeout would quietly
    let the cap advance on runs up to 192 minutes long."""
    from fub_automation import ramp

    assert ramp.WORKFLOW_TIMEOUT_MINUTES == 240
    assert ramp.RUNTIME_HOLD_MINUTES == 96.0


def test_a_150_minute_week_holds_the_ramp_under_the_240_minute_timeout(tmp_path):
    """A week whose worst run took 150 minutes fits the new timeout but is still
    over the hold line, so the guardrails are not green."""
    import datetime as dt
    import json
    import sqlite3

    from fub_automation import ramp

    con = sqlite3.connect(tmp_path / "a.sqlite3")
    con.execute("CREATE TABLE audit_log (id INTEGER PRIMARY KEY, created_at TEXT, person_id INTEGER, "
                "action TEXT, status TEXT, details TEXT)")
    start = dt.datetime(2026, 11, 2, tzinfo=dt.timezone.utc)
    end = start + dt.timedelta(days=7)
    for n in range(200):
        con.execute("INSERT INTO audit_log(created_at, person_id, action, status, details) VALUES (?,?,?,?,?)",
                    ((start + dt.timedelta(hours=1, minutes=n)).isoformat(), n, "pond_nurture", "sent", "{}"))
    ramp.record_run_duration(con, 150.0)
    con.execute("UPDATE audit_log SET created_at=? WHERE action=?",
                ((start + dt.timedelta(days=1)).isoformat(), ramp.RUN_DURATION_ACTION))
    con.commit()
    g = ramp.evaluate_guardrails(con, start, end)
    assert not g["green"], g
    assert any("hold line 96 min" in r for r in g["reasons"]), g["reasons"]
