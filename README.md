# LDR Database Hygiene & Nurture System

> ✅ **LIVE — runs entirely on GitHub Actions (cutover 2026-07-13)**
> Agent Bot Dashboard and Power Queue remain on Manus hosting.

**Lifestyle Design Realty | Last updated: July 13, 2026**

---

## What This System Does (Plain English)

This is a fully automated real estate follow-up machine. It watches every lead in Follow Up Boss (FUB), figures out who needs to hear from the team and when, and either sends an email automatically or puts the right lead in front of the right agent at the right time. It runs every day without anyone touching it. If something breaks, it fixes itself or sends a report explaining exactly what went wrong.

There are **four connected pieces** to this system:

| Piece | What It Is | Where It Lives |
| --- | --- | --- |
| **Python Automation (5 GitHub Actions workflows)** | Pond nurture emails, speed-to-lead, reply detection, nightly health, weekly digest | GitHub Actions on `PropertyPete1/LDR-Automation-Clean` |
| **FUB Nurture Dashboard** | Web dashboard for the Power Queue (agents text leads) + health monitoring | Manus WebDev: `fub-nurture-phfprjui.manus.space` |
| **Lifestyle Bot Dashboard** | Runs per-agent AI bots (data-driven `agent_bots` registry) that send lifestyle emails to assigned leads | Manus WebDev: `lifestyledash-wpnl8v84.manus.space` |
| **Nightly Health Report** | 4am email that checks every system and auto-fixes known errors | GitHub Actions (nightly-health.yml) |

---

## GitHub Actions Workflows (5 Total)

All automation runs on GitHub Actions with encrypted state persistence on the `state` branch.

| Workflow | File | Schedule (UTC) | CT Equivalent | Purpose |
| --- | --- | --- | --- | --- |
| **Daily Automation** | `daily-automation.yml` | `0 12 * * *` | 7:00 AM CT | Pond nurture emails (100/day cap), stale-agent reassignment, speed-to-lead scan, reply detection, dashboard export |
| **Nightly Health** | `nightly-health.yml` | `0 9 * * *` | 4:00 AM CT | System audit, auto-fixes, bounce/unsub detection, 4am email report to Peter + Steven |
| **Speed-to-Lead** | `speed-to-lead.yml` | `*/5 15-23 * * *` | Every 5 min, 10am–6pm CT | Monitors new leads, fires 30-min warning and 60-min reassignment |
| **Reply Detection** | `reply-detection.yml` | `*/10 * * * *` | Every 10 min | Detects replies to bot emails, tags lead, alerts agent |
| **Weekly Digest** | `weekly-digest.yml` | `0 13 * * 1` | 8:00 AM CT Monday | Weekly performance summary email to Peter |

### State Management

The `state` branch contains only the encrypted SQLite database (`fub_automation.sqlite3.enc`). Each workflow:
1. Pulls and decrypts the state DB at the start of the run
2. Executes the Python automation
3. Re-encrypts and pushes the updated state DB back to the `state` branch

Encryption uses AES-256 via `openssl` with the `STATE_ENCRYPTION_KEY` secret.

### Required GitHub Secrets

| Secret | Purpose |
| --- | --- |
| `FUB_API_KEY` | Follow Up Boss API key |
| `ANTHROPIC_API_KEY` | Anthropic API key for LLM email generation |
| `LLM_MODEL` | Model ID (currently `claude-sonnet-4-6`) |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_PORT` | Email sending credentials |
| `STATE_ENCRYPTION_KEY` | AES-256 key for encrypting the SQLite state DB |
| `DASHBOARD_URL` | Lifestyle Bot Dashboard URL |
| `FUB_NURTURE_URL` | FUB Nurture Dashboard URL |
| `HEALER_SECRET` | Shared token for healer API endpoints |
| `HEALTHCHECKS_PING_KEY` | Dead-man's switch ping key |

---

## The Lead Journey — Start to Finish

**Day 0 — New Lead Arrives in FUB.** The lead is assigned to an agent. Speed-to-Lead monitors the response time (30-min warning, 60-min reassignment to Peter).

**Day 1 through Day 13 — Agent's Window.** The lead belongs to the agent. Every morning, the agent gets a digest email listing all their leads that need attention, with a Click-to-Text link for each one. The agent can also open the Power Queue on the dashboard and work through their leads in order.

**Day 14 through Day 20 — Priority Zone (Agent Must Act).** These leads are now flagged as "Priority" in the Power Queue. They appear at the top of the agent's queue, sorted most-overdue first (day 20 before day 19). If the agent does not act, the lead is about to fall into the pond.

**Day 21+ — Lead Falls into the Pond (Lifestyle Bot Takes Over).** Once a lead has had no activity for 20+ days, the Python automation reassigns it to the Lead Pond (FUB Pond ID 2). The Lifestyle Bot Dashboard's bots take over and send AI-written lifestyle emails every 14 days indefinitely.

**Pond Lead — Every 14 Days Forever.** The Pond Nurture bot emails every pond lead every 14 days. The email is written by AI, references the lead's most recent FUB note, uses a dynamic subject line, and feels like a natural continuation of the last conversation.

---

## System 1 — Python Automation (GitHub Actions)

**Runs at: 7:00 AM CT every day (Daily Automation workflow)**

### Phase 1 — Agent Digest Emails

For every agent, the script pulls all their leads from FUB that are 1–20 days stale and builds a personalized digest email. Each lead in the email has a Click-to-Text link. Peter is CC'd on every digest.

### Phase 2 — Pond Nurture Emails

For every lead sitting in the Lead Pond, the script checks if it has been 14+ days since the last email. If yes, it goes through five checks before sending:

1. **LLM Skip Check** — The AI reads all of the lead's FUB notes and decides whether the lead should be skipped. It looks for four intent categories: (A) no longer a buyer, (B) working with someone else, (C) asked not to be contacted, (D) relocated permanently. The AI must be 80%+ confident to skip.
2. **3-Day Contact Gap** — If any bot or the Python script contacted this lead within the last 3 days, skip silently.
3. **Stage/Tag Suppression** — Leads in Trash, or tagged with any shared suppression tag, are skipped.
4. **Email Channel Check** — Lead must have a valid email address.
5. **14-Day Cadence** — Lead must not have received a pond nurture email in the last 14 days.

If all five checks pass, the AI writes a personalized email. After sending, a note is written in FUB and the send is logged to the SQLite database.

**Daily caps:** 100 pond nurture emails per run, 100 stale-agent reassignments per run.

### Phase 2 also handles Stale-Agent Reassignment

If a lead has been assigned to an agent for 20+ days with no qualifying note, it is automatically moved to the Lead Pond (Pond ID 2) and reassigned to Peter.

---

## System 2 — FUB Nurture Dashboard (Power Queue)

**URL:** `fub-nurture-phfprjui.manus.space`
**Hosting:** Manus WebDev (unchanged by cutover)

The Power Queue shows every agent their leads in the 1–20 day stale window, sorted with the most urgent first. It fetches all leads by paginating through FUB's full API using cursor-based pagination. Leads are split into two tiers:

- **Priority Tier (Day 14–20):** Shown at the top with a fire badge. These are the leads the agent absolutely must text today.
- **Available Tier (Day 1–13):** Shown after the priority leads.

The dashboard also receives health observations from all agent bots via a secure API (`/api/healer/observations`).

---

## System 3 — Lifestyle Bot Dashboard (Agent Bots)

**URL:** `lifestyledash-wpnl8v84.manus.space`
**Hosting:** Manus WebDev (unchanged by cutover)

Runs one AI bot per agent, driven by the `agent_bots` registry table. The original agents run via their per-agent bot files; newer agents (e.g. Jason) run on the data-driven engine (`engineActive=true`) — adding an agent needs no code change. Each bot sends up to 15 lifestyle emails per run. The emails are AI-written, reference the lead's most recent FUB note, and are personalized to each lead's context.

---

## System 4 — Nightly Health Report (4am CT)

**Runs at: 4:00 AM CT every day (Nightly Health workflow on GitHub Actions)**
**Recipients:** peter@lifestyledesignrealty.com, steven@lifestyledesignrealty.com

This script is the watchdog for the entire stack. Every morning it:

1. Reads the SQLite database for any Python automation errors from the last 24 hours.
2. Calls the Lifestyle Bot Dashboard API to get the run status and any errors from all agent bots.
3. Runs auto-fix logic on known fixable errors.
4. Scans FUB Email Marketing Events API (`/v1/emEvents`) for bounces and unsubscribes.
5. Scans inbound text messages for opt-out language.
6. Builds and sends an HTML email report.
7. Posts a heartbeat to the FUB Nurture Dashboard confirming the healer ran.

---

## All Rules at a Glance

### Lead Suppression Rules (Python Pond Nurture)

| Rule | Detail |
| --- | --- |
| LLM skip (intent A) | Lead is no longer a buyer |
| LLM skip (intent B) | Working with another agent |
| LLM skip (intent C) | Asked not to be contacted |
| LLM skip (intent D) | Relocated permanently |
| LLM confidence < 80% | Ambiguous notes → default to send |
| 3-day contact gap | Any bot or script contacted this lead in the last 3 days |
| Stage: Trash | Always excluded |
| Tags | All 20 shared suppression tags (see `config/suppression_tags.json`) |
| No email address | Cannot send |
| 14-day cadence | Already emailed within last 14 days |

### Timing Rules

| Rule | Value |
| --- | --- |
| Agent window | Day 1 through Day 20 |
| Priority zone | Day 14 through Day 20 |
| Pond reassignment trigger | 20+ days no activity |
| Pond nurture cadence | Every 14 days (engagement-based: 10/14/21 days) |
| 3-day contact gap | 3 days between any bot contact |
| Daily email cap (pond nurture) | 100 per run |
| Daily reassignment cap | 100 per run |
| Bot daily send cap | 15 emails per bot per run |

---

## How the Pieces Connect

```
FUB (Follow Up Boss)
       │
       ├─── GitHub Actions (5 workflows) ─────────────────────────────────────────┐
       │         Daily Automation: Pond nurture + agent digests + reassignment     │
       │         Speed-to-Lead: 30/60 min timer (every 5 min, business hours)     │
       │         Reply Detection: Hot-lead alerts (every 10 min)                  │
       │         Nightly Health: 4am audit + auto-fix + bounce/unsub detection    │
       │         Weekly Digest: Monday 8am performance summary                    │
       │         State: encrypted SQLite on 'state' branch                        │
       │                                                                           │
       ├─── Lifestyle Bot Dashboard (daily, N bots) ──────────────────────────────┤
       │         Each bot sends up to 15 lifestyle emails per day                 │
       │         Writes run_start / run_complete / bot_crash → bot_observations   │
       │         Hosting: Manus WebDev (lifestyledash-wpnl8v84.manus.space)       │
       │                                                                           │
       ├─── FUB Nurture Dashboard (live, agent-facing) ───────────────────────────┤
       │         Power Queue: agents text day 1–20 leads                          │
       │         Receives bot observations via /api/healer/observations            │
       │         Hosting: Manus WebDev (fub-nurture-phfprjui.manus.space)         │
       │                                                                           │
       └─── Nightly Health (GitHub Actions, 4am CT) ──────────────────────────────┘
                 Reads SQLite (Python errors) + bot_observations (bot errors)
                 Auto-fixes known issues
                 Emails Peter + Steven
                 Posts heartbeat to FUB Nurture Dashboard
```

---

## Migration History

| Date | Event |
| --- | --- |
| 2026-07-12 | Code migrated from Cloud Computer 2 to GitHub repo (dry-run mode) |
| 2026-07-13 | All 5 workflows verified green in dry-run mode |
| 2026-07-13 | PII scrubbed from all log output (commit `c282bde`) |
| 2026-07-13 | Missing `sms_helpers.py` migrated (commit `fd3a7b0`) |
| 2026-07-13 | Anthropic API key + `claude-sonnet-4-6` model confirmed working |
| 2026-07-13 | Cloud Computer 2 crons disabled, port 8080 stopped |
| 2026-07-13 | DRY_RUN flipped to false — **system is LIVE on GitHub Actions** |
| 2026-07-13 | Speed-to-Lead and Reply Detection verified with real writes |
| 2026-07-13 | Bounce/unsub detection fixed: `/v1/emails` → `/v1/emEvents` |

---

## What Is Currently Disabled

| Feature | Status | Reason |
| --- | --- | --- |
| SMS/text outreach (Python) | Disabled | Owner request — agents text manually via Power Queue |
| Email sending from agent addresses | Disabled | All emails send from `peter@lifestyledesignrealty.com` |
| Speed-to-Lead 30/60 reassignment | Monitoring only | Awaiting Peter's separate approval |

---

## Agents

| Agent | Email | Role |
| --- | --- | --- |
| Peter Allen | peter@lifestyledesignrealty.com | Broker / Owner |
| Steven | steven@lifestyledesignrealty.com | Agent |
| Tiffany | tiffany@lifestyledesignrealty.com | Agent |
| Stefanie | stefanie@lifestyledesignrealty.com | Agent |
| Abby | abby@lifestyledesignrealty.com | Agent |
| Irma | irma@lifestyledesignrealty.com | Agent |
| Laila | laila@lifestyledesignrealty.com | Agent |

---

## Target Markets

San Antonio · New Braunfels · Austin · Dallas · Fort Worth · Houston

---

*This README is the single source of truth for the LDR automation stack. Any new task or agent working on this system should read this document first.*
