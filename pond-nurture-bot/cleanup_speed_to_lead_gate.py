#!/usr/bin/env python3
"""Speed-to-lead gate cleanup: timers and bounces the Peter-only rule forbids.

Peter's rule (2026-09-27): a speed-to-lead timer arms ONLY when Peter
assigned the lead to an agent — he added it and assigned it, or he
reassigned it. Before the gate, every agent-assigned lead armed, an agent's
own imported contacts included, and each unanswered one bounced to Peter.

This lists, and on --commit repairs:

  A. ACTIVE timers whose lead fails the gate NOW — the same resolve_assigner
     verdict the live triggers use (not Peter, or assigner unknown). --commit
     cancels each, with an audit row.
  B. Every speed-to-lead warning / auto-reassignment since --since whose
     assignment was not Peter's: lead, agent, who added it, when it bounced.

History is judged from what FUB still shows. createdVia/createdById never
change, so "an agent's own contact" (added by the agent, armed at discovery
while still theirs) is certain. The last-editor stamp that would name a
LATER router was overwritten by the bounce itself — the automation writes on
Peter's key — so any lead routed after creation reads UNDETERMINED: listed
for Peter's call, restored only when he names it with --also-restore.

Nothing is written without --commit. With it, for each bounced lead that
fails the gate (or is named in --also-restore):
  - the original agent is restored — only if the lead still sits with Peter,
    outside a pond, and nobody has edited it since the bounce: a re-route by
    hand is never overwritten;
  - the auto-reassigned-speed-to-lead tag is stripped;
  - an "Automation: speed-to-lead gate cleanup" note explains why;
  - a speed_to_lead_gate_cleanup audit row is written (the live triggers
    treat it as the automation's own move, so the restore never arms).
Warned-but-never-bounced leads are listed only; there is nothing to undo.

The repository is public: output carries FUB ids, staff names, lead-source
labels and timestamps — never lead names or contact details.

USAGE
    python3 cleanup_speed_to_lead_gate.py --since 2026-08-25T00:00:00+00:00
    python3 cleanup_speed_to_lead_gate.py --since ... --commit [--also-restore 6337,6341]
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from fub_automation.assigner import (  # noqa: E402
    AUTOMATION_EDIT_WINDOW,
    HUMAN_CREATED_VIA,
    automation_write_times,
    parse_stamp,
    resolve_assigner,
)

UTC = dt.timezone.utc

CLEANUP_ACTION = "speed_to_lead_gate_cleanup"
CLEANUP_NOTE_SUBJECT = "Automation: speed-to-lead gate cleanup"
BOUNCE_TAG = "auto-reassigned-speed-to-lead"
#: An arm audit row lands within a second of its timer row.
ARM_ROW_MATCH_SECONDS = 60
#: The bounce's own writes (assignment, tag) land within seconds of the
#: timer's reassigned_at stamp; an edit later than this is someone else's.
EDIT_AFTER_BOUNCE_GRACE = dt.timedelta(minutes=5)

FAILS = "FAILS"
PASSES = "passes"
UNDETERMINED = "UNDETERMINED"

ARM_LABELS = {
    "started_polling": "new-lead poll",
    "started_assignment_change": "reassignment scan",
    "started": "webhook",
}


def _p(line: str = "") -> None:
    print(line, flush=True)


def _uid(value) -> Optional[int]:
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _short(ts: Optional[dt.datetime]) -> str:
    return ts.strftime("%Y-%m-%d %H:%MZ") if ts else "-"


def load_arm_rows(db_path: str) -> Dict[int, List[Tuple[dt.datetime, str]]]:
    """Every timer-arm audit row, by person: (logged at, status)."""
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    out: Dict[int, List[Tuple[dt.datetime, str]]] = collections.defaultdict(list)
    for row in con.execute(
            "SELECT created_at, person_id, status FROM audit_log "
            "WHERE action='new_lead_timer' AND status LIKE 'started%'"):
        ts = parse_stamp(row["created_at"])
        if ts is not None and row["person_id"]:
            out[int(row["person_id"])].append((ts, str(row["status"])))
    con.close()
    return out


def arm_kind(arm_rows: Dict[int, List[Tuple[dt.datetime, str]]], person_id: int,
             timer_created_at: str) -> str:
    """Which trigger armed this timer generation (its audit row's status)."""
    created = parse_stamp(timer_created_at)
    if created is None:
        return "unknown"
    best: Optional[Tuple[float, str]] = None
    for ts, status in arm_rows.get(person_id, []):
        gap = abs((ts - created).total_seconds())
        if gap <= ARM_ROW_MATCH_SECONDS and (best is None or gap < best[0]):
            best = (gap, status)
    return best[1] if best else "unknown"


def judge_history(person: Optional[dict], agent_id: Optional[int], kinds: Set[str],
                  peter_user_id: int) -> Tuple[str, str]:
    """(verdict, why) for one punished (lead, agent) pair, from the fields FUB
    still shows. Only createdVia/createdById are trusted: they never change.
    """
    if not person:
        return UNDETERMINED, "lead no longer in FUB"
    via = str(person.get("createdVia") or "").strip().lower()
    created_by = _uid(person.get("createdById"))
    added_by_person = via in HUMAN_CREATED_VIA and bool(created_by) and created_by > 0
    armed_at_discovery = bool(kinds) and kinds <= {"started_polling", "started"}
    if armed_at_discovery and added_by_person and created_by != int(peter_user_id) \
            and agent_id == created_by:
        # Armed while the contact still sat with the agent who added it.
        return FAILS, "agent's own contact"
    if armed_at_discovery and added_by_person and created_by == int(peter_user_id):
        return PASSES, "Peter added the lead"
    if "unknown" in kinds and len(kinds) == 1:
        return UNDETERMINED, "arm record not found — router not recoverable"
    if armed_at_discovery and added_by_person:
        return UNDETERMINED, "added by another user, routed to this agent — router not recoverable"
    if armed_at_discovery:
        return UNDETERMINED, "arrived from a lead source — router not recoverable"
    return UNDETERMINED, "routed after creation — router not recoverable"


def collect_punished(db_path: str, since: dt.datetime) -> Dict[Tuple[int, Optional[int]], List[dict]]:
    """Timer generations warned or reassigned at/after `since`, by (person, agent)."""
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute(
        "SELECT * FROM new_lead_timers WHERE warned_at IS NOT NULL "
        "OR reassigned_at IS NOT NULL")]
    con.close()
    groups: Dict[Tuple[int, Optional[int]], List[dict]] = collections.defaultdict(list)
    for row in rows:
        stamps = [parse_stamp(row.get("warned_at")), parse_stamp(row.get("reassigned_at"))]
        if not any(s is not None and s >= since for s in stamps):
            continue
        agent = _uid(row.get("assigned_user_id"))
        groups[(int(row["person_id"]), agent)].append(row)
    return groups


def plan_restore(person: Optional[dict], verdict: dict, peter_user_id: int,
                 users: Dict[int, dict], auto_times: List[dt.datetime],
                 excluded_ids: frozenset = frozenset()) -> Tuple[str, str]:
    """(status, detail): what --commit would do for one punished pair."""
    if verdict["bounced_at"] is None:
        return "list_only_warned", "warned, never bounced — nothing to undo"
    if verdict["already_cleaned"]:
        return "skip_already_repaired", "an earlier repair/cleanup already handled it"
    if not verdict["latest_routing"]:
        return "skip_not_latest_routing", "a later bounce from another agent supersedes it"
    if not person:
        return "skip_lead_gone", "lead no longer in FUB"
    if person.get("assignedPondId"):
        return "skip_moved_to_pond", f"now in pond {person.get('assignedPondId')}"
    current = _uid(person.get("assignedUserId"))
    if current != int(peter_user_id):
        name = (users.get(current or 0) or {}).get("name") or f"user {current}"
        return "skip_rerouted_since_bounce", f"now with {name}"
    updated = parse_stamp(person.get("updated"))
    if updated is not None and updated > verdict["bounced_at"] + EDIT_AFTER_BOUNCE_GRACE \
            and not any(abs(updated - ts) <= AUTOMATION_EDIT_WINDOW for ts in auto_times):
        editor = _uid(person.get("updatedById"))
        name = (users.get(editor or 0) or {}).get("name") or f"user {editor}"
        return "skip_edited_since_bounce", f"edited {_short(updated)} by {name}"
    agent = users.get(verdict["agent_id"] or 0) or {}
    if not agent or agent.get("status") != "Active":
        return "skip_agent_inactive", f"agent {verdict['agent_id']} is not an active user"
    if verdict["agent_id"] in excluded_ids:
        # rules.yaml excluded_user_ids: removed from automation or gone — a
        # lead goes back to them only on Peter's say, never automatically.
        return "skip_agent_excluded", f"{agent.get('name')} is in excluded_user_ids"
    return "restore", f"→ {agent.get('name') or verdict['agent_id']}"


def build_note(verdict: dict, agent_name: str, creator: str, approved: bool) -> str:
    what = "reassignment to Peter" if verdict["bounced_at"] else "warning"
    when = _short(verdict["bounced_at"] or verdict["warned_at"])
    if approved:
        cause = ("Peter reviewed it and confirmed the assignment was not his, so under "
                 "the speed-to-lead rule no timer should have run")
    else:
        cause = (f"This contact was added to Follow Up Boss by {creator} and was never "
                 "routed by Peter, so under the speed-to-lead rule no timer should have run")
    return (f"Speed-to-lead cleanup: this lead has been returned to {agent_name}. "
            "The speed-to-lead timer only applies when Peter assigns a lead to an agent. "
            f"{cause}, and the automatic {what} on {when} was a mistake.")


def apply_restore(db, fub, verdict: dict, peter_user_id: int, agent_name: str,
                  creator: str, approved: bool) -> str:
    """Commit one restore. Re-reads the lead first: a re-route that landed
    after the dry run still wins."""
    person_id = verdict["person_id"]
    agent_id = int(verdict["agent_id"])
    person = fub.get_person(person_id)
    if not person:
        db.log(CLEANUP_ACTION, "person_gone", person_id, {"agent_id": agent_id})
        return "person_gone"
    if person.get("assignedPondId") or _uid(person.get("assignedUserId")) != int(peter_user_id):
        db.log(CLEANUP_ACTION, "restore_skipped_rerouted", person_id, {
            "agent_id": agent_id, "now_assigned": person.get("assignedUserId"),
            "pond": person.get("assignedPondId")})
        return "restore_skipped_rerouted"
    fub.update_person(person_id, {"assignedUserId": agent_id})
    db.upsert_assignment_watch(person_id, agent_id)
    # FUB returns tags as strings or {"name": ...}; strip by NAME and write the
    # kept names back whole (there is no tag-removal call), as the repair does.
    names: List[str] = []
    for tag in person.get("tags") or []:
        name = tag.get("name") if isinstance(tag, dict) else tag
        if name:
            names.append(str(name))
    kept = [n for n in names if n.strip().lower() != BOUNCE_TAG]
    if len(kept) != len(names):
        fub.update_person(person_id, {"tags": kept})
    db.cancel_timer(person_id, agent_id)
    fub.add_note(person_id, CLEANUP_NOTE_SUBJECT,
                 build_note(verdict, agent_name, creator, approved))
    db.log(CLEANUP_ACTION, "restored", person_id, {
        "agent_id": agent_id,
        "why": verdict["why"],
        "approved_by_id": approved,
        "bounced_at": verdict["bounced_at"].isoformat() if verdict["bounced_at"] else None,
    })
    return "restored"


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Speed-to-lead gate cleanup.")
    parser.add_argument("--since", default="2026-08-25T00:00:00+00:00",
                        help="Judge warnings/reassignments at/after this ISO instant.")
    parser.add_argument("--commit", action="store_true",
                        help="Apply. Without it: list only, write nothing.")
    parser.add_argument("--also-restore", default="",
                        help="Comma-separated person ids Peter approved from the "
                             "UNDETERMINED list.")
    args = parser.parse_args(argv)

    since = dt.datetime.fromisoformat(args.since)
    if since.tzinfo is None:
        since = since.replace(tzinfo=UTC)
    approved_ids = {int(x) for x in args.also_restore.replace(" ", "").split(",") if x}

    os.environ.setdefault("FUB_DISABLE_SCHEDULER", "true")
    if not args.commit:
        # Belt and braces: a dry run must be unable to write even through a bug.
        os.environ["DRY_RUN"] = "true"

    from fub_automation.main import AuditDB, FollowUpBossClient, Rules, Settings

    settings = Settings.from_env()
    if not settings.fub_api_key:
        _p("FUB_API_KEY missing — nothing to judge.")
        return 2
    if args.commit and settings.dry_run:
        _p("--commit with DRY_RUN=true is contradictory — refusing to guess. "
           "Set DRY_RUN=false to commit.")
        return 2
    rules = Rules.load(settings.rules_path)
    peter = int(rules.peter_user_id or 2)
    db = AuditDB(settings.database_path)
    fub = FollowUpBossClient(settings)
    users: Dict[int, dict] = {int(u["id"]): u for u in fub.users() if u.get("id") is not None}

    def uname(uid) -> str:
        if uid is None:
            return "?"
        return (users.get(int(uid)) or {}).get("name") or f"user {uid}"

    now = dt.datetime.now(UTC)
    arm_rows = load_arm_rows(db.path)
    audit = db.recent_audit_rows(
        ["stale_agent_pond_reassignment", "pond_keyword_reassignment", "pond_opt_out_trash",
         "pond_nurture", "reply_intent_disqualification", "email_address_update",
         "long_term_nurture_enrollment", "annual_nurture_enrollment", "reply_detected",
         "new_lead_reassigned", "speed_to_lead_repair", CLEANUP_ACTION],
        since - dt.timedelta(days=30))
    cleaned: Set[int] = {int(r["person_id"]) for r in audit
                         if r.get("action") in ("speed_to_lead_repair", CLEANUP_ACTION)
                         and r.get("person_id")}
    person_cache: Dict[int, Optional[dict]] = {}

    def person_of(pid: int) -> Optional[dict]:
        if pid not in person_cache:
            try:
                person_cache[pid] = fub.get_person(pid)
            except Exception as exc:  # noqa: BLE001
                _p(f"  lead {pid}: FUB read failed ({str(exc)[:80]}) — treated as unreadable")
                person_cache[pid] = None
        return person_cache[pid]

    def creator_label(person: Optional[dict]) -> str:
        if not person:
            return "?"
        via = str(person.get("createdVia") or "?")
        cby = _uid(person.get("createdById"))
        src = str(person.get("source") or "").strip()
        src_part = f", source {src}" if src else ""
        if via.strip().lower() in HUMAN_CREATED_VIA and cby and cby > 0:
            return f"{uname(cby)} ({via}{src_part})"
        return f"lead source via {via}{src_part}"

    mode = "COMMIT" if args.commit else "DRY-RUN"
    _p(f"=== Speed-to-lead gate cleanup — {mode} — rule: arm only when Peter "
       f"(user {peter}) made the assignment ===")

    # ── A. active timers that fail the gate now ─────────────────────────────
    active = db.active_new_lead_timers()
    by_person: Dict[int, List[dict]] = collections.defaultdict(list)
    for timer in active:
        by_person[int(timer["person_id"])].append(timer)
    _p(f"\n=== A. ACTIVE timers: {len(active)} generation(s) on {len(by_person)} lead(s) ===")
    to_cancel: List[Tuple[int, dict]] = []
    for pid in sorted(by_person):
        gens = by_person[pid]
        person = person_of(pid)
        anchors = [parse_stamp(g.get("touch_anchor_at") or g.get("created_at")) for g in gens]
        anchor = min((a for a in anchors if a is not None), default=None)
        kinds = sorted({ARM_LABELS.get(arm_kind(arm_rows, pid, g["created_at"]), "unknown")
                        for g in gens})
        agent = uname(_uid(gens[0].get("assigned_user_id")))
        if not person:
            verdict = {"kind": "unknown", "why": "lead unreadable", "reason": "assigner_unknown"}
        else:
            v = resolve_assigner(person, peter, since=anchor,
                                 automation_edits=automation_write_times(audit, pid))
            verdict = {"kind": v.kind, "why": v.why, "reason": v.reason,
                       "assigner": uname(v.assigner_id) if v.assigner_id else None}
        fails = verdict["kind"] != "peter"
        _p(f"  [{'FAILS' if fails else 'passes'}] lead {pid} | agent {agent} | armed by "
           f"{'/'.join(kinds)} | gate: {verdict['kind']} ({verdict['why']}) | "
           f"added by {creator_label(person)}")
        if fails:
            to_cancel.append((pid, verdict))
    _p(f"  → {len(to_cancel)} active timer lead(s) fail the gate "
       f"({'will be' if args.commit else 'would be'} cancelled).")

    # ── B. warnings / bounces since `since` ─────────────────────────────────
    groups = collect_punished(db.path, since)
    latest_by_person: Dict[int, dt.datetime] = {}
    verdicts: List[dict] = []
    for (pid, agent_id), gens in groups.items():
        bounced = [parse_stamp(g.get("reassigned_at")) for g in gens]
        warned = [parse_stamp(g.get("warned_at")) for g in gens]
        bounced = [b for b in bounced if b is not None]
        warned = [w for w in warned if w is not None]
        punished_at = max(bounced or warned)
        prev = latest_by_person.get(pid)
        if prev is None or punished_at > prev:
            latest_by_person[pid] = punished_at
        kinds = {arm_kind(arm_rows, pid, g["created_at"]) for g in gens}
        verdicts.append({
            "person_id": pid,
            "agent_id": agent_id,
            "kinds": kinds,
            "armed_at": min(parse_stamp(g["created_at"]) or now for g in gens),
            "warned_at": min(warned) if warned else None,
            "bounced_at": max(bounced) if bounced else None,
            "punished_at": punished_at,
        })

    _p(f"\n=== B. Speed-to-lead warnings/bounces since {since.isoformat()}: "
       f"{len(verdicts)} (lead, agent) pair(s) on {len(latest_by_person)} lead(s) ===")
    verdicts.sort(key=lambda v: (v["punished_at"], v["person_id"]))
    tallies: Dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    restore_plan: List[dict] = []
    for v in verdicts:
        pid = v["person_id"]
        person = person_of(pid)
        v["verdict"], v["why"] = judge_history(person, v["agent_id"], v["kinds"], peter)
        v["latest_routing"] = v["punished_at"] == latest_by_person[pid]
        v["already_cleaned"] = pid in cleaned
        approved = pid in approved_ids and v["verdict"] == UNDETERMINED
        eligible = v["verdict"] == FAILS or approved
        status, detail = ("list_only_passes", "Peter's assignment — stands")
        if v["verdict"] != PASSES:
            status, detail = plan_restore(person, v, peter, users,
                                          automation_write_times(audit, pid),
                                          frozenset(rules.excluded_user_ids))
            if status == "restore" and not eligible:
                status, detail = "needs_peter", f"restore {detail} only if Peter names it"
        v["plan"], v["plan_detail"], v["approved"] = status, detail, approved
        creator = creator_label(person)
        v["creator"] = creator
        tallies["verdict"][f"{v['verdict']}: {v['why']}"] += 1
        tallies["plan"][status] += 1
        tallies["agent"][f"{uname(v['agent_id'])} — {v['verdict']}"] += 1
        tallies["added by"][creator.split(" (")[0] if "(" in creator else creator] += 1
        tallies["punished on (UTC date)"][v["punished_at"].date().isoformat()] += 1
        if v["verdict"] == PASSES:
            continue
        now_with = uname(_uid((person or {}).get("assignedUserId"))) if person else "?"
        kinds = "/".join(sorted(ARM_LABELS.get(k, k) for k in v["kinds"]))
        _p(f"  [{v['verdict']}] lead {pid} | agent {uname(v['agent_id'])} | added by {creator} "
           f"{_short(parse_stamp((person or {}).get('created')))} | armed {_short(v['armed_at'])} "
           f"by {kinds} | warned {_short(v['warned_at'])} | bounced {_short(v['bounced_at'])} | "
           f"now with {now_with} | {v['why']} | plan: {status} {detail}")
        if status == "restore":
            restore_plan.append(v)

    passes = [v for v in verdicts if v["verdict"] == PASSES]
    if passes:
        _p(f"\n  passes the gate (Peter added the lead) — {len(passes)}: "
           + ", ".join(str(v["person_id"]) for v in passes))
    for title, counter in tallies.items():
        _p(f"\n  by {title}:")
        for key, count in counter.most_common():
            _p(f"    {count:5d}  {key}")
    _p(f"\n  → {len(restore_plan)} bounced lead(s) "
       f"{'will be' if args.commit else 'would be'} restored to their agent.")

    if not args.commit:
        _p("\nDry-run: nothing was written (no FUB writes, no state rows).")
        return 0

    # ── commit ──────────────────────────────────────────────────────────────
    canceled = restored = skipped = failures = 0
    for pid, verdict in to_cancel:
        db.cancel_timer(pid)
        db.log(CLEANUP_ACTION, "timer_canceled", pid, {
            "gate": verdict.get("kind"), "why": verdict.get("why"),
            "reason": verdict.get("reason")})
        canceled += 1
    for v in restore_plan:
        try:
            status = apply_restore(db, fub, v, peter, uname(v["agent_id"]),
                                   v["creator"], v["approved"])
        except Exception as exc:  # noqa: BLE001
            failures += 1
            _p(f"  lead {v['person_id']}: RESTORE FAILED — {str(exc)[:120]}")
            continue
        if status == "restored":
            restored += 1
        else:
            skipped += 1
        _p(f"  lead {v['person_id']}: {status}")
    with open("speed_to_lead_gate_cleanup_summary.json", "w") as fh:
        json.dump({"canceled": canceled, "restored": restored, "skipped": skipped,
                   "failed": failures, "since": since.isoformat(),
                   "started_at": now.isoformat()}, fh)
    _p(f"\nCommit complete: {canceled} timer(s) cancelled, {restored} lead(s) restored, "
       f"{skipped} skipped at write time, {failures} failed.")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
