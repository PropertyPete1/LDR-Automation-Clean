"""Test bootstrap for pond-nurture-bot behavioral tests.

- Neutralizes the module-level APScheduler start in main.py (importing the
  module must not spawn background jobs during tests).
- Provides a FakeFub transport that records every HTTP request main.py makes
  (method, full URL, params, json) and returns canned responses — the whole
  suite runs with mocked HTTP only; no live calls, no secrets.
"""
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

# Ensure predictable env before main.py import (Settings reads env at load)
os.environ.setdefault("DRY_RUN", "true")
os.environ.setdefault("FUB_API_KEY", "")
os.environ.setdefault("DATABASE_PATH", str(ROOT / "tests" / ".tmp_unused.sqlite3"))

# Neutralize the background scheduler BEFORE importing main
import apscheduler.schedulers.background as _bg  # noqa: E402

_bg.BackgroundScheduler.start = lambda self, *a, **k: None  # type: ignore[assignment]

# main.py resolves config/ relative to CWD — run from the package root
os.chdir(ROOT)

import fub_automation.main as main  # noqa: E402


@pytest.fixture()
def m():
    """The imported module under test."""
    return main


class RecordedRequest:
    def __init__(self, method, url, params, json_body):
        self.method = method
        self.url = url
        self.params = params or {}
        self.json = json_body

    def __repr__(self):
        return f"<{self.method} {self.url} params={self.params}>"


class FakeHttp:
    """Replacement for requests.request used by FollowUpBossClient._request.

    responses: list of (status_code, json_payload) consumed in order; the
    last entry repeats forever. Every call is recorded in .calls.
    """

    def __init__(self, responses=None):
        self.calls: list[RecordedRequest] = []
        self.responses = list(responses or [(200, {})])

    def __call__(self, method, url, params=None, json=None, headers=None, auth=None, timeout=None):
        self.calls.append(RecordedRequest(method, url, dict(params) if params else {}, json))
        status, payload = self.responses[0]
        if len(self.responses) > 1:
            self.responses.pop(0)

        class _Resp:
            status_code = status
            text = "" if payload is None else "x"

            @staticmethod
            def json():
                return payload

        return _Resp()

    @property
    def urls(self):
        return [c.url for c in self.calls]


@pytest.fixture()
def fake_http(monkeypatch):
    """Patch requests.request inside main.py with a recording fake."""
    fake = FakeHttp()
    monkeypatch.setattr(main.requests, "request", fake)
    monkeypatch.setattr(main.time, "sleep", lambda s: None)  # no real backoff waits
    return fake


@pytest.fixture()
def settings(m):
    s = m.Settings.from_env()
    s.fub_api_key = "fka_test_key"
    s.dry_run = True
    return s


@pytest.fixture()
def rules(m):
    return m.Rules.load(str(ROOT / 'config' / 'rules.yaml'))


@pytest.fixture()
def fub(m, settings):
    return m.FollowUpBossClient(settings)


@pytest.fixture()
def tmp_db(m, tmp_path):
    return m.AuditDB(str(tmp_path / "audit.sqlite3"))


@pytest.fixture()
def engine(m, settings, rules, fub, tmp_db):
    """A real RuleEngine wired to the fake transport and a temp DB."""
    return m.RuleEngine(settings, rules, fub, tmp_db)
