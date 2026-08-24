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

Walks every FUB person updated inside the window (any inbound message bumps
`updated`), pulls their message history, and classifies each inbound message
after our latest send with the SAME classifier the live scanner now uses
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
from typing import Dict, Iterator, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

UTC = dt.timezone.utc

#: Hard stop on the -updated walk: 60 pages of 100 is far past every lead the
#: pond can update in a fortnight, and a runaway loop must not eat the API.
MAX_PAGES = 60


def _msg_dt(message: dict):
    from fub_automation.main import parse_fub_datetime

    return parse_fub_datetime(
        message.get("dateCreated") or message.get("created") or message.get("date"))


def inbound_in_window(messages: List[dict], window_start: dt.datetime) -> List[Tuple[dt.datetime, dict]]:
    """Every inbound message at/after window_start, oldest first."""
    from fub_automation.main import is_inbound_message

    out: List[Tuple[dt.datetime, dict]] = []
    for msg in messages:
        if not is_inbound_message(msg):
            continue
        when = _msg_dt(msg)
        if when and when >= window_start:
            out.append((when, msg))
    out.sort(key=lambda item: item[0])
    return out


def latest_outbound_before(messages: List[dict], when: dt.datetime) -> Optional[dt.datetime]:
    """Our most recent send before `when` — the anchor the auto-reply timing
    heuristic measures from. None when the history holds no outbound, in which
    case timing cannot fire and only the marker/keyword rules apply."""
    from fub_automation.main import is_inbound_message

    best: Optional[dt.datetime] = None
    for msg in messages:
        if is_inbound_message(msg):
            continue
        sent = _msg_dt(msg)
        if sent and sent < when and (best is None or sent > best):
            best = sent
    return best


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


def already_recorded(db, person_id: int, reply_at: dt.datetime, window_start: dt.datetime) -> bool:
    """Does any reply/auto row already cover this exact inbound message?"""
    from fub_automation.main import parse_fub_datetime

    for row in db.recent_audit_rows(
            ["reply_detected", "auto_reply_detected"], window_start - dt.timedelta(days=1)):
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


def iter_recently_updated_people(fub, window_start: dt.datetime) -> Iterator[dict]:
    """Every FUB person whose `updated` falls inside the window, via the same
    cursor pagination the client uses, newest first. Any inbound message bumps
    `updated`, so every possible responder is in this walk."""
    from fub_automation.main import parse_fub_datetime

    params: Dict[str, object] = {"sort": "-updated", "limit": 100}
    pages = 0
    while pages < MAX_PAGES:
        data = fub._request("GET", "/people", params=dict(params))
        people = data.get("people", data.get("data", []))
        if not people:
            return
        for person in people:
            updated = parse_fub_datetime(person.get("updated"))
            if updated and updated < window_start:
                return
            yield person
        pages += 1
        next_cursor = data.get("_metadata", {}).get("next")
        if not next_cursor:
            return
        params["next"] = next_cursor


def person_has_recent_inbound(person_detail: dict, window_start: dt.datetime) -> bool:
    from fub_automation.main import parse_fub_datetime

    for key in ("lastReceivedEmail", "lastReceivedText"):
        value = person_detail.get(key)
        if value:
            parsed = parse_fub_datetime(value)
            if parsed and parsed >= window_start:
                return True
    return False


def process_person(engine, db, person_detail: dict, window_start: dt.datetime,
                   commit: bool) -> Optional[dict]:
    """Classify one lead's window and (on commit) act. Returns a summary line
    dict, or None when there was nothing to do."""
    from fub_automation.main import (
        SELLER_LEAD_TAG,
        SELLER_REPLIED_TAG,
        reply_message_body,
    )

    person_id = int(person_detail["id"])
    name = f"{person_detail.get('firstName', '')} {person_detail.get('lastName', '')}".strip() \
        or f"Lead #{person_id}"

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

    if opt_outs:
        if already_disqualified(db, person_id, window_start):
            return None
        when, msg = opt_outs[-1]
        if commit:
            engine._trash_opt_out_reply(person_id, person_detail, when, msg)
        return {"kind": "opt_out", "person_id": person_id, "name": name,
                "reply_at": when.isoformat(),
                "snippet": reply_message_body(msg)[:120]}

    if humans:
        when, msg = humans[-1]
        if already_recorded(db, person_id, when, window_start):
            return None
        if engine.has_any_tag(person_detail, ["Replied - Paused"]):
            return None
        snippet = reply_message_body(msg)[:300]
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
            "reply_snippet": reply_message_body(msg)[:200],
            "seconds_after_send": (round((when - anchor).total_seconds(), 1)
                                   if anchor else None),
            "contact_name": name,
            "backfilled": True,
        }, when)
    return {"kind": "auto_reply", "person_id": person_id, "name": name,
            "reply_at": when.isoformat(),
            "snippet": reply_message_body(msg)[:120]}


def run_backfill(engine, db, *, days: int, commit: bool) -> List[dict]:
    window_start = dt.datetime.now(UTC) - dt.timedelta(days=days)
    results: List[dict] = []
    scanned = detailed = 0
    for person in iter_recently_updated_people(engine.fub, window_start):
        scanned += 1
        if engine.is_excluded(person):
            continue
        person_detail = engine.fub.get_person(int(person["id"]))
        if not person_detail:
            continue
        detailed += 1
        if not person_has_recent_inbound(person_detail, window_start):
            continue
        try:
            outcome = process_person(engine, db, person_detail, window_start, commit)
        except Exception as exc:  # noqa: BLE001
            print(f"  ERROR processing lead {person.get('id')}: {exc}")
            continue
        if outcome:
            results.append(outcome)
            mode = "" if commit else " [DRY RUN — nothing written]"
            print(f"  {outcome['kind']:<10} {outcome['name']} (FUB {outcome['person_id']}) "
                  f"replied {outcome['reply_at']}: \"{outcome['snippet']}\"{mode}")
    print(f"Walked {scanned} recently-updated leads ({detailed} detail fetches).")
    return results


def send_summary(engine, results: List[dict], *, days: int, commit: bool) -> None:
    if not results:
        return
    by_kind: Dict[str, List[dict]] = {}
    for r in results:
        by_kind.setdefault(r["kind"], []).append(r)
    labels = {"human": "Real replies (now tagged Replied - Paused)",
              "opt_out": "Opt-outs (now trashed + tagged)",
              "auto_reply": "Auto-replies (classified, no action needed)"}
    mode = "" if commit else " — DRY RUN, nothing was written"
    lines = [f"Reply backfill over the last {days} days{mode}.", ""]
    html = [f"<p>Reply backfill over the last {days} days{mode}.</p>"]
    for kind in ("human", "opt_out", "auto_reply"):
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
    print(f"=== Missed-reply backfill — last {args.days} days — {mode} ===")
    results = run_backfill(engine, db, days=args.days, commit=args.commit)

    counts = {}
    for r in results:
        counts[r["kind"]] = counts.get(r["kind"], 0) + 1
    print(f"Done: {counts.get('human', 0)} real replies, {counts.get('opt_out', 0)} "
          f"opt-outs, {counts.get('auto_reply', 0)} auto-replies ({mode}).")
    send_summary(engine, results, days=args.days, commit=args.commit)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
