"""Assignment-change watch (Option A), ghost sweep, and the live footer cap.

Built from the 2026-08-25 evidence run: Jose Reyes (created 07:57, assigned to
Laila ~15:55) had no timer because poll_new_leads only watches leads CREATED
in the last 24h and every intraday run was dead — the assignment diff is the
net for exactly that lead. No network: conftest's FakeHttp stands in.
"""
from __future__ import annotations

import datetime as dt
import json
import sqlite3

import pytest

UTC = dt.timezone.utc
NOW = dt.datetime.now(UTC)


def _stub(pid, agent, *, pond=None, stage="Lead", updated=None, name=("Jose", "Reyes")):
    return {
        "id": pid,
        "firstName": name[0],
        "lastName": name[1],
        "assignedUserId": agent,
        "assignedPondId": pond,
        "stage": stage,
        "tags": [],
        "updated": (updated or NOW).isoformat(),
        "phones": [],
        "emails": [],
    }


@pytest.fixture()
def watch_engine(m, engine, monkeypatch):
    sent = []
    monkeypatch.setattr(engine.email, "send",
                        lambda *a, **k: sent.append((a, k)) or None)
    monkeypatch.setattr(engine, "user_cache_by_id", lambda: {
        9: {"name": "Laila Maria", "email": "laila@example.com"},
        11: {"name": "Stefanie Graham", "email": "stef@example.com"},
    })
    engine._sent_emails = sent
    return engine


def _people_page(*stubs):
    return [(200, {"people": list(stubs)})]


def _active_timers(db):
    return db.active_new_lead_timers()


def _audit(db, action):
    return [r for r in db.recent_audit_rows([action], NOW - dt.timedelta(days=1))]


# ── the diff itself ──────────────────────────────────────────────────────────

def test_a_reassignment_to_an_agent_arms_a_timer_and_alerts(watch_engine, tmp_db, fake_http):
    """The Jose Reyes case: watched with agent 7, reassigned to agent 9 —
    timer anchored at detection, instant agent alert, watch updated."""
    tmp_db.upsert_assignment_watch(42, 7)
    fake_http.responses = _people_page(_stub(42, 9))

    watch_engine.scan_assignment_changes()

    timers = _active_timers(tmp_db)
    assert len(timers) == 1 and timers[0]["person_id"] == 42
    assert timers[0]["assigned_user_id"] == 9
    started = dt.datetime.fromisoformat(timers[0]["created_at"])
    assert abs((started - NOW).total_seconds()) < 120, "anchored at DETECTION time"
    assert tmp_db.get_assignment_watch(42)["assigned_user_id"] == 9
    assert [r["status"] for r in _audit(tmp_db, "new_lead_timer")] == ["started_assignment_change"]
    assert len(watch_engine._sent_emails) == 1, "the agent gets the instant alert"
    args, _ = watch_engine._sent_emails[0]
    assert args[0] == "laila@example.com"


def test_first_sight_is_a_baseline_not_a_change(watch_engine, tmp_db, fake_http):
    """No stored pair = nothing to diff. Record silently; catch the NEXT move."""
    fake_http.responses = _people_page(_stub(42, 9))

    watch_engine.scan_assignment_changes()

    assert _active_timers(tmp_db) == []
    assert watch_engine._sent_emails == []
    assert tmp_db.get_assignment_watch(42)["assigned_user_id"] == 9


@pytest.mark.parametrize("stub_kwargs,expected_reason", [
    ({"agent": 2}, "assigned_to_peter"),          # peter_user_id in rules.yaml is 2
    ({"agent": 9, "pond": 2}, "moved_into_pond"),
    ({"agent": 16}, "excluded_agent"),            # 16 is in excluded_user_ids
])
def test_guarded_moves_update_the_watch_but_never_arm(watch_engine, tmp_db, fake_http,
                                                      stub_kwargs, expected_reason):
    tmp_db.upsert_assignment_watch(42, 7)
    agent = stub_kwargs.pop("agent")
    fake_http.responses = _people_page(_stub(42, agent, **stub_kwargs))

    watch_engine.scan_assignment_changes()

    assert _active_timers(tmp_db) == []
    assert watch_engine._sent_emails == []
    skips = _audit(tmp_db, "assignment_change")
    assert len(skips) == 1
    assert json.loads(skips[0]["details"])["reason"] == expected_reason
    assert tmp_db.get_assignment_watch(42)["assigned_user_id"] == agent, \
        "the watch still learns the new pair"


def test_an_automation_move_is_not_a_distribution(watch_engine, tmp_db, fake_http):
    """The 20-day reassignment moved this lead minutes ago — our own audit row
    proves it, and the watch must not page anyone about our own action."""
    tmp_db.upsert_assignment_watch(42, 7)
    tmp_db.log("stale_agent_pond_reassignment", "completed", 42, {})
    fake_http.responses = _people_page(_stub(42, 9))

    watch_engine.scan_assignment_changes()

    assert _active_timers(tmp_db) == []
    skips = _audit(tmp_db, "assignment_change")
    assert json.loads(skips[0]["details"])["reason"] == "automation_move"


def test_bulk_distribution_pages_peter_once_not_every_agent(watch_engine, tmp_db, fake_http):
    """Six moves in one run reads as a manual distribution: six timers, zero
    agent alerts, one digest to Peter."""
    stubs = []
    for pid in range(101, 107):
        tmp_db.upsert_assignment_watch(pid, 7)
        stubs.append(_stub(pid, 9, name=("Lead", str(pid))))
    fake_http.responses = _people_page(*stubs)

    watch_engine.scan_assignment_changes()

    assert len(_active_timers(tmp_db)) == 6
    assert len(watch_engine._sent_emails) == 1, "one digest, not six pages"
    args, kwargs = watch_engine._sent_emails[0]
    assert args[0] == watch_engine.rules.owner_email
    assert "Bulk distribution" in args[1]
    assert len(_audit(tmp_db, "assignment_bulk_digest")) == 1


def test_a_rearmed_person_holds_two_generations(watch_engine, tmp_db, fake_http):
    """The lead had a timer weeks ago (completed); a fresh reassignment arms a
    NEW generation, and milestones land only on the active one."""
    old_anchor = (NOW - dt.timedelta(days=20)).isoformat()
    tmp_db.add_new_lead_timer(42, 7, created_at=old_anchor)
    tmp_db.cancel_timer(42)
    tmp_db.upsert_assignment_watch(42, 7)
    fake_http.responses = _people_page(_stub(42, 9))

    watch_engine.scan_assignment_changes()

    with tmp_db.connect() as con:
        rows = con.execute(
            "SELECT created_at, canceled_at FROM new_lead_timers WHERE person_id=42 "
            "ORDER BY created_at").fetchall()
    assert len(rows) == 2, "repeat timers are distinct generations"
    assert rows[0][1] is not None and rows[1][1] is None

    tmp_db.mark_warned(42)
    with tmp_db.connect() as con:
        warned = con.execute(
            "SELECT created_at FROM new_lead_timers WHERE person_id=42 AND warned_at IS NOT NULL"
        ).fetchall()
    assert [w[0] for w in warned] != [old_anchor], \
        "the warning lands on the active generation, never the completed one"


def test_the_walk_stops_at_the_window_edge(watch_engine, tmp_db, fake_http):
    stale = _stub(42, 9, updated=NOW - dt.timedelta(hours=30))
    fake_http.responses = _people_page(stale)

    watch_engine.scan_assignment_changes()

    assert len(fake_http.calls) == 1, "one page, then stop at the stale record"
    assert _active_timers(tmp_db) == []


# ── legacy schema migration ──────────────────────────────────────────────────

def test_a_legacy_state_db_migrates_to_timer_generations(m, tmp_path):
    """A pulled state DB still has PRIMARY KEY person_id — opening it must
    rebuild to (person_id, created_at) and keep every row."""
    path = tmp_path / "legacy.sqlite3"
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE new_lead_timers (
            person_id INTEGER PRIMARY KEY,
            created_at TEXT NOT NULL,
            assigned_user_id INTEGER,
            warned_at TEXT,
            reassigned_at TEXT,
            canceled_at TEXT
        );
        INSERT INTO new_lead_timers VALUES (42, '2026-08-07T17:57:18Z', 35,
                                            NULL, NULL, '2026-08-08T13:23:07Z');
        """
    )
    con.commit()
    con.close()

    db = m.AuditDB(str(path))

    con = sqlite3.connect(db.path)
    sql = con.execute(
        "SELECT sql FROM sqlite_master WHERE name='new_lead_timers'").fetchone()[0]
    assert "PRIMARY KEY (person_id, created_at)" in sql
    rows = con.execute("SELECT person_id, created_at, canceled_at FROM new_lead_timers").fetchall()
    con.close()
    assert rows == [(42, "2026-08-07T17:57:18Z", "2026-08-08T13:23:07Z")]
    # And re-opening (migration already done) changes nothing.
    m.AuditDB(str(path))


# ── the touched check: only the assigned agent, only at/after the anchor ─────
# Policy 2026-08-26: a speed-to-lead timer is cancelled as "touched" ONLY by
# the ASSIGNED AGENT's own activity, timestamped at or after the timer's
# anchor. Bot sends stay excluded, as before.

def test_a_nurture_send_does_not_count_as_first_touch(watch_engine, tmp_db, fake_http):
    """The pond email syncs into FUB and bumps lastSentEmail like an agent's
    mail — its /emails row carries the API-key user (2), not the agent, and it
    matches our own audit send. It must not cancel a timer."""
    send_ts = NOW - dt.timedelta(hours=1)
    tmp_db.log("pond_nurture", "sent", 42, {})
    with tmp_db.connect() as con:
        con.execute("UPDATE audit_log SET created_at=? WHERE person_id=42",
                    ((send_ts + dt.timedelta(seconds=40)).isoformat(),))
    person = _stub(42, 9)
    person["lastSentEmail"] = send_ts.isoformat()
    bot_email = {"id": 51937, "created": send_ts.isoformat(), "userId": 2,
                 "relatedPeople": [{"personId": 42, "sentByPerson": False}]}
    fake_http.responses = [
        (200, {"emails": [bot_email]}),  # the synced copy of our own send
        (200, {}),                       # notes lookup finds nothing
    ]

    anchor = NOW - dt.timedelta(hours=3)
    assert watch_engine.lead_touched_after_creation(person, anchor, assigned_user_id=9) is False


def test_the_assigned_agents_own_email_counts_as_touch(watch_engine, tmp_db, fake_http):
    person = _stub(42, 9)
    sent_at = NOW - dt.timedelta(hours=1)
    person["lastSentEmail"] = sent_at.isoformat()
    agent_email = {"id": 52001, "created": sent_at.isoformat(), "userId": 9,
                   "relatedPeople": [{"personId": 42, "sentByPerson": False}]}
    fake_http.responses = [(200, {"emails": [agent_email]})]

    anchor = NOW - dt.timedelta(hours=3)
    assert watch_engine.lead_touched_after_creation(person, anchor, assigned_user_id=9) is True


def test_someone_elses_activity_is_not_the_agents_touch(watch_engine, tmp_db, fake_http):
    """Another agent texting and noting the lead after the anchor is real human
    activity — but not the ASSIGNED agent's, so the timer must keep running."""
    anchor = NOW - dt.timedelta(minutes=20)
    person = _stub(42, 9)
    person["lastSentText"] = (anchor + dt.timedelta(minutes=5)).isoformat()
    other_text = {"id": 5, "created": (anchor + dt.timedelta(minutes=5)).isoformat(),
                  "userId": 11, "isIncoming": False, "message": "following up"}
    other_note = {"id": 8, "created": (anchor + dt.timedelta(minutes=6)).isoformat(),
                  "createdById": 11, "subject": "Spoke with them"}
    fake_http.responses = [
        (200, {"textMessages": [other_text]}),
        (200, {"notes": [other_note]}),
    ]

    assert watch_engine.lead_touched_after_creation(person, anchor, assigned_user_id=9) is False


def test_the_agents_own_note_at_the_anchor_instant_counts(watch_engine, tmp_db, fake_http):
    """AT OR AFTER means the anchor instant itself qualifies — no grace buffer
    shaves off a note the agent wrote the second the alert landed."""
    anchor = NOW - dt.timedelta(minutes=20)
    person = _stub(42, 9)
    note = {"id": 9, "created": anchor.isoformat(), "createdById": 9,
            "subject": "Called — left voicemail"}
    fake_http.responses = [(200, {"notes": [note]})]

    assert watch_engine.lead_touched_after_creation(person, anchor, assigned_user_id=9) is True


def test_a_pre_timer_note_never_cancels_the_timer(watch_engine, tmp_db, fake_http):
    """The Jose Brito case: his record carried a note from 13:23; the
    assignment-change timer was anchored 13:57. Under the old rule the touch
    anchor was back-dated to the lead's FUB creation, so the pre-timer note
    cancelled the escalation. Activity from before the timer existed — even
    the assigned agent's own — must never cancel it."""
    anchor = NOW - dt.timedelta(minutes=10)
    tmp_db.add_new_lead_timer(42, 9, created_at=anchor.isoformat())
    person = _stub(42, 9)
    person["created"] = (NOW - dt.timedelta(days=30)).isoformat()
    pre_timer_note = {"id": 7, "created": (anchor - dt.timedelta(minutes=34)).isoformat(),
                      "createdById": 9, "subject": "Left a voicemail"}
    fake_http.responses = [
        (200, {"people": [person]}),        # get_person
        (200, {"notes": [pre_timer_note]}),  # 13:23 vs a 13:57 anchor
    ]

    watch_engine.process_new_lead_timers()

    assert [t["person_id"] for t in _active_timers(tmp_db)] == [42], \
        "the pre-timer note cancelled the timer — the Brito bug is back"
    assert _audit(tmp_db, "new_lead_timer") == []


def test_the_assigned_agents_text_after_the_alert_cancels(watch_engine, tmp_db, fake_http):
    """Five minutes after the speed-to-lead alert, the assigned agent texts the
    lead — exactly the response the alert asks for, and it must cancel."""
    anchor = NOW - dt.timedelta(minutes=20)
    tmp_db.add_new_lead_timer(42, 9, created_at=anchor.isoformat())
    person = _stub(42, 9)
    person["lastSentText"] = (anchor + dt.timedelta(minutes=5)).isoformat()
    agent_text = {"id": 6, "created": (anchor + dt.timedelta(minutes=5)).isoformat(),
                  "userId": 9, "isIncoming": False, "message": "Hi! Just saw your inquiry"}
    fake_http.responses = [
        (200, {"people": [person]}),
        (200, {"textMessages": [agent_text]}),
    ]

    watch_engine.process_new_lead_timers()

    assert _active_timers(tmp_db) == []
    assert [r["status"] for r in _audit(tmp_db, "new_lead_timer")] == ["canceled_touched"]


# ── ghost sweep ──────────────────────────────────────────────────────────────

def test_deleted_leads_are_cleared_from_every_watch_surface(watch_engine, tmp_db, fake_http, monkeypatch):
    """The Stephen Herrera case: his record was deleted and his NEEDS A REPLY
    entry lived on. The sweep resolves every watched person; ghosts get one
    lead_deleted row, their watch row is dropped and their timer cancelled."""
    tmp_db.log("reply_detected", "alert_sent", 42, {
        "reply_at": (NOW - dt.timedelta(days=2)).isoformat(),
        "reply_snippet": "UNSUBSCRIBE", "contact_name": "Stephen Herrera",
        "reply_channel": "email",
    })
    tmp_db.upsert_assignment_watch(43, 9)
    tmp_db.add_new_lead_timer(44, 9)
    alive = {44: _stub(44, 9)}
    monkeypatch.setattr(watch_engine.fub, "get_person", lambda pid: alive.get(pid))

    watch_engine.scan_deleted_leads()

    deleted = {r["person_id"] for r in _audit(tmp_db, "lead_deleted")}
    assert deleted == {42, 43}
    assert tmp_db.get_assignment_watch(43) is None
    assert [t["person_id"] for t in _active_timers(tmp_db)] == [44]

    # And the needs-reply collector honours the lead_deleted closing event.
    fake_http.responses = [(200, {})]
    assert watch_engine._collect_needs_reply() == []


def test_the_sweep_never_pays_for_the_same_ghost_twice(watch_engine, tmp_db, monkeypatch):
    tmp_db.upsert_assignment_watch(43, 9)
    calls = []
    monkeypatch.setattr(watch_engine.fub, "get_person",
                        lambda pid: calls.append(pid) or None)

    watch_engine.scan_deleted_leads()
    watch_engine.scan_deleted_leads()

    assert calls == [43], "a marked ghost is never re-checked"


# ── the live footer cap ──────────────────────────────────────────────────────

def test_the_footer_reports_the_ramp_cap_not_the_yaml_fallback(watch_engine, tmp_db, fake_http):
    from fub_automation import ramp

    with tmp_db.connect() as con:
        ramp.ensure_schema(con)
        ramp.save_state(con, step_index=1, last_advanced_at=NOW.isoformat(),
                        last_evaluated_at=NOW.isoformat(), holding=False, hold_reason=None)
    tmp_db.log("pond_nurture", "sent", 7, {"city": "Austin"})
    fake_http.responses = [(200, {})]

    watch_engine.send_phase2_daily_summary()

    assert watch_engine._sent_emails, "no summary email was sent"
    args, kwargs = watch_engine._sent_emails[-1]
    plain = str(kwargs.get("body") or (args[2] if len(args) > 2 else ""))
    html_body = str(kwargs.get("html_body") or "")
    assert "Capped at 200 emails (ramp-controlled)" in plain
    assert "Capped at 200 emails (ramp-controlled)" in html_body
    assert "Capped at 150" not in plain


# ── the escalations themselves ───────────────────────────────────────────────
# Until 2026-08-26 nothing drove a timer ACROSS the 30/60-minute lines — the
# suite pinned discovery, dedup, anchors and cancellation, but never that an
# old-enough timer actually warns or reassigns. new_lead_timer_mode="24_7"
# makes the elapsed-minutes math wall-clock so the tests hold at any hour.

def test_the_thirty_minute_warning_actually_fires(watch_engine, tmp_db, fake_http):
    watch_engine.rules.new_lead_timer_mode = "24_7"
    watch_engine.settings.dry_run = False  # let the FUB writes hit the fake
    anchor = NOW - dt.timedelta(minutes=35)
    tmp_db.add_new_lead_timer(42, 9, created_at=anchor.isoformat())
    fake_http.responses = [
        (200, {"people": [_stub(42, 9)]}),  # get_person
        (200, {}),                          # touch check: no notes
        (200, {"id": 900}),                 # POST /tasks
        (200, {"id": 901}),                 # POST /notes — the warning
    ]

    watch_engine.process_new_lead_timers()

    posts = [c for c in fake_http.calls if c.method == "POST"]
    assert [c.url.rsplit("/", 1)[-1] for c in posts] == ["tasks", "notes"]
    task, note = posts
    assert task.json["personId"] == 42 and task.json["assignedUserId"] == 9
    assert note.json["subject"] == "Automation: speed-to-lead warning", \
        "the Automation: prefix is what stops the warning counting as a touch"
    assert "@Laila Maria" in note.json["body"]
    with tmp_db.connect() as con:
        row = con.execute(
            "SELECT warned_at, reassigned_at FROM new_lead_timers WHERE person_id=42"
        ).fetchone()
    assert row[0] is not None and row[1] is None, \
        "warned, not reassigned — the 60-minute line has not been crossed"
    assert [r["status"] for r in _audit(tmp_db, "new_lead_warning")] == ["created"]
    assert [t["person_id"] for t in _active_timers(tmp_db)] == [42], \
        "a warning must not resolve the timer"


def test_the_sixty_minute_reassignment_actually_fires(watch_engine, tmp_db, fake_http):
    """An unwarned timer crossing 60 business minutes gets the late warning
    AND the reassignment to Peter, in that order, with the audit trail."""
    watch_engine.rules.new_lead_timer_mode = "24_7"
    watch_engine.settings.dry_run = False
    anchor = NOW - dt.timedelta(minutes=65)
    tmp_db.add_new_lead_timer(42, 9, created_at=anchor.isoformat())
    fake_http.responses = [
        (200, {"people": [_stub(42, 9)]}),  # get_person
        (200, {}),                          # touch check: no notes
        (200, {"id": 901}),                 # POST /notes — late warning
        (200, {}),                          # PUT /people/42 — assignedUserId
        (200, {}),                          # PUT /people/42 — merge tag
        (200, {"id": 902}),                 # POST /notes — reassignment note
    ]

    watch_engine.process_new_lead_timers()

    note_posts = [c for c in fake_http.calls
                  if c.method == "POST" and c.url.endswith("/notes")]
    assert [c.json["subject"] for c in note_posts] == [
        "Automation: speed-to-lead reassignment",
        "Automation: reassigned for no first touch",
    ]
    puts = [c for c in fake_http.calls if c.method == "PUT"]
    assert puts and puts[0].url.endswith("/people/42")
    assert puts[0].json == {"assignedUserId": 2}, "the lead goes back to Peter"
    with tmp_db.connect() as con:
        row = con.execute(
            "SELECT warned_at, reassigned_at FROM new_lead_timers WHERE person_id=42"
        ).fetchone()
    assert row[0] is not None and row[1] is not None
    assert [r["status"] for r in _audit(tmp_db, "new_lead_warning")] == ["created_at_reassignment"]
    assert [r["status"] for r in _audit(tmp_db, "new_lead_reassigned")] == ["completed"]
    assert _active_timers(tmp_db) == [], "a reassigned timer leaves the active set"
    args, _ = watch_engine._sent_emails[-1]
    assert args[0] == watch_engine.rules.owner_email, "Peter gets the reassignment email"


# ── the detection gap: touch anchor vs budget anchor (2026-08-29) ────────────
# Sunny Chamadia (6343): created 20:22Z, CALLED by her assigned agent at
# 20:46Z, discovered by polling at 22:13Z. The 2026-08-26 rule anchored the
# TOUCH check at detection, so the 20:46 call was refused, the lead warned at
# 10:09 CT and bounced back to Peter — as did four siblings. The corrected
# policy separates the anchors: created_at still runs the 30/60 budget from
# detection (a stale lead must not be insta-reassigned), while the touch check
# runs from when the assignment became the agent's — the lead's CREATION for
# polling timers, the PREVIOUS completed scan for assignment-change timers.
# Assigned-agent-only, bot-send exclusion and fail-closed are all unchanged.

def test_the_sunny_shape_a_call_before_discovery_never_arms(watch_engine, tmp_db, fake_http):
    """The incident itself: agent calls 24 minutes after creation, polling
    discovers the lead two hours later — no timer, no page, an audit row."""
    created = NOW - dt.timedelta(hours=2)
    person = _stub(42, 9)
    person["created"] = created.isoformat()
    full = dict(person)
    full["lastCall"] = (created + dt.timedelta(minutes=24)).isoformat()
    agent_call = {"id": 71, "created": (created + dt.timedelta(minutes=24)).isoformat(),
                  "userId": 9, "isIncoming": False}
    fake_http.responses = [
        (200, {"people": [person]}),  # the createdAfter poll page
        (200, {"people": [full]}),    # the at-arm full record
        (200, {"calls": [agent_call]}),
    ]

    watch_engine.poll_new_leads()

    with tmp_db.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM new_lead_timers").fetchone()[0] == 0
    assert [r["status"] for r in _audit(tmp_db, "new_lead_timer")] == ["skipped_already_touched"]
    assert watch_engine._sent_emails == [], \
        "no 'contact within 30 min' page for a lead the agent already contacted"


def test_an_already_touched_skip_is_remembered_across_polls(watch_engine, tmp_db, fake_http):
    """The skip leaves no timer row, so without the audit-row dedup every
    later tick would re-spend the API calls re-proving the same touch."""
    created = NOW - dt.timedelta(hours=2)
    person = _stub(42, 9)
    person["created"] = created.isoformat()
    full = dict(person)
    full["lastCall"] = (created + dt.timedelta(minutes=24)).isoformat()
    agent_call = {"id": 71, "created": (created + dt.timedelta(minutes=24)).isoformat(),
                  "userId": 9, "isIncoming": False}
    fake_http.responses = [
        (200, {"people": [person]}),
        (200, {"people": [full]}),
        (200, {"calls": [agent_call]}),
        (200, {"people": [person]}),  # the next poll's page
    ]

    watch_engine.poll_new_leads()
    calls_after_first = len(fake_http.calls)
    watch_engine.poll_new_leads()

    assert len(fake_http.calls) == calls_after_first + 1, \
        "the second poll should cost one page fetch, not a fresh touch check"
    assert [r["status"] for r in _audit(tmp_db, "new_lead_timer")] == ["skipped_already_touched"]


def test_a_polling_timer_records_creation_as_the_touch_anchor(watch_engine, tmp_db, fake_http):
    created = NOW - dt.timedelta(hours=20)
    person = _stub(42, 9)
    person["created"] = created.isoformat()
    fake_http.responses = [
        (200, {"people": [person]}),  # the createdAfter poll page
        (200, {"people": [person]}),  # the at-arm full record
        (200, {"notes": []}),         # untouched
    ]

    watch_engine.poll_new_leads()

    timers = _active_timers(tmp_db)
    assert len(timers) == 1
    budget = dt.datetime.fromisoformat(timers[0]["created_at"])
    assert abs((budget - NOW).total_seconds()) < 120, \
        "the 30/60 budget must still anchor at detection"
    touch = dt.datetime.fromisoformat(timers[0]["touch_anchor_at"])
    assert abs((touch - created).total_seconds()) < 1, \
        "the touch clock starts at the lead's creation, not our discovery"
    assert len(watch_engine._sent_emails) == 1, "an untouched lead still pages the agent"


def test_an_assignment_change_timer_anchors_touch_at_the_previous_scan(watch_engine, tmp_db, fake_http):
    prev = NOW - dt.timedelta(minutes=45)
    tmp_db.log("assignment_scan", "completed", None, {"observed_at": prev.isoformat()})
    tmp_db.upsert_assignment_watch(42, 7)
    fake_http.responses = _people_page(_stub(42, 9))

    watch_engine.scan_assignment_changes()

    timers = _active_timers(tmp_db)
    assert len(timers) == 1
    touch = dt.datetime.fromisoformat(timers[0]["touch_anchor_at"])
    assert abs((touch - prev).total_seconds()) < 1, \
        "the touch anchor is the previous completed observation"
    budget = dt.datetime.fromisoformat(timers[0]["created_at"])
    assert abs((budget - NOW).total_seconds()) < 120


def test_the_first_scan_ever_falls_back_to_the_walk_window_anchor(watch_engine, tmp_db, fake_http):
    """No completed row yet: the walk cannot detect a change older than its
    24h window, so that window is the defensible lower bound."""
    tmp_db.upsert_assignment_watch(42, 7)
    fake_http.responses = _people_page(_stub(42, 9))

    watch_engine.scan_assignment_changes()

    timers = _active_timers(tmp_db)
    touch = dt.datetime.fromisoformat(timers[0]["touch_anchor_at"])
    expected = NOW - dt.timedelta(hours=24)
    assert abs((touch - expected).total_seconds()) < 120


def test_a_touch_inside_the_detection_gap_never_arms(watch_engine, tmp_db, fake_http):
    """The assignment-change flavour of the Sunny shape: the agent noted the
    lead between the previous observation and this detection."""
    prev = NOW - dt.timedelta(minutes=45)
    tmp_db.log("assignment_scan", "completed", None, {"observed_at": prev.isoformat()})
    tmp_db.upsert_assignment_watch(42, 7)
    stub = _stub(42, 9)
    note = {"id": 9, "created": (NOW - dt.timedelta(minutes=10)).isoformat(),
            "createdById": 9, "subject": "Called — left VM and texted"}
    fake_http.responses = [
        (200, {"people": [stub]}),  # the -updated walk page
        (200, {"people": [stub]}),  # the at-arm full record
        (200, {"notes": [note]}),
    ]

    watch_engine.scan_assignment_changes()

    assert _active_timers(tmp_db) == []
    assert [r["status"] for r in _audit(tmp_db, "new_lead_timer")] == ["skipped_already_touched"]
    assert watch_engine._sent_emails == []
    assert tmp_db.get_assignment_watch(42)["assigned_user_id"] == 9, \
        "the watch still learns the new pair"


def test_a_note_before_the_touch_anchor_still_never_cancels(watch_engine, tmp_db, fake_http):
    """The Brito protection, restated for the new anchor: activity from before
    the touch anchor — even the assigned agent's own — contributes nothing."""
    anchor = NOW - dt.timedelta(minutes=40)
    tmp_db.add_new_lead_timer(42, 9, created_at=(NOW - dt.timedelta(minutes=10)).isoformat(),
                              touch_anchor_at=anchor.isoformat())
    person = _stub(42, 9)
    old_note = {"id": 7, "created": (anchor - dt.timedelta(minutes=5)).isoformat(),
                "createdById": 9, "subject": "Left a voicemail"}
    fake_http.responses = [
        (200, {"people": [person]}),
        (200, {"notes": [old_note]}),
    ]

    watch_engine.process_new_lead_timers()

    assert [t["person_id"] for t in _active_timers(tmp_db)] == [42]
    assert _audit(tmp_db, "new_lead_timer") == []


def test_a_stored_touch_anchor_lets_a_later_tick_see_the_gap_touch(watch_engine, tmp_db, fake_http):
    """Fail-closed at arm time means an API outage still arms the timer — but
    the stored anchor lets the NEXT tick recognise the same gap touch and
    cancel instead of warning."""
    touch_anchor = NOW - dt.timedelta(hours=2)
    tmp_db.add_new_lead_timer(42, 9, created_at=(NOW - dt.timedelta(minutes=20)).isoformat(),
                              touch_anchor_at=touch_anchor.isoformat())
    person = _stub(42, 9)
    person["lastCall"] = (NOW - dt.timedelta(minutes=96)).isoformat()
    agent_call = {"id": 71, "created": (NOW - dt.timedelta(minutes=96)).isoformat(),
                  "userId": 9, "isIncoming": False}
    fake_http.responses = [
        (200, {"people": [person]}),
        (200, {"calls": [agent_call]}),
    ]

    watch_engine.process_new_lead_timers()

    assert _active_timers(tmp_db) == []
    assert [r["status"] for r in _audit(tmp_db, "new_lead_timer")] == ["canceled_touched"]


def test_duplicate_active_generations_fire_once(watch_engine, tmp_db, fake_http):
    """The 2026-08-28 state-pull race gave Sunny TWO started_polling rows and
    the loop reassigned her twice, five seconds apart. One person, one action
    per run — whatever fires stamps every active generation."""
    watch_engine.rules.new_lead_timer_mode = "24_7"
    watch_engine.settings.dry_run = False
    tmp_db.add_new_lead_timer(42, 9, created_at=(NOW - dt.timedelta(minutes=70)).isoformat())
    tmp_db.add_new_lead_timer(42, 9, created_at=(NOW - dt.timedelta(minutes=65)).isoformat())
    fake_http.responses = [
        (200, {"people": [_stub(42, 9)]}),  # get_person
        (200, {}),                          # touch check: no notes
        (200, {"id": 901}),                 # POST /notes — late warning
        (200, {}),                          # PUT — assignedUserId
        (200, {}),                          # PUT — merge tag
        (200, {"id": 902}),                 # POST /notes — reassignment note
    ]

    watch_engine.process_new_lead_timers()

    assert [r["status"] for r in _audit(tmp_db, "new_lead_reassigned")] == ["completed"]
    note_posts = [c for c in fake_http.calls
                  if c.method == "POST" and c.url.endswith("/notes")]
    assert len(note_posts) == 2, "the second generation re-warned or re-reassigned"
    with tmp_db.connect() as con:
        stamps = con.execute(
            "SELECT reassigned_at FROM new_lead_timers WHERE person_id=42").fetchall()
    assert all(s[0] is not None for s in stamps), \
        "both generations must leave the active set"


def test_a_repaired_lead_is_not_rearmed_for_a_day(watch_engine, tmp_db, fake_http):
    """The false-positive repair restores the original agent — an assignment
    change. A racing run holding pre-repair watch state must not re-arm and
    re-page; the repair row suppresses for 24h, well past the 30-minute
    automation window."""
    tmp_db.log("speed_to_lead_repair", "reassignment_reverted", 42, {})
    with tmp_db.connect() as con:
        con.execute("UPDATE audit_log SET created_at=? WHERE action='speed_to_lead_repair'",
                    ((NOW - dt.timedelta(hours=2)).isoformat(),))
    tmp_db.upsert_assignment_watch(42, 2)
    fake_http.responses = _people_page(_stub(42, 9))

    watch_engine.scan_assignment_changes()

    assert _active_timers(tmp_db) == []
    assert watch_engine._sent_emails == []
    skips = _audit(tmp_db, "assignment_change")
    assert json.loads(skips[0]["details"])["reason"] == "repair_suppressed"


def test_every_completed_walk_logs_its_observation(watch_engine, tmp_db, fake_http):
    """The completion row IS the next run's touch anchor — an uneventful walk
    must log it too, or the anchor drifts back and over-forgives."""
    fake_http.responses = _people_page(_stub(42, 9))  # first sight → baseline only

    watch_engine.scan_assignment_changes()

    rows = _audit(tmp_db, "assignment_scan")
    assert [r["status"] for r in rows] == ["completed"]
    observed = json.loads(rows[0]["details"])["observed_at"]
    assert abs((dt.datetime.fromisoformat(observed) - NOW).total_seconds()) < 120, \
        "the stamp is the walk's start, so an anchor can never postdate an observation"


def test_a_page_capped_walk_never_advances_the_touch_anchor(watch_engine, tmp_db, fake_http):
    """A bulk sweep can keep 500+ records above a lead in the -updated sort;
    such a walk observed only a slice, so trusting its stamp would let the
    anchor postdate an agent's real first touch — the Sunny class again, via
    scan-cap blindness. The walk logs 'truncated' and advances nothing."""
    watch_engine.ASSIGNMENT_SCAN_MAX_PAGES = 1
    prev = NOW - dt.timedelta(hours=3)
    tmp_db.log("assignment_scan", "completed", None, {"observed_at": prev.isoformat()})
    tmp_db.upsert_assignment_watch(42, 7)
    page = {"people": [_stub(42, 9)], "_metadata": {"next": "cursor-2"}}
    fake_http.responses = [
        (200, page),                  # page 1 of a walk with more left
        (200, {"people": [_stub(42, 9)]}),  # at-arm full record
        (200, {"notes": []}),
    ]

    watch_engine.scan_assignment_changes()

    rows = _audit(tmp_db, "assignment_scan")
    assert [r["status"] for r in rows] == ["truncated", "completed"], \
        "a page-capped walk must not claim it observed the whole window"
    timers = _active_timers(tmp_db)
    touch = dt.datetime.fromisoformat(timers[0]["touch_anchor_at"])
    assert abs((touch - prev).total_seconds()) < 1, \
        "the anchor must stay at the last WHOLE-window observation"


def test_a_repaired_leads_racing_timer_is_canceled_not_fired(watch_engine, tmp_db, fake_http):
    """The repair's restore is an assignment change; a tick that pulled state
    before the repair pushed can have armed a timer for it. Once the rows
    merge, the next tick must cancel that timer — never warn on it."""
    tmp_db.log("speed_to_lead_repair", "reassignment_reverted", 42, {})
    tmp_db.add_new_lead_timer(42, 9, created_at=(NOW - dt.timedelta(minutes=35)).isoformat())

    watch_engine.process_new_lead_timers()

    assert _active_timers(tmp_db) == []
    assert [r["status"] for r in _audit(tmp_db, "new_lead_timer")] == \
        ["canceled_repair_suppressed"]
    assert _audit(tmp_db, "new_lead_warning") == [], "no warning may fire on a repaired lead"


def test_duplicate_generations_use_the_earliest_touch_anchor(watch_engine, tmp_db, fake_http):
    """A legacy NULL-anchor duplicate must not mask its sibling's knowledge of
    the real assignment moment: the merged judgement takes the earliest touch
    clock, so the gap touch still cancels."""
    touch_anchor = NOW - dt.timedelta(hours=2)
    tmp_db.add_new_lead_timer(42, 9, created_at=(NOW - dt.timedelta(minutes=20)).isoformat())
    tmp_db.add_new_lead_timer(42, 9, created_at=(NOW - dt.timedelta(minutes=15)).isoformat(),
                              touch_anchor_at=touch_anchor.isoformat())
    person = _stub(42, 9)
    person["lastCall"] = (NOW - dt.timedelta(minutes=96)).isoformat()
    agent_call = {"id": 71, "created": (NOW - dt.timedelta(minutes=96)).isoformat(),
                  "userId": 9, "isIncoming": False}
    fake_http.responses = [
        (200, {"people": [person]}),
        (200, {"calls": [agent_call]}),
    ]

    watch_engine.process_new_lead_timers()

    assert _active_timers(tmp_db) == []
    assert [r["status"] for r in _audit(tmp_db, "new_lead_timer")] == ["canceled_touched"]


# ── notes count only when they document actual contact (2026-08-29 policy) ───
# Peter's follow-up to the touch-anchor fix: an assigned agent's note is a
# first touch ONLY if it carries contact evidence (call/called, vm/voicemail,
# text/texted, spoke, talked, left message, emailed, reached out). A bare
# acknowledgment proves the agent saw the alert — the lead still hasn't heard
# from anyone. Calls, texts and emails through their own channels always count.

@pytest.mark.parametrize("note_text", [
    "VM and Text",                                   # the Tiffany shape
    "Called — no answer",
    "left a message with her husband",
    "Spoke with him, wants to see homes Saturday",
    "reached out and texting her now",
])
def test_a_note_documenting_contact_is_a_first_touch(watch_engine, tmp_db,
                                                     fake_http, note_text):
    anchor = NOW - dt.timedelta(minutes=20)
    tmp_db.add_new_lead_timer(42, 9, created_at=anchor.isoformat())
    person = _stub(42, 9)
    note = {"id": 9, "created": (anchor + dt.timedelta(minutes=5)).isoformat(),
            "createdById": 9, "subject": "", "body": note_text}
    fake_http.responses = [
        (200, {"people": [person]}),
        (200, {"notes": [note]}),
    ]

    watch_engine.process_new_lead_timers()

    assert _active_timers(tmp_db) == [], f"{note_text!r} documents contact — must cancel"
    assert [r["status"] for r in _audit(tmp_db, "new_lead_timer")] == ["canceled_touched"]


@pytest.mark.parametrize("note_text", ["got it", "ok", "on it", "will do", "mine"])
def test_a_bare_acknowledgment_note_never_stops_the_clock(watch_engine, tmp_db,
                                                          fake_http, note_text):
    anchor = NOW - dt.timedelta(minutes=20)
    tmp_db.add_new_lead_timer(42, 9, created_at=anchor.isoformat())
    person = _stub(42, 9)
    note = {"id": 9, "created": (anchor + dt.timedelta(minutes=5)).isoformat(),
            "createdById": 9, "subject": "", "body": note_text}
    fake_http.responses = [
        (200, {"people": [person]}),
        (200, {"notes": [note]}),
    ]

    watch_engine.process_new_lead_timers()

    assert [t["person_id"] for t in _active_timers(tmp_db)] == [42], \
        f"{note_text!r} is an acknowledgment, not contact — the clock must keep running"
    assert _audit(tmp_db, "new_lead_timer") == []


def test_the_word_boundary_keeps_context_from_counting_as_text(watch_engine, tmp_db, fake_http):
    """Substring matching would count 'context' as 'text' — the boundary must
    hold or every chatty note stops the clock."""
    anchor = NOW - dt.timedelta(minutes=20)
    tmp_db.add_new_lead_timer(42, 9, created_at=anchor.isoformat())
    person = _stub(42, 9)
    note = {"id": 9, "created": (anchor + dt.timedelta(minutes=5)).isoformat(),
            "createdById": 9, "subject": "",
            "body": "adding context: relocating from Dallas, per the portal notes"}
    fake_http.responses = [
        (200, {"people": [person]}),
        (200, {"notes": [note]}),
    ]

    watch_engine.process_new_lead_timers()

    assert [t["person_id"] for t in _active_timers(tmp_db)] == [42]
