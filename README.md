# LDR Database Hygiene & Nurture System

> 🚧 **CODE SNAPSHOT** — live system runs on Cloud Computer 2 + Manus (fubdash-bkyqff6t.manus.space, lifestyledash-wpnl8v84.manus.space). Not yet deployable from this repo.

**Lifestyle Design Realty | Last updated: June 17, 2026**

---

## What This System Does (Plain English)

This is a fully automated real estate follow-up machine. It watches every lead in Follow Up Boss (FUB), figures out who needs to hear from the team and when, and either sends an email automatically or puts the right lead in front of the right agent at the right time. It runs every day without anyone touching it. If something breaks, it fixes itself or sends a report explaining exactly what went wrong.

There are **four connected pieces** to this system:

| Piece | What It Is | Where It Lives |
| --- | --- | --- |
| **Python Automation DONT NEED BECAUSE AGENT BOTS EMAIL THE AGENTS LEADS AND LIFEESTYLE BOT NURTURES POND LEADS** | Sends pond nurture emails + agent digest emails every morning | Cloud Computer 2 (`/home/ubuntu/fub_automation/`) |
| **FUB Nurture Dashboard** | Web dashboard for the Power Queue (agents text leads) + health monitoring | Manus WebDev: `fub-nurture-phfprjui.manus.space` |
| **Lifestyle Bot Dashboard** | Runs 7 AI bots that send lifestyle emails to all assigned leads | Manus WebDev: `lifestyledash-wpnl8v84.manus.space` |
| **Nightly Health Report** | 4am email that checks every system and auto-fixes known errors | Cloud Computer 2 (`nightly_health.py`) |

---

## The Lead Journey — Start to Finish

Think of every lead like a person walking through a funnel. Here is exactly what happens to them at each stage:

**Day 0 — New Lead Arrives in FUB DONT FORGET 30-60 MINUTE RULE**The lead is assigned to an agent. Nothing automated happens yet — the agent is expected to reach out personally within the first 30 MINUTES THEYRE NOTIFIED AND 60 MIN REASIGN LEAD BACK TO PETER

**Day 1 through Day 13 — Agent's Window**The lead belongs to the agent. Every morning, the agent gets a digest email listing all their leads that need attention, with a Click-to-Text link for each one. Clicking the link opens a pre-written iMessage on the agent's phone — they just tap Send. The agent can also open the Power Queue on the dashboard and work through their leads in order.

**Day 14 through Day 20 — Priority Zone (Agent Must Act)**These leads are now flagged as "Priority" in the Power Queue. They appear at the top of the agent's queue, sorted most-overdue first (day 20 before day 19). The agent should text these leads before touching any day 1–13 leads. If the agent does not act, the lead is about to fall into the pond.

**Day 21+ — Lead Falls into the Pond (Lifestyle Bot Takes Over)**Once a lead has had no activity for 20+ days, the Python automation reassigns it to the **Lead Pond** (FUB Pond ID 2). From this point on, the agent no longer manages this lead. The Lifestyle Bot Dashboard's bots take over and send AI-written lifestyle emails every 14 days indefinitely. The agent is off the hook.

**Pond Lead — Every 14 Days Forever**The Pond Nurture bot (Python, runs at 8am CT) emails every pond lead every 14 days. The email is written by AI, references the lead's most recent FUB note, uses a dynamic subject line, and feels like a natural continuation of the last conversation — not a generic blast. I WANT THE EMAILS TO BE TAYLORED TO THAT PERSON FOR BEST RENGAGMENT PERFORMANCE

---

## System 1 — Python Automation (Cloud Computer 2)

**Runs at: 8:00 AM CT every day****Entry point:** `/home/ubuntu/fub_automation/run_approved_daily_automation.py`

This script does two things every morning:

### Phase 1 — Agent Digest Emails PINTLESS BECAUSE BOTS DO THIS BETTER

~~For every agent (Peter, Steven, Tiffany, Stefanie, Abby, Irma, Laila), the script pulls all their leads from FUB that are 1–20 days stale and builds a personalized digest email. Each lead in the email has a Click-to-Text link. Clicking it opens a pre-written iMessage on the agent's phone. Peter is CC'd on every digest. Daily cap: 100 emails per run.  ~~

### Phase 2 — Pond Nurture Emails

For every lead sitting in the Lead Pond, the script checks if it has been 14+ days since the last email. If yes, it goes through five checks before sending:

1. **LLM Skip Check** — The AI reads all of the lead's FUB notes and decides (using intent reasoning, not keywords) whether the lead should be skipped. It looks for four intent categories: (A) no longer a buyer, (B) working with someone else, (C) asked not to be contacted, (D) relocated permanently. The AI must be 80%+ confident to skip. If it skips, it writes a note in FUB explaining why.

1. **3-Day Contact Gap** — If any bot or the Python script contacted this lead within the last 3 days, skip silently (no FUB note).

1. **Stage/Tag Suppression** — Leads in Trash, or tagged "Do Not Contact," "Do Not Email," "No AI Email," "Manual Review," "bounced," "unsubscribe," or "email opt out" are skipped.

1. **Email Channel Check** — Lead must have a valid email address.

1. **14-Day Cadence** — Lead must not have received a pond nurture email in the last 14 days.

If all five checks pass, the AI writes a personalized email that:

- References the lead's most recent FUB note directly

- Uses a dynamic subject line specific to the lead's context (never "Checking in")

- Opens with exactly one greeting line using first name only (e.g., "Hey Matthew,")

- Never ends with a question about automating the agent's workflow

- Comes from `peter@lifestyledesignrealty.com`

After sending, a note is written in FUB and the send is logged to the local SQLite database.

**Daily caps:** 100 pond nurture emails per run, 100 stale-agent reassignments per run.

### Phase 2 also handles Stale-Agent Reassignment

If a lead has been assigned to an agent for 20+ days with no qualifying note, it is automatically moved to the Lead Pond (Pond ID 2) and reassigned to Peter. This is what feeds the pond.

---

## System 2 — FUB Nurture Dashboard (Power Queue)

**URL:** `fub-nurture-phfprjui.manus.space`**Purpose:** Gives agents a clean, prioritized list of leads to text each day.

### The Power Queue

The Power Queue shows every agent their leads in the 1–20 day stale window, sorted with the most urgent first. It fetches all leads by paginating through FUB's full API (no 100-result cap — fixed June 17, 2026). Leads are split into two tiers:

- **Priority Tier (Day 14–20):** Shown at the top with a 🔥 badge. These are the leads the agent absolutely must text today before they fall into the pond.

- **Available Tier (Day 1–13):** Shown after the priority leads. Agent can text these at any time.

When an agent taps a lead in the queue, they can:

- Send a pre-written Click-to-Text (opens iMessage pre-filled)

- Log a call attempt

- Send a nurture email

The moment an agent acts on a lead, it is marked as done and disappears from the queue instantly. The "already texted today" record is stored in the database and survives page refreshes and server restarts.

### Health Monitoring

The dashboard also receives health observations from all 7 agent bots via a secure API (`/api/healer/observations`). It stores these in a `bot_observations` database table. The nightly healer reads this table every morning to build the health report.

---

## System 3 — Lifestyle Bot Dashboard (7 Agent Bots)

**URL:** `lifestyledash-wpnl8v84.manus.space`**Purpose:** Runs 7 AI bots that send lifestyle emails to every assigned lead, every day.

### The 7 Bots

| Bot | Agent | FUB User ID |
| --- | --- | --- |
| S&P500 / Lifestyle Bot | Peter | 2 |
| S&P500 Bot | Steven | (Steven's ID) |
| Tiffany Bot | Tiffany | 20 |
| Rue Bot | Stefanie | (Stefanie's ID) |
| Abby Bot | Abby | (Abby's ID) |
| Irma Bot | Irma | (Irma's ID) |
| Laila Bot | Laila | (Laila's ID) |

Each bot runs daily and sends up to 15 lifestyle emails per run. The emails are AI-written, reference the lead's most recent FUB note, and are personalized to each lead's context. Each bot writes a `run_start` and `run_complete` observation to the database so the nightly healer knows it ran.

### Bot Rules (Same as Pond Nurture)

- LLM skip check (intent-based, 80% confidence gate)

- 3-day contact gap check

- Stage/tag suppression

- Dynamic subject line

- Single clean greeting, first name only

---

## System 4 — Nightly Health Report (4am CT)

**Runs at: 4:00 AM CT every day (9:00 UTC)****Script:** `/home/ubuntu/fub_automation/nightly_health.py`**Recipients:** [peter@lifestyledesignrealty.com](mailto:peter@lifestyledesignrealty.com), [steven@lifestyledesignrealty.com](mailto:steven@lifestyledesignrealty.com)

This script is the watchdog for the entire stack. Every morning it:

1. **Reads the local SQLite database** for any Python automation errors from the last 24 hours.

1. **Calls the Lifestyle Bot Dashboard API** (`GET /api/healer/observations`) to get the run status and any errors from all 7 agent bots.

1. **Runs auto-fix logic** on known fixable errors (e.g., missing Python packages — installs them automatically).

1. **Handles bot crashes** — if a bot crashed with FUB's deep pagination error (`offset=2000`), it flags it with a clear note: "Code fix required — switch to nextLink cursor pagination." General crashes are acknowledged and cleared.

1. **Builds and sends an HTML email report** — either "All systems green ✅" or a detailed breakdown of every error with severity, source, and recommended action.

1. **Posts a heartbeat** to the FUB Nurture Dashboard (`POST /api/healer/write`) confirming the healer ran. This clears the botMonitor warning on the dashboard automatically.

---

## All Rules at a Glance

### Lead Suppression Rules (Python Pond Nurture)

A lead is skipped if any of the following are true:

| Rule | Detail |
| --- | --- |
| LLM skip (intent A) | Lead is no longer a buyer — bought elsewhere, under contract, gave up, "not ready for years" |
| LLM skip (intent B) | Working with another agent — signed with KW, cousin is a realtor, already has representation |
| LLM skip (intent C) | Asked not to be contacted — opt-out, seemed annoyed, "stop texting" |
| LLM skip (intent D) | Relocated permanently — moved out of state, no longer geographically relevant |
| LLM confidence < 80% | Ambiguous notes → default to send the email |
| 3-day contact gap | Any bot or script contacted this lead in the last 3 days |
| Stage: Trash | Always excluded |
| Tags | "Do Not Contact," "Do Not Email," "No AI Email," "Manual Review," "bounced," "unsubscribe," "email opt out," "realtor," "dnc," "do not nurture" |
| No email address | Cannot send |
| 14-day cadence | Already emailed within last 14 days |

### Power Queue Exclusion Rules

A lead is excluded from the Power Queue if:

| Rule | Detail |
| --- | --- |
| Stage: Past Client, Closed, Active Client | Intentionally excluded |
| Tag: bounced | No point texting |
| No phone number | Nothing to text |
| Already texted today | Marked done, removed from queue instantly |
| Day 0 or Day 21+ | Outside the 1–20 day agent window |

### Timing Rules

| Rule | Value |
| --- | --- |
| Agent window | Day 1 through Day 20 |
| Priority zone | Day 14 through Day 20 |
| Pond reassignment trigger | 20+ days no activity |
| Pond nurture cadence | Every 14 days |
| 3-day contact gap | 3 days between any bot contact |
| Daily email cap (pond nurture) | 100 per run |
| Daily reassignment cap | 100 per run |
| Bot daily send cap | 15 emails per bot per run |

---

## How the Pieces Connect

```
FUB (Follow Up Boss)
       │
       ├─── Python Automation (8am CT) ──────────────────────────────────────────┐
       │         Phase 1: Agent digest emails with Click-to-Text links            │
       │         Phase 2: Pond nurture emails (14-day cadence)                    │
       │         Phase 2: Stale-agent reassignment to Lead Pond (20+ days)        │
       │         Writes audit log → SQLite DB on Cloud Computer 2                 │
       │                                                                           │
       ├─── Lifestyle Bot Dashboard (daily, 7 bots) ──────────────────────────────┤
       │         Each bot sends up to 15 lifestyle emails per day                 │
       │         Writes run_start / run_complete / bot_crash → bot_observations   │
       │                                                                           │
       ├─── FUB Nurture Dashboard (live, agent-facing) ───────────────────────────┤
       │         Power Queue: agents text day 1–20 leads                          │
       │         Receives bot observations via /api/healer/observations            │
       │         Stores smsSentToday in database                                  │
       │                                                                           │
       └─── Nightly Health Report (4am CT) ───────────────────────────────────────┘
                 Reads SQLite (Python errors) + bot_observations (bot errors)
                 Auto-fixes known issues
                 Emails Peter + Steven
                 Posts heartbeat to FUB Nurture Dashboard
```

---

## Environment Variables (Cloud Computer 2)

All secrets live in `/home/ubuntu/fub_automation/.env`. Never commit this file.

| Variable | Purpose |
| --- | --- |
| `FUB_API_KEY` | Follow Up Boss API key |
| `OPENAI_API_KEY` | OpenAI key for LLM email generation |
| `OPENAI_BASE_URL` | OpenAI-compatible endpoint base URL |
| `SMTP_HOST / SMTP_USER / SMTP_PASSWORD / SMTP_PORT` | Email sending credentials |
| `DASHBOARD_URL` | Lifestyle Bot Dashboard URL (`https://lifestyledash-wpnl8v84.manus.space` ) |
| `FUB_NURTURE_URL` | FUB Nurture Dashboard URL (`https://fubdash-bkyqff6t.manus.space` ) |
| `HEALER_SECRET` | Shared token for `/api/healer/observations` and `/api/healer/write` |

---

## Key File Locations

| File | Purpose |
| --- | --- |
| `/home/ubuntu/fub_automation/src/fub_automation/main.py` | Core pond nurture + agent digest logic |
| `/home/ubuntu/fub_automation/src/fub_automation/sms_helpers.py` | SMS body generation helpers |
| `/home/ubuntu/fub_automation/config/rules.yaml` | All business rules (stages, tags, caps, cadence) |
| `/home/ubuntu/fub_automation/data/fub_automation.sqlite3` | Audit log + reengagement history |
| `/home/ubuntu/fub_automation/nightly_health.py` | 4am health report + auto-fix |
| `/home/ubuntu/fub_automation/run_approved_daily_automation.py` | Daily automation entry point |
| `fub_nurture_dashboard/server/dashboardData.ts` | Power Queue logic (paginated FUB fetch) |
| `fub_nurture_dashboard/server/nightlyHealer.ts` | Dashboard-side healer (bot crash handling) |
| `fub_nurture_dashboard/server/routers.ts` | All tRPC API procedures |

---

## Scheduled Tasks (Manus)

| Task Name | Schedule | What It Does |
| --- | --- | --- |
| FUB approved daily automation: Phase 1 + Phase 2 | 8:00 AM CT | Agent digests + pond nurture emails |
| LDR Unified 4am Morning Health Report (UID: `OGkdIqCfyKfol8rPzVVaV1`) | 4:00 AM CT | Health check + auto-fix + email report |

---

## What Is Currently Disabled

The following features exist in the codebase but are turned off by owner decision:

| Feature | Status | Reason |
| --- | --- | --- |
| SMS/text outreach (Python) | Disabled | Owner request — agents text manually via Power Queue |
| New-lead 30/60-min workflow | Disabled | Not yet activated |
| Email sending from agent addresses | Disabled | All emails send from `peter@lifestyledesignrealty.com` |

---

## Agents

| Agent | Email | Role |
| --- | --- | --- |
| Peter Allen | [peter@lifestyledesignrealty.com](mailto:peter@lifestyledesignrealty.com) | Broker / Owner |
| Steven | [steven@lifestyledesignrealty.com](mailto:steven@lifestyledesignrealty.com) | Agent |
| Tiffany | [tiffany@lifestyledesignrealty.com](mailto:tiffany@lifestyledesignrealty.com) | Agent |
| Stefanie | [stefanie@lifestyledesignrealty.com](mailto:stefanie@lifestyledesignrealty.com) | Agent |
| Abby | [abby@lifestyledesignrealty.com](mailto:abby@lifestyledesignrealty.com) | Agent |
| Irma | [irma@lifestyledesignrealty.com](mailto:irma@lifestyledesignrealty.com) | Agent |
| Laila | [laila@lifestyledesignrealty.com](mailto:laila@lifestyledesignrealty.com) | Agent |

---

## Target Markets

San Antonio · New Braunfels · Austin · Dallas · Fort Worth · Houston

---

*This README is the single source of truth for the LDR automation stack. Any new task or agent working on this system should read this document first.*

