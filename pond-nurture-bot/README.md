# Follow Up Boss Automation Starter

**Author:** Manus AI  
**Purpose:** Automate stale-lead re-engagement, agent follow-up accountability, and new-lead speed-to-lead reassignment in Follow Up Boss.

## What This Project Does

This starter service implements the core automation logic requested by the owner. It scans Follow Up Boss for stale, pond, unresponsive, and no-contact leads; uses OpenAI to draft local-market re-engagement messages; creates Follow Up Boss tasks when assigned agents have not followed up; and monitors new leads so the assigned agent receives a thirty-minute warning before the lead is reassigned to Peter Allen at the one-hour mark.

The code is intentionally designed to run first in **dry-run mode**. Dry-run mode logs what would happen without sending messages or modifying real contacts. This is important because the system needs the account's exact Follow Up Boss stages, tags, ponds, Peter Allen user ID, consent tags, and sending provider credentials before it should be turned on live.

## Important Limitation

Follow Up Boss's public API can log externally sent text messages, but its text-message endpoint does not actually send SMS. For real text delivery, connect a compliant SMS provider such as Twilio, SimpleTexting, or another approved provider, then log the sent message back to Follow Up Boss. Email delivery similarly needs an SMTP or email marketing provider unless the workflow is rebuilt around native Follow Up Boss automations.

## Files

| File | Purpose |
| --- | --- |
| `src/fub_automation/main.py` | Main FastAPI service, scheduler, Follow Up Boss API client, rule engine, OpenAI content generator, email/SMS senders, webhook handler, and SQLite audit log. |
| `config/rules.yaml` | Editable business rules for stages, tags, timing, Peter Allen reassignment, compliance suppression, and target cities. |
| `config/market_context.json` | City-specific market facts used to ground AI-generated re-engagement copy. |
| `.env.example` | Environment variable template for FUB, OpenAI, SMTP, and Twilio credentials. |
| `requirements.txt` | Python dependencies. |

## Setup

Run these commands from the project folder:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Then edit `.env` and `config/rules.yaml` with real values. Keep `DRY_RUN=true` until testing is complete.

## Run Locally

```bash
source .venv/bin/activate
set -a
source .env
set +a
uvicorn fub_automation.main:app --host 0.0.0.0 --port 8080 --reload
```

Health check:

```bash
curl http://localhost:8080/health
```

Manually trigger daily scans:

```bash
curl -X POST http://localhost:8080/jobs/daily-scans
```

Manually trigger new-lead timer checks:

```bash
curl -X POST http://localhost:8080/jobs/new-lead-timers
```

## Follow Up Boss Webhook Setup

Once the service is hosted at a public HTTPS URL, register Follow Up Boss webhooks pointing to:

```text
https://your-domain.example.com/webhooks/fub
```

Recommended webhook events are:

| Event | Reason |
| --- | --- |
| `peopleCreated` | Starts the thirty-minute and sixty-minute new-lead timer. |
| `peopleUpdated` | Helps detect assignment/contact changes. |
| `callsCreated` | Cancels reassignment when the agent calls. |
| `emailsCreated` | Cancels reassignment when the agent emails. |
| `textMessagesCreated` | Cancels reassignment when the agent texts. |
| `notesCreated` | Cancels reassignment when the agent records a meaningful touch. |
| `tasksCreated` | Optional activity signal depending on how your team uses FUB. |

## Live Deployment Checklist

Before changing `DRY_RUN=false`, confirm each item below.

| Item | Status |
| --- | --- |
| Owner/admin FUB API key is configured. | Needed |
| FUB registered system name and key are configured. | Needed for webhooks and registered-system logging endpoints. |
| Peter Allen's exact FUB user ID is entered as `peter_user_id`. | Needed for reliable reassignment. |
| Stale, unresponsive, excluded, SMS consent, and opt-out tags match the real account. | Needed |
| Sending provider is configured and tested. | Needed |
| Valid physical mailing address is added to `company_address`. | Needed for marketing email compliance. |
| Market context is populated with verified facts for each target city. | Recommended |
| Dry-run logs have been reviewed by the owner. | Required before live mode. |

## How the Main Rules Work

The stale-lead workflow runs once daily and looks for contacts whose `lastCommunication` is older than the configured thirty-day threshold. The rule engine then suppresses excluded stages and tags, checks the fourteen-day cadence cap, generates content, sends through approved channels, adds a note in Follow Up Boss, and records the action in SQLite.

The assigned-agent accountability workflow also runs daily. If an assigned lead has had no communication for more than fourteen days and is not in a pond or excluded stage, the service creates a Follow Up Boss task assigned to the agent. The task due time and reminder are designed to produce in-FUB notification behavior.

The new-lead workflow starts from the `peopleCreated` webhook. The service stores a timer, checks after thirty minutes, creates an urgent Follow Up Boss task if untouched, checks again after sixty minutes, and reassigns to Peter Allen if still untouched.

## Compliance Reminder

This project includes suppression hooks for opt-outs, SMS consent, and excluded contact tags, but it is not legal advice. The owner should confirm TCPA, DNC, CAN-SPAM, state law, brokerage policy, and platform-provider requirements before sending automated outreach. In particular, SMS should only be sent where documented consent exists, and commercial email must include truthful sender information, a valid postal address, and an opt-out mechanism.
