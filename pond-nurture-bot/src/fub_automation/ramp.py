"""
ramp.py — pond volume ramp with automatic guardrails.

Replaces the flat daily cap with a schedule that climbs only while the list
stays healthy, and holds itself the moment it does not.

    step 1: 150   <- start here
    step 2: 200
    step 3: 250
    step 4: 300   <- ceiling; going higher needs a manual config change

One step every RAMP_INTERVAL_DAYS, and only if every guardrail was green for
the whole preceding week. A red week holds the current step and requires a
full green week before advancing again. The ramp never auto-decreases below
step 1 and never advances past the last step.

WHAT THE CAP DOES AND DOES NOT DO
    The cap decides HOW MANY leads get an email today. It has no effect on
    WHICH leads are eligible: opt-out auto-trash, SOI, excluded sources,
    landlord/lease silencing, deal protection (fail-closed), Replied-Paused,
    the 3-day minimum gap and the dedup guard all run per-lead inside
    process_reengagement_candidate, before and independently of any cap
    arithmetic. Raising the cap lets the loop reach further down the same
    filtered list; it cannot let a suppressed lead through.

GUARDRAILS (all computed from audit_log rows the system already writes)

    bounce-ish rate  = (send errors + detected bounces) / sends      > 2.0% -> HOLD
    opt-out rate     = opt-out trashings / sends                     > 1.5% -> HOLD
    runtime headroom = worst daily run duration vs the workflow      -> HOLD
                       timeout

The third one is not cosmetic. The daily workflow allows 120 timeout-minutes,
raised from 90 after a run was KILLED at the old limit on cap 100 (2026-08-05:
cancelled at 91.1 min, mid-pond). Advancing the cap into a timeout does not
send more email — it gets the run killed part-way through, which is strictly
worse than not advancing. So runtime is a first-class guardrail: if last week's
worst run used more than RUNTIME_HOLD_FRACTION of the timeout, the ramp holds
regardless of how clean the list looks.

A guardrail with a zero denominator (a week with no sends) is NOT green — it
is unknown, and unknown must not advance a ramp.
"""
from __future__ import annotations

import datetime as dt
import os
import sqlite3
from typing import List, Optional

# ── Schedule ─────────────────────────────────────────────────────────────────

RAMP_STEPS: List[int] = [150, 200, 250, 300]
RAMP_INTERVAL_DAYS = 7

# ── Guardrail thresholds ─────────────────────────────────────────────────────

BOUNCE_RATE_LIMIT_PCT = 2.0
OPT_OUT_RATE_LIMIT_PCT = 1.5

# Workflow timeout-minutes for daily-automation.yml. If that value changes in
# the workflow, change it here too — this module cannot read it.
WORKFLOW_TIMEOUT_MINUTES = 120
# Hold if the worst run last week used more than this share of the timeout.
# 0.8 leaves ~24 minutes of headroom for a slow FUB or a slow Anthropic day.
RUNTIME_HOLD_FRACTION = 0.8

# Actions whose 'sent' status means an email actually went to a lead.
EMAIL_SEND_ACTIONS = (
    "pond_nurture",
    "closed_drip",
    "long_term_nurture_drip",
    "closed_congrats",
    "instant_welcome_email",
    "seller_nurture",
)
SENT_STATUSES = ("sent", "dry_run_sent")

# Audit action written at the end of each daily run so runtime is measurable
# from the state DB rather than only from GitHub's UI.
RUN_DURATION_ACTION = "daily_run_duration"


# ── State ────────────────────────────────────────────────────────────────────


def ensure_schema(con: sqlite3.Connection) -> None:
    """Create the ramp state table. Safe to call on every run."""
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS volume_ramp_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            step_index INTEGER NOT NULL DEFAULT 0,
            last_advanced_at TEXT,
            last_evaluated_at TEXT,
            holding INTEGER NOT NULL DEFAULT 0,
            hold_reason TEXT
        )
        """
    )
    con.execute(
        "INSERT OR IGNORE INTO volume_ramp_state(id, step_index, holding) VALUES (1, 0, 0)"
    )


def get_state(con: sqlite3.Connection) -> dict:
    """Current ramp state, creating it on first use."""
    ensure_schema(con)
    row = con.execute(
        "SELECT step_index, last_advanced_at, last_evaluated_at, holding, hold_reason "
        "FROM volume_ramp_state WHERE id = 1"
    ).fetchone()
    if row is None:  # pragma: no cover — INSERT OR IGNORE above guarantees a row
        return {"step_index": 0, "last_advanced_at": None, "last_evaluated_at": None,
                "holding": False, "hold_reason": None}
    return {
        "step_index": int(row[0]),
        "last_advanced_at": row[1],
        "last_evaluated_at": row[2],
        "holding": bool(row[3]),
        "hold_reason": row[4],
    }


def save_state(
    con: sqlite3.Connection,
    *,
    step_index: int,
    last_advanced_at: Optional[str],
    last_evaluated_at: Optional[str],
    holding: bool,
    hold_reason: Optional[str],
) -> None:
    ensure_schema(con)
    # Clamp on the way in as well as the way out, so a hand-edited or corrupted
    # row can never produce a cap outside the schedule.
    step_index = max(0, min(int(step_index), len(RAMP_STEPS) - 1))
    con.execute(
        "UPDATE volume_ramp_state SET step_index=?, last_advanced_at=?, "
        "last_evaluated_at=?, holding=?, hold_reason=? WHERE id=1",
        (step_index, last_advanced_at, last_evaluated_at, int(holding), hold_reason),
    )


# ── Guardrail measurement ────────────────────────────────────────────────────


def _count(con: sqlite3.Connection, sql: str, params) -> int:
    row = con.execute(sql, tuple(params)).fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def count_sends(con: sqlite3.Connection, start: dt.datetime, end: dt.datetime) -> int:
    a = ",".join("?" for _ in EMAIL_SEND_ACTIONS)
    s = ",".join("?" for _ in SENT_STATUSES)
    return _count(
        con,
        f"""SELECT COUNT(*) FROM audit_log
            WHERE created_at >= ? AND created_at < ?
              AND action IN ({a}) AND status IN ({s})""",
        (start.isoformat(), end.isoformat(), *EMAIL_SEND_ACTIONS, *SENT_STATUSES),
    )


def count_bounce_ish(con: sqlite3.Connection, start: dt.datetime, end: dt.datetime) -> int:
    """Send failures plus detected bounces — anything that means mail did not land."""
    a = ",".join("?" for _ in EMAIL_SEND_ACTIONS)
    errors = _count(
        con,
        f"""SELECT COUNT(*) FROM audit_log
            WHERE created_at >= ? AND created_at < ?
              AND action IN ({a}) AND status = 'error'""",
        (start.isoformat(), end.isoformat(), *EMAIL_SEND_ACTIONS),
    )
    bounces = _count(
        con,
        """SELECT COUNT(*) FROM audit_log
           WHERE created_at >= ? AND created_at < ?
             AND action = 'bounce_detected'""",
        (start.isoformat(), end.isoformat()),
    )
    return errors + bounces


def count_opt_outs(con: sqlite3.Connection, start: dt.datetime, end: dt.datetime) -> int:
    """Leads trashed for opting out, from either detection path."""
    return _count(
        con,
        """SELECT COUNT(*) FROM audit_log
           WHERE created_at >= ? AND created_at < ?
             AND status IN ('opt_out_trashed', 'trashed')
             AND action IN ('pond_nurture', 'reply_intent_disqualification', 'pond_opt_out_trash')""",
        (start.isoformat(), end.isoformat()),
    )


def worst_runtime_minutes(
    con: sqlite3.Connection, start: dt.datetime, end: dt.datetime
) -> Optional[float]:
    """Longest daily run in the window, or None if nothing recorded.

    Reads the details JSON written by record_run_duration(). None means "no
    data", which is treated as not-green rather than green.
    """
    rows = con.execute(
        """SELECT details FROM audit_log
           WHERE created_at >= ? AND created_at < ? AND action = ?""",
        (start.isoformat(), end.isoformat(), RUN_DURATION_ACTION),
    ).fetchall()
    worst: Optional[float] = None
    import json as _json

    for (details,) in rows:
        try:
            val = float(_json.loads(details or "{}").get("minutes"))
        except Exception:
            continue
        if worst is None or val > worst:
            worst = val
    return worst


def record_run_duration(con: sqlite3.Connection, minutes: float) -> None:
    """Write one run's wall-clock duration into audit_log.

    The runtime guardrail needs history the state DB actually carries; GitHub's
    run list is not reachable from inside the job.
    """
    import json as _json

    con.execute(
        "INSERT INTO audit_log(created_at, person_id, action, status, details) VALUES (?,?,?,?,?)",
        (
            dt.datetime.now(dt.timezone.utc).isoformat(),
            None,
            RUN_DURATION_ACTION,
            "completed",
            _json.dumps({"minutes": round(float(minutes), 2)}),
        ),
    )


def evaluate_guardrails(
    con: sqlite3.Connection, start: dt.datetime, end: dt.datetime
) -> dict:
    """Measure every guardrail over [start, end).

    Returns rates as percentages, plus a green flag and human-readable reasons.
    """
    sends = count_sends(con, start, end)
    bounce_ish = count_bounce_ish(con, start, end)
    opt_outs = count_opt_outs(con, start, end)
    runtime = worst_runtime_minutes(con, start, end)

    bounce_pct = (bounce_ish * 100.0 / sends) if sends else None
    opt_out_pct = (opt_outs * 100.0 / sends) if sends else None
    runtime_limit = WORKFLOW_TIMEOUT_MINUTES * RUNTIME_HOLD_FRACTION

    reasons: List[str] = []
    if sends == 0:
        # Not green: an empty week proves nothing, and a ramp that advances on
        # no evidence is not guarded.
        reasons.append("no sends recorded — cannot confirm a healthy week")
    else:
        if bounce_pct is not None and bounce_pct > BOUNCE_RATE_LIMIT_PCT:
            reasons.append(f"bounce/failure {bounce_pct:.1f}% (limit {BOUNCE_RATE_LIMIT_PCT}%)")
        if opt_out_pct is not None and opt_out_pct > OPT_OUT_RATE_LIMIT_PCT:
            reasons.append(f"opt-out {opt_out_pct:.1f}% (limit {OPT_OUT_RATE_LIMIT_PCT}%)")

    if runtime is None:
        reasons.append("no run-duration data — runtime headroom unknown")
    elif runtime > runtime_limit:
        reasons.append(
            f"runtime {runtime:.0f} min of {WORKFLOW_TIMEOUT_MINUTES} min timeout "
            f"(limit {runtime_limit:.0f} min)"
        )

    return {
        "sends": sends,
        "bounce_ish": bounce_ish,
        "bounce_pct": bounce_pct,
        "opt_outs": opt_outs,
        "opt_out_pct": opt_out_pct,
        "worst_runtime_min": runtime,
        "runtime_limit_min": runtime_limit,
        "green": not reasons,
        "reasons": reasons,
    }


# ── Cap resolution and advancement ───────────────────────────────────────────


def env_cap_override() -> Optional[int]:
    """POND_DAILY_CAP, when set to a positive integer, wins outright.

    A manual override is an instruction, so it bypasses the schedule entirely —
    including the ceiling. It does not move or corrupt the stored ramp step, so
    removing the variable returns to exactly where the ramp was.
    """
    raw = os.environ.get("POND_DAILY_CAP", "").strip()
    if not raw:
        return None
    try:
        val = int(raw)
    except ValueError:
        return None
    return val if val > 0 else None


def cap_for_step(step_index: int) -> int:
    return RAMP_STEPS[max(0, min(int(step_index), len(RAMP_STEPS) - 1))]


def resolve_daily_cap(con: sqlite3.Connection) -> int:
    """Today's cap: the env override if present, else the current ramp step."""
    override = env_cap_override()
    if override is not None:
        return override
    return cap_for_step(get_state(con)["step_index"])


def maybe_advance(
    con: sqlite3.Connection,
    now: Optional[dt.datetime] = None,
) -> dict:
    """Evaluate the last 7 days and advance one step if everything was green.

    Idempotent within an interval: called repeatedly on the same day it
    evaluates and records, but only advances once RAMP_INTERVAL_DAYS have
    passed since the previous advance.
    """
    now = now or dt.datetime.now(dt.timezone.utc)
    ensure_schema(con)
    state = get_state(con)

    window_start = now - dt.timedelta(days=RAMP_INTERVAL_DAYS)
    guardrails = evaluate_guardrails(con, window_start, now)

    step = state["step_index"]
    at_ceiling = step >= len(RAMP_STEPS) - 1

    # Interval gate: first evaluation ever starts the clock rather than
    # advancing immediately off a week that predates the ramp.
    last_advanced = _parse(state["last_advanced_at"])
    if last_advanced is None:
        due = False
        interval_note = "ramp clock started"
    else:
        due = (now - last_advanced) >= dt.timedelta(days=RAMP_INTERVAL_DAYS)
        interval_note = "interval elapsed" if due else "waiting for interval"

    advanced = False
    if guardrails["green"] and due and not at_ceiling:
        step += 1
        advanced = True
        holding = False
        hold_reason = None
    else:
        holding = not guardrails["green"]
        hold_reason = "; ".join(guardrails["reasons"]) or None

    save_state(
        con,
        step_index=step,
        # Start the clock on first evaluation so the first advance is a full
        # interval away, not immediate.
        last_advanced_at=(now.isoformat() if (advanced or last_advanced is None)
                          else state["last_advanced_at"]),
        last_evaluated_at=now.isoformat(),
        holding=holding,
        hold_reason=hold_reason,
    )

    return {
        "advanced": advanced,
        "holding": holding,
        "hold_reason": hold_reason,
        "step_index": step,
        "cap": cap_for_step(step),
        "at_ceiling": step >= len(RAMP_STEPS) - 1,
        "guardrails": guardrails,
        "interval_note": interval_note,
    }


def _parse(value: Optional[str]) -> Optional[dt.datetime]:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed


# ── Rendering ────────────────────────────────────────────────────────────────


def status_line(con: sqlite3.Connection) -> str:
    """One-line status for the daily email footer.

    e.g. "Cap: 150 · Ramp: step 1 of 4 · guardrails green"
    """
    state = get_state(con)
    override = env_cap_override()
    cap = resolve_daily_cap(con)
    step_no = state["step_index"] + 1
    total = len(RAMP_STEPS)

    if override is not None:
        return f"Cap: {cap} (manual override) · Ramp: step {step_no} of {total} · paused by POND_DAILY_CAP"

    if state["holding"] and state["hold_reason"]:
        return f"Cap: {cap} · Ramp: step {step_no} of {total} · ⚠️ HELD — {state['hold_reason']}"
    return f"Cap: {cap} · Ramp: step {step_no} of {total} · guardrails green"


def digest_section_html(con: sqlite3.Connection, guardrails: Optional[dict] = None) -> str:
    """Volume-ramp block for the weekly digest.

    A hold is rendered loudly and near the top of its section — the whole point
    of an automatic hold is that a human notices it happened.
    """
    state = get_state(con)
    cap = resolve_daily_cap(con)
    step_no = state["step_index"] + 1
    total = len(RAMP_STEPS)
    override = env_cap_override()

    def pct(value: Optional[float]) -> str:
        return "—" if value is None else f"{value:.1f}%"

    if state["holding"] and state["hold_reason"]:
        banner = (
            '<p style="background:#fef2f2;border-left:4px solid #ef4444;padding:10px;'
            'margin:8px 0;color:#991b1b;"><strong>⚠️ Volume ramp held</strong> — '
            f"{state['hold_reason']}. The cap stays at {cap}/day until a full "
            "green week.</p>"
        )
    elif override is not None:
        banner = (
            '<p style="background:#eff6ff;border-left:4px solid #3b82f6;padding:10px;'
            'margin:8px 0;color:#1e40af;"><strong>Manual cap override active</strong> — '
            f"POND_DAILY_CAP={cap}. The schedule is paused until it is removed.</p>"
        )
    else:
        banner = (
            '<p style="background:#f0fdf4;border-left:4px solid #22c55e;padding:10px;'
            'margin:8px 0;color:#166534;"><strong>✅ Guardrails green</strong> — '
            f"ramp is clear to advance on schedule.</p>"
        )

    rows = ""
    if guardrails:
        rows = f"""
    <tr><td style="padding:6px;">Emails sent</td><td style="padding:6px;"><strong>{guardrails['sends']}</strong></td><td style="padding:6px;color:#6b7280;">denominator</td></tr>
    <tr><td style="padding:6px;">Bounce / failure rate</td><td style="padding:6px;"><strong>{pct(guardrails['bounce_pct'])}</strong></td><td style="padding:6px;color:#6b7280;">limit {BOUNCE_RATE_LIMIT_PCT}%</td></tr>
    <tr><td style="padding:6px;">Opt-out rate</td><td style="padding:6px;"><strong>{pct(guardrails['opt_out_pct'])}</strong></td><td style="padding:6px;color:#6b7280;">limit {OPT_OUT_RATE_LIMIT_PCT}%</td></tr>
    <tr><td style="padding:6px;">Worst run duration</td><td style="padding:6px;"><strong>{'—' if guardrails['worst_runtime_min'] is None else f"{guardrails['worst_runtime_min']:.0f} min"}</strong></td><td style="padding:6px;color:#6b7280;">limit {guardrails['runtime_limit_min']:.0f} min of {WORKFLOW_TIMEOUT_MINUTES}</td></tr>
"""

    return f"""
    <h2>🚦 Volume Ramp</h2>
    {banner}
    <table style="border-collapse: collapse; width: 100%;">
    <tr><td style="padding:6px;">Daily cap</td><td style="padding:6px;"><strong>{cap}</strong></td><td style="padding:6px;color:#6b7280;">step {step_no} of {total} ({' → '.join(str(s) for s in RAMP_STEPS)})</td></tr>
    {rows}
    </table>
    <p style="color: #6b7280; font-size: 0.85em;">
      The ramp advances one step every {RAMP_INTERVAL_DAYS} days, and only after a
      full week with every guardrail green. It never advances past {RAMP_STEPS[-1]}
      and never lowers itself below {RAMP_STEPS[0]}. The cap changes how many leads
      are emailed — never which ones: every suppression check runs per-lead,
      before the cap is consulted.
    </p>
    """
