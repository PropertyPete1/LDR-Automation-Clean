#!/usr/bin/env python3
"""DIAG BRANCH ONLY (diag/skip-recheck) — never merge.

Read-only recheck for the 2026-09-24 cost audit: 11 pond leads the LLM skip
check said to skip (2026-09-11..23) that were drafted a day or three later.
For each one this prints the lead's HUMAN notes verbatim (bot-authored notes
are summarised by subject only), inbound texts, the pond_nurture audit trail
and any opt-out ledger row, so each skip can be judged against the original
notes rather than the bot's own skip reasons.

READ-ONLY: every FUB call is a GET, DRY_RUN is pinned, the state DB is pulled
and never pushed (the workflow has contents: read). Runs under the registered
investigate-assignments workflow, which passes --hours/--focus; both ignored.
"""
from __future__ import annotations

import argparse
import collections
import os
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

PIDS = [3725, 3883, 4017, 4461, 4504, 4556, 4804, 5019, 5103]

# Notes this bot (and Cowork) write. Summarised, not printed: the question is
# what HUMANS wrote about the lead.
BOT_SUBJECT_MARKERS = (
    "pond nurture", "automation:", "quarterly check-in email sent",
    "long-term nurture email sent", "instant welcome email sent",
    "seller nurture", "[cowork reengage]",
)
# Exactly fix 1's filter (fix/remember-note-checks), to show what it would hide.
FIX1_MARKERS = ("pond nurture", "check-in email sent", "long-term nurture email sent",
    "welcome email sent", "seller nurture email sent", "reassigned to lead pond",
    "pond lead reassigned", "moved to lead pond", "speed-to-lead warning",
    "untouched assignment warning")
FIX1_LIFESTYLE = re.compile(r"^\s*\[[^\]]{1,60}\]\s*(?:skipped automated follow-up|follow-up email sent)", re.I)


def fix1_hides(note):
    subject = str(note.get("subject") or "").lower()
    body = re.sub(r"<[^>]+>", " ", str(note.get("body") or ""))
    if any(m in subject for m in FIX1_MARKERS) or FIX1_LIFESTYLE.match(body):
        return True
    return "[cowork reengage]" in subject or "[cowork reengage]" in body.lower()


def _p(line: str = "") -> None:
    print(line, flush=True)


def _clean(text: str, limit: int) -> str:
    text = re.sub(r"<[^>]+>", " ", str(text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[:limit] + " …[truncated]"


def _is_bot_note(note: dict) -> bool:
    subject = str(note.get("subject") or note.get("title") or "").lower()
    body = str(note.get("body") or "").lower()
    return any(m in subject for m in BOT_SUBJECT_MARKERS) or "[cowork reengage]" in body[:200]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hours", default=None)
    parser.add_argument("--focus", default=None)
    parser.parse_args(argv)

    os.environ["DRY_RUN"] = "true"
    os.environ.setdefault("FUB_DISABLE_SCHEDULER", "true")

    from fub_automation.main import FollowUpBossClient, Settings, is_inbound_message

    settings = Settings.from_env()
    if not settings.fub_api_key:
        _p("FUB_API_KEY missing — nothing to check.")
        return 2
    fub = FollowUpBossClient(settings)
    con = sqlite3.connect(settings.database_path)
    con.row_factory = sqlite3.Row

    for pid in PIDS:
        _p("=" * 100)
        person = fub.get_person(pid) or {}
        name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip()
        tags = [t.get("name") if isinstance(t, dict) else t for t in (person.get("tags") or [])]
        _p(f"LEAD {pid} {name!r} stage={person.get('stage')!r} source={person.get('source')!r} "
           f"assignedTo={person.get('assignedTo')!r} pond={person.get('assignedPondId')} "
           f"created={person.get('created')}")
        _p(f"  tags={tags}")
        _p(f"  emails_on_record={len(person.get('emails') or [])} "
           f"unsubscribed_flags={[k for k in ('unsubscribed', 'emailOptOut', 'unsubscribedEmail', 'isUnsubscribed') if person.get(k)]}")

        ledger = con.execute("SELECT * FROM opt_outs WHERE person_id=?", (pid,)).fetchall()
        _p(f"  opt-out ledger: {[dict(r) for r in ledger] or 'none'}")
        rows = con.execute(
            "SELECT created_at, action, status, details FROM audit_log WHERE person_id=? "
            "AND created_at >= '2026-09-08' AND action IN ('pond_nurture','seller_nurture') "
            "ORDER BY created_at", (pid,)).fetchall()
        _p("  pond/seller audit since 09-08:")
        for r in rows:
            _p(f"    {r['created_at'][:16]} {r['action']} {r['status']} {_clean(r['details'], 180)}")

        notes = fub.get_notes(pid, limit=100)
        human = [n for n in notes if not _is_bot_note(n)]
        bot = [n for n in notes if _is_bot_note(n)]
        by_subject = collections.Counter(str(n.get("subject") or "")[:60] for n in bot)
        _p(f"  notes: {len(notes)} total, {len(human)} human/other, {len(bot)} bot-authored")
        _p(f"  bot notes by subject: {dict(by_subject)}")
        _p("  NOTES MENTIONING tiffany/automation/remove (newest first):")
        for n in notes:
            text = f"{n.get('subject') or ''} {n.get('body') or ''}".lower()
            if not re.search(r"tiffany|automation|remov|do not|don't", text):
                continue
            tag = "HIDDEN-BY-FIX1" if fix1_hides(n) else "KEPT"
            _p(f"   - [{tag}] [{str(n.get('created') or '')[:10]}] by={n.get('createdBy')!r} subject={_clean(n.get('subject'), 80)!r}")
            _p(f"     {_clean(n.get('body'), 500)}")
        kept = [n for n in notes if not fix1_hides(n)]
        _p(f"  fix1 keeps {len(kept)} of {len(notes)} notes as evidence")
        try:
            texts = fub.get_text_messages(pid, limit=20)
        except Exception as exc:  # noqa: BLE001
            texts = []
            _p(f"  texts: fetch failed ({exc})")
        inbound = [t for t in texts if is_inbound_message(t)]
        _p(f"  texts: {len(texts)} fetched, {len(inbound)} inbound")
        for t in inbound[:10]:
            _p(f"   < [{str(t.get('created') or '')[:10]}] {_clean(t.get('message') or t.get('body'), 200)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
