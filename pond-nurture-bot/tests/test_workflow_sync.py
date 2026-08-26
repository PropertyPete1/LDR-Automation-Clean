"""Values that live in two files and must agree.

ramp.py's runtime guardrail holds the daily cap whenever a run creeps toward
the workflow's kill line — but it can only see its own constant, not GitHub's.
If daily-automation.yml's timeout-minutes moves and WORKFLOW_TIMEOUT_MINUTES
does not, the guardrail measures against the wrong ceiling: too low and the
ramp holds forever, too high and the workflow kills runs the ramp thought were
safe. Nothing else ties them together — this test is the seam.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # pond-nurture-bot/
DAILY_YML = ROOT.parent / ".github" / "workflows" / "daily-automation.yml"


def test_ramp_timeout_matches_the_daily_workflow():
    from fub_automation import ramp

    yml = DAILY_YML.read_text()
    found = re.findall(r"timeout-minutes:\s*(\d+)", yml)
    assert len(found) == 1, (
        f"expected exactly one timeout-minutes in daily-automation.yml, found {found} — "
        "if a second job was added, point this test at the automation job's value")
    assert int(found[0]) == ramp.WORKFLOW_TIMEOUT_MINUTES, (
        f"daily-automation.yml timeout-minutes={found[0]} but "
        f"ramp.WORKFLOW_TIMEOUT_MINUTES={ramp.WORKFLOW_TIMEOUT_MINUTES} — "
        "change them together (the ramp's runtime guardrail measures against this)")
