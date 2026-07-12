# LDR Unified Nightly Health Check — June 18, 2026 (4:00 AM CT Run)

**Executed by:** Manus Scheduled Task (`OGkdIqCfyKfol8rPzVVaV1`)
**Run time:** 2026-06-18 09:00 UTC (4:00 AM CT)
**Exit code:** NON-ZERO — `nightly_health.py` could not execute (see Critical Finding)

---

## Critical Finding

The directory `/home/ubuntu/fub_automation` **does not exist** on Cloud PC 2
(device ID: `6or46cjxhrta0ylgsc60labr8`). The `nightly_health.py` script
could not be executed because neither the directory nor the script is present
on the cloud computer's filesystem.

This is a **persistent issue** — the same error has appeared in the June 15,
June 16, and June 18 morning health reports.

---

## WebDev-Side Healer Results (Ran Successfully at 09:00 UTC)

| Metric | Value |
|---|---|
| Dashboard UI errors found | 3 |
| Errors auto-fixed overnight | 3 |
| Errors needing manual review | 0 |
| Roster cache cleared | Yes |
| Old error rows pruned | 0 |
| Total bot observations (last 25 hrs) | 19 |
| Issues auto-fixed | 0 |

### Auto-fixes Applied
- `other` (2 errors): Transient fetch errors cleared; cache reset for fresh morning load
- `roster` (1 error): Roster cache cleared — agent data will re-fetch from FUB on next load

---

## Active Errors (Require Manual Attention)

| Severity | Source | Issue |
|---|---|---|
| 🔴 Error | `bot_monitor` | FUB API reachability — FUB API returned an error or timed out after 1ms |
| 🔴 Error | `pond_nurture` | Pond nurture script failed — `/home/ubuntu/fub_automation` missing on cloud computer |

## Active Warnings (17 total)

| Count | Source | Issue |
|---|---|---|
| 16 | `bot_monitor` | `rules.yaml` integrity — missing expected configuration keys |
| 1 | `bot_monitor` | FUB total lead count — Skipped (FUB API unreachable) |
| 1 | `bot_monitor` | Pond lead count — Skipped (FUB API unreachable) |

---

## Lifestyle Bot Status

All 6 agent lifestyle bots show status `not_run` (S&P500, Tiffany's, Rue,
Abby's, Irma's, and Laila's bots have never run per the 4am bot health check
email sent at 09:00 UTC).

---

## Priority Action Items

1. **CRITICAL** — Restore `/home/ubuntu/fub_automation/` on Cloud PC 2.
   All Python automation files (`nightly_health.py`, `run_approved_daily_automation.py`,
   `main.py`, `rules.yaml`, `fub_automation.sqlite3`) are absent.
2. **HIGH** — Investigate FUB API reachability (timing out after 1ms).
   May be a credentials issue, network/firewall issue, or API key expiration.
3. **MEDIUM** — Fix `rules.yaml` missing configuration keys (16 repeated warnings/cycle).
4. **MEDIUM** — Verify and activate the 6 per-agent lifestyle bot heartbeat cron jobs.
