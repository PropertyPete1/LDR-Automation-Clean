"""Import-path regression tests — these must NOT rely on conftest's sys.path hack.

Production incident 2026-07-25: `run_approved_daily_automation.py` imports
`src.fub_automation.main`, so main.py loads under the package path
`src.fub_automation`. Its module-level `from fub_automation.seller_nurture
import ...` had no top-level `fub_automation` to resolve against and the daily
run died with ModuleNotFoundError. The whole test suite passed the entire time,
because tests/conftest.py inserts `src/` on sys.path before importing, which is
the one arrangement where the absolute form happens to work.

So these tests deliberately spawn a CLEAN interpreter: no conftest, no
inherited PYTHONPATH. If they can't import it the way production does, they
fail — which is the point.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]          # pond-nurture-bot/
SRC = ROOT / "src"


def _clean_env(**extra: str) -> dict:
    """Environment with PYTHONPATH stripped, so nothing leaks in from pytest."""
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    # main.py reads settings at import time; keep it inert and offline.
    env.update({"DRY_RUN": "true", "FUB_API_KEY": "", "ANTHROPIC_API_KEY": "",
                "DATABASE_PATH": str(ROOT / "tests" / ".tmp_import_check.sqlite3")})
    env.update(extra)
    return env


def _import_in_subprocess(statement: str, cwd: Path, env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", statement],
        cwd=str(cwd), env=env, capture_output=True, text=True, timeout=180,
    )


def test_imports_the_way_production_does():
    """THE regression: `from src.fub_automation.main import ...` with cwd =
    pond-nurture-bot and nothing on sys.path. This is verbatim what
    run_approved_daily_automation.py does on the GitHub runner."""
    proc = _import_in_subprocess(
        "from src.fub_automation.main import AuditDB, FollowUpBossClient, RuleEngine, Rules, Settings",
        cwd=ROOT, env=_clean_env(),
    )
    assert proc.returncode == 0, (
        "production import path is broken — this is the daily-automation crash:\n"
        f"{proc.stderr[-3000:]}"
    )


def test_imports_the_way_the_tests_and_dashboard_do():
    """The other live path: `from fub_automation.main import ...` with src/ on
    sys.path (tests/conftest.py and export_dashboard_data.py). Both arrangements
    must work — fixing one by breaking the other is not a fix."""
    proc = _import_in_subprocess(
        "from fub_automation.main import AuditDB, RuleEngine, Rules, Settings",
        cwd=ROOT, env=_clean_env(PYTHONPATH=str(SRC)),
    )
    assert proc.returncode == 0, (
        f"package import path is broken:\n{proc.stderr[-3000:]}"
    )


def test_seller_nurture_symbols_actually_resolve():
    """Guard against a fix that imports but leaves the seller track dangling —
    line 42 is what crashed, so assert its symbols are really bound."""
    proc = _import_in_subprocess(
        "import src.fub_automation.main as m; "
        "assert m.SELLER_LEAD_TAG and m.SELLER_SEQUENCE_LENGTH == 5 "
        "and callable(m.build_seller_email_html) and callable(m.ramp_daily_cap)",
        cwd=ROOT, env=_clean_env(),
    )
    assert proc.returncode == 0, f"seller-nurture symbols missing:\n{proc.stderr[-3000:]}"


@pytest.mark.parametrize("module", ["main", "seller_nurture", "sms_helpers"])
def test_no_absolute_self_imports_remain(module):
    """Static guard: no module under src/ may import its own package by
    absolute name. Both `fub_automation.x` and `src.fub_automation.x` are
    wrong — each breaks under the other's invocation path."""
    import re
    text = (SRC / "fub_automation" / f"{module}.py").read_text()
    offenders = [
        f"{n}: {line.strip()}"
        for n, line in enumerate(text.splitlines(), 1)
        if re.match(r"\s*(from|import)\s+(src\.)?fub_automation\b", line)
    ]
    assert not offenders, (
        f"{module}.py must use package-relative imports (from .x import y). Found:\n  "
        + "\n  ".join(offenders)
    )
