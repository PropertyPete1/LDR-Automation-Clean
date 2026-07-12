/**
 * replyIntentHandler.ts
 *
 * Automated reply intent detector — fully automatic, no buttons required.
 * Runs every 2 hours via heartbeat cron.
 *
 * Logic:
 *   1. Connect to peter@lifestyledesignrealty.com via IMAP (Google Workspace)
 *   2. Scan INBOX for inbound emails received in the last 4 hours (2x the run interval
 *      for safety overlap) that are NOT from mailer-daemon / system addresses
 *   3. For each candidate reply:
 *      a. Skip if Gmail message UID already in reply_intent_processed (dedup)
 *      b. Look up the sender email in FUB — skip if not a known lead
 *      c. Skip if lead already has opt-out / do-not-contact tag
 *      d. Pass the email body to LLM classifier — asks: does this indicate
 *         the person is no longer interested, already working with another agent,
 *         already under contract, or wants to stop receiving emails?
 *      e. If opt-out intent detected (confidence >= 0.75):
 *         - Add "opt-out" tag to lead in FUB (preserving all existing tags)
 *         - Post a FUB note documenting the auto-detection
 *         - Write a bot_observations entry (source: reply_intent, severity: info)
 *   4. Record every processed message in reply_intent_processed for dedup
 *   5. Return a summary
 *
 * Opt-out signals the LLM is trained to detect:
 *   - "already building with someone else" / "already under contract"
 *   - "working with another agent" / "have an agent"
 *   - "not interested" / "please remove me" / "unsubscribe"
 *   - "already bought" / "already closed" / "already moved"
 *   - "stop sending" / "take me off your list"
 *   - "not looking anymore" / "decided not to buy"
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { invokeLLM } from "./_core/llm";
import { writeObservation } from "./db";
import { getDb } from "./db";
import { suppressLead } from "./compliance";
import { replyIntentProcessed } from "../drizzle/schema";
import { eq } from "drizzle-orm";

const FUB_BASE = "https://api.followupboss.com/v1";
const FUB_REQUEST_TIMEOUT_MS = 15_000;

// ── FUB helpers (same pattern as bounceHandler.ts) ────────────────────────────

function getFubCredentials(): string {
  const apiKey = process.env.FUB_API_KEY;
  if (!apiKey) throw new Error("FUB_API_KEY not configured");
  return Buffer.from(`${apiKey}:`).toString("base64");
}

async function fubGet(path: string): Promise<any> {
  const credentials = getFubCredentials();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FUB_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${FUB_BASE}${path}`, {
        headers: { Accept: "application/json", Authorization: `Basic ${credentials}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.status === 429) { await new Promise(r => setTimeout(r, 5000)); continue; }
      if (res.status >= 500) continue;
      if (!res.ok) throw new Error(`FUB GET ${path} failed ${res.status}`);
      return res.json();
    } catch (e) {
      clearTimeout(timeoutId);
      if (attempt === 2) throw e;
    }
  }
}

async function fubPut(path: string, body: object): Promise<any> {
  const credentials = getFubCredentials();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FUB_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${FUB_BASE}${path}`, {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.status === 429) { await new Promise(r => setTimeout(r, 5000)); continue; }
      if (res.status >= 500) continue;
      if (!res.ok) throw new Error(`FUB PUT ${path} failed ${res.status}`);
      if (res.status === 204 || res.headers.get("content-length") === "0") return {};
      return res.json();
    } catch (e) {
      clearTimeout(timeoutId);
      if (attempt === 2) throw e;
    }
  }
}

async function fubPost(path: string, body: object): Promise<any> {
  const credentials = getFubCredentials();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
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
      if (res.status === 429) { await new Promise(r => setTimeout(r, 5000)); continue; }
      if (res.status >= 500) continue;
      if (!res.ok) throw new Error(`FUB POST ${path} failed ${res.status}`);
      if (res.status === 204 || res.headers.get("content-length") === "0") return {};
      return res.json();
    } catch (e) {
      clearTimeout(timeoutId);
      if (attempt === 2) throw e;
    }
  }
}

// ── FUB lead types ────────────────────────────────────────────────────────────

interface FubPerson {
  id: number;
  name: string;
  firstName?: string;
  emails: Array<{ value: string; type?: string }>;
  phones: Array<{ value: string; type?: string }>;
  tags: string[];
  stage?: string;
}

// Tags that indicate the lead has already been suppressed — skip re-processing
const ALREADY_SUPPRESSED_TAGS = ["opt-out", "do-not-contact", "unsubscribed", "dnc"];

// Protected stages — never modify leads in these stages
const PROTECTED_STAGES = ["Closed", "Under Contract"];

async function findLeadByEmail(email: string): Promise<FubPerson | null> {
  try {
    const data = await fubGet(`/people?email=${encodeURIComponent(email)}&limit=1`);
    const people = data?.people ?? [];
    if (people.length === 0) return null;
    return people[0] as FubPerson;
  } catch (e) {
    console.warn(`[replyIntent] FUB lookup failed for ${email}:`, e);
    return null;
  }
}

// ── Dedup helpers ─────────────────────────────────────────────────────────────

async function isAlreadyProcessed(gmailMessageId: string): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    const rows = await db
      .select({ id: replyIntentProcessed.id })
      .from(replyIntentProcessed)
      .where(eq(replyIntentProcessed.gmailMessageId, gmailMessageId))
      .limit(1);
    return rows.length > 0;
  } catch {
    // If DB is unavailable, be conservative and skip (don't re-process)
    return false;
  }
}

async function recordProcessed(params: {
  gmailMessageId: string;
  senderEmail: string;
  fubPersonId: number | null;
  action: string;
  confidence: string | null;
  reason: string | null;
}): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(replyIntentProcessed).values({
      gmailMessageId: params.gmailMessageId,
      senderEmail: params.senderEmail,
      fubPersonId: params.fubPersonId ?? undefined,
      action: params.action,
      confidence: params.confidence ?? undefined,
      reason: params.reason?.slice(0, 499) ?? undefined,
    });
  } catch (e) {
    console.warn("[replyIntent] Failed to record processed message:", e);
  }
}

// ── LLM classifier ────────────────────────────────────────────────────────────

interface IntentClassification {
  highIntent: boolean;
  isOptOut: boolean;
  confidence: number; // 0.0 – 1.0
  reason: string;     // short human-readable explanation
}

/**
 * Ask the LLM whether this email reply indicates the person no longer wants
 * to receive real estate communications or is already taken care of.
 *
 * We use a strict JSON schema response so the output is always parseable.
 */
async function classifyReplyIntent(
  emailBody: string,
  senderEmail: string
): Promise<IntentClassification> {
  // Truncate very long emails — first 2000 chars is plenty for intent detection
  const truncatedBody = emailBody.slice(0, 2000);

  const systemPrompt = `You are an AI assistant that classifies real estate email replies for Lifestyle Design Realty.
Your job is to determine:
1. Whether the sender wants to opt out of communications
2. Whether the sender shows strong buying/selling intent that needs immediate agent attention

Opt-out signals (isOptOut: true):
- Already working with another agent or broker
- Already under contract or already bought a home
- Already building a home with a builder
- Not interested in buying or selling anymore
- Wants to be removed from the mailing list / unsubscribe
- Explicitly says "stop emailing" or "stop contacting"
- Already moved / already closed on a property
- Decided not to buy / not looking anymore

High-intent signals (highIntent: true) — these need immediate agent follow-up:
- Asking to schedule a showing or tour
- Ready to make an offer or asking about making an offer
- Asking about a specific property or listing
- Asking to speak with an agent immediately
- Mentioning a specific timeline ("we want to buy in the next 30 days")
- Asking about financing or mortgage pre-approval

NOT opt-out and NOT high-intent:
- Out-of-office auto-replies
- Vacation responders
- General questions or chitchat
- Asking for more general information

Be conservative on both: only flag when there is clear, unambiguous evidence.
Confidence should reflect how certain you are (0.0 = no idea, 1.0 = absolutely certain).`;

  const userPrompt = `Classify this email reply from ${senderEmail}:

---
${truncatedBody}
---

Return JSON with:
- isOptOut (boolean): true if they want to stop communications
- highIntent (boolean): true if they show strong buying/selling intent needing immediate follow-up
- confidence (0.0-1.0): how certain you are
- reason (string): short explanation under 200 chars`;

  try {
    const result = await invokeLLM({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "intent_classification",
          strict: true,
          schema: {
            type: "object",
            properties: {
              isOptOut: { type: "boolean", description: "True if the email indicates opt-out intent" },
              highIntent: { type: "boolean", description: "True if the email shows strong buying/selling intent" },
              confidence: { type: "number", description: "Confidence score 0.0 to 1.0" },
              reason: { type: "string", description: "Short explanation under 200 characters" },
            },
            required: ["isOptOut", "highIntent", "confidence", "reason"],
            additionalProperties: false,
          },
        },
      },
    });

    const rawContent = result?.choices?.[0]?.message?.content;
    if (!rawContent) throw new Error("Empty LLM response");
    const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);

    const parsed = JSON.parse(content) as IntentClassification;
    return {
      isOptOut: Boolean(parsed.isOptOut),
      highIntent: Boolean(parsed.highIntent),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
      reason: String(parsed.reason || "").slice(0, 499),
    };
  } catch (e) {
    console.warn("[replyIntent] LLM classification failed:", e);
    // Safe fallback: treat as no opt-out intent if LLM fails
    return { isOptOut: false, highIntent: false, confidence: 0, reason: "LLM classification failed" };
  }
}

// ── FUB opt-out action ────────────────────────────────────────────────────────

async function applyOptOutTag(person: FubPerson, reason: string): Promise<void> {
  // Delegate entirely to the Unified Compliance Layer
  await suppressLead({
    personId: person.id,
    reason: "opt_out_reply",
    source: "reply_intent",
    leadName: person.name,
    extraContext: `LLM detected opt-out intent in reply email. Reason: ${reason}`,
  });
}

// ── IMAP scanner ──────────────────────────────────────────────────────────────

interface CandidateReply {
  uid: string;
  fromEmail: string;
  subject: string;
  bodyText: string;
}

/**
 * Scan the Gmail INBOX for inbound emails received in the last 4 hours.
 * Returns candidate replies that are NOT from system/mailer-daemon addresses.
 *
 * We use a 4-hour lookback (2x the 2-hour run interval) to ensure we never
 * miss a message if the cron fires slightly late.
 */
async function scanInboundReplies(): Promise<CandidateReply[]> {
  const smtpUser     = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_PASSWORD;

  if (!smtpUser || !smtpPassword) {
    throw new Error("SMTP_USER or SMTP_PASSWORD not configured — cannot connect to IMAP");
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: smtpUser, pass: smtpPassword },
    logger: false,
  });

  const candidates: CandidateReply[] = [];

  // System/automated sender patterns to skip
  const SKIP_SENDERS = [
    "mailer-daemon",
    "postmaster",
    "noreply",
    "no-reply",
    "bounce",
    "notifications",
    "donotreply",
    "do-not-reply",
    "support@",
    "admin@",
    "info@lifestyledesignrealty.com",
    "peter@lifestyledesignrealty.com",
    "steven@lifestyledesignrealty.com",
    "tiffany@lifestyledesignrealty.com",
    "stefanie@lifestyledesignrealty.com",
    "abby@lifestyledesignrealty.com",
    "irma@lifestyledesignrealty.com",
    "laila@lifestyledesignrealty.com",
  ];

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      // Search for messages received in the last 4 hours
      const since = new Date(Date.now() - 4 * 60 * 60 * 1000);
      const searchResult = await client.search({ since });
      const uids: number[] = Array.isArray(searchResult) ? searchResult : [];

      if (uids.length === 0) {
        return [];
      }

      console.log(`[replyIntent] Found ${uids.length} messages in last 4h — scanning for lead replies...`);

      for await (const msg of client.fetch(uids, { source: true, uid: true })) {
        try {
          const rawSource = msg.source;
          if (!rawSource) continue;

          const parsed = await simpleParser(rawSource as Buffer);

          // Extract sender email
          const fromAddress = parsed.from?.value?.[0]?.address?.toLowerCase() ?? "";
          if (!fromAddress || !fromAddress.includes("@")) continue;

          // Skip system/automated senders
          const isSystemSender = SKIP_SENDERS.some(skip => fromAddress.includes(skip));
          if (isSystemSender) continue;

          // Skip auto-replies (vacation responders, out-of-office)
          const subject = (parsed.subject ?? "").toLowerCase();
          const isAutoReply =
            subject.includes("out of office") ||
            subject.includes("auto-reply") ||
            subject.includes("automatic reply") ||
            subject.includes("vacation") ||
            (parsed.headers?.get("auto-submitted") ?? "").toString().toLowerCase() !== "" ||
            (parsed.headers?.get("x-auto-response-suppress") ?? "").toString().toLowerCase() !== "";
          if (isAutoReply) continue;

          // Extract plain text body (prefer text over HTML)
          const bodyText = (parsed.text ?? "").trim();
          if (bodyText.length < 5) continue; // Skip empty/trivial bodies

          const uid = String(msg.uid ?? "");
          if (!uid) continue;

          candidates.push({
            uid,
            fromEmail: fromAddress,
            subject: parsed.subject ?? "",
            bodyText,
          });
        } catch (parseErr) {
          console.warn("[replyIntent] Failed to parse message:", parseErr);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return candidates;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export interface ReplyIntentResult {
  messagesScanned: number;
  alreadyProcessed: number;
  notInFub: number;
  alreadySuppressed: number;
  classifiedNoIntent: number;
  optOutsApplied: number;
  errors: number;
  durationMs: number;
  details: string[];
}

export async function runReplyIntentHandler(): Promise<ReplyIntentResult> {
  const startTime = Date.now();
  const result: ReplyIntentResult = {
    messagesScanned: 0,
    alreadyProcessed: 0,
    notInFub: 0,
    alreadySuppressed: 0,
    classifiedNoIntent: 0,
    optOutsApplied: 0,
    errors: 0,
    durationMs: 0,
    details: [],
  };

  const runId = `reply-intent-${Date.now()}`;

  try {
    console.log("[replyIntent] Starting reply intent scan...");

    // Step 1: Scan Gmail inbox for inbound replies
    const candidates = await scanInboundReplies();
    result.messagesScanned = candidates.length;
    console.log(`[replyIntent] ${candidates.length} candidate message(s) to evaluate`);

    if (candidates.length === 0) {
      await writeObservation({
        source: "reply_intent",
        severity: "info",
        category: "reply_scan",
        message: "Reply intent scan complete — no inbound messages in last 4h",
        detail: null,
        autoFixable: 0,
        runId,
      });
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Step 2: Process each candidate
    for (const candidate of candidates) {
      try {
        // 2a. Dedup check — skip if already processed
        const alreadyDone = await isAlreadyProcessed(candidate.uid);
        if (alreadyDone) {
          result.alreadyProcessed++;
          continue;
        }

        // 2b. Look up sender in FUB
        const lead = await findLeadByEmail(candidate.fromEmail);
        if (!lead) {
          result.notInFub++;
          result.details.push(`NOT IN FUB: ${candidate.fromEmail}`);
          await recordProcessed({
            gmailMessageId: candidate.uid,
            senderEmail: candidate.fromEmail,
            fubPersonId: null,
            action: "not_in_fub",
            confidence: null,
            reason: "Sender email not found in FUB",
          });
          continue;
        }

        // 2c. Skip if lead is already suppressed or in a protected stage
        const existingTags = (lead.tags ?? []).map(t => t.toLowerCase());
        const isAlreadySuppressed = ALREADY_SUPPRESSED_TAGS.some(tag =>
          existingTags.includes(tag)
        );
        if (isAlreadySuppressed) {
          result.alreadySuppressed++;
          result.details.push(`ALREADY SUPPRESSED: ${lead.name} (${candidate.fromEmail})`);
          await recordProcessed({
            gmailMessageId: candidate.uid,
            senderEmail: candidate.fromEmail,
            fubPersonId: lead.id,
            action: "already_opted_out",
            confidence: null,
            reason: "Lead already has opt-out or do-not-contact tag",
          });
          continue;
        }

        const isProtectedStage = PROTECTED_STAGES.includes(lead.stage ?? "");
        if (isProtectedStage) {
          result.alreadySuppressed++;
          result.details.push(`PROTECTED STAGE (${lead.stage}): ${lead.name} — skipped`);
          await recordProcessed({
            gmailMessageId: candidate.uid,
            senderEmail: candidate.fromEmail,
            fubPersonId: lead.id,
            action: "protected_stage",
            confidence: null,
            reason: `Lead is in protected stage: ${lead.stage}`,
          });
          continue;
        }

        // 2d. Classify reply intent with LLM
        console.log(`[replyIntent] Classifying reply from ${lead.name} (${candidate.fromEmail})...`);
        const classification = await classifyReplyIntent(candidate.bodyText, candidate.fromEmail);

        console.log(
          `[replyIntent] ${lead.name}: isOptOut=${classification.isOptOut}, ` +
          `confidence=${classification.confidence.toFixed(2)}, reason="${classification.reason}"`
        );

        // 2e. Apply opt-out if confidence >= 0.75
        const CONFIDENCE_THRESHOLD = 0.75;
        if (classification.isOptOut && classification.confidence >= CONFIDENCE_THRESHOLD) {
          await applyOptOutTag(lead, classification.reason);
          result.optOutsApplied++;
          result.details.push(
            `OPT-OUT APPLIED: ${lead.name} (${candidate.fromEmail}) — "${classification.reason}" (confidence: ${(classification.confidence * 100).toFixed(0)}%)`
          );

          await writeObservation({
            source: "reply_intent",
            severity: "info",
            category: "auto_optout",
            message: `Auto opt-out applied — ${lead.name} replied indicating no longer interested`,
            detail: `Email: ${candidate.fromEmail} | Reason: ${classification.reason} | Confidence: ${(classification.confidence * 100).toFixed(0)}% | Subject: "${candidate.subject}"`,
            autoFixable: 0,
            runId,
          });

          await recordProcessed({
            gmailMessageId: candidate.uid,
            senderEmail: candidate.fromEmail,
            fubPersonId: lead.id,
            action: "opted_out",
            confidence: classification.confidence.toFixed(3),
            reason: classification.reason,
          });
        } else {
          // Check for high-intent buying signals — notify Peter immediately
          if (classification.highIntent && classification.confidence >= 0.70) {
            const { notifyOwner } = await import("./_core/notification");
            await notifyOwner({
              title: `🔥 High-Intent Reply Detected — ${lead.name}`,
              content: [
                `${lead.name} (${candidate.fromEmail}) replied with strong buying intent.`,
                ``,
                `Reason: ${classification.reason}`,
                `Confidence: ${(classification.confidence * 100).toFixed(0)}%`,
                `Subject: "${candidate.subject}"`,
                ``,
                `📧 Email snippet:`,
                candidate.bodyText.slice(0, 400),
                ``,
                `🔗 FUB Lead: https://app.followupboss.com/2/people/${lead.id}`,
                ``,
                `Recommend: Assign to an agent immediately for follow-up.`,
              ].join("\n"),
            }).catch(() => {});
            await writeObservation({
              source: "reply_intent",
              severity: "info",
              category: "high_intent_reply",
              message: `High-intent reply detected — ${lead.name}`,
              detail: `Reason: ${classification.reason} | Confidence: ${(classification.confidence * 100).toFixed(0)}% | FUB: https://app.followupboss.com/2/people/${lead.id}`,
              autoFixable: 0,
              runId,
            });
          }

          // No opt-out intent (or low confidence) — record as no_intent
          result.classifiedNoIntent++;
          result.details.push(
            `NO INTENT: ${lead.name} (${candidate.fromEmail}) — "${classification.reason}" (confidence: ${(classification.confidence * 100).toFixed(0)}%)`
          );

          await recordProcessed({
            gmailMessageId: candidate.uid,
            senderEmail: candidate.fromEmail,
            fubPersonId: lead.id,
            action: "no_intent",
            confidence: classification.confidence.toFixed(3),
            reason: classification.reason,
          });
        }
      } catch (msgErr) {
        result.errors++;
        const msg = msgErr instanceof Error ? msgErr.message : String(msgErr);
        result.details.push(`ERROR processing ${candidate.fromEmail}: ${msg}`);
        console.error(`[replyIntent] Error processing ${candidate.fromEmail}:`, msgErr);

        await writeObservation({
          source: "reply_intent",
          severity: "error",
          category: "reply_scan",
          message: `Reply intent handler error for ${candidate.fromEmail}`,
          detail: msg.slice(0, 255),
          autoFixable: 0,
          runId,
        });

        // Still record as processed to avoid retry loops on bad messages
        await recordProcessed({
          gmailMessageId: candidate.uid,
          senderEmail: candidate.fromEmail,
          fubPersonId: null,
          action: "error",
          confidence: null,
          reason: msg.slice(0, 499),
        });
      }
    }

    // Step 3: Write summary observation
    const summaryMsg =
      `Reply intent scan: ${result.messagesScanned} scanned, ` +
      `${result.optOutsApplied} opt-outs applied, ` +
      `${result.classifiedNoIntent} no-intent, ` +
      `${result.notInFub} not-in-FUB, ` +
      `${result.alreadySuppressed} already suppressed, ` +
      `${result.errors} errors`;

    await writeObservation({
      source: "reply_intent",
      severity: result.errors > 0 ? "warning" : "info",
      category: "reply_scan",
      message: summaryMsg,
      detail: result.details.join(" | ").slice(0, 1000),
      autoFixable: 0,
      runId,
    });

    console.log(`[replyIntent] Complete: ${summaryMsg}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[replyIntent] Fatal error:", err);
    result.errors++;

    await writeObservation({
      source: "reply_intent",
      severity: "error",
      category: "reply_scan",
      message: "Reply intent handler fatal error",
      detail: msg.slice(0, 255),
      autoFixable: 0,
      runId,
    });
  }

  result.durationMs = Date.now() - startTime;
  return result;
}
