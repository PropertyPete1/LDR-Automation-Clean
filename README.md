# LDR Database Hygiene & Nurture System

> 🚧 **CODE SNAPSHOT** — live system runs on Cloud Computer 2 + Manus (fubdash-bkyqff6t.manus.space, lifestyledash-wpnl8v84.manus.space). Not yet deployable from this repo.

**Lifestyle Design Realty | Last updated: July 12, 2026 (Tier 3)**

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

## Recently Activated Features (July 2026)

### Speed-to-Lead — 0/30/60-Minute Timer (LIVE)

When a new lead is created in FUB and assigned to an agent, a countdown begins:

| Timer | Action |
| --- | --- |
| Minute 0 | Agent receives alert email with lead details + green "Tap to Text" button. Peter CC'd. |
| Minute 30 | If no qualifying activity (call, text, email, or note by agent): FUB @mention warning note + urgent Call task created for the agent. |
| Minute 60 | If still no activity: lead reassigned to Peter (user ID 2), FUB note logged, Peter notified by email, lead tagged `auto-reassigned-speed-to-lead`. |

**Implementation details:**
- Scheduler jobs: `poll_new_leads` (every 5 min) and `process_new_lead_timers` (every 5 min)
- Business-hours aware: only counts minutes during 10 AM – 6 PM CT (America/Chicago)
- Touch detection: checks `lastSentEmail`, `lastSentText`, `lastCall`, and human-authored FUB notes
- Database: timer records stored in `new_lead_timers` table (SQLite)
- Acceptance test passed July 12, 2026: all 3 stages fired correctly (~3 min alert, ~32 min warning, ~62 min reassignment)

### Reply Detection + Hot Lead Alert (LIVE)

Detects when any lead that received a bot email replies by email or text:

| Trigger | Action |
| --- | --- |
| Reply detected | Lead tagged `Replied - Paused` — suppresses ALL bot cadences |
| Notification | Owning agent emailed immediately (pond leads → Peter) |
| FUB note | "Lead replied on [date] — bots paused, follow up personally" |

**Implementation details:**
- Scheduler job: `scan_reply_detection` (every 10 min)
- Suppression scope: pond nurture bot + all 7 agent bots (via `hasDncTag()` in `botHelpers.ts`)
- Resume: human removes the `Replied - Paused` tag to re-enable automation
- Cap: 20 alerts per scan to avoid flooding
- Acceptance test passed: suppression check verified in every bot's skip logic

### Cursor-Based Pagination (LIVE)

All FUB API fetches (`get_people()` in Python, `fubGetPeople()` in TypeScript) use cursor-based `_metadata.next` pagination. The previous offset-based approach crashed at offset > 2000 when FUB disabled deep pagination. The system now reliably pages through 4,400+ leads without error.

**Fixed in:** Python `main.py`, TypeScript `dashboardData.ts` / `pondNurture.ts`

### Note-Write Verification (LIVE)

The nightly healer (4am CT) now compares emails logged as "sent" in the SQLite audit log (last 24h) against FUB notes actually written for those sends. Any send missing its note = integrity error reported in the 4am email with lead ID + bot name. This prevents "invisible contacts" where a bot emailed a lead but the note was lost, making the contact invisible to other bots reading FUB notes.

**Implementation details:**
- Stage 2.5a in `nightly_health.py`
- Checks all note-backed actions: pond_nurture, closed_congrats, closed_drip, long_term_nurture_drip, agent_reminder_digest, instant_welcome_email
- Caps at 50 leads per run to respect FUB rate limits
- Reports in 4am email under "NOTE-WRITE INTEGRITY ERRORS" section
- Acceptance test passed: simulated send-without-note correctly flagged

### Bounce & Unsubscribe Auto-Tagging (LIVE)

Detects hard bounces and unsubscribe/opt-out replies across all bot email. Zero tolerance — any plausible opt-out counts.

| Signal | Action |
| --- | --- |
| Hard bounce detected | Tag `bounced` + FUB note |
| Opt-out language (email or text) | Tag `unsubscribe` + FUB note |
| Daily counts | Reported in 4am email |

**Implementation details:**
- Stage 2.5b in `nightly_health.py`
- Scans FUB emails (last 24h) for bounce indicators (delivery failure, 550 errors, etc.)
- Scans inbound emails + texts for opt-out language (unsubscribe, stop, remove me, etc.)
- Both tags are in the shared suppression list — leads are permanently excluded from all bots
- Acceptance test passed: simulated bounce and unsubscribe both correctly tagged

### Dead-Man's Switch — healthchecks.io (LIVE)

If the nightly health system or daily automation stops running, healthchecks.io emails peter@lifestyledesignrealty.com automatically.

| Check | Expected Schedule | Grace Period |
| --- | --- | --- |
| `ldr-nightly-health` | Every 25 hours (4am CT) | 2 hours |
| `ldr-daily-automation` | Every 25 hours (7am CT) | 2 hours |

**Implementation details:**
- Config: `config/healthchecks.json` (slug-based auto-provisioning with `create=1`)
- Ping at END of successful run only — if the run crashes, no ping = alert
- `ping_healthcheck()` in `nightly_health.py`, `_ping_healthcheck_daily()` in `run_approved_daily_automation.py`
- Setup: create free healthchecks.io account, set ping_key in config, checks auto-create on first ping
- Acceptance test passed: ping function correctly targets healthchecks.io endpoints

### Shared Suppression List (LIVE)

Single source of truth for all suppression tags, readable by both the Python bot and TypeScript dashboard. Adding a tag in one place protects leads everywhere.

**Source file:** `config/suppression_tags.json` (20 tags)

**How it works:**
- Python: `Rules.load()` merges shared tags into `excluded_tags` on startup
- TypeScript: `getSharedSuppressionTags()` in `botHelpers.ts` reads from the same JSON file
- Both systems check the same list — no hardcoded duplicates
- Fallback: dashboard keeps a copy at `lifestyle-bot-dashboard/config/suppression_tags.json`

**Current tags:** do not contact, do not email, do not nurture, no ai email, manual review, opt-out, opted-out, email opt out, unsubscribed, unsubscribe, dnc, do-not-contact, bot_suppress, trash, trashed, deceased, wrong number, wrong person, bounced, opt-out-auto-trash

**Acceptance test passed:** Added test tag to shared list, verified Python pond bot AND TypeScript agent bots both skip leads carrying it, then removed it.

### Engagement-Based Cadence (LIVE)

Pond nurture emails now use dynamic cadence based on lead engagement level:

| Tier | Cadence | Criteria |
| --- | --- | --- |
| Engaged | 10 days | Any inbound activity (email reply, text, call) within last 60 days |
| Standard | 14 days | Last inbound activity 61–90 days ago |
| Cold | 21 days | No inbound activity in 90+ days (or never) |

**Data source:** FUB person fields `lastReceivedEmail`, `lastReceivedText`, `lastIncomingCall` (replies + inbound activity as engagement signal — FUB API does not expose email open/click tracking per lead).

**Implementation details:**
- `classify_engagement_tier()` method in main.py — called before cadence check in `process_reengagement_candidate()`
- Tier stored in `engagement_tier` SQLite table (person_id, tier, last_classified_at, reason)
- Tier counts reported in 4am email under "ENGAGEMENT TIERS" section
- No change to existing safety rails: 3-day contact gap and 100-email cap still enforced
- Acceptance test passed: 3 sample leads classified into 3 tiers correctly (engaged=10d, standard=14d, cold=21d)

### Deeper Email Personalization (LIVE)

Pond nurture AI prompt now receives expanded context for smarter, more tailored emails:

| Input | Source |
| --- | --- |
| Full note history (up to 20 notes) | FUB notes API |
| Lead source | FUB person `source` field |
| Price range | FUB person `priceRange` field |
| City/market | FUB addresses |
| Days in pond | Calculated from `created` date |
| Engagement tier | Feature 1 classification |

**Angle rotation:** Emails cycle through 6 angles (market update, neighborhood fit, rates/payment, new construction, lifestyle/restaurants, home-search strategy). The system never repeats the same angle twice in a row per lead — tracked in `email_angle_log` SQLite table.

**Implementation details:**
- `ContentGenerator.generate()` accepts new kwargs: `engagement_tier`, `full_note_history`, `last_angle_used`
- Angle selection uses deterministic hash + rotation if last angle matches
- `upsert_email_angle()` / `get_last_email_angle()` in AuditDB
- Email signature and styling unchanged
- Acceptance test passed: 2 sample emails for same lead show different angles and use of note history

### Weekly Performance Digest (LIVE — Mondays 8am CT)

Peter receives a weekly summary email every Monday at 8am CT:

| Section | Contents |
| --- | --- |
| Email Sends | Per-bot breakdown + total, vs last week |
| Engagement | Replies detected, hot-lead alerts fired |
| Speed-to-Lead | New leads, 60-min misses (by agent) |
| Compliance | Bounces, unsubscribes |
| Pond Status | Pond size, leads reassigned |
| Engagement Tiers | Engaged/Standard/Cold counts |
| Best-Send-Time | Reply-time data points collected |

**Implementation details:**
- New file: `weekly_digest.py` (standalone script)
- Cron: `0 8 * * 1` (Monday 8am CT) in `setup_crons.sh`
- Queries `audit_log`, `new_lead_timers`, `engagement_tier`, `reply_time_log` tables
- HTML email with color-coded deltas (green ▲ / red ▼) vs previous week
- Acceptance test passed: digest generated from sample DB data with all key sections

### Best-Send-Time Logging (LIVE — Foundation Only)

Every detected reply now logs the hour-of-day and day-of-week (CT timezone) to build a dataset for future send-window optimization.

**Implementation details:**
- New SQLite table: `reply_time_log` (person_id, reply_hour 0-23, reply_day_of_week 0-6, detected_at)
- Logged in `scan_reply_detection()` when a reply is confirmed
- 4am report includes: "Reply-time data points collected: N"
- No behavior change yet — after 8+ weeks of data, we'll use it to shift send windows
- Acceptance test passed: 3 sample replies logged with correct hour/day values

---

## What Is Currently Disabled

The following features exist in the codebase but are turned off by owner decision:

| Feature | Status | Reason |
| --- | --- | --- |
| SMS/text outreach (Python) | Disabled | Owner request — agents text manually via Power Queue |
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

