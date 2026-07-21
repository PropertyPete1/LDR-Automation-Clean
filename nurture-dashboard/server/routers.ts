import { COOKIE_NAME } from "@shared/const";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { promises as fsPromises } from "fs";
import { getSessionCookieOptions } from "./_core/cookies";
import { invokeLLM } from "./_core/llm";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { ENV } from "./_core/env";
import { getDashboardStats, getAgentLeads, getPendingQueue, getAgentRoster, clearRosterCache, clearQueueCache, clearDashboardCache, recordSmsSentToday, getPondSmsOnlyLeads } from "./dashboardData";
import { getMemories, getWinningPatterns, logFeedback, saveMemory, logUiError, getSmsSentTodayByAgent, getSmsSentLastWeekByAgent, getRecentBotRuns, getRecentMonitorRuns, insertMonitorLog, getRecentObservations, markObservationFixed, getDb, getCachedDraft, setCachedDraft, snoozeLead as snoozeLeadDb, unsnoozeLead as unsnoozeLeadDb, markSnoozeNoteWritten as markSnoozeNoteWrittenDb, getActiveSnoozesForAgent as getActiveSnoozesForAgentDb, getSnoozeCount, recordQueueAction as recordQueueActionDb, getWeeklyQueueStats as getWeeklyQueueStatsDb } from "./db";
import { smsSentToday } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { runBotMonitor } from "./botMonitor";
import { runBounceHandler } from "./bounceHandler";
import { runLifestyleBot } from "./lifestyleBot";
import { runAutoPondPromotion, getRecentPondPromotionRuns } from "./autoPondPromotion";
import { suppressLead, isLeadSuppressed, getSuppressionList } from "./compliance";
import { getLeadMemories, formatMemoriesForContext, autoExtractAndStore } from "./memoryLayer";
import { createHeartbeatJob } from "./_core/heartbeat";
import { parse as parseCookie } from "cookie";
import { getActiveAgents, normalizeAgentName, getBotStatusRoster } from "./agentRegistry";

const execAsync = promisify(exec);
const AUDIT_RESULT_PATH = "/home/ubuntu/fub_automation/audit_result.json";
const AUDIT_SCRIPT_PATH = "/home/ubuntu/fub_automation/sevenx_audit.py";

const FUB_BASE = "https://api.followupboss.com/v1";

async function fubRequest(method: string, path: string, body?: object) {
  const apiKey = ENV.fubApiKey;
  if (!apiKey) throw new Error("FUB_API_KEY not configured");

  const credentials = Buffer.from(`${apiKey}:`).toString("base64");
  const res = await fetch(`${FUB_BASE}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${credentials}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FUB API ${method} ${path} failed ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") return {};
  return res.json();
}

const COPILOT_SYSTEM_PROMPT = `You are the **Lifestyle Design Realty AI Broker** — a senior-level real estate broker AI built exclusively for the agents and leadership of Lifestyle Design Realty. You know this brokerage, its systems, its deals, and its markets from top to bottom.

## WHO YOU ARE
You are a seasoned Texas real estate broker with deep knowledge of new construction, buyer financing, and lead nurturing. You are confident, concise, warm, and professional. You write and speak like a real person — never robotic, never corporate, always human.

## THE BROKERAGE
- Company: Lifestyle Design Realty
- Address: 1209 S Saint Marys St #232, San Antonio, TX 78210
- Realtor & Owner: Peter Allen (peter@lifestyledesignrealty.com)
- Markets served: San Antonio, New Braunfels, Austin, Dallas, Fort Worth, Houston
- Agents: Stefanie (San Antonio), Steven (Austin, Broker & Owner), Tiffany (Austin), Abby (Austin), Irma (DFW), Laila (San Antonio), Peter Allen (Realtor & Owner, San Antonio)

## THE AUTOMATION SYSTEM
The brokerage runs a fully automated lead nurture system:

Phase 1 - Agent Reminder Digests: Every morning at 8am CT, each agent receives a personalized email digest listing all their stale leads (untouched for 14+ days). The digest includes a Launch Power Queue button that opens a tap-to-text page filtered to that agent's leads.

Phase 2 - Pond Nurture Emails: Leads in the Lead Pond receive an AI-personalized email every 14 days indefinitely. Emails come from peter@lifestyledesignrealty.com and are city-tailored. Daily cap: 100 emails per run.

Phase 2 - Stale Reassignment: If an agent has not left a qualifying FUB note on a lead within 20 days, the lead is automatically reassigned to the Lead Pond. Daily cap: 100 reassignments per run.

Speed-to-Lead: New leads assigned to an agent trigger a timer. If the agent has not touched the lead within 30 business minutes (10am-6pm CT), a warning note is added to FUB and the agent gets an urgent task. At 60 minutes, the lead is reassigned to Peter Allen.

Keyword Reassignment: If a pond lead replies with purchase intent keywords (yes, interested, ready, looking, buy, home, price, schedule, tour, call me, when, how much), they are immediately reassigned to Peter Allen.

Power Queue (Tap-to-Text): The Power Queue at https://fub-nurture-phfprjui.manus.space/sms-queue shows agents their stale leads with pre-filled SMS messages. Agents tap Send Text Now to open iMessage pre-loaded with the message. A note is automatically logged in FUB when they send.

Suppression Rules: Leads tagged Do Not Nurture, No AI Email, Do Not Email, Manual Review, do not contact, realtor, bounced, unsubscribe, email opt out, or dnc are never contacted. Leads in stages Trash, Active Client, Pending, Closed, Past Client, Sphere, or Under Contract are excluded from reassignment.

## CURRENT NEW BUILD DEALS DATABASE

San Antonio - Sorento and Horizon Pointe Communities
- Builder: Lennar Homes
- Price range: $311,000 to $415,000+
- Rate: 3.99% on select homes
- Est. payment: $1,480/mo base, $1,980/mo upgraded
- Highlights: Zero down for VA/military, FHA/conventional friendly, 3-5 bedrooms, pool/amenity center, easy highway access
- Best for: First-time buyers, military families, value-focused buyers

Austin Metro - Leander and Georgetown Ranch Communities
- Builder: Pulte Homes
- Price range: $349,000 to $450,000+
- Rate: 4.25% with preferred lender
- Est. payment: $1,720/mo base, $2,210/mo upgraded
- Highlights: Up to $15,000 closing cost assistance, free design consultation, tech hub proximity, walking trails
- Best for: Tech workers, growing families, commuter buyers

North Dallas (DFW) - Frisco and Prosper Ranch Communities
- Builder: Perry Homes
- Price range: $399,000 to $520,000+
- Rate: 4.50% with 3-2-1 buy-down available
- Est. payment: $2,020/mo base, $2,630/mo upgraded
- Highlights: USDA zero-down eligible, $10K designer upgrade credits, resort pool/clubhouse, top-rated schools, 1-2-10 warranty
- Best for: Luxury buyers, families with school-age kids, USDA-eligible buyers

## WHAT YOU CAN DO FOR AGENTS
1. Draft SMS messages - short, friendly, personalized texts for leads. Under 160 chars. Use first name only.
2. Draft email copy - warm professional emails. Sign off with agent first name. Never mention automation or AI.
3. Summarize leads - 2-3 sentence brief on status, interest area, and recommended next action.
4. Answer system questions - explain how the Power Queue works, why a lead was reassigned, what triggers a suppression, etc.
5. Look up new build homes - give specific pricing, community names, builder names, rates, and payment estimates by city.
6. Handle objections - give agents word-for-word scripts for common buyer objections (rate concerns, timing, just browsing, etc.).
7. Explain the daily digest - tell agents what the email is, what the PDF is, what the video is, and how to use them.
8. Answer questions about a specific lead - when a lead is selected, you have their FUB notes and last inbound text RIGHT IN FRONT OF YOU in the CURRENT LEAD CONTEXT block below. Use that data directly and confidently.

## YOUR ACCESS TO LEAD DATA
When a lead is selected in the Power Queue, you receive a CURRENT LEAD CONTEXT block that contains:
- The lead's name, phone, stage, city interest, and days since last contact
- Their recent FUB notes (last 3 notes from Follow Up Boss)
- Their last inbound text message to the agent

YOU HAVE THIS DATA. It is injected directly into your context. When an agent asks "what did this lead say?" or "what are their notes?" or "how should I respond?" — READ THE CONTEXT BLOCK and answer from it. Do NOT say you don't have access to FUB. You do not need real-time API access because the data is already here.

## RULES
- Never reveal that you are AI-powered in any draft copy you write for clients.
- Always use the lead FIRST NAME ONLY in SMS drafts (never last name).
- Keep SMS drafts under 160 characters unless asked for longer.
- Personalize drafts using lead name, city interest, days since last contact, notes, and last inbound text when provided.
- Format responses with markdown when it helps clarity.
- When asked about a specific city, always give the exact deal numbers from the database above.
- NEVER say you don't have access to lead data or FUB notes — you DO have it when a lead is selected. Use it.
- If no lead is selected and the agent asks about a specific lead, ask them to select the lead from the dropdown first.`;

// ── Audit tRPC procedures ─────────────────────────────────────────────────────
const auditRouter = router({
  /**
   * Get the latest audit result from disk. Public so the dashboard can poll it.
   */
  getStatus: publicProcedure.query(async () => {
    try {
      const raw = await fsPromises.readFile(AUDIT_RESULT_PATH, "utf-8");
      return JSON.parse(raw);
    } catch {
      return { never_run: true, passed: 0, total: 0, failed: 0, score_pct: 0, clean: false, failures: [], run_at: null, audit_version: "sevenx" };
    }
  }),

  /**
   * Run the system audit script. Public — no login required for the dashboard owner.
   * Returns the fresh audit result when done.
   */
  run: publicProcedure.mutation(async () => {
    try {
      // -W ignore suppresses DeprecationWarning from stderr so it doesn't throw
      await execAsync(`python3 -W ignore ${AUDIT_SCRIPT_PATH}`, { timeout: 120_000 });
      const raw = await fsPromises.readFile(AUDIT_RESULT_PATH, "utf-8");
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`Audit run failed: ${String(err).slice(0, 200)}`);
    }
  }),
});

export const appRouter = router({
  system: systemRouter,
  audit: auditRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // ── Live FUB + SQLite data ─────────────────────────────────────────────────
  fub: router({
    /**
     * Fetch the latest incoming SMS for a lead from FUB.
     * Used by Reply Mode to auto-load the most recent inbound text.
     * Cached for 60 seconds per lead to avoid rate limit issues.
     */
    getLatestInboundSms: publicProcedure
      .input(z.object({ personId: z.number() }))
      .query(async ({ input }) => {
        const res = await fubRequest("GET", `/textMessages?personId=${input.personId}&limit=20`);
        const msgs: any[] = res.textMessages || [];
        const inbound = msgs.find((m: any) => m.isIncoming === true || m.direction === "inbound");
        if (!inbound) return { message: null, receivedAt: null };
        return {
          message: inbound.message || inbound.body || null,
          receivedAt: inbound.createdAt || inbound.updatedAt || null,
          messageId: inbound.id || null,
        };
      }),

    /**
     * Returns the full dashboard stats object built from the SQLite audit_log
     * and supplemented with FUB API data (conversions, agent clicks).
     */
    getDashboardStats: publicProcedure.query(async () => {
      return getDashboardStats(ENV.fubApiKey);
    }),

    /**
     * Returns the live pending SMS queue — leads that are stale and have a
     * phone number, enriched with a pre-generated SMS body and redirect link.
     */
    getPendingQueue: publicProcedure
      .input(z.object({ agentFilter: z.string().optional() }))
      .query(async ({ input }) => {
        // agentFilter: when provided, server only returns that agent's leads.
        // When omitted (Peter/admin), returns the full queue.
        return getPendingQueue(ENV.fubApiKey, input.agentFilter);
      }),

    /**
     * Returns pond leads tagged "bad-email" that have a valid phone number.
     * These are leads whose email bounced but still have a working phone —
     * shown in Peter's Power Queue under "Pond Leads — SMS Only" section.
     */
    getPondSmsLeads: publicProcedure.query(async () => {
      return getPondSmsOnlyLeads(ENV.fubApiKey);
    }),
  }),

  leads: router({
    /**
     * Returns today's per-agent SMS text counts for the daily goal tracker.
     * Goal is configurable — default 15 texts/day.
     */
    getDailySmsGoal: publicProcedure
      .input(z.object({ agentName: z.string().min(1) }))
      .query(async ({ input }) => {
        const DAILY_GOAL = 15;
        const rows = await getSmsSentTodayByAgent();
        const agentRow = rows.find(
          r => r.agentName.toLowerCase() === input.agentName.toLowerCase()
        );
        const todayCount = agentRow?.todayTexts ?? 0;
        return { todayCount, goal: DAILY_GOAL, pct: Math.min(100, Math.round((todayCount / DAILY_GOAL) * 100)) };
      }),

    // Log a FUB note when agent taps "Send Text Now" or when a nurture email is sent
    // publicProcedure: agents tap links from email without being logged in — no auth cookie
    // Spam protection: personId must be a positive integer; FUB rejects invalid IDs server-side
    logSentNote: publicProcedure
      .input(
        z.object({
          personId: z.number().int().positive(),
          agentName: z.string().min(1).max(100),
          messageBody: z.string().max(500).optional(),
          channel: z.enum(["sms", "email", "call"]).optional().default("sms"),
        })
      )
      .mutation(async ({ input }) => {
        const { personId, messageBody, channel } = input;

        // Dynamic: normalize agentName via agentRegistry (Golden Rule — no hardcoded names)
        const activeAgents = await getActiveAgents();
        const rawName = input.agentName.trim();
        const agentName = normalizeAgentName(rawName, activeAgents);
        const now = new Date().toLocaleDateString("en-US", {
          month: "numeric",
          day: "numeric",
          year: "numeric",
          timeZone: "America/Chicago",
        });

        let subject: string;
        let noteBody: string;

        if (channel === "email") {
          subject = `📧 Nurture Email Sent — ${agentName}`;
          noteBody = messageBody
            ? `Automated nurture email sent by ${agentName} on ${now}.\n\nSubject: "${messageBody}"`
            : `Automated nurture email sent by ${agentName} on ${now}.`;
        } else if (channel === "call") {
          subject = `📞 Call Attempted — ${agentName}`;
          noteBody = `Call attempted by ${agentName} via Power Queue on ${now}. No text sent — agent chose to call instead.`;
        } else {
          subject = `📲 Click-to-Text Sent — ${agentName}`;
          noteBody = messageBody
            ? `Click-to-Text follow-up sent by ${agentName} via Power Queue on ${now}.\n\nMessage: "${messageBody}"`
            : `Click-to-Text follow-up initiated by ${agentName} via Power Queue on ${now}.`;
        }

        await fubRequest("POST", "/notes", {
          personId,
          subject,
          body: noteBody,
          isHtml: false,
        });

        // Record this lead as texted today so the Power Queue and dashboard
        // immediately reflect the action without waiting for FUB to update.
        // DB-backed so it survives server restarts — no more "already texted" leads reappearing.
        if (channel === "sms") {
          await recordSmsSentToday(personId, agentName);
          // Bust all server-side caches so the next dashboard/queue load is fresh
          clearQueueCache();
          clearRosterCache();
          clearDashboardCache();
        }

        return { success: true };
      }),

    // Returns the set of personIds texted today (CT) — used to seed client localStorage
    // so agents never re-text a lead they already contacted today, even after a page refresh.
    getTodayTextedLeadIds: publicProcedure
      .input(z.object({ agentName: z.string().min(1).max(100) }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return { ids: [] };
        const sentDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
        // Dynamic: normalize agentName via agentRegistry (Golden Rule)
        const agentsForNorm = await getActiveAgents();
        const canonical = normalizeAgentName(input.agentName, agentsForNorm);
        const agentRows = await db
          .select({ personId: smsSentToday.personId })
          .from(smsSentToday)
          .where(
            and(
              eq(smsSentToday.sentDate, sentDate),
              eq(smsSentToday.agentName, canonical)
            )
          );
        return { ids: agentRows.map(r => r.personId) };
      }),

    // Fetch the last inbound text message for a lead from FUB
    getLastInbound: publicProcedure
      .input(z.object({ personId: z.number() }))
      .query(async ({ input }) => {
        const data = (await fubRequest("GET", `/textMessages?personId=${input.personId}&limit=20`)) as {
          textMessages?: Array<{
            message?: string;
            body?: string;
            isIncoming?: boolean;
            direction?: string;
            createdAt?: string;
          }>;
        };

        const messages = data.textMessages ?? [];
        const inbound = messages.find(
          m => m.isIncoming === true || m.direction === "inbound"
        );

        return {
          message: inbound?.message || inbound?.body || null,
          createdAt: inbound?.createdAt || null,
        };
      }),

    // Fetch recent notes for a lead from FUB
    getNotes: publicProcedure
      .input(z.object({ personId: z.number() }))
      .query(async ({ input }) => {
        const data = (await fubRequest("GET", `/notes?personId=${input.personId}&limit=5`)) as {
          notes?: Array<{ body?: string; subject?: string; createdAt?: string }>;
        };

        const notes = (data.notes ?? [])
          .map(n => n.body || n.subject || "")
          .filter(Boolean)
          .join(" | ");

        return { notes };
      }),

    // ── Power Queue 2.0: Snooze ──────────────────────────────────────────────
    snoozeLead: publicProcedure
      .input(z.object({
        personId: z.number().int().positive(),
        agentName: z.string().min(1).max(100),
        snoozeUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
        reason: z.string().max(200).optional(),
        leadName: z.string().max(200).optional(),
        daysStale: z.number().optional().default(0),
      }))
      .mutation(async ({ input }) => {
        const { personId, agentName, snoozeUntil, reason, leadName, daysStale } = input;

        // Write FUB note for audit trail
        const snoozeDate = new Date(snoozeUntil + 'T12:00:00').toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric'
        });
        try {
          await fubRequest("POST", "/notes", {
            personId,
            subject: `⏸️ Agent snoozed follow-up until ${snoozeDate}`,
            body: `${agentName} snoozed Power Queue follow-up until ${snoozeDate}.${reason ? ` Reason: ${reason}` : ''} (Display-level only — nurture timers unaffected.)`,
            isHtml: false,
          });
          await markSnoozeNoteWrittenDb(personId, agentName);
        } catch (e) {
          console.warn('[snoozeLead] FUB note write failed:', e);
        }

        // Store snooze in DB
        await snoozeLeadDb(personId, agentName, snoozeUntil, reason, leadName);

        // Record as queue action for stats
        await recordQueueActionDb(personId, agentName, 'snoozed', daysStale, false);

        // Bust queue cache so the lead disappears immediately
        clearQueueCache();

        return { success: true, snoozeUntil };
      }),

    unsnoozeLead: publicProcedure
      .input(z.object({
        personId: z.number().int().positive(),
        agentName: z.string().min(1).max(100),
      }))
      .mutation(async ({ input }) => {
        await unsnoozeLeadDb(input.personId, input.agentName);
        clearQueueCache();
        return { success: true };
      }),

    getSnoozeInfo: publicProcedure
      .input(z.object({ agentName: z.string().min(1).max(100) }))
      .query(async ({ input }) => {
        const snoozes = await getActiveSnoozesForAgentDb(input.agentName);
        const count = snoozes.size;
        const entries = Array.from(snoozes.entries()).map(([personId, until]) => ({ personId, snoozeUntil: until }));
        return { count, entries };
      }),

    // ── Power Queue 2.0: Record Action (for stats) ───────────────────────────
    recordAction: publicProcedure
      .input(z.object({
        personId: z.number().int().positive(),
        agentName: z.string().min(1).max(100),
        actionType: z.enum(['texted', 'called', 'snoozed', 'hot_lead_responded', 'completed']),
        daysStale: z.number().optional().default(0),
        isHotLead: z.boolean().optional().default(false),
      }))
      .mutation(async ({ input }) => {
        await recordQueueActionDb(input.personId, input.agentName, input.actionType, input.daysStale, input.isHotLead);
        return { success: true };
      }),

    // ── Power Queue 2.0: Weekly Stats (for Python digest) ────────────────────
    getWeeklyStats: publicProcedure
      .input(z.object({ weekKey: z.string().optional() }))
      .query(async ({ input }) => {
        return getWeeklyQueueStatsDb(input.weekKey);
      }),
  }),

  ai: router({
    chat: publicProcedure
      .input(
        z.object({
          messages: z.array(
            z.object({
              role: z.enum(["system", "user", "assistant"]),
              content: z.string(),
            })
          ),
          leadContext: z
            .object({
              id: z.number(),
              name: z.string(),
              phone: z.string().optional(),
              stage: z.string().optional(),
              city: z.string().optional(),
              days_stale: z.number().optional(),
              assigned_agent: z.string().optional(),
              sms_body: z.string().optional(),
              notes: z.string().optional(),
              last_inbound_text: z.string().optional(),
            })
            .optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { messages, leadContext } = input;
        const agentName = leadContext?.assigned_agent || "";

        // Build the system prompt with optional lead context
        let systemContent = COPILOT_SYSTEM_PROMPT;

        // Inject agent memories (RAG — Option 1)
        if (agentName) {
          const memories = await getMemories(agentName, 10);
          if (memories.length > 0) {
            systemContent += `\n\n--- AGENT MEMORY (${agentName}) ---\nThe following are things you have learned about ${agentName} and their leads over time. Use these to personalize your responses:\n${memories.map((m) => `• [${m.category}] ${m.memoryText}`).join("\n")}\n---`;
          }

          // Inject winning draft patterns (RAG — Option 2)
          const patterns = await getWinningPatterns(agentName, 5);
          if (patterns.length > 0) {
            systemContent += `\n\n--- WINNING SMS PATTERNS (what ${agentName} actually sends) ---\nThese are recent SMS drafts that ${agentName} chose to send. Use them to match their preferred tone and style:\n${patterns.map((p, i) => `${i + 1}. "${p.draftText.slice(0, 120)}"`).join("\n")}\n---`;
          }
        }

        if (leadContext) {
          systemContent += `\n\n--- CURRENT LEAD CONTEXT ---\nName: ${leadContext.name}\nPhone: ${leadContext.phone || "N/A"}\nStage: ${leadContext.stage || "N/A"}\nCity Interest: ${leadContext.city || "Texas"}\nDays Since Last Contact: ${leadContext.days_stale ?? "Unknown"}\nAssigned Agent: ${leadContext.assigned_agent || "N/A"}\n${leadContext.sms_body ? `Last Auto-Generated SMS Draft: "${leadContext.sms_body}"` : ""}${leadContext.notes ? `\nRecent FUB Notes: ${leadContext.notes}` : ""}${leadContext.last_inbound_text ? `\nLast Inbound Text from Lead: "${leadContext.last_inbound_text}"` : ""}\n---`;
        }

        // Prepend the system message (or replace if already present)
        const hasSystemMessage = messages[0]?.role === "system";
        const fullMessages = hasSystemMessage
          ? [{ role: "system" as const, content: systemContent }, ...messages.slice(1)]
          : [{ role: "system" as const, content: systemContent }, ...messages];

        const result = await invokeLLM({
          messages: fullMessages,
          maxTokens: 1024,
        });

        const content = result.choices[0]?.message?.content;
        if (typeof content !== "string") {
          throw new Error("Unexpected LLM response format");
        }

        return { content };
      }),

    draftSms: publicProcedure
      .input(
        z.object({
          leadName: z.string(),
          leadCity: z.string().optional(),
          daysStale: z.number().optional(),
          assignedAgent: z.string().optional(),
          notes: z.string().optional(),
          prefillMessage: z.string().optional(),
          personId: z.number().optional(), // for memory layer + cache key
          forceRefresh: z.boolean().optional().default(false), // bypass cache
        })
      )
      .mutation(async ({ input }) => {
        const { leadName, leadCity, daysStale, assignedAgent, notes, prefillMessage, personId, forceRefresh } = input;

        // ── Power Queue 2.0: Check cache first (per lead per day) ──────────────
        if (personId && assignedAgent && !forceRefresh) {
          const cached = await getCachedDraft(personId, assignedAgent);
          if (cached) {
            return { draft: cached, cached: true };
          }
        }

        // Inject memory context if we have a personId
        let memoryContext = "";
        if (personId && assignedAgent) {
          const memories = await getLeadMemories(personId, assignedAgent, 8);
          memoryContext = formatMemoriesForContext(memories);
        }

        // Fetch recent outbound SMS history so AI doesn't repeat messages
        let smsHistoryContext = "";
        if (personId) {
          try {
            const smsRes = await fubRequest("GET", `/textMessages?personId=${personId}&limit=20`);
            const allTexts: any[] = smsRes.textMessages || [];
            const outbound = allTexts
              .filter((m: any) => m.isIncoming === false || m.direction === "outbound" || (!m.isIncoming && m.direction !== "inbound"))
              .slice(0, 5)
              .map((m: any) => m.message || m.body || "")
              .filter(Boolean);
            if (outbound.length > 0) {
              smsHistoryContext = `\n\nIMPORTANT — Previous texts already sent to this lead (DO NOT repeat or closely paraphrase any of these):\n${outbound.map((t: string, i: number) => `${i + 1}. "${t}"`).join("\n")}`;
            }
          } catch (_) {
            // SMS history fetch failed — continue without it
          }
        }

        const hasNotes = notes && notes.trim().length > 0;
        // ── Power Queue 2.0: Upgraded prompt for Claude claude-sonnet-4-6 ───────────────────
        const systemPrompt = `You are writing a single SMS text message for a Texas real estate agent to send to a lead. Rules:
- Write ONLY the SMS text itself — no quotes, no labels, no explanation, no markdown
- Maximum 2 sentences. Under 160 characters total.
- Sound like a real human agent — casual, warm, specific. Not a bot.
- Use the lead's first name naturally
- If notes are provided, you MUST reference something specific from them (a city they mentioned, a price range, a question they asked, a property type). Generic messages are unacceptable.
- Never use more than 1 emoji. Prefer zero.
- Never mention automation, AI, or systems
- NEVER repeat or closely paraphrase a message that was already sent (see history below)${memoryContext}${smsHistoryContext}`;

        let userPrompt: string;
        if (hasNotes) {
          userPrompt = `Write a personalized follow-up text for ${leadName}.
City/area: ${leadCity || "Texas"}
Days since created: ${daysStale ?? "unknown"}
Agent: ${assignedAgent || "the agent"}

FUB Notes (most recent first):
${notes}

Reference something SPECIFIC from the notes. Make it feel like the agent remembers this person. 2 sentences max, under 160 chars.`;
        } else {
          userPrompt = `Write a brief, natural follow-up text for ${leadName} (interested in ${leadCity || "Texas"}, ${daysStale ?? "several"} days since they entered the system). No notes available — keep it simple and friendly. Ask one specific question about their home search. 2 sentences max, under 160 chars.`;
        }

        // ── Call Anthropic API directly (not Manus/Forge LLM) ──────────────
        const anthropicKey = ENV.anthropicApiKey;
        if (!anthropicKey) {
          throw new Error("ANTHROPIC_API_KEY not configured");
        }
        const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 200,
            system: systemPrompt,
            messages: [
              { role: "user", content: userPrompt },
            ],
          }),
        });
        if (!anthropicRes.ok) {
          const errBody = await anthropicRes.text();
          throw new Error(`Anthropic API error ${anthropicRes.status}: ${errBody}`);
        }
        const anthropicData = await anthropicRes.json() as any;
        const content = anthropicData.content?.[0]?.text;
        if (typeof content !== "string") {
          throw new Error("Unexpected Anthropic response format");
        }

        // Strip any surrounding quotes the model might add
        const cleaned = content.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");

        // ── Power Queue 2.0: Cache the draft for today ────────────────────────
        if (personId && assignedAgent) {
          await setCachedDraft(personId, assignedAgent, cleaned);
        }

        return { draft: cleaned, cached: false };
      }),

    // Draft a reply to a lead's inbound message
    draftReply: publicProcedure
      .input(
        z.object({
          leadName: z.string(),
          leadCity: z.string().optional(),
          assignedAgent: z.string().optional(),
          inboundMessage: z.string(),
          notes: z.string().optional(),
          personId: z.number().optional(), // for memory layer
        })
      )
      .mutation(async ({ input }) => {
        const { leadName, leadCity, assignedAgent, inboundMessage, notes, personId } = input;

        // Inject memory context if we have a personId
        let memoryContext = "";
        if (personId && assignedAgent) {
          const memories = await getLeadMemories(personId, assignedAgent, 8);
          memoryContext = formatMemoriesForContext(memories);
          // Auto-extract memories from the inbound message (fire-and-forget)
          autoExtractAndStore(personId, assignedAgent, leadName, inboundMessage).catch(() => {});
        }

        const systemPrompt = `You are a Texas real estate agent named ${assignedAgent || "the agent"} at Lifestyle Design Realty. Your job is to write a warm, natural SMS reply to a lead's message.${memoryContext}

Rules:
- Write ONLY the reply text — no quotes, no labels, no explanation
- Keep it under 160 characters
- Sound like a real person — casual, warm, professional
- Never mention AI or automation
- Use the lead's first name if appropriate
- Address what they actually said
- Move the conversation toward a next step (showing, call, etc.) if relevant`;

        const userPrompt = `${leadName} just texted${leadCity ? ` (interested in ${leadCity})` : ""}:
"${inboundMessage}"
${notes ? `\nContext about this lead: ${notes}` : ""}

Write a natural reply that addresses their message and keeps the conversation going. Under 160 chars.`;

        const result = await invokeLLM({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          maxTokens: 200,
        });

        const content = result.choices[0]?.message?.content;
        if (typeof content !== "string") {
          throw new Error("Unexpected LLM response format");
        }

        const cleaned = content.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
        return { draft: cleaned };
      }),

    /**
     * AI-powered daily briefing — generates a concise system status summary.
     * Cached for 10 minutes to avoid excessive LLM calls.
     */
    dailyBriefing: publicProcedure
      .query(async () => {
        // Gather system stats for the briefing
        const fubApiKey = ENV.fubApiKey;
        let rosterSummary = "";
        let botSummary = "";
        try {
          const roster = await getAgentRoster(fubApiKey || "");
          const totalDoNow = roster.reduce((sum, a) => sum + (a.do_now || 0), 0);
          const totalHot = roster.reduce((sum, a) => sum + (a.hot_prospect || 0), 0);
          const totalLeads = roster.reduce((sum, a) => sum + (a.total || 0), 0);
          rosterSummary = `Team has ${roster.length} agents managing ${totalLeads} total leads. ${totalDoNow} leads need immediate attention (14-20 day window). ${totalHot} hot prospects.`;
        } catch { rosterSummary = "Roster data unavailable."; }

        try {
          const recentRuns = await getRecentBotRuns(3);
          if (recentRuns.length > 0) {
            const lastRun = recentRuns[0];
            const totalProcessed = recentRuns.reduce((s, r) => s + (r.leadsTexted || 0), 0);
            const totalErrors = recentRuns.reduce((s, r) => s + (r.leadsFailed || 0), 0);
            botSummary = `Lifestyle Bot: ${totalProcessed} leads processed in last 3 runs, ${totalErrors} errors. Last run: ${new Date(lastRun.runAt).toLocaleString()}.`;
          } else {
            botSummary = "No recent bot runs found.";
          }
        } catch { botSummary = "Bot run data unavailable."; }

        let monitorSummary = "";
        try {
          const observations = await getRecentObservations(5);
          const errors = observations.filter(o => o.severity === "error" && !o.fixedAt);
          const warnings = observations.filter(o => o.severity === "warning" && !o.fixedAt);
          monitorSummary = errors.length > 0
            ? `⚠️ ${errors.length} unresolved error(s): ${errors.map(e => e.message).join("; ")}.`
            : warnings.length > 0
            ? `${warnings.length} warning(s) noted but no critical errors.`
            : "All systems healthy — no errors or warnings.";
        } catch { monitorSummary = "Monitor data unavailable."; }

        try {
          const response = await invokeLLM({
            messages: [
              {
                role: "system",
                content: "You are a concise operations briefing assistant for a real estate lead nurture system. Write a 1-2 sentence executive summary of the system status. Be specific with numbers. No greetings, no fluff, no markdown."
              },
              {
                role: "user",
                content: `Generate today's briefing based on:\n\nAgent Roster: ${rosterSummary}\n\nBot Activity: ${botSummary}\n\nSystem Health: ${monitorSummary}`
              }
            ],
            max_tokens: 150,
          });

          const content = response?.choices?.[0]?.message?.content;
          return { briefing: typeof content === "string" ? content.trim() : "System operational." };
        } catch {
          return { briefing: "System is running. AI briefing temporarily unavailable." };
        }
      }),
  }),

  // ── Agent personal dashboard ─────────────────────────────────────────────────
  agent: router({
    /**
     * Fetch all leads assigned to a specific agent, classified into tiers.
     * Tier: do_now (14-20 days stale), hot_prospect (stage = Hot Prospect), your_leads (everything else)
     */
    getLeads: publicProcedure
      .input(z.object({ agentName: z.string().min(1) }))
      .query(async ({ input }) => {
        const fubApiKey = ENV.fubApiKey;
        if (!fubApiKey) throw new Error("FUB_API_KEY not configured");
        const leads = await getAgentLeads(fubApiKey, input.agentName);
        return { leads };
      }),

    /**
     * Fetch a summary of all 6 active agents for the admin overview dashboard.
     * Returns tier counts, avg staleness, and last-active metrics per agent.
     * Reuses per-agent cache so subsequent calls are instant.
     */
    getRoster: publicProcedure
      .query(async () => {
        const fubApiKey = ENV.fubApiKey;
        if (!fubApiKey) throw new Error("FUB_API_KEY not configured");
        const roster = await getAgentRoster(fubApiKey);
        return { roster };
      }),

    /**
     * Force-refresh the roster cache — clears server-side cache and re-fetches
     * all 7 agents from FUB live. Use the refresh button on the dashboard.
     */
    refreshRoster: publicProcedure
      .mutation(async () => {
        const fubApiKey = ENV.fubApiKey;
        if (!fubApiKey) throw new Error("FUB_API_KEY not configured");
        clearRosterCache();
        const roster = await getAgentRoster(fubApiKey);
        return { roster };
      }),
  }),

  // ── Copilot Learning System (RAG Memory + Feedback Loop) ─────────────────────
  copilot: router({
    /**
     * Save a memory for an agent. Called by the Copilot UI after a useful exchange.
     */
    saveMemory: publicProcedure
      .input(
        z.object({
          agentName: z.string().min(1),
          memoryText: z.string().min(1).max(500),
          category: z.enum(["agent_style", "lead_insight", "market_knowledge", "general"]).default("general"),
          importanceScore: z.number().min(1).max(5).default(1),
        })
      )
      .mutation(async ({ input }) => {
        await saveMemory(input);
        return { success: true };
      }),

    /**
     * Get memories for an agent to display in the Copilot UI.
     */
    getMemories: publicProcedure
      .input(z.object({ agentName: z.string() }))
      .query(async ({ input }) => {
        const memories = await getMemories(input.agentName, 10);
        return { memories };
      }),

    /**
     * Log a feedback signal for a draft (sent / ignored / regenerated / edited).
     */
    logFeedback: publicProcedure
      .input(
        z.object({
          agentName: z.string().min(1),
          draftText: z.string().min(1),
          leadCity: z.string().optional(),
          leadStage: z.string().optional(),
          draftType: z.enum(["outbound", "reply"]).default("outbound"),
          action: z.enum(["sent", "ignored", "regenerated", "edited"]),
        })
      )
      .mutation(async ({ input }) => {
        await logFeedback(input);
        return { success: true };
      }),

    /**
     * Get winning draft patterns for an agent (most-sent drafts).
     */
    getWinningPatterns: publicProcedure
      .input(z.object({ agentName: z.string() }))
      .query(async ({ input }) => {
        const patterns = await getWinningPatterns(input.agentName, 5);
        return { patterns };
      }),
  }),

  // ── Self-Healing Error Logger ───────────────────────────────────────────────────────
  errors: router({
    /**
     * Client-side error reporter. Called by the React error boundary and
     * the global tRPC error hook to persist browser-side failures to the
     * ui_error_log table so the nightly healer can process them.
     * Always returns { ok: true } — never throws back to the client.
     */
    logClientError: publicProcedure
      .input(z.object({
        actor:        z.string().max(100).default('unknown'),
        action:       z.string().max(200),
        errorMessage: z.string().max(500),
        errorDetail:  z.string().max(2000).optional(),
        category:     z.enum(['fub_api', 'roster', 'audit', 'sms', 'queue', 'auth', 'ui_crash', 'other']).default('other'),
      }))
      .mutation(async ({ input }) => {
        await logUiError(input);
        return { ok: true };
      }),

    /**
     * Returns a summary of today's unresolved errors for the dashboard health card.
     * Shows the owner how many errors occurred and what categories.
     */
    getDaySummary: publicProcedure
      .query(async () => {
        const { getUnresolvedErrors } = await import('./db');
        const errors = await getUnresolvedErrors(25);
        const byCategory: Record<string, number> = {};
        for (const e of errors) {
          byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
        }
        return {
          total: errors.length,
          byCategory,
          recentErrors: errors.slice(0, 5).map(e => ({
            action: e.action,
            errorMessage: e.errorMessage,
            category: e.category,
            createdAt: e.createdAt,
          })),
        };
      }),
  }),

  // ── Lifestyle Bot ─────────────────────────────────────────────────────────
  bot: router({
    /**
     * Returns today's activity counts for all agents + Lifestyle Bot,
     * plus this week's totals. Used by the dashboard Lifestyle Bot panel.
     * (Power Queue texts for agents, FUB note posts for the bot)
     */
    getStatus: publicProcedure
      .query(async () => {
        // Dynamic: build ROSTER from FUB users via agentRegistry (Golden Rule)
        const ROSTER = getBotStatusRoster(await getActiveAgents());
        // Agent goal is a soft target for Power Queue texts (not a hard cap).
        // Lifestyle Bot's standalone run is deprecated — Pond Nurture handles all emails now.
        // The bot's "goal" is informational only (shows Pond Nurture volume in its row).
        const AGENT_GOAL = 10;
        const [todayRows, weekRows] = await Promise.all([
          getSmsSentTodayByAgent(),
          getSmsSentLastWeekByAgent(),
        ]);
        const todayMap: Record<string, number> = {};
        for (const r of todayRows) todayMap[r.agentName] = r.todayTexts;
        const weekMap: Record<string, number> = {};
        for (const r of weekRows) weekMap[r.agentName] = r.weekTexts;
        const agents = ROSTER.map(name => {
          const goal = AGENT_GOAL; // Uniform soft target for all
          const todayCount = todayMap[name] ?? 0;
          return {
            name,
            isBot: name === "Lifestyle Bot",
            todayCount,
            weekCount: weekMap[name] ?? 0,
            goal,
            pct: goal > 0 ? Math.min(100, Math.round((todayCount / goal) * 100)) : 0,
          };
        });
        const totalToday = agents.reduce((s, a) => s + a.todayCount, 0);
        const totalWeek = agents.reduce((s, a) => s + a.weekCount, 0);
        return { agents, totalToday, totalWeek };
      }),

    /**
     * Returns the N most recent bot run records for the dashboard history panel.
     */
    getRunHistory: publicProcedure
      .query(async () => {
        return getRecentBotRuns(10);
      }),

    /**
     * Manually triggers the Lifestyle Bot.
     * Returns the full LifestyleBotResult so the dashboard can show what happened.
     */
    runNow: publicProcedure
      .mutation(async () => {
        const result = await runLifestyleBot("manual");
        return result;
      }),

    /**
     * Returns the last 5 bot monitor run records for the dashboard System Monitor section.
     * Parses the JSON findings field so the UI gets typed objects.
     */
    getMonitorStatus: publicProcedure
      .query(async () => {
        const runs = await getRecentMonitorRuns(5);
        return runs.map(r => ({
          ...r,
          findings: (() => {
            try { return JSON.parse(r.findings ?? "[]") as Array<{ check: string; status: string; detail: string }>; }
            catch { return [] as Array<{ check: string; status: string; detail: string }>; }
          })(),
        }));
      }),

    /**
     * Manually triggers the Bot Monitor engine.
     * Returns the full MonitorResult so the dashboard can show what was checked.
     */
    runMonitorNow: publicProcedure
      .mutation(async () => {
        const result = await runBotMonitor("manual");
        // Persist to DB (non-blocking)
        insertMonitorLog({
          runAt: new Date(result.ranAt),
          checksRun: result.checksRun,
          issuesFound: result.issuesFound,
          issuesFixed: result.issuesFixed,
          findings: JSON.stringify(result.findings),
          summary: result.summary,
          triggeredBy: result.triggeredBy,
          durationMs: result.durationMs,
        }).catch(e => console.warn("[runMonitorNow] DB log failed:", e));
        return result;
      }),

    /**
     * Returns recent bot_observations rows for the live feed UI.
     * limit: max rows to return (default 50)
     * hoursBack: how many hours back to look (default 25)
     */
    getObservations: publicProcedure
      .input(z.object({
        limit: z.number().min(1).max(200).optional(),
        hoursBack: z.number().min(1).max(72).optional(),
      }).optional())
      .query(async ({ input }) => {
        const limit = input?.limit ?? 50;
        const hoursBack = input?.hoursBack ?? 25;
        return getRecentObservations(limit, hoursBack);
      }),

    /**
     * Mark a specific observation as manually fixed.
     */
    markObsFixed: publicProcedure
      .input(z.object({ id: z.number(), note: z.string().optional() }))
      .mutation(async ({ input }) => {
        await markObservationFixed(input.id, input.note ?? "Manually marked fixed");
        return { ok: true };
      }),

    /**
     * Manually triggers the Auto-Pond Promotion job.
     * Moves all agent leads created 20+ days ago to the pond.
     */
    runAutoPondNow: publicProcedure
      .mutation(async () => {
        const result = await runAutoPondPromotion("manual");
        return result;
      }),

    /**
     * Returns the N most recent auto-pond promotion run records.
     */
    getPondPromotionHistory: publicProcedure
      .query(async () => {
        return getRecentPondPromotionRuns(10);
      }),

    /**
     * Manually triggers the Bounce Handler.
     * Scans Gmail for permanent delivery failures and processes each bounced lead.
     */
    runBounceNow: publicProcedure
      .mutation(async () => {
        const result = await runBounceHandler();
        return result;
      }),

    /**
     * One-time setup: registers the nightly auto-pond-promotion heartbeat cron.
     * Must be called after the site is deployed (production URL required).
     * 2am CT = 07:00 UTC daily.
     */
    setupAutoPondSchedule: protectedProcedure
      .mutation(async ({ ctx }) => {
        const sessionToken = parseCookie(ctx.req.headers.cookie ?? "")[COOKIE_NAME] ?? "";
        const job = await createHeartbeatJob({
          name: "auto-pond-promotion-nightly",
          cron: "0 0 7 * * *", // 2am CT = 07:00 UTC
          path: "/api/scheduled/auto-pond-promotion",
          description: "Nightly job: moves agent leads created 20+ days ago to the pond for Lifestyle Bot nurturing",
        }, sessionToken);
        return { ok: true, taskUid: job.taskUid, nextExecutionAt: job.nextExecutionAt };
      }),
  }),

  /**
   * Unified Compliance Layer — Power Queue "Mark as Unsubscribe" and suppression queries.
   */
  compliance: router({
    /**
     * Mark a lead as unsubscribed from the Power Queue.
     * Triggers full compliance flow: FUB Trash + opt-out tag + FUB note + DB record.
     */
    markUnsubscribe: publicProcedure
      .input(z.object({
        personId: z.number(),
        leadName: z.string().optional(),
        agentName: z.string().optional(),
        reason: z.enum(["unsubscribe", "bounce_no_phone", "opt_out_reply", "agent_marked", "manual"]).default("agent_marked"),
      }))
      .mutation(async ({ input }) => {
        const result = await suppressLead({
          personId: input.personId,
          reason: input.reason,
          source: "power_queue",
          leadName: input.leadName,
          agentName: input.agentName,
        });
        return result;
      }),

    /**
     * Check if a single lead is suppressed.
     */
    isLeadSuppressed: publicProcedure
      .input(z.object({ personId: z.number() }))
      .query(async ({ input }) => {
        const suppressed = await isLeadSuppressed(input.personId);
        return { suppressed };
      }),

    /**
     * Get the full suppression list for the dashboard.
     */
    getSuppressionList: publicProcedure
      .input(z.object({ limit: z.number().optional() }))
      .query(async ({ input }) => {
        return getSuppressionList(input.limit ?? 200);
      }),
  }),
});

export type AppRouter = typeof appRouter;

