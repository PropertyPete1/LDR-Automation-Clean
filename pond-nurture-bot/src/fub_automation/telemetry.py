"""
telemetry.py — the bot reporting on itself, for LIFESTYLE ("THE FLOOR").

Writes two files under `status/` at the repo root so the telemetry panel and the
bottom ticker have live numbers instead of "TELEMETRY OFFLINE":

    status/daily_stats.json    six scalars, overwritten every run
    status/activity_log.json   the 100 most recent lead-level events

READ-ONLY BY CONSTRUCTION, like funnel.py. Every query here is a SELECT over
data the automation already wrote. This module never sends, tags, suppresses or
enrolls; a bug in it can make a dashboard wrong, never a lead.

─────────────────────────────────────────────────────────────────────────────
WHERE EACH NUMBER COMES FROM

emails_sent — audit_log rows today with action in EMAIL_SEND_ACTIONS and
    status='sent'. Rows, not distinct people: two emails to one lead are two
    emails. INCLUDES seller drips, so it is the headline "mail that left the
    building today" and seller_drips_sent is a named slice of it, not a
    disjoint bucket. Adding the two together double-counts.

    DELIBERATELY EXCLUDES status='dry_run_sent', which funnel.py's CONTACTED
    accepts. The funnel measures work attempted; this panel is read as "mail
    Peter's leads received". Counting a dry run there would put 41 on a screen
    on a day nothing was delivered — the exact silent-success failure this
    repo keeps getting bitten by. Under DRY_RUN the panel reads 0, and
    last_run_iso still moves, so the bot is visibly alive and visibly idle.

seller_drips_sent — the action='seller_nurture' slice of the above.

leads_scored — DISTINCT person_id in engagement_tier whose last_classified_at
    is today. Engagement tiering is this system's scoring step: it reads a
    lead's inbound history and files it engaged / standard / cold. The table
    keeps only the current tier per person (no history), which is exactly why
    this counts by last_classified_at rather than by row.

replies_needed — POINT-IN-TIME BACKLOG, not a per-run event count. A lead
    counts when reply detection has seen them write back and nothing since
    says a human closed the loop:

        reply_detected/alert_sent (or /backfilled, the retro-repair's rows)
        within REPLY_BACKLOG_DAYS
        MINUS anyone with a closing event AFTER their latest reply

    Closing events are (a) reply_intent_disqualification or pond_opt_out_trash
    — they replied to leave, nobody owes them anything — and (b) a bot email
    that actually sent. (b) works because reply detection tags the lead
    "Replied - Paused", which is in the suppression list: while the reply is
    open the bot cannot email them, so a later send proves a human removed the
    tag. It is a lagging signal (the next send waits out the 10–21 day
    cadence), which is the safe direction to be wrong in — see below.

    LIFESTYLE notifies Peter's phone when this number RISES, so the failure
    that matters is a spurious rise, and every design choice here is bent away
    from one. Counting per-run replies would sit at 0 on quiet runs and spike
    on busy ones — a notification per burst, none of them new information.
    A backlog that decays a fortnight late merely delays a decrease, and a
    decrease notifies nobody.

─────────────────────────────────────────────────────────────────────────────
ACTIVITY LOG

Four types, fixed by the LIFESTYLE ticker contract: sent, drip, needs_reply,
heating_up. Each entry is one audit_log row rendered for a human, and
`detail` is written for a scrolling ticker — under 60 characters, and never
repeating contact_name, which the ticker prints alongside it.

Contact names live in the audit row's `details` JSON (main.py writes
"contact_name" at each of these sites, matching the "person_name" key
reply_intent_disqualification already used). No name in the row means no FUB
lookup — the entry renders as "Lead #123" rather than spending an API call per
ticker line at the tail of a run the ramp is timing.

THE FILE IS A MERGE, NOT AN APPEND. Each run unions what is already on disk
with what the DB can currently see, dedupes on (ts, type, person_id), sorts
newest-first and keeps 100. That makes a rerun a no-op instead of a duplicate,
so the workflow can regenerate after a crash without corrupting history, and
history older than the DB's retention still survives on disk.

Both files are written temp-then-rename: LIFESTYLE polls them, and a reader
that catches a half-written file gets invalid JSON, not a partial number.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

UTC = dt.timezone.utc

# The business runs on Central time; "today" is Peter's today, not UTC's.
DEFAULT_TIMEZONE = "America/Chicago"

# Actions whose 'sent' status means a real email left the building. Kept in
# step with funnel.EMAIL_SEND_ACTIONS deliberately rather than imported: the
# two modules answer to different consumers and must be free to diverge.
EMAIL_SEND_ACTIONS: Tuple[str, ...] = (
    "pond_nurture",
    "closed_drip",
    "long_term_nurture_drip",
    "closed_congrats",
    "instant_welcome_email",
    "seller_nurture",
)

SELLER_ACTION = "seller_nurture"

# Only real delivery. See the module docstring on why dry_run_sent is out.
SENT_STATUS = "sent"

# How far back an unanswered reply keeps counting. Long enough that a reply
# left over a holiday week still shows, short enough that a lead handled by
# phone a season ago — a close nobody could see from here — ages out.
REPLY_BACKLOG_DAYS = 30

# The ticker contract. Four values, no others.
ACTIVITY_TYPES: Tuple[str, ...] = ("sent", "drip", "needs_reply", "heating_up")

MAX_ACTIVITY_ENTRIES = 100

# Ticker copy per send action. Kept short because `detail` renders inline
# after the contact name and the panel does not wrap.
_SEND_DETAILS: Dict[str, str] = {
    "pond_nurture": "pond nurture email",
    "closed_drip": "quarterly check-in",
    "closed_congrats": "closing congratulations",
    "instant_welcome_email": "instant welcome email",
    "long_term_nurture_drip": "long-term nurture email",
}

DETAIL_MAX_CHARS = 60

# Paths LIFESTYLE reads, relative to the repo root — not to this package.
STATUS_DIRNAME = "status"
STATS_FILENAME = "daily_stats.json"
ACTIVITY_FILENAME = "activity_log.json"

# Entry types that represent a delivered email, and so must be countable in
# emails_sent for the same local day.
SEND_TYPES: Tuple[str, ...] = ("sent", "drip")


class TelemetryContradiction(RuntimeError):
    """The stats and the activity log disagree, so neither can be published.

    Raised when the activity log holds more delivered emails for today than
    daily_stats can count. The log is capped and trimmed, so it may legitimately
    hold FEWER than the true total — it can never hold more. When it does, the
    audit DB this run read is missing rows that a previous run demonstrably saw,
    and every scalar computed from it is understated.

    This is not hypothetical. On 2026-08-11 the daily run sent ~150 emails, its
    state-DB push failed, and every run afterwards pulled a DB lineage without
    them. The writer faithfully computed zeros from the DB it was given and
    published `emails_sent: 0` on a day the log itself showed the morning's
    sends, with names. The numbers were wrong; nothing about them looked wrong.
    Refusing to publish leaves the last good pair in place and lets last_run_iso
    go stale, which is what "the data is not trustworthy" should look like.
    """


# ── Time helpers ─────────────────────────────────────────────────────────────


def _zone(name: str):
    from zoneinfo import ZoneInfo

    return ZoneInfo(name)


def local_day_bounds(now: dt.datetime, tz_name: str = DEFAULT_TIMEZONE) -> Tuple[dt.datetime, dt.datetime, str]:
    """The UTC instants bracketing `now`'s local day, plus that day's date.

    Half-open [start, end) so consecutive days tile exactly, matching how
    funnel.py windows a week.
    """
    local_now = now.astimezone(_zone(tz_name))
    local_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    local_end = local_start + dt.timedelta(days=1)
    return (
        local_start.astimezone(UTC),
        local_end.astimezone(UTC),
        local_start.strftime("%Y-%m-%d"),
    )


def iso_z(value: dt.datetime) -> str:
    """UTC ISO 8601 with a Z suffix — the shape LIFESTYLE parses."""
    return value.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_stored(value: Optional[str]) -> Optional[dt.datetime]:
    """Parse an audit timestamp. Bad rows are dropped, never crash a report."""
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _sql_ts(value: dt.datetime) -> str:
    """Render a bound the way audit_log stores its timestamps (now_iso())."""
    return value.astimezone(UTC).isoformat()


# ── Daily stats ──────────────────────────────────────────────────────────────


def count_sent(conn: sqlite3.Connection, start: dt.datetime, end: dt.datetime, actions: Sequence[str]) -> int:
    if not actions:
        return 0
    placeholders = ",".join("?" for _ in actions)
    row = conn.execute(
        f"""SELECT COUNT(*) FROM audit_log
            WHERE created_at >= ? AND created_at < ?
              AND action IN ({placeholders})
              AND status = ?""",
        (_sql_ts(start), _sql_ts(end), *actions, SENT_STATUS),
    ).fetchone()
    return int(row[0] or 0)


def count_leads_scored(conn: sqlite3.Connection, start: dt.datetime, end: dt.datetime) -> int:
    row = conn.execute(
        """SELECT COUNT(DISTINCT person_id) FROM engagement_tier
           WHERE last_classified_at >= ? AND last_classified_at < ?
             AND person_id IS NOT NULL""",
        (_sql_ts(start), _sql_ts(end)),
    ).fetchone()
    return int(row[0] or 0)


def count_replies_needed(
    conn: sqlite3.Connection,
    now: dt.datetime,
    backlog_days: int = REPLY_BACKLOG_DAYS,
) -> int:
    """Leads who wrote back and are still waiting on a human. See docstring."""
    since = _sql_ts(now - dt.timedelta(days=backlog_days))

    # Latest reply per lead, so a lead who replied twice is one open thread and
    # only the most recent reply has to be cleared.
    latest_reply: Dict[int, str] = {}
    # 'backfilled' alongside 'alert_sent': the retroactive repair of missed
    # replies (backfill_missed_replies.py) writes those rows without paging
    # anyone, and the leads behind them are waiting just the same.
    for person_id, created_at in conn.execute(
        """SELECT person_id, MAX(created_at) FROM audit_log
           WHERE created_at >= ?
             AND action = 'reply_detected' AND status IN ('alert_sent', 'backfilled')
             AND person_id IS NOT NULL
           GROUP BY person_id""",
        (since,),
    ):
        latest_reply[int(person_id)] = created_at

    if not latest_reply:
        return 0

    # Anything that closes the loop: they left, the alert was voided as a
    # false positive (the repair sweep's reply_false_positive_cleared rows —
    # nobody was ever waiting), or the bot could reach them again (only
    # possible once a human cleared "Replied - Paused").
    send_placeholders = ",".join("?" for _ in EMAIL_SEND_ACTIONS)
    closing: Dict[int, str] = {}
    for person_id, created_at in conn.execute(
        f"""SELECT person_id, MAX(created_at) FROM audit_log
            WHERE created_at >= ?
              AND person_id IS NOT NULL
              AND ( action IN ('reply_intent_disqualification', 'pond_opt_out_trash',
                               'reply_false_positive_cleared')
                 OR (action IN ({send_placeholders}) AND status = ?) )
            GROUP BY person_id""",
        (since, *EMAIL_SEND_ACTIONS, SENT_STATUS),
    ):
        closing[int(person_id)] = created_at

    open_threads = 0
    for person_id, replied_at_raw in latest_reply.items():
        replied_at = _parse_stored(replied_at_raw)
        closed_at = _parse_stored(closing.get(person_id))
        if replied_at is None:
            continue
        if closed_at is not None and closed_at > replied_at:
            continue
        open_threads += 1
    return open_threads


def daily_stats(
    conn: sqlite3.Connection,
    now: Optional[dt.datetime] = None,
    tz_name: str = DEFAULT_TIMEZONE,
) -> dict:
    """The six scalars of status/daily_stats.json."""
    now = (now or dt.datetime.now(UTC)).astimezone(UTC)
    start, end, date_str = local_day_bounds(now, tz_name)
    return {
        "date": date_str,
        "emails_sent": count_sent(conn, start, end, EMAIL_SEND_ACTIONS),
        "seller_drips_sent": count_sent(conn, start, end, (SELLER_ACTION,)),
        "replies_needed": count_replies_needed(conn, now),
        "leads_scored": count_leads_scored(conn, start, end),
        "last_run_iso": iso_z(now),
    }


# ── Activity log ─────────────────────────────────────────────────────────────


def _details(raw: Optional[str]) -> dict:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _contact_name(details: dict, person_id: Optional[int]) -> str:
    for key in ("contact_name", "person_name"):
        value = str(details.get(key) or "").strip()
        if value:
            return value
    return f"Lead #{person_id}" if person_id else "Unknown lead"


def _clip(text: str) -> str:
    text = " ".join(text.split())
    if len(text) <= DETAIL_MAX_CHARS:
        return text
    return text[: DETAIL_MAX_CHARS - 1].rstrip() + "…"


def _describe(action: str, details: dict) -> Tuple[str, str]:
    """(type, detail) for one audit row. Ticker copy lives here, nowhere else."""
    if action == SELLER_ACTION:
        number = details.get("email_number")
        if isinstance(number, int) and number > 0:
            return "drip", _clip(f"seller drip email {number}")
        return "drip", _clip("seller drip email")

    if action == "long_term_nurture_drip":
        number = details.get("email_number")
        if isinstance(number, int) and number > 0:
            return "sent", _clip(f"long-term nurture email {number}")
        return "sent", _clip(_SEND_DETAILS[action])

    if action == "pond_nurture":
        city = str(details.get("city") or "").strip()
        if city and city != "Texas/general":
            return "sent", _clip(f"pond nurture email — {city}")
        return "sent", _clip(_SEND_DETAILS[action])

    if action in _SEND_DETAILS:
        return "sent", _clip(_SEND_DETAILS[action])

    if action == "reply_detected":
        channel = str(details.get("reply_channel") or "").strip()
        if channel:
            return "needs_reply", _clip(f"replied by {channel} — awaiting a human")
        return "needs_reply", _clip("replied — awaiting a human")

    if action == "pond_keyword_reassignment":
        return "heating_up", _clip("buying intent detected — routed to Peter")

    raise ValueError(f"no ticker rendering for action {action!r}")


def activity_entries(
    conn: sqlite3.Connection,
    since: dt.datetime,
    limit: int = MAX_ACTIVITY_ENTRIES,
) -> List[dict]:
    """The most recent ticker-worthy events, newest first."""
    send_placeholders = ",".join("?" for _ in EMAIL_SEND_ACTIONS)
    rows = conn.execute(
        f"""SELECT created_at, person_id, action, status, details FROM audit_log
            WHERE created_at >= ?
              AND ( (action IN ({send_placeholders}) AND status = ?)
                 OR (action = 'reply_detected' AND status IN ('alert_sent', 'backfilled'))
                 OR (action = 'pond_keyword_reassignment' AND status = 'completed') )
            ORDER BY created_at DESC
            LIMIT ?""",
        (_sql_ts(since), *EMAIL_SEND_ACTIONS, SENT_STATUS, limit),
    ).fetchall()

    entries: List[dict] = []
    for created_at, person_id, action, _status, raw_details in rows:
        ts = _parse_stored(created_at)
        if ts is None:
            continue
        details = _details(raw_details)
        try:
            entry_type, detail = _describe(action, details)
        except ValueError:
            continue
        entries.append(
            {
                "ts": iso_z(ts),
                "type": entry_type,
                "contact_name": _contact_name(details, person_id),
                "detail": detail,
            }
        )
    return entries


def _key(entry: dict) -> Tuple[str, str, str, str]:
    """Dedupe identity — all four contract fields, and nothing else.

    Nothing person_id-based, because the other side of the merge is a file
    whose entries never carried a person_id: key on a field only one side has
    and every entry survives as its own duplicate on the next run. An audit
    row's rendering is deterministic (its details JSON is immutable once
    written), so a row read this run keys identically to the same row written
    last run.

    `detail` earns its place: ts is second-precision by contract, so a lead who
    gets two different emails inside one second collides on
    (ts, type, contact_name) alone and one of them silently vanishes from the
    ticker. Seen in a seeded day — 70 events published as 69.
    """
    return (
        str(entry.get("ts", "")),
        str(entry.get("type", "")),
        str(entry.get("contact_name", "")),
        str(entry.get("detail", "")),
    )


def _public(entry: dict) -> dict:
    """Normalize to the four contract fields — drops anything a hand-edited or
    future-version file carried in."""
    return {
        "ts": str(entry["ts"]),
        "type": str(entry["type"]),
        "contact_name": str(entry["contact_name"]),
        "detail": _clip(str(entry.get("detail") or "")),
    }


def _valid(entry: object) -> bool:
    """Reject anything that would break the LIFESTYLE contract on the way in.

    Applied to the on-disk file too: a corrupted or hand-edited entry gets
    dropped rather than propagated forward for the next hundred runs.
    """
    if not isinstance(entry, dict):
        return False
    if entry.get("type") not in ACTIVITY_TYPES:
        return False
    if not _parse_stored(entry.get("ts")):
        return False
    return bool(str(entry.get("contact_name") or "").strip())


def merge_activity(
    existing: Iterable[object],
    fresh: Iterable[dict],
    limit: int = MAX_ACTIVITY_ENTRIES,
) -> List[dict]:
    """Union of disk and DB, newest first, deduped, trimmed to `limit`.

    `fresh` wins on a key collision — it carries the current rendering.
    """
    merged: Dict[Tuple[str, str, str], dict] = {}
    for entry in existing:
        if _valid(entry):
            merged[_key(entry)] = dict(entry)  # type: ignore[arg-type]
    for entry in fresh:
        if _valid(entry):
            merged[_key(entry)] = entry

    ordered = sorted(merged.values(), key=lambda e: (e["ts"], e["type"]), reverse=True)
    return [_public(entry) for entry in ordered[:limit]]


def logged_sends_on(entries: Iterable[dict], date_str: str) -> int:
    """Delivered-email entries in the log bearing `date_str`'s LOCAL date.

    Entry timestamps are UTC, so they are converted back through the same
    timezone daily_stats used — otherwise an evening send lands on tomorrow
    here and today there, and the two disagree by construction.
    """
    count = 0
    for entry in entries:
        if entry.get("type") not in SEND_TYPES:
            continue
        ts = _parse_stored(entry.get("ts"))
        if ts is not None and entry.get("_local_date") == date_str:
            count += 1
    return count


def check_agreement(stats: dict, activity: List[dict], tz_name: str) -> None:
    """The stats/log agreement invariant. Raises TelemetryContradiction.

    emails_sent must be able to account for every delivered-email entry the log
    shows for the same day. `>=` rather than `==` because the log is trimmed to
    the most recent 100 and can hold fewer; it can never hold more.
    """
    date_str = stats["date"]
    zone = _zone(tz_name)
    tagged = []
    for entry in activity:
        ts = _parse_stored(entry.get("ts"))
        local_date = ts.astimezone(zone).strftime("%Y-%m-%d") if ts else None
        tagged.append({**entry, "_local_date": local_date})

    logged = logged_sends_on(tagged, date_str)
    if logged > stats["emails_sent"]:
        raise TelemetryContradiction(
            f"activity_log shows {logged} delivered emails on {date_str} but "
            f"daily_stats counted only {stats['emails_sent']}. The audit DB this "
            f"run read is missing rows a previous run already published — most "
            f"likely the state DB was not persisted. Refusing to publish; the "
            f"previous status files are left untouched."
        )


def _read_existing_activity(path: Path) -> List[object]:
    """Whatever is already on disk. Unreadable or non-array content is treated
    as empty — a corrupt file must not stop this run from publishing."""
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return loaded if isinstance(loaded, list) else []


# ── Writing ──────────────────────────────────────────────────────────────────


def _atomic_write_json(path: Path, payload: object) -> None:
    """Temp file in the destination directory, then rename.

    Same directory so the rename is same-filesystem and therefore atomic;
    fsync before it so a crashed runner cannot leave a renamed-but-empty file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        # mkstemp makes the file 0600. These are published dashboard files, and
        # the rename carries the temp file's mode across.
        os.chmod(tmp_name, 0o644)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def write_status(
    db_path: str,
    status_dir: str,
    now: Optional[dt.datetime] = None,
    tz_name: str = DEFAULT_TIMEZONE,
) -> dict:
    """Write both status files. Returns what was written, for logging/tests.

    Safe to call twice for the same run: the stats file is a pure snapshot and
    the activity file merges, so a rerun refreshes last_run_iso and changes
    nothing else.
    """
    now = (now or dt.datetime.now(UTC)).astimezone(UTC)
    out_dir = Path(status_dir)
    activity_path = out_dir / ACTIVITY_FILENAME

    # read-only so a reporting bug can never write to the state DB. as_uri()
    # percent-encodes, which a hand-built file: string does not.
    conn = sqlite3.connect(f"{Path(db_path).resolve().as_uri()}?mode=ro", uri=True)
    try:
        stats = daily_stats(conn, now=now, tz_name=tz_name)
        fresh = activity_entries(conn, since=now - dt.timedelta(days=REPLY_BACKLOG_DAYS))
    finally:
        conn.close()

    activity = merge_activity(_read_existing_activity(activity_path), fresh)

    # Checked BEFORE either file is written, so a contradictory run leaves the
    # last good pair on disk rather than half-replacing it.
    check_agreement(stats, activity, tz_name)

    _atomic_write_json(out_dir / STATS_FILENAME, stats)
    _atomic_write_json(activity_path, activity)
    return {"daily_stats": stats, "activity_log": activity}


# ── CLI ──────────────────────────────────────────────────────────────────────


def main(argv: Optional[Sequence[str]] = None) -> int:
    """`python -m fub_automation.telemetry` — used by the publish step.

    Exit codes are the contract with that step:
      0 — published, or nothing to publish (missing/unreadable DB). This runs
          with `if: always()`; a dashboard file must not turn a good run red.
      2 — the stats and the log contradict each other. Deliberately loud: the
          run's state is wrong, not just its reporting, and a silent stale
          dashboard is how the 2026-08-11 incident stayed invisible for 16
          hours. The publish step skips the commit on 2.
    """
    parser = argparse.ArgumentParser(description="Write status/ telemetry from the audit DB.")
    parser.add_argument("--db", default=os.environ.get("DATABASE_PATH", "data/fub_automation.sqlite3"))
    parser.add_argument("--out", default=STATUS_DIRNAME, help="Directory to write the status files into.")
    parser.add_argument("--timezone", default=os.environ.get("LOCAL_TIMEZONE", DEFAULT_TIMEZONE))
    args = parser.parse_args(argv)

    if not Path(args.db).exists():
        print(f"[telemetry] No audit DB at {args.db} — nothing to report.", file=sys.stderr)
        return 0

    try:
        written = write_status(args.db, args.out, tz_name=args.timezone)
    except TelemetryContradiction as exc:
        print(f"[telemetry] REFUSING TO PUBLISH — {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"[telemetry] Failed to write status files: {exc}", file=sys.stderr)
        return 0

    stats = written["daily_stats"]
    print(
        "[telemetry] {date}: {emails_sent} emails ({seller_drips_sent} seller drips), "
        "{replies_needed} awaiting reply, {leads_scored} leads scored, "
        "{entries} ticker entries".format(entries=len(written["activity_log"]), **stats)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
