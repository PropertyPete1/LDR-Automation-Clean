#!/usr/bin/env python3
"""
Lightweight speed-to-lead intraday checker.

Runs every minute during business hours (10am–6pm CT) via Manus AGENT cron.
ONLY processes new_lead_timers — no pond nurture, no agent digests, no reassignments.

This script is intentionally minimal so it completes in under 30 seconds.
"""

from __future__ import annotations
import os
import sys
import datetime
import logging
from pathlib import Path
from zoneinfo import ZoneInfo

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [speed-to-lead] %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("/home/ubuntu/fub_automation/speed_to_lead.log", mode="a"),
    ],
)
LOGGER = logging.getLogger("speed_to_lead")


# ---------------------------------------------------------------------------
# .env loader (same as daily automation)
# ---------------------------------------------------------------------------
def load_dotenv(path: str = ".env") -> None:
    env_path = Path(path)
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    CT = ZoneInfo("America/Chicago")
    now_ct = datetime.datetime.now(CT)
    hour = now_ct.hour

    # Only run during business hours: 10am–6pm CT (10–18)
    if not (10 <= hour < 18):
        LOGGER.info("Outside business hours (%s CT) — skipping.", now_ct.strftime("%H:%M"))
        return 0

    LOGGER.info("Speed-to-lead check starting at %s CT", now_ct.strftime("%H:%M:%S"))

    load_dotenv()

    # Disable the APScheduler background scheduler (we run inline, not as a daemon)
    os.environ["FUB_DISABLE_SCHEDULER"] = "true"

    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

    try:
        from src.fub_automation.main import AuditDB, FollowUpBossClient, RuleEngine, Rules, Settings
    except ModuleNotFoundError:
        from fub_automation.main import AuditDB, FollowUpBossClient, RuleEngine, Rules, Settings

    settings = Settings.from_env()
    if not settings.fub_api_key:
        LOGGER.error("FUB_API_KEY is missing — aborting.")
        return 1

    rules = Rules.load(settings.rules_path)

    # Safety: only proceed if speed-to-lead is enabled in rules.yaml
    if not rules.new_lead_warning_enabled and not rules.new_lead_reassignment_enabled:
        LOGGER.info("Speed-to-lead disabled in rules.yaml — skipping.")
        return 0

    db = AuditDB(settings.database_path)
    fub = FollowUpBossClient(settings)
    engine = RuleEngine(settings, rules, fub, db)

    try:
        engine.process_new_lead_timers()
        LOGGER.info("Speed-to-lead check complete at %s CT", datetime.datetime.now(CT).strftime("%H:%M:%S"))
    except Exception as exc:
        LOGGER.error("Speed-to-lead check failed: %s", exc, exc_info=True)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
