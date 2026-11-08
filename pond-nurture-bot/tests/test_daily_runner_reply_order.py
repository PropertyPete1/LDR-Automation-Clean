"""The daily run reads replies BEFORE it sends anything (2026-11-08).

A typed UNSUBSCRIBE only stops mail once a reply scan turns it into the trash +
tags + opt-out ledger row that every sender's is_excluded() checks. Reply
Detection's */10 schedule is not a guarantee (on 2026-11-08 GitHub created its
runs 4.5 to 7 hours apart), and run_approved_daily_automation.py used to call
scan_reply_detection() and scan_wide_reply_sweep() only after every sending
scan, so an unsubscribe could sit unread through a whole day's sends.

This drives the REAL run_automation() with a recording engine (no FUB, no SMTP,
no network) and checks the order of what it calls.
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

REPLY_SCANS = ["scan_reply_detection", "scan_wide_reply_sweep"]

#: Every scan in the daily run that can email a lead or a contact. The pond
#: path also re-checks inbound mail at send time; the others do not.
SENDING_SCANS = [
    "scan_stale_leads",            # pond nurture emails
    "scan_seller_nurture",         # seller nurture emails
    "scan_recruiting_track",       # recruiting emails (order only; recruiting itself untouched)
    "scan_agent_followup",
    "scan_untouched_assignments",
    "poll_new_leads",
    "scan_assignment_changes",
    "process_new_lead_timers",     # speed-to-lead follow-ups
    "scan_new_closed_leads",       # congrats emails
    "scan_closed_drip",            # quarterly check-in emails
]


class _RecordingEngine:
    calls: list = []

    def __init__(self, settings, rules, fub, db):
        _RecordingEngine.calls = []

    def __getattr__(self, name):
        def record(*args, **kwargs):
            _RecordingEngine.calls.append(name)
        return record


class _Response:
    status_code = 200
    text = "ok"

    def json(self):
        return {}


@pytest.fixture()
def recorded_daily_run(m, monkeypatch, tmp_path):
    monkeypatch.setenv("DRY_RUN", "true")
    monkeypatch.setenv("FUB_API_KEY", "test-key-not-real")
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "runner.sqlite3"))
    monkeypatch.setenv("RULES_PATH", str(ROOT / "config" / "rules.yaml"))

    # The runner imports `src.fub_automation.main`; give it the real settings,
    # rules and audit DB with a recording engine and no FUB client.
    fake_main = types.ModuleType("src.fub_automation.main")
    fake_main.AuditDB = m.AuditDB
    fake_main.Rules = m.Rules
    fake_main.Settings = m.Settings
    fake_main.RuleEngine = _RecordingEngine
    fake_main.FollowUpBossClient = lambda settings: object()
    monkeypatch.setitem(sys.modules, "src", types.ModuleType("src"))
    monkeypatch.setitem(sys.modules, "src.fub_automation", types.ModuleType("src.fub_automation"))
    monkeypatch.setitem(sys.modules, "src.fub_automation.main", fake_main)

    import requests
    posts: list = []
    monkeypatch.setattr(requests, "post", lambda *a, **k: posts.append((a, k)) or _Response())
    monkeypatch.setattr(requests, "get", lambda *a, **k: _Response())

    spec = importlib.util.spec_from_file_location(
        "daily_runner_under_test", ROOT / "run_approved_daily_automation.py")
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    assert runner.run_automation() == 0
    return list(_RecordingEngine.calls)


def test_reply_scans_run_before_every_sending_scan(recorded_daily_run):
    calls = recorded_daily_run
    for scan in REPLY_SCANS + SENDING_SCANS:
        assert scan in calls, f"{scan} is no longer called by the daily run"
    last_reply_scan = max(calls.index(s) for s in REPLY_SCANS)
    first_send = min(calls.index(s) for s in SENDING_SCANS)
    assert last_reply_scan < first_send, (
        f"a sending scan runs before the reply scans: {calls}")


def test_reply_scans_are_moved_not_duplicated(recorded_daily_run):
    for scan in REPLY_SCANS:
        assert recorded_daily_run.count(scan) == 1, recorded_daily_run


def test_the_reply_scans_come_first_and_the_summary_still_comes_last(recorded_daily_run):
    calls = recorded_daily_run
    assert calls[:2] == REPLY_SCANS, calls
    assert calls[-1] == "send_phase2_daily_summary", calls
