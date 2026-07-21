/**
 * Speed-to-Lead Engine (Heartbeat-based)
 *
 * Fires every 5 minutes via heartbeat cron. Self-limits to Mon-Fri 10am-6pm CT.
 * Business rules:
 * - Polls FUB for leads created in the last 24h
 * - Starts a timer for any lead assigned to a non-Peter agent
 * - At 30 business minutes: sends a warning note + creates a FUB task
 * - At 60 business minutes: reassigns to Peter + sends final note
 * - Timer canceled if agent touches the lead (call, text, email, or note after creation)
 *
 * All state is persisted in the `speed_to_lead_timers` MySQL table.
 */

import { eq, and } from "drizzle-orm";
import { getDb } from "./db";
import { speedToLeadTimers } from "../drizzle/schema";
import { writeObservation } from "./db";

// ─── Configuration ───────────────────────────────────────────────────────────

const PETER_USER_ID = 2; // Peter Allen's FUB user ID
const PETER_NAME = "Peter Allen";
const WARNING_MINUTES = 30; // Business minutes before warning
const REASSIGN_MINUTES = 60; // Business minutes before reassignment
const FUB_BASE = "https://api.followupboss.com/v1";
const FUB_TIMEOUT_MS = 15_000;

// Excluded user IDs (Peter, system accounts)
const EXCLUDED_USER_IDS = [PETER_USER_ID];

// Excluded stages — leads in these stages should not trigger speed-to-lead
const EXCLUDED_STAGES = new Set([
  "trash", "active", "under contract", "closed", "past client",
  "sphere", "do not contact", "agent"
]);

// Excluded tags
const EXCLUDED_TAGS = new Set([
  "unsubscribe", "unsubscribed", "do not contact", "dnc",
  "bounced", "realtor", "agent", "do not nurture", "no ai email"
]);

// ─── FUB API Helpers ─────────────────────────────────────────────────────────

function getFubAuth(): string {
  const key = process.env.FUB_API_KEY;
  if (!key) throw new Error("FUB_API_KEY not configured");
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

async function fubRequest(
  method: "GET" | "PUT" | "POST",
  path: string,
  body?: object
): Promise<any> {
  const auth = getFubAuth();
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt - 1), 8000)));
    }
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), FUB_TIMEOUT_MS);
    try {
      const res = await fetch(`${FUB_BASE}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: auth,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (res.status === 429) {
        const ra = parseInt(res.headers.get("Retry-After") ?? "5", 10);
        await new Promise(r => setTimeout(r, Math.min(ra * 1000, 10_000)));
        continue;
      }
      if (res.status >= 500) {
        lastError = new Error(`FUB ${method} ${path} server error ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`FUB ${method} ${path} failed ${res.status}: ${txt.slice(0, 200)}`);
      }
      if (res.status === 204 || res.headers.get("content-length") === "0") return {};
      return res.json();
    } catch (e) {
      clearTimeout(tid);
      if (e instanceof Error && e.name === "AbortError") {
        lastError = new Error(`FUB ${method} ${path} timed out`);
        continue;
      }
      if (e instanceof Error && !e.message.includes("server error") && !e.message.includes("timed out")) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error(`FUB ${method} ${path} failed after 3 attempts`);
}

// ─── Business Hours Logic ────────────────────────────────────────────────────

function isBusinessHours(): boolean {
  const now = new Date();
  // Convert to CT
  const ct = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const hour = ct.getHours();
  const day = ct.getDay(); // 0=Sun, 6=Sat
  // Mon-Fri 10am-6pm CT
  return day >= 1 && day <= 5 && hour >= 10 && hour < 18;
}

/**
 * Calculate elapsed business minutes between two dates.
 * Only counts Mon-Fri 10am-6pm CT (480 business minutes per day).
 */
function businessMinutesElapsed(startUtc: Date, endUtc: Date): number {
  const CT = "America/Chicago";
  let minutes = 0;
  const cursor = new Date(startUtc);

  // Walk forward minute by minute (optimized: skip non-business chunks)
  while (cursor < endUtc) {
    const ctStr = cursor.toLocaleString("en-US", { timeZone: CT });
    const ct = new Date(ctStr);
    const hour = ct.getHours();
    const day = ct.getDay();

    if (day >= 1 && day <= 5 && hour >= 10 && hour < 18) {
      // In business hours — count remaining minutes in this hour or until endUtc
      const endOfHour = new Date(cursor);
      endOfHour.setMinutes(endOfHour.getMinutes() + (60 - ct.getMinutes()));
      const chunkEnd = endOfHour < endUtc ? endOfHour : endUtc;
      const chunkMinutes = Math.floor((chunkEnd.getTime() - cursor.getTime()) / 60000);
      minutes += Math.max(chunkMinutes, 1);
      cursor.setTime(chunkEnd.getTime());
    } else {
      // Skip to next business hour
      if (day === 0) {
        // Sunday → skip to Monday 10am
        cursor.setTime(cursor.getTime() + 24 * 60 * 60000); // next day
        const nextCt = new Date(cursor.toLocaleString("en-US", { timeZone: CT }));
        nextCt.setHours(10, 0, 0, 0);
        cursor.setTime(new Date(nextCt.toLocaleString("en-US", { timeZone: "UTC" })).getTime());
      } else if (day === 6) {
        // Saturday → skip to Monday 10am
        cursor.setTime(cursor.getTime() + 2 * 24 * 60 * 60000);
        const nextCt = new Date(cursor.toLocaleString("en-US", { timeZone: CT }));
        nextCt.setHours(10, 0, 0, 0);
        cursor.setTime(new Date(nextCt.toLocaleString("en-US", { timeZone: "UTC" })).getTime());
      } else if (hour < 10) {
        // Before business hours → skip to 10am
        const ctNow = new Date(cursor.toLocaleString("en-US", { timeZone: CT }));
        const skipMinutes = (10 - hour) * 60 - ctNow.getMinutes();
        cursor.setTime(cursor.getTime() + skipMinutes * 60000);
      } else {
        // After business hours → skip to next day 10am
        cursor.setTime(cursor.getTime() + (24 - hour + 10) * 60 * 60000);
        const nextCt = new Date(cursor.toLocaleString("en-US", { timeZone: CT }));
        nextCt.setHours(10, 0, 0, 0);
        cursor.setTime(new Date(nextCt.toLocaleString("en-US", { timeZone: "UTC" })).getTime());
      }
    }
  }

  return minutes;
}

// ─── Lead Exclusion Checks ───────────────────────────────────────────────────

function isExcluded(person: any): boolean {
  // Stage check
  const stage = String(person.stage ?? "").toLowerCase();
  if (EXCLUDED_STAGES.has(stage)) return true;

  // Tag check
  const tags: string[] = (person.tags ?? []).map((t: string) => t.toLowerCase());
  for (const tag of tags) {
    if (EXCLUDED_TAGS.has(tag)) return true;
  }

  // Unsubscribe check
  if (person.unsubscribed || person.emailOptOut) return true;

  return false;
}

// ─── Touch Detection ─────────────────────────────────────────────────────────

/**
 * Check if the assigned agent has touched the lead after it was created.
 * A "touch" = any call, text, email, or note logged after lead creation.
 */
async function hasAgentTouched(personId: number, leadCreatedAt: string, assignedUserId: number): Promise<boolean> {
  const createdDate = new Date(leadCreatedAt);

  // Check calls
  try {
    const callsData = await fubRequest("GET", `/calls?personId=${personId}&limit=5&sort=-createdAt`);
    const calls = callsData?.calls ?? [];
    for (const call of calls) {
      if (new Date(call.created) > createdDate) return true;
    }
  } catch { /* ignore */ }

  // Check text messages
  try {
    const textsData = await fubRequest("GET", `/textMessages?personId=${personId}&limit=5&sort=-createdAt`);
    const texts = textsData?.textmessages ?? textsData?.textMessages ?? [];
    for (const txt of texts) {
      if (!txt.isIncoming && new Date(txt.created || txt.dateCreated) > createdDate) return true;
    }
  } catch { /* ignore */ }

  // Check emails (outgoing only)
  try {
    const emailsData = await fubRequest("GET", `/emails?personId=${personId}&limit=5&sort=-createdAt`);
    const emails = emailsData?.emails ?? [];
    for (const email of emails) {
      if (!email.isIncoming && new Date(email.created) > createdDate) return true;
    }
  } catch { /* ignore */ }

  // Check notes (any note after creation = agent engagement)
  try {
    const notesData = await fubRequest("GET", `/notes?personId=${personId}&limit=5&sort=-createdAt`);
    const notes = notesData?.notes ?? [];
    for (const note of notes) {
      // Skip automation notes
      const subject = String(note.subject ?? "").toLowerCase();
      if (subject.includes("automation:") || subject.includes("bot:")) continue;
      if (new Date(note.created) > createdDate) return true;
    }
  } catch { /* ignore */ }

  return false;
}

// ─── FUB User Cache ──────────────────────────────────────────────────────────

let _userCache: Map<number, any> | null = null;
let _userCacheTime = 0;

async function getUserCache(): Promise<Map<number, any>> {
  const now = Date.now();
  if (_userCache && now - _userCacheTime < 300_000) return _userCache; // 5 min cache

  try {
    const data = await fubRequest("GET", "/users?limit=100");
    const users = data?.users ?? [];
    _userCache = new Map(users.map((u: any) => [Number(u.id), u]));
    _userCacheTime = now;
  } catch {
    if (!_userCache) _userCache = new Map();
  }
  return _userCache;
}

// ─── Main Engine ─────────────────────────────────────────────────────────────

export interface SpeedToLeadResult {
  skipped?: string;
  newTimersStarted: number;
  warnings: number;
  reassignments: number;
  canceled: number;
  errors: string[];
}

export async function runSpeedToLead(): Promise<SpeedToLeadResult> {
  const result: SpeedToLeadResult = {
    newTimersStarted: 0,
    warnings: 0,
    reassignments: 0,
    canceled: 0,
    errors: [],
  };

  // Only run during business hours
  if (!isBusinessHours()) {
    result.skipped = "outside-business-hours";
    return result;
  }

  const fubApiKey = process.env.FUB_API_KEY;
  if (!fubApiKey) {
    result.skipped = "no-api-key";
    return result;
  }

  const db = await getDb();
  if (!db) {
    result.skipped = "no-database";
    return result;
  }

  const now = new Date();

  // ─── Step 1: Poll for new leads (created in last 24h) ───────────────────
  try {
    const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const cutoffStr = cutoff24h.toISOString().replace("T", " ").slice(0, 19);

    const data = await fubRequest("GET", `/people?sort=created&createdAfter=${encodeURIComponent(cutoffStr)}&limit=100&fields=allFields`);
    const recentLeads: any[] = data?.people ?? [];

    // Get existing timers to avoid duplicates
    const existingTimers = await db.select({ personId: speedToLeadTimers.personId })
      .from(speedToLeadTimers);
    const existingPersonIds = new Set(existingTimers.map(t => t.personId));

    const userCache = await getUserCache();

    for (const person of recentLeads) {
      const personId = Number(person.id);
      if (existingPersonIds.has(personId)) continue;

      const assignedUserId = Number(person.assignedUserId);
      if (!assignedUserId || EXCLUDED_USER_IDS.includes(assignedUserId)) continue;
      if (isExcluded(person)) continue;
      // Skip if already in a pond
      if (person.assignedPondId) continue;

      const agentUser = userCache.get(assignedUserId);
      const agentName = agentUser?.name ?? "";

      try {
        await db.insert(speedToLeadTimers).values({
          personId,
          assignedUserId,
          agentName,
          leadCreatedAt: person.created ?? now.toISOString(),
          status: "active",
        });
        result.newTimersStarted++;
        console.log(`[SpeedToLead] Timer started for lead ${personId} (agent: ${agentName})`);
      } catch (e: any) {
        // Duplicate key = already tracked, ignore
        if (!e.message?.includes("Duplicate")) {
          result.errors.push(`Insert timer ${personId}: ${e.message}`);
        }
      }
    }
  } catch (e: any) {
    result.errors.push(`Poll new leads: ${e.message}`);
    console.error("[SpeedToLead] Failed to poll new leads:", e.message);
  }

  // ─── Step 2: Process active timers ──────────────────────────────────────
  try {
    const activeTimers = await db.select()
      .from(speedToLeadTimers)
      .where(
        and(
          eq(speedToLeadTimers.status, "active"),
        )
      );

    const warnedTimers = await db.select()
      .from(speedToLeadTimers)
      .where(
        and(
          eq(speedToLeadTimers.status, "warned"),
        )
      );

    const allTimers = [...activeTimers, ...warnedTimers];

    for (const timer of allTimers) {
      try {
        const leadCreated = new Date(timer.leadCreatedAt);
        const elapsedMin = businessMinutesElapsed(leadCreated, now);

        // Check if agent has touched the lead
        const touched = await hasAgentTouched(timer.personId, timer.leadCreatedAt, timer.assignedUserId);
        if (touched) {
          await db.update(speedToLeadTimers)
            .set({ status: "canceled", canceledAt: now, cancelReason: "agent_touched" })
            .where(eq(speedToLeadTimers.personId, timer.personId));
          result.canceled++;
          console.log(`[SpeedToLead] Timer canceled (agent touched): lead ${timer.personId}`);
          continue;
        }

        // Check for reassignment threshold (60 min)
        if (elapsedMin >= REASSIGN_MINUTES) {
          // Send warning if not already warned
          if (timer.status === "active") {
            const warningBody = (
              `@${timer.agentName} 🚨 **SPEED-TO-LEAD: LEAD BEING REASSIGNED** 🚨\n\n` +
              `This new lead was assigned to you but no first touch was detected after ` +
              `**${REASSIGN_MINUTES} business minutes**.\n\n` +
              `⚠️ This lead has been automatically returned to ${PETER_NAME} for reassignment.`
            );
            await fubRequest("POST", "/notes", {
              personId: timer.personId,
              subject: "Automation: speed-to-lead reassignment",
              body: warningBody,
              isHtml: false,
            });
          }

          // Reassign to Peter
          await fubRequest("PUT", `/people/${timer.personId}`, { assignedUserId: PETER_USER_ID });

          // Add reassignment tag
          try {
            const personData = await fubRequest("GET", `/people/${timer.personId}?fields=tags`);
            const existingTags: string[] = personData?.tags ?? [];
            const merged = Array.from(new Set([...existingTags, "auto-reassigned-speed-to-lead"]));
            await fubRequest("PUT", `/people/${timer.personId}`, { tags: merged });
          } catch { /* tag merge is best-effort */ }

          // Add final note
          await fubRequest("POST", "/notes", {
            personId: timer.personId,
            subject: "Automation: reassigned for no first touch",
            body: `No assigned-agent touch detected within ${REASSIGN_MINUTES} business-time minutes. Lead reassigned to ${PETER_NAME}.`,
            isHtml: false,
          });

          await db.update(speedToLeadTimers)
            .set({ status: "reassigned", reassignedAt: now })
            .where(eq(speedToLeadTimers.personId, timer.personId));
          result.reassignments++;
          console.log(`[SpeedToLead] Lead ${timer.personId} reassigned to Peter (${elapsedMin} biz min elapsed)`);

          await writeObservation({
            source: "speed_to_lead",
            severity: "warning",
            category: "reassignment",
            message: `Speed-to-lead: Lead ${timer.personId} reassigned to ${PETER_NAME} after ${elapsedMin} business minutes`,
            detail: `Agent: ${timer.agentName} (ID: ${timer.assignedUserId})`,
            autoFixable: 0,
          }).catch(() => {});

          continue;
        }

        // Check for warning threshold (30 min)
        if (timer.status === "active" && elapsedMin >= WARNING_MINUTES) {
          const warningBody = (
            `@${timer.agentName} 🚨 **URGENT SPEED-TO-LEAD WARNING** 🚨\n\n` +
            `This new lead was assigned to you, but no first touch (call, text, or email) has been detected after **${WARNING_MINUTES} business minutes**.\n\n` +
            `⚠️ **Action Required**: Please contact this lead immediately!\n` +
            `⏰ **Fallback Reassignment**: If no contact is logged within the next **${REASSIGN_MINUTES - WARNING_MINUTES} minutes**, ` +
            `this lead will be automatically returned to ${PETER_NAME} for reassignment.`
          );

          // Add warning note
          await fubRequest("POST", "/notes", {
            personId: timer.personId,
            subject: "Automation: speed-to-lead warning",
            body: warningBody,
            isHtml: false,
          });

          // Create FUB task for the agent
          if (timer.assignedUserId) {
            try {
              await fubRequest("POST", "/tasks", {
                personId: timer.personId,
                assignedTo: timer.assignedUserId,
                name: `URGENT: touch this new lead within ${WARNING_MINUTES} business-time minutes or it will be reassigned to ${PETER_NAME}`,
                type: "Call",
                dueAt: new Date(now.getTime() + 60000).toISOString(), // Due in 1 minute
              });
            } catch { /* task creation is best-effort */ }
          }

          await db.update(speedToLeadTimers)
            .set({ status: "warned", warnedAt: now })
            .where(eq(speedToLeadTimers.personId, timer.personId));
          result.warnings++;
          console.log(`[SpeedToLead] Warning sent for lead ${timer.personId} (${elapsedMin} biz min, agent: ${timer.agentName})`);

          await writeObservation({
            source: "speed_to_lead",
            severity: "info",
            category: "warning",
            message: `Speed-to-lead warning: Lead ${timer.personId} not touched after ${elapsedMin} business minutes`,
            detail: `Agent: ${timer.agentName} (ID: ${timer.assignedUserId}). Reassignment in ${REASSIGN_MINUTES - elapsedMin} min.`,
            autoFixable: 0,
          }).catch(() => {});
        }
      } catch (e: any) {
        result.errors.push(`Process timer ${timer.personId}: ${e.message}`);
        console.error(`[SpeedToLead] Error processing timer for lead ${timer.personId}:`, e.message);
      }

      // Rate limit courtesy between leads
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (e: any) {
    result.errors.push(`Process timers: ${e.message}`);
    console.error("[SpeedToLead] Failed to process timers:", e.message);
  }

  // ─── Step 3: Cleanup old timers (older than 7 days, non-active) ─────────
  try {
    const cleanupCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    // We don't delete — just log. Old timers serve as audit trail.
    // Could add a prune step later if the table grows too large.
  } catch { /* cleanup is best-effort */ }

  // Log summary
  if (result.newTimersStarted > 0 || result.warnings > 0 || result.reassignments > 0) {
    console.log(`[SpeedToLead] Run complete: ${result.newTimersStarted} new, ${result.warnings} warned, ${result.reassignments} reassigned, ${result.canceled} canceled`);
  }

  return result;
}
