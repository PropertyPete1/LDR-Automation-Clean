#!/usr/bin/env python3
"""One-shot repair: re-judge recent reply alerts with the thread-lineage gate,
list the false positives, and (on --commit) un-pause the leads they froze.

WHAT HAPPENED

2026-08-28 22:37 UTC: "HOT LEAD REPLY: Angie Gonzalez" paged Peter, tagged
FUB 6340 "Replied - Paused" and counted her WARM — but Angie never replied.
The email was a LENDER's ("Re: Lender Intro Irene and Angie", email 52890's
thread), third-party correspondence FUB attached to her record and stamped
relatedPeople=[{personId: 6340, sentByPerson: True}] — field-for-field the
shape of a genuine reply (run 33218198212 measured it). The fix in main.py
(reply_thread_verified) now requires an inbound email's thread to hold one of
OUR audit-logged sends before it may alert. This script applies that same
judgment retroactively.

WHAT THIS DOES

For every reply_detected alert row (alert_sent / backfilled) in the last
--days days: re-read the lead's message history, find the message the alert
fired on (matched on the reply's own timestamp), and re-run the new gate.

  stands  — the alerted message sits on a thread with one of our sends (or is
            a text / has no threadId, where the gate does not apply), or some
            other inbound of theirs passes the gate. Nothing changes.
  unverified_review — the alerted message fails the gate but we DID email
            this lead: the anchor evidence may simply have aged out of the
            fetched history (Jose Muñoz, a documented genuine replier, judged
            exactly like Angie in the first dry run). Listed for a human.
            NEVER auto-cleared — absence of proof only clears a tag when the
            absence is provable.
  FALSE POSITIVE — structurally impossible: the lead has NO audit-logged bot
            email send in the whole lookback, so there was nothing of ours
            to reply to. Listed. On --commit:
              1. "Replied - Paused" (and nothing else) is removed from their
                 tags — the first automated tag removal in this repo, done as
                 read-filter-replace because FUB has no removal API.
              2. A FUB note explains the un-pause.
              3. A reply_false_positive_cleared row is written whose reply_at
                 names the voided alert — the scans, NEEDS A REPLY and the
                 telemetry replies_needed count all read that row to re-arm
                 the lead and drop the phantom "awaiting a human" entry.
            A false positive whose tag is already gone (removed by hand) still
            gets the row, status='tag_absent', so the phantom entries clear.

Opt-out trashings in the window are re-judged too but NEVER auto-reversed —
they are printed with a verdict for review by hand (untrashing a lead who
really did unsubscribe is a compliance violation; a human decides).

SAFETY

- Dry run unless --commit: prints every verdict, writes nothing — not to FUB
  and not to the DB.
- Idempotent: an alert already voided by a reply_false_positive_cleared row
  is skipped. Safe to re-run and to overlap with the live scanner.
- The tag replace re-reads the person's tags immediately before writing and
  removes ONLY "Replied - Paused"; every other tag is written back verbatim.

USAGE

    python3 sweep_reply_false_positives.py --days 7
    python3 sweep_reply_false_positives.py --days 7 --commit
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

#: Same lists the scanners watch — a lineage anchor can be weeks older than
#: the alert it vindicates, so the send lookback is wider than --days.
SEND_ACTIONS = ("pond_nurture", "agent_bot_email", "closed_congrats", "closed_drip",
                "long_term_nurture_drip", "instant_welcome_email", "seller_nurture")
SEND_STATUSES = ("sent", "email_sent", "completed")
SEND_LOOKBACK_DAYS = 60

#: How close a message timestamp must be to the alert's logged reply_at to be
#: "the message the alert fired on". The scanners store the message's own
#: timestamp, so this only absorbs parse jitter, not sync latency.
REPLY_MATCH_SECONDS = 2

PAUSE_TAG = "Replied - Paused"


def _details(row: dict) -> dict:
    try:
        parsed = json.loads(row.get("details") or "{}")
    except Exception:  # noqa: BLE001
        return {}
    return parsed if isinstance(parsed, dict) else {}


def send_times_by_person(db, since: dt.datetime) -> Dict[int, List[dt.datetime]]:
    from fub_automation.main import parse_fub_datetime

    times: Dict[int, List[dt.datetime]] = {}
    for row in db.recent_audit_rows(list(SEND_ACTIONS), since):
        pid = row.get("person_id")
        if not pid or row.get("status") not in SEND_STATUSES:
            continue
        sent_ts = parse_fub_datetime(row.get("created_at"))
        if sent_ts:
            times.setdefault(int(pid), []).append(sent_ts)
    return times


def has_any_bot_send(db, person_id: int) -> bool:
    """Has the bot EVER emailed this lead? All-time on purpose: 'nothing to
    reply to' must not be an artifact of the query horizon. With the 60-day
    anchor window alone, a genuine reply to a 70-day-old nurture thread
    judged identical to Angie — the absence has to be provable, and the
    audit log (append-only, person-indexed) can prove it cheaply."""
    action_ph = ",".join("?" for _ in SEND_ACTIONS)
    status_ph = ",".join("?" for _ in SEND_STATUSES)
    with db.connect() as con:
        row = con.execute(
            f"SELECT COUNT(*) FROM audit_log WHERE person_id=? "
            f"AND action IN ({action_ph}) AND status IN ({status_ph})",
            (person_id, *SEND_ACTIONS, *SEND_STATUSES),
        ).fetchone()
    return bool(row and row[0])


def already_voided(db, since: dt.datetime) -> set:
    """(person_id, reply_at) pairs a prior run already cleared."""
    voided = set()
    for row in db.recent_audit_rows(["reply_false_positive_cleared"], since):
        pid = row.get("person_id")
        reply_at = _details(row).get("reply_at")
        if pid and reply_at:
            voided.add((int(pid), reply_at))
    return voided


def find_alerted_message(messages: List[dict], reply_at: dt.datetime) -> Optional[dict]:
    """The message whose own timestamp the alert logged as reply_at."""
    from fub_automation.main import message_timestamp

    best = None
    best_gap = REPLY_MATCH_SECONDS + 1
    for msg in messages:
        when = message_timestamp(msg)
        if not when:
            continue
        gap = abs((when - reply_at).total_seconds())
        if gap <= REPLY_MATCH_SECONDS and gap < best_gap:
            best, best_gap = msg, gap
    return best


def judge_person(engine, db, person_id: int, reply_at: dt.datetime,
                 bot_sends: List[dt.datetime]) -> Tuple[str, dict]:
    """('stands'|'false_positive'|'unverified_review'|'unmatched', evidence).

    'stands' also covers the case where the ALERTED message fails the gate
    but some other inbound of theirs passes it — the pause is then justified
    by that other message, and clearing the tag would lose a real reply.

    'false_positive' — the auto-clearable verdict — requires structural
    impossibility: the lead has NO audit-logged bot email send in the whole
    lookback, so there was nothing of ours to reply to (Angie Gonzalez: zero
    send rows, alerted off a lender's thread by the wide sweep's -updated
    walk, which has no send precondition). A lead we DID email whose alerted
    message merely fails the lineage check is 'unverified_review' instead:
    the first dry run judged Jose Muñoz — a documented GENUINE replier whose
    anchor evidence had simply aged out of the fetched history — exactly the
    same as Angie, and clearing him would have un-paused a lead who really
    is waiting on a human. Absence of proof only clears a tag when the
    absence is provable.
    """
    from fub_automation.main import (
        inbound_messages_since,
        reply_thread_verified,
    )

    messages = [
        *engine.fub.get_emails(person_id, limit=25),
        *engine.fub.get_text_messages(person_id, limit=25),
    ]
    alerted = find_alerted_message(messages, reply_at)
    if alerted is None:
        return "unmatched", {"reason": "no message matches the logged reply_at"}
    if reply_thread_verified(alerted, messages, bot_sends):
        return "stands", {"thread_id": alerted.get("threadId"),
                          "bot_sends": len(bot_sends)}
    window_floor = reply_at - dt.timedelta(days=SEND_LOOKBACK_DAYS)
    other_verified = [
        (when, msg) for when, msg in inbound_messages_since(messages, window_floor)
        if msg is not alerted and reply_thread_verified(msg, messages, bot_sends)
    ]
    if other_verified:
        return "stands", {
            "thread_id": alerted.get("threadId"),
            "bot_sends": len(bot_sends),
            "note": "alerted message unverified, but another inbound passes the gate",
            "verified_at": other_verified[-1][0].isoformat(),
        }
    if bot_sends or has_any_bot_send(db, person_id):
        return "unverified_review", {"thread_id": alerted.get("threadId"),
                                     "bot_sends": len(bot_sends)}
    return "false_positive", {"thread_id": alerted.get("threadId"),
                              "bot_sends": 0}


def clear_pause_tag(engine, person: dict) -> Tuple[bool, List[str]]:
    """Remove ONLY the pause tag; everything else is written back verbatim.
    Returns (had_tag, kept_tag_names)."""
    names: List[str] = []
    for tag in person.get("tags") or []:
        name = tag.get("name") if isinstance(tag, dict) else tag
        if name:
            names.append(str(name))
    kept = [n for n in names if n.strip().lower() != PAUSE_TAG.lower()]
    had_tag = len(kept) != len(names)
    if had_tag:
        # merge_tags=False on purpose: FUB has no tag-removal API, so the
        # whole list is replaced with everything except the pause tag.
        engine.fub.update_person(int(person["id"]), {"tags": kept}, merge_tags=False)
    return had_tag, kept


def run_sweep(engine, db, *, days: int, commit: bool) -> List[dict]:
    from fub_automation.main import parse_fub_datetime

    now = dt.datetime.now(UTC)
    since = now - dt.timedelta(days=days)
    send_times = send_times_by_person(db, now - dt.timedelta(days=SEND_LOOKBACK_DAYS))
    voided = already_voided(db, since - dt.timedelta(days=1))

    alerts: List[dict] = []
    for row in db.recent_audit_rows(["reply_detected"], since):
        if row.get("status") not in ("alert_sent", "backfilled"):
            continue
        pid = row.get("person_id")
        if not pid:
            continue
        details = _details(row)
        reply_at_raw = details.get("reply_at") or row.get("created_at")
        reply_at = parse_fub_datetime(reply_at_raw)
        if not reply_at:
            continue
        alerts.append({
            "person_id": int(pid),
            "reply_at": reply_at,
            "reply_at_raw": str(reply_at_raw),
            "contact_name": (details.get("contact_name") or "").strip(),
            "channel": details.get("reply_channel") or "email",
            "snippet": details.get("reply_snippet") or "",
        })

    print(f"{len(alerts)} reply alert(s) in the last {days} days to re-judge.",
          flush=True)
    results: List[dict] = []
    judged_persons: set = set()
    for alert in alerts:
        pid = alert["person_id"]
        if (pid, alert["reply_at_raw"]) in voided:
            print(f"  skipped   FUB {pid} — already voided by a prior run", flush=True)
            continue
        try:
            verdict, evidence = judge_person(
                engine, db, pid, alert["reply_at"], send_times.get(pid, []))
        except Exception as exc:  # noqa: BLE001
            print(f"  ERROR judging FUB {pid}: {exc}", flush=True)
            continue
        name = alert["contact_name"] or f"Lead #{pid}"
        line = {**alert, "reply_at": alert["reply_at"].isoformat(),
                "verdict": verdict, **evidence, "name": name}
        results.append(line)
        print(f"  {verdict:<17} {name} (FUB {pid}) reply_at={line['reply_at']} "
              f"thread={evidence.get('thread_id')} "
              f"bot_sends={evidence.get('bot_sends', '?')}", flush=True)

        if verdict != "false_positive" or pid in judged_persons:
            continue
        judged_persons.add(pid)
        if not commit:
            print(f"    [DRY RUN] would clear '{PAUSE_TAG}' and void the alert",
                  flush=True)
            continue
        try:
            person = engine.fub.get_person(pid)
            if not person:
                print(f"    person {pid} unreadable — no clearing", flush=True)
                continue
            had_tag, _kept = clear_pause_tag(engine, person)
            if had_tag:
                engine.fub.add_note(
                    pid,
                    "Automation: false-positive reply alert cleared",
                    ("The 'Lead Replied' alert on this record was a false "
                     "positive: the inbound email sat on a thread the "
                     "automation never started (third-party correspondence "
                     f"attached to the record, thread {evidence.get('thread_id')}). "
                     f"The \"{PAUSE_TAG}\" tag has been removed and automation "
                     "resumed. No genuine reply from this lead was found."),
                )
            db.log("reply_false_positive_cleared",
                   "completed" if had_tag else "tag_absent", pid, {
                       "reply_at": alert["reply_at_raw"],
                       "thread_id": (str(evidence.get("thread_id"))
                                     if evidence.get("thread_id") is not None else None),
                       "removed_tag": PAUSE_TAG if had_tag else None,
                       "contact_name": name,
                   })
            line["cleared"] = "tag_removed" if had_tag else "tag_absent"
            print(f"    CLEARED ({line['cleared']})", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"    ERROR clearing FUB {pid}: {exc}", flush=True)

    # Opt-out trashings re-judged for the report only — reversing one is a
    # human decision, never this script's.
    for row in db.recent_audit_rows(
            ["reply_intent_disqualification", "pond_opt_out_trash"], since):
        pid = row.get("person_id")
        if not pid:
            continue
        pid = int(pid)
        details = _details(row)
        reply_at = parse_fub_datetime(details.get("reply_at"))
        verdict = "review_by_hand"
        if reply_at:
            try:
                verdict, _ = judge_person(engine, db, pid, reply_at,
                                          send_times.get(pid, []))
            except Exception as exc:  # noqa: BLE001
                verdict = f"error: {exc}"
        print(f"  opt-out   FUB {pid} {row.get('action')}/{row.get('status')} "
              f"→ {verdict} (never auto-reversed)", flush=True)

    return results


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Re-judge recent reply alerts with the thread-lineage gate.")
    parser.add_argument("--days", type=int, default=7,
                        help="Window of alerts to re-judge (default 7).")
    parser.add_argument("--commit", action="store_true",
                        help="Actually clear tags and write void rows. "
                             "Without it, a dry run that prints the verdicts.")
    args = parser.parse_args(argv)

    # Pin dry-run BEFORE the import so --commit is the only thing that can
    # enable writes, whatever the caller's env says (house idiom, see
    # backfill_missed_replies.py).
    os.environ["DRY_RUN"] = "false" if args.commit else "true"
    os.environ.setdefault("FUB_DISABLE_SCHEDULER", "true")

    from fub_automation.main import AuditDB, FollowUpBossClient, RuleEngine, Rules, Settings

    settings = Settings.from_env()
    if not settings.fub_api_key:
        print("FUB_API_KEY missing — cannot read message history. Nothing done.")
        return 2
    rules = Rules.load(settings.rules_path)
    db = AuditDB(settings.database_path)
    engine = RuleEngine(settings, rules, FollowUpBossClient(settings), db)

    mode = "COMMIT" if args.commit else "DRY RUN"
    print(f"=== Reply false-positive sweep — last {args.days} days — {mode} ===",
          flush=True)
    results = run_sweep(engine, db, days=args.days, commit=args.commit)
    false_positives = [r for r in results if r["verdict"] == "false_positive"]
    reviews = [r for r in results if r["verdict"] == "unverified_review"]
    cleared = [r for r in results if r.get("cleared")]
    print(f"Done: {len(results)} alert(s) judged, {len(false_positives)} false "
          f"positive(s){' cleared' if args.commit else ' (dry run — nothing written)'}, "
          f"{len(reviews)} left for human review.")
    # The workflow's post-push verify step reads this to know how many void
    # rows to EXPECT on the state branch — zero cleared is a legitimate
    # outcome, not a lost write, and must not fail the run.
    with open("sweep_fp_summary.json", "w") as fh:
        json.dump({"cleared": len(cleared), "judged": len(results)}, fh)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
