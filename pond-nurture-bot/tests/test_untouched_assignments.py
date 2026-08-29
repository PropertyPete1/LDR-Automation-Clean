"""Assignment safety net + speed-to-lead anchor fix (mocked HTTP only).

Born from the Aug 2026 incident: a lead manually reassigned to an agent sat
untouched for 2+ days with zero warnings, because speed-to-lead timers only
ever start for leads CREATED in the last 24 hours. These tests pin the new
daily net's guardrails (pond skip, excluded agents, 72h re-alert suppression,
per-run cap, never messaging the lead) and the detection-time timer anchor.
"""
import datetime as dt
import json
from datetime import timezone

UTC = timezone.utc


def _iso(hours_ago: float) -> str:
    return (dt.datetime.now(UTC) - dt.timedelta(hours=hours_ago)).isoformat()


def _person(pid, agent_id=35, pond=None, last_activity_hours_ago=48, **extra):
    p = {
        "id": pid,
        "firstName": f"Lead{pid}",
        "lastName": "Test",
        "stage": "Lead",
        "assignedUserId": agent_id,
        "lastActivity": _iso(last_activity_hours_ago),
    }
    if pond is not None:
        p["assignedPondId"] = pond
    p.update(extra)
    return p


USERS = {
    "users": [
        {"id": 35, "name": "Stefanie Agent", "email": "stef@x.com", "status": "Active"},
        {"id": 44, "name": "Laila Maria", "email": "laila@x.com", "status": "Active"},
        {"id": 77, "name": "Fired Agent", "email": "gone@x.com", "status": "Active"},
        {"id": 88, "name": "Deleted Agent", "email": "del@x.com", "status": "Deleted"},
        {"id": 2, "name": "Peter Allen", "email": "peter@x.com", "status": "Active"},
    ]
}


def _audit(db, action, status=None):
    with db.connect() as con:
        rows = con.execute(
            "SELECT person_id, action, status, details FROM audit_log WHERE action=?", (action,)
        ).fetchall()
    if status is not None:
        rows = [r for r in rows if r[2] == status]
    return rows


def _scan_skips(db):
    rows = _audit(db, "untouched_assignment_scan", "completed")
    assert rows, "scan should always write its aggregate completion row"
    return json.loads(rows[-1][3])["skips"]


class TestUntouchedAssignmentGuardrails:
    def test_pond_leads_skipped(self, engine, fake_http):
        fake_http.responses = [
            (200, {"people": [_person(1, agent_id=35, pond=2)]}),
            (200, USERS),
        ]
        engine.scan_untouched_assignments()
        assert engine.db.get_assignment_watch(1) is None  # never even watched
        assert _audit(engine.db, "untouched_assignment_alert") == []
        assert _scan_skips(engine.db).get("in_pond") == 1

    def test_excluded_agents_skipped(self, engine, fake_http):
        engine.rules.excluded_user_ids = [77]
        fake_http.responses = [
            (200, {"people": [_person(1, agent_id=77)]}),
            (200, USERS),
        ]
        engine.scan_untouched_assignments()
        assert engine.db.get_assignment_watch(1) is None
        assert _audit(engine.db, "untouched_assignment_alert") == []
        assert _scan_skips(engine.db).get("excluded_agent") == 1

    def test_peter_and_inactive_agents_skipped(self, engine, fake_http):
        fake_http.responses = [
            (200, {"people": [_person(1, agent_id=2), _person(2, agent_id=88)]}),
            (200, USERS),
        ]
        engine.scan_untouched_assignments()
        assert _audit(engine.db, "untouched_assignment_alert") == []
        skips = _scan_skips(engine.db)
        assert skips.get("assigned_to_peter") == 1
        assert skips.get("inactive_agent") == 1

    def test_first_sighting_starts_watch_without_alert(self, engine, fake_http):
        fake_http.responses = [
            (200, {"people": [_person(1, agent_id=35)]}),
            (200, USERS),
        ]
        engine.scan_untouched_assignments()
        watch = engine.db.get_assignment_watch(1)
        assert watch is not None and int(watch["assigned_user_id"]) == 35
        assert _audit(engine.db, "untouched_assignment_alert") == []

    def test_alert_fires_after_24h_untouched(self, engine, fake_http):
        engine.db.upsert_assignment_watch(1, 35, first_seen_at=_iso(25))
        fake_http.responses = [
            (200, {"people": [_person(1, agent_id=35)]}),
            (200, USERS),
            (200, {"notes": []}),  # touch check finds no human notes
        ]
        engine.scan_untouched_assignments()
        rows = _audit(engine.db, "untouched_assignment_alert", "dry_run_created")
        assert [r[0] for r in rows] == [1]
        details = json.loads(rows[0][3])
        assert details["agent_name"] == "Stefanie Agent"
        assert details["hours_untouched"] >= 24
        assert engine.db.get_assignment_watch(1)["last_alert_at"] is not None

    def test_realert_suppressed_within_72h(self, engine, fake_http):
        engine.db.upsert_assignment_watch(1, 35, first_seen_at=_iso(48))
        engine.db.mark_assignment_alerted(1)  # alerted just now
        fake_http.responses = [
            (200, {"people": [_person(1, agent_id=35)]}),
            (200, USERS),
        ]
        engine.scan_untouched_assignments()
        assert _audit(engine.db, "untouched_assignment_alert") == []
        skip_rows = _audit(engine.db, "untouched_assignment_skip", "realert_suppressed")
        assert [r[0] for r in skip_rows] == [1]

    def test_realert_fires_again_after_72h(self, engine, fake_http):
        engine.db.upsert_assignment_watch(1, 35, first_seen_at=_iso(100))
        with engine.db.connect() as con:  # last alert 73h ago — window expired
            con.execute("UPDATE assignment_watch SET last_alert_at=? WHERE person_id=1", (_iso(73),))
        fake_http.responses = [
            (200, {"people": [_person(1, agent_id=35)]}),
            (200, USERS),
            (200, {"notes": []}),
        ]
        engine.scan_untouched_assignments()
        assert len(_audit(engine.db, "untouched_assignment_alert", "dry_run_created")) == 1

    def test_assignment_change_resets_clock_and_suppression(self, engine, fake_http):
        engine.db.upsert_assignment_watch(1, 35, first_seen_at=_iso(48))
        engine.db.mark_assignment_alerted(1)
        fake_http.responses = [
            (200, {"people": [_person(1, agent_id=44)]}),  # moved to Laila
            (200, USERS),
        ]
        engine.scan_untouched_assignments()
        watch = engine.db.get_assignment_watch(1)
        assert int(watch["assigned_user_id"]) == 44
        assert watch["last_alert_at"] is None
        assert _audit(engine.db, "untouched_assignment_alert") == []  # new clock, no alert yet

    def test_touched_lead_skipped(self, engine, fake_http):
        engine.db.upsert_assignment_watch(1, 35, first_seen_at=_iso(30))
        person = _person(1, agent_id=35, lastSentText=_iso(5))  # agent texted 5h ago
        fake_http.responses = [
            (200, {"people": [person]}),
            (200, USERS),
        ]
        engine.scan_untouched_assignments()
        assert _audit(engine.db, "untouched_assignment_alert") == []
        assert [r[0] for r in _audit(engine.db, "untouched_assignment_skip", "touched")] == [1]

    def test_cap_limits_alerts_per_run(self, engine, fake_http):
        assert engine.rules.untouched_assignment_max_alerts_per_run == 10
        people = []
        for pid in range(1, 13):  # 12 qualifying leads, cap is 10
            engine.db.upsert_assignment_watch(pid, 35, first_seen_at=_iso(30))
            people.append(_person(pid, agent_id=35, last_activity_hours_ago=100 + pid))
        fake_http.responses = [
            (200, {"people": people}),
            (200, USERS),
            (200, {"notes": []}),  # repeats for every touch check
        ]
        engine.scan_untouched_assignments()
        assert len(_audit(engine.db, "untouched_assignment_alert", "dry_run_created")) == 10
        assert len(_audit(engine.db, "untouched_assignment_alert", "cap_reached")) == 1
        deferred = _audit(engine.db, "untouched_assignment_skip", "cap_deferred")
        assert len(deferred) == 2
        # Deferred leads keep an unmarked watch row → first in line tomorrow
        for pid, *_ in deferred:
            assert engine.db.get_assignment_watch(pid)["last_alert_at"] is None

    def test_alert_is_task_plus_note_to_agent_never_lead(self, engine, fake_http, monkeypatch):
        engine.settings.dry_run = False  # let FUB writes hit the fake transport
        sent_emails = []
        monkeypatch.setattr(engine.email, "send", lambda *a, **k: sent_emails.append((a, k)))
        engine.db.upsert_assignment_watch(1, 35, first_seen_at=_iso(25))
        fake_http.responses = [
            (200, {"people": [_person(1, agent_id=35)]}),
            (200, USERS),
            (200, {"notes": []}),
            (200, {"id": 900}),  # POST /tasks
            (200, {"id": 901}),  # POST /notes
        ]
        engine.scan_untouched_assignments()
        posts = [c for c in fake_http.calls if c.method == "POST"]
        assert [c.url.rsplit("/", 1)[-1] for c in posts] == ["tasks", "notes"]
        task, note = posts
        assert task.json["assignedUserId"] == 35 and task.json["personId"] == 1
        assert note.json["subject"].startswith("Automation:")  # never counts as a touch
        assert "@Stefanie Agent" in note.json["body"]
        assert "🚨" in note.json["body"]  # reuses the speed-to-lead warning format
        assert sent_emails == []  # no email to anyone — and nothing to the lead
        assert not any(c.url.endswith("/textMessages") for c in posts)
        assert len(_audit(engine.db, "untouched_assignment_alert", "created")) == 1

    def test_daily_summary_lists_untouched_assignments(self, engine, monkeypatch):
        engine.db.log(
            "untouched_assignment_alert", "created", 1,
            {"lead_name": "Jane Doe", "agent_name": "Stefanie Agent", "assigned_user_id": 35, "hours_untouched": 51.5},
        )
        captured = {}

        def _capture(to_email, subject, body, **kwargs):
            captured["subject"] = subject
            captured["body"] = body
            captured["html"] = kwargs.get("html_body", "")

        monkeypatch.setattr(engine.email, "send", _capture)
        engine.send_phase2_daily_summary()
        assert "⚠️ UNTOUCHED ASSIGNMENTS: 1" in captured["body"]
        assert "Jane Doe" in captured["body"]
        assert "Stefanie Agent" in captured["body"]
        assert "51.5h untouched" in captured["body"]
        assert "UNTOUCHED ASSIGNMENTS" in captured["html"]

    def test_disabled_by_rules_makes_no_api_calls(self, engine, fake_http):
        engine.rules.untouched_assignment_alert_enabled = False
        engine.scan_untouched_assignments()
        assert fake_http.calls == []


class TestNewLeadTimerAnchor:
    """Anchor fix: timers start at DETECTION time, not the lead's FUB created
    timestamp — afternoon-created leads no longer begin life already past the
    60-minute budget."""

    def test_poll_anchors_timer_at_detection_time(self, engine, fake_http, monkeypatch):
        monkeypatch.setattr(engine.email, "send", lambda *a, **k: None)
        lead_created = _iso(20)  # created 20h before the poll sees it
        person = _person(6270, agent_id=35, created=lead_created)
        fake_http.responses = [
            (200, {"people": [person]}),
            (200, USERS),  # user cache for the agent alert email
        ]
        engine.poll_new_leads()
        with engine.db.connect() as con:
            row = con.execute("SELECT created_at FROM new_lead_timers WHERE person_id=6270").fetchone()
        assert row is not None
        anchor = dt.datetime.fromisoformat(row[0])
        age_min = (dt.datetime.now(UTC) - anchor).total_seconds() / 60
        assert age_min < 5, f"timer anchored {age_min:.0f} min in the past — should be detection time"

    def test_fresh_detection_timer_does_not_instantly_warn(self, engine, fake_http):
        engine.db.add_new_lead_timer(6270, 35)  # detection-time anchor (now)
        person = _person(6270, agent_id=35, created=_iso(20))
        fake_http.responses = [
            (200, {"people": [person]}),  # get_person
            (200, {"notes": []}),         # touch check
        ]
        engine.process_new_lead_timers()
        with engine.db.connect() as con:
            row = con.execute(
                "SELECT warned_at, reassigned_at, canceled_at FROM new_lead_timers WHERE person_id=6270"
            ).fetchone()
        assert row == (None, None, None), "0 business minutes elapsed — nothing should fire"

    def test_touch_before_detection_no_longer_cancels_timer(self, engine, fake_http):
        """REVERSED 2026-08-26 (the Brito case): activity from before the timer
        existed does not count. The agent must respond to THIS alert — their
        10h-old text predates the anchor and leaves the timer running.

        SCOPE NARROWED 2026-08-29 (the Sunny Chamadia case): this pin now
        covers only legacy rows with no touch_anchor_at. Timers armed by the
        fixed code carry an explicit touch anchor at the lead's creation /
        the previous scan observation, and the assigned agent's own touch
        inside the detection gap rightly counts — see
        test_assignment_changes.py's detection-gap section."""
        engine.db.add_new_lead_timer(6270, 35)  # detected just now
        person = _person(6270, agent_id=35, created=_iso(20), lastSentText=_iso(10))
        fake_http.responses = [
            (200, {"people": [person]}),  # get_person
            (200, {"notes": []}),         # no post-anchor notes by the agent
        ]
        engine.process_new_lead_timers()
        with engine.db.connect() as con:
            row = con.execute("SELECT canceled_at FROM new_lead_timers WHERE person_id=6270").fetchone()
        assert row[0] is None, "a pre-anchor touch cancelled the timer — policy regression"
        assert not _audit(engine.db, "new_lead_timer", "canceled_touched")
