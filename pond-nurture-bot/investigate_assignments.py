#!/usr/bin/env python3
"""Read-only investigation: today's assignments vs what the automation did.

Built for the 2026-08-25 incident report: several leads distributed in the
morning, one speed-to-lead alert fired (Jose Brito → Laila, 13:57 UTC),
nothing else. For every lead created in the window and every lead whose
record changed in the window, this prints what FUB says, what the state DB
says (timers, watch rows, audit trail), and — for created leads — which
poll_new_leads gate would exclude them, evaluated with the REAL gate code.

READ-ONLY: every FUB call is a GET, the state DB is opened after a pull and
never pushed. DRY_RUN is pinned so even a mistake cannot write.

USAGE
    python3 investigate_assignments.py --hours 48 --focus 6327
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

UTC = dt.timezone.utc


def _p(line: str) -> None:
    print(line, flush=True)


def poll_gate_verdict(engine, person: dict, created_cutoff: dt.datetime) -> str:
    """Which poll_new_leads gate stops this lead, evaluated with the real
    predicates — 'timer' means nothing stops it."""
    from fub_automation.main import parse_fub_datetime

    created = parse_fub_datetime(person.get("created"))
    if not created or created < created_cutoff:
        return "GATE createdAfter-24h: not a recently created lead — invisible to polling"
    if engine.is_excluded(person):
        return "GATE is_excluded: stage/tag exclusion"
    if engine._is_excluded_source(person):
        return f"GATE excluded source: {engine._is_excluded_source(person)}"
    if engine._is_soi_silenced(person):
        return "GATE SOI silenced"
    assigned = person.get("assignedUserId")
    if not assigned:
        return "GATE unassigned: no assignedUserId — no timer until an agent gets it"
    if int(assigned) == int(engine.rules.peter_user_id or -1):
        return "GATE assigned to Peter: timers only guard agent assignments"
    return "timer"


def describe_lead(engine, db, person: dict, users: Dict[int, dict],
                  created_cutoff: dt.datetime, window_start: dt.datetime) -> None:
    pid = int(person["id"])
    name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip() or f"#{pid}"
    assigned = person.get("assignedUserId")
    agent = (users.get(int(assigned), {}).get("name") if assigned else None) or assigned
    _p(f"  lead {pid} {name!r} created={person.get('created')} "
       f"updated={person.get('updated')} stage={person.get('stage')} "
       f"agent={agent!r} pond={person.get('assignedPondId')} "
       f"lastActivity={person.get('lastActivity')}")

    watch = db.get_assignment_watch(pid)
    if watch:
        _p(f"    watch: assigned_user_id={watch['assigned_user_id']} "
           f"first_seen={watch['first_seen_at']} last_alert={watch['last_alert_at']}"
           + ("  ← ASSIGNEE CHANGED since watch" if assigned and watch["assigned_user_id"] != int(assigned) else ""))
    else:
        _p("    watch: NO ROW — never observed by the daily safety net")

    import sqlite3 as _sq
    con = _sq.connect(db.path)
    con.row_factory = _sq.Row
    timers = [dict(r) for r in con.execute(
        "SELECT * FROM new_lead_timers WHERE person_id=?", (pid,))]
    con.close()
    if timers:
        for t in timers:
            _p(f"    timer: started={t['created_at']} agent={t['assigned_user_id']} "
               f"warned={t['warned_at']} reassigned={t['reassigned_at']} "
               f"canceled={t['canceled_at']}")
    else:
        _p("    timer: NONE")
    for row in db.recent_audit_rows(
            ["new_lead_timer", "speed_to_lead_alert", "new_lead_warning",
             "new_lead_reassigned", "untouched_assignment_alert"], window_start):
        if int(row.get("person_id") or 0) == pid:
            _p(f"    audit: {row['created_at']} {row['action']}/{row['status']}")
    _p(f"    verdict: {poll_gate_verdict(engine, person, created_cutoff)}")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Assignment investigation, read-only.")
    parser.add_argument("--hours", type=int, default=48)
    parser.add_argument("--focus", type=int, default=None,
                        help="Person id to detail (notes included).")
    args = parser.parse_args(argv)

    os.environ["DRY_RUN"] = "true"
    os.environ.setdefault("FUB_DISABLE_SCHEDULER", "true")

    from fub_automation.main import (
        AuditDB,
        FollowUpBossClient,
        RuleEngine,
        Rules,
        Settings,
        parse_fub_datetime,
    )

    settings = Settings.from_env()
    if not settings.fub_api_key:
        _p("FUB_API_KEY missing — nothing to investigate.")
        return 2
    rules = Rules.load(settings.rules_path)
    db = AuditDB(settings.database_path)
    engine = RuleEngine(settings, rules, FollowUpBossClient(settings), db)
    fub = engine.fub

    now = dt.datetime.now(UTC)
    window_start = now - dt.timedelta(hours=args.hours)
    created_cutoff = now - dt.timedelta(hours=24)  # poll_new_leads' own window
    users = fub.users_cache() if hasattr(fub, "users_cache") else {}
    if not users:
        users = engine.user_cache_by_id()

    _p(f"=== A. Leads CREATED in the last {args.hours}h ===")
    created_ids = set()
    created_leads = fub.get_people(
        createdAfter=window_start.strftime("%Y-%m-%d %H:%M:%S"), fields="allFields")
    for person in created_leads:
        created_ids.add(int(person["id"]))
        describe_lead(engine, db, person, users, created_cutoff, window_start)

    _p(f"\n=== B. Leads whose record CHANGED in the last {args.hours}h "
       "(assignment-change candidates; FUB keeps no assignment history, so the "
       "watch-table diff and timer absence are the evidence) ===")
    params: Dict[str, object] = {"sort": "-updated", "limit": 100}
    pages = 0
    stop = False
    while pages < 10 and not stop:
        data = fub._request("GET", "/people", params=dict(params))
        people = data.get("people", data.get("data", []))
        if not people:
            break
        for person in people:
            updated = parse_fub_datetime(person.get("updated"))
            if updated and updated < window_start:
                stop = True
                break
            if int(person["id"]) in created_ids:
                continue
            detail = fub.get_person(int(person["id"])) or person
            describe_lead(engine, db, detail, users, created_cutoff, window_start)
        pages += 1
        cursor = data.get("_metadata", {}).get("next")
        if not cursor or stop:
            break
        params["next"] = cursor

    _p(f"\n=== C. State DB: timers + related audit in the last {args.hours}h ===")
    import sqlite3 as _sq
    con = _sq.connect(db.path)
    con.row_factory = _sq.Row
    for t in con.execute("SELECT * FROM new_lead_timers WHERE created_at >= ?",
                         (window_start.isoformat(),)):
        _p(f"  timer person={t['person_id']} started={t['created_at']} "
           f"agent={t['assigned_user_id']} warned={t['warned_at']} "
           f"reassigned={t['reassigned_at']} canceled={t['canceled_at']}")
    con.close()
    for row in db.recent_audit_rows(
            ["new_lead_timer", "speed_to_lead_alert", "new_lead_warning",
             "new_lead_reassigned", "untouched_assignment_alert"], window_start):
        _p(f"  audit {row['created_at']} person={row['person_id']} "
           f"{row['action']}/{row['status']}")

    if args.focus:
        _p(f"\n=== D. Focus lead {args.focus} ===")
        person = fub.get_person(args.focus)
        if not person:
            _p("  NOT FOUND in FUB")
        else:
            describe_lead(engine, db, person, users, created_cutoff, window_start)
            for key in ("lastSentEmail", "lastReceivedEmail", "lastReceivedText",
                        "lastIncomingCall", "lastCall", "lastCommunication"):
                _p(f"    {key} = {person.get(key)!r}")
            notes = fub.get_notes(args.focus, limit=10)
            _p(f"    notes: {len(notes)}")
            for note in notes[:10]:
                _p(f"      {note.get('created') or note.get('createdAt')} "
                   f"createdById={note.get('createdById')} "
                   f"subj={str(note.get('subject'))[:60]!r}")
            # Channel rows WITH their author ids — the touch check attributes
            # every channel this way, so a diagnosis has to see the same fields.
            for label, rows_ in (("calls", fub.get_calls(args.focus, limit=20)),
                                 ("texts", fub.get_text_messages(args.focus, limit=20)),
                                 ("emails", fub.get_emails(args.focus, limit=20))):
                _p(f"    {label}: {len(rows_)}")
                for row in rows_[:20]:
                    _p(f"      {row.get('created') or row.get('createdAt')} "
                       f"userId={row.get('userId')} "
                       f"isIncoming={row.get('isIncoming')!r} "
                       f"outcome/subj={str(row.get('outcome') or row.get('subject') or '')[:40]!r}")
            # The full timer + assignment audit trail for this person, however
            # old — section C is window-capped, and a bounced lead's history is
            # exactly what an incident review needs.
            import sqlite3 as _sq2
            con2 = _sq2.connect(db.path)
            con2.row_factory = _sq2.Row
            for row in con2.execute(
                    "SELECT created_at, action, status, details FROM audit_log "
                    "WHERE person_id=? ORDER BY created_at", (args.focus,)):
                _p(f"    audit(all): {row['created_at']} {row['action']}/{row['status']} "
                   f"{str(row['details'])[:120]}")
            con2.close()
    _p("\nDone. Every FUB call above was a GET; the state DB was never pushed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
