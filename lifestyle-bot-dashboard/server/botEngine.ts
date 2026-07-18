/**
 * botEngine.ts — Data-Driven Agent Bot Engine
 *
 * Generic engine that processes ALL agents where engineActive=true in the agent_bots table.
 * Reuses the same proven pipeline as the hardcoded bot files (tiffanyBot, abbyBot, etc.)
 * but is entirely data-driven — no code changes needed to add a new agent.
 *
 * Zero-overlap guarantee:
 *   - This engine ONLY processes rows with engineActive=true
 *   - Existing hardcoded bots have engineActive=false in agent_bots
 *   - FUB API scopes each fetch to a single assignedUserId — impossible to cross agents
 *
 * Exports:
 *   - runEngineForAgent(botSlug): Run the follow-up pipeline for one specific engine agent
 *   - sendEngineClockinForAgent(botSlug): Send clock-in email for one engine agent
 *   - sendEngineClockoffForAgent(botSlug, sent, errored, skipped): Send clock-off email
 *   - getActiveEngineAgents(): Returns all engineActive=true agents (used by heartbeat wiring)
 */

import { getDb } from "./db";
import { agentBots } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import type { AgentBot } from "../drizzle/schema";
import {
  MAX_LEADS_PER_RUN,
  fetchLeadsForAgent,
  isEligible,
  shouldSkipLead,
  wasContactedRecently,
  daysStale,
  generateFollowUpMessage,
  sendLeadFollowUpEmail,
  extractEmail,
  postFubNote,
  getSmsSentTodayIds,
  recordSmsSentToday,
  logContactedLead,
  sendClockinEmail,
  sendClockoffEmail,
  writeObservation,
  logBotRun,
  fetchPowerQueueCount,
} from "./botHelpers";

// ─── Legacy Safeguard ───────────────────────────────────────────────────────────

/**
 * LEGACY_BOT_SLUGS — These slugs have dedicated hardcoded bot files
 * (tiffanyBot.ts, abbyBot.ts, etc.) that already run via their own heartbeat schedules.
 * The engine MUST NEVER process these agents even if someone flips engineActive=true,
 * unless a future `legacyRetired` flag is added and set to true.
 *
 * This is a code-level safeguard against double-sending.
 */
const LEGACY_BOT_SLUGS = new Set([
  "sp500",
  "sp500_peter",
  "sp500_steven",
  "tiffany",
  "stefanie",
  "abby",
  "irma",
  "laila",
]);

/** Returns true if the agent is a legacy hardcoded bot that the engine must not process. */
function isLegacyBot(slug: string): boolean {
  return LEGACY_BOT_SLUGS.has(slug);
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Fetch all engine-active agents from the database, excluding legacy bots */
export async function getActiveEngineAgents(): Promise<AgentBot[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(agentBots).where(eq(agentBots.engineActive, true));
  // SAFEGUARD: filter out any legacy bot that somehow has engineActive=true
  return rows.filter(r => !isLegacyBot(r.botSlug));
}

/** Fetch a single agent by slug (regardless of engineActive status) */
async function getAgentBySlug(slug: string): Promise<AgentBot | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select().from(agentBots).where(eq(agentBots.botSlug, slug)).limit(1);
  return row ?? null;
}

// ─── Main Engine Run ────────────────────────────────────────────────────────────

/**
 * Run the follow-up email pipeline for a single engine agent.
 * This is the exact same logic as tiffanyBot/abbyBot/etc., but parameterized.
 */
export async function runEngineForAgent(botSlug: string): Promise<{
  sent: number;
  errored: number;
  skipped: number;
}> {
  // LEGACY SAFEGUARD: check FIRST, before any DB lookup, so it fires regardless of DB state
  if (isLegacyBot(botSlug)) throw new Error(`[Engine] BLOCKED: ${botSlug} is a legacy hardcoded bot — engine refuses to process`);

  const agent = await getAgentBySlug(botSlug);
  if (!agent) throw new Error(`[Engine] Agent not found: ${botSlug}`);
  if (!agent.engineActive) throw new Error(`[Engine] Agent ${botSlug} is not engine-active`);

  const OBSERVATION_SOURCE = `${botSlug}_bot`;

  await writeObservation({
    source: OBSERVATION_SOURCE,
    category: "run_start",
    severity: "info",
    message: `${agent.botName} started at ${new Date().toISOString()}`,
  });

  const alreadySentToday = await getSmsSentTodayIds();
  const allLeads = await fetchLeadsForAgent(agent.fubUserId);

  const candidates = allLeads
    .filter(p => !alreadySentToday.has(p.id) && isEligible(p))
    .slice(0, MAX_LEADS_PER_RUN);

  let sent = 0;
  let errored = 0;
  let skipped = allLeads.length - candidates.length;

  for (const person of candidates) {
    const personId = person.id;
    try {
      // LLM-powered skip check
      const skipCheck = await shouldSkipLead(person);
      if (skipCheck.skip) {
        skipped++;
        await postFubNote(
          personId,
          `[${agent.botName}] Skipped automated follow-up. Reason: ${skipCheck.reason ?? "Notes indicate no follow-up needed"}`
        ).catch(() => {});
        continue;
      }

      // Minimum contact gap check — don't email the same lead within 3 days
      if (await wasContactedRecently(personId)) {
        skipped++;
        continue;
      }

      const staleDays = daysStale(person);
      const stage = person.stage ?? "Lead";
      const leadEmail = extractEmail(person);

      // Generate highly intelligent, context-aware follow-up message
      const { body: message, subject: emailSubject } = await generateFollowUpMessage({
        agentFirstName: agent.agentFirstName,
        agentLastName: agent.agentLastName,
        leadFirstName: person.firstName ?? null,
        daysStale: staleDays,
        stage,
        person, // pass full person for notes context
      });

      // Send email to lead from agent's email address
      if (leadEmail) {
        await sendLeadFollowUpEmail({
          agentEmail: agent.agentEmail,
          agentFirstName: agent.agentFirstName,
          agentLastName: agent.agentLastName,
          leadEmail,
          leadFirstName: person.firstName ?? null,
          messageBody: message,
          subject: emailSubject,
        });
      }

      // Log FUB note
      await postFubNote(
        personId,
        `[${agent.botName}] Follow-up email sent by ${agent.agentFirstName} ${agent.agentLastName} on ${new Date().toLocaleDateString()}.\nSubject: ${emailSubject}\n\n${message}`
      );

      // Log to contacted_leads for dashboard lead list view
      await logContactedLead({
        botSlug: agent.botSlug,
        botName: agent.botName,
        person,
        daysStaleVal: staleDays,
        messageBody: message,
      });

      await recordSmsSentToday(personId, agent.botName);
      alreadySentToday.add(personId);
      sent++;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errored++;
      await writeObservation({
        source: OBSERVATION_SOURCE,
        category: "lead_error",
        severity: "warning",
        message: `${agent.botName} failed on lead ${personId}: ${errMsg}`,
      }).catch(() => {});
    }
  }

  const status = errored > 0 ? "warning" : "ok";

  await writeObservation({
    source: OBSERVATION_SOURCE,
    category: "run_complete",
    severity: errored > 0 ? "warning" : "info",
    message: `${agent.botName} complete: ${sent} sent, ${errored} errors, ${skipped} skipped`,
  });

  await logBotRun({ botName: agent.botName, botSlug: agent.botSlug, sent, errored, skipped, status });
  return { sent, errored, skipped };
}

// ─── Clock-In ───────────────────────────────────────────────────────────────────

/**
 * Send the clock-in email for an engine agent.
 * Calculates leads queued and Power Queue count, then sends the standard clock-in email.
 */
export async function sendEngineClockinForAgent(botSlug: string): Promise<void> {
  const agent = await getAgentBySlug(botSlug);
  if (!agent || !agent.engineActive) return;

  let leadsQueued = 0;
  let powerQueueCount = 0;
  try {
    const alreadySent = await getSmsSentTodayIds();
    const leads = await fetchLeadsForAgent(agent.fubUserId);
    leadsQueued = leads.filter(p => !alreadySent.has(p.id) && isEligible(p)).length;
  } catch { leadsQueued = 0; }

  const pqName = agent.powerQueueName ?? agent.agentFirstName;
  powerQueueCount = await fetchPowerQueueCount(pqName);

  await sendClockinEmail({
    botName: agent.botName,
    agentFirstName: agent.agentFirstName,
    agentLastName: agent.agentLastName,
    agentEmail: agent.agentEmail,
    leadsQueued,
    powerQueueCount,
    accentColor: agent.accentColor,
    headerGradient: agent.headerGradient,
  });
}

// ─── Clock-Off ──────────────────────────────────────────────────────────────────

/**
 * Send the clock-off summary email for an engine agent.
 */
export async function sendEngineClockoffForAgent(
  botSlug: string,
  sent = 0,
  errored = 0,
  skipped = 0
): Promise<void> {
  const agent = await getAgentBySlug(botSlug);
  if (!agent || !agent.engineActive) return;

  await sendClockoffEmail({
    botName: agent.botName,
    agentFirstName: agent.agentFirstName,
    agentLastName: agent.agentLastName,
    agentEmail: agent.agentEmail,
    sent,
    errored,
    skipped,
    accentColor: agent.accentColor,
    headerGradient: agent.headerGradient,
  });
}

// ─── Engine-Level Orchestrators (iterate all active agents) ─────────────────────

/**
 * Run the full follow-up pipeline for ALL engine-active agents.
 * Called by the heartbeat cron at the scheduled time.
 */
export async function runAllEngineAgents(): Promise<{
  results: Array<{ slug: string; sent: number; errored: number; skipped: number }>;
}> {
  const agents = await getActiveEngineAgents();
  const results: Array<{ slug: string; sent: number; errored: number; skipped: number }> = [];

  for (const agent of agents) {
    try {
      const r = await runEngineForAgent(agent.botSlug);
      results.push({ slug: agent.botSlug, ...r });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await writeObservation({
        source: `${agent.botSlug}_bot`,
        category: "bot_crash",
        severity: "error",
        message: `[Engine] Crash running ${agent.botName}: ${errMsg}`,
      }).catch(() => {});
      results.push({ slug: agent.botSlug, sent: 0, errored: 1, skipped: 0 });
    }
  }

  return { results };
}

/**
 * Send clock-in emails for ALL engine-active agents.
 */
export async function sendAllEngineClockins(): Promise<void> {
  const agents = await getActiveEngineAgents();
  for (const agent of agents) {
    try {
      await sendEngineClockinForAgent(agent.botSlug);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await writeObservation({
        source: `${agent.botSlug}_bot`,
        category: "lead_error",
        severity: "warning",
        message: `[Engine] Clock-in failed for ${agent.botName}: ${errMsg}`,
      }).catch(() => {});
    }
  }
}

/**
 * Send clock-off emails for ALL engine-active agents.
 * Reads today's run results from bot_run_logs to populate sent/errored/skipped.
 */
export async function sendAllEngineClockoffs(): Promise<void> {
  const agents = await getActiveEngineAgents();
  const db = await getDb();

  for (const agent of agents) {
    let sent = 0, errored = 0, skipped = 0;
    if (db) {
      // Get today's run results for this bot
      const { botRunLogs } = await import("../drizzle/schema");
      const { desc, gte, and: drizzleAnd } = await import("drizzle-orm");
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const [todayRun] = await db
        .select()
        .from(botRunLogs)
        .where(drizzleAnd(eq(botRunLogs.botSlug, agent.botSlug), gte(botRunLogs.ranAt, todayStart)))
        .orderBy(desc(botRunLogs.ranAt))
        .limit(1);
      if (todayRun) {
        sent = todayRun.sent ?? 0;
        errored = todayRun.errored ?? 0;
        skipped = todayRun.skipped ?? 0;
      }
    }
    try {
      await sendEngineClockoffForAgent(agent.botSlug, sent, errored, skipped);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await writeObservation({
        source: `${agent.botSlug}_bot`,
        category: "lead_error",
        severity: "warning",
        message: `[Engine] Clock-off failed for ${agent.botName}: ${errMsg}`,
      }).catch(() => {});
    }
  }
}
