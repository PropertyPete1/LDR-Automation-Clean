#!/usr/bin/env python3
"""Run Phase 1 FUB agent reminder digests only.

This script intentionally runs only internal agent follow-up reminders. Customer
re-engagement, SMS, new-lead warnings, and reassignment remain controlled by
rules.yaml and are not invoked here.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path


def load_dotenv(path: str = '.env') -> None:
    env_path = Path(path)
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(errors='ignore').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if value.startswith('${') and value.endswith('}'):
            value = os.environ.get(value[2:-1], value)
        os.environ[key] = value


def main() -> int:
    parser = argparse.ArgumentParser(description='Run Phase 1 agent reminder digests only.')
    parser.add_argument('--dry-run', action='store_true', help='Force dry-run mode regardless of .env')
    args = parser.parse_args()

    load_dotenv()
    if args.dry_run:
        os.environ['DRY_RUN'] = 'true'
    os.environ['FUB_DISABLE_SCHEDULER'] = 'true'

    from src.fub_automation.main import AuditDB, FollowUpBossClient, RuleEngine, Rules, Settings

    settings = Settings.from_env()
    rules = Rules.load(settings.rules_path)

    if not rules.agent_reminder_emails_enabled:
        print('Phase 1 agent reminder emails are disabled in rules.yaml; no action taken.')
        return 0
    # Allow new-lead warning/reassignment flags as approved on June 4, 2026.
    if rules.customer_reengagement_emails_enabled or rules.sms_outreach_enabled:
        print('Safety check failed: non-Phase-1 outreach flags are enabled. No action taken.')
        return 2
    if not settings.fub_api_key:
        print('Safety check failed: FUB_API_KEY is missing. No action taken.')
        return 2
    if not settings.dry_run and not all([settings.smtp_host, settings.smtp_user, settings.smtp_password, settings.email_from]):
        print('Safety check failed: SMTP settings are incomplete for live sending. No action taken.')
        return 2

    db = AuditDB(settings.database_path)
    fub = FollowUpBossClient(settings)
    engine = RuleEngine(settings, rules, fub, db)
    print(f'Running Phase 1 agent reminders only. dry_run={settings.dry_run}')
    engine.scan_agent_followup()
    print('Phase 1 agent reminder run completed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
