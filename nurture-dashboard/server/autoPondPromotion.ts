/**
 * Auto-Pond Promotion Engine
 *
 * Runs nightly to move stale agent leads to the pond.
 *
 * Rule: Any lead CREATED more than 20 days ago that is still assigned to an agent
 * (not already in the pond) and not in a protected stage → move to pond (pondId=2).
 *
 * Why `created` and NOT `lastActivity`:
 *   lastActivity resets every time the bot emails a lead, so a lead created 14 months
 *   ago will always look "recently active." The 20-day window is about how long a lead
 *   has been in the system, not when the bot last touched them.
 *
 * Protected stages (never moved): Active Client, Pending, Closed, Past Client,
 *   Sphere, Under Contract, Trash
 *
 * Protected tags (never moved): do not contact, realtor, bounced, unsubscribe,
 *   email opt out, dnc, do not nurture, no ai email, do not email, manual review
 */

import crypto from "crypto";
import { getDb, writeObservation } from "./db";
import { pondPromotionLog } from "../drizzle/schema";

// ── Config ────────────────────────────────────────────────────────────────────

const POND_ID = 2;
const STALE_DAYS = 20;
const FUB_BASE = "https://api.followupboss.com/v1";
const FUB_TIMEOUT_MS = 15_000;
const MAX_PER_RUN = 500; // safety cap per run

const PROTECTED_STAGES = new Set([
  "active client", "pending", "closed", "past client",
  "sphere", "under contract", "trash",
]);

const PROTECTED_TAGS = new Set([
  "do not contact", "realtor", "bounced", "unsubscribe",
  "email opt out", "dnc", "do not nurture", "no ai email",
  "do not email", "manual review",
]);

// Excluded FUB user IDs (inactive agents)
const EXCLUDED_USER_IDS = new Set([16, 34]);

// ── FUB helpers ───────────────────────────────────────────────────────────────

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

function personName(p: any): string {
  const fn = (p.firstName ?? "").trim();
  const ln = (p.lastName ?? "").trim();
  return [fn, ln].filter(Boolean).join(" ") || `Lead#${p.id}`;
}

function isProtected(person: any): boolean {
  const stage = String(person.stage ?? "").toLowerCase();
  if (PROTECTED_STAGES.has(stage)) return true;
  const tags: string[] = (person.tags ?? []).map((t: string) => t.toLowerCase());
  if (tags.some(t => PROTECTED_TAGS.has(t))) return true;
  return false;
}

// ── Main promotion function ───────────────────────────────────────────────────

export interface AutoPondPromotionResult {
  promoted: number;
  skipped: number;
  errors: number;
  durationMs: number;
  runId: string;
  triggeredBy: "cron" | "manual";
  summary: string;
  details: Array<{ id: number; name: string; agentId: number; daysOld: number; action: "promoted" | "skipped" | "error"; reason?: string }>;
}

export async function runAutoPondPromotion(
  triggeredBy: "cron" | "manual" = "cron"
): Promise<AutoPondPromotionResult> {
  const runId = crypto.randomUUID().slice(0, 16);
  const startMs = Date.now();
  console.log(`[AutoPondPromotion] Starting run ${runId} (triggered by: ${triggeredBy})`);

  await writeObservation({
    source: "auto_pond_promotion",
    severity: "info",
    category: "run_start",
    message: `Auto-pond promotion started (${triggeredBy})`,
    detail: `runId: ${runId}`,
    autoFixable: 0,
  });

  let promoted = 0;
  let skipped = 0;
  let errors = 0;
  const details: AutoPondPromotionResult["details"] = [];

  try {
    // Fetch all leads created more than 20 days ago that still have an assigned agent
    // and are NOT already in a pond.
    const cutoffDate = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoffDate.toISOString().replace(/\.\d{3}Z$/, "Z");

    const PAGE_SIZE = 100;
    const allCandidates: any[] = [];
    let offset = 0;

    while (allCandidates.length < MAX_PER_RUN) {
      await new Promise(r => setTimeout(r, 300)); // rate limit courtesy
      const data = await fubRequest(
        "GET",
        `/people?limit=${PAGE_SIZE}&offset=${offset}&createdBefore=${cutoffStr}&sort=-created&fields=allFields`
      );
      const batch: any[] = data?.people ?? [];
      if (batch.length === 0) break;

      // Pre-filter: only leads with an assigned agent, not already in pond
      for (const p of batch) {
        if (!p.assignedUserId) continue; // no agent = already unassigned
        if (p.assignedPondId) continue;  // already in pond
        if (EXCLUDED_USER_IDS.has(Number(p.assignedUserId))) continue; // inactive agent
        allCandidates.push(p);
        if (allCandidates.length >= MAX_PER_RUN) break;
      }

      if (batch.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
      if (offset >= 2000) break; // FUB hard cap
    }

    console.log(`[AutoPondPromotion] Found ${allCandidates.length} candidates to evaluate`);

    // Process each candidate
    for (const person of allCandidates) {
      const personId = Number(person.id);
      const name = personName(person);
      const agentId = Number(person.assignedUserId);

      // Calculate days since created
      const createdStr = person.created ?? person.createdAt ?? "";
      let daysOld = STALE_DAYS + 1;
      if (createdStr) {
        try {
          daysOld = Math.floor((Date.now() - new Date(createdStr).getTime()) / (24 * 60 * 60 * 1000));
        } catch { /* use default */ }
      }

      // Skip protected leads
      if (isProtected(person)) {
        skipped++;
        details.push({ id: personId, name, agentId, daysOld, action: "skipped", reason: `Protected stage/tag: ${person.stage}` });
        continue;
      }

      // Move to pond
      try {
        await fubRequest("PUT", `/people/${personId}`, { assignedPondId: POND_ID });
        await fubRequest("POST", "/notes", {
          personId,
          subject: "🔄 Automation: Moved to Lead Pond",
          body: `Lead was created ${daysOld} days ago and has not converted to an active client.\n\n` +
            `Automatically moved to the Lead Pond for ongoing AI-powered nurturing via the Lifestyle Bot.\n\n` +
            `If this lead re-engages with buying intent, they will be automatically reassigned to an agent.`,
          isHtml: false,
        });
        promoted++;
        details.push({ id: personId, name, agentId, daysOld, action: "promoted" });
        console.log(`[AutoPondPromotion] Promoted: ${name} (${personId}) — ${daysOld} days old`);
      } catch (e) {
        errors++;
        const msg = e instanceof Error ? e.message : String(e);
        details.push({ id: personId, name, agentId, daysOld, action: "error", reason: msg.slice(0, 100) });
        console.warn(`[AutoPondPromotion] Failed to promote ${name} (${personId}):`, msg);
      }

      // Rate limit: 300ms between writes
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[AutoPondPromotion] Fatal error in run ${runId}:`, msg);
    await writeObservation({
      source: "auto_pond_promotion",
      severity: "error",
      category: "run_error",
      message: "Auto-pond promotion fatal error",
      detail: msg.slice(0, 500),
      autoFixable: 0,
    });
  }

  const durationMs = Date.now() - startMs;
  const summary = `Promoted ${promoted} leads to pond, skipped ${skipped}, ${errors} errors (${Math.round(durationMs / 1000)}s)`;

  // Persist run log to DB
  try {
    const db = await getDb();
    if (db) {
      await db.insert(pondPromotionLog).values({
        ranAt: new Date(),
        promoted,
        skipped,
        errors,
        triggeredBy,
        durationMs,
        summary,
      });
    }
  } catch (e) {
    console.warn(`[AutoPondPromotion] DB log failed:`, e instanceof Error ? e.message : e);
  }

  await writeObservation({
    source: "auto_pond_promotion",
    severity: promoted > 0 ? "info" : "info",
    category: "run_complete",
    message: `Auto-pond promotion complete: ${summary}`,
    detail: `runId: ${runId} | promoted: ${promoted} | skipped: ${skipped} | errors: ${errors}`,
    autoFixable: 0,
  });

  console.log(`[AutoPondPromotion] Complete: ${summary}`);

  return {
    promoted,
    skipped,
    errors,
    durationMs,
    runId,
    triggeredBy,
    summary,
    details,
  };
}

/**
 * Returns the N most recent auto-pond promotion run records.
 */
export async function getRecentPondPromotionRuns(limit = 10): Promise<typeof pondPromotionLog.$inferSelect[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select()
      .from(pondPromotionLog)
      .orderBy(pondPromotionLog.ranAt)
      .limit(limit);
    return rows.reverse();
  } catch (e) {
    console.warn("[AutoPondPromotion] getRecentPondPromotionRuns failed:", e instanceof Error ? e.message : e);
    return [];
  }
}
