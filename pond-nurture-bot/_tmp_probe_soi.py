#!/usr/bin/env python3
"""TEMPORARY read-only probe — this branch only, deleted before the PR is ready.

1. Payload shape for the Lifestyle Bot Dashboard's lead list URL: does the
   default payload carry createdById, and does adding fields=allFields keep the
   includeNotes=true notes — the evidence for changing fetchLeadsForAgent.
2. Speed-to-lead gate cleanup verification (Actions run 36365964872): the 60
   restored leads — assignee, bounce tag, cleanup note — and who still carries
   the bounce tag.

Every call is a GET. No lead PII: ids, staff names, field names, counts, dates.
"""
from __future__ import annotations

import collections
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
os.environ["DRY_RUN"] = "true"
os.environ.setdefault("FUB_DISABLE_SCHEDULER", "true")

from fub_automation.main import FollowUpBossClient, Settings  # noqa: E402

BOUNCE_TAG = "auto-reassigned-speed-to-lead"
CLEANUP_NOTE_SUBJECT = "Automation: speed-to-lead gate cleanup"
RESTORED = sorted(set(range(9599, 9660)) - {9646})
PROBE_KEYS = ("id", "createdVia", "createdById", "updatedById", "notes", "tags", "emails",
              "phones", "stage", "assignedUserId", "assignedPondId", "source", "lastActivity",
              "firstName", "lastName", "created", "price", "addresses")


def main() -> int:
    settings = Settings.from_env()
    if not settings.fub_api_key:
        print("FUB_API_KEY missing")
        return 2
    fub = FollowUpBossClient(settings)
    users = {int(u["id"]): u for u in fub.users() if u.get("id") is not None}

    def uname(uid):
        return ((users.get(int(uid)) or {}).get("name") or f"user {uid}") if uid else "-"

    print("=== 1. payload shape for the agent-bot list URL "
          "(assignedUserId=1, limit=3, includeNotes=true, sort=-lastActivityAt) ===", flush=True)
    base = {"limit": 3, "assignedUserId": 1, "includeNotes": "true", "sort": "-lastActivityAt"}
    variants = {
        "default (fetchLeadsForAgent today)": dict(base),
        "+fields=allFields": dict(base, fields="allFields"),
        "+fields=createdById,createdVia,assignedUserId,tags": dict(
            base, fields="createdById,createdVia,assignedUserId,tags"),
    }
    for label, params in variants.items():
        try:
            data = fub._request("GET", "/people", params=params)
        except Exception as exc:  # noqa: BLE001
            print(f"  {label}: FAILED {str(exc)[:200]}", flush=True)
            continue
        people = data.get("people", [])
        present = {k: sum(1 for p in people if k in p) for k in PROBE_KEYS}
        print(f"  {label}: {len(people)} records; keys per record {[len(p) for p in people]}; "
              f"notes per record {[len(p.get('notes') or []) for p in people]}; "
              f"present: {present}", flush=True)

    print("\n=== 2. cleanup verification: the 60 restored leads ===", flush=True)
    tally = collections.Counter()
    anomalies = []
    for pid in RESTORED:
        person = fub.get_person(pid)
        if not person:
            tally["missing"] += 1
            anomalies.append((pid, "missing"))
            continue
        tags = [str(t.get("name") if isinstance(t, dict) else t) for t in (person.get("tags") or [])]
        has_tag = any(t.strip().lower() == BOUNCE_TAG for t in tags)
        assignee = person.get("assignedUserId")
        notes = fub.get_notes(pid, limit=25)
        cleanup_notes = sum(1 for n in notes if str(n.get("subject") or "") == CLEANUP_NOTE_SUBJECT)
        tally[f"assigned to {uname(assignee)}"] += 1
        tally["bounce tag still present" if has_tag else "bounce tag gone"] += 1
        tally[f"cleanup note x{cleanup_notes}"] += 1
        tally[f"source {person.get('source')!r}"] += 1
        if has_tag or assignee != 1 or cleanup_notes != 1 or person.get("assignedPondId"):
            anomalies.append((pid, uname(assignee), has_tag, cleanup_notes,
                              person.get("assignedPondId"), person.get("updated")))
    for key, count in sorted(tally.items()):
        print(f"  {count:4d}  {key}", flush=True)
    print(f"  anomalies: {anomalies or 'none'}", flush=True)

    print(f"\n=== 3. who still carries {BOUNCE_TAG!r} (GET /people?tags=) ===", flush=True)
    holders = fub.get_people(tags=BOUNCE_TAG)
    by = collections.Counter(
        (uname(p.get("assignedUserId")), str(p.get("source") or "<blank>"), str(p.get("createdVia")))
        for p in holders)
    print(f"  {len(holders)} contact(s) carry the tag", flush=True)
    for key, count in by.most_common(25):
        print(f"  {count:5d}  assigned {key[0]} | source {key[1]} | via {key[2]}", flush=True)
    print("\nDone. Every call above was a GET.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
