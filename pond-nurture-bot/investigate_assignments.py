#!/usr/bin/env python3
"""
DIAG (never merge): how late did speed-to-lead escalations and reply alerts
actually land once GitHub stopped firing the */5 and */10 crons on schedule
(2026-08-26 onward)?

READ-ONLY. The state DB pulled by the workflow is opened with sqlite
`mode=ro`: no AuditDB(), no migrations, no FUB calls, nothing pushed.

This repository and its run logs are PUBLIC, so this prints TIMESTAMPS ONLY:
no person ids, no names, no emails, no message text. People are replaced by a
per-run sequence number (p) that only groups one person's rows together here
and cannot be mapped back to FUB.

Machine-readable lines (one JSON object each):
  @@TIMER      one per new_lead_timers generation armed in the window
  @@SKIP       one per new_lead_timer/skipped_already_touched audit row
  @@REPLY      one per reply_detected audit row
  @@DISQ       one per reply_intent_disqualification / pond_opt_out_trash row
  @@OPTOUT     one per opt_outs ledger row
  @@SCAN       one per assignment_scan audit row (a timer pass ran)
  @@SENDAFTER  one per bot email sent to a person AFTER their reply/opt-out
               timestamp but BEFORE the bot recorded it
  @@COUNTS     action/status totals in the window
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sqlite3
import sys
from collections import Counter

EMAIL_ACTIONS = ("pond_nurture", "agent_bot_email", "closed_congrats", "closed_drip",
                 "long_term_nurture_drip", "instant_welcome_email", "seller_nurture",
                 "recruiting_email")
SENT_STATUSES = ("sent", "email_sent", "completed")
MATCH_SECONDS = 120


def parse(value):
    if not value:
        return None
    try:
        text = str(value).strip().replace("Z", "+00:00")
        out = dt.datetime.fromisoformat(text)
        return out if out.tzinfo else out.replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None


def iso(value):
    d = parse(value)
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if d else None


def details(raw):
    try:
        out = json.loads(raw or "{}")
        return out if isinstance(out, dict) else {}
    except ValueError:
        return {}


def emit(tag, obj):
    print(f"@@{tag} {json.dumps(obj, sort_keys=True)}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=1800)
    ap.add_argument("--focus", default="")  # accepted for the workflow's sake; unused
    args = ap.parse_args()

    db_path = os.environ.get("DATABASE_PATH", "data/fub_automation.sqlite3")
    if not os.path.exists(db_path):
        print(f"no state DB at {db_path}")
        return 1
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    now = dt.datetime.now(dt.timezone.utc)
    since = now - dt.timedelta(hours=args.hours)
    since_s = since.isoformat()
    print(f"window: {iso(since_s)} .. {iso(now.isoformat())}  (read-only, timestamps only)")

    people = {}

    def p(pid):
        if pid is None:
            return None
        return people.setdefault(int(pid), len(people) + 1)

    def audit(actions, since_value=since_s):
        marks = ",".join("?" for _ in actions)
        return [dict(r) for r in con.execute(
            f"SELECT created_at, person_id, action, status, details FROM audit_log "
            f"WHERE action IN ({marks}) AND created_at >= ? ORDER BY created_at",
            (*actions, since_value))]

    # ── audit rows keyed by person, for matching timers to their events ──
    by_person = {}
    for row in audit(["new_lead_timer", "new_lead_warning", "new_lead_reassigned",
                      "speed_to_lead_alert"], (since - dt.timedelta(days=2)).isoformat()):
        if row["person_id"] is not None:
            by_person.setdefault(int(row["person_id"]), []).append(row)

    def near(pid, when, action, statuses=None, window=MATCH_SECONDS):
        t = parse(when)
        if t is None:
            return None
        best = None
        for row in by_person.get(int(pid), []):
            if row["action"] != action or (statuses and row["status"] not in statuses):
                continue
            rt = parse(row["created_at"])
            if rt is None:
                continue
            gap = abs((rt - t).total_seconds())
            if gap <= window and (best is None or gap < best[0]):
                best = (gap, row)
        return best[1] if best else None

    cols = [r[1] for r in con.execute("PRAGMA table_info(new_lead_timers)")]
    has_anchor = "touch_anchor_at" in cols
    timers = [dict(r) for r in con.execute(
        "SELECT * FROM new_lead_timers WHERE created_at >= ? ORDER BY created_at", (since_s,))]
    for t in timers:
        pid = int(t["person_id"])
        armed = near(pid, t["created_at"], "new_lead_timer",
                     ("started_polling", "started_assignment_change"))
        d = details(armed["details"]) if armed else {}
        cancel = near(pid, t.get("canceled_at"), "new_lead_timer",
                      ("canceled_touched", "canceled_recruiting_source",
                       "canceled_repair_suppressed")) if t.get("canceled_at") else None
        warn = near(pid, t.get("warned_at"), "new_lead_warning") if t.get("warned_at") else None
        alert = near(pid, t["created_at"], "speed_to_lead_alert", window=600)
        emit("TIMER", {
            "p": p(pid),
            "armed": iso(t["created_at"]),
            "source": armed["status"] if armed else None,
            "fub_created": iso(d.get("fub_created_at")),
            "touch_anchor": iso(t.get("touch_anchor_at")) if has_anchor else None,
            "has_agent": t.get("assigned_user_id") is not None,
            "agent_alert": iso(alert["created_at"]) if alert else None,
            "warned": iso(t.get("warned_at")),
            "warn_kind": warn["status"] if warn else None,
            "reassigned": iso(t.get("reassigned_at")),
            "canceled": iso(t.get("canceled_at")),
            "cancel_reason": cancel["status"] if cancel else None,
        })

    for row in audit(["new_lead_timer"]):
        if row["status"] != "skipped_already_touched":
            continue
        d = details(row["details"])
        emit("SKIP", {"p": p(row["person_id"]), "at": iso(row["created_at"]),
                      "fub_created": iso(d.get("fub_created_at")),
                      "touch_anchor": iso(d.get("touch_anchor"))})

    for row in audit(["assignment_scan"]):
        d = details(row["details"])
        emit("SCAN", {"at": iso(row["created_at"]), "status": row["status"],
                      "observed": iso(d.get("observed_at"))})

    # ── replies and opt-outs: lead's own timestamp vs when the bot recorded it ──
    events = []  # (pid, reply_at, recorded_at, kind)
    for row in audit(["reply_detected"]):
        d = details(row["details"])
        emit("REPLY", {"p": p(row["person_id"]), "recorded": iso(row["created_at"]),
                       "status": row["status"], "reply_at": iso(d.get("reply_at")),
                       "channel": d.get("reply_channel"),
                       "recruit": bool(d.get("track")),
                       "backfilled": bool(d.get("backfilled"))})
        if row["status"] == "alert_sent" and row["person_id"] is not None and d.get("reply_at"):
            events.append((int(row["person_id"]), d.get("reply_at"), row["created_at"], "reply"))
    for row in audit(["reply_intent_disqualification", "pond_opt_out_trash"]):
        d = details(row["details"])
        emit("DISQ", {"p": p(row["person_id"]), "recorded": iso(row["created_at"]),
                      "action": row["action"], "status": row["status"],
                      "reply_at": iso(d.get("reply_at")),
                      "trigger": d.get("trigger"), "channel": d.get("channel")})
    for row in con.execute("SELECT person_id, opted_out_at, detected_at, channel, source "
                           "FROM opt_outs WHERE detected_at >= ? ORDER BY detected_at", (since_s,)):
        emit("OPTOUT", {"p": p(row["person_id"]), "opted_out_at": iso(row["opted_out_at"]),
                        "detected": iso(row["detected_at"]), "channel": row["channel"],
                        "source": row["source"]})
        events.append((int(row["person_id"]), row["opted_out_at"], row["detected_at"], "opt_out"))

    marks = ",".join("?" for _ in EMAIL_ACTIONS)
    smarks = ",".join("?" for _ in SENT_STATUSES)
    for pid, reply_at, recorded, kind in events:
        r, d = parse(reply_at), parse(recorded)
        if r is None or d is None or d <= r:
            continue
        for s in con.execute(
                f"SELECT created_at, action FROM audit_log WHERE person_id=? "
                f"AND action IN ({marks}) AND status IN ({smarks}) "
                f"AND created_at > ? AND created_at < ? ORDER BY created_at",
                (pid, *EMAIL_ACTIONS, *SENT_STATUSES, r.isoformat(), d.isoformat())):
            emit("SENDAFTER", {"p": p(pid), "kind": kind, "reply_at": iso(reply_at),
                               "recorded": iso(recorded), "sent": iso(s["created_at"]),
                               "action": s["action"]})

    counts = Counter()
    for row in con.execute(
            "SELECT action, status, COUNT(*) FROM audit_log WHERE created_at >= ? AND action IN "
            "('new_lead_timer','new_lead_warning','new_lead_reassigned','speed_to_lead_alert',"
            "'reply_detected','reply_intent_disqualification','pond_opt_out_trash',"
            "'assignment_scan','auto_reply_detected','unverified_inbound') GROUP BY action, status",
            (since_s,)):
        counts[f"{row[0]}/{row[1]}"] = row[2]
    emit("COUNTS", dict(sorted(counts.items())))
    print(f"done: {len(timers)} timers, {len(people)} people (sequence-numbered, not ids)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
