#!/usr/bin/env python3
"""Re-judge speed-to-lead warnings/reassignments under the corrected touch rule.

The 2026-08-29 incident: Sunny Chamadia (6343) was assigned to Tiffany on
08-28, called 24 minutes after creation — and still warned and auto-returned
to Peter, because the timer's touch anchor was DETECTION time (22:13Z, ~2h
after creation) and the 2026-08-26 "at or after the anchor" rule refused the
20:46Z call. Several leads bounced the same way.

This script re-judges every warning and auto-reassignment since --since with
the corrected anchor:

  - polling timers (started_polling): the agent has the lead from its FUB
    creation — the anchor is the fub_created_at the arm row logged;
  - assignment-change timers (started_assignment_change): no historical scan
    observations exist, so the anchor is detection minus the 24h scan window
    (the walk cannot detect a change older than that).

A touch is the ASSIGNED AGENT's OWN attributed activity, exactly as the
strict check defines it — their call (either direction), their outbound
text/email (bot audit-log sends excluded), their non-Automation note — at or
after the corrected anchor and before the punishment resolved. Per the
2026-08-29 follow-up policy a note counts only when it documents actual lead
contact (note_documents_contact); a bare acknowledgment ("got it") does not,
and such notes are printed WITH their text so every judgment can be eyeballed.

DRY-RUN by default: prints the verdict list and writes NOTHING (no FUB
writes, no state rows). --commit additionally:
  - restores the original agent (only if the lead still sits with Peter —
    a manual re-route since the bounce is never overwritten),
  - strips the auto-reassigned-speed-to-lead tag,
  - leaves an "Automation: speed-to-lead repair" note naming the missed touch,
  - cancels any still-active punished timer,
  - writes a speed_to_lead_repair audit row per lead, which suppresses
    re-arming for 24h (scan_assignment_changes skips repair_suppressed).

USAGE
    python3 repair_speed_to_lead_false_positives.py --since 2026-08-28T00:00:00+00:00
    python3 repair_speed_to_lead_false_positives.py --since ... --commit
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

UTC = dt.timezone.utc

REPAIR_TAG = "auto-reassigned-speed-to-lead"
REPAIR_ACTION = "speed_to_lead_repair"
ARM_STATUSES = ("started_polling", "started_assignment_change")
#: An arm audit row lands within a second of its timer row; the match window
#: is generous because the two stamps come from separate now_iso() calls.
ARM_ROW_MATCH_SECONDS = 60
#: scan_assignment_changes cannot detect a change older than its walk window.
SCAN_WINDOW_HOURS = 24


def _p(line: str) -> None:
    print(line, flush=True)


def find_arm_row(db, person_id: int, timer_created_at: str):
    """The new_lead_timer arm audit row for this timer generation, if any."""
    from fub_automation.main import parse_dt

    created = parse_dt(timer_created_at)
    if created is None:
        return None
    best = None
    for row in db.recent_audit_rows(
            ["new_lead_timer"], created - dt.timedelta(seconds=ARM_ROW_MATCH_SECONDS)):
        if int(row.get("person_id") or 0) != person_id:
            continue
        if row.get("status") not in ARM_STATUSES:
            continue
        row_ts = parse_dt(row.get("created_at") or "")
        if row_ts is None:
            continue
        gap = abs((row_ts - created).total_seconds())
        if gap <= ARM_ROW_MATCH_SECONDS and (best is None or gap < best[0]):
            best = (gap, row)
    return best[1] if best else None


def corrected_touch_anchor(db, person_id: int,
                           generations: List[dict]) -> Tuple[dt.datetime, str]:
    """The earliest corrected anchor across this person's punished timers."""
    from fub_automation.main import parse_dt, parse_fub_datetime

    anchors: List[Tuple[dt.datetime, str]] = []
    for gen in generations:
        created = parse_dt(gen["created_at"])
        # A generation armed by the FIXED code already carries the corrected
        # anchor — trust it over the wider historical approximations.
        stored = parse_dt(gen.get("touch_anchor_at") or "")
        if stored is not None:
            anchors.append((stored, "stored_touch_anchor"))
            continue
        arm = find_arm_row(db, person_id, gen["created_at"])
        if arm is not None and arm.get("status") == "started_polling":
            try:
                details = json.loads(arm.get("details") or "{}")
            except ValueError:
                details = {}
            fub_created = parse_fub_datetime(details.get("fub_created_at") or "")
            if fub_created is not None:
                anchors.append((fub_created, "lead_creation"))
                continue
        if created is not None:
            anchors.append((created - dt.timedelta(hours=SCAN_WINDOW_HOURS),
                            "detection_minus_scan_window"))
    if not anchors:
        # Unjudgeable without a parsable timer stamp — fail toward "not a
        # false positive" by anchoring at now (no touch can qualify).
        return dt.datetime.now(UTC), "unjudgeable"
    return min(anchors, key=lambda a: a[0])


def _note_display_text(note: dict) -> str:
    """The note as a human would read it, whitespace-collapsed."""
    import re as _re

    parts = [str(note.get("subject") or note.get("title") or "").strip(),
             str(note.get("body") or "").strip()]
    text = " — ".join(p for p in parts if p)
    return _re.sub(r"\s+", " ", text) or "(empty note)"


def find_agent_touch(fub, db, person_id: int, agent_id: int,
                     anchor: dt.datetime,
                     cutoff: dt.datetime) -> Tuple[Optional[dict], List[dict]]:
    """(earliest qualifying touch or None, the agent's rejected notes).

    Attribution mirrors _touched_by_assigned_agent: calls either direction by
    userId, texts/emails outbound-only by userId with the bot's audit-logged
    sends excluded, notes by createdById minus Automation: subjects — and,
    per the 2026-08-29 policy, a note counts only when it documents actual
    lead contact (note_documents_contact). Notes that fail that gate come
    back in the second slot WITH their text, so a human reviewing a verdict
    can eyeball exactly what the note said. API errors contribute nothing
    (fail closed — same as the live check).
    """
    from fub_automation.funnel import EMAIL_SEND_ACTIONS, SENT_STATUSES
    from fub_automation.main import (
        is_inbound_message,
        note_documents_contact,
        parse_dt,
    )

    bot_send_times: List[dt.datetime] = []
    try:
        for row in db.recent_audit_rows(list(EMAIL_SEND_ACTIONS), anchor):
            if int(row.get("person_id") or 0) != person_id:
                continue
            if row.get("status") not in SENT_STATUSES:
                continue
            ts = parse_dt(row.get("created_at") or "")
            if ts:
                bot_send_times.append(ts)
    except Exception:  # noqa: BLE001
        pass

    def _is_bot_send(ts: dt.datetime) -> bool:
        return any(abs((ts - bot_ts).total_seconds()) <= 300 for bot_ts in bot_send_times)

    def _row_ts(row: dict) -> Optional[dt.datetime]:
        return parse_dt(row.get("created") or row.get("createdAt") or "")

    candidates: List[dict] = []

    def _consider(channel: str, ts: Optional[dt.datetime], detail: str) -> None:
        if ts is not None and anchor <= ts <= cutoff:
            candidates.append({"channel": channel, "at": ts, "detail": detail})

    try:
        for call in fub.get_calls(person_id, limit=50):
            if int(call.get("userId") or 0) != agent_id:
                continue
            _consider("call", _row_ts(call),
                      f"outcome={call.get('outcome')!r}")
    except Exception:  # noqa: BLE001
        pass
    try:
        for msg in fub.get_text_messages(person_id, limit=50):
            if is_inbound_message(msg) or int(msg.get("userId") or 0) != agent_id:
                continue
            _consider("text", _row_ts(msg),
                      f"message={str(msg.get('message') or '')[:60]!r}")
    except Exception:  # noqa: BLE001
        pass
    try:
        for mail in fub.get_emails(person_id, limit=50):
            if is_inbound_message(mail) or int(mail.get("userId") or 0) != agent_id:
                continue
            ts = _row_ts(mail)
            if ts is not None and _is_bot_send(ts):
                continue
            _consider("email", ts, f"subject={str(mail.get('subject') or '')[:60]!r}")
    except Exception:  # noqa: BLE001
        pass
    rejected_notes: List[dict] = []
    try:
        for note in fub.get_notes(person_id, limit=50):
            if int(note.get("createdById") or 0) != agent_id:
                continue
            if str(note.get("subject") or note.get("title") or "").startswith("Automation:"):
                continue
            ts = _row_ts(note)
            if ts is None or not (anchor <= ts <= cutoff):
                continue
            if not note_documents_contact(note):
                rejected_notes.append({"at": ts, "text": _note_display_text(note)})
                continue
            _consider("note", ts, f"text={_note_display_text(note)[:160]!r}")
    except Exception:  # noqa: BLE001
        pass

    if not candidates:
        return None, rejected_notes
    return min(candidates, key=lambda c: c["at"]), rejected_notes


def judge_incidents(db, fub, since: dt.datetime) -> List[dict]:
    """One verdict per punished (person, agent): every timer generation whose
    warning or reassignment landed at/after `since`, re-judged under the
    corrected anchor. Grouping by agent matters — a lead bounced from agent A,
    redistributed to B and bounced again holds generations for both, each
    judged against its OWN agent's activity."""
    import sqlite3

    from fub_automation.main import parse_dt

    con = sqlite3.connect(db.path)
    con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute(
        "SELECT * FROM new_lead_timers WHERE warned_at IS NOT NULL "
        "OR reassigned_at IS NOT NULL")]
    con.close()

    # A person already repaired once must not be re-judged as fresh — the
    # commit run is dispatchable twice, and the second pass would otherwise
    # re-write notes and re-restore over whatever happened since.
    already_repaired = set()
    for row in db.recent_audit_rows(["speed_to_lead_repair"],
                                    since - dt.timedelta(days=30)):
        if row.get("person_id"):
            already_repaired.add(int(row["person_id"]))

    by_key: Dict[Tuple[int, Optional[int]], List[dict]] = {}
    for row in rows:
        stamps = [parse_dt(row.get("warned_at") or ""),
                  parse_dt(row.get("reassigned_at") or "")]
        if not any(s is not None and s >= since for s in stamps):
            continue
        agent = int(row["assigned_user_id"]) if row.get("assigned_user_id") else None
        by_key.setdefault((int(row["person_id"]), agent), []).append(row)

    verdicts: List[dict] = []
    for person_id, agent_id in sorted(by_key, key=lambda k: (k[0], k[1] or 0)):
        gens = by_key[(person_id, agent_id)]
        reassigned = [parse_dt(g.get("reassigned_at") or "") for g in gens]
        warned = [parse_dt(g.get("warned_at") or "") for g in gens]
        reassigned = [t for t in reassigned if t is not None]
        warned = [t for t in warned if t is not None]
        cutoff = max(reassigned or warned)
        punishment = "reassigned" if reassigned else "warned"
        anchor, anchor_how = corrected_touch_anchor(db, person_id, gens)
        touch, rejected_notes = None, []
        if agent_id is not None:
            touch, rejected_notes = find_agent_touch(
                fub, db, person_id, agent_id, anchor, cutoff)
        verdicts.append({
            "person_id": person_id,
            "agent_id": agent_id,
            "generations": gens,
            "punishment": punishment,
            "punished_at": cutoff,
            "anchor": anchor,
            "anchor_how": anchor_how,
            "touch": touch,
            "rejected_notes": rejected_notes,
            "false_positive": touch is not None,
            "already_repaired": person_id in already_repaired,
        })
    return verdicts


def apply_repair(db, fub, verdict: dict, peter_user_id: int,
                 agent_name: str, latest_routing: bool = True) -> str:
    """Commit one false positive's repair. Returns the audit status written.

    latest_routing: False when another punished generation for this person
    was punished LATER (a different agent held the most recent routing) — the
    verdict still gets its note and suppression, but never the restore.
    """
    person_id = verdict["person_id"]
    agent_id = verdict["agent_id"]
    touch = verdict["touch"]
    person = fub.get_person(person_id)
    if not person:
        db.log(REPAIR_ACTION, "person_gone", person_id, {})
        return "person_gone"

    restored = False
    status = "warning_cleared"
    if verdict["punishment"] == "reassigned":
        current = int(person.get("assignedUserId") or 0)
        if not latest_routing:
            status = "restore_skipped_not_latest_routing"
        elif current == int(peter_user_id):
            fub.update_person(person_id, {"assignedUserId": agent_id})
            db.upsert_assignment_watch(person_id, agent_id)
            restored = True
            status = "reassignment_reverted"
        else:
            # Peter (or someone) already re-routed the lead by hand — an
            # automated restore would overwrite a human decision.
            status = "restore_skipped_manual_route"
        # FUB returns tags either as plain strings or as {"name": ...}
        # objects; strip by NAME and write the kept names back verbatim
        # (merge_tags=False — FUB has no tag-removal API, the whole list is
        # replaced), same as sweep_reply_false_positives.clear_pause_tag.
        names: List[str] = []
        for tag in person.get("tags") or []:
            name = tag.get("name") if isinstance(tag, dict) else tag
            if name:
                names.append(str(name))
        kept = [n for n in names if n.strip().lower() != REPAIR_TAG.lower()]
        if len(kept) != len(names):
            fub.update_person(person_id, {"tags": kept})

    # The punished agent must not keep a live clock — but ONLY theirs: a
    # legitimate timer running for whoever holds the lead now stays.
    if restored or verdict["punishment"] == "warned":
        db.cancel_timer(person_id, agent_id)

    touch_line = "(touch unavailable)"
    if touch:
        touch_line = f"{touch['channel']} at {touch['at'].isoformat()}"
        if touch["channel"] == "note":
            touch_line += f", {touch['detail']}"
    body = (
        f"Speed-to-lead repair: the {verdict['punishment']} on this lead was a "
        f"false positive. {agent_name or f'Agent {agent_id}'} touched the lead "
        f"({touch_line}) between the assignment and the automation's detection "
        f"of it — the old rule only counted activity after detection. "
        + ("The lead has been returned to the agent."
           if restored else
           "The assignment was already re-routed manually and was left as is."
           if status == "restore_skipped_manual_route" else
           "A later routing decision supersedes this one; the assignment was left as is."
           if status == "restore_skipped_not_latest_routing" else
           "No reassignment had happened; the pending timer was cleared.")
    )
    fub.add_note(person_id, "Automation: speed-to-lead repair", body)
    db.log(REPAIR_ACTION, status, person_id, {
        "agent_id": agent_id,
        "missed_touch_channel": touch["channel"] if touch else None,
        "missed_touch_at": touch["at"].isoformat() if touch else None,
        "anchor": verdict["anchor"].isoformat(),
        "anchor_how": verdict["anchor_how"],
        "restored": restored,
    })
    return status


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Re-judge speed-to-lead punishments; repair false positives.")
    parser.add_argument("--since", default="2026-08-28T00:00:00+00:00",
                        help="Re-judge warnings/reassignments at/after this ISO instant.")
    parser.add_argument("--commit", action="store_true",
                        help="Apply the repairs. Without it: judge and print only.")
    args = parser.parse_args(argv)

    since = dt.datetime.fromisoformat(args.since)
    if since.tzinfo is None:
        since = since.replace(tzinfo=UTC)

    os.environ.setdefault("FUB_DISABLE_SCHEDULER", "true")
    if not args.commit:
        # Belt and braces: dry-run must be unable to write even through a bug.
        os.environ["DRY_RUN"] = "true"

    from fub_automation.main import (
        AuditDB,
        FollowUpBossClient,
        RuleEngine,
        Rules,
        Settings,
    )

    settings = Settings.from_env()
    if not settings.fub_api_key:
        _p("FUB_API_KEY missing — nothing to judge.")
        return 2
    if args.commit and settings.dry_run:
        _p("--commit with DRY_RUN=true is contradictory — refusing to guess. "
           "Set DRY_RUN=false to commit.")
        return 2
    rules = Rules.load(settings.rules_path)
    db = AuditDB(settings.database_path)
    fub = FollowUpBossClient(settings)
    engine = RuleEngine(settings, rules, fub, db)

    users = engine.user_cache_by_id()

    def _uname(uid) -> str:
        if uid is None:
            return "?"
        return (users.get(int(uid), {}) or {}).get("name") or f"user {uid}"

    verdicts = judge_incidents(db, fub, since)
    mode = "COMMIT" if args.commit else "DRY-RUN"
    _p(f"=== Speed-to-lead re-judgment since {since.isoformat()} — {mode} ===")
    _p(f"{len(verdicts)} punished lead(s) in the window.\n")

    false_positives = [v for v in verdicts
                       if v["false_positive"] and not v["already_repaired"]]
    for v in verdicts:
        person = fub.get_person(v["person_id"]) or {}
        name = (f"{person.get('firstName', '')} {person.get('lastName', '')}".strip()
                or f"#{v['person_id']}")
        head = ("ALREADY REPAIRED" if v["already_repaired"]
                else "FALSE POSITIVE" if v["false_positive"] else "legitimate")
        _p(f"  [{head}] lead {v['person_id']} {name!r} — agent {_uname(v['agent_id'])}"
           f" ({v['agent_id']}), {v['punishment']} at {v['punished_at'].isoformat()}")
        _p(f"      corrected anchor: {v['anchor'].isoformat()} ({v['anchor_how']})")
        for gen in v["generations"]:
            _p(f"      timer: started={gen['created_at']} warned={gen['warned_at']} "
               f"reassigned={gen['reassigned_at']}")
        if v["touch"]:
            t = v["touch"]
            _p(f"      missed touch: {t['channel']} at {t['at'].isoformat()} {t['detail']}")
        else:
            _p("      no qualifying agent touch in the corrected window — stands.")
        for rn in v.get("rejected_notes") or []:
            _p(f"      note WITHOUT contact evidence (did not stop the clock): "
               f"{rn['at'].isoformat()} text={rn['text'][:160]!r}")

    _p(f"\n{len(false_positives)} false positive(s) to repair.")

    if not args.commit:
        _p("Dry-run: nothing was written (no FUB writes, no state rows).")
        return 0

    # The restore may only follow the person's LATEST routing decision — a
    # lead punished under agent A, redistributed to B and punished again must
    # not land back with A.
    latest_by_person: Dict[int, dt.datetime] = {}
    for v in verdicts:
        prev = latest_by_person.get(v["person_id"])
        if prev is None or v["punished_at"] > prev:
            latest_by_person[v["person_id"]] = v["punished_at"]

    repaired = 0
    failures = 0
    for v in false_positives:
        # One lead's FUB hiccup must not strand the rest of the list — and
        # the audit rows written so far must still reach the state branch.
        try:
            status = apply_repair(
                db, fub, v, int(rules.peter_user_id or 0), _uname(v["agent_id"]),
                latest_routing=v["punished_at"] == latest_by_person[v["person_id"]])
        except Exception as exc:  # noqa: BLE001
            failures += 1
            _p(f"  lead {v['person_id']}: REPAIR FAILED — {exc}")
            continue
        repaired += 1
        _p(f"  repaired lead {v['person_id']}: {status}")

    with open("speed_to_lead_repair_summary.json", "w") as fh:
        json.dump({"repaired": repaired, "failed": failures,
                   "since": since.isoformat()}, fh)
    _p(f"Commit complete: {repaired} repaired, {failures} failed. "
       "Re-arming on repaired leads is suppressed for 24h.")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
