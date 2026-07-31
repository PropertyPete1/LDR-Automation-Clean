"""healthchecks.io dead-man's switches, configured entirely by environment.

WHY ENV AND NOT config/healthchecks.json
    The two existing checks (daily_automation, nightly_health) keep their ping
    UUIDs in a committed JSON file. This repo is PUBLIC, and an hc-ping UUID is
    effectively a write credential: anyone holding it can ping the check and
    hold it green while the automation is dead — the exact failure the switch
    exists to catch. New checks therefore read their URL from a secret env var
    and never enter the repo.

WHY THESE THREE
    daily-automation and nightly-health already ping. speed-to-lead,
    reply-detection and weekly-digest did not — so if any of them silently
    stopped firing, nothing would say so. speed-to-lead is the worst of the
    three: it drives the 30/60-minute lead-response timers.

CONTRACT
    * Never raises, never blocks the run. A monitoring call must not be able to
      break the thing it monitors.
    * Silent no-op when the env var is unset, so local runs and forks need no
      configuration and no secret.
    * ping(check, fail=True) hits the /fail endpoint so a failed run marks the
      check DOWN immediately instead of waiting for the grace period.
"""
from __future__ import annotations

import logging
import os

LOGGER = logging.getLogger("fub_automation.healthcheck")

#: Logical check name -> environment variable holding its full ping URL.
CHECK_ENV_VARS = {
    "speed_to_lead": "HEALTHCHECK_URL_SPEED_TO_LEAD",
    "reply_detection": "HEALTHCHECK_URL_REPLY_DETECTION",
    "weekly_digest": "HEALTHCHECK_URL_WEEKLY_DIGEST",
}

_TIMEOUT_SECONDS = 10


def env_var_for(check: str) -> str:
    """Environment variable name that carries `check`'s ping URL."""
    return CHECK_ENV_VARS.get(check, f"HEALTHCHECK_URL_{check.upper()}")


def ping(check: str, *, fail: bool = False) -> bool:
    """Ping the dead-man's switch for `check`. Returns True if a ping was sent.

    fail=True pings the `/fail` endpoint (healthchecks.io convention), flipping
    the check to DOWN right away rather than waiting for it to time out.
    """
    url = (os.environ.get(env_var_for(check)) or "").strip()
    if not url:
        LOGGER.debug("healthcheck %s not configured (%s unset) — skipping ping",
                     check, env_var_for(check))
        return False
    if (os.environ.get("DRY_RUN") or "").lower() in ("1", "true", "yes"):
        LOGGER.info("[DRY-RUN] would ping healthcheck %s (fail=%s)", check, fail)
        return False

    target = f"{url.rstrip('/')}/fail" if fail else url
    try:
        import requests  # imported lazily so this module stays dependency-free
        resp = requests.get(target, timeout=_TIMEOUT_SECONDS)
        LOGGER.info("healthcheck %s pinged (%s): HTTP %s",
                    check, "FAIL" if fail else "ok", resp.status_code)
        return True
    except Exception as exc:  # noqa: BLE001 — monitoring must never break the run
        LOGGER.warning("healthcheck %s ping failed: %s", check, exc)
        return False


def configured_checks() -> dict:
    """{check: bool} — which switches are wired up in this environment."""
    return {c: bool((os.environ.get(v) or "").strip()) for c, v in CHECK_ENV_VARS.items()}
