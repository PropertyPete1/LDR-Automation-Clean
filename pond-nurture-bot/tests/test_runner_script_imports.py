"""Import-path regressions for the top-level RUNNER SCRIPTS.

tests/test_import_paths.py guards the modules under src/. It does not guard the
scripts the workflows actually execute, and that gap cost the pond volume ramp
its entire life: run_approved_daily_automation.py imported
`fub_automation.ramp` — the bare form, which does not resolve from that script
because src/ is never put on sys.path there — inside an `except Exception` that
only prints. Every daily run printed

    Warning: ramp evaluation failed, cap falls back to rules.yaml:
        No module named 'fub_automation'
    Warning: could not record run duration: No module named 'fub_automation'

and carried on. maybe_advance() never ran once, so the ramp never left step 1,
and record_run_duration() never wrote a row, so the runtime guardrail had no
data to be green on. Nothing failed and no test noticed.

Like test_import_paths.py, these spawn a CLEAN interpreter: no conftest, no
inherited PYTHONPATH. Importing it the way pytest does is the one arrangement
where the broken form happens to work.
"""
from __future__ import annotations

import ast
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]          # pond-nurture-bot/

#: Scripts a workflow invokes directly, with `working-directory:
#: pond-nurture-bot` and no PYTHONPATH.
RUNNER_SCRIPTS = [
    "run_approved_daily_automation.py",
    "run_speed_to_lead_check.py",
    "backfill_reengagement.py",
    "backfill_missed_replies.py",
    "backfill_ramp_state.py",
    "diagnose_reply_surfaces.py",
    "investigate_assignments.py",
    "repair_speed_to_lead_false_positives.py",
    "weekly_digest.py",
    "nightly_health.py",
    "export_dashboard_data.py",
]


def _clean_env(**extra: str) -> dict:
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env.update({"DRY_RUN": "true", "FUB_API_KEY": "", "ANTHROPIC_API_KEY": "",
                "DATABASE_PATH": str(ROOT / "tests" / ".tmp_runner_check.sqlite3")})
    env.update(extra)
    return env


def test_the_ramp_imports_resolve_the_way_the_daily_run_makes_them():
    """THE regression. Both symbols, imported verbatim as the daily script
    does, from the daily script's working directory, with a bare sys.path."""
    proc = subprocess.run(
        [sys.executable, "-c",
         "from src.fub_automation.ramp import maybe_advance, record_run_duration; "
         "assert callable(maybe_advance) and callable(record_run_duration)"],
        cwd=str(ROOT), env=_clean_env(), capture_output=True, text=True, timeout=180,
    )
    assert proc.returncode == 0, (
        "the daily run cannot import the ramp — it will print a warning and "
        f"skip the ramp entirely:\n{proc.stderr[-3000:]}"
    )


def _sys_path_insert_line(tree: ast.Module) -> int | None:
    """Line of the first sys.path insert/append, or None if the script has none."""
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("insert", "append")
                and isinstance(node.func.value, ast.Attribute)
                and node.func.value.attr == "path"
                and isinstance(node.func.value.value, ast.Name)
                and node.func.value.value.id == "sys"):
            return node.lineno
    return None


@pytest.mark.parametrize("script", RUNNER_SCRIPTS)
def test_no_bare_package_import_without_putting_src_on_sys_path(script):
    """A runner script may use `from fub_automation.x import y` ONLY if it puts
    src/ on sys.path first. Otherwise it must use the `src.` form.

    Both spellings work under pytest, so only a static rule catches this before
    a workflow does — and when a workflow catches it, it catches it inside an
    `except` that prints a warning nobody reads.
    """
    path = ROOT / script
    if not path.exists():
        pytest.skip(f"{script} not present")
    source = path.read_text()
    tree = ast.parse(source)

    bare = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        and node.level == 0
        and (node.module or "").split(".")[0] == "fub_automation"
    ]
    if not bare:
        return

    inserted_at = _sys_path_insert_line(tree)
    assert inserted_at is not None, (
        f"{script} imports fub_automation.* at line(s) "
        f"{[n.lineno for n in bare]} but never puts src/ on sys.path — those "
        f"imports raise ModuleNotFoundError in production. Use the "
        f"`src.fub_automation.` form, as this script's other imports do."
    )

    # Only module-level imports can be checked by line order; those run
    # top-to-bottom at import time. An import inside a function runs whenever
    # the function is called, and no static rule can prove that is after the
    # insert — requiring the insert to exist at all is the honest guard there.
    module_level = {n.lineno for n in bare} & {n.lineno for n in tree.body
                                               if isinstance(n, ast.ImportFrom)}
    if module_level:
        assert inserted_at < min(module_level), (
            f"{script} imports fub_automation.* at module level on line "
            f"{min(module_level)}, before the sys.path insert on line {inserted_at}"
        )


def test_ramp_holds_when_it_has_no_runtime_data(tmp_path):
    """Deploy safety for the fix above: the first daily run that can finally
    reach the ramp must HOLD, not advance.

    record_run_duration() has never written a row, so the runtime guardrail is
    unknown — and unknown is not green. The cap stays at step 1 until a full
    week of real duration rows exists.
    """
    sys.path.insert(0, str(ROOT / "src"))
    import sqlite3

    from fub_automation import ramp

    con = sqlite3.connect(str(tmp_path / "ramp.sqlite3"))
    con.execute(
        """CREATE TABLE audit_log (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               created_at TEXT NOT NULL, person_id INTEGER,
               action TEXT NOT NULL, status TEXT NOT NULL, details TEXT)"""
    )
    ramp.ensure_schema(con)
    # A perfectly clean week of sends — no bounces, no opt-outs, no runtime rows.
    import datetime as dt
    now = dt.datetime.now(dt.timezone.utc)
    for i in range(200):
        con.execute(
            "INSERT INTO audit_log(created_at, person_id, action, status, details)"
            " VALUES (?,?,?,?,?)",
            ((now - dt.timedelta(days=2)).isoformat(), 1000 + i,
             "pond_nurture", "sent", "{}"),
        )

    result = ramp.maybe_advance(con, now=now)

    assert result["advanced"] is False, "a ramp with no runtime data must not advance"
    assert result["cap"] == ramp.RAMP_STEPS[0], "cap must stay on step 1"
    assert any("runtime" in r for r in result["guardrails"]["reasons"]), (
        f"expected the runtime guardrail to be the reason; got {result['guardrails']['reasons']}"
    )
