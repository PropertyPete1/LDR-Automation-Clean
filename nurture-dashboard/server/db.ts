import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { BotMonitorLog, BotObservation, BotRunLog, InsertBotMonitorLog, InsertBotObservation, InsertBotRunLog, InsertCopilotFeedback, InsertCopilotMemory, InsertUiErrorLog, InsertUser, botMonitorLog, botObservations, botRunLog, copilotFeedback, copilotMemories, pondNurtureLog, pondPromotionLog, replyIntentProcessed, smsSentToday, uiErrorLog, users } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// ── Copilot Memory helpers ─────────────────────────────────────────────────────

/**
 * Save a new memory for an agent. Deduplicates by trimming to 20 most recent
 * memories per agent so the context doesn't grow unbounded.
 */
export async function saveMemory(memory: InsertCopilotMemory): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(copilotMemories).values(memory);
  // Keep only the 20 most recent memories per agent to avoid context overflow
  const all = await db
    .select({ id: copilotMemories.id })
    .from(copilotMemories)
    .where(eq(copilotMemories.agentName, memory.agentName))
    .orderBy(desc(copilotMemories.createdAt));
  if (all.length > 20) {
    const toDelete = all.slice(20).map((r) => r.id);
    for (const id of toDelete) {
      await db.delete(copilotMemories).where(eq(copilotMemories.id, id));
    }
  }
}

/**
 * Retrieve the top N memories for an agent, ordered by importance then recency.
 */
export async function getMemories(agentName: string, limit = 10) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(copilotMemories)
    .where(eq(copilotMemories.agentName, agentName))
    .orderBy(desc(copilotMemories.importanceScore), desc(copilotMemories.createdAt))
    .limit(limit);
}

// ── Copilot Feedback helpers ────────────────────────────────────────────────────

/**
 * Log a feedback signal for a draft (sent / ignored / regenerated / edited).
 */
export async function logFeedback(feedback: InsertCopilotFeedback): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(copilotFeedback).values(feedback);
}

/**
 * Return the top 5 most-sent draft patterns for an agent (positive signals).
 * Used to teach the Copilot what tone and style actually gets sent.
 */
export async function getWinningPatterns(agentName: string, limit = 5) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(copilotFeedback)
    .where(
      sql`${copilotFeedback.agentName} = ${agentName} AND ${copilotFeedback.action} = 'sent'`
    )
    .orderBy(desc(copilotFeedback.createdAt))
    .limit(limit);
}

// ── UI Error Log helpers (overnight self-healing system) ───────────────────────

/**
 * Write a single error event to the daytime error memory.
 * Called by the tRPC error middleware and the React error boundary.
 * Never throws - error logging must not cause cascading failures.
 */
export async function logUiError(entry: Omit<InsertUiErrorLog, 'id' | 'createdAt' | 'resolvedAt' | 'resolved' | 'fixApplied'>): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return; // DB unavailable - silently skip, don't break the caller
    await db.insert(uiErrorLog).values({
      actor: entry.actor ?? 'unknown',
      action: entry.action,
      errorMessage: entry.errorMessage.slice(0, 500), // cap at 500 chars
      errorDetail: entry.errorDetail?.slice(0, 2000) ?? null,
      category: entry.category ?? 'other',
    });
  } catch (err) {
    // Silently swallow - logging failures must never crash the app
    console.warn('[logUiError] Failed to write error log:', err);
  }
}

/**
 * Fetch all unresolved errors from the past N hours.
 * Called by the nightly healer to get the day's error list.
 */
export async function getUnresolvedErrors(hoursBack = 25) {
  const db = await getDb();
  if (!db) return [];
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
  return db
    .select()
    .from(uiErrorLog)
    .where(and(eq(uiErrorLog.resolved, 'no'), sql`${uiErrorLog.createdAt} >= ${cutoff}`))
    .orderBy(desc(uiErrorLog.createdAt));
}

/**
 * Mark a list of error IDs as resolved with the fix description.
 * Called by the nightly healer after applying a fix.
 */
export async function markErrorsResolved(ids: number[], fixApplied: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  for (const id of ids) {
    await db.update(uiErrorLog)
      .set({ resolved: 'yes', fixApplied, resolvedAt: new Date() })
      .where(eq(uiErrorLog.id, id));
  }
}

/**
 * Mark errors as unfixable (healer tried but couldn’t auto-fix).
 */
export async function markErrorsUnfixable(ids: number[], reason: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  for (const id of ids) {
    await db.update(uiErrorLog)
      .set({ resolved: 'unfixable', fixApplied: reason, resolvedAt: new Date() })
      .where(eq(uiErrorLog.id, id));
  }
}

/**
 * Prune error log rows older than 30 days.
 * Called by the weekly cleanup cron to keep the table lean.
 */
export async function pruneOldErrorLogs(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await db.delete(uiErrorLog).where(lt(uiErrorLog.createdAt, cutoff));
  return (result as any).affectedRows ?? 0;
}

// ── SMS Sent Today helpers (Power Queue cross-restart tracking) ────────────────

/** Returns today's date string in CT (YYYY-MM-DD) */
function getTodayCT(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

/**
 * Record that a lead was texted today via the Power Queue.
 * Persists to DB so the queue stays correct across server restarts.
 * Never throws - must not crash the send flow.
 */
export async function dbRecordSmsSentToday(personId: number, agentName: string): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const sentDate = getTodayCT();
    // Upsert: ignore duplicate if already recorded today
    await db.insert(smsSentToday)
      .values({ personId, agentName, sentDate })
      .onDuplicateKeyUpdate({ set: { agentName } }); // no-op update to satisfy MySQL
  } catch (err) {
    console.warn('[dbRecordSmsSentToday] Failed:', err);
  }
}

/**
 * Returns the set of personIds that were texted today (CT).
 * Used by getPendingQueue to filter already-texted leads.
 */
export async function getSmsSentTodayIds(): Promise<Set<number>> {
  try {
    const db = await getDb();
    if (!db) return new Set();
    const sentDate = getTodayCT();
    const rows = await db
      .select({ personId: smsSentToday.personId })
      .from(smsSentToday)
      .where(eq(smsSentToday.sentDate, sentDate));
    return new Set(rows.map(r => r.personId));
  } catch (err) {
    console.warn('[getSmsSentTodayIds] Failed:', err);
    return new Set();
  }
}

/**
 * Returns the count of leads texted today (CT).
 * Used by getRoster to decrement do_now counts.
 */
export async function getSmsSentTodayCount(): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const sentDate = getTodayCT();
    const result = await db
      .select({ cnt: sql<number>`COUNT(*)` })
      .from(smsSentToday)
      .where(eq(smsSentToday.sentDate, sentDate));
    return Number(result[0]?.cnt ?? 0);
  } catch (err) {
    console.warn('[getSmsSentTodayCount] Failed:', err);
    return 0;
  }
}

/**
 * Get per-agent all-time text counts from the DB.
 * Used by the leaderboard to show accurate numbers merged with clicks.json.
 */
export async function getSmsSentByAgent(): Promise<Array<{ agentName: string; totalTexts: number; lastActive: Date | null }>> {
  try {
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select({
        agentName: smsSentToday.agentName,
        totalTexts: sql<number>`COUNT(*)`,
        lastActive: sql<Date | null>`MAX(${smsSentToday.createdAt})`,
      })
      .from(smsSentToday)
      .groupBy(smsSentToday.agentName)
      .orderBy(sql`COUNT(*) DESC`);
    return rows.map(r => ({ agentName: r.agentName, totalTexts: Number(r.totalTexts), lastActive: r.lastActive }));
  } catch (err) {
    console.warn('[getSmsSentByAgent] Failed:', err);
    return [];
  }
}

/**
 * Get per-agent text counts for today only (CT).
 * Used by the daily SMS goal tracker on the Power Queue page.
 */
export async function getSmsSentTodayByAgent(): Promise<Array<{ agentName: string; todayTexts: number }>> {
  try {
    const db = await getDb();
    if (!db) return [];
    const sentDate = getTodayCT();
    const rows = await db
      .select({
        agentName: smsSentToday.agentName,
        todayTexts: sql<number>`COUNT(*)`,
      })
      .from(smsSentToday)
      .where(eq(smsSentToday.sentDate, sentDate))
      .groupBy(smsSentToday.agentName);
    return rows.map(r => ({ agentName: r.agentName, todayTexts: Number(r.todayTexts) }));
  } catch (err) {
    console.warn('[getSmsSentTodayByAgent] Failed:', err);
    return [];
  }
}

/**
 * Get per-agent text counts for last week (Mon-Sun, CT).
 * Used by the weekly leaderboard email sent every Monday morning.
 */
export async function getSmsSentLastWeekByAgent(): Promise<Array<{ agentName: string; weekTexts: number }>> {
  try {
    const db = await getDb();
    if (!db) return [];
    // Compute last Monday and last Sunday in CT (UTC-5/UTC-6)
    const CT_OFFSET_MS = 6 * 60 * 60 * 1000; // use UTC-6 (CST) as conservative offset
    const nowCT = new Date(Date.now() - CT_OFFSET_MS);
    const dayOfWeek = nowCT.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    // Days since last Monday (today is Monday when this runs, so dayOfWeek=1)
    // We want the PREVIOUS week: Mon to Sun
    const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek; // if Sun=0, go back 6; Mon=1 go back 1
    const lastMonday = new Date(nowCT);
    lastMonday.setUTCDate(nowCT.getUTCDate() - daysToLastMonday);
    const lastSunday = new Date(lastMonday);
    lastSunday.setUTCDate(lastMonday.getUTCDate() + 6);
    const fmt = (d: Date) => d.toISOString().slice(0, 10); // YYYY-MM-DD
    const startDate = fmt(lastMonday);
    const endDate = fmt(lastSunday);
    const rows = await db
      .select({
        agentName: smsSentToday.agentName,
        weekTexts: sql<number>`COUNT(*)`,
      })
      .from(smsSentToday)
      .where(sql`${smsSentToday.sentDate} >= ${startDate} AND ${smsSentToday.sentDate} <= ${endDate}`)
      .groupBy(smsSentToday.agentName)
      .orderBy(sql`COUNT(*) DESC`);
    return rows.map(r => ({ agentName: r.agentName, weekTexts: Number(r.weekTexts) }));
  } catch (err) {
    console.warn('[getSmsSentLastWeekByAgent] Failed:', err);
    return [];
  }
}

// ── Lifestyle Bot Run Log helpers ─────────────────────────────────────────────

/**
 * Insert a record of a Lifestyle Bot run into bot_run_log.
 * Called at the end of every runLifestyleBot() execution.
 */
export async function insertBotRunLog(data: Omit<InsertBotRunLog, 'id' | 'createdAt'>): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(botRunLog).values(data);
  } catch (err) {
    console.warn('[insertBotRunLog] Failed:', err);
  }
}

/**
 * Fetch the N most recent Lifestyle Bot run records, newest first.
 * Used by the dashboard panel to show "Last run: today at 10:02am — 12 leads texted".
 */
export async function getRecentBotRuns(limit = 10): Promise<BotRunLog[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(botRunLog).orderBy(desc(botRunLog.runAt)).limit(limit);
  } catch (err) {
    console.warn('[getRecentBotRuns] Failed:', err);
    return [];
  }
}

/**
 * Prune sms_sent_today rows older than 7 days.
 * Called by the weekly cleanup cron.
 */
export async function pruneOldSmsSentToday(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await db.delete(smsSentToday).where(lt(smsSentToday.createdAt, cutoff));
  return (result as any).affectedRows ?? 0;
}

// ── Bot Monitor Log helpers ───────────────────────────────────────────────────

/**
 * Insert a record of a Bot Monitor run into bot_monitor_log.
 * Called at the end of every runBotMonitor() execution.
 */
export async function insertMonitorLog(
  data: Omit<InsertBotMonitorLog, 'id' | 'createdAt'>
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(botMonitorLog).values(data);
  } catch (err) {
    console.warn('[insertMonitorLog] Failed:', err);
  }
}

/**
 * Fetch the N most recent Bot Monitor run records, newest first.
 * Used by the dashboard panel to show what the monitor last checked.
 */
export async function getRecentMonitorRuns(limit = 5): Promise<BotMonitorLog[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(botMonitorLog).orderBy(desc(botMonitorLog.runAt)).limit(limit);
  } catch (err) {
    console.warn('[getRecentMonitorRuns] Failed:', err);
    return [];
  }
}

// ── Bot Observations (unified cross-bot observation log) ──────────────────────

/**
 * Write a single observation from any bot/system.
 * All automated systems call this to log what they see — the nightly healer
 * reads these rows to understand the full system state.
 */
export async function writeObservation(
  data: Omit<InsertBotObservation, 'id' | 'createdAt' | 'fixedAt' | 'fixNote'>
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(botObservations).values({
      ...data,
      autoFixable: data.autoFixable ?? 0,
    });
  } catch (err) {
    // Never throw — observation writes are best-effort
    console.warn('[writeObservation] Failed:', err);
  }
}

/**
 * Fetch the N most recent observations across all sources, newest first.
 * Used by the dashboard UI feed and the nightly healer.
 */
export async function getRecentObservations(limit = 50, hoursBack = 25): Promise<BotObservation[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    return db.select().from(botObservations)
      .where(gte(botObservations.createdAt, cutoff))
      .orderBy(desc(botObservations.createdAt))
      .limit(limit);
  } catch (err) {
    console.warn('[getRecentObservations] Failed:', err);
    return [];
  }
}

/**
 * Fetch all unfixed warning/error observations from the last N hours.
 * The nightly healer calls this to decide what to fix.
 */
export async function getUnfixedObservations(hoursBack = 25): Promise<BotObservation[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    return db.select().from(botObservations)
      .where(
        and(
          sql`${botObservations.severity} IN ('warning', 'error')`,
          sql`${botObservations.fixedAt} IS NULL`,
          sql`${botObservations.createdAt} >= ${cutoff.toISOString()}`
        )
      )
      .orderBy(desc(botObservations.createdAt))
      .limit(500);
  } catch (err) {
    console.warn('[getUnfixedObservations] Failed:', err);
    return [];
  }
}

/**
 * Mark an observation as fixed by the nightly healer.
 */
export async function markObservationFixed(id: number, fixNote: string): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.update(botObservations)
      .set({ fixedAt: new Date(), fixNote, severity: 'fixed' })
      .where(eq(botObservations.id, id));
  } catch (err) {
    console.warn('[markObservationFixed] Failed:', err);
  }
}

/**
 * Prune observations older than N days to prevent unbounded table growth.
 * Called by the nightly healer as part of its cleanup stage.
 */
export async function pruneOldObservations(daysBack = 30): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const result = await db.delete(botObservations)
      .where(lt(botObservations.createdAt, cutoff));
    return (result as any)[0]?.affectedRows ?? 0;
  } catch (err) {
    console.warn('[pruneOldObservations] Failed:', err);
    return 0;
  }
}

/**
 * Build a summary of what the nightly healer fixed overnight.
 * Returns counts and a list of human-readable fix descriptions for the clock-in email.
 * Looks at the last 10 hours (healer runs at 4am CT, clock-in at 10am CT).
 */
export interface OvernightHealerSummary {
  totalFixed: number;
  totalUiErrorsResolved: number;
  fixDescriptions: string[]; // up to 5 short human-readable lines
  hadIssues: boolean;        // true if anything was fixed
}

export async function getOvernightHealerSummary(): Promise<OvernightHealerSummary> {
  const empty: OvernightHealerSummary = {
    totalFixed: 0,
    totalUiErrorsResolved: 0,
    fixDescriptions: [],
    hadIssues: false,
  };

  try {
    const db = await getDb();
    if (!db) return empty;

    const since = new Date(Date.now() - 10 * 60 * 60 * 1000); // last 10 hours

    // 1. bot_observations that were fixed overnight (severity = 'fixed', fixedAt within window)
    const fixedObs = await db
      .select({
        message: botObservations.message,
        fixNote: botObservations.fixNote,
        source: botObservations.source,
      })
      .from(botObservations)
      .where(
        and(
          sql`${botObservations.severity} = 'fixed'`,
          sql`${botObservations.fixedAt} >= ${since.toISOString()}`
        )
      )
      .orderBy(desc(botObservations.fixedAt))
      .limit(20);

    // 2. ui_error_log rows resolved overnight
    const resolvedUiErrors = await db
      .select({ cnt: sql<number>`COUNT(*)` })
      .from(uiErrorLog)
      .where(
        and(
          sql`${uiErrorLog.resolved} = 'yes' OR ${uiErrorLog.resolved} = 'unfixable'`,
          sql`${uiErrorLog.resolvedAt} >= ${since.toISOString()}`
        )
      );
    const uiCount = Number(resolvedUiErrors[0]?.cnt ?? 0);

    if (fixedObs.length === 0 && uiCount === 0) return empty;

    // Build human-readable descriptions (deduplicated by message)
    const seen = new Set<string>();
    const descriptions: string[] = [];
    for (const obs of fixedObs) {
      const key = obs.fixNote || obs.message;
      if (!seen.has(key)) {
        seen.add(key);
        const note = obs.fixNote ? obs.fixNote : obs.message;
        descriptions.push(`✓ ${note}`);
      }
      if (descriptions.length >= 4) break;
    }
    if (uiCount > 0) {
      descriptions.push(`✓ ${uiCount} UI error${uiCount !== 1 ? 's' : ''} cleared from the dashboard`);
    }

    return {
      totalFixed: fixedObs.length,
      totalUiErrorsResolved: uiCount,
      fixDescriptions: descriptions,
      hadIssues: true,
    };
  } catch (err) {
    console.warn('[getOvernightHealerSummary] Failed:', err);
    return empty;
  }
}


// ── Database Hygiene — Prune Unbounded Tables ─────────────────────────────────

/**
 * Prune bot_run_log rows older than 90 days.
 * Called by the Nightly Healer cleanup stage.
 */
export async function pruneOldBotRunLogs(daysBack = 90): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const result = await db.delete(botRunLog).where(lt(botRunLog.createdAt, cutoff));
    return (result as any)[0]?.affectedRows ?? 0;
  } catch (err) {
    console.warn('[pruneOldBotRunLogs] Failed:', err);
    return 0;
  }
}

/**
 * Prune bot_monitor_log rows older than 60 days.
 * Called by the Nightly Healer cleanup stage.
 */
export async function pruneOldBotMonitorLogs(daysBack = 60): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const result = await db.delete(botMonitorLog).where(lt(botMonitorLog.createdAt, cutoff));
    return (result as any)[0]?.affectedRows ?? 0;
  } catch (err) {
    console.warn('[pruneOldBotMonitorLogs] Failed:', err);
    return 0;
  }
}

/**
 * Prune pond_nurture_log rows older than 90 days.
 * Called by the Nightly Healer cleanup stage.
 */
export async function pruneOldPondNurtureLogs(daysBack = 90): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const result = await db.delete(pondNurtureLog).where(lt(pondNurtureLog.sentAt, cutoff));
    return (result as any)[0]?.affectedRows ?? 0;
  } catch (err) {
    console.warn('[pruneOldPondNurtureLogs] Failed:', err);
    return 0;
  }
}

/**
 * Prune pond_promotion_log rows older than 90 days.
 * Called by the Nightly Healer cleanup stage.
 */
export async function pruneOldPondPromotionLogs(daysBack = 90): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const result = await db.delete(pondPromotionLog).where(lt(pondPromotionLog.ranAt, cutoff));
    return (result as any)[0]?.affectedRows ?? 0;
  } catch (err) {
    console.warn('[pruneOldPondPromotionLogs] Failed:', err);
    return 0;
  }
}

/**
 * Prune reply_intent_processed rows older than 90 days.
 * Called by the Nightly Healer cleanup stage.
 */
export async function pruneOldReplyIntentProcessed(daysBack = 90): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const result = await db.delete(replyIntentProcessed).where(lt(replyIntentProcessed.processedAt, cutoff));
    return (result as any)[0]?.affectedRows ?? 0;
  } catch (err) {
    console.warn('[pruneOldReplyIntentProcessed] Failed:', err);
    return 0;
  }
}

/**
 * Prune copilot_feedback rows older than 180 days.
 * Called by the Nightly Healer cleanup stage.
 */
export async function pruneOldCopilotFeedback(daysBack = 180): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const result = await db.delete(copilotFeedback).where(lt(copilotFeedback.createdAt, cutoff));
    return (result as any)[0]?.affectedRows ?? 0;
  } catch (err) {
    console.warn('[pruneOldCopilotFeedback] Failed:', err);
    return 0;
  }
}
