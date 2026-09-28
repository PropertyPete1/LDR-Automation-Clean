#!/usr/bin/env python3
"""TEMPORARY read-only probe — this branch only, deleted before the PR is ready.

Round 2 (2026-09-28). Round 1 (run 36367093517) showed four createdVia values
on the account — API, Email Parsing, Import, Manually — and that the default
/people payload lacks createdById. Open questions this round answers:

1. Are the API-channel contacts credited to non-Peter users (674 to Steven, 26
   to Abby, ...) lead-source integrations on their API keys, or people adding
   contacts by hand from the FUB mobile app? Evidence per (createdVia, creator)
   group: source spread (blank = "<unspecified>"), sourceUrl / leadFlowId
   presence, updated-within-15s-of-created share (an import stamps the same
   second; the UI's add-and-assign a few seconds later), and the share created
   inside Central business hours.
2. Does fields=allFields keep the notes that includeNotes=true adds? Measured on
   leads known to carry notes (the cleanup-restored 9599..9603).
3. Are the TypeScript bots still writing "sent" notes? A sample of pond leads
   and of the bot agents' leads, most recently active first.

Every call is a GET. No lead PII: ids, staff names, field names, counts, dates.
"""
from __future__ import annotations

import collections
import datetime as dt
import os
import re
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
os.environ["DRY_RUN"] = "true"
os.environ.setdefault("FUB_DISABLE_SCHEDULER", "true")

from fub_automation.assigner import parse_stamp  # noqa: E402
from fub_automation.main import FollowUpBossClient, Settings  # noqa: E402

CT = ZoneInfo("America/Chicago")
UTC = dt.timezone.utc
NOTED_LEADS = [9599, 9600, 9601, 9602, 9603]
AGENT_BOT_SENT = re.compile(r"^\[[^\]]+\]\s*Follow-up email sent", re.IGNORECASE)
AGENT_BOT_SKIP = re.compile(r"^\[[^\]]+\]\s*Skipped automated follow-up", re.IGNORECASE)
TS_POND_SENT = re.compile(r"Automated two-week pond nurture outreach sent|^pond nurture .* sent", re.IGNORECASE)


def blank(source) -> bool:
    return str(source or "").strip().lower() in {"", "<unspecified>"}


def main() -> int:
    settings = Settings.from_env()
    if not settings.fub_api_key:
        print("FUB_API_KEY missing")
        return 2
    fub = FollowUpBossClient(settings)
    users = {int(u["id"]): u for u in fub.users() if u.get("id") is not None}

    def uname(uid):
        if uid is None or uid == "":
            return "-"
        if int(uid) <= 0:
            return f"system ({uid})"
        return (users.get(int(uid)) or {}).get("name") or f"user {uid}"

    print("=== 1. createdVia x creator: what the records look like ===", flush=True)
    people = fub.get_people(fields="allFields")
    print(f"  people: {len(people)}", flush=True)
    groups = collections.defaultdict(list)
    for p in people:
        groups[(str(p.get("createdVia") or "<missing>"), uname(p.get("createdById")))].append(p)
    for (via, who), rows in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        n = len(rows)
        sources = collections.Counter("<blank>" if blank(p.get("source")) else str(p.get("source")) for p in rows)
        with_url = sum(1 for p in rows if p.get("sourceUrl"))
        with_flow = sum(1 for p in rows if p.get("leadFlowId"))
        same_second = 0
        within_15s = 0
        business_hours = 0
        weekday = 0
        stamped = 0
        for p in rows:
            c, u = parse_stamp(p.get("created")), parse_stamp(p.get("updated"))
            if c and u:
                stamped += 1
                gap = (u - c).total_seconds()
                same_second += gap <= 1
                within_15s += gap <= 15
            if c:
                local = c.astimezone(CT)
                business_hours += 8 <= local.hour < 20
                weekday += local.weekday() < 5
        print(f"  {n:5d}  {via:<14} by {who:<20} sourceUrl {with_url:5d}  leadFlowId {with_flow:5d}  "
              f"updated==created {same_second:5d}  within15s {within_15s:5d}  "
              f"created 8am-8pm CT {business_hours:5d}  weekday {weekday:5d}", flush=True)
        print(f"         sources: {sources.most_common(8)}", flush=True)

    print("\n=== 2. does fields=allFields keep includeNotes notes? (leads known to carry a note) ===", flush=True)
    for pid in NOTED_LEADS:
        for label, extra in (("default+includeNotes", {}), ("allFields+includeNotes", {"fields": "allFields"})):
            try:
                data = fub._request("GET", "/people", params={"id": pid, "includeNotes": "true", **extra})
            except Exception as exc:  # noqa: BLE001
                print(f"  lead {pid} {label}: FAILED {str(exc)[:160]}", flush=True)
                continue
            recs = data.get("people", [])
            for r in recs:
                print(f"  lead {pid} {label}: keys {len(r)}; 'notes' key present {('notes' in r)}; "
                      f"notes {len(r.get('notes') or [])}; createdById present {('createdById' in r)}", flush=True)
        notes = fub.get_notes(pid, limit=10)
        print(f"  lead {pid} GET /notes: {len(notes)} note(s)", flush=True)

    print("\n=== 3. are the TypeScript bots still writing notes? (30d, sampled) ===", flush=True)
    since = dt.datetime.now(UTC) - dt.timedelta(days=30)
    samples = {"pond 2, most recently active": fub.get_people(pondId=2, sort="-lastActivity", limit=40)}
    for uid in (35, 31, 28, 1):  # Laila, Stefanie, Abby, Steven
        samples[f"assigned to {uname(uid)}, most recently active"] = fub.get_people(
            assignedUserId=uid, sort="-lastActivity", limit=25)
    for label, rows in samples.items():
        kinds = collections.Counter()
        seen = 0
        for p in rows:
            pid = int(p["id"])
            try:
                notes = fub.get_notes(pid, limit=50)
            except Exception:  # noqa: BLE001
                continue
            seen += 1
            for n in notes:
                created = parse_stamp(n.get("created") or n.get("createdAt"))
                if not created or created < since:
                    continue
                body = str(n.get("body") or "")
                subject = str(n.get("subject") or "")
                if AGENT_BOT_SENT.match(body):
                    kinds["agent-bot: Follow-up email sent"] += 1
                elif AGENT_BOT_SKIP.match(body):
                    kinds["agent-bot: Skipped automated follow-up"] += 1
                elif TS_POND_SENT.search(body):
                    kinds["ts pond nurture: outreach sent"] += 1
                elif subject.startswith("Automation:") or body.startswith("Automation:"):
                    kinds[f"python: {subject[:40] or body[:40]}"] += 1
                else:
                    kinds["human/other note"] += 1
        print(f"  {label}: {seen} leads read; notes in 30d by kind: {dict(kinds)}", flush=True)

    print("\nDone. Every call above was a GET.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
