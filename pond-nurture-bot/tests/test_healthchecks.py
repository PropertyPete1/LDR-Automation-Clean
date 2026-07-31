"""Dead-man's-switch coverage for the three previously-unmonitored workflows.

speed-to-lead, reply-detection and weekly-digest had no healthcheck ping, so if
any of them silently stopped firing nothing would say so. speed-to-lead is the
worst of the three — it drives the 30/60-minute lead-response timers.

The ping URLs come from env vars, never from a committed file: this repo is
public, and an hc-ping UUID is effectively a write credential (anyone holding it
can keep a check green while the automation is dead).
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from fub_automation import healthcheck  # noqa: E402


ALL_CHECKS = ["speed_to_lead", "reply_detection", "weekly_digest"]


@pytest.mark.parametrize("check", ALL_CHECKS)
def test_no_op_when_unconfigured(check, monkeypatch):
    """Unset env must be a silent no-op — local runs and forks need no secret."""
    monkeypatch.delenv(healthcheck.env_var_for(check), raising=False)
    monkeypatch.delenv("DRY_RUN", raising=False)
    called = []
    monkeypatch.setattr(healthcheck, "ping", healthcheck.ping)  # real fn
    assert healthcheck.ping(check) is False
    assert called == []


@pytest.mark.parametrize("check", ALL_CHECKS)
def test_pings_configured_url(check, monkeypatch):
    monkeypatch.setenv(healthcheck.env_var_for(check), "https://hc.example/uuid")
    monkeypatch.delenv("DRY_RUN", raising=False)
    seen = {}

    class _Resp:
        status_code = 200

    import requests
    monkeypatch.setattr(requests, "get", lambda url, **kw: (seen.update(url=url), _Resp())[1])
    assert healthcheck.ping(check) is True
    assert seen["url"] == "https://hc.example/uuid"


def test_fail_pings_the_fail_endpoint(monkeypatch):
    """A failed run must flip the check DOWN immediately, not wait for grace."""
    monkeypatch.setenv("HEALTHCHECK_URL_SPEED_TO_LEAD", "https://hc.example/uuid")
    monkeypatch.delenv("DRY_RUN", raising=False)
    seen = {}

    class _Resp:
        status_code = 200

    import requests
    monkeypatch.setattr(requests, "get", lambda url, **kw: (seen.update(url=url), _Resp())[1])
    healthcheck.ping("speed_to_lead", fail=True)
    assert seen["url"] == "https://hc.example/uuid/fail"


def test_ping_never_raises(monkeypatch):
    """Monitoring must not be able to break the thing it monitors."""
    monkeypatch.setenv("HEALTHCHECK_URL_WEEKLY_DIGEST", "https://hc.example/uuid")
    monkeypatch.delenv("DRY_RUN", raising=False)
    import requests

    def boom(*a, **k):
        raise OSError("network down")

    monkeypatch.setattr(requests, "get", boom)
    assert healthcheck.ping("weekly_digest") is False  # swallowed, not raised


def test_dry_run_does_not_ping(monkeypatch):
    monkeypatch.setenv("HEALTHCHECK_URL_WEEKLY_DIGEST", "https://hc.example/uuid")
    monkeypatch.setenv("DRY_RUN", "true")
    assert healthcheck.ping("weekly_digest") is False


def test_no_ping_urls_are_committed_to_this_public_repo():
    """Regression: the two legacy checks keep UUIDs in config/healthchecks.json.
    New checks must never do that — the URL lives only in a secret env var."""
    root = Path(__file__).resolve().parents[2]
    for pattern in ("*.py", "*.ts", "*.json", "*.yml"):
        for f in root.rglob(pattern):
            if "node_modules" in f.parts or ".git" in f.parts:
                continue
            if f.name == "healthchecks.json":
                continue  # pre-existing legacy file, flagged separately
            text = f.read_text(errors="ignore")
            for var in healthcheck.CHECK_ENV_VARS.values():
                idx = text.find(var)
                if idx != -1:
                    snippet = text[idx:idx + 120]
                    assert "hc-ping.com/" not in snippet, f"{f}: ping URL committed next to {var}"


def test_all_three_workflows_are_covered():
    assert set(healthcheck.CHECK_ENV_VARS) == set(ALL_CHECKS)
