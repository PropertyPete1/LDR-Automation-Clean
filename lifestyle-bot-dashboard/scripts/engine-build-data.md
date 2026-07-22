# Engine Build Data (saved for reference)

## Agent Registry Data (for agent_bots table seeding)

| Bot Slug | Bot Name | Agent First | Agent Last | Agent Email | FUB ID | Accent Color | Header Gradient | PQ Name | engine_active |
|----------|----------|-------------|------------|-------------|--------|--------------|-----------------|---------|---------------|
| sp500_peter | S&P500 Lifestyle Bot | Peter | Allen | Peter@lifestyledesignrealty.com | 2 | #1d4ed8 | linear-gradient(135deg,#1e3a5f 0%,#1d4ed8 60%,#3b82f6 100%) | Peter | false |
| sp500_steven | S&P500 Lifestyle Bot | Steven | Van Orden | Steven@lifestyledesignrealty.com | 1 | #1d4ed8 | linear-gradient(135deg,#1e3a5f 0%,#1d4ed8 60%,#3b82f6 100%) | Steven | false |
| tiffany | Tiffany's Lifestyle Bot | Tiffany | Proske | Tiffany@lifestyledesignrealty.com | 20 | #0d9488 | linear-gradient(135deg,#134e4a 0%,#0d9488 60%,#14b8a6 100%) | Tiffany | false |
| stefanie | Rue Lifestyle Bot | Rue |  | Stefanie@lifestyledesignrealty.com | 31 | #db2777 | linear-gradient(135deg,#831843 0%,#db2777 60%,#f472b6 100%) | Stefanie | false |
| abby | Abby's Lifestyle Bot | Abby | Martinez | Abby@lifestyledesignrealty.com | 28 | #7c3aed | linear-gradient(135deg,#3b0764 0%,#7c3aed 60%,#a78bfa 100%) | Abby | false |
| irma | Irma's Lifestyle Bot | Irma | Vidic Crisp | Irma@lifestyledesignrealty.com | 33 | #d97706 | linear-gradient(135deg,#78350f 0%,#d97706 60%,#fbbf24 100%) | Irma | false |
| laila | Laila's Lifestyle Bot | Laila | Maria | Laila@lifestyledesignrealty.com | 35 | #059669 | linear-gradient(135deg,#064e3b 0%,#059669 60%,#34d399 100%) | Laila | false |
| jason | Jason's Lifestyle Bot | Jason | Casanova | Jason@lifestyledesignrealty.com | 37 | #ea580c | linear-gradient(135deg,#431407 0%,#ea580c 60%,#fb923c 100%) | Jason | true |

## Key Architecture Decisions

1. **Staged cutover**: 6 existing bots stay hardcoded (engine_active=false), Jason runs on new engine (engine_active=true)
2. **Zero overlap**: Old bot files skip Jason's FUB ID (37), engine only processes engine_active=true agents
3. **SP bot is special**: It's a combined bot for Peter+Steven with split runs (sp-peter-run, sp-steven-run). In the engine, they'll be separate rows.
4. **Stefanie/Rue**: Bot name is "Rue Lifestyle Bot", agent first name is "Rue", but email is Stefanie@, FUB ID is 31 (Stefanie Graham). Power Queue uses "Stefanie".
5. **Intro email**: When introSentAt is NULL, send intro email THEN proceed with first clock-in. Set introSentAt after sending.
6. **All bots use**: sendClockinEmail, sendClockoffEmail, logBotRun, writeObservation from botHelpers.ts
7. **Run pattern**: fetchLeadsForAgent(fubId) → filter isEligible → shouldSkipLead → wasContactedRecently → generateFollowUpMessage → sendLeadFollowUpEmail → postFubNote → logContactedLead → recordSmsSentToday
8. **MAX_LEADS_PER_RUN**: Shared constant from botHelpers.ts

## Scheduled Endpoints Pattern
- Clock-in: POST /api/scheduled/{slug}-clockin (10:00am CT)
- Run: POST /api/scheduled/{slug}-run (10:05am CT)
- Clock-off: POST /api/scheduled/{slug}-clockoff (6:00pm CT)
- All require sdk.authenticateRequest (cron-only)

## Engine Endpoints (new)
- POST /api/scheduled/engine-clockin → iterates engine_active agents, sends clock-in for each
- POST /api/scheduled/engine-run → iterates engine_active agents, runs follow-ups for each
- POST /api/scheduled/engine-clockoff → iterates engine_active agents, sends clock-off for each

## Intro Email Pattern
- Uses sendBotIntroEmail(botSlug) from botHelpers.ts
- Existing function uses BOT_INTRO_COPY[botSlug] — hardcoded copy per bot
- For new data-driven agents: generate intro copy dynamically or use a generic template with agent-specific details

## FUB API Access
- Sandbox is geo-blocked from FUB API (CloudFront)
- Live deployed server CAN reach FUB API
- fubUsers endpoint already exists at agentRegistry.fubUsers (public procedure)
