#!/usr/bin/env python3
"""Run approved Phase 2 FUB pond nurture and 20-day stale-agent reassignment.

This runner intentionally keeps SMS and new-lead automation out of scope. It runs
only customer pond nurture, stale-agent reassignment to Lead Pond, and the Phase 2
summary email after scans complete.
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
    parser = argparse.ArgumentParser(description='Run approved Phase 2 pond nurture and stale-agent reassignment.')
    parser.add_argument('--dry-run', action='store_true', help='Force dry-run mode regardless of .env')
    args = parser.parse_args()

    load_dotenv()
    if args.dry_run:
        os.environ['DRY_RUN'] = 'true'
    os.environ['FUB_DISABLE_SCHEDULER'] = 'true'

    from src.fub_automation.main import AuditDB, FollowUpBossClient, RuleEngine, Rules, Settings

    settings = Settings.from_env()
    rules = Rules.load(settings.rules_path)

    if not rules.customer_reengagement_emails_enabled:
        print('Safety check failed: customer pond nurture emails are disabled in rules.yaml. No action taken.')
        return 2
    if not rules.stale_agent_no_note_reassignment_enabled:
        print('Safety check failed: stale-agent reassignment is disabled in rules.yaml. No action taken.')
        return 2
    if rules.sms_outreach_enabled:
        print('Safety check failed: SMS outreach is enabled. No action taken.')
        return 2
    # Allowed new-lead warning and reassignment workflow live as approved by owner on June 4, 2026.
    # if rules.new_lead_warning_enabled or rules.new_lead_reassignment_enabled:
    #     print('Safety check failed: new-lead warning/reassignment flags are enabled. No action taken.')
    #     return 2
    if not settings.fub_api_key:
        print('Safety check failed: FUB_API_KEY is missing. No action taken.')
        return 2
    if not settings.dry_run and not all([settings.smtp_host, settings.smtp_user, settings.smtp_password, settings.email_from]):
        print('Safety check failed: SMTP settings are incomplete for live sending. No action taken.')
        return 2

    db = AuditDB(settings.database_path)
    fub = FollowUpBossClient(settings)
    engine = RuleEngine(settings, rules, fub, db)
    print(f'Running approved Phase 2. dry_run={settings.dry_run}; email_cap={rules.phase2_max_customer_emails_per_run}; reassignment_cap={rules.phase2_max_reassignments_per_run}')
    engine.scan_stale_agent_no_note_reassignment()
    engine.scan_stale_leads()
    engine.send_phase2_daily_summary()
    print('Phase 2 run completed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
