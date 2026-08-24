#!/usr/bin/env python3
"""Read-only diagnostic: where do inbound replies actually live in this FUB account?

WHY THIS EXISTS

Two dry runs of the missed-reply backfill (2026-08-24) proved, in order, that
neither surface the detection stack was built on holds inbound email:

1. FUB's person `updated` field: 65 records changed in a fortnight containing
   at least four known replies — synced email never touches it.
2. /v1/emails + /v1/textMessages: 2,603 emailed leads' message histories held
   ZERO inbound messages over 14 days — statistically impossible if replies
   were logged there.

Meanwhile every AI intent classification in this repo's whole run history came
from source='Sync Note' — never 'Inbound Email' — so the one surface known to
carry a lead's own words is FUB NOTES, with /v1/events never yet examined.

WHAT THIS PRINTS, per lead (looked up by email address)

- the person: id, name, stage, updated, lastReceivedEmail/lastReceivedText
- /v1/emails:       raw top-level keys, count, last 5 (direction, created, subject)
- /v1/textMessages: same
- /v1/notes:        count, last 10 (created, subject, first 100 chars of body)
- /v1/events:       count, last 10 (type, created, first 100 chars)

Bodies are clipped and email addresses/phone numbers inside them redacted.
READ-ONLY BY CONSTRUCTION: every FUB call is a GET; nothing here writes to
FUB, the audit DB, or anywhere else.

USAGE

    python3 diagnose_reply_surfaces.py --emails joe_munoz@att.net,sjherrera987@gmail.com
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))


def clip_and_redact(text: object, limit: int = 100) -> str:
    """First `limit` chars, with email addresses and phone numbers masked —
    enough to recognise a reply, not enough to republish contact details."""
    flat = re.sub(r"\s+", " ", str(text or "")).strip()
    flat = re.sub(r"\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[email]", flat)
    flat = re.sub(r"\+?\d[\d\s().-]{7,}\d", "[phone]", flat)
    return flat[:limit]


def direction_of(message: dict) -> str:
    from fub_automation.main import is_inbound_message

    return "IN " if is_inbound_message(message) else "OUT"


def describe_person(fub, email: str) -> Optional[int]:
    print(f"\n{'=' * 70}\nLEAD {clip_and_redact(email, 60)}", flush=True)
    data = fub._request("GET", "/people", params={"email": email, "fields": "allFields"})
    print(f"  /people top-level keys: {sorted(data.keys())}", flush=True)
    people = data.get("people", data.get("data", []))
    if not people:
        print("  NOT FOUND by email lookup", flush=True)
        return None
    person = people[0]
    pid = int(person["id"])
    print(f"  id={pid} name={person.get('firstName', '')} {person.get('lastName', '')} "
          f"stage={person.get('stage')}", flush=True)
    for key in ("updated", "lastReceivedEmail", "lastReceivedText", "lastActivity",
                "lastCommunication"):
        print(f"  {key} = {person.get(key)!r}", flush=True)
    return pid


def dump_item(item: dict, indent: str = "      ") -> None:
    """Every field of one message object, values clipped and redacted — the
    2026-08-24 run showed [CONTENT HIDDEN] payloads with no visible direction
    flag, so the exact field inventory is the whole point."""
    for key in sorted(item):
        print(f"{indent}{key} = {clip_and_redact(item[key], 80)!r}", flush=True)


def describe_messages(fub, pid: int, path: str, list_key: str, label: str) -> None:
    data = fub._request("GET", path, params={"personId": pid, "limit": 100})
    items = data.get(list_key, data.get("data", []))
    print(f"  {label}: top-level keys {sorted(data.keys())}, {len(items)} items",
          flush=True)
    if items:
        field_union = sorted({key for item in items for key in item})
        print(f"    item fields (union): {field_union}", flush=True)
    for item in items[:5]:
        created = item.get("created") or item.get("dateCreated") or item.get("date")
        subject = item.get("subject") or item.get("message") or item.get("body")
        print(f"    [{direction_of(item)}] {created}  {clip_and_redact(subject, 80)}",
              flush=True)
    if items:
        print("    newest item, every field:", flush=True)
        dump_item(items[0])
        # The single-object endpoint sometimes returns more than the list —
        # check whether direction/content appear when one email is fetched
        # directly by id.
        item_id = items[0].get("id")
        if label == "/emails" and item_id is not None:
            single = fub._request("GET", f"/emails/{item_id}")
            body = single.get("email", single) if isinstance(single, dict) else {}
            print(f"    GET /emails/{item_id}: top-level keys "
                  f"{sorted(single.keys()) if isinstance(single, dict) else '?'}",
                  flush=True)
            if isinstance(body, dict):
                print("    single-fetch, every field:", flush=True)
                dump_item(body)


def describe_notes(fub, pid: int) -> None:
    data = fub._request("GET", "/notes", params={"personId": pid, "limit": 100})
    notes = data.get("notes", data.get("data", []))
    print(f"  /notes: {len(notes)} items", flush=True)
    for note in notes[:10]:
        created = note.get("created") or note.get("createdAt")
        print(f"    {created}  subj={clip_and_redact(note.get('subject'), 60)!r}  "
              f"body={clip_and_redact(note.get('body'), 100)!r}", flush=True)


def describe_events(fub, pid: int) -> None:
    data = fub._request("GET", "/events", params={"personId": pid, "limit": 100})
    events = data.get("events", data.get("data", []))
    print(f"  /events: top-level keys {sorted(data.keys())}, {len(events)} items",
          flush=True)
    for event in events[:10]:
        created = event.get("created") or event.get("occurredAt")
        print(f"    type={event.get('type')!r} {created}  "
              f"{clip_and_redact(event.get('description') or event.get('message'), 100)!r}",
              flush=True)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Print every FUB surface that could hold a lead's replies.")
    parser.add_argument("--emails", required=True,
                        help="Comma-separated lead email addresses to inspect.")
    args = parser.parse_args(argv)

    # Read-only: force dry-run so even a code-path mistake cannot write.
    os.environ["DRY_RUN"] = "true"
    os.environ.setdefault("FUB_DISABLE_SCHEDULER", "true")

    from fub_automation.main import FollowUpBossClient, Settings

    settings = Settings.from_env()
    if not settings.fub_api_key:
        print("FUB_API_KEY missing — nothing to diagnose.")
        return 2
    fub = FollowUpBossClient(settings)

    for email in [e.strip() for e in args.emails.split(",") if e.strip()]:
        pid = describe_person(fub, email)
        if pid is None:
            continue
        describe_messages(fub, pid, "/emails", "emails", "/emails")
        describe_messages(fub, pid, "/textMessages", "textMessages", "/textMessages")
        describe_notes(fub, pid)
        describe_events(fub, pid)
    print(f"\n{'=' * 70}\nDone. Every call above was a GET.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
