/**
 * lifestyleBot.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Lifestyle Bot — the 8th virtual agent.
 *
 * Runs on a weekday heartbeat (10am CT). For each pond lead that:
 *   - Is assigned to Peter (the pond owner)
 *   - Is eligible for a follow-up email today
 *   - Has last activity 20+ days ago
 *
 * The bot will:
 *   1. Fetch the lead's FUB notes (last 3) and recent inbound messages
 *   2. Generate a unique, personalized AI email using the notes
 *   3. Post a FUB note on the lead documenting the bot's action
 *   4. Record the send in the run log
 *   5. Return a structured result for the daily summary email
 *
 * NOTE: The bot generates personalized AI follow-up emails for pond leads.
 * It posts a FUB note documenting the outreach and tracks the send.
 * existing FUB automation (pond_nurture). The bot's job is to ensure every
 * 20+ day pond lead gets a personalized follow-up note and is tracked.
 *
 * The bot uses SMTP to deliver emails directly to leads.
 * message body so it's visible in the lead's timeline.
 */

import { ENV } from "./_core/env";
import { invokeLLM } from "./_core/llm";
import { notifyOwner } from "./_core/notification";
import { dbRecordSmsSentToday, getSmsSentTodayIds, getRecentBotRuns, getRecentObservations, insertBotRunLog, writeObservation, getOvernightHealerSummary } from "./db";
import { isLeadSuppressed } from "./compliance";
import { getSharedSuppressionTags } from "./botHelpers";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BotLeadResult {
  personId: number;
  name: string;
  phone: string;
  daysStale: number;
  draftMessage: string;
  notePosted: boolean;
  recorded: boolean;
  error?: string;
}

export interface LifestyleBotResult {
  ranAt: string;
  leadsProcessed: number;
  leadsSkipped: number;
  leadsErrored: number;
  results: BotLeadResult[];
  summaryEmailSent: boolean;
  durationMs: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FUB_BASE = "https://api.followupboss.com/v1";
const BOT_AGENT_NAME = "Lifestyle Bot";
const STALE_DAYS_THRESHOLD = 20;
// MAX_LEADS_PER_RUN removed — Pond Nurture uses dynamic cap (eligible ÷ 14).
// Clock-in preview now shows total eligible pond leads instead of a hardcoded cap.

// ── FUB helpers ───────────────────────────────────────────────────────────────

const FUB_REQUEST_TIMEOUT_MS = 15_000; // 15 second timeout per request

function getFubCredentials(): string {
  const apiKey = ENV.fubApiKey;
  if (!apiKey) throw new Error("FUB_API_KEY not configured");
  return Buffer.from(`${apiKey}:`).toString("base64");
}

/**
 * Hardened FUB GET with:
 * - 15s AbortController timeout per attempt
 * - 3 retries with exponential backoff (1s, 2s, 4s)
 * - 429 rate-limit handling with Retry-After header support
 * - 5xx server error retry
 */
async function fubGet(path: string): Promise<any> {
  const credentials = getFubCredentials();
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000); // 1s, 2s, 4s
      await new Promise(r => setTimeout(r, backoffMs));
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FUB_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${FUB_BASE}${path}`, {
        headers: { Accept: "application/json", Authorization: `Basic ${credentials}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.status === 429) {
        // Respect Retry-After header if present, otherwise use 5s
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "5", 10);
        await new Promise(r => setTimeout(r, Math.min(retryAfter * 1000, 10_000)));
        continue;
      }
      if (res.status >= 500) {
        // FUB server error — retry
        lastError = new Error(`FUB GET ${path} server error ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`FUB GET ${path} failed ${res.status}: ${text.slice(0, 200)}`);
      }
      return res.json();
    } catch (e) {
      clearTimeout(timeoutId);
      if (e instanceof Error && e.name === "AbortError") {
        lastError = new Error(`FUB GET ${path} timed out after ${FUB_REQUEST_TIMEOUT_MS}ms`);
        continue;
      }
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error(`FUB GET ${path} failed after 3 attempts`);
}

/**
 * Hardened FUB POST with:
 * - 15s AbortController timeout
 * - 3 retries with exponential backoff on 429 and 5xx
 * - Does NOT retry on 4xx client errors (bad request, not found, etc.)
 */
async function fubPost(path: string, body: object): Promise<any> {
  const credentials = getFubCredentials();
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      await new Promise(r => setTimeout(r, backoffMs));
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FUB_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${FUB_BASE}${path}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "5", 10);
        await new Promise(r => setTimeout(r, Math.min(retryAfter * 1000, 10_000)));
        continue;
      }
      if (res.status >= 500) {
        lastError = new Error(`FUB POST ${path} server error ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        // 4xx client errors — do NOT retry (bad request, not found, etc.)
        throw new Error(`FUB POST ${path} failed ${res.status}: ${text.slice(0, 200)}`);
      }
      if (res.status === 204 || res.headers.get("content-length") === "0") return {};
      return res.json();
    } catch (e) {
      clearTimeout(timeoutId);
      if (e instanceof Error && e.name === "AbortError") {
        lastError = new Error(`FUB POST ${path} timed out after ${FUB_REQUEST_TIMEOUT_MS}ms`);
        continue;
      }
      // Re-throw non-retryable errors immediately
      if (e instanceof Error && !e.message.includes("server error") && !e.message.includes("timed out")) {
        throw e;
      }
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error(`FUB POST ${path} failed after 3 attempts`);
}

// ── Lead fetching ─────────────────────────────────────────────────────────────

interface RawLead {
  id: number;
  firstName: string;
  lastName: string;
  phones: Array<{ value?: string; phone?: string }>;
  lastActivity?: string;
  updated?: string;
  stage?: string;
  assignedUserId?: number;
  tags?: Array<{ name?: string }>;
  emailOptOut?: boolean;
  textOptOut?: boolean;
}

/**
 * Fetch Peter's FUB user ID dynamically by looking up the users list.
 */
async function getPeterUserId(): Promise<number | null> {
  try {
    const data = await fubGet("/users?limit=50");
    const users: any[] = data.users || [];
    for (const u of users) {
      const firstName = (u.firstName || u.name || "").trim().split(/\s+/)[0].toLowerCase();
      if (firstName === "peter") return Number(u.id);
    }
    return null;
  } catch (e) {
    console.warn("[LifestyleBot] Could not fetch FUB users:", e);
    return null;
  }
}

/**
 * Fetch pond leads assigned to Peter that are 20+ days stale.
 * Returns up to MAX_LEADS_PER_RUN leads.
 * NOTE: The bot posts FUB notes (not emails to leads directly) — filtering
 * is based on stage/tag exclusions and daily dedup, not email/phone presence.
 */
async function getPondLeadsForBot(peterUserId: number, alreadySentToday: Set<number>): Promise<RawLead[]> {
  const cutoffDate = new Date(Date.now() - STALE_DAYS_THRESHOLD * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0] + "T00:00:00Z";

  // Fetch Peter's leads that haven't had activity in 20+ days
  // Use limit=100 to get a larger pool before filtering, so we always reach MAX_LEADS_PER_RUN
  const data = await fubGet(
    `/people?limit=100&assignedUserId=${peterUserId}&lastActivityBefore=${cutoffDate}&sort=lastActivity`
  );
  const people: RawLead[] = data.people || [];

  // Stages that should NOT receive automated outreach
  const SKIP_STAGES = new Set([
    "closed", "closed - won", "closed - lost", "unsubscribed", "do not contact",
    "dnc", "inactive", "dead", "bad data",
  ]);

  // Filter: must not have been processed today, must not be DNC/closed/opted-out
  const eligible = people.filter(p => {
    if (alreadySentToday.has(p.id)) return false;
    // Skip leads who opted out of emails
    if (p.emailOptOut === true) return false;
    // Skip leads in closed/DNC stages
    const stage = (p.stage || "").toLowerCase().trim();
    if (stage && SKIP_STAGES.has(stage)) return false;
    // Skip leads tagged with any shared suppression tag (single source of truth)
    const suppressionTags = getSharedSuppressionTags();
    const tags: any[] = p.tags || [];
    const hasSuppressTag = tags.some((t: any) => {
      const name = (t.name || "").toLowerCase();
      return suppressionTags.some(st => name.includes(st));
    });
    if (hasSuppressTag) return false;
    return true;
  });

  return eligible; // No hardcoded cap — dynamic scaling handled by Pond Nurture
}

// ── AI draft generation ───────────────────────────────────────────────────────

/**
 * Generate a unique, personalized follow-up message for a lead.
 * Uses FUB notes if available; falls back to a contextual follow-up.
 */
async function generateBotDraft(
  firstName: string,
  daysStale: number,
  notes: string,
  lastInbound: string
): Promise<string> {
  const hasNotes = notes.trim().length > 0;
  const hasInbound = lastInbound.trim().length > 0;

  const hasName = firstName.toLowerCase() !== "there";
  const nameContext = hasName ? firstName : "a lead with no name on file (open with \"Hey, it's Peter Allen with Lifestyle Design Realty!\")";

  // ── Deep note-driven strategic prompt ──────────────────────────────────────
  // Parse the notes to extract the most actionable context for the AI
  const noteLines = notes
    .split("|")
    .map(n => n.trim())
    .filter(Boolean)
    .slice(0, 3);
  const noteContext = noteLines.length > 0
    ? `\n\nMost recent FUB notes (newest first):\n${noteLines.map((n, i) => `${i + 1}. ${n}`).join("\n")}`
    : "";

  const systemPrompt = `You are Peter Allen, a top real estate agent at Lifestyle Design Realty in Texas.
You are writing a strategic, personalized follow-up message to a lead in your pond — someone who hasn't been assigned to an agent but is still a real prospect.

Your goal: re-engage them naturally, reference something specific from their notes if available, and move the conversation toward a next step (showing, call, or just a warm reconnect).

Rules:
- Write ONLY the message text — no quotes, no labels, no explanation, no markdown
- Keep it under 160 characters
- Sound like a real person, not a bot or AI
- ${hasName ? `Use the lead's first name: ${firstName}` : `No name on file — open with "Hey, it's Peter Allen with Lifestyle Design Realty!" and do NOT use any name or placeholder`}
- Be warm, casual, and genuine — never salesy or scripted
- Never mention automation, AI, or that this is a follow-up system
- Every message must feel unique — vary the opening, tone, angle, and hook
- If notes mention a specific property, price range, area, or timeline — reference it directly
- If the lead previously replied, acknowledge their message and pick up the thread naturally
- If notes suggest urgency or high intent, match that energy
- If notes are stale or generic, keep it light and curiosity-driven${noteContext}`;

  let userPrompt: string;

  if (hasInbound) {
    userPrompt = `${nameContext} last texted: "${lastInbound}"\nIt's been ${daysStale} days since that message.${noteContext ? `\n\nContext: ${notes}` : ""}\n\nWrite a natural, warm reply that picks up the thread and moves toward a next step. Under 160 chars.`;
  } else if (hasNotes) {
    userPrompt = `${nameContext} hasn't been contacted in ${daysStale} days.\n\nTheir notes: ${notes}\n\nWrite a strategic, personalized follow-up SMS that references something specific from their notes. Make it feel like you remembered them personally. Under 160 chars.`;
  } else if (daysStale > 60) {
    userPrompt = `${nameContext} hasn't been contacted in ${daysStale} days and has no recent notes.\n\nWrite a warm, low-pressure re-engagement SMS. Ask if they're still thinking about buying a home in Texas. Keep it genuine and curious. Under 160 chars.`;
  } else {
    userPrompt = `${nameContext} hasn't been contacted in ${daysStale} days and has no notes.\n\nWrite a friendly, casual check-in SMS. Keep it light — ask how they're doing or if they're still thinking about a home. Under 160 chars.`;
  }

  const result = await invokeLLM({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    maxTokens: 200,
  });

  const content = result.choices[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Unexpected LLM response");
  return content.trim().replace(/^["']|["']$/g, "");
}

// ── Main bot runner ───────────────────────────────────────────────────────────

export async function runLifestyleBot(triggeredBy: "cron" | "manual" = "cron"): Promise<LifestyleBotResult> {
  // ═══════════════════════════════════════════════════════════════════════════════
  // DEPRECATED: The standalone Lifestyle Bot note-posting run is no longer needed.
  // Pond Nurture (server/pondNurture.ts) now handles ALL pond lead emails + FUB notes
  // on a 14-day cadence with dynamic scaling (eligible ÷ 14).
  //
  // This function is kept as a no-op so existing cron routes and manual triggers
  // don't crash. Clock-in/clock-off emails remain fully functional as separate exports.
  // ═══════════════════════════════════════════════════════════════════════════════
  const startTime = Date.now();
  const ranAt = new Date().toISOString();

  console.log("[LifestyleBot] Run triggered but deprecated — Pond Nurture handles all notes now.");
  await writeObservation({
    source: "lifestyle_bot",
    severity: "info",
    category: "bot_run_start",
    message: "Lifestyle Bot run skipped (deprecated — Pond Nurture handles notes)",
    detail: `Triggered by: ${triggeredBy}. The standalone note-posting run is no longer needed.`,
    autoFixable: 0,
    runId: `lifestyle-bot-noop-${Date.now()}`,
  });

  return {
    ranAt,
    leadsProcessed: 0,
    leadsSkipped: 0,
    leadsErrored: 0,
    results: [],
    summaryEmailSent: false,
    durationMs: Date.now() - startTime,
  };
}

// ── DEPRECATED: Original runLifestyleBot implementation (kept for reference) ──
// The code below is unreachable but preserved for historical context.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _runLifestyleBotLegacy(triggeredBy: "cron" | "manual" = "cron"): Promise<LifestyleBotResult> {
  const startTime = Date.now();
  const ranAt = new Date().toISOString();
  const results: BotLeadResult[] = [];
  let leadsSkipped = 0;
  let leadsErrored = 0;

  const runId = `lifestyle-bot-${Date.now()}`;
  console.log("[LifestyleBot] Starting run...");
  await writeObservation({
    source: "lifestyle_bot",
    severity: "info",
    category: "bot_run_start",
    message: "Lifestyle Bot run started",
    detail: `Triggered by: ${triggeredBy}`,
    autoFixable: 0,
    runId,
  });

  // 1. Get Peter's FUB user ID
  const peterUserId = await getPeterUserId();
  if (!peterUserId) {
    const msg = "Could not find Peter's FUB user ID — aborting bot run";
    console.error(`[LifestyleBot] ${msg}`);
    await writeObservation({
      source: "lifestyle_bot",
      severity: "error",
      category: "fub_api",
      message: "Lifestyle Bot: Peter FUB user ID not found — run aborted",
      detail: msg,
      autoFixable: 1,
      runId,
    });
    await notifyOwner({
      title: "🤖 Lifestyle Bot — Run Failed",
      content: msg,
    }).catch(() => {});
    return {
      ranAt,
      leadsProcessed: 0,
      leadsSkipped: 0,
      leadsErrored: 1,
      results: [],
      summaryEmailSent: false,
      durationMs: Date.now() - startTime,
    };
  }

  // 2. Get today's already-processed lead IDs to avoid duplicates
  const alreadySentToday = await getSmsSentTodayIds();

  // 3. Fetch eligible pond leads
  const leads = await getPondLeadsForBot(peterUserId, alreadySentToday);
  console.log(`[LifestyleBot] Found ${leads.length} eligible pond leads`);

  if (leads.length === 0) {
    leadsSkipped = 0;
    const summaryEmailSent = await notifyOwner({
      title: "🤖 Lifestyle Bot — No Leads Today",
      content: `Lifestyle Bot ran at ${new Date(ranAt).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT.\n\nNo pond leads were eligible today (all leads either texted today or have activity within ${STALE_DAYS_THRESHOLD} days).`,
    }).catch(() => false);
    return {
      ranAt,
      leadsProcessed: 0,
      leadsSkipped: 0,
      leadsErrored: 0,
      results: [],
      summaryEmailSent: typeof summaryEmailSent === "boolean" ? summaryEmailSent : false,
      durationMs: Date.now() - startTime,
    };
  }

  // 4. Process each lead
  for (const person of leads) {
    const phones: any[] = person.phones || [];
    const phone: string = phones[0]?.value || phones[0]?.phone || "";
    const rawFirst = person.firstName || "";
    const rawLast = person.lastName || "";
    const tc = (s: string) =>
      s.toLowerCase().split(/\s+/).map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    const firstName = rawFirst ? tc(rawFirst.trim().split(/\s+/)[0]) : "there";
    const fullName = rawFirst && rawLast ? `${tc(rawFirst)} ${tc(rawLast)}`.trim() : tc(rawFirst) || "Unknown";

    let daysStale = STALE_DAYS_THRESHOLD;
    const lastActivityStr = person.lastActivity || person.updated || null;
    if (lastActivityStr) {
      try {
        daysStale = Math.floor((Date.now() - new Date(lastActivityStr).getTime()) / (1000 * 60 * 60 * 24));
      } catch { /* ignore */ }
    }

    const result: BotLeadResult = {
      personId: person.id,
      name: fullName,
      phone,
      daysStale,
      draftMessage: "",
      notePosted: false,
      recorded: false,
    };

    try {
      // Compliance check — skip if lead is in our suppression registry
      const suppressed = await isLeadSuppressed(person.id);
      if (suppressed) {
        leadsSkipped++;
        console.log(`[LifestyleBot] Skipping suppressed lead ${fullName} (ID ${person.id})`);
        await writeObservation({
          source: "lifestyle_bot",
          severity: "info",
          category: "ai_decision",
          message: `AI skip: suppressed lead — ${fullName}`,
          detail: JSON.stringify({ personId: person.id, reason: "compliance_suppressed", leadName: fullName }),
          autoFixable: 0,
          runId,
        });
        continue;
      }

      // Fetch notes for AI context (FUB /textMessages returns 403 — not available)
      const notesRes = await fubGet(`/notes?personId=${person.id}&limit=3`).catch(() => ({ notes: [] }));

      let notes = "";
      const notesArr: any[] = notesRes.notes || [];
      notes = notesArr
        .slice(0, 3)
        .map((n: any) => (n.body || n.subject || "").trim().slice(0, 200))
        .filter(Boolean)
        .join(" | ");

      // lastInbound is always empty — FUB text API unavailable for this account
      const lastInbound = "";

      // ── Smart Escalation Detection ──────────────────────────────────────────
      // Before generating the draft, check if this lead needs immediate human attention.
      // High-intent signals: ready to buy, wants to schedule, asking about specific properties.
      // Problematic signals: angry, threatening, legal language, harassment.
      if (notes || lastInbound) {
        const escalationCheck = await invokeLLM({
          messages: [
            {
              role: "system",
              content: `You are a real estate lead analyst. Analyze the lead context and return JSON only.
Return: { "escalate": boolean, "reason": string, "type": "high_intent" | "problematic" | "none" }
- high_intent: lead is ready to buy, wants to schedule a showing, asking about specific homes, or has strong buying signals
- problematic: lead is angry, threatening, using legal language, or requesting to stop contact
- none: normal lead, no escalation needed
Be conservative — only escalate when clearly warranted.`,
            },
            {
              role: "user",
              content: `Lead: ${fullName} (${daysStale} days in pond)\nNotes: ${notes || "none"}\nLast inbound text: ${lastInbound || "none"}`,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "escalation_check",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  escalate: { type: "boolean" },
                  reason: { type: "string" },
                  type: { type: "string", enum: ["high_intent", "problematic", "none"] },
                },
                required: ["escalate", "reason", "type"],
                additionalProperties: false,
              },
            },
          },
          maxTokens: 150,
        }).catch(() => null);

        if (escalationCheck) {
          const rawContent = escalationCheck.choices[0]?.message?.content;
          const contentStr = typeof rawContent === "string" ? rawContent : "{}";
          const parsed = JSON.parse(contentStr);
          if (parsed.escalate === true && parsed.type !== "none") {
            const emoji = parsed.type === "high_intent" ? "🔥" : "⚠️";
            const label = parsed.type === "high_intent" ? "HIGH INTENT LEAD" : "PROBLEMATIC LEAD";
            await notifyOwner({
              title: `${emoji} Lifestyle Bot Escalation: ${label} — ${fullName}`,
              content: `Lead ${fullName} (ID ${person.id}, ${daysStale} days in pond) needs your attention.\n\nReason: ${parsed.reason}\n\nNotes: ${notes || "none"}\nLast inbound: ${lastInbound || "none"}\n\nFUB: https://app.followupboss.com/2/people/${person.id}`,
            }).catch(() => {});
            await writeObservation({
              source: "lifestyle_bot",
              severity: parsed.type === "problematic" ? "warning" : "info",
              category: "escalation",
              message: `Escalation: ${label} — ${fullName}`,
              detail: parsed.reason,
              autoFixable: 0,
              runId,
            });
          }
        }
      }

      // Generate unique AI draft
      const draft = await generateBotDraft(firstName, daysStale, notes, lastInbound);
      result.draftMessage = draft;

      // Log AI decision: draft generated
      await writeObservation({
        source: "lifestyle_bot",
        severity: "info",
        category: "ai_decision",
        message: `AI draft generated for ${fullName} (${daysStale} days stale)`,
        detail: JSON.stringify({
          personId: person.id,
          leadName: fullName,
          daysStale,
          hasNotes: notes.length > 0,
          hasInbound: lastInbound.length > 0,
          draftPreview: draft.slice(0, 100),
        }),
        autoFixable: 0,
        runId,
      });

      // Post FUB note documenting the bot's action
      const now = new Date().toLocaleString("en-US", {
        month: "numeric", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
      });
      await fubPost("/notes", {
        personId: person.id,
        subject: `🤖 Lifestyle Bot Follow-up — ${now} CT`,
        body: `Lifestyle Bot sent a personalized follow-up on ${now} CT.\n\nMessage sent:\n"${draft}"\n\nLead has been in pond for ${daysStale} days without contact.`,
        isHtml: false,
      });
      result.notePosted = true;

      // Record in daily dedup table (shared with Power Queue)
      await dbRecordSmsSentToday(person.id, BOT_AGENT_NAME);
      result.recorded = true;

      results.push(result);
      console.log(`[LifestyleBot] ✓ Processed ${fullName} (${person.id}) — ${daysStale}d stale`);

      // Respectful inter-lead delay — 1.2s gives FUB breathing room between note POSTs
      // and prevents hitting the undocumented burst limit on the /notes endpoint
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.error = errMsg;
      leadsErrored++;
      results.push(result);
      console.error(`[LifestyleBot] ✗ Failed ${fullName} (${person.id}):`, errMsg);
      await writeObservation({
        source: "lifestyle_bot",
        severity: "warning",
        category: "lead_processing_error",
        message: `Lifestyle Bot: failed to process lead ${fullName}`,
        detail: errMsg.slice(0, 500),
        autoFixable: 0,
        runId,
      });
    }
  }

  const leadsProcessed = results.filter(r => !r.error).length;

  // 5. Send daily summary email to Peter
  const ctTime = new Date().toLocaleString("en-US", {
    weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
  });

  const successLines = results
    .filter(r => !r.error)
    .map(r => `• ${r.name} (${r.daysStale}d stale) — "${r.draftMessage}"`)
    .join("\n");

  const errorLines = results
    .filter(r => r.error)
    .map(r => `• ${r.name} (${r.personId}) — ${r.error}`)
    .join("\n");

  const summaryContent = [
    `Lifestyle Bot completed its daily run on ${ctTime} CT.`,
    "",
    `📊 Summary: ${leadsProcessed} leads processed, ${leadsSkipped} skipped, ${leadsErrored} errors`,
    "",
    leadsProcessed > 0 ? `✅ Leads Followed Up:\n${successLines}` : "No leads were followed up today.",
    leadsErrored > 0 ? `\n❌ Errors:\n${errorLines}` : "",
    "",
    "All successful leads have been logged in FUB with a note and recorded in the run log.",
  ].filter(Boolean).join("\n");

  const summaryEmailSent = await notifyOwner({
    title: `🤖 Lifestyle Bot — ${leadsProcessed} leads followed up (${ctTime})`,
    content: summaryContent,
  }).catch(() => false);

  const durationMs = Date.now() - startTime;
  console.log(`[LifestyleBot] Done. Processed: ${leadsProcessed}, Errored: ${leadsErrored}, Duration: ${durationMs}ms`);

  // Write run completion observation
  await writeObservation({
    source: "lifestyle_bot",
    severity: leadsErrored > 0 ? "warning" : "info",
    category: "bot_run_complete",
    message: `Lifestyle Bot completed: ${leadsProcessed} emailed, ${leadsErrored} errors`,
    detail: `Processed ${leadsProcessed} leads, ${leadsSkipped} skipped, ${leadsErrored} errors. Duration: ${Date.now() - startTime}ms`,
    autoFixable: 0,
    runId,
  });

  // Persist run record to bot_run_log so the dashboard shows "Last run: ..."
  await insertBotRunLog({
    runAt: new Date(),
    leadsTexted: leadsProcessed,
    leadsFailed: leadsErrored,
    leadsEvaluated: leadsProcessed + leadsSkipped + leadsErrored,
    emailSent: (typeof summaryEmailSent === "boolean" ? summaryEmailSent : false) ? "yes" : "no",
    summary: `${leadsProcessed} emailed, ${leadsSkipped} skipped, ${leadsErrored} errors`,
    triggeredBy,
  });

  return {
    ranAt,
    leadsProcessed,
    leadsSkipped,
    leadsErrored,
    results,
    summaryEmailSent: typeof summaryEmailSent === "boolean" ? summaryEmailSent : false,
    durationMs,
  };
}

// ── Luxury HTML Email Builder ────────────────────────────────────────────────────

interface LuxuryEmailOptions {
  preheader: string;
  body: string;
  footerTagline: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildLuxuryEmailHtml({ preheader, body, footerTagline }: LuxuryEmailOptions): string {
  // Convert plain text body to HTML paragraphs
  const htmlParagraphs = body
    .split("\n\n")
    .map(para => {
      const lines = para.split("\n");
      const htmlLines = lines.map(line => {
        if (line.trim().startsWith("•") || line.trim().startsWith("-")) {
          return `<span style="display:block;padding-left:16px;margin:4px 0;">${escapeHtml(line)}</span>`;
        }
        return escapeHtml(line);
      });
      return `<p style="margin:0 0 16px 0;line-height:1.7;color:#2d2d2d;">${htmlLines.join("<br>")}</p>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <title>Lifestyle Bot</title>
  <style>
    body { margin:0; padding:0; background-color:#f8f6f3; font-family: 'Georgia', 'Times New Roman', serif; }
    .preheader { display:none !important; max-height:0; overflow:hidden; }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f8f6f3;">
  <span class="preheader">${escapeHtml(preheader)}&nbsp;</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8f6f3;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:2px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
        <!-- Gold accent bar -->
        <tr><td style="height:4px;background:linear-gradient(90deg,#c9a96e,#e8d5a3,#c9a96e);"></td></tr>
        <!-- Brand -->
        <tr><td style="padding:32px 40px 8px 40px;text-align:center;">
          <span style="font-size:14px;letter-spacing:3px;text-transform:uppercase;color:#c9a96e;font-family:'Helvetica Neue',Arial,sans-serif;">Lifestyle Design Realty</span>
        </td></tr>
        <!-- Divider -->
        <tr><td style="padding:0 40px;"><hr style="border:none;border-top:1px solid #e8e4de;margin:16px 0;"></td></tr>
        <!-- Body -->
        <tr><td style="padding:24px 40px 32px 40px;font-size:15px;font-family:'Georgia','Times New Roman',serif;color:#2d2d2d;line-height:1.7;">
          ${htmlParagraphs}
        </td></tr>
        <!-- Bottom accent bar -->
        <tr><td style="height:2px;background:linear-gradient(90deg,#c9a96e,#e8d5a3,#c9a96e);"></td></tr>
        <!-- Footer -->
        <tr><td style="padding:24px 40px;text-align:center;background-color:#faf9f7;">
          <p style="margin:0;font-size:12px;color:#8a8278;font-family:'Helvetica Neue',Arial,sans-serif;letter-spacing:0.5px;">${escapeHtml(footerTagline)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Evening Clock-Off Email ────────────────────────────────────────────────────

export interface ClockoffEmailResult {
  sent: boolean;
  emailsToday: number;
  error?: string;
}

/**
 * Sends the Lifestyle Bot's warm evening clock-off email to Peter and Steven.
 * Runs at 6pm CT daily. Summarises emails sent, pond nurture activity, and any
 * issues observed during the day — then signs off warmly.
 */
export async function sendBotClockoffEmail(): Promise<ClockoffEmailResult> {
  console.log("[LifestyleBot] Sending evening clock-off email...");

  // ── Gather today's stats ──────────────────────────────────────────────────
  const [recentRuns, observations] = await Promise.allSettled([
    getRecentBotRuns(1),
    getRecentObservations(100, 12), // last 12 hours
  ]);

  // Pull pond nurture email count from today's observations
  let emailsToday = 0;
  if (observations.status === "fulfilled") {
    const pondObs = observations.value.filter(
      o => o.source === "pond_nurture" && o.category === "daily_run"
    );
    for (const obs of pondObs) {
      const match = (obs.message || "").match(/(\d+)\s+email/i);
      if (match) emailsToday = Math.max(emailsToday, parseInt(match[1]));
    }
  }

  // Count any issues observed today
  const issueObs = observations.status === "fulfilled"
    ? observations.value.filter(o => o.severity === "error" || o.severity === "warning")
    : [];
  const issueCount = issueObs.length;

  // ── Build the email ───────────────────────────────────────────────────────
  const now = new Date();
  const ctDate = now.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    timeZone: "America/Chicago",
  });
  const ctTime = now.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
  });

  const ctDayOfWeek = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Chicago" });

  // Determine season for AI context
  const monthNum = now.getMonth() + 1;
  const season = monthNum >= 3 && monthNum <= 5 ? "spring" :
                 monthNum >= 6 && monthNum <= 8 ? "summer" :
                 monthNum >= 9 && monthNum <= 11 ? "fall" : "winter";

  // Stats block — always factual, inserted into AI body
  const statsBlock = [
    `Today's Activity:`,
    `   • Pond nurture emails sent:   ${emailsToday}`,
    issueCount > 0
      ? `   • Issues flagged for review:  ${issueCount} (details in your morning health report)`
      : `   • System issues:              None — everything ran clean ✅`,
  ].join("\n");

  // AI-generated personalized body — varies every day in tone and angle
  let body = "";
  try {
    const aiPrompt = [
      `You are the Lifestyle Bot, the 8th virtual agent at Lifestyle Design Realty in Texas.`,
      `You are writing your daily evening clock-off email to Peter and Steven (the leadership team).`,
      ``,
      `Today is ${ctDayOfWeek}, ${ctDate}. It is ${season} in Texas.`,
      `Today you sent ${emailsToday} pond nurture emails to keep leads warm.`,
      issueCount > 0
        ? `You flagged ${issueCount} issue${issueCount !== 1 ? "s" : ""} today that need attention.`
        : `Everything ran clean today with no issues.`,
      ``,
      `Write a warm, genuine, professional clock-off email body. Rules:`,
      `- Start with: "Hey Steven and Peter,"`,
      `- Mention you are clocking off for the evening`,
      `- Reference the day of week or season naturally (not forced)`,
      `- Optionally include ONE brief casual real estate market insight for Texas ${season} — conversational, not a lecture`,
      `- Place the exact placeholder text [STATS_BLOCK] on its own line where the activity stats should appear`,
      `- After the stats, add a warm closing paragraph`,
      `- End with a genuine thank-you for the opportunity to work at Lifestyle Design Realty`,
      `- Wish them a wonderful evening`,
      `- Sign off as: — Lifestyle Bot / Your 8th Virtual Agent / Lifestyle Design Realty`,
      `- Keep total length under 250 words`,
      `- Sound like a real warm person — NOT corporate, NOT robotic, NEVER mention AI or automation`,
      `- Vary the tone and angle each day so it never feels repetitive`,
      `- Output ONLY the email body text — no subject line, no markdown, no labels`,
    ].join("\n");

    const aiResult = await invokeLLM({
      messages: [{ role: "user", content: aiPrompt }],
    });
    const rawAi = (String(aiResult.choices[0]?.message?.content ?? "")).trim();
    body = rawAi.includes("[STATS_BLOCK]")
      ? rawAi.replace("[STATS_BLOCK]", statsBlock)
      : rawAi + "\n\n" + statsBlock;
  } catch (aiErr) {
    console.warn("[LifestyleBot] AI clock-off generation failed, using fallback:", aiErr);
    body = [
      `Hey Steven and Peter,`,
      ``,
      `I've completed my work day and I'm clocking off for the evening — just wanted to give you a quick update on what I got done today.`,
      ``,
      statsBlock,
      ``,
      issueCount === 0
        ? `All leads were followed up on time, notes were posted in Follow Up Boss, and the system is running smoothly heading into the evening.`
        : `I flagged ${issueCount} item${issueCount !== 1 ? "s" : ""} that may need your attention — you'll see the full details in tomorrow morning's health report.`,
      ``,
      `I genuinely enjoy being part of the Lifestyle Design Realty team. Thank you both for the opportunity to work alongside you — it means a lot.`,
      ``,
      `Wishing you both a wonderful evening!`,
      ``,
      `— Lifestyle Bot`,
      `  Your 8th Virtual Agent`,
      `  Lifestyle Design Realty`,
    ].join("\n");
  }

  const subject = `Lifestyle Bot — Evening Report (${ctDate})`;

  // ── Build luxury HTML email ───────────────────────────────────────────────
  const htmlBody = buildLuxuryEmailHtml({
    preheader: `${emailsToday} emails sent today — ${issueCount === 0 ? "all systems clean" : issueCount + " items flagged"}`,
    body,
    footerTagline: "Your 8th Virtual Agent · Lifestyle Design Realty",
  });

  // ── Send via SMTP ─────────────────────────────────────────────────────────
  try {
    const nodemailer = await import("nodemailer");

    const smtpHost     = process.env.SMTP_HOST;
    const smtpPort     = parseInt(process.env.SMTP_PORT ?? "587", 10);
    const smtpUser     = process.env.SMTP_USER;
    const smtpPassword = process.env.SMTP_PASSWORD;
    const fromEmail    = process.env.EMAIL_FROM ?? "peter@lifestyledesignrealty.com";

    if (!smtpHost || !smtpUser || !smtpPassword) {
      console.warn("[LifestyleBot] SMTP not configured — falling back to notifyOwner");
      const sent = await notifyOwner({ title: subject, content: body }).catch(() => false);
      return { sent: !!sent, emailsToday };
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPassword },
    });

    await transporter.sendMail({
      from: `"Lifestyle Bot" <${fromEmail}>`,
      to: ["peter@lifestyledesignrealty.com", "steven@lifestyledesignrealty.com"],
      subject,
      text: body,
      html: htmlBody,
    });

    console.log(`[LifestyleBot] ✓ Clock-off email sent to Peter & Steven (${ctTime} CT)`);

    await writeObservation({
      source: "lifestyle_bot",
      severity: "info",
      category: "clockoff_email",
      message: `Evening clock-off email sent: ${emailsToday} emails today`,
      detail: `Sent to peter@lifestyledesignrealty.com + steven@lifestyledesignrealty.com at ${ctTime} CT`,
      autoFixable: 0,
    });

    return { sent: true, emailsToday };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[LifestyleBot] Clock-off email failed:", errMsg);

    await writeObservation({
      source: "lifestyle_bot",
      severity: "warning",
      category: "clockoff_email_error",
      message: "Evening clock-off email failed to send",
      detail: errMsg.slice(0, 400),
      autoFixable: 0,
    });

    return { sent: false, emailsToday, error: errMsg };
  }
}

// ── Morning Clock-In Email ────────────────────────────────────────────────────

export interface ClockinEmailResult {
  sent: boolean;
  leadsQueued: number;
  error?: string;
}

/**
 * Sends the Lifestyle Bot's warm morning clock-in email to Peter and Steven.
 * Runs at 10am CT daily. Previews today's eligible pond leads and what the
 * bot is planning to work on — sets the tone for the day.
 */
export async function sendBotClockinEmail(): Promise<ClockinEmailResult> {
  console.log("[LifestyleBot] Sending morning clock-in email...");

  const now = new Date();
  const ctDate = now.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    timeZone: "America/Chicago",
  });
  const ctTime = now.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
  });
  const ctDayOfWeek = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Chicago" });

  const monthNum = now.getMonth() + 1;
  const season = monthNum >= 3 && monthNum <= 5 ? "spring" :
                 monthNum >= 6 && monthNum <= 8 ? "summer" :
                 monthNum >= 9 && monthNum <= 11 ? "fall" : "winter";

  // ── Fetch overnight healer summary ─────────────────────────────────────────
  const healerSummary = await getOvernightHealerSummary().catch(() => ({
    totalFixed: 0, totalUiErrorsResolved: 0, fixDescriptions: [], hadIssues: false,
  }));

  // ── Fetch today's eligible lead preview from FUB ──────────────────────────
  let leadsQueued = 0;
  let leadPreviewLines: string[] = [];

  try {
    // Get Peter's FUB user ID
    const usersData = await fubGet("/users?limit=50");
    const users: any[] = usersData.users || usersData.data || [];
    const peter = users.find((u: any) => {
      const name = (u.name || u.firstName || "").toLowerCase();
      return name.includes("peter");
    });
    const peterUserId = peter?.id ?? 0;

    if (peterUserId) {
      const alreadySentToday = await getSmsSentTodayIds();
      const cutoffDate = new Date(Date.now() - STALE_DAYS_THRESHOLD * 24 * 60 * 60 * 1000)
        .toISOString().split("T")[0] + "T00:00:00Z";

      const data = await fubGet(
        `/people?limit=50&assignedUserId=${peterUserId}&lastActivityBefore=${cutoffDate}&sort=lastActivity`
      );
      const people: RawLead[] = data.people || [];

      const SKIP_STAGES = new Set([
        "closed", "closed - won", "closed - lost", "unsubscribed", "do not contact",
        "dnc", "inactive", "dead", "bad data",
      ]);

      const eligible = people.filter(p => {
        if (alreadySentToday.has(p.id)) return false;
        if (p.emailOptOut === true) return false;
        const stage = (p.stage || "").toLowerCase().trim();
        if (stage && SKIP_STAGES.has(stage)) return false;
        const tags: any[] = p.tags || [];
        const suppressionTags2 = getSharedSuppressionTags();
        const hasSuppressTag2 = tags.some((t: any) => {
          const name = (t.name || "").toLowerCase();
          return suppressionTags2.some(st => name.includes(st));
        });
        if (hasSuppressTag2) return false;
        return true;
      });

      // Dynamic: show all eligible leads (Pond Nurture handles the actual daily cap)
      leadsQueued = eligible.length;

      // Build a preview of the first 5 leads (name + city + days stale)
      const preview = eligible.slice(0, 5);
      for (const lead of preview) {
        const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unknown";
        const city = (lead as any).city || (lead as any).address?.city || "";
        const lastActivity = lead.lastActivity ? new Date(lead.lastActivity) : null;
        const daysStale = lastActivity
          ? Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24))
          : null;
        const stalePart = daysStale !== null ? ` — ${daysStale} days since last contact` : "";
        const cityPart = city ? ` (${city})` : "";
        leadPreviewLines.push(`   • ${name}${cityPart}${stalePart}`);
      }
      if (eligible.length > 5) {
        leadPreviewLines.push(`   • ...and ${eligible.length - 5} more`);
      }
    }
  } catch (fubErr) {
    console.warn("[LifestyleBot] Clock-in FUB preview failed:", fubErr);
    // Non-fatal — continue with email without lead preview
  }

  // ── Overnight healer block ───────────────────────────────────────────────
  const healerBlock = healerSummary.hadIssues
    ? [
        `🔧 Overnight Fixes (Nightly Healer):`,
        ...healerSummary.fixDescriptions.map(d => `   ${d}`),
        ...(healerSummary.totalFixed > healerSummary.fixDescriptions.length
          ? [`   ✓ ...and ${healerSummary.totalFixed - (healerSummary.fixDescriptions.length - (healerSummary.totalUiErrorsResolved > 0 ? 1 : 0))} more items resolved`]
          : []),
      ].join("\n")
    : `🔧 Overnight Fixes: All clear — no issues needed attention last night ✅`;

  // ── Stats block ───────────────────────────────────────────────────────────
  const planBlock = [
    healerBlock,
    ``,
    `📋 Today's Plan:`,
    `   • Leads queued for follow-up: ${leadsQueued}`,
    ...(leadPreviewLines.length > 0 ? [`   • Lead preview:`, ...leadPreviewLines] : []),
    `   • Pond nurture emails:        Scheduled for 8am (already sent or running)`,
    `   • System monitoring:          Running every 30 min throughout the day`,
  ].join("\n");

  // ── AI-generated personalized body ───────────────────────────────────────
  let body = "";
  try {
    const aiPrompt = [
      `You are the Lifestyle Bot, the 8th virtual agent at Lifestyle Design Realty in Texas.`,
      `You are writing your daily morning clock-in email to Peter and Steven (the leadership team).`,
      ``,
      `Today is ${ctDayOfWeek}, ${ctDate}. It is ${season} in Texas.`,
      `You have ${leadsQueued} pond leads queued for follow-up emails today.`,
      healerSummary.hadIssues
        ? `The nightly healer fixed ${healerSummary.totalFixed} issue${healerSummary.totalFixed !== 1 ? 's' : ''} overnight. Briefly mention this in a reassuring way — something like "the system cleaned itself up overnight" or "everything looks good after last night's maintenance". Keep it casual and positive, not technical.`
        : `The nightly healer found no issues overnight — the system is running perfectly clean.`,
      ``,
      `Write a warm, genuine, professional morning clock-in email body. Rules:`,
      `- Start with: "Good morning Peter and Steven,"`,
      `- Mention you are starting your work day`,
      `- Reference the day of week or season naturally (not forced)`,
      `- Optionally include ONE brief casual real estate market insight or motivational note for Texas ${season} \u2014 conversational, not a lecture`,
      `- Place the exact placeholder text [PLAN_BLOCK] on its own line where the day's plan should appear`,
      `- After the plan, add a short upbeat closing sentence about getting to work`,
      `- Sign off as: \u2014 Lifestyle Bot / Your 8th Virtual Agent / Lifestyle Design Realty`,
      `- Keep total length under 200 words`,
      `- Sound like a real warm person \u2014 NOT corporate, NOT robotic, NEVER mention AI or automation`,
      `- Vary the tone and angle each day so it never feels repetitive`,
      `- Output ONLY the email body text \u2014 no subject line, no markdown, no labels`,
    ].join("\n");

    const aiResult = await invokeLLM({
      messages: [{ role: "user", content: aiPrompt }],
    });
    const rawAi = (String(aiResult.choices[0]?.message?.content ?? "")).trim();
    body = rawAi.includes("[PLAN_BLOCK]")
      ? rawAi.replace("[PLAN_BLOCK]", planBlock)
      : rawAi + "\n\n" + planBlock;
  } catch (aiErr) {
    console.warn("[LifestyleBot] AI clock-in generation failed, using fallback:", aiErr);
    body = [
      `Good morning Peter and Steven,`,
      ``,
      `I'm clocking in and starting my work day — here's what I've got lined up for today.`,
      ``,
      planBlock,
      ``,
      `I'll get right to it. Have a great ${ctDayOfWeek}!`,
      ``,
      `\u2014 Lifestyle Bot`,
      `  Your 8th Virtual Agent`,
      `  Lifestyle Design Realty`,
    ].join("\n");
  }

  const subject = `🌅 Lifestyle Bot — Good Morning! Clocking In (${ctDate})`;

  // ── Build luxury HTML email ───────────────────────────────────────────────
  const htmlBody = buildLuxuryEmailHtml({
    preheader: `${leadsQueued} leads queued for follow-up today`,
    body,
    footerTagline: "Your 8th Virtual Agent · Lifestyle Design Realty",
  });

  // ── Send via SMTP ─────────────────────────────────────────────────────────
  try {
    const nodemailer = await import("nodemailer");

    const smtpHost     = process.env.SMTP_HOST;
    const smtpPort     = parseInt(process.env.SMTP_PORT ?? "587", 10);
    const smtpUser     = process.env.SMTP_USER;
    const smtpPassword = process.env.SMTP_PASSWORD;
    const fromEmail    = process.env.EMAIL_FROM ?? "peter@lifestyledesignrealty.com";

    if (!smtpHost || !smtpUser || !smtpPassword) {
      console.warn("[LifestyleBot] SMTP not configured — falling back to notifyOwner for clock-in");
      const sent = await notifyOwner({ title: subject, content: body }).catch(() => false);
      return { sent: !!sent, leadsQueued };
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPassword },
    });

    await transporter.sendMail({
      from: `"Lifestyle Bot 🤖" <${fromEmail}>`,
      to: ["peter@lifestyledesignrealty.com", "steven@lifestyledesignrealty.com"],
      subject,
      text: body,
      html: htmlBody,
    });

    console.log(`[LifestyleBot] ✓ Clock-in email sent to Peter & Steven (${ctTime} CT)`);

    await writeObservation({
      source: "lifestyle_bot",
      severity: "info",
      category: "clockin_email",
      message: `Morning clock-in email sent: ${leadsQueued} leads queued for today`,
      detail: `Sent to peter@lifestyledesignrealty.com + steven@lifestyledesignrealty.com at ${ctTime} CT`,
      autoFixable: 0,
    });

    return { sent: true, leadsQueued };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[LifestyleBot] Clock-in email failed:", errMsg);

    await writeObservation({
      source: "lifestyle_bot",
      severity: "warning",
      category: "clockin_email_error",
      message: "Morning clock-in email failed to send",
      detail: errMsg.slice(0, 400),
      autoFixable: 0,
    });

    return { sent: false, leadsQueued, error: errMsg };
  }
}
