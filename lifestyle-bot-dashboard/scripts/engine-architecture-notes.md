# Engine Architecture Notes (saved for context preservation)

## Key Function Signatures from botHelpers.ts

### sendClockinEmail(opts)
```ts
export async function sendClockinEmail(opts: {
  botName: string;
  agentFirstName: string;
  agentLastName: string;
  agentEmail: string;
  leadsQueued: number;
  powerQueueCount?: number;
  accentColor?: string;
  headerGradient?: string;
}): Promise<void>
```
- Uses OLD_DASHBOARD_BASE for Power Queue links, NEW_DASHBOARD_BASE for dashboard links
- POWER_QUEUE_AGENT_NAME map and AGENT_DASHBOARD_SLUG map are used for link building
- LEADER_AGENTS = Set(["peter", "steven", "stefanie", "rue"]) — they see / instead of /agent/:slug

### sendClockoffEmail(opts)
```ts
export async function sendClockoffEmail(opts: {
  botName: string;
  agentFirstName: string;
  agentLastName: string;
  agentEmail: string;
  sent: number;
  errored: number;
  skipped: number;
  timelineAdjusted?: number;
  avgWindowDaysOut?: number;
  accentColor?: string;
  headerGradient?: string;
}): Promise<void>
```

### Other key helpers used by bots:
- `fetchLeadsForAgent(agentFubId: number): Promise<FubPerson[]>` — cursor-paginated
- `isEligible(person: FubPerson): boolean` — 3-19 day window check
- `shouldSkipLead(person: FubPerson): Promise<{skip: boolean; reason?: string}>` — LLM-powered
- `wasContactedRecently(personId: number): Promise<boolean>` — 3-day gap check
- `daysStale(person: FubPerson): number`
- `generateFollowUpMessage({agentFirstName, agentLastName, leadFirstName, daysStale, stage, person}): Promise<{body, subject}>`
- `sendLeadFollowUpEmail({agentEmail, agentFirstName, agentLastName, leadEmail, leadFirstName, messageBody, subject?})`
- `postFubNote(personId: number, body: string)`
- `logContactedLead({botSlug, botName, person, daysStaleVal, messageBody})`
- `recordSmsSentToday(personId: number, agentName: string)`
- `getSmsSentTodayIds(): Promise<Set<number>>`
- `logBotRun({botName, botSlug, sent, errored, skipped, status})`
- `writeObservation({source, category, severity, message})`
- `fetchPowerQueueCount(agentFirstName: string): Promise<number>`
- `extractEmail(person: FubPerson): string | null`
- `MAX_LEADS_PER_RUN = 15`

### sendBotIntroEmail(botSlug)
- Uses hardcoded BOT_INTRO_COPY[botSlug] — only supports: sp500, tiffany, stefanie, abby, irma, laila
- For engine agents, we need a new `sendEngineIntroEmail(agent: AgentBot)` that generates copy dynamically

### Constants:
- OLD_DASHBOARD_BASE = "https://fub-nurture-phfprjui.manus.space" (Power Queue)
- NEW_DASHBOARD_BASE = "https://lifestyledash-wpnl8v84.manus.space" (Dashboard)
- PETER_EMAIL = "peter@lifestyledesignrealty.com"
- STEVEN_EMAIL = "steven@lifestyledesignrealty.com"

## Bot Run Loop (from tiffanyBot.ts — the template):
1. writeObservation(run_start)
2. getSmsSentTodayIds()
3. fetchLeadsForAgent(AGENT_FUB_ID)
4. filter: !alreadySentToday.has(id) && isEligible(p) → slice(0, MAX_LEADS_PER_RUN)
5. For each candidate:
   a. shouldSkipLead(person) → if skip, postFubNote + continue
   b. wasContactedRecently(personId) → if true, skip
   c. daysStale(person), stage
   d. generateFollowUpMessage(...)
   e. sendLeadFollowUpEmail(...)
   f. postFubNote(personId, "[BotName] Follow-up email sent...")
   g. logContactedLead(...)
   h. recordSmsSentToday(personId, BOT_NAME)
   i. alreadySentToday.add(personId), sent++
6. writeObservation(run_complete)
7. logBotRun(...)
8. return { sent, errored, skipped }

## Clock-in pattern:
1. getSmsSentTodayIds()
2. fetchLeadsForAgent(FUB_ID)
3. filter eligible → leadsQueued = count
4. fetchPowerQueueCount(agentFirstName)
5. sendClockinEmail(...)

## Clock-off pattern:
1. sendClockoffEmail(sent, errored, skipped)
(Clock-off handler reads results from DB via getTodayBotRunResults(botSlug))

## Zero-Overlap Design:
- Old bots fetch leads by their hardcoded FUB ID (e.g. fetchLeadsForAgent(20) for Tiffany)
- They ONLY see leads assigned to that specific agent — they can never touch Jason's leads
- The engine fetches leads by the agent_bots.fubUserId for engine_active=true agents only
- Additional safety: add ENGINE_ACTIVE_FUB_IDS set to old bot files to skip if somehow encountered
- But structurally impossible since fetchLeadsForAgent filters by assignedUserId at the FUB API level

## botMonitor.ts:
- ALL_BOTS array at line 13 — needs Jason added once engine is live
- newSlugs set at line 84 — used to suppress "not_run" warnings for newly added bots
- checkAllBotHealth() iterates ALL_BOTS and queries bot_run_logs per slug

## Scheduled Handlers Pattern:
- requireCron(req, res) — checks sdk.authenticateRequest, must be isCron
- withCrashObservation(botSlug, action, fn, res) — wraps handler with crash logging
- Each handler: if (!requireCron) return; await withCrashObservation(slug, action, async () => { ... }, res);

## Migration Note:
- The generated migration 0004_daffy_terror.sql tries to create many tables that already exist
- ONLY execute the agent_bots CREATE TABLE statement — all other tables already exist in prod
- Also skip the email_angle_log column renames (those columns already exist with correct names in prod)

## tRPC Router Structure:
- Imports: publicProcedure, protectedProcedure, router from ./_core/trpc
- adminProcedure available from ./_core/trpc (role check built-in)
- agentRegistry router already exists with fubUsers endpoint
- Need to add: list, create, toggleActive procedures

## Admin UI:
- DashboardLayout navItems at lines 15-19 needs new entry
- App.tsx needs new route
- AgentBots.tsx is the best template for table/card UI patterns
