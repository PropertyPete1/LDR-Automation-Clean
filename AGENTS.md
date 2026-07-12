# Cloud Computer: Peter Allen's Cloud PC 2 — AGENTS.md

## Purpose
Runs the FUB Pond Nurture daily automation AND the unified 4am morning health report for Lifestyle Design Realty.

## Key Paths
- `/home/ubuntu/fub_automation/` — Main automation project
- `/home/ubuntu/fub_automation/src/fub_automation/main.py` — Core automation logic
- `/home/ubuntu/fub_automation/src/fub_automation/sms_helpers.py` — SMS body generation
- `/home/ubuntu/fub_automation/data/fub_automation.sqlite3` — Audit log + reengagement DB
- `/home/ubuntu/fub_automation/config/rules.yaml` — Live automation rules
- `/home/ubuntu/fub_automation/.env` — Environment variables (FUB_API_KEY, OPENAI_API_KEY, OPENAI_BASE_URL, SMTP_*, DASHBOARD_URL, HEALER_SECRET, FUB_NURTURE_URL)
- `/home/ubuntu/fub_automation/run_approved_daily_automation.py` — Entry point for daily automation
- `/home/ubuntu/fub_automation/nightly_health.py` — **Unified 4am morning healer** (NEW 2026-06-15)

## Scheduled Execution

### Daily Automation (8:00 AM CT)
Task name: "FUB approved daily automation: Phase 1 + Phase 2"
- Phase 1: Agent reminder email digests with Click-to-Text links
- Phase 2: Pond nurture emails (14-day cadence), stale-agent reassignment (20+ days)
- SMS/texting: DISABLED
- New-lead 30/60-min workflow: DISABLED

### Unified 4am Morning Health Report (4:00 AM CT)
Task name: "LDR Unified 4am Morning Health Report"
Task UID: `OGkdIqCfyKfol8rPzVVaV1`
Cron: `0 9 * * *` (09:00 UTC = 4:00 AM CT)
Script: `/home/ubuntu/fub_automation/nightly_health.py`
Recipients: peter@lifestyledesignrealty.com, steven@lifestyledesignrealty.com

This report covers the ENTIRE automation stack:
1. **Python Pond Automation** — queries local SQLite `audit_log` for errors
2. **Agent Bots (6 bots)** — queries WebDev dashboard `/api/healer/observations` API
3. **Auto-fix** — detects and fixes known transient errors (missing packages, etc.)

## Unified Healer — WebDev API Bridge (✅ COMPLETED 2026-06-15)

The healer fetches agent bot data from the Lifestyle Bot Dashboard via a secure API endpoint.
All setup steps have been applied:

1. ✅ Route `GET /api/healer/observations` added to `server/_core/index.ts` in the `lifestyle_bot_dashboard` WebDev project.
2. ✅ `HEALER_SECRET` set as env var in the WebDev project (matches value in this `.env`).
3. ✅ `DASHBOARD_URL=https://lifestyledash-wpnl8v84.manus.space` set in `/home/ubuntu/fub_automation/.env`.
4. ✅ `lifestyle_bot_dashboard` WebDev project is published at `https://lifestyledash-wpnl8v84.manus.space`.

Endpoint contract: `GET /api/healer/observations` with header `x-healer-token: <HEALER_SECRET>`
Returns: `{ observations: [...], run_status: [...], generatedAt: "..." }`
Slug mapping: sp500→lifestyle_bot, tiffany→tiffany_bot, stefanie→rue_bot, abby→abby_bot, irma→irma_bot, laila→laila_bot

## Self-Healing Heartbeat Write-Back (✅ COMPLETED 2026-06-17)

After every successful run, `nightly_health.py` calls `post_healer_heartbeat()` which POSTs a `source=nightly_healer` observation to the fub-nurture dashboard. This clears the botMonitor warning automatically — the nightly healer is now fully self-healing.

1. ✅ `bot_observations` table added to `fub_nurture_dashboard` WebDev project (Drizzle schema + migration applied).
2. ✅ `POST /api/healer/write` route added to `server/_core/index.ts` in `fub_nurture_dashboard`. Authenticates via `x-healer-token` header, inserts into `bot_observations`, returns `{ok:true}`.
3. ✅ `HEALER_SECRET` env var set in `fub_nurture_dashboard` WebDev project.
4. ✅ `FUB_NURTURE_URL=https://fubdash-bkyqff6t.manus.space` set in `/home/ubuntu/fub_automation/.env`.
5. ✅ `fub_nurture_dashboard` published at `https://fubdash-bkyqff6t.manus.space`.

Endpoint contract: `POST /api/healer/write` with header `x-healer-token: <HEALER_SECRET>`
Body: `{ source, severity, category, message, detail?, autoFixable? }`
Returns: `{ ok: true }` on success

## Installed Python Packages (system-level)
- openai 1.59.3
- requests 2.32.3
- reportlab 4.5.1 (installed 2026-06-08 — required for PDF generation in agent digests)
- jinja2 3.0.3

## Change History
- 2026-06-17: Self-healing heartbeat write-back completed — POST /api/healer/write added to fub_nurture_dashboard, bot_observations table migrated, FUB_NURTURE_URL updated in .env to https://fubdash-bkyqff6t.manus.space, end-to-end verified (nightly_health.py → live endpoint → database insert confirmed)
- 2026-06-15: Healer bridge completed — GET /api/healer/observations route added to lifestyle_bot_dashboard, HEALER_SECRET set, DASHBOARD_URL updated in .env
- 2026-06-15: Created nightly_health.py — unified 4am healer covering Python automation + 6 agent bots
- 2026-06-15: Added DASHBOARD_URL, HEALER_SECRET, HEALER_REPORT_TO to .env
- 2026-06-15: Registered Manus scheduled task "LDR Unified 4am Morning Health Report" (UID: OGkdIqCfyKfol8rPzVVaV1)
- 2026-06-08: Applied OPENAI_BASE_URL fix to ContentGenerator.__init__ in main.py
- 2026-06-08: Installed reportlab (was missing, causing 9 agent_followup_reminder errors per run)
- 2026-06-08: sms_helpers.py updated with first_name_cap and lead_id seed for SMS variety
