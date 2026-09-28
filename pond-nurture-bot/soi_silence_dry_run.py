#!/usr/bin/env python3
"""SOI silence dry run: whom the sphere rule silences, and whom it newly silences.

Peter's rule (2026-09-28): a contact an agent adds to Follow Up Boss themselves
is that agent's sphere and gets total silence from all automation, whatever
source they typed (most leave it blank). FUB records HOW a contact was added in
createdVia — "Manually" for the web UI and the mobile app, "Import" for a
spreadsheet — and WHO added it in createdById. Before this rule the automation
silenced only the "Manually" channel: an agent's spreadsheet import without
"SOI" in the source was fair game for every bot.

READ-ONLY: every FUB call is a GET, the state DB is opened after a pull and
never pushed. DRY_RUN is pinned so even a mistake cannot write.

The repository is public, so the output carries FUB ids, staff names,
lead-source labels, stages, counts and timestamps — never lead names or
contact details.

  A. createdVia census — every distinct createdVia value in the account, by
     who added the contact: counts, blank-source counts, example ids and the
     created-date range. The evidence for which values the rule must name.
  B. Newly silenced — every contact the LIVE rule (RuleEngine._is_soi_silenced,
     whatever this checkout says) silences that the legacy Manually-only rule
     did not: FUB id, who added it, how, source, where it sits now, recruit or
     lead, and whether the lead paths already excluded it for another reason.
     Also the reverse — legacy-silenced contacts the live rule frees — which
     must be zero: the rule only ever widens.
  C. Bot email in the last --days for each newly silenced contact: the
     automation's own audit-logged sends (pond nurture, drips, seller nurture,
     recruiting) and, from FUB notes, the "[<bot>] Follow-up email sent" trail
     the Lifestyle Bot Dashboard leaves after every agent-bot email.

USAGE
    python3 soi_silence_dry_run.py [--days 30] [--max-note-lookups 4000]
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import re
import sqlite3
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from fub_automation.funnel import EMAIL_SEND_ACTIONS  # noqa: E402
from fub_automation.recruiting import RECRUITING_AUDIT_ACTION  # noqa: E402

UTC = dt.timezone.utc

#: Every audit action that is an email to a contact, lead tracks and recruiting.
BOT_SEND_ACTIONS: Tuple[str, ...] = tuple(EMAIL_SEND_ACTIONS) + (RECRUITING_AUDIT_ACTION,)
#: A real send. dry_run_sent rows are rehearsals — nothing reached an inbox.
SENT_STATUS = "sent"
#: lifestyle-bot-dashboard/server/botEngine.ts posts this after every agent-bot
#: email: "[<bot name>] Follow-up email sent by <agent> on <date>."
AGENT_BOT_SENT_NOTE = re.compile(r"^\[[^\]]+\]\s*Follow-up email sent", re.IGNORECASE)
#: The nurture-dashboard pond engine's note. A hit inside the window means that
#: engine is still sending from somewhere.
TS_POND_SENT_NOTE = re.compile(
    r"Automated two-week pond nurture outreach sent|^pond nurture .* sent", re.IGNORECASE)
#: This automation's own "email sent" notes (seller nurture, congrats). Their
#: sends are already in the audit log; the note is the FUB-side echo.
PY_SENT_NOTE_SUBJECT = re.compile(r"^Automation:.*Email Sent", re.IGNORECASE)
NOTE_KINDS = ("agent-bot email", "ts pond nurture email", "automation email note")
#: FUB returns the literal "<unspecified>" for a contact whose source was left
#: blank (measured 2026-09-28: 442 of Peter's own manual adds carry it).
BLANK_SOURCES = frozenset({"", "<unspecified>"})


def source_label(person: dict) -> str:
    """The typed source, or "<blank>" for the two ways FUB spells an empty one."""
    raw = str(person.get("source") or person.get("leadSource") or "").strip()
    return "<blank>" if raw.lower() in BLANK_SOURCES else raw


def _p(line: str = "") -> None:
    print(line, flush=True)


def _uid(value) -> Optional[int]:
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def parse_stamp(value) -> Optional[dt.datetime]:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = dt.datetime.strptime(str(value)[:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _short(ts: Optional[dt.datetime]) -> str:
    return ts.strftime("%Y-%m-%d") if ts else "-"


def legacy_soi_rule(person: dict, peter_user_id: int) -> Optional[str]:
    """The SOI rule as it stood before 2026-09-28, frozen here as the baseline:
    source contains SOI, a tag starting with SOI, or a *Manually* created
    contact by someone other than Peter. Imports were not silenced."""
    source = str(person.get("source") or person.get("leadSource") or "").lower()
    if "soi" in source:
        return "source contains SOI"
    for tag in person.get("tags") or []:
        name = str(tag.get("name") if isinstance(tag, dict) else tag or "").strip()
        if name.lower().startswith("soi"):
            return "tag starts with SOI"
    via = str(person.get("createdVia") or "").lower()
    created_by = int(person.get("createdById") or 0)
    if via == "manually" and created_by != 0 and created_by != int(peter_user_id):
        return "manually created by non-Peter user"
    return None


def audit_sends(db_path: str, person_ids: set, since: dt.datetime) -> Dict[int, List[Tuple[str, str]]]:
    """(action, last sent) per person for the automation's own real sends since `since`."""
    if not person_ids:
        return {}
    con = sqlite3.connect(db_path)
    placeholders = ",".join("?" for _ in BOT_SEND_ACTIONS)
    rows = con.execute(
        f"SELECT person_id, action, MAX(created_at) FROM audit_log "
        f"WHERE action IN ({placeholders}) AND status = ? AND created_at >= ? "
        f"GROUP BY person_id, action",
        [*BOT_SEND_ACTIONS, SENT_STATUS, since.isoformat()]).fetchall()
    con.close()
    out: Dict[int, List[Tuple[str, str]]] = collections.defaultdict(list)
    for person_id, action, last in rows:
        if person_id is not None and int(person_id) in person_ids:
            out[int(person_id)].append((str(action), str(last)[:10]))
    return out


def classify_note(note: dict, since: dt.datetime) -> Optional[Tuple[str, str]]:
    """(kind, date) when a FUB note records a bot email inside the window."""
    created = parse_stamp(note.get("created") or note.get("createdAt"))
    if created is None or created < since:
        return None
    body = str(note.get("body") or "")
    subject = str(note.get("subject") or note.get("title") or "")
    if AGENT_BOT_SENT_NOTE.match(body):
        return "agent-bot email", _short(created)
    if TS_POND_SENT_NOTE.search(body):
        return "ts pond nurture email", _short(created)
    if PY_SENT_NOTE_SUBJECT.match(subject):
        return "automation email note", _short(created)
    return None


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="SOI silence dry run, read-only.")
    parser.add_argument("--days", type=int, default=30,
                        help="Bot-email lookback for section C.")
    parser.add_argument("--max-note-lookups", type=int, default=4000,
                        help="Cap on per-contact FUB note reads in section C.")
    args = parser.parse_args(argv)

    os.environ["DRY_RUN"] = "true"
    os.environ.setdefault("FUB_DISABLE_SCHEDULER", "true")

    from fub_automation.main import AuditDB, FollowUpBossClient, RuleEngine, Rules, Settings

    settings = Settings.from_env()
    if not settings.fub_api_key:
        _p("FUB_API_KEY missing — nothing to judge.")
        return 2
    rules = Rules.load(settings.rules_path)
    peter = int(rules.peter_user_id or 2)
    db = AuditDB(settings.database_path)
    fub = FollowUpBossClient(settings)
    engine = RuleEngine(settings, rules, fub, db)
    users: Dict[int, dict] = {int(u["id"]): u for u in fub.users() if u.get("id") is not None}

    def uname(uid) -> str:
        if uid is None:
            return "?"
        if int(uid) <= 0:
            return f"system ({uid})"
        return (users.get(int(uid)) or {}).get("name") or f"user {uid}"

    now = dt.datetime.now(UTC)
    since = now - dt.timedelta(days=args.days)
    _p(f"=== SOI silence dry run — READ-ONLY — Peter is user {peter} — "
       f"bot-email window {args.days}d (since {since.date().isoformat()}) ===")

    people = fub.get_people(fields="allFields")
    _p(f"people read with fields=allFields: {len(people)}")

    # ── A. createdVia census ────────────────────────────────────────────────
    _p("\n=== A. createdVia census — how every contact was added, and by whom ===")
    census: Dict[Tuple[str, str], dict] = {}
    for person in people:
        via = str(person.get("createdVia") or "<missing>")
        key = (via, uname(_uid(person.get("createdById"))))
        row = census.setdefault(key, {"n": 0, "blank_source": 0, "ids": [], "first": None, "last": None})
        row["n"] += 1
        if source_label(person) == "<blank>":
            row["blank_source"] += 1
        if len(row["ids"]) < 3:
            row["ids"].append(int(person["id"]))
        created = parse_stamp(person.get("created"))
        if created:
            row["first"] = min(row["first"] or created, created)
            row["last"] = max(row["last"] or created, created)
    by_via = collections.Counter()
    for (via, _), row in census.items():
        by_via[via] += row["n"]
    _p(f"  distinct createdVia values: {sorted(by_via)}")
    for via, total in by_via.most_common():
        _p(f"  createdVia={via!r}: {total}")
    _p("  by createdVia x added by:")
    for (via, who), row in sorted(census.items(), key=lambda kv: (-kv[1]["n"], kv[0])):
        _p(f"    {row['n']:6d}  {via:<14} added by {who:<20} blank source {row['blank_source']:5d}  "
           f"created {_short(row['first'])}..{_short(row['last'])}  e.g. {row['ids']}")

    # ── B. live rule vs legacy rule ─────────────────────────────────────────
    _p("\n=== B. Newly silenced — live RuleEngine._is_soi_silenced vs the legacy Manually-only rule ===")
    newly: List[Tuple[dict, str]] = []
    freed: List[int] = []
    legacy_count = live_count = 0
    for person in people:
        legacy = legacy_soi_rule(person, peter)
        live = engine._is_soi_silenced(person)
        legacy_count += bool(legacy)
        live_count += bool(live)
        if live and not legacy:
            newly.append((person, live))
        elif legacy and not live:
            freed.append(int(person["id"]))
    _p(f"  legacy rule silences {legacy_count}; live rule silences {live_count}; "
       f"newly silenced {len(newly)}; freed by the change {len(freed)} (must be 0)")
    if freed:
        _p(f"  FREED — the live rule silences fewer contacts than the legacy rule: {sorted(freed)[:50]}")

    # ── C. bot email inside the window ──────────────────────────────────────
    newly_ids = {int(p["id"]) for p, _ in newly}
    sends = audit_sends(db.path, newly_ids, since)
    note_hits: Dict[int, List[Tuple[str, str]]] = collections.defaultdict(list)
    # Agent bots only email leads assigned to an agent; read those notes first,
    # pond members next, so a cap lands on the least likely targets.
    ordered = sorted(newly, key=lambda pw: (
        0 if (pw[0].get("assignedUserId") and not pw[0].get("assignedPondId")) else 1, int(pw[0]["id"])))
    looked = failed = 0
    for person, _ in ordered:
        if looked >= args.max_note_lookups:
            break
        pid = int(person["id"])
        looked += 1
        try:
            notes = fub.get_notes(pid, limit=100)
        except Exception as exc:  # noqa: BLE001
            failed += 1
            _p(f"  lead {pid}: notes unreadable ({str(exc)[:80]})")
            continue
        for note in notes:
            hit = classify_note(note, since)
            if hit:
                note_hits[pid].append(hit)
        if looked % 200 == 0:
            _p(f"  ... {looked} contacts' notes read")
    _p(f"\n=== C. Bot email in the last {args.days}d: notes read for {looked} of {len(newly)} "
       f"newly silenced contact(s), {failed} unreadable"
       + (f"; {len(newly) - looked} NOT read (cap {args.max_note_lookups})" if looked < len(newly) else "") + " ===")

    # ── per-contact lines + tallies ─────────────────────────────────────────
    tallies: Dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    emailed: List[int] = []
    out_rows: List[dict] = []
    for person, why in sorted(newly, key=lambda pw: int(pw[0]["id"])):
        pid = int(person["id"])
        via = str(person.get("createdVia") or "<missing>")
        creator = uname(_uid(person.get("createdById")))
        source = source_label(person)
        pond = person.get("assignedPondId")
        where = f"pond {pond}" if pond else f"with {uname(_uid(person.get('assignedUserId')))}"
        recruit = engine.recruiting_source(person)
        kind = "recruit (recruiting track)" if recruit else "lead"
        excluded = "" if recruit else (
            "already excluded from lead paths" if engine.is_excluded(person) else "eligible for lead paths")
        got = [f"{action} {when}" for action, when in sends.get(pid, [])]
        got += [f"{k} {when}" for k, when in sorted(set(note_hits.get(pid, [])))]
        if got:
            emailed.append(pid)
        _p(f"  lead {pid} | added by {creator} via {via} | source {source} | now {where} | "
           f"stage {person.get('stage')} | {kind}{' | ' + excluded if excluded else ''} | "
           f"rule: {why} | bot email {args.days}d: {', '.join(got) or 'none'}")
        tallies["added by / via / source"][f"{creator} / {via} / {source}"] += 1
        tallies["now"][where] += 1
        tallies["kind"][kind + (f" — {excluded}" if excluded else "")] += 1
        tallies[f"bot email in {args.days}d"]["yes" if got else "no"] += 1
        for g in got:
            tallies["bot email kind"][g.split(" 20")[0]] += 1
        out_rows.append({"id": pid, "added_by": creator, "createdVia": via, "source": source,
                         "now": where, "stage": person.get("stage"), "kind": kind,
                         "excluded": excluded, "rule": why, "bot_email": got})

    for title, counter in tallies.items():
        _p(f"\n  by {title}:")
        for key, count in counter.most_common():
            _p(f"    {count:5d}  {key}")
    _p(f"\n  → {len(newly)} contact(s) newly silenced; {len(emailed)} of them got a bot email "
       f"in the last {args.days}d: {emailed}")

    with open("soi_silence_dry_run.json", "w") as fh:
        json.dump({"generated_at": now.isoformat(), "days": args.days, "people": len(people),
                   "legacy_silenced": legacy_count, "live_silenced": live_count,
                   "freed": freed, "census": {f"{via} | {who}": row["n"] for (via, who), row in census.items()},
                   "newly_silenced": out_rows}, fh, indent=1, default=str)
    _p("\nDone. Every FUB call above was a GET; the state DB was never pushed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
