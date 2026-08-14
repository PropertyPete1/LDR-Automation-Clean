"""PRIMARY's controls.json is a CLAMP, never an override.

Three promises, each pinned here because each has a failure mode that would
be silent in production:

  - the effective cap is min(voice-set target, the bot's own cap), so a
    voice-set 500 can never push past a ramp cap of 150;
  - a missing/broken/nonsense file changes nothing — the bot behaves exactly
    as it did before controls existed, and says why;
  - every resolution narrates which number actually governed, in the wording
    telemetry and the brain will repeat.
"""
from __future__ import annotations

import inspect
import json
import re
from pathlib import Path

import pytest

from fub_automation.controls import (
    CONTROLS_PATH,
    REPO_ROOT,
    load_controls,
    resolve_effective_cap,
)


def write(tmp_path: Path, payload) -> Path:
    target = tmp_path / "controls.json"
    if isinstance(payload, (bytes, str)):
        target.write_text(payload if isinstance(payload, str) else payload.decode())
    else:
        target.write_text(json.dumps(payload))
    return target


# ── The clamp ────────────────────────────────────────────────────────────────


def test_a_lower_controls_value_governs(tmp_path):
    path = write(tmp_path, {"daily_email_target": 100})
    r = resolve_effective_cap(150, "ramp", path)
    assert r.cap == 100
    assert r.governed_by == "controls"
    assert any("100 from controls" in line and "governing" in line for line in r.log_lines)


def test_a_higher_controls_value_cannot_raise_the_cap(tmp_path):
    """The constraint verbatim: a voice-set 500 never pushes past the ramp."""
    path = write(tmp_path, {"daily_email_target": 500})
    r = resolve_effective_cap(150, "ramp", path)
    assert r.cap == 150
    assert r.governed_by == "ramp"
    assert any("500 from controls, capped at 150 by ramp" in line for line in r.log_lines)


def test_zero_is_a_real_instruction_and_stops_the_day(tmp_path):
    path = write(tmp_path, {"daily_email_target": 0})
    r = resolve_effective_cap(150, "ramp", path)
    assert r.cap == 0
    assert r.governed_by == "controls"


def test_the_clamp_applies_evenly_to_a_manual_env_override(tmp_path):
    """min() is min(): a POND_DAILY_CAP of 400 is still clamped by a lower
    voice target, and the log names the override as the base's source."""
    path = write(tmp_path, {"daily_email_target": 200})
    r = resolve_effective_cap(400, "manual override", path)
    assert r.cap == 200
    assert any("under the manual override cap 400" in line for line in r.log_lines)


# ── Fail-open: current behaviour, with the reason logged ─────────────────────


def test_missing_file_changes_nothing(tmp_path):
    r = resolve_effective_cap(150, "ramp", tmp_path / "absent.json")
    assert r.cap == 150
    assert r.governed_by == "ramp"
    assert any("not present" in line for line in r.log_lines)


def test_invalid_json_changes_nothing(tmp_path):
    r = resolve_effective_cap(150, "ramp", write(tmp_path, "{not json"))
    assert r.cap == 150
    assert any("not valid JSON" in line for line in r.log_lines)


def test_a_non_object_file_changes_nothing(tmp_path):
    r = resolve_effective_cap(150, "ramp", write(tmp_path, [1, 2, 3]))
    assert r.cap == 150
    assert any("not a JSON object" in line for line in r.log_lines)


def test_an_unset_key_changes_nothing_and_is_not_a_fault(tmp_path):
    r = resolve_effective_cap(150, "ramp", write(tmp_path, {"something_else": 5}))
    assert r.cap == 150
    assert any("unset" in line for line in r.log_lines)


@pytest.mark.parametrize(
    "bad",
    ["150", True, False, None, -1, 501, 12.5, [150], {"n": 150}],
    ids=["string", "true", "false", "null", "negative", "over-max", "fraction", "list", "object"],
)
def test_a_nonsense_value_is_ignored_loudly(tmp_path, bad):
    """A value the brain could never have written is a broken file, not an
    instruction — and never, in any direction, a changed cap."""
    r = resolve_effective_cap(150, "ramp", write(tmp_path, {"daily_email_target": bad}))
    assert r.cap == 150
    assert r.governed_by == "ramp"
    assert any("ignored" in line for line in r.log_lines)


def test_an_integral_float_is_accepted_as_the_integer_it_is(tmp_path):
    r = resolve_effective_cap(150, "ramp", write(tmp_path, {"daily_email_target": 100.0}))
    assert r.cap == 100


def test_no_branch_raises(tmp_path):
    """The whole module is on the daily run's path; nothing here may throw."""
    unreadable = tmp_path / "dir-not-file"
    unreadable.mkdir()
    for path in [tmp_path / "absent.json", unreadable, write(tmp_path, "{broken")]:
        resolve_effective_cap(150, "ramp", path)  # must not raise


# ── Honest narration ─────────────────────────────────────────────────────────


def test_the_example_wording_from_the_spec(tmp_path):
    """'daily_email_target: 200 from controls, capped at 150 by ramp'."""
    path = write(tmp_path, {"daily_email_target": 200})
    r = resolve_effective_cap(150, "ramp", path)
    assert "daily_email_target: 200 from controls, capped at 150 by ramp" in r.log_lines


def test_every_resolution_produces_at_least_one_log_line(tmp_path):
    cases = [
        tmp_path / "absent.json",
        write(tmp_path, "{broken"),
        write(tmp_path, {}),
        write(tmp_path, {"daily_email_target": 10}),
        write(tmp_path, {"daily_email_target": 9999}),
    ]
    for path in cases:
        assert resolve_effective_cap(150, "ramp", path).log_lines


def test_an_unenforced_paused_cities_setting_is_at_least_visible(tmp_path):
    path = write(tmp_path, {"nurture_paused_cities": ["Boerne", "Helotes"]})
    r = resolve_effective_cap(150, "ramp", path)
    assert r.cap == 150
    assert any("NOT" in line and "enforced" in line for line in r.log_lines)


# ── The file it reads is the file the brain writes ───────────────────────────


def test_the_path_is_the_repo_root_controls_file():
    """lifestyle-brain commits to config/controls.json at the repository root
    (CONTROLS_PATH in its controls.ts). Reading anywhere else — this bot's own
    pond-nurture-bot/config in particular — would honour a file nobody writes."""
    assert CONTROLS_PATH == REPO_ROOT / "config" / "controls.json"
    assert REPO_ROOT.name != "pond-nurture-bot"
    assert (REPO_ROOT / "pond-nurture-bot").is_dir()


def test_load_controls_reads_what_the_brain_writes(tmp_path):
    """The brain merges a flat object: {"daily_email_target": 200, ...}."""
    parsed, why = load_controls(
        write(tmp_path, {"daily_email_target": 200, "nurture_paused_cities": []})
    )
    assert why is None
    assert parsed == {"daily_email_target": 200, "nurture_paused_cities": []}


# ── The wiring in main.py ────────────────────────────────────────────────────


def test_the_clamp_runs_after_ramp_resolution_and_before_the_send_loop(m):
    """Order is the safety property: base cap first (env/ramp/rules), then the
    controls clamp, then — and only then — the per-lead loop that consults it."""
    src = inspect.getsource(m.RuleEngine.scan_stale_leads)
    ramp_at = src.index("resolve_daily_cap")
    clamp_at = src.index("resolve_effective_cap")
    loop_at = src.index("for person in candidates")
    assert ramp_at < clamp_at < loop_at


def test_the_wiring_fails_open_and_audits_the_resolution(m):
    """Both halves of the constraint, structurally: the controls step is inside
    its own try/except (a broken read cannot stop the run), and the governed
    number lands in audit_log as daily_cap_resolution."""
    src = inspect.getsource(m.RuleEngine.scan_stale_leads)
    clamp_block = src[src.index("from .controls import") :]
    assert re.search(r"except Exception.*controls", clamp_block, re.DOTALL)
    assert '"daily_cap_resolution"' in src
