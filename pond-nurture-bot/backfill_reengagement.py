#!/usr/bin/env python3
"""One-shot repair: rebuild reengagement_log rows lost on 2026-08-11.

WHAT HAPPENED

Daily Automation run #37 sent 150 pond nurture emails (13:28–13:44 UTC) and
wrote a reengagement_log row for each one. Its state-DB push then failed — see
PR #5 — so the whole day's writes died with the runner. The emails are real;
the record that they happened is not.

reengagement_log.last_sent_at is the cadence clock. With no row,
process_reengagement_candidate believes those leads were never emailed, and
was_contacted_recently only shields them for 3 days by asking FUB directly.
From day 4 they become eligible again, roughly 11 days early.

WHY FUB NOTES ARE A SOUND SOURCE

main.py writes `Pond Nurture {CHANNELS} Sent` immediately before
upsert_reengagement, and that add_note is the only place any note by that name
is created (upsert_reengagement likewise has exactly one caller). So a note is
written if and only if the row was — and unlike the row, the note is in FUB,
where it survived. FUB's own `created` timestamp is the send time.

SAFETY

- Dry run unless --commit. The dry run prints exactly what it would write.
- A clock is NEVER moved backwards. If a lead already has a last_sent_at at or
  after its note, the row is left alone. That makes the script re-runnable and
  makes a late overlap with the live bot harmless.
- Only reengagement_log is touched. Nothing here sends, tags or reassigns.
- --expect makes the count a gate rather than a number in a log: a mismatch
  against the authoritative total exits non-zero instead of half-repairing.

USAGE

    python3 backfill_reengagement.py --date 2026-08-11 --expect 150
    python3 backfill_reengagement.py --date 2026-08-11 --expect 150 --commit
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import sqlite3
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

UTC = dt.timezone.utc
DEFAULT_TIMEZONE = "America/Chicago"

# main.py: f"Pond Nurture {note_channels} Sent", note_channels being
# "EMAIL", "SMS" or "EMAIL + SMS".
NOTE_SUBJECT_RE = re.compile(r"^\s*Pond Nurture\s+(?P<channels>[A-Z+\s]+?)\s+Sent\s*$")
CITY_RE = re.compile(r"City focus:\s*(?P<city>.+)")

# Marks every row this script writes. message_hash is written by
# upsert_reengagement and read by nothing, so it is free to carry provenance —
# and anyone auditing the DB later can tell a reconstructed row from a real one.
BACKFILL_MARKER = "backfilled-from-fub-note"


# ── Pure logic (unit-tested; no network, no DB) ──────────────────────────────


def parse_ts(value: object) -> Optional[dt.datetime]:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def note_subject(note: dict) -> str:
    return str(note.get("subject") or note.get("title") or "")


def note_created(note: dict) -> Optional[dt.datetime]:
    for key in ("created", "dateCreated", "createdAt"):
        parsed = parse_ts(note.get(key))
        if parsed:
            return parsed
    return None


def note_person_id(note: dict) -> Optional[int]:
    for key in ("personId", "person_id", "personID"):
        raw = note.get(key)
        if raw not in (None, ""):
            try:
                return int(raw)
            except (TypeError, ValueError):
                return None
    return None


def is_pond_nurture_note(note: dict) -> bool:
    return bool(NOTE_SUBJECT_RE.match(note_subject(note)))


def channels_from_subject(subject: str) -> str:
    """"Pond Nurture EMAIL + SMS Sent" -> "email+sms", matching the "+".join()
    of sent_channels that the live path stores."""
    match = NOTE_SUBJECT_RE.match(subject)
    if not match:
        return "email"
    parts = [p.strip().lower() for p in match.group("channels").split("+") if p.strip()]
    return "+".join(parts) or "email"


def city_from_body(body: object) -> str:
    match = CITY_RE.search(str(body or ""))
    return match.group("city").strip() if match else "Texas/general"


def plan_backfill(
    notes: Iterable[dict],
    existing: Dict[int, Optional[dt.datetime]],
    target_date: str,
    tz_name: str = DEFAULT_TIMEZONE,
) -> Tuple[List[dict], List[dict]]:
    """(rows to write, rows deliberately skipped).

    One row per person — the LATEST note of the day, so a lead emailed twice
    gets the newer clock rather than whichever note paginated first.
    """
    zone = ZoneInfo(tz_name)
    latest: Dict[int, dict] = {}

    for note in notes:
        if not is_pond_nurture_note(note):
            continue
        created = note_created(note)
        person_id = note_person_id(note)
        if created is None or person_id is None:
            continue
        if created.astimezone(zone).strftime("%Y-%m-%d") != target_date:
            continue
        current = latest.get(person_id)
        if current is None or created > current["created"]:
            latest[person_id] = {
                "person_id": person_id,
                "created": created,
                "channel": channels_from_subject(note_subject(note)),
                "city": city_from_body(note.get("body")),
            }

    write: List[dict] = []
    skip: List[dict] = []
    for person_id, row in sorted(latest.items()):
        have = existing.get(person_id)
        # Never move a clock backwards: a row at or after the note is already at
        # least as protective as anything this script could write.
        if have is not None and have >= row["created"]:
            skip.append({**row, "existing": have})
        else:
            write.append(row)
    return write, skip


# ── FUB ──────────────────────────────────────────────────────────────────────


def fetch_notes(fub, target_date: str, tz_name: str, max_pages: int = 200) -> List[dict]:
    """Every note from `target_date`, newest first.

    Sorted descending and stopped one whole day past the target: FUB holds far
    more notes than the day we care about, and paging the entire history to find
    150 rows would be its own outage.
    """
    zone = ZoneInfo(tz_name)
    stop_before = (
        dt.datetime.strptime(target_date, "%Y-%m-%d")
        .replace(tzinfo=zone) - dt.timedelta(days=1)
    ).astimezone(UTC)

    collected: List[dict] = []
    next_cursor = None
    for page in range(max_pages):
        params = {"limit": 100, "sort": "-created"}
        if next_cursor:
            params["next"] = next_cursor
        data = fub._request("GET", "/notes", params=params)
        notes = data.get("notes", data.get("data", []))
        if not notes:
            break
        collected.extend(notes)

        oldest = min((note_created(n) for n in notes if note_created(n)), default=None)
        if oldest and oldest < stop_before:
            print(f"  reached {oldest.isoformat()} — older than the window, stopping")
            break

        next_cursor = (data.get("_metadata") or {}).get("next")
        if not next_cursor:
            break
        print(f"  fetched page {page + 1} ({len(collected)} notes)...")
    return collected


# ── DB ───────────────────────────────────────────────────────────────────────


def read_existing(conn: sqlite3.Connection, person_ids: Iterable[int]) -> Dict[int, Optional[dt.datetime]]:
    out: Dict[int, Optional[dt.datetime]] = {}
    for person_id in person_ids:
        row = conn.execute(
            "SELECT last_sent_at FROM reengagement_log WHERE person_id=?", (person_id,)
        ).fetchone()
        out[person_id] = parse_ts(row[0]) if row else None
    return out


def apply_rows(conn: sqlite3.Connection, rows: List[dict]) -> int:
    for row in rows:
        conn.execute(
            """
            INSERT INTO reengagement_log(person_id, last_sent_at, channel, city, message_hash)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(person_id) DO UPDATE SET
                last_sent_at=excluded.last_sent_at,
                channel=excluded.channel,
                city=excluded.city,
                message_hash=excluded.message_hash
            """,
            (row["person_id"], row["created"].isoformat(), row["channel"],
             row["city"], BACKFILL_MARKER),
        )
    conn.commit()
    return len(rows)


# ── Entry point ──────────────────────────────────────────────────────────────


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--date", required=True, help="Local date to repair, YYYY-MM-DD")
    parser.add_argument("--db", default=os.environ.get("DATABASE_PATH", "data/fub_automation.sqlite3"))
    parser.add_argument("--timezone", default=DEFAULT_TIMEZONE)
    parser.add_argument("--expect", type=int, default=None,
                        help="Authoritative send count. A mismatch fails instead of half-repairing.")
    parser.add_argument("--commit", action="store_true",
                        help="Actually write. Without it this is a dry run.")
    args = parser.parse_args(argv)

    if not Path(args.db).exists():
        print(f"ERROR: no audit DB at {args.db}", file=sys.stderr)
        return 1

    sys.path.insert(0, "src")
    from fub_automation.main import FollowUpBossClient, Settings

    settings = Settings.from_env()
    if not settings.fub_api_key:
        print("ERROR: FUB_API_KEY is missing — cannot read the notes.", file=sys.stderr)
        return 1

    print(f"Fetching notes for {args.date} ({args.timezone})...")
    notes = fetch_notes(FollowUpBossClient(settings), args.date, args.timezone)
    pond = [n for n in notes if is_pond_nurture_note(n)]
    print(f"  {len(notes)} notes scanned, {len(pond)} are pond nurture sends "
          f"(the fetched window overshoots {args.date}; the day filter is applied below)")
    if not pond:
        print(
            "\nERROR: no pond nurture notes came back at all. Either the date is "
            "wrong, or GET /notes did not return a global listing — check the "
            "first page of the response shape before trusting a zero.",
            file=sys.stderr,
        )
        return 1

    conn = sqlite3.connect(args.db)
    try:
        candidates = {note_person_id(n) for n in pond} - {None}
        existing = read_existing(conn, sorted(candidates))  # type: ignore[arg-type]
        write, skip = plan_backfill(notes, existing, args.date, args.timezone)

        print(f"\n{args.date}: {len(write) + len(skip)} leads emailed")
        print(f"  {len(write)} need a reengagement_log row")
        print(f"  {len(skip)} already have one at or after the send — left alone")
        for row in write[:5]:
            print(f"    person {row['person_id']}  {row['created'].isoformat()}  "
                  f"{row['channel']}  {row['city']}")
        if len(write) > 5:
            print(f"    ... and {len(write) - 5} more")

        total = len(write) + len(skip)
        if args.expect is not None and total != args.expect:
            print(
                f"\nERROR: found {total} sends for {args.date} but --expect said "
                f"{args.expect}. Refusing to write a partial repair — investigate "
                f"the gap first.",
                file=sys.stderr,
            )
            return 1

        if not args.commit:
            print("\nDRY RUN — nothing written. Re-run with --commit to apply.")
            return 0

        written = apply_rows(conn, write)
        print(f"\n✅ Wrote {written} reengagement_log rows.")

        # Read back rather than trusting the write: assert on content, not on
        # the absence of an exception.
        verified = read_existing(conn, [r["person_id"] for r in write])
        wrong = [r["person_id"] for r in write
                 if verified.get(r["person_id"]) != r["created"]]
        if wrong:
            print(f"ERROR: {len(wrong)} rows did not read back as written: {wrong[:5]}",
                  file=sys.stderr)
            return 1
        print(f"✅ Verified all {written} rows read back with the expected timestamp.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
