#!/usr/bin/env python3
"""TEMPORARY read-only probe — removed again before this branch's PR is ready.

Question: how can the automation tell WHO assigned a lead to an agent?
Compares what FUB exposes for a lead Peter added and assigned vs a contact an
agent added themselves, and for leads that were REASSIGNED later:

  A. identity of the API key (GET /me) and the user roster (staff only);
  B. every person field FUB returns with fields=allFields, and which of them
     look like creator / assigner / claim evidence;
  C. createdVia x createdById x assignee over recently created people;
  D. per sample lead: the creation fields, /events rows, notes that mention
     an assignment, and a sweep of candidate timeline/history endpoints;
  E. the state DB's speed-to-lead timers (active, and warned/reassigned since
     2026-08-25) joined with the same FUB creation fields.

READ-ONLY: every FUB call is a GET, DRY_RUN is pinned, the state DB is opened
read-only (sqlite mode=ro) and never pushed.

PUBLIC LOG: this repository is public, so the output carries NO lead PII —
no names, emails, phones, addresses, note or message text. Numbers, enum
values, field NAMES, staff (FUB user) names, timestamps and HTTP statuses
only. Free text that mentions an assignment is shown as a masked template:
staff names and a small structural vocabulary survive, every other word
becomes '■'.
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
from typing import Any, Dict, Iterable, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

UTC = dt.timezone.utc
SINCE = "2026-08-25T00:00:00+00:00"

#: Person keys whose VALUES are safe to print (no lead PII).
SAFE_VALUE_KEY = re.compile(
    r"^(id|created|updated|createdVia|createdById|createdBy|assigned\w*|"
    r"claimed|firstToClaimOffer|stage|stageId|source|sourceId|contacted|"
    r"lastActivity|timeframeId|delayed|isContact|leadFlowId|\w*ById|\w*By|"
    r"\w*Via|\w*[Aa]ssign\w*|\w*[Cc]laim\w*|\w*[Oo]wner\w*)$")
#: Keys that are PII even if a pattern above would match.
PII_KEYS = {"name", "firstName", "lastName", "emails", "phones", "addresses",
            "picture", "socialData", "background", "sourceUrl", "tags",
            "collaborators", "teamLeaders", "pondMembers"}
INTERESTING_KEY = re.compile(r"assign|creat|claim|owner|flow|histor|by$|byid$|via$", re.I)

#: Words that may survive masking in an assignment-related text.
VOCAB = {
    "assigned", "assign", "reassigned", "unassigned", "assignment", "to", "by",
    "from", "the", "lead", "person", "contact", "was", "has", "been", "this",
    "is", "a", "an", "and", "via", "pond", "lead flow", "flow", "round", "robin",
    "claimed", "claim", "added", "created", "changed", "moved", "agent",
    "automatically", "auto", "system", "api", "manually", "user", "owner",
    "stage", "of", "in", "into", "for", "on", "at", "with", "rule", "group",
    "timeline", "note", "automation:", "automation", "speed-to-lead", "returned",
}
ENDPOINT_CANDIDATES = [
    "/timeline?personId={pid}", "/timelines?personId={pid}",
    "/people/{pid}/timeline", "/people/{pid}/activities", "/people/{pid}/activity",
    "/activities?personId={pid}", "/activity?personId={pid}",
    "/personActivities?personId={pid}", "/peopleActivities?personId={pid}",
    "/history?personId={pid}", "/people/{pid}/history", "/peopleHistory?personId={pid}",
    "/assignments?personId={pid}", "/people/{pid}/assignments",
    "/audit?personId={pid}", "/auditLog?personId={pid}", "/changes?personId={pid}",
    "/people/{pid}/events", "/systemEvents?personId={pid}", "/leadFlow?personId={pid}",
    "/people/{pid}", "/people/{pid}?includeHistory=true",
]
FIELD_GUESSES = ("assignedById,assignedBy,assignedAt,assignedDate,lastAssigned,"
                 "lastAssignedAt,lastAssignedById,assignmentHistory,assignedHistory,"
                 "createdById,createdBy,createdVia,leadFlowId,leadFlow,claimedById,"
                 "claimedAt,ownerId,assignedUserId,assignedTo")


def _p(line: str = "") -> None:
    print(line, flush=True)


def mask_text(text: str, staff: Iterable[str]) -> str:
    """Template of `text` keeping only staff names + VOCAB words."""
    text = re.sub(r"<[^>]+>", " ", str(text or ""))
    text = re.sub(r"\s+", " ", text).strip()[:400]
    staff_sorted = sorted({s for s in staff if s}, key=len, reverse=True)
    out: List[str] = []
    i = 0
    tokens = text.split(" ")
    while i < len(tokens):
        matched = False
        for name in staff_sorted:
            parts = name.split(" ")
            window = " ".join(tokens[i:i + len(parts)])
            if window.strip(".,;:!?()'\"").lower() == name.lower():
                out.append(f"[{name}]")
                i += len(parts)
                matched = True
                break
        if matched:
            continue
        word = tokens[i].strip(".,;:!?()'\"").lower()
        out.append(tokens[i] if word in VOCAB else "■")
        i += 1
    return re.sub(r"(■ ?)+", "■ ", " ".join(out)).strip()


def safe_person_view(person: dict, users: Dict[int, str]) -> Dict[str, Any]:
    view: Dict[str, Any] = {}
    for key in sorted(person):
        if key in PII_KEYS or key.startswith("custom"):
            continue
        if not SAFE_VALUE_KEY.match(key):
            continue
        value = person[key]
        if isinstance(value, (dict, list)):
            value = f"<{type(value).__name__} len={len(value)}>"
        view[key] = value
    for key in ("createdById", "assignedUserId"):
        uid = person.get(key)
        if uid:
            view[f"{key}__user"] = users.get(int(uid), f"user {uid}")
    return view


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hours", type=int, default=48)
    parser.add_argument("--focus", type=int, default=None)
    args, _ = parser.parse_known_args(argv)

    os.environ["DRY_RUN"] = "true"
    os.environ.setdefault("FUB_DISABLE_SCHEDULER", "true")
    from fub_automation.main import FollowUpBossClient, Rules, Settings, parse_dt

    settings = Settings.from_env()
    if not settings.fub_api_key:
        _p("FUB_API_KEY missing")
        return 2
    rules = Rules.load(settings.rules_path)
    fub = FollowUpBossClient(settings)
    peter = int(rules.peter_user_id or 2)
    recruit_words = list(getattr(rules, "recruiting_sources", []) or [])

    def is_recruit(person: dict) -> bool:
        src = str(person.get("source") or "").lower()
        return any(w and w in src for w in recruit_words)

    def get(path: str, params: Optional[dict] = None):
        """(status, json-or-None, error-text) — never raises."""
        try:
            return 200, fub._request("GET", path, params=params), ""
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            m = re.search(r"failed (\d{3})", msg)
            return (int(m.group(1)) if m else -1), None, msg[:160]

    # ── A. identity + roster ────────────────────────────────────────────────
    _p("=== A. API key identity and user roster (staff only) ===")
    st, me, err = get("/me")
    if me:
        _p(f"  /me -> id={me.get('id')} name={me.get('name')!r} role={me.get('role')!r} "
           f"isOwner={me.get('isOwner')!r} keys={sorted(me)[:40]}")
    else:
        _p(f"  /me -> {st} {err}")
    users: Dict[int, str] = {}
    st, data, err = get("/users", {"limit": 100})
    for u in (data or {}).get("users", []):
        users[int(u["id"])] = str(u.get("name") or "")
        _p(f"  user {u.get('id')}: {u.get('name')!r} role={u.get('role')!r} "
           f"status={u.get('status')!r}")
    staff_names = list(users.values())

    # ── B. person field inventory ───────────────────────────────────────────
    _p("\n=== B. Person fields returned with fields=allFields (recent 300 by created) ===")
    recent: List[dict] = []
    params: Dict[str, Any] = {"sort": "-created", "limit": 100, "fields": "allFields"}
    for _ in range(3):
        st, data, err = get("/people", dict(params))
        if not data:
            _p(f"  /people -> {st} {err}")
            break
        recent.extend(data.get("people", []))
        nxt = (data.get("_metadata") or {}).get("next")
        if not nxt:
            break
        params["next"] = nxt
    key_counts = collections.Counter(k for p in recent for k in p)
    _p(f"  people sampled: {len(recent)}")
    _p("  ALL keys: " + ", ".join(sorted(key_counts)))
    _p("  keys that could carry creator/assigner/claim evidence:")
    for key in sorted(key_counts):
        if INTERESTING_KEY.search(key):
            vals = collections.Counter(
                type(p.get(key)).__name__ + ("" if p.get(key) in (None, "", 0, False) else "+")
                for p in recent if key in p)
            _p(f"    {key}: present on {key_counts[key]}/{len(recent)} — value types {dict(vals)}")
    # One raw payload key/value view (non-PII keys only) of the newest lead.
    if recent:
        _p("  newest record, non-PII keys only:")
        _p("    " + json.dumps(safe_person_view(recent[0], users), default=str))
    # The assignment-change walk reads the DEFAULT list payload (no fields=).
    st, data, err = get("/people", {"sort": "-updated", "limit": 25})
    stubs = (data or {}).get("people", [])
    stub_keys = collections.Counter(k for p in stubs for k in p)
    _p(f"  default list payload (sort=-updated, no fields=): {len(stubs)} stubs; "
       f"createdVia on {stub_keys.get('createdVia', 0)}, createdById on "
       f"{stub_keys.get('createdById', 0)}, assignedUserId on {stub_keys.get('assignedUserId', 0)}")
    _p("  default keys: " + ", ".join(sorted(stub_keys)))

    # ── C. createdVia x creator x assignee ─────────────────────────────────
    _p("\n=== C. createdVia x createdBy x assignee (non-recruit, recent) ===")
    buckets: Dict[tuple, List[int]] = collections.defaultdict(list)
    for p in recent:
        if is_recruit(p):
            continue
        via = p.get("createdVia")
        cby = p.get("createdById")
        asg = p.get("assignedUserId")
        rel = ("unassigned" if not asg else
               "assignee=Peter" if int(asg) == peter else
               "assignee=creator" if cby and int(asg) == int(cby) else
               "assignee=other agent")
        creator = users.get(int(cby), f"user {cby}") if cby else repr(cby)
        buckets[(str(via), creator, rel, bool(p.get("assignedPondId")))].append(int(p["id"]))
    for key, pids in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
        via, creator, rel, in_pond = key
        _p(f"  createdVia={via!r:14} createdBy={creator!r:22} {rel:22} pond={in_pond!s:5} "
           f"n={len(pids):3}  e.g. {pids[:4]}")

    # ── state DB: speed-to-lead history ─────────────────────────────────────
    db_path = settings.database_path
    timers: List[dict] = []
    arm_rows: Dict[int, List[dict]] = collections.defaultdict(list)
    if Path(db_path).exists():
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        timers = [dict(r) for r in con.execute("SELECT * FROM new_lead_timers")]
        for r in con.execute(
                "SELECT created_at, person_id, status, details FROM audit_log "
                "WHERE action='new_lead_timer' AND status LIKE 'started_%' ORDER BY created_at"):
            arm_rows[int(r["person_id"] or 0)].append(dict(r))
        con.close()
    else:
        _p(f"\n(state DB {db_path} not found — section E skipped)")

    def arm_kind(timer: dict) -> str:
        created = parse_dt(timer.get("created_at") or "")
        best = None
        for row in arm_rows.get(int(timer["person_id"]), []):
            ts = parse_dt(row["created_at"])
            if created and ts and abs((ts - created).total_seconds()) <= 60:
                best = row["status"]
        return best or "?"

    since = dt.datetime.fromisoformat(SINCE)
    punished = [t for t in timers
                if any((parse_dt(t.get(k) or "") or dt.datetime.min.replace(tzinfo=UTC)) >= since
                       for k in ("warned_at", "reassigned_at"))]
    active = [t for t in timers if not t.get("canceled_at") and not t.get("reassigned_at")]

    # ── D. per-sample deep dive ─────────────────────────────────────────────
    samples: List[tuple] = []
    for key, pids in buckets.items():
        via, creator, rel, _pond = key
        if rel in ("assignee=other agent", "assignee=creator"):
            samples.extend((f"C:{via}/{creator}/{rel}", pid) for pid in pids[:2])
    for t in punished[-6:]:
        samples.append((f"E:punished/{arm_kind(t)}", int(t["person_id"])))
    for t in [t for t in active if arm_kind(t) == "started_assignment_change"][:3]:
        samples.append(("E:active/started_assignment_change", int(t["person_id"])))
    if args.focus:
        samples.insert(0, ("focus", int(args.focus)))
    seen = set()
    samples = [s for s in samples if not (s[1] in seen or seen.add(s[1]))][:18]

    _p(f"\n=== D. Deep dive on {len(samples)} sample lead(s) ===")
    endpoint_status: Dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for idx, (why, pid) in enumerate(samples):
        st, data, err = get("/people", {"id": str(pid), "fields": "allFields"})
        person = ((data or {}).get("people") or [None])[0]
        _p(f"\n  lead {pid} [{why}]")
        if not person:
            _p(f"    person fetch -> {st} {err or 'not found'}")
            continue
        _p("    person (non-PII keys): " + json.dumps(safe_person_view(person, users), default=str))

        st, data, err = get(f"/people/{pid}", {"fields": FIELD_GUESSES})
        if data is not None:
            _p(f"    fields=<guesses> -> 200, keys returned: {sorted(data)}")
        else:
            _p(f"    fields=<guesses> -> {st} {err}")

        st, data, err = get("/events", {"personId": pid, "limit": 50})
        events = (data or {}).get("events", [])
        _p(f"    /events -> {st} {len(events)} row(s) {err}")
        for ev in events[:8]:
            extra = {k: ev.get(k) for k in ev
                     if re.search(r"user|assign|by$|ById", k, re.I) and not isinstance(ev.get(k), (dict, list))}
            _p(f"      event id={ev.get('id')} created={ev.get('created')} type={ev.get('type')!r} "
               f"source={ev.get('source')!r} system={ev.get('system')!r} {extra} keys={sorted(ev)}")
            for k, v in ev.items():
                if isinstance(v, str) and re.search(r"assign", v, re.I):
                    _p(f"        {k} (masked): {mask_text(v, staff_names)}")

        st, data, err = get("/notes", {"personId": pid, "limit": 100})
        notes = (data or {}).get("notes", [])
        n_auto = sum(1 for n in notes if str(n.get("subject") or "").startswith("Automation:"))
        _p(f"    /notes -> {st} {len(notes)} row(s) ({n_auto} Automation:) {err}")
        for n in notes:
            text = f"{n.get('subject') or ''} {n.get('body') or ''}"
            if re.search(r"assign", text, re.I):
                author = users.get(int(n.get("createdById") or 0), n.get("createdById"))
                subj = str(n.get("subject") or "")
                _p(f"      note {n.get('created')} by={author!r} "
                   f"subject={subj if subj.startswith('Automation:') else '(human subject withheld)'!r} "
                   f"keys={sorted(n)}")
                _p(f"        masked: {mask_text(text, staff_names)}")

        if idx < 3:
            for tmpl in ENDPOINT_CANDIDATES:
                path = tmpl.format(pid=pid)
                q = None
                if "?" in path:
                    path, qs = path.split("?", 1)
                    q = dict(x.split("=", 1) for x in qs.split("&"))
                st, data, err = get(path, q)
                endpoint_status[tmpl][st] += 1
                if data is None:
                    _p(f"    GET {tmpl:40} -> {st} {err[:120]}")
                    continue
                top = sorted(data)[:25] if isinstance(data, dict) else type(data).__name__
                _p(f"    GET {tmpl:40} -> 200 top-level keys {top}")
                for coll in (data.values() if isinstance(data, dict) else []):
                    if isinstance(coll, list) and coll and isinstance(coll[0], dict):
                        _p(f"      item keys: {sorted(coll[0])}")
                        for item in coll[:15]:
                            enumish = {k: item.get(k) for k in item
                                       if re.search(r"^(type|kind|action|category|event\w*|"
                                                    r"created|date|time|\w*userId|\w*ById|"
                                                    r"user|status|system|source)$", k, re.I)
                                       and not isinstance(item.get(k), (dict, list))
                                       and len(str(item.get(k))) <= 40}
                            texts = [mask_text(v, staff_names) for v in item.values()
                                     if isinstance(v, str) and re.search(r"assign", v, re.I)]
                            _p(f"        {enumish} {('masked: ' + ' | '.join(texts)) if texts else ''}")
                        break

    # ── E. timers joined with FUB creation fields ───────────────────────────
    def creation_line(pid: int) -> str:
        st, data, err = get("/people", {"id": str(pid), "fields": "allFields"})
        person = ((data or {}).get("people") or [None])[0]
        if not person:
            return f"person -> {st} {err or 'not found'}"
        cby = person.get("createdById")
        asg = person.get("assignedUserId")
        return (f"createdVia={person.get('createdVia')!r} "
                f"createdBy={users.get(int(cby), cby) if cby else cby!r} "
                f"created={person.get('created')} now_assigned="
                f"{users.get(int(asg), asg) if asg else asg!r} "
                f"pond={person.get('assignedPondId')!r} claimed={person.get('claimed')!r}")

    _p(f"\n=== E1. Speed-to-lead timers warned/reassigned since {SINCE}: {len(punished)} ===")
    for t in sorted(punished, key=lambda t: t.get("warned_at") or t.get("reassigned_at") or "")[:150]:
        agent = users.get(int(t["assigned_user_id"] or 0), t["assigned_user_id"])
        _p(f"  lead {t['person_id']} agent={agent!r} armed={t['created_at']} via={arm_kind(t)} "
           f"warned={t.get('warned_at')} reassigned={t.get('reassigned_at')} | "
           f"{creation_line(int(t['person_id']))}")
    kinds = collections.Counter(arm_kind(t) for t in active)
    _p(f"\n=== E2. ACTIVE timers: {len(active)} — by arm kind {dict(kinds)} ===")
    for t in sorted(active, key=lambda t: t["created_at"])[-40:]:
        agent = users.get(int(t["assigned_user_id"] or 0), t["assigned_user_id"])
        _p(f"  lead {t['person_id']} agent={agent!r} armed={t['created_at']} via={arm_kind(t)} | "
           f"{creation_line(int(t['person_id']))}")

    _p("\n=== F. Candidate history endpoints — status tally ===")
    for tmpl, tally in endpoint_status.items():
        _p(f"  {tmpl:45} {dict(tally)}")
    st, data, err = get("/webhooks", {"limit": 100})
    hooks = (data or {}).get("webhooks", [])
    _p(f"\n  /webhooks -> {st} {len(hooks)} registered; events: "
       f"{sorted({h.get('event') for h in hooks})} {err}")
    st, data, err = get("/events", {"limit": 100, "sort": "-created"})
    evs = (data or {}).get("events", [])
    _p(f"  /events (account-wide, newest 100) -> {st}: types "
       f"{dict(collections.Counter(e.get('type') for e in evs))} "
       f"sources {dict(collections.Counter(e.get('source') for e in evs).most_common(8))}")
    _p("\nDone. Every FUB call was a GET; no lead PII printed; state DB opened read-only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
