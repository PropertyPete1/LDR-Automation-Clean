#!/usr/bin/env python3
"""Run the currently approved live Follow Up Boss automation.

Approved live scope as of 2026-06-03:
- Phase 1 daily internal agent reminder digests.
- Phase 2 customer pond nurture emails every configured cadence period.
- Phase 2 20+ day stale-agent reassignment to Lead Pond.
- Phase 2 daily summary email to Peter.

Explicitly out of scope:
- SMS/texting.
- New-lead 30/60-minute warning or reassignment workflow.
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
    parser = argparse.ArgumentParser(description='Run approved daily FUB automation: Phase 1 + approved Phase 2.')
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
        print('Safety check failed: Phase 1 agent reminders are disabled. No action taken.')
        return 2
    if not rules.customer_reengagement_emails_enabled:
        print('Safety check failed: Phase 2 customer pond nurture emails are disabled. No action taken.')
        return 2
    if not rules.stale_agent_no_note_reassignment_enabled:
        print('Safety check failed: Phase 2 stale-agent reassignment is disabled. No action taken.')
        return 2
    if rules.sms_outreach_enabled:
        print('Safety check failed: SMS outreach is enabled. No action taken.')
        return 2
    # Allowed new-lead warning and reassignment workflow live as approved by owner on June 4, 2026.
    # if rules.new_lead_warning_enabled or rules.new_lead_reassignment_enabled:
    #     print('Safety check failed: new-lead warning/reassignment flags are enabled. No action taken.')
    #     return 2
    # rules.customer_nurture_log_note_enabled is no longer a safety failure since Peter requested notes on EVERYTHING by default.
    if not settings.fub_api_key:
        print('Safety check failed: FUB_API_KEY is missing. No action taken.')
        return 2
    if not settings.dry_run and not all([settings.smtp_host, settings.smtp_user, settings.smtp_password, settings.email_from]):
        print('Safety check failed: SMTP settings are incomplete for live sending. No action taken.')
        return 2

    db = AuditDB(settings.database_path)
    fub = FollowUpBossClient(settings)
    engine = RuleEngine(settings, rules, fub, db)
    print(
        'Running approved daily automation. '
        f'dry_run={settings.dry_run}; '
        f'email_cap={rules.phase2_max_customer_emails_per_run}; '
        f'reassignment_cap={rules.phase2_max_reassignments_per_run}'
    )
    # ── DISABLED: Daily deals/captions/videos email content removed (replaced by Power Queue) ──
    # The video generation, PDF deal sheets, and social media captions are no longer sent
    # to agents in the clock-in email. Power Queue handles all lead engagement now.
    if False:  # Disabled 2026-06-25
        print("Generating fresh daily personalized videos for agents...")
        import subprocess, glob, re, json
        subprocess.run(["python3", "/home/ubuntu/fub_automation/generate_personalized_videos.py"], check=True)
        
        # Upload the freshly rendered videos to S3 to refresh the CDN links
        print("Uploading fresh videos to CDN...")
        video_files = sorted(glob.glob("/home/ubuntu/webdev-static-assets/videos/LDR_Promo_*.mp4"))
        new_cdn_map = {}  # agent_key -> new CDN URL
        for vf in video_files:
            result = subprocess.run(["manus-upload-file", "--webdev", vf], capture_output=True, text=True)
            output = result.stdout.strip()
            # manus-upload-file returns the CDN URL on stdout
            cdn_url = output.split()[-1] if output else ""
            if cdn_url.startswith("http"):
                # Extract agent name from filename: LDR_Promo_steven_austin_10s.mp4 -> steven
                fname = os.path.basename(vf)
                m = re.match(r"LDR_Promo_(\w+)_", fname)
                if m:
                    new_cdn_map[m.group(1).lower()] = cdn_url
                    print(f"  Uploaded {fname} -> {cdn_url}")
        
        if new_cdn_map:
            # Auto-patch VIDEO_CDN_MAP in server/_core/index.ts
            server_index = "/home/ubuntu/fub_nurture_dashboard/server/_core/index.ts"
            with open(server_index, "r") as f:
                content = f.read()
            for agent_key, url in new_cdn_map.items():
                content = re.sub(
                    rf'({agent_key}:\s*")[^"]+"',
                    rf'\g<1>{url}"',
                    content
                )
            with open(server_index, "w") as f:
                f.write(content)
            print(f"Auto-patched VIDEO_CDN_MAP in server/_core/index.ts for: {list(new_cdn_map.keys())}")

            # Auto-patch video_cdn_map in main.py
            main_py = "/home/ubuntu/fub_automation/src/fub_automation/main.py"
            with open(main_py, "r") as f:
                main_content = f.read()
            for agent_key, url in new_cdn_map.items():
                main_content = re.sub(
                    rf'("{agent_key}":\s*")[^"]+"',
                    rf'\g<1>{url}"',
                    main_content
                )
            with open(main_py, "w") as f:
                f.write(main_content)
            print(f"Auto-patched video_cdn_map in main.py for: {list(new_cdn_map.keys())}")

        print("Daily video generation and CDN refresh completed successfully!")

    engine.scan_all_leads_for_disqualification()  # Reply Intent Handler: auto-trash relocated/bought-elsewhere leads (ALL leads)
    engine.scan_pond_responses_for_intent()
    engine.scan_stale_agent_no_note_reassignment()
    engine.scan_stale_leads()
    engine.scan_agent_followup()
    engine.poll_new_leads()
    engine.process_new_lead_timers()
    engine.scan_new_closed_leads()  # Phase 3b: same-day congrats email when a deal closes
    engine.scan_closed_drip()  # Phase 3: quarterly check-in emails for Closed/Past Client/Sphere leads
    engine.scan_reply_detection()  # Reply detection: tag + alert for leads that replied to bot emails
    engine.send_phase2_daily_summary()
    
    # Auto-refresh the dashboard data
    try:
        print("Auto-refreshing FUB Pond Nurture Dashboard data...")
        import subprocess
        subprocess.run(["/home/ubuntu/fub_automation/refresh_dashboard.sh"], check=True)
    except Exception as d_exc:
        print(f"Warning: Failed to auto-refresh dashboard: {d_exc}")
        
    print('Approved daily automation run completed.')

    # ── Dead-Man's Switch: Ping healthchecks.io on success ─────────────────
    _ping_healthcheck_daily()

    return 0


def _ping_healthcheck_daily() -> None:
    """Ping healthchecks.io dead-man's switch for the daily automation run.

    Simple GET to the configured UUID-based ping URL. Failures are logged but
    never crash the run.
    """
    import json as _json
    import requests as _req
    hc_path = Path('/home/ubuntu/fub_automation/config/healthchecks.json')
    if not hc_path.exists():
        print('  [healthcheck] config not found — skipping ping')
        return
    try:
        hc_config = _json.loads(hc_path.read_text())
        check_cfg = hc_config.get('daily_automation', {})
        url = check_cfg.get('ping_url', '')
        if not url:
            print('  [healthcheck] No ping_url for daily_automation')
            return
        resp = _req.get(url, timeout=10)
        print(f'  [healthcheck] Pinged daily_automation: {resp.status_code} {resp.text.strip()}')
    except Exception as e:
        print(f'  [healthcheck] Ping failed: {e}')


if __name__ == '__main__':
    raise SystemExit(main())
