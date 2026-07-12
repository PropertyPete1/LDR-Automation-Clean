#!/bin/bash
# =============================================================================
# FUB Automation — Cloud Computer 24/7 Cron Setup
# Run once: bash /home/ubuntu/fub_automation/setup_crons.sh
# Timezone: America/Chicago (CT) — already set via timedatectl
# =============================================================================

AUTOMATION_DIR="/home/ubuntu/fub_automation"
LOG_DIR="$AUTOMATION_DIR/logs"
mkdir -p "$LOG_DIR"

crontab - << 'CRONTAB'
# FUB Automation — Lifestyle Design Realty
# Cloud Computer crontab — all times in America/Chicago (CT)
# Last updated: 2026-06-20

# ── Daily main automation ──────────────────────────────────────────────────
# Pond emails, stale reassignment, agent digests, closed drip, Phase 3 check-ins
# Runs at 8:00 AM CT every day
0 8 * * * cd /home/ubuntu/fub_automation && /usr/bin/python3 run_approved_daily_automation.py >> /home/ubuntu/fub_automation/logs/daily_automation.log 2>&1

# ── Nightly self-healing health check ─────────────────────────────────────
# Audits system, auto-fixes known issues, emails Peter morning summary
# Runs at 4:00 AM CT every day
0 4 * * * cd /home/ubuntu/fub_automation && /usr/bin/python3 nightly_health.py >> /home/ubuntu/fub_automation/logs/nightly_health.log 2>&1

# ── Speed-to-lead intraday checker ────────────────────────────────────────
# Fires 30-min alert if a new lead hasn't been claimed
# Runs every 5 minutes 7 days a week 10am-6pm CT (approved by Peter 2026-06-20)
*/5 10-17 * * * cd /home/ubuntu/fub_automation && /usr/bin/python3 run_speed_to_lead_check.py >> /home/ubuntu/fub_automation/logs/speed_to_lead.log 2>&1

# ── Weekly performance digest ─────────────────────────────────────────────
# Sends Peter a weekly summary: sends, replies, speed-to-lead, bounces, etc.
# Runs at 8:00 AM CT every Monday
0 8 * * 1 cd /home/ubuntu/fub_automation && /usr/bin/python3 weekly_digest.py >> /home/ubuntu/fub_automation/logs/weekly_digest.log 2>&1

# ── Log rotation ───────────────────────────────────────────────────────────
# Truncates any log over 5MB to 2MB to prevent disk fill
# Runs at 3:00 AM CT every Sunday
0 3 * * 0 find /home/ubuntu/fub_automation/logs -name "*.log" -size +5M -exec truncate -s 2M {} \;

CRONTAB

echo "✅ Crontab installed. Current schedule:"
crontab -l
