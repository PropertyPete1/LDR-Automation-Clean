# Email-Only Follow Up Boss Automation: Go-Live Checklist

## Current Status

The Follow Up Boss automation has been revised to be **email-only**. Texting is disabled. Phase 1 is configured to send **internal agent follow-up reminder digests only**, with Peter copied at `peter@lifestyledesignrealty.com`. Customer re-engagement emails, new-lead warnings, and reassignment remain disabled until later approval. When customer re-engagement is eventually enabled, the system is configured to send from the assigned agent sender format of **first-name@lifestyledesignrealty.com**, such as `tiffany@lifestyledesignrealty.com`, assuming that mailbox or sending alias exists in Google Workspace; otherwise, it falls back to `peter@lifestyledesignrealty.com`.

The new-lead speed-to-lead workflow settings are staged but **not active**. The configured policy is a warning to the assigned agent after **30 business-time minutes** and reassignment to **Peter Allen**, Follow Up Boss user ID `2`, after **60 business-time minutes** if the lead has still not been touched. The timer counts only during **10:00 AM–6:00 PM Central Time**, seven days per week. Leads arriving after hours wait until the next business-hours window. The automation remains in dry-run/safe mode until explicitly deployed and activated.

## Revised Dry-Run Validation

The revised no-action scan completed successfully. It made **no live changes** to Follow Up Boss and did not send any emails. The scan reviewed 500 stale-contact candidates, 500 agent-follow-up candidates, and 2 recent leads.

| Dry-run metric | Count |
| --- | ---: |
| Proposed total actions | 849 |
| Agent follow-up reminders | 472 |
| Stale lead re-engagement emails | 377 |
| Suppressed candidates | 123 |
| Recent leads checked | 2 |

| Proposed action type | Live recommendation |
| --- | --- |
| Agent follow-up reminders | Safe to activate first after Gmail sending is connected. |
| New-lead 30-minute warnings | Deferred until the 5-day review. |
| New-lead 60-minute reassignment to Peter | Deferred until the 5-day review and final owner approval. |
| Customer re-engagement emails | Activate after confirming sender aliases and exclusion rules. |
| Texting | Disabled and should remain off. |

## Information Needed To Go Live

| Needed item | Required decision or credential |
| --- | --- |
| Gmail sending access | Connected using Google Workspace SMTP for `peter@lifestyledesignrealty.com`. |
| Peter sender mailbox | SMTP authentication tested successfully for `peter@lifestyledesignrealty.com`. |
| Agent sender aliases | Still confirm whether each agent has a real mailbox or authorized alias using `firstname@lifestyledesignrealty.com`; Phase 1 can start from Peter only if unsure. |
| Gmail authentication | Google App Password received and configured in the private local `.env` file. Do not include this file in shared packages. |
| CC rules | Confirmed for Phase 1: Peter should be CC'd on agent reminder digests. Customer outreach CC rules can be decided later. |
| Business hours | Confirmed: the 30/60-minute new-lead timer runs only during **10:00 AM–6:00 PM Central Time**, all days unless you later choose to exclude specific weekdays. |
| Excluded stages | Confirm whether **Active Client** should be excluded from stale customer re-engagement. Recommended: exclude Active Client from customer re-engagement, but allow internal agent reminders. |
| Bounced/invalid email handling | Confirm suppression of leads with bounced, unsubscribed, DNC, trash, or invalid-email indicators. Recommended: suppress them. |
| Deployment location | Confirm whether to run this on a durable server/scheduled environment. It should not rely on a one-off local terminal. |
| Final written approval | Confirm Phase 1 live activation after Gmail credentials are connected. New-lead warning/reassignment will be reviewed after five days. |

## Recommended First Live Phase

The safest first live phase is to enable **agent follow-up reminder emails only**. This immediately improves accountability and pipeline hygiene without sending customer-facing messages. After a few days of monitoring, the next phase should enable the **new-lead warning and Peter reassignment workflow**. Customer-facing market-update emails should come after sender aliases and suppression rules are confirmed.

## Recommended Live Order

| Phase | Workflow | Status |
| --- | --- | --- |
| 1 | Agent follow-up reminder digests by Gmail | Ready after Gmail auth. |
| 2 | 30-minute new-lead warning to assigned agent | Deferred until 5-day review. |
| 3 | 60-minute untouched-new-lead reassignment to Peter | Deferred until 5-day review and final approval. |
| 4 | Customer stale-lead market-update emails | Ready after alias and suppression confirmation. |
| 5 | SMS/text automation | Disabled by owner decision. |

## Exact Owner Approvals Needed

Before Phase 1 live activation, Gmail sending through `peter@lifestyledesignrealty.com` is now connected and SMTP authentication has passed. The remaining decisions are **final explicit approval to switch Phase 1 from dry-run to live**, **whether to send all Phase 1 reminders from Peter only or use verified agent aliases**, and **which agent `firstname@lifestyledesignrealty.com` aliases are valid senders** if alias-based sending is desired. Peter CC on agent reminders is already confirmed. New-lead warning/reassignment remains off until the 5-day review. The timer behavior is staged as **10:00 AM–6:00 PM Central Time**, seven days per week.

## Phase 1 Live Activation Update — 2026-06-03

The approved **email-only Phase 1** workflow has been activated for internal agent reminder digests. The first live run completed successfully from `peter@lifestyledesignrealty.com`. Gmail sent-mail verification confirmed eight reminder digest emails, one per active assigned agent group identified by the Follow Up Boss scan: Laila, Stefanie, Abby, Peter, Steven, Tiffany, Bebe, and Irma. Peter was copied on all non-Peter agent digests, and Peter’s own digest was sent directly to Peter without duplicating him in CC.

The active daily schedule is now set for **8:00 AM America/Chicago** with the title **FUB Phase 1 daily agent reminders**. The schedule instruction remains restricted to the Phase 1 runner and explicitly keeps customer re-engagement emails, SMS/texting, Follow Up Boss tasks/notes, new-lead warnings, and reassignment disabled unless Peter explicitly approves a later phase.

| Item | Status |
|---|---|
| Follow Up Boss API key recovered from prior local configuration and verified with read-only users endpoint | Complete |
| Google Workspace SMTP for Peter connected and authentication-tested | Complete |
| Dry-run preview of Phase 1 agent reminders | Complete |
| First live Phase 1 agent reminder run | Complete |
| Sent-mail verification for live reminder digests | Complete |
| Daily recurring schedule at 8:00 AM America/Chicago | Complete |
| Customer-facing emails/texts | Disabled |
| New-lead warning and reassignment | Disabled pending review |
| Five-day review reminder | Preserved inside the recurring daily schedule instructions |

No customer-facing outreach was sent, no SMS/text message was sent, no Follow Up Boss tasks or notes were created, and no lead reassignment was enabled during this activation.


## Personalized Agent Reminder Copy Update — 2026-06-03

After Peter confirmed that the first live emails worked but looked too automated, the Phase 1 agent reminder copy was revised to sound more like a daily personal note from Peter. The updated template now uses varied subject lines, varied opening language, stage summaries, varied action wording, and varied closing language based on the run date and assigned agent. The email now signs off simply as `Peter` instead of as an automation.

The explicit sentence saying that Peter is copied on the email was removed from the body. Peter can still be copied in the background on non-Peter agent digests, but the email no longer calls that out to the agent.

A forced dry-run preview was completed after the change. It generated 8 preview digests and did not send any new emails. Customer re-engagement emails, SMS/texting, new-lead warnings, Follow Up Boss tasks/notes, and reassignment remain disabled.
