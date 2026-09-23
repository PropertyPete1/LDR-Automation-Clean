#!/usr/bin/env python3
"""Read-only probe: how the bot treats recruiting-source contacts today.

Every FUB person whose source contains "New Agent Inquiry" or "Agent
Scouting" (case-insensitive — the bot's own CONTAINS rule) is a licensed
agent answering a recruiting post, not a lead. This answers, with the bot's
REAL gate code and its REAL state DB: how many there are and how recent,
where they sit (pond / assigned / Peter), which gates already stop them, and
what the automation has actually done to them — nurture sends by action,
suppressions, reply flags, speed-to-lead timers.

COUNTS ONLY. The repository is public and its run logs are world-readable:
no name, address, subject, body or person id is ever printed.

READ-ONLY: every FUB call is a GET, DRY_RUN is pinned, and the state DB is
pulled and never pushed (the workflow's token is contents: read).
"""
from __future__ import annotations

import collections
import datetime as dt
import os
import sqlite3
import sys
from pathlib import Path
from typing import Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

UTC = dt.timezone.utc
RECRUITING = ("new agent inquiry", "agent scouting")


def _p(line: str = "") -> None:
    print(line, flush=True)


def recruiting_source(person: dict) -> Optional[str]:
    source = str(person.get("source") or person.get("leadSource") or "").lower().strip()
    return next((name for name in RECRUITING if name in source), None)


def main() -> int:
    os.environ["DRY_RUN"] = "true"
    os.environ.setdefault("FUB_DISABLE_SCHEDULER", "true")
    from fub_automation.main import AuditDB, FollowUpBossClient, RuleEngine, Rules, Settings, parse_fub_datetime

    settings = Settings.from_env()
    if not settings.fub_api_key:
        _p("FUB_API_KEY missing — nothing to probe.")
        return 2
    rules = Rules.load(settings.rules_path)
    db = AuditDB(settings.database_path)
    engine = RuleEngine(settings, rules, FollowUpBossClient(settings), db)
    now = dt.datetime.now(UTC)

    _p("=== A. The book, walked whole (fields=allFields) ===")
    people = engine.fub.get_people(fields="allFields")
    _p(f"people read: {len(people)}")
    by_source: Dict[str, List[dict]] = collections.defaultdict(list)
    for person in people:
        hit = recruiting_source(person)
        if hit:
            by_source[hit].append(person)
    recruit_ids = {int(p["id"]) for group in by_source.values() for p in group}
    _p(f"recruiting-source contacts: {len(recruit_ids)} "
       f"({', '.join(f'{name}: {len(group)}' for name, group in sorted(by_source.items()))})")
    _p(f"configured excluded_sources: {sorted(rules.excluded_sources)}")
    pond_ids = [int(x) for x in (rules.pond_ids or [])]
    _p(f"pond_nurture_only={rules.pond_nurture_only} pond_ids={pond_ids} peter_user_id={rules.peter_user_id}")

    for name, group in sorted(by_source.items()):
        _p(f"\n--- source contains '{name}': {len(group)} ---")
        created = [parse_fub_datetime(p.get("created")) for p in group]
        for days in (1, 7, 30, 90):
            n = sum(1 for c in created if c and c >= now - dt.timedelta(days=days))
            _p(f"  created in the last {days:>2} days: {n}")
        exact = collections.Counter(str(p.get("source") or "").strip() for p in group)
        _p(f"  distinct source spellings: {len(exact)} (top: "
           + ", ".join(f"{s!r}×{n}" for s, n in exact.most_common(4)) + ")")
        stages = collections.Counter(str(p.get("stage") or "(none)") for p in group)
        _p("  stages: " + ", ".join(f"{s}×{n}" for s, n in stages.most_common(6)))
        in_pond = sum(1 for p in group if p.get("assignedPondId") and int(p["assignedPondId"]) in pond_ids)
        other_pond = sum(1 for p in group if p.get("assignedPondId") and int(p["assignedPondId"]) not in pond_ids)
        peter = sum(1 for p in group if str(p.get("assignedUserId") or "") == str(rules.peter_user_id))
        agent = sum(1 for p in group if p.get("assignedUserId") and str(p.get("assignedUserId")) != str(rules.peter_user_id))
        _p(f"  in the nurture pond: {in_pond} | other pond: {other_pond} | assigned to Peter: {peter} | assigned to another user: {agent}")
        tags = collections.Counter(t.lower() for p in group for t in (p.get("tags") or []) if isinstance(t, str))
        _p(f"  tagged 'agent': {tags.get('agent', 0)} | 'realtor': {tags.get('realtor', 0)} | "
           f"'replied - paused': {tags.get('replied - paused', 0)} | distinct tags: {len(tags)}")
        with_email = sum(1 for p in group if p.get("emails"))
        _p(f"  with an email address: {with_email}")
        # The pond-nurture gates, evaluated with the real predicates.
        excluded = sum(1 for p in group if engine.is_excluded(p))
        excluded_src = sum(1 for p in group if engine._is_excluded_source(p))
        soi = sum(1 for p in group if engine._is_soi_silenced(p))
        nurture_eligible = sum(
            1 for p in group
            if p.get("assignedPondId") and int(p["assignedPondId"]) in pond_ids
            and p.get("emails") and not engine.is_excluded(p)
            and not engine._is_excluded_source(p) and not engine._is_soi_silenced(p)
        )
        _p(f"  gates today — is_excluded: {excluded} | excluded source: {excluded_src} | SOI: {soi}")
        _p(f"  PASS every pond-nurture gate today (in pond, has email, no exclusion): {nurture_eligible}")

    _p("\n=== B. What the bot has done to them (state DB) ===")
    if not recruit_ids:
        _p("no recruiting-source contacts — nothing to look up")
        return 0
    with sqlite3.connect(settings.database_path) as con:
        con.execute("CREATE TEMP TABLE recruits (person_id INTEGER PRIMARY KEY)")
        con.executemany("INSERT INTO recruits VALUES (?)", [(i,) for i in recruit_ids])
        since30 = (now - dt.timedelta(days=30)).isoformat()
        for label, where in (("ALL TIME", ""), ("LAST 30 DAYS", f"AND a.created_at >= '{since30}'")):
            rows = con.execute(
                f"""SELECT a.action, a.status, COUNT(*), COUNT(DISTINCT a.person_id), MAX(a.created_at)
                    FROM audit_log a JOIN recruits r ON r.person_id = a.person_id
                    WHERE 1=1 {where}
                    GROUP BY a.action, a.status ORDER BY COUNT(*) DESC"""
            ).fetchall()
            _p(f"\n  audit_log rows for recruiting-source contacts, {label}: {sum(r[2] for r in rows)}")
            for action, status, n, people_n, last in rows[:40]:
                _p(f"    {action:<34} {status:<22} rows={n:<6} people={people_n:<5} last={str(last)[:10]}")
        for table, column in (("reengagement_log", "last_sent_at"), ("opt_outs", "opted_out_at"),
                              ("new_lead_timers", "created_at"), ("assignment_watch", None)):
            try:
                if column:
                    n, last = con.execute(
                        f"SELECT COUNT(*), MAX(t.{column}) FROM {table} t JOIN recruits r ON r.person_id = t.person_id"
                    ).fetchone()
                    _p(f"  {table}: {n} recruiting-source rows (latest {str(last)[:10]})")
                else:
                    (n,) = con.execute(
                        f"SELECT COUNT(*) FROM {table} t JOIN recruits r ON r.person_id = t.person_id"
                    ).fetchone()
                    _p(f"  {table}: {n} recruiting-source rows")
            except sqlite3.Error as exc:
                _p(f"  {table}: unreadable ({exc})")
        # Of all pond_nurture sends in the last 30 days, how many went to recruits?
        total30, recruit30 = con.execute(
            f"""SELECT COUNT(*), SUM(CASE WHEN r.person_id IS NULL THEN 0 ELSE 1 END)
                FROM audit_log a LEFT JOIN recruits r ON r.person_id = a.person_id
                WHERE a.action = 'pond_nurture' AND a.status = 'sent' AND a.created_at >= '{since30}'"""
        ).fetchone()
        _p(f"\n  pond_nurture 'sent' rows in the last 30 days: {total30} — to recruiting-source contacts: {recruit30 or 0}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
