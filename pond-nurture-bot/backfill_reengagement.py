#!/usr/bin/env python3
"""One-shot repair: rebuild the reengagement_log AND audit_log rows lost on
2026-08-11. (The filename predates the audit_log half; --tables says what runs.)

WHAT HAPPENED

Daily Automation run #37 sent 150 pond nurture emails (13:28–13:44 UTC) and
wrote a reengagement_log row for each one. Its state-DB push then failed — see
PR #5 — so the whole day's writes died with the runner. The emails are real;
the record that they happened is not.

TWO TABLES, TWO DIFFERENT HARMS

reengagement_log.last_sent_at is the cadence clock. With no row,
process_reengagement_candidate believes those leads were never emailed, and
was_contacted_recently only shields them for 3 days by asking FUB directly.
From day 4 they become eligible again, roughly 11 days early.

audit_log is what scan_reply_detection searches to decide whose inbox to watch:
it takes everyone with a send in the last 7 days and looks for a reply. With no
row, those 150 leads are simply not on the list — a lead who writes back this
week is never seen, never tagged "Replied - Paused", never alerted to an agent,
and keeps receiving automation as though they had said nothing. That is the
worst of the losses here, and it is why the audit half exists.

WHY FUB NOTES ARE A SOUND SOURCE

main.py writes `Pond Nurture {CHANNELS} Sent` immediately before
upsert_reengagement, and that add_note is the only place any note by that name
is created (upsert_reengagement likewise has exactly one caller). So a note is
written if and only if the row was — and unlike the row, the note is in FUB,
where it survived. FUB's own `created` timestamp is the send time.

SAFETY

- Dry run unless --commit. The dry run prints exactly what it would write.
- A clock is NEVER moved backwards. If a lead already has a last_sent_at at or
  after its note, the row is left alone.
- audit_log has no uniqueness constraint, so a naive re-run would double every
  row. A person who already has a pond_nurture/sent row inside the target day is
  skipped, which makes both halves re-runnable and makes a late overlap with the
  live bot harmless.
- Only these two tables are touched. Nothing here sends, tags or reassigns.
- --expect makes the count a gate rather than a number in a log: a mismatch
  against the authoritative total exits non-zero instead of half-repairing.

USAGE

    python3 backfill_reengagement.py --date 2026-08-11 --expect 150
    python3 backfill_reengagement.py --date 2026-08-11 --expect 150 --commit
    python3 backfill_reengagement.py --date 2026-08-11 --expect 150 --tables audit
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
SUBJECT_RE = re.compile(r"Subject:\s*\"(?P<subject>.*)\"")
SOURCE_RE = re.compile(r"Source:\s*(?P<source>.+)")

# main.py logs pond nurture sends as this action/status pair.
AUDIT_ACTION = "pond_nurture"
AUDIT_STATUS = "sent"

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


def subject_from_body(body: object) -> str:
    match = SUBJECT_RE.search(str(body or ""))
    return match.group("subject").strip() if match else ""


def source_from_body(body: object) -> str:
    match = SOURCE_RE.search(str(body or ""))
    return match.group("source").strip() if match else "backfill"


def local_day_bounds(date_str: str, tz_name: str) -> Tuple[dt.datetime, dt.datetime]:
    zone = ZoneInfo(tz_name)
    start = dt.datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=zone)
    return start.astimezone(UTC), (start + dt.timedelta(days=1)).astimezone(UTC)


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


def sends_from_notes(
    notes: Iterable[dict],
    target_date: str,
    tz_name: str = DEFAULT_TIMEZONE,
) -> List[dict]:
    """Every pond nurture send on `target_date`, one entry per note.

    Unlike the reengagement planner this does NOT collapse to one per person: a
    lead emailed twice really is two audit rows, and scan_reply_detection keys
    off the most recent send per lead, so losing the second would move that
    lead's reply window backwards.
    """
    zone = ZoneInfo(tz_name)
    out: List[dict] = []
    for note in notes:
        if not is_pond_nurture_note(note):
            continue
        created = note_created(note)
        person_id = note_person_id(note)
        if created is None or person_id is None:
            continue
        if created.astimezone(zone).strftime("%Y-%m-%d") != target_date:
            continue
        body = note.get("body")
        out.append({
            "person_id": person_id,
            "created": created,
            "channels": channels_from_subject(note_subject(note)).split("+"),
            "city": city_from_body(body),
            "city_source": source_from_body(body),
            "subject": subject_from_body(body),
        })
    return sorted(out, key=lambda r: (r["created"], r["person_id"]))


def plan_audit_backfill(
    sends: Iterable[dict],
    already_logged: Iterable[int],
) -> Tuple[List[dict], List[dict]]:
    """(rows to insert, rows skipped because the day already has one).

    audit_log is append-only with no unique key, so re-running without this
    check would double every row and hand the ramp's guardrails a day that
    looks twice as busy as it was.
    """
    have = set(already_logged)
    write, skip = [], []
    for row in sends:
        (skip if row["person_id"] in have else write).append(row)
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


def fetch_person_names(fub, person_ids: List[int]) -> Dict[int, str]:
    """Display names for the ticker, straight from FUB.

    The note carries no name, and the obvious shortcut — joining the preserved
    activity_log on its timestamp — can put the WRONG name against a lead when
    two sends land in the same second. One lookup per lead is a few hundred
    calls in a one-shot repair, and it cannot mis-attribute. A lookup that fails
    falls back to "Lead #<id>", exactly as the telemetry writer would.
    """
    from fub_automation.main import person_name

    names: Dict[int, str] = {}
    for i, person_id in enumerate(person_ids, 1):
        try:
            person = fub.get_person(person_id)
            if person:
                names[person_id] = person_name(person)
        except Exception as exc:  # noqa: BLE001
            print(f"  warning: could not read person {person_id}: {exc}")
        if i % 50 == 0:
            print(f"  resolved {i}/{len(person_ids)} names...")
    return names


# ── DB ───────────────────────────────────────────────────────────────────────


def read_existing(conn: sqlite3.Connection, person_ids: Iterable[int]) -> Dict[int, Optional[dt.datetime]]:
    out: Dict[int, Optional[dt.datetime]] = {}
    for person_id in person_ids:
        row = conn.execute(
            "SELECT last_sent_at FROM reengagement_log WHERE person_id=?", (person_id,)
        ).fetchone()
        out[person_id] = parse_ts(row[0]) if row else None
    return out


def people_logged_on(conn: sqlite3.Connection, start: dt.datetime, end: dt.datetime) -> List[int]:
    rows = conn.execute(
        """SELECT DISTINCT person_id FROM audit_log
           WHERE created_at >= ? AND created_at < ?
             AND action = ? AND status = ? AND person_id IS NOT NULL""",
        (start.isoformat(), end.isoformat(), AUDIT_ACTION, AUDIT_STATUS),
    ).fetchall()
    return [int(r[0]) for r in rows]


def count_audit_sends(conn: sqlite3.Connection, start: dt.datetime, end: dt.datetime) -> int:
    row = conn.execute(
        """SELECT COUNT(*) FROM audit_log
           WHERE created_at >= ? AND created_at < ?
             AND action = ? AND status = ?""",
        (start.isoformat(), end.isoformat(), AUDIT_ACTION, AUDIT_STATUS),
    ).fetchone()
    return int(row[0] or 0)


def apply_audit_rows(conn: sqlite3.Connection, rows: List[dict], names: Dict[int, str]) -> int:
    """Insert reconstructed pond_nurture/sent rows.

    The details payload mirrors what main.py writes at the live send site, minus
    the two fields a note cannot carry (freshness_angle, engagement_tier). It
    adds `backfilled`, which the live path never writes — so a reconstructed row
    is identifiable by the presence of a key, not by a guess.
    """
    import json as _json

    for row in rows:
        details = {
            "channels": row["channels"],
            "city": row["city"],
            "city_source": row["city_source"],
            "subject": row["subject"],
            "contact_name": names.get(row["person_id"], f"Lead #{row['person_id']}"),
            "backfilled": BACKFILL_MARKER,
        }
        conn.execute(
            "INSERT INTO audit_log(created_at, person_id, action, status, details) VALUES (?, ?, ?, ?, ?)",
            (row["created"].isoformat(), row["person_id"], AUDIT_ACTION, AUDIT_STATUS,
             _json.dumps(details, sort_keys=True)),
        )
    conn.commit()
    return len(rows)


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
    parser.add_argument("--tables", choices=("both", "reengagement", "audit"), default="both",
                        help="Which repair to run. Default both.")
    args = parser.parse_args(argv)
    do_reengagement = args.tables in ("both", "reengagement")
    do_audit = args.tables in ("both", "audit")

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

    sends = sends_from_notes(notes, args.date, args.timezone)
    people = sorted({s["person_id"] for s in sends})
    print(f"\n{args.date}: {len(sends)} sends across {len(people)} leads")

    # The gate is on leads, not rows: emails_sent from the run's own published
    # daily_stats counts sends, but a lead emailed twice would make the two
    # disagree. They are equal here (150/150) and a divergence is worth stopping
    # for, so check the one the operator supplied against both.
    if args.expect is not None and len(sends) != args.expect:
        print(
            f"\nERROR: found {len(sends)} sends for {args.date} but --expect said "
            f"{args.expect}. Refusing to write a partial repair — investigate the "
            f"gap first.",
            file=sys.stderr,
        )
        return 1

    conn = sqlite3.connect(args.db)
    try:
        day_start, day_end = local_day_bounds(args.date, args.timezone)
        re_write: List[dict] = []
        audit_write: List[dict] = []

        if do_reengagement:
            existing = read_existing(conn, people)
            re_write, re_skip = plan_backfill(notes, existing, args.date, args.timezone)
            print(f"\nreengagement_log (the cadence clock):")
            print(f"  {len(re_write)} need a row")
            print(f"  {len(re_skip)} already have one at or after the send — left alone")
            for row in re_write[:3]:
                print(f"    person {row['person_id']}  {row['created'].isoformat()}  "
                      f"{row['channel']}  {row['city']}")
            if len(re_write) > 3:
                print(f"    ... and {len(re_write) - 3} more")

        if do_audit:
            audit_write, audit_skip = plan_audit_backfill(sends, people_logged_on(conn, day_start, day_end))
            print(f"\naudit_log (what reply detection searches):")
            print(f"  {len(audit_write)} rows to insert")
            print(f"  {len(audit_skip)} skipped — that lead already has a "
                  f"{AUDIT_ACTION}/{AUDIT_STATUS} row on {args.date}")
            print(f"  rows present for {args.date} right now: "
                  f"{count_audit_sends(conn, day_start, day_end)}")

        if not args.commit:
            print("\nDRY RUN — nothing written. Re-run with --commit to apply.")
            return 0

        if do_reengagement and re_write:
            written = apply_rows(conn, re_write)
            # Read back rather than trusting the write: assert on content, not
            # on the absence of an exception.
            verified = read_existing(conn, [r["person_id"] for r in re_write])
            wrong = [r["person_id"] for r in re_write
                     if verified.get(r["person_id"]) != r["created"]]
            if wrong:
                print(f"ERROR: {len(wrong)} reengagement rows did not read back: {wrong[:5]}",
                      file=sys.stderr)
                return 1
            print(f"\n✅ reengagement_log: wrote {written} rows, all read back with the "
                  f"expected timestamp.")
        elif do_reengagement:
            print("\n✅ reengagement_log: already complete, nothing to write.")

        if do_audit and audit_write:
            print(f"\nResolving {len(people)} contact names from FUB for the ticker...")
            names = fetch_person_names(FollowUpBossClient(settings), people)
            named = sum(1 for p in people if p in names)
            print(f"  resolved {named}/{len(people)}; the rest fall back to 'Lead #<id>'")

            before = count_audit_sends(conn, day_start, day_end)
            written = apply_audit_rows(conn, audit_write, names)
            after = count_audit_sends(conn, day_start, day_end)
            if after - before != written:
                print(f"ERROR: inserted {written} rows but the day's count moved "
                      f"{before}->{after}.", file=sys.stderr)
                return 1
            if args.expect is not None and after != args.expect:
                print(f"ERROR: {args.date} now has {after} {AUDIT_ACTION}/{AUDIT_STATUS} "
                      f"rows, expected {args.expect}.", file=sys.stderr)
                return 1
            print(f"✅ audit_log: wrote {written} rows; {args.date} now has {after} "
                  f"{AUDIT_ACTION}/{AUDIT_STATUS} rows.")
        elif do_audit:
            print(f"\n✅ audit_log: already complete "
                  f"({count_audit_sends(conn, day_start, day_end)} rows), nothing to write.")

        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
