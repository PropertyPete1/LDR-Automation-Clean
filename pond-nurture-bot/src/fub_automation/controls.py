"""
controls.py — PRIMARY's config/controls.json, honoured as a CLAMP, never an
override.

The voice console (lifestyle-brain) commits settings to config/controls.json
at the REPOSITORY ROOT — not this bot's own config/ directory — after Peter
approves them out loud. Until now nothing read that file: a voice-set
daily_email_target was a number in git and not a behaviour. This module is
the read side, and it is built around three rules, in order of importance:

1.  **A control can only ever lower the volume.** The effective daily cap is
        min(controls value, whatever the bot resolved on its own)
    where "on its own" means the full existing resolution — POND_DAILY_CAP
    env override, else the ramp step, else the rules.yaml fallback. A
    voice-set 500 cannot push past a ramp cap of 150; a voice-set 0 stops
    the day's sending outright. The ramp's guardrails, the suppression
    layers and every safety invariant are untouched — the clamp runs after
    and below all of them, and only ever downward.

2.  **A missing or broken file changes nothing.** No file, unreadable JSON,
    a non-object, a value of the wrong type or out of range — every one of
    those means the bot behaves exactly as it did before this module
    existed, and says why in the log. Fail-open to current behaviour,
    never fail-closed on a config read.

3.  **The resolution is said out loud.** Every run logs which number
    actually governed and why — "daily_email_target: 200 from controls,
    capped at 150 by ramp" — and writes the same resolution into audit_log,
    so the telemetry, the weekly digest and PRIMARY itself can report the
    governing number honestly instead of guessing from the file.

Only daily_email_target is enforced here. nurture_paused_cities exists in
the schema the brain writes but is NOT wired into suppression yet; when it
is present and non-empty this module logs that it is unenforced, so a
committed-but-ignored setting is at least a visible one.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple

# The path the brain writes (CONTROLS_PATH in lifestyle-brain's controls.ts):
# config/controls.json at the repository root. This file lives at
# <root>/pond-nurture-bot/src/fub_automation/controls.py, so the root is three
# levels up — resolved from __file__ deliberately, because main.py chdirs and
# a CWD-relative read would look inside pond-nurture-bot/config instead.
REPO_ROOT = Path(__file__).resolve().parents[3]
CONTROLS_PATH = REPO_ROOT / "config" / "controls.json"

DAILY_TARGET_KEY = "daily_email_target"
PAUSED_CITIES_KEY = "nurture_paused_cities"

# The brain refuses to commit values outside 0..500; mirrored here so a
# hand-edited file cannot smuggle a nonsense number through the clamp. Above
# the bound is invalid (ignored, loudly), not clamped-to-bound: a number the
# brain could never have written is a broken file, not an instruction.
DAILY_TARGET_MIN = 0
DAILY_TARGET_MAX = 500


@dataclass
class CapResolution:
    """The whole story of one run's daily cap, for logs and audit alike."""

    #: The number that actually governs today.
    cap: int
    #: What the bot resolved on its own (env override / ramp / rules fallback).
    base_cap: int
    #: The valid controls value, when there was one.
    control_value: Optional[int] = None
    #: "controls" when the file lowered the cap, "ramp" when the bot's own cap
    #: held (including every fail-open case), for the audit row.
    governed_by: str = "ramp"
    #: git blob SHA of the controls file that was read (what GitHub shows for
    #: it), None when there was no readable file. Ties every run's log to the
    #: exact committed bytes that governed it.
    controls_sha: Optional[str] = None
    #: Human sentences, one per LOGGER.info call, ready to emit.
    log_lines: List[str] = field(default_factory=list)


def load_controls(path: Optional[Path] = None) -> Tuple[Optional[dict], Optional[str]]:
    """The controls file as a dict, or (None, why-not).

    Every miss is a reason, never an exception: the caller's fail-open path
    wants a sentence for the log, not a stack trace.
    """
    target = path or CONTROLS_PATH
    try:
        raw = target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, "config/controls.json not present"
    except OSError as exc:
        return None, f"config/controls.json unreadable ({exc})"

    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        return None, f"config/controls.json is not valid JSON ({exc})"

    if not isinstance(parsed, dict):
        return None, "config/controls.json is not a JSON object"

    return parsed, None


def controls_blob_sha(path: Optional[Path] = None) -> Optional[str]:
    """The file's git blob SHA — the id GitHub shows for the committed file.

    Computed locally (sha1 over ``blob <len>\0<bytes>``) so the log can name
    the exact controls.json a run obeyed without shelling out to git, which
    is not guaranteed to be on PATH where the bot runs. None when the file
    cannot be read; the caller treats that exactly like a missing file.
    """
    target = path or CONTROLS_PATH
    try:
        data = target.read_bytes()
    except OSError:
        return None
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def _read_daily_target(controls: dict) -> Tuple[Optional[int], Optional[str]]:
    """The daily_email_target as an int in bounds, or (None, why it was ignored).

    (None, None) means the key simply is not set — unset is normal, not a fault.
    """
    if DAILY_TARGET_KEY not in controls:
        return None, None

    value = controls[DAILY_TARGET_KEY]

    # bool is an int subclass; True clamping the pond to 1 email would be absurd.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None, f"{DAILY_TARGET_KEY} is {value!r}, not a number — ignored"
    if isinstance(value, float):
        if not value.is_integer():
            return None, f"{DAILY_TARGET_KEY} is {value!r}, not a whole number — ignored"
        value = int(value)
    if not (DAILY_TARGET_MIN <= value <= DAILY_TARGET_MAX):
        return None, (
            f"{DAILY_TARGET_KEY} is {value}, outside {DAILY_TARGET_MIN}"
            f"..{DAILY_TARGET_MAX} — ignored"
        )

    return int(value), None


def resolve_effective_cap(
    base_cap: int,
    base_source: str = "ramp",
    path: Optional[Path] = None,
) -> CapResolution:
    """Clamp the bot's own cap by the controls file, and narrate the outcome.

    `base_cap` is whatever the existing resolution produced and `base_source`
    names where it came from — "ramp" (the ordinary case), "manual override"
    (POND_DAILY_CAP), or "rules.yaml fallback" (the state DB was unreadable).
    The base is the ceiling the controls value can never exceed, whatever its
    source: min() is min(), and a manual override being clamped downward by a
    lower voice-set target is exactly the never-an-override rule applied
    evenly. Every branch returns a governed cap and at least one log line; no
    branch raises.
    """
    base_cap = max(0, int(base_cap))
    resolution = CapResolution(cap=base_cap, base_cap=base_cap)

    controls, why_not = load_controls(path)
    if controls is None:
        resolution.log_lines.append(
            f"controls: {why_not} — daily cap {base_cap} from {base_source}"
        )
        # The greppable self-documentation line: every run states the clamp's
        # status in one [controls]-prefixed sentence, engaged or not.
        resolution.log_lines.append(
            f"[controls] clamp fail-open ({why_not}): daily_cap={base_cap} from {base_source}"
        )
        return resolution

    resolution.controls_sha = controls_blob_sha(path)

    target, invalid_reason = _read_daily_target(controls)

    if invalid_reason is not None:
        resolution.log_lines.append(
            f"controls: {invalid_reason} — daily cap {base_cap} from {base_source}"
        )
    elif target is None:
        resolution.log_lines.append(
            f"controls: {DAILY_TARGET_KEY} unset — daily cap {base_cap} from {base_source}"
        )
    elif target < base_cap:
        resolution.cap = target
        resolution.control_value = target
        resolution.governed_by = "controls"
        resolution.log_lines.append(
            f"{DAILY_TARGET_KEY}: {target} from controls, under the {base_source} cap "
            f"{base_cap} — governing"
        )
    else:
        resolution.control_value = target
        resolution.log_lines.append(
            f"{DAILY_TARGET_KEY}: {target} from controls, capped at {base_cap} by {base_source}"
        )

    # A committed setting nobody enforces must at least be a visible one.
    paused = controls.get(PAUSED_CITIES_KEY)
    if isinstance(paused, list) and paused:
        resolution.log_lines.append(
            f"controls: {PAUSED_CITIES_KEY} is set ({len(paused)} cities) but NOT "
            "enforced by this bot yet"
        )

    # The greppable self-documentation line, last so it reads as the verdict:
    # which number governs today, and the exact committed file it came from.
    sha7 = (resolution.controls_sha or "unknown")[:7]
    resolution.log_lines.append(
        f"[controls] clamp active: daily_cap={resolution.cap}, source=controls.json@{sha7}"
    )

    return resolution
