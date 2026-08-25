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


# ── the bot's own sends are not touches ──────────────────────────────────────

def test_a_nurture_send_does_not_count_as_first_touch(watch_engine, tmp_db, fake_http):
    """The pond email syncs into FUB and bumps lastSentEmail like an agent's
    mail — matched against our own audit send, it must not cancel a timer."""
    send_ts = NOW - dt.timedelta(hours=1)
    tmp_db.log("pond_nurture", "sent", 42, {})
    with tmp_db.connect() as con:
        con.execute("UPDATE audit_log SET created_at=? WHERE person_id=42",
                    ((send_ts + dt.timedelta(seconds=40)).isoformat(),))
    person = _stub(42, 9)
    person["lastSentEmail"] = send_ts.isoformat()
    fake_http.responses = [(200, {})]  # notes lookup finds nothing

    anchor = NOW - dt.timedelta(hours=3)
    assert watch_engine.lead_touched_after_creation(person, anchor) is False


def test_a_real_outbound_email_still_counts_as_touch(watch_engine, tmp_db, fake_http):
    person = _stub(42, 9)
    person["lastSentEmail"] = (NOW - dt.timedelta(hours=1)).isoformat()

    anchor = NOW - dt.timedelta(hours=3)
    assert watch_engine.lead_touched_after_creation(person, anchor) is True


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
