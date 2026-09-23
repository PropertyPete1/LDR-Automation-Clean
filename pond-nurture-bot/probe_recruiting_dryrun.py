#!/usr/bin/env python3
"""Read-only DRY RUN of the recruiting track and the lead-path exclusion.

Live FUB (GETs only) and a pulled copy of the real state DB. DRY_RUN is
pinned: EmailSender and every FUB write are no-ops, and the DB copy is never
pushed (the workflow's token is contents: read). COUNTS ONLY — the repo is
public: no name, address or person id is printed. The one email printed in
full is rendered for a made-up "Maria".
"""
from __future__ import annotations

import collections
import datetime as dt
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
UTC = dt.timezone.utc


def _p(line: str = "") -> None:
    print(line, flush=True)


def main() -> int:
    os.environ["DRY_RUN"] = "true"
    os.environ.setdefault("FUB_DISABLE_SCHEDULER", "true")
    from fub_automation.main import (AuditDB, FollowUpBossClient, RuleEngine, Rules, Settings,
                                     TREC_CONSUMER_PROTECTION_URL, TREC_IABS_URL)
    from fub_automation import recruiting as rt

    settings = Settings.from_env()
    if not settings.fub_api_key:
        _p("FUB_API_KEY missing"); return 2
    assert settings.dry_run, "DRY_RUN must be pinned"
    rules = Rules.load(settings.rules_path)
    db = AuditDB(settings.database_path)
    engine = RuleEngine(settings, rules, FollowUpBossClient(settings), db)
    _p(f"recruiting_sources={rules.recruiting_sources} track_enabled={rules.recruiting_track_enabled} "
       f"cadence={rules.recruiting_cadence_days}d window={rules.recruiting_first_send_window_days}d "
       f"ramp={rules.recruiting_daily_cap_ramp} owner_phone_set={bool(rules.owner_phone)}")

    _p("\n=== A. The exclusion on the live book ===")
    people = engine.fub.get_people(fields="allFields")
    recruits = [p for p in people if engine.recruiting_source(p)]
    _p(f"people: {len(people)} | recruits: {len(recruits)} | "
       f"by source: {dict(collections.Counter(str(engine.recruiting_source(p)) for p in recruits))}")
    _p(f"recruits refused by is_excluded(): {sum(1 for p in recruits if engine.is_excluded(p))} of {len(recruits)}")
    _p(f"recruits refused by _is_excluded_source(): {sum(1 for p in recruits if engine._is_excluded_source(p))} of {len(recruits)}")
    leads = [p for p in people if not engine.recruiting_source(p)]
    _p(f"non-recruits newly refused by is_excluded(): 0 expected — recruit check is source-only "
       f"(recruiting_source true for {sum(1 for p in leads if engine.recruiting_source(p))} of them)")
    ids = {int(p["id"]) for p in recruits}
    pending = [t for t in db.active_new_lead_timers() if int(t["person_id"]) in ids]
    _p(f"ACTIVE speed-to-lead timers held by recruits (next tick cancels them): {len(pending)}")

    _p("\n=== B. The recruiting gate on the live recruits ===")
    reasons = collections.Counter(engine.recruiting_suppressed(p) or "sendable" for p in recruits)
    for reason, n in reasons.most_common():
        _p(f"  {reason}: {n}")
    _p(f"  sendable AND with an email address: "
       f"{sum(1 for p in recruits if not engine.recruiting_suppressed(p) and p.get('emails'))}")

    _p("\n=== C. scan_recruiting_track() — today, dry run ===")
    outbox = []
    engine.email.send = lambda to, subject, body, **kw: outbox.append((subject, body, kw))
    counts = engine.scan_recruiting_track()
    _p(f"counts: {json.dumps(counts, sort_keys=True)}")
    rows = db.recent_audit_rows([rt.RECRUITING_AUDIT_ACTION], dt.datetime.now(UTC) - dt.timedelta(hours=1))
    statuses = collections.Counter(r["status"] for r in rows)
    _p(f"audit rows written to the (never-pushed) copy: {dict(statuses)}")
    angles = collections.Counter(json.loads(r["details"]).get("angle") for r in rows if r["status"] == "dry_run_sent")
    _p(f"angles in today's batch: {dict(angles)}")
    _p(f"subjects' max word count: {max((len(s.split()) for s, _, _ in outbox), default=0)} | "
       f"bodies with exactly one '?' above the footer: "
       f"{sum(1 for _, b, _ in outbox if b.split(chr(10) + '--' + chr(10))[0].count('?') == 1)} of {len(outbox)}")
    senders = collections.Counter((kw.get('from_email'), kw.get('reply_to')) for _, _, kw in outbox)
    _p(f"from / reply-to: {dict(senders)}")
    enrolled = db.recruiting_enrollments()
    _p(f"enrolled after the run: {len(enrolled)} | owed a first send after today's cap: "
       f"{sum(1 for r in enrolled.values() if not r['emails_sent'])}")

    _p("\n=== D. The first email, rendered for a made-up agent ===")
    angle = rt.ANGLES[0]
    subject, body = rt.compose_recruiting_email("Maria", angle, 1, rules.owner_phone)
    _p(f"Subject: {subject}")
    _p(body + "\n\n" + rt.recruiting_footer(rules.company_address, TREC_IABS_URL, TREC_CONSUMER_PROTECTION_URL))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
