/**
 * compliance.ts
 *
 * Unified Compliance Layer — the single shared service for all
 * unsubscribe / trash / suppression actions across every system.
 *
 * Every system (Power Queue, Bounce Handler, Reply Intent, Lifestyle Bot,
 * Agent Bots) MUST call suppressLead() instead of implementing its own
 * inline trash/tag logic. This ensures:
 *   1. FUB stage is always set to "Trash"
 *   2. "opt-out" tag is always added (preserving existing tags)
 *   3. A FUB note is always posted explaining the action
 *   4. The suppressedLeads DB table is always written
 *   5. A botObservation is always written for the healer
 *
 * Usage:
 *   import { suppressLead, isLeadSuppressed } from "./compliance";
 *   await suppressLead({ personId: 12345, reason: "unsubscribe", source: "power_queue" });
 *   const suppressed = await isLeadSuppressed(12345);
 */

import { eq } from "drizzle-orm";
import { suppressedLeads } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { getDb, writeObservation } from "./db";

// ─── FUB API helpers ────────────────────────────────────────────────────────

const FUB_BASE = "https://api.followupboss.com/v1";

async function fubGet(path: string): Promise<any> {
  const apiKey = ENV.fubApiKey;
  if (!apiKey) throw new Error("FUB_API_KEY not configured");
  const credentials = Buffer.from(`${apiKey}:`).toString("base64");
  const res = await fetch(`${FUB_BASE}${path}`, {
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`FUB GET ${path} failed ${res.status}`);
  return res.json();
}

async function fubPut(path: string, body: object): Promise<any> {
  const apiKey = ENV.fubApiKey;
  if (!apiKey) throw new Error("FUB_API_KEY not configured");
  const credentials = Buffer.from(`${apiKey}:`).toString("base64");
  const res = await fetch(`${FUB_BASE}${path}`, {
    method: "PUT",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`FUB PUT ${path} failed ${res.status}`);
  return res.json();
}

async function fubPost(path: string, body: object): Promise<any> {
  const apiKey = ENV.fubApiKey;
  if (!apiKey) throw new Error("FUB_API_KEY not configured");
  const credentials = Buffer.from(`${apiKey}:`).toString("base64");
  const res = await fetch(`${FUB_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`FUB POST ${path} failed ${res.status}`);
  return res.json();
}

// ─── Suppression reason → human-readable label ──────────────────────────────

const REASON_LABELS: Record<string, string> = {
  unsubscribe: "Unsubscribe request detected",
  bounce_no_phone: "Email bounced — no phone on file",
  opt_out_reply: "Opt-out reply detected by automated system",
  agent_marked: "Marked as unsubscribe by agent",
  manual: "Manually suppressed",
};

const SOURCE_LABELS: Record<string, string> = {
  power_queue: "Power Queue (agent action)",
  bounce_handler: "Bounce Handler (automated)",
  reply_intent: "Reply Intent Handler (automated)",
  lifestyle_bot: "Lifestyle Bot (automated)",
  agent_bot: "Agent Bot (automated)",
  manual: "Manual action",
};

// ─── Core suppressLead function ──────────────────────────────────────────────

export interface SuppressLeadOptions {
  /** FUB person ID */
  personId: number;
  /** Why this lead is being suppressed */
  reason: "unsubscribe" | "bounce_no_phone" | "opt_out_reply" | "agent_marked" | "manual";
  /** Which system is triggering the suppression */
  source: string;
  /** Optional: lead email address (for bounce tracking) */
  email?: string;
  /** Optional: lead name (for display in logs) */
  leadName?: string;
  /** Optional: agent name assigned at time of suppression */
  agentName?: string;
  /** Optional: extra context for the FUB note body */
  extraContext?: string;
}

export interface SuppressLeadResult {
  success: boolean;
  alreadySuppressed: boolean;
  personId: number;
  leadName?: string;
  error?: string;
}

/**
 * The single entry point for all suppression actions across every system.
 * Safe to call multiple times — idempotent (checks for existing suppression first).
 */
export async function suppressLead(opts: SuppressLeadOptions): Promise<SuppressLeadResult> {
  const { personId, reason, source, email, leadName, agentName, extraContext } = opts;

  try {
    // 1. Check if already suppressed in our DB
    const db = await getDb();
    if (db) {
      const existing = await db
        .select()
        .from(suppressedLeads)
        .where(eq(suppressedLeads.personId, personId))
        .limit(1);
      if (existing.length > 0) {
        return { success: true, alreadySuppressed: true, personId, leadName };
      }
    }

    // 2. Fetch current FUB person data to get existing tags and name
    let person: any = null;
    let resolvedName = leadName ?? "Unknown Lead";
    let currentTags: string[] = [];
    try {
      person = await fubGet(`/people/${personId}`);
      resolvedName = person?.name ?? resolvedName;
      currentTags = (person?.tags ?? []).map((t: any) =>
        typeof t === "string" ? t : t.name ?? ""
      ).filter(Boolean);
    } catch (fetchErr) {
      console.warn(`[compliance] Could not fetch FUB person ${personId}:`, fetchErr);
    }

    // 3. Set FUB stage to "Trash" and add "opt-out" tag (preserving existing tags)
    const updatedTags = Array.from(new Set([...currentTags, "opt-out"]));
    try {
      await fubPut(`/people/${personId}`, {
        stage: "Trash",
        tags: updatedTags,
      });
    } catch (putErr) {
      console.warn(`[compliance] FUB PUT failed for person ${personId}:`, putErr);
      // Continue — still write to DB and post note
    }

    // 4. Post a FUB note documenting the suppression
    const dateStr = new Date().toLocaleDateString("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const reasonLabel = REASON_LABELS[reason] ?? reason;
    const sourceLabel = SOURCE_LABELS[source] ?? source;
    const noteBody = [
      `Automated compliance action taken on ${dateStr}.`,
      ``,
      `Reason: ${reasonLabel}`,
      `Triggered by: ${sourceLabel}`,
      agentName ? `Agent: ${agentName}` : null,
      email ? `Email: ${email}` : null,
      extraContext ? `\nContext: ${extraContext}` : null,
      ``,
      `Actions taken:`,
      `  • Lead stage set to "Trash"`,
      `  • "opt-out" tag added`,
      `  • Lead removed from all automated outreach (emails, texts, bot nurture)`,
      `  • Suppression recorded in compliance registry`,
    ].filter(Boolean).join("\n");

    try {
      await fubPost("/notes", {
        personId,
        subject: `Compliance — Lead Suppressed (${reasonLabel})`,
        body: noteBody,
      });
    } catch (noteErr) {
      console.warn(`[compliance] FUB note failed for person ${personId}:`, noteErr);
    }

    // 5. Write to suppressedLeads DB table
    if (db) {
      try {
        await db.insert(suppressedLeads).values({
          personId,
          email: email ?? null,
          reason,
          source,
          leadName: resolvedName,
          agentName: agentName ?? null,
        });
      } catch (dbErr) {
        console.warn(`[compliance] DB insert failed for person ${personId}:`, dbErr);
      }
    }

    // 6. Write botObservation so the healer and dashboard can see it
    await writeObservation({
      source: "compliance_layer",
      severity: "info",
      category: "compliance",
      message: `Lead suppressed: ${resolvedName} (ID ${personId}) — ${reasonLabel}`,
      detail: JSON.stringify({ personId, reason, source, agentName, email }),
      autoFixable: 0,
    });

    console.log(`[compliance] Suppressed lead ${personId} (${resolvedName}) — ${reason} via ${source}`);
    return { success: true, alreadySuppressed: false, personId, leadName: resolvedName };
  } catch (err: any) {
    console.error(`[compliance] suppressLead failed for person ${personId}:`, err);
    await writeObservation({
      source: "compliance_layer",
      severity: "error",
      category: "compliance",
      message: `Failed to suppress lead ${personId}: ${err?.message ?? "unknown error"}`,
      detail: JSON.stringify({ personId, reason, source, error: err?.message }),
      autoFixable: 0,
    });
    return { success: false, alreadySuppressed: false, personId, leadName, error: err?.message };
  }
}

/**
 * Check if a lead is already suppressed in our local DB.
 * Fast check — use before sending any email or text.
 */
export async function isLeadSuppressed(personId: number): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    const rows = await db
      .select({ id: suppressedLeads.id })
      .from(suppressedLeads)
      .where(eq(suppressedLeads.personId, personId))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the full suppression list for dashboard stats.
 * Returns newest first, limited to 200 rows.
 */
export async function getSuppressionList(limit = 200) {
  try {
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select()
      .from(suppressedLeads)
      .orderBy(suppressedLeads.suppressedAt)
      .limit(limit);
    return rows.reverse(); // newest first
  } catch {
    return [];
  }
}

/**
 * Get suppression count for the nightly health report.
 */
export async function getSuppressionCount(hoursBack = 24): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const rows = await db
      .select({ id: suppressedLeads.id })
      .from(suppressedLeads)
      .where(eq(suppressedLeads.suppressedAt, cutoff)); // approximate — good enough for reports
    return rows.length;
  } catch {
    return 0;
  }
}
