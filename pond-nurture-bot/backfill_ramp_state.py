#!/usr/bin/env python3
"""One-shot repair: give the volume ramp the state and data it was starved of.

WHAT HAPPENED

run_approved_daily_automation.py imported the ramp with a bare package name
that never resolved (fixed alongside this script), so from the day the ramp
shipped, maybe_advance() and record_run_duration() never executed once. Two
holes follow, and fixing the import alone closes neither:

1. volume_ramp_state.last_advanced_at is NULL. maybe_advance treats the first
   evaluation as "start the clock" — correct for a fresh ramp, but this ramp
   is not fresh: it has been live at step 1 (cap 150) since 2026-08-06, and
   starting the clock now would cost ANOTHER week at 150 on top of the 18 days
   already lost.

2. audit_log has no daily_run_duration rows, and the runtime guardrail treats
   "no data" as not-green (correctly). With no rows, the first evaluation
   holds no matter how healthy the list is.

WHAT THIS DOES

- Backfills daily_run_duration rows from GitHub's own record of the daily
  workflow's runs (the Actions API), stamped at each run's real end time.
  This is measured data, not invention — the same wall clock the in-run
  recorder would have captured had it ever run.
- Seeds last_advanced_at with the moment the ramp actually went live at step 1
  (the 2026-08-06 daily run) — ONLY if it is NULL, so a ramp that has since
  advanced on its own is never touched.
- Prints what the next daily run's evaluation will decide, without saving it:
  the advance itself stays maybe_advance()'s call, made inside the daily run
  with all guardrails measured. If last week was genuinely green, the next
  run advances 150 → 200 and the weekly 200 → 250 → 300 schedule resumes.

SAFETY

- Dry run unless --commit.
- Idempotent: duration rows carry their run_id and are never written twice,
  and the seed never overwrites a non-NULL last_advanced_at (there is
  deliberately no force flag — a live ramp clock is the ramp's own business).
- This script never moves step_index and never writes an advance.

USAGE (in the workflow; GITHUB_TOKEN needs actions:read)

    python3 backfill_ramp_state.py
    python3 backfill_ramp_state.py --commit
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

UTC = dt.timezone.utc

#: The Daily Automation run of 2026-08-06 14:11 UTC — the first at cap 150,
#: i.e. the moment step 1 went live. Seeding the clock here makes the interval
#: already elapsed, which is the truth: step 1 has had far more than its week.
DEFAULT_LAST_ADVANCED = "2026-08-06T14:11:25+00:00"

WORKFLOW_FILE = "daily-automation.yml"


def _parse_iso(value: str) -> Optional[dt.datetime]:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def durations_from_runs(payload: dict) -> List[Tuple[str, float, int]]:
    """(end_iso, minutes, run_id) for each successful completed run.

    run_started_at (not created_at): queue time is not runtime, and the
    guardrail is about how long the work takes.
    """
    out: List[Tuple[str, float, int]] = []
    for run in payload.get("workflow_runs", []):
        if run.get("status") != "completed" or run.get("conclusion") != "success":
            continue
        started = _parse_iso(str(run.get("run_started_at") or ""))
        ended = _parse_iso(str(run.get("updated_at") or ""))
        if not started or not ended or ended <= started:
            continue
        minutes = (ended - started).total_seconds() / 60.0
        out.append((ended.isoformat(), round(minutes, 2), int(run["id"])))
    return out


def fetch_recent_daily_runs(days: int) -> dict:
    """The Actions API's record of the daily workflow's recent runs."""
    import requests

    repo = os.environ.get("GITHUB_REPOSITORY")
    token = os.environ.get("GITHUB_TOKEN")
    if not repo or not token:
        raise RuntimeError("GITHUB_REPOSITORY and GITHUB_TOKEN are required to "
                           "read run durations (token needs actions:read)")
    since = (dt.datetime.now(UTC) - dt.timedelta(days=days)).strftime("%Y-%m-%d")
    resp = requests.get(
        f"https://api.github.com/repos/{repo}/actions/workflows/{WORKFLOW_FILE}/runs",
        params={"created": f">={since}", "per_page": 50},
        headers={"Authorization": f"Bearer {token}",
                 "Accept": "application/vnd.github+json"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def existing_duration_run_ids(con) -> set:
    from fub_automation.ramp import RUN_DURATION_ACTION

    ids = set()
    for (details,) in con.execute(
            "SELECT details FROM audit_log WHERE action = ?", (RUN_DURATION_ACTION,)):
        try:
            run_id = json.loads(details or "{}").get("run_id")
        except Exception:  # noqa: BLE001
            run_id = None
        if run_id is not None:
            ids.add(int(run_id))
    return ids


def apply_durations(con, durations: List[Tuple[str, float, int]], *, commit: bool) -> int:
    """Insert one daily_run_duration row per run, keyed on run_id. Idempotent."""
    from fub_automation.ramp import RUN_DURATION_ACTION

    seen = existing_duration_run_ids(con)
    written = 0
    for end_iso, minutes, run_id in durations:
        if run_id in seen:
            continue
        print(f"  duration {minutes:6.1f} min — run {run_id} ended {end_iso}"
              + ("" if commit else " [DRY RUN]"))
        if commit:
            con.execute(
                "INSERT INTO audit_log(created_at, person_id, action, status, details) "
                "VALUES (?, NULL, ?, 'completed', ?)",
                (end_iso, RUN_DURATION_ACTION,
                 json.dumps({"minutes": minutes, "run_id": run_id,
                             "source": "github_actions_backfill"}, sort_keys=True)),
            )
        written += 1
    return written


def seed_last_advanced(con, seed_iso: str, *, commit: bool) -> bool:
    """Start the ramp clock at the moment step 1 went live — only from NULL."""
    from fub_automation import ramp

    ramp.ensure_schema(con)
    state = ramp.get_state(con)
    if state["last_advanced_at"] is not None:
        print(f"  last_advanced_at already {state['last_advanced_at']} — leaving it alone")
        return False
    print(f"  seeding last_advanced_at = {seed_iso}" + ("" if commit else " [DRY RUN]"))
    if commit:
        ramp.save_state(
            con,
            step_index=state["step_index"],
            last_advanced_at=seed_iso,
            last_evaluated_at=state["last_evaluated_at"],
            holding=state["holding"],
            hold_reason=state["hold_reason"],
        )
    return True


def print_projection(con) -> None:
    """What the next daily run's maybe_advance will decide. Read-only."""
    from fub_automation import ramp

    now = dt.datetime.now(UTC)
    state = ramp.get_state(con)
    guardrails = ramp.evaluate_guardrails(con, now - dt.timedelta(days=ramp.RAMP_INTERVAL_DAYS), now)
    last_advanced = state["last_advanced_at"]
    parsed = _parse_iso(last_advanced) if last_advanced else None
    due = bool(parsed) and (now - parsed) >= dt.timedelta(days=ramp.RAMP_INTERVAL_DAYS)
    step = state["step_index"]
    at_ceiling = step >= len(ramp.RAMP_STEPS) - 1

    print(f"  projection: step {step + 1} (cap {ramp.cap_for_step(step)}), "
          f"interval {'elapsed' if due else 'not elapsed'}, "
          f"guardrails {'GREEN' if guardrails['green'] else 'NOT green'}")
    for reason in guardrails["reasons"]:
        print(f"    - {reason}")
    if guardrails["green"] and due and not at_ceiling:
        print(f"  → the next daily run will ADVANCE to cap {ramp.cap_for_step(step + 1)}")
    elif at_ceiling:
        print("  → at ceiling; nothing to advance")
    elif not due:
        print("  → next daily run will hold: interval not yet elapsed")
    else:
        print("  → next daily run will HOLD on the reasons above")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Backfill run durations and seed the ramp clock.")
    parser.add_argument("--days", type=int, default=10,
                        help="How far back to backfill run durations (default 10).")
    parser.add_argument("--last-advanced", default=DEFAULT_LAST_ADVANCED,
                        help="Clock seed, used only when last_advanced_at is NULL.")
    parser.add_argument("--commit", action="store_true",
                        help="Actually write. Without it, a dry run that prints the plan.")
    args = parser.parse_args(argv)

    import sqlite3

    from fub_automation.main import AuditDB

    db_path = os.environ.get("DATABASE_PATH", "data/fub_automation.sqlite3")
    if not Path(db_path).exists():
        print(f"No state DB at {db_path} — pull it first. Nothing done.")
        return 2
    AuditDB(db_path)  # ensure the audit schema exists

    mode = "COMMIT" if args.commit else "DRY RUN"
    print(f"=== Ramp state repair — {mode} ===")

    payload = fetch_recent_daily_runs(args.days)
    durations = durations_from_runs(payload)
    if not durations:
        print("No successful daily runs found in the window — refusing to seed a "
              "clock the guardrails cannot then evaluate.")
        return 1

    con = sqlite3.connect(db_path)
    try:
        with con:
            wrote = apply_durations(con, durations, commit=args.commit)
            seeded = seed_last_advanced(con, args.last_advanced, commit=args.commit)
        print(f"Durations written: {wrote}; clock seeded: {seeded} ({mode}).")
        print_projection(con)
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
