"""Speed-to-lead DISCOVERY — the 5-minute job must find leads, not just tick clocks.

The gap this closes: poll_new_leads() was wired into the daily automation only,
so a lead assigned at 10:05am had no timer until the next morning's sweep. The
5-minute runner faithfully processed timers — there just weren't any. The
30/60-minute promise was structurally unmeetable for every lead that arrived
after the daily run.

Polling on every invocation means the same lead is now seen ~96 times a day
instead of once, so the dedup that made re-detection safe stops being a nice
property and becomes load-bearing. These tests pin it: one timer per person
EVER, and a lead discovered intraday is anchored at that discovery, never at its
FUB creation timestamp.

Mocked HTTP only — no live calls, no secrets.
"""
from __future__ import annotations

import datetime as dt
import os
import sqlite3
import sys
from datetime import timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

UTC = timezone.utc
CT = ZoneInfo("America/Chicago")
ROOT = Path(__file__).resolve().parents[1]  # pond-nurture-bot/

# The runner attaches a FileHandler at import time, rooted at AUTO_DIR. Point it
# somewhere harmless before importing (*.log is gitignored, but the suite still
# has no business writing into the package root).
os.environ.setdefault("AUTO_DIR", str(ROOT / "tests"))

sys.path.insert(0, str(ROOT))
import run_speed_to_lead_check as runner  # noqa: E402


def _iso(hours_ago: float) -> str:
    return (dt.datetime.now(UTC) - dt.timedelta(hours=hours_ago)).isoformat()


def _person(pid, agent_id=35, created_hours_ago=20, **extra):
    """A freshly assigned lead. Default: created 20h ago in FUB — the afternoon
    lead that a daily-only poll used to hand an already-expired timer."""
    p = {
        "id": pid,
        "firstName": f"Lead{pid}",
        "lastName": "Test",
        "stage": "Lead",
        "assignedUserId": agent_id,
        "created": _iso(created_hours_ago),
        "lastActivity": _iso(created_hours_ago),
        "phones": [{"value": "512-555-0142"}],
        "emails": [{"value": f"lead{pid}@example.com"}],
    }
    p.update(extra)
    return p


USERS = [
    {"id": 35, "name": "Stefanie Agent", "email": "stef@x.com", "status": "Active"},
    {"id": 2, "name": "Peter Allen", "email": "peter@x.com", "status": "Active"},
]


class _Call:
    def __init__(self, method, url, params):
        self.method = method
        self.url = url
        self.params = params or {}
        self.path = url.rsplit("/v1", 1)[-1]

    def __repr__(self):
        return f"<{self.method} {self.path} params={self.params}>"


class _RoutingHttp:
    """URL-routed stand-in for requests.request.

    conftest's FakeHttp replays a fixed sequence, which cannot express "the same
    poll, 96 times" without hard-coding how many calls each pass happens to
    make. This one answers by endpoint, so a test can loop without asserting on
    internal call counts, and records every request for ordering assertions.
    """

    def __init__(self, people=None, users=None):
        self.people = list(people or [])
        self.users = list(users if users is not None else USERS)
        self.calls: list[_Call] = []

    def __call__(self, method, url, params=None, json=None, headers=None, auth=None, timeout=None):
        call = _Call(method, url, dict(params) if params else {})
        self.calls.append(call)
        return _resp(self._payload(call))

    def _payload(self, call):
        if call.path == "/people":
            wanted = call.params.get("id")
            if wanted:  # get_person(id=...)
                return {"people": [p for p in self.people if str(p.get("id")) == str(wanted)]}
            return {"people": self.people}  # poll: createdAfter=...
        if call.path == "/users":
            return {"users": self.users}
        return {}  # /notes, /textMessages, ... → no touches

    @property
    def paths(self):
        return [c.path for c in self.calls]

    def polls(self):
        return [c for c in self.calls if c.path == "/people" and "createdAfter" in c.params]


def _resp(payload):
    class _Resp:
        status_code = 200
        text = "x"

        @staticmethod
        def json():
            return payload

    return _Resp()


@pytest.fixture()
def http(m, monkeypatch):
    """Routing transport installed over requests.request.

    Patched on the shared `requests` module rather than a main.py attribute, so
    it holds for whichever copy of main.py the runner imports (`src.fub_automation
    .main` when the package root is on sys.path, `fub_automation.main` otherwise).
    """
    fake = _RoutingHttp()
    monkeypatch.setattr(m.requests, "request", fake)
    monkeypatch.setattr(m.time, "sleep", lambda s: None)
    return fake


class _ClockShim:
    """Stands in for the runner's `datetime` module so the business-hours gate is
    deterministic — the suite must not go red because it ran at 6:01pm CT."""

    def __init__(self, hour_ct):
        self.hour_ct = hour_ct
        shim = self

        class _DatetimeClass:
            @staticmethod
            def now(tz=None):
                moment = dt.datetime.now(CT).replace(
                    hour=shim.hour_ct, minute=7, second=0, microsecond=0
                )
                return moment.astimezone(tz) if tz else moment

        self.datetime = _DatetimeClass


class _Job:
    """The 5-minute runner, invoked the way GitHub Actions invokes it."""

    def __init__(self, db_path, monkeypatch):
        self.db_path = db_path
        self._monkeypatch = monkeypatch

    def run(self, hour_ct=11) -> int:
        self._monkeypatch.setattr(runner, "datetime", _ClockShim(hour_ct))
        return runner.main()

    def timers(self):
        con = sqlite3.connect(str(self.db_path))
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute("SELECT * FROM new_lead_timers").fetchall()]
        finally:
            con.close()


@pytest.fixture()
def job(monkeypatch, tmp_path, http):
    monkeypatch.setenv("FUB_API_KEY", "fka_test_key")
    monkeypatch.setenv("DRY_RUN", "true")
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "speed.sqlite3"))
    monkeypatch.setenv("RULES_PATH", str(ROOT / "config" / "rules.yaml"))
    monkeypatch.setattr(runner, "load_dotenv", lambda path=".env": None)
    monkeypatch.setattr(runner, "_ping_healthcheck", lambda check, **kw: None)
    return _Job(tmp_path / "speed.sqlite3", monkeypatch)


def _audit(db, action, status=None):
    with db.connect() as con:
        rows = con.execute(
            "SELECT person_id, action, status FROM audit_log WHERE action=?", (action,)
        ).fetchall()
    return [r for r in rows if status is None or r[2] == status]


class TestFiveMinuteJobDiscoversLeads:
    """THE regression: the intraday job has to go looking for leads, not only
    tick clocks for leads that something else found."""

    def test_run_polls_for_new_leads_before_processing_timers(self, job, http):
        http.people = [_person(6270)]
        assert job.run() == 0

        assert http.polls(), (
            "the 5-minute run made no createdAfter query — discovery is still "
            f"daily-only. Calls: {http.paths}"
        )
        # Poll precedes timer processing, so a lead found now is evaluated now.
        first_poll = http.calls.index(http.polls()[0])
        get_person = [i for i, c in enumerate(http.calls) if c.params.get("id") == "6270"]
        assert get_person, "the just-discovered lead's timer was never processed this run"
        assert first_poll < get_person[0]

    def test_lead_assigned_midday_is_not_stranded_until_tomorrow(self, job, http):
        http.people = [_person(6270, created_hours_ago=0.1)]
        job.run()
        rows = job.timers()
        assert [r["person_id"] for r in rows] == [6270]
        assert rows[0]["assigned_user_id"] == 35

    def test_nothing_to_find_creates_nothing(self, job):
        assert job.run() == 0
        assert job.timers() == []

    def test_outside_business_hours_makes_no_api_calls(self, job, http):
        http.people = [_person(6270)]
        assert job.run(hour_ct=21) == 0
        assert http.calls == [], "polling escaped the business-hours gate"


class TestDetectionTimeAnchorHolds:
    """The anchor fix has to survive the new entry point: a lead discovered by
    the 5-minute job starts its 30/60-minute budget from that moment, not from
    its FUB `created` timestamp."""

    def test_timer_is_anchored_at_the_moment_the_five_minute_job_saw_it(self, job, http):
        http.people = [_person(6270, created_hours_ago=20)]
        job.run()

        rows = job.timers()
        assert len(rows) == 1
        anchor = dt.datetime.fromisoformat(rows[0]["created_at"])
        age_min = (dt.datetime.now(UTC) - anchor).total_seconds() / 60
        assert age_min < 5, (
            f"timer anchored {age_min:.0f} min in the past — a lead created this "
            "morning would start life already past the 60-minute budget"
        )

    def test_stale_lead_discovered_intraday_is_not_instantly_reassigned(self, job, http):
        """The failure mode the anchor prevents, exercised end-to-end through the
        runner: a 20h-old lead whose timer is created AND processed in one pass."""
        http.people = [_person(6270, created_hours_ago=20)]
        job.run()

        row = job.timers()[0]
        assert (row["warned_at"], row["reassigned_at"]) == (None, None), (
            "0 business minutes have elapsed since detection — nothing may fire"
        )
        writes = [c for c in http.calls if c.method != "GET"]
        assert writes == [], f"a freshly discovered lead triggered FUB writes: {writes}"


class TestDedupUnderIntradayPolling:
    """~96 gated runs/day instead of 1. One timer per person, ever."""

    POLLS_PER_DAY = 96

    def test_repeated_polls_of_the_same_lead_create_exactly_one_timer(
        self, engine, http, monkeypatch
    ):
        sent = []
        monkeypatch.setattr(engine.email, "send", lambda *a, **k: sent.append(a))
        http.people = [_person(6270)]

        for _ in range(self.POLLS_PER_DAY):
            engine.poll_new_leads()

        with engine.db.connect() as con:
            rows = con.execute("SELECT person_id FROM new_lead_timers").fetchall()
        assert len(rows) == 1, f"{len(rows)} timers for one lead after {self.POLLS_PER_DAY} polls"
        assert len(_audit(engine.db, "new_lead_timer", "started_polling")) == 1
        assert len(sent) == 1, f"agent got {len(sent)} 'new lead assigned' emails, expected 1"
        assert len(http.polls()) == self.POLLS_PER_DAY  # it really did poll every time

    def test_the_anchor_does_not_drift_across_repeated_polls(self, engine, http, monkeypatch):
        """INSERT OR IGNORE, not upsert: a later poll must not reset the clock,
        or the lead would never age past 5 minutes and never warn."""
        monkeypatch.setattr(engine.email, "send", lambda *a, **k: None)
        http.people = [_person(6270)]
        engine.poll_new_leads()
        with engine.db.connect() as con:
            first = con.execute(
                "SELECT created_at FROM new_lead_timers WHERE person_id=6270"
            ).fetchone()[0]

        for _ in range(20):
            engine.poll_new_leads()

        with engine.db.connect() as con:
            latest = con.execute(
                "SELECT created_at FROM new_lead_timers WHERE person_id=6270"
            ).fetchone()[0]
        assert latest == first, "a repeat poll reset the anchor — the lead can never age out"

    @pytest.mark.parametrize("resolve", ["cancel_timer", "mark_reassigned"])
    def test_resolved_timer_is_never_recreated_by_a_later_poll(
        self, engine, http, monkeypatch, resolve
    ):
        """A resolved timer leaves the active set, so only `processed_timers`
        stands between a finished lead and a fresh 60-minute countdown every
        5 minutes for the rest of the 24h createdAfter window."""
        monkeypatch.setattr(engine.email, "send", lambda *a, **k: None)
        http.people = [_person(6270)]
        engine.poll_new_leads()
        getattr(engine.db, resolve)(6270)

        for _ in range(self.POLLS_PER_DAY):
            engine.poll_new_leads()

        with engine.db.connect() as con:
            rows = con.execute("SELECT * FROM new_lead_timers WHERE person_id=6270").fetchall()
        assert len(rows) == 1
        assert len(_audit(engine.db, "new_lead_timer", "started_polling")) == 1, (
            f"{resolve} let the lead be re-detected — the agent gets re-alerted every 5 min"
        )

    def test_daily_backup_sweep_overlapping_an_intraday_run_is_free(
        self, engine, http, monkeypatch
    ):
        """Both jobs poll the same DB. The overlap must cost nothing."""
        monkeypatch.setattr(engine.email, "send", lambda *a, **k: None)
        http.people = [_person(6270)]
        engine.poll_new_leads()  # intraday run
        engine.poll_new_leads()  # daily backup sweep, minutes later

        with engine.db.connect() as con:
            assert con.execute("SELECT COUNT(*) FROM new_lead_timers").fetchone()[0] == 1

    def test_add_new_lead_timer_is_idempotent_per_generation(self, tmp_db):
        """Belt and braces underneath the poll's own guard, updated for the
        assignment watch: identity is (person_id, created_at) now, so a
        SAME-generation double write is still ignored and cannot move the
        anchor — but a new generation (a reassignment re-arm) is a legitimate
        second row. Double-arming within a run is prevented by the callers'
        active-timer checks, pinned elsewhere."""
        tmp_db.add_new_lead_timer(6270, 35, created_at="2026-08-09T10:00:00+00:00")
        # Same generation, different agent: ignored, anchor and agent keep.
        tmp_db.add_new_lead_timer(6270, 44, created_at="2026-08-09T10:00:00+00:00")
        # A later generation: the reassignment watch re-arming the person.
        tmp_db.add_new_lead_timer(6270, 44, created_at="2026-08-09T17:00:00+00:00")
        with tmp_db.connect() as con:
            rows = con.execute(
                "SELECT created_at, assigned_user_id FROM new_lead_timers ORDER BY created_at"
            ).fetchall()
        assert rows == [
            ("2026-08-09T10:00:00+00:00", 35),
            ("2026-08-09T17:00:00+00:00", 44),
        ]


class TestPollingFailureIsolation:
    """Discovery is the newer, network-heavier half of the run. It must not be
    able to take out the half that warns and reassigns."""

    def test_poll_failure_still_processes_timers_and_reports_unhealthy(self, job, http, m):
        # A pre-existing timer whose lead has vanished from FUB — processing it
        # cancels the timer, which is the observable proof that the second half
        # of the run happened despite the first half raising.
        m.AuditDB(str(job.db_path)).add_new_lead_timer(999, 35)
        # FUB hands back a person with no id → KeyError inside poll_new_leads,
        # past the fetch try/except it already has.
        http.people = [{"firstName": "Malformed", "assignedUserId": 35}]

        rc = job.run()

        assert job.timers()[0]["canceled_at"] is not None, (
            "a polling failure skipped timer processing — the half that reassigns"
        )
        assert rc == 1, "a polling failure must leave the dead-man's switch DOWN"
