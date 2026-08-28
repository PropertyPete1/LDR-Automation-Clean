#!/usr/bin/env python3
"""One-shot repair: find and process the replies the broken scanner never saw.

WHAT HAPPENED

scan_reply_detection shipped 2026-07-12 testing a field FUB does not send
(`isReceived`; the real field is `isIncoming`), so it detected nothing from the
day it shipped: every inbound reply in that window went untagged, uncounted and
unanswered. The known casualties of the last fortnight alone: Joe Muñoz
(replied twice 2026-08-22, never surfaced), Stephen Herrera ("UNSUBSCRIBE"
2026-08-23, never trashed — a compliance miss), and two same-second
autoresponders (2026-08-23) that sat unclassified.

WHAT THIS DOES

Takes every lead the bot emailed in the last --send-lookback days (from
audit_log — OUR authoritative record; the first dry run proved FUB's `updated`
field blind to synced email, so no FUB ordering is trusted for discovery),
reads each lead's message history directly, and classifies each inbound
message in the window with the SAME classifier the live scanner now uses
(classify_reply in main.py):

  opt_out — trash + unsubscribed/opt-out-auto-trash tags + FUB note, one
            reply_intent_disqualification row. Logged at commit time: the
            trashing is happening now, whenever the reply arrived.
  human   — "Replied - Paused" tag + FUB note + a reply_detected row with
            status='backfilled', BACKDATED to the reply's own timestamp so the
            funnel's WARM lands in the week the person actually wrote, and the
            daily summary's NEEDS A REPLY ages them from that moment. No
            per-lead alert email — after a fortnight, one consolidated summary
            to Peter beats a burst of "hot lead" pages.
  auto    — an auto_reply_detected row, likewise backdated. Nothing else.

SAFETY

- Dry run unless --commit. The dry run prints exactly what it would do, per
  lead, and writes nothing — not to FUB and not to the DB.
- Idempotent: a lead whose latest inbound already has a reply_detected /
  auto_reply_detected row (matched on the reply's own timestamp), or who is
  already tagged "Replied - Paused", or already disqualified, is skipped. Safe
  to re-run, and safe to overlap with the live scanner.
- Suppression is respected: excluded stages/tags are never touched.
- One summary email to Peter at the end (respects DRY_RUN).

USAGE

    python3 backfill_missed_replies.py --days 14
    python3 backfill_missed_replies.py --days 14 --commit
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

#: The audit actions/statuses that mean a real email left the building —
#: matching scan_reply_detection's watch-list build in main.py.
SEND_ACTIONS = ("pond_nurture", "agent_bot_email", "closed_congrats", "closed_drip",
                "long_term_nurture_drip", "instant_welcome_email", "seller_nurture")
SEND_STATUSES = ("sent", "email_sent", "completed")


def inbound_in_window(messages: List[dict], window_start: dt.datetime) -> List[Tuple[dt.datetime, dict]]:
    """Every inbound message after window_start, oldest first. Delegates to
    main.py so this repair and the live scanners can never drift apart."""
    from fub_automation.main import inbound_messages_since

    return inbound_messages_since(messages, window_start)


def latest_outbound_before(messages: List[dict], when: dt.datetime) -> Optional[dt.datetime]:
    """The live scanners' anchor helper, re-exported for this script's tests."""
    from fub_automation.main import latest_outbound_before as _impl

    return _impl(messages, when)


def classify_window(
    engine, messages: List[dict], window_start: dt.datetime
) -> List[Tuple[dt.datetime, dict, str]]:
    """(when, message, kind) for every inbound message in the window."""
    from fub_automation.main import classify_reply

    classified = []
    for when, msg in inbound_in_window(messages, window_start):
        anchor = latest_outbound_before(messages, when)
        # No outbound found: anchor far in the past so the timing heuristic
        # cannot claim the message; keywords and markers still can.
        send_dt = anchor or (when - dt.timedelta(days=3650))
        classified.append((when, msg, classify_reply(msg, send_dt, when, engine._OPT_OUT_KEYWORDS)))
    return classified


def already_recorded(db, person_id: int, reply_at: dt.datetime, window_start: dt.datetime,
                     actions: Tuple[str, ...] = ("reply_detected", "auto_reply_detected"),
                     ) -> bool:
    """Does any reply/auto row already cover this exact inbound message?"""
    from fub_automation.main import parse_fub_datetime

    for row in db.recent_audit_rows(list(actions), window_start - dt.timedelta(days=1)):
        if int(row.get("person_id") or 0) != person_id:
            continue
        try:
            details = json.loads(row.get("details") or "{}")
        except Exception:  # noqa: BLE001
            details = {}
        seen = parse_fub_datetime(details.get("reply_at")) \
            or parse_fub_datetime(row.get("created_at"))
        if seen and seen >= reply_at:
            return True
    return False


def already_disqualified(db, person_id: int, window_start: dt.datetime) -> bool:
    for row in db.recent_audit_rows(
            ["reply_intent_disqualification", "pond_opt_out_trash"],
            window_start - dt.timedelta(days=1)):
        if int(row.get("person_id") or 0) == person_id:
            return True
    return False


def log_backdated(db, action: str, status: str, person_id: int, details: dict,
                  created_at: dt.datetime) -> None:
    """An audit row stamped with the reply's own moment, not the repair's.

    The funnel and the digest window by created_at; a fortnight of replies all
    landing "today" would count one absurd day instead of the real fortnight.
    """
    with db.connect() as con:
        con.execute(
            "INSERT INTO audit_log(created_at, person_id, action, status, details) "
            "VALUES (?, ?, ?, ?, ?)",
            (created_at.isoformat(), person_id, action, status,
             json.dumps(details, sort_keys=True)),
        )


def candidates_from_audit(db, send_lookback_days: int) -> List[int]:
    """Every lead the bot emailed inside the lookback, most recent send first.

    Discovery deliberately does NOT come from FUB's `updated` ordering. The
    first dry run (2026-08-24, run 32757820303) proved that surface blind on
    real data: 65 records "updated" in a fortnight that provably contained at
    least four replies — neither a synced send nor a synced inbound email
    touches the person record's `updated`. Our audit_log is the authoritative
    list of everyone we wrote to, and the messages themselves are then read
    directly — the same surface the live 10-minute scanner detects on.

    The lookback is wider than the reply window on purpose: Joe Muñoz answered
    on Aug 22 a thread last touched July 4, so the send that earns a lead a
    look can be weeks older than the reply we are looking for.
    """
    since = dt.datetime.now(UTC) - dt.timedelta(days=send_lookback_days)
    seen: set = set()
    ordered: List[int] = []
    # recent_audit_rows returns newest-first, so leads with the freshest sends
    # — the likeliest repliers — are checked first.
    for row in db.recent_audit_rows(list(SEND_ACTIONS), since):
        pid = row.get("person_id")
        if not pid or row.get("status") not in SEND_STATUSES:
            continue
        pid = int(pid)
        if pid not in seen:
            seen.add(pid)
            ordered.append(pid)
    return ordered


def send_times_from_audit(db, send_lookback_days: int) -> Dict[int, List[dt.datetime]]:
    """Every bot send time per lead — the thread-lineage anchors
    (reply_thread_verified in main.py)."""
    from fub_automation.main import parse_fub_datetime

    since = dt.datetime.now(UTC) - dt.timedelta(days=send_lookback_days)
    times: Dict[int, List[dt.datetime]] = {}
    for row in db.recent_audit_rows(list(SEND_ACTIONS), since):
        pid = row.get("person_id")
        if not pid or row.get("status") not in SEND_STATUSES:
            continue
        sent_ts = parse_fub_datetime(row.get("created_at"))
        if sent_ts:
            times.setdefault(int(pid), []).append(sent_ts)
    return times


def process_person(engine, db, person_detail: dict, window_start: dt.datetime,
                   commit: bool, messages: Optional[List[dict]] = None,
                   bot_sends: Optional[List[dt.datetime]] = None) -> Optional[dict]:
    """Classify one lead's window and (on commit) act. Returns a summary line
    dict, or None when there was nothing to do."""
    from fub_automation.main import (
        SELLER_LEAD_TAG,
        SELLER_REPLIED_TAG,
        reply_display_snippet,
        reply_thread_verified,
    )

    person_id = int(person_detail["id"])
    name = f"{person_detail.get('firstName', '')} {person_detail.get('lastName', '')}".strip() \
        or f"Lead #{person_id}"

    if messages is None:
        messages = [
            *engine.fub.get_emails(person_id, limit=25),
            *engine.fub.get_text_messages(person_id, limit=25),
        ]
    classified = classify_window(engine, messages, window_start)
    if not classified:
        return None

    opt_outs = [(w, m) for w, m, kind in classified if kind == "opt_out"]
    humans = [(w, m) for w, m, kind in classified if kind == "human"]
    autos = [(w, m) for w, m, kind in classified if kind == "auto_reply"]

    # Opt-outs need lineage too (same gate as the live scanners): FUB's
    # `unsubscribed` flag rides on synced third-party mail, and trashing the
    # LEAD off a stranger's unsubscribe click must never happen. Unverified
    # opt-outs fall through to the unverified-review branch below.
    verified_opt_outs = [(w, m) for w, m in opt_outs
                         if reply_thread_verified(m, messages, bot_sends or [])]
    if verified_opt_outs:
        if already_disqualified(db, person_id, window_start):
            return None
        when, msg = verified_opt_outs[-1]
        if commit:
            engine._trash_opt_out_reply(person_id, person_detail, when, msg)
        return {"kind": "opt_out", "person_id": person_id, "name": name,
                "reply_at": when.isoformat(),
                "snippet": reply_display_snippet(msg)[:120]}
    humans = sorted(
        [*humans, *[(w, m) for w, m in opt_outs
                    if not reply_thread_verified(m, messages, bot_sends or [])]],
        key=lambda item: item[0])

    if humans:
        # Thread lineage, same gate as the live scanners: only an inbound on
        # a thread we started may tag or count. Third-party mail FUB attached
        # to the record is recorded for review instead.
        verified = [(w, m) for w, m in humans
                    if reply_thread_verified(m, messages, bot_sends or [])]
        if not verified:
            when, msg = humans[-1]
            if already_recorded(db, person_id, when, window_start,
                                actions=("reply_detected", "auto_reply_detected",
                                         "unverified_inbound")):
                return None
            if commit:
                log_backdated(db, "unverified_inbound", "review", person_id, {
                    "reply_at": when.isoformat(),
                    "thread_id": (str(msg.get("threadId"))
                                  if msg.get("threadId") is not None else None),
                    "reply_snippet": reply_display_snippet(msg)[:200],
                    "contact_name": name,
                    "backfilled": True,
                }, when)
            return {"kind": "unverified", "person_id": person_id, "name": name,
                    "reply_at": when.isoformat(),
                    "snippet": reply_display_snippet(msg)[:120]}
        humans = verified
        when, msg = humans[-1]
        if already_recorded(db, person_id, when, window_start):
            return None
        if engine.has_any_tag(person_detail, ["Replied - Paused"]):
            return None
        snippet = reply_display_snippet(msg)[:300]
        channel = "email" if msg.get("subject") is not None else "text"
        if commit:
            tags = ["Replied - Paused"]
            if engine.has_any_tag(person_detail, [SELLER_LEAD_TAG]):
                tags.append(SELLER_REPLIED_TAG)
            engine.fub.update_person(person_id, {"tags": tags}, merge_tags=True)
            engine.fub.add_note(
                person_id,
                "\U0001f525 Automation: Missed Reply Found — All Automation Paused",
                (f"This lead replied on {when.isoformat()} and the reply was missed by a "
                 f"reply-detection bug (fixed). All automation is now **paused**.\n\n"
                 f"\U0001f4e8 Reply channel: {channel}\n"
                 f"\U0001f4ac Reply snippet: \"{snippet}\"\n\n"
                 f"✅ They have been waiting since then — please review and respond, "
                 f"then remove the \"Replied - Paused\" tag to resume automation."),
            )
            log_backdated(db, "reply_detected", "backfilled", person_id, {
                "reply_channel": channel,
                "reply_snippet": snippet[:200],
                "reply_at": when.isoformat(),
                "contact_name": name,
                "backfilled": True,
            }, when)
        return {"kind": "human", "person_id": person_id, "name": name,
                "reply_at": when.isoformat(), "snippet": snippet[:120]}

    when, msg = autos[-1]
    if already_recorded(db, person_id, when, window_start):
        return None
    if commit:
        anchor = latest_outbound_before(messages, when)
        log_backdated(db, "auto_reply_detected", "classified", person_id, {
            "reply_at": when.isoformat(),
            "reply_snippet": reply_display_snippet(msg)[:200],
            "seconds_after_send": (round((when - anchor).total_seconds(), 1)
                                   if anchor else None),
            "contact_name": name,
            "backfilled": True,
        }, when)
    return {"kind": "auto_reply", "person_id": person_id, "name": name,
            "reply_at": when.isoformat(),
            "snippet": reply_display_snippet(msg)[:120]}


def run_backfill(engine, db, *, days: int, commit: bool,
                 send_lookback_days: int = 60) -> List[dict]:
    window_start = dt.datetime.now(UTC) - dt.timedelta(days=days)
    candidates = candidates_from_audit(db, send_lookback_days)
    send_times = send_times_from_audit(db, send_lookback_days)
    print(f"Candidates: {len(candidates)} leads the bot emailed in the last "
          f"{send_lookback_days} days; looking for inbound in the last {days}.",
          flush=True)
    results: List[dict] = []
    checked = with_inbound = 0
    for person_id in candidates:
        checked += 1
        if checked % 250 == 0:
            print(f"  …{checked}/{len(candidates)} message histories checked, "
                  f"{with_inbound} with fresh inbound so far", flush=True)
        try:
            # Straight to the messages — no person fetch, no reliance on
            # lastReceived* clocks. Most leads have no fresh inbound and cost
            # exactly these two calls.
            messages = [
                *engine.fub.get_emails(person_id, limit=25),
                *engine.fub.get_text_messages(person_id, limit=25),
            ]
            if not inbound_in_window(messages, window_start):
                continue
            with_inbound += 1
            person_detail = engine.fub.get_person(person_id)
            if not person_detail or engine.is_excluded(person_detail):
                continue
            outcome = process_person(
                engine, db, person_detail, window_start, commit, messages=messages,
                bot_sends=send_times.get(person_id, []))
        except Exception as exc:  # noqa: BLE001
            print(f"  ERROR processing lead {person_id}: {exc}", flush=True)
            continue
        if outcome:
            results.append(outcome)
            mode = "" if commit else " [DRY RUN — nothing written]"
            print(f"  {outcome['kind']:<10} {outcome['name']} (FUB {outcome['person_id']}) "
                  f"replied {outcome['reply_at']}: \"{outcome['snippet']}\"{mode}", flush=True)
    print(f"Checked {checked} emailed leads; {with_inbound} had inbound in the window.",
          flush=True)
    return results


def send_summary(engine, results: List[dict], *, days: int, commit: bool) -> None:
    if not results:
        return
    by_kind: Dict[str, List[dict]] = {}
    for r in results:
        by_kind.setdefault(r["kind"], []).append(r)
    labels = {"human": "Real replies (now tagged Replied - Paused)",
              "opt_out": "Opt-outs (now trashed + tagged)",
              "auto_reply": "Auto-replies (classified, no action needed)",
              "unverified": "Unverified inbound (no thread we started — review)"}
    mode = "" if commit else " — DRY RUN, nothing was written"
    lines = [f"Reply backfill over the last {days} days{mode}.", ""]
    html = [f"<p>Reply backfill over the last {days} days{mode}.</p>"]
    for kind in ("human", "opt_out", "auto_reply", "unverified"):
        if kind not in by_kind:
            continue
        lines.append(f"{labels[kind]} — {len(by_kind[kind])}:")
        html.append(f"<h3>{labels[kind]} — {len(by_kind[kind])}</h3><ul>")
        for r in by_kind[kind]:
            link = f"https://www.followupboss.com/2/people/view/{r['person_id']}"
            lines.append(f"  • {r['name']} — replied {r['reply_at']} — \"{r['snippet']}\" → {link}")
            html.append(f"<li><strong>{r['name']}</strong> — replied {r['reply_at']} — "
                        f"<em>&ldquo;{r['snippet']}&rdquo;</em> — <a href='{link}'>Open in FUB</a></li>")
        lines.append("")
        html.append("</ul>")
    lines.append("The real replies now appear in the daily summary's NEEDS A REPLY "
                 "section until each one gets an answer.")
    html.append("<p>The real replies now appear in the daily summary's NEEDS A REPLY "
                "section until each one gets an answer.</p>")
    engine.email.send(
        engine.rules.owner_email,
        f"\U0001f4ec Missed-reply backfill: {len(results)} replies processed",
        "\n".join(lines),
        from_email=engine.rules.owner_email,
        html_body="".join(html),
    )


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Retroactively process replies the broken scanner missed.")
    parser.add_argument("--days", type=int, default=14,
                        help="Window of inbound messages to repair (default 14).")
    parser.add_argument("--send-lookback", type=int, default=60,
                        help="How far back a bot send earns a lead a look (default 60): "
                             "a reply in the window can answer a much older thread.")
    parser.add_argument("--commit", action="store_true",
                        help="Actually write. Without it, a dry run that prints the plan.")
    args = parser.parse_args(argv)

    # The FUB client and EmailSender read dry-run from Settings, which reads it
    # from the environment — pin it BEFORE the import so --commit is the only
    # thing that can enable writes, whatever the caller's env says.
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
    print(f"=== Missed-reply backfill — last {args.days} days — {mode} ===", flush=True)
    results = run_backfill(engine, db, days=args.days, commit=args.commit,
                           send_lookback_days=args.send_lookback)

    counts = {}
    for r in results:
        counts[r["kind"]] = counts.get(r["kind"], 0) + 1
    print(f"Done: {counts.get('human', 0)} real replies, {counts.get('opt_out', 0)} "
          f"opt-outs, {counts.get('auto_reply', 0)} auto-replies ({mode}).")
    send_summary(engine, results, days=args.days, commit=args.commit)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
