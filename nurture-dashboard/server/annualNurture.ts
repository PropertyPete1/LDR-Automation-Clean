/**
 * annualNurture.ts
 *
 * Annual Nurture Email Sender — sends ONE friendly check-in email per year
 * to leads who indicated they are no longer looking to move to Texas.
 *
 * Runs monthly via heartbeat. On each run:
 *   1. Query annual_nurture_leads where active=true AND
 *      (last_email_sent_at IS NULL OR last_email_sent_at < 365 days ago)
 *   2. For each due lead:
 *      a. Verify they still exist in FUB and still have "Annual Nurture Only" tag
 *      b. Generate a personalized, friendly check-in email via LLM
 *      c. Send via SMTP
 *      d. Post a FUB note documenting the annual touch
 *      e. Update last_email_sent_at and emails_sent
 *   3. Cap at 20 emails per run to stay under rate limits
 *
 * The email tone is warm, brief, and referral-focused:
 * "Hey [Name], hope you're doing well! If you ever know anyone looking to
 *  buy or sell in Texas, keep us in mind. Wishing you all the best!"
 */

import { invokeLLM } from "./_core/llm";
import { getDb } from "./db";
import { writeObservation } from "./db";
import { annualNurtureLeads } from "../drizzle/schema";
import { eq, and, or, isNull, lt, sql } from "drizzle-orm";
import nodemailer from "nodemailer";

const FUB_BASE = "https://api.followupboss.com/v1";
const FUB_REQUEST_TIMEOUT_MS = 15_000;
const MAX_EMAILS_PER_RUN = 20;
const DAYS_BETWEEN_EMAILS = 365;

// ── FUB helpers ──────────────────────────────────────────────────────────────

function getFubCredentials(): string {
  const apiKey = process.env.FUB_API_KEY;
  if (!apiKey) throw new Error("FUB_API_KEY not configured");
  return Buffer.from(`${apiKey}:`).toString("base64");
}

async function fubGet(path: string): Promise<any> {
  const credentials = getFubCredentials();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FUB_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${FUB_BASE}${path}`, {
      headers: { Accept: "application/json", Authorization: `Basic ${credentials}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`FUB GET ${path} failed ${res.status}`);
    return res.json();
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

async function fubPost(path: string, body: object): Promise<any> {
  const credentials = getFubCredentials();
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
    if (!res.ok) throw new Error(`FUB POST ${path} failed ${res.status}`);
    if (res.status === 204 || res.headers.get("content-length") === "0") return {};
    return res.json();
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

// ── SMTP helper ──────────────────────────────────────────────────────────────

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !user || !pass) throw new Error("SMTP not configured");

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

// ── LLM email generation ─────────────────────────────────────────────────────

async function generateAnnualEmail(
  firstName: string,
  triggerSnippet: string,
  enrolledMonthsAgo: number
): Promise<{ subject: string; body: string }> {
  const systemPrompt = `You are a friendly real estate agent assistant for Lifestyle Design Realty in Texas.
You are writing a brief, warm annual check-in email to someone who previously indicated they are no longer looking to move to Texas.

Rules:
- Keep it SHORT (3-5 sentences max)
- Be warm and genuine, not salesy
- Do NOT try to sell them on moving to Texas
- Mention that if they know anyone looking to buy or sell in Texas, you'd love to help
- Ask for referrals naturally, not pushy
- Sign off warmly
- Do NOT mention that you know they moved away or stopped looking (don't remind them of that)
- Just be a friendly check-in like you'd send to an old friend

The email should feel like a quick, genuine "thinking of you" note.`;

  const userPrompt = `Write a brief annual check-in email to ${firstName}.
They were enrolled in annual nurture about ${enrolledMonthsAgo} months ago.
Original context (for your reference only, do NOT mention this directly): "${triggerSnippet}"

Return JSON with:
- subject: email subject line (short, friendly, no emojis)
- body: plain text email body (3-5 sentences, sign as "Peter Allen, Lifestyle Design Realty")`;

  try {
    const result = await invokeLLM({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "annual_email",
          strict: true,
          schema: {
            type: "object",
            properties: {
              subject: { type: "string", description: "Email subject line" },
              body: { type: "string", description: "Plain text email body" },
            },
            required: ["subject", "body"],
            additionalProperties: false,
          },
        },
      },
    });

    const rawContent = result?.choices?.[0]?.message?.content;
    if (!rawContent) throw new Error("Empty LLM response");
    const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
    return JSON.parse(content) as { subject: string; body: string };
  } catch (e) {
    // Fallback generic email
    return {
      subject: `Checking in — ${firstName}`,
      body: `Hi ${firstName},\n\nHope you're doing well! Just wanted to reach out and say hello. If you ever know anyone looking to buy or sell in Texas, I'd love to help them out.\n\nWishing you all the best!\n\nPeter Allen\nLifestyle Design Realty`,
    };
  }
}

// ── Main runner ──────────────────────────────────────────────────────────────

export interface AnnualNurtureResult {
  dueLeads: number;
  emailsSent: number;
  skipped: number;
  errors: number;
  durationMs: number;
  details: string[];
}

export async function runAnnualNurture(): Promise<AnnualNurtureResult> {
  const startTime = Date.now();
  const result: AnnualNurtureResult = {
    dueLeads: 0,
    emailsSent: 0,
    skipped: 0,
    errors: 0,
    durationMs: 0,
    details: [],
  };

  const runId = `annual-nurture-${Date.now()}`;

  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Find leads due for annual email
    const cutoffDate = new Date(Date.now() - DAYS_BETWEEN_EMAILS * 24 * 60 * 60 * 1000);

    const dueLeads = await db
      .select()
      .from(annualNurtureLeads)
      .where(
        and(
          eq(annualNurtureLeads.active, true),
          or(
            isNull(annualNurtureLeads.lastEmailSentAt),
            lt(annualNurtureLeads.lastEmailSentAt, cutoffDate)
          )
        )
      )
      .limit(MAX_EMAILS_PER_RUN);

    result.dueLeads = dueLeads.length;
    console.log(`[annualNurture] Found ${dueLeads.length} leads due for annual check-in`);

    if (dueLeads.length === 0) {
      await writeObservation({
        source: "annual_nurture",
        severity: "info",
        category: "annual_email",
        message: "Annual nurture run — no leads due for check-in",
        detail: null,
        autoFixable: 0,
        runId,
      });
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const transporter = getTransporter();
    const fromEmail = process.env.EMAIL_FROM || process.env.SMTP_USER || "";

    for (const lead of dueLeads) {
      try {
        // Verify lead still exists in FUB and has the tag
        const fubData = await fubGet(`/people/${lead.personId}`);
        if (!fubData || !fubData.id) {
          result.skipped++;
          result.details.push(`SKIPPED (not in FUB): ${lead.leadName}`);
          // Deactivate this record
          await db.update(annualNurtureLeads)
            .set({ active: false })
            .where(eq(annualNurtureLeads.id, lead.id));
          continue;
        }

        const tags = (fubData.tags ?? []).map((t: string) => t.toLowerCase());
        if (!tags.includes("annual nurture only")) {
          result.skipped++;
          result.details.push(`SKIPPED (tag removed): ${lead.leadName}`);
          await db.update(annualNurtureLeads)
            .set({ active: false })
            .where(eq(annualNurtureLeads.id, lead.id));
          continue;
        }

        // Check if lead has a valid email
        const leadEmail = lead.email || (fubData.emails?.[0]?.value ?? "");
        if (!leadEmail || !leadEmail.includes("@")) {
          result.skipped++;
          result.details.push(`SKIPPED (no email): ${lead.leadName}`);
          continue;
        }

        // Generate personalized email
        const firstName = (fubData.firstName ?? lead.leadName?.split(" ")[0] ?? "there").trim();
        const enrolledMs = Date.now() - new Date(lead.enrolledAt).getTime();
        const enrolledMonths = Math.round(enrolledMs / (30 * 24 * 60 * 60 * 1000));

        const email = await generateAnnualEmail(
          firstName,
          lead.triggerSnippet ?? "",
          enrolledMonths
        );

        // Send email
        await transporter.sendMail({
          from: `"Peter Allen - Lifestyle Design Realty" <${fromEmail}>`,
          to: leadEmail,
          subject: email.subject,
          text: email.body,
        });

        // Post FUB note
        await fubPost("/notes", {
          personId: lead.personId,
          body: [
            `📅 ANNUAL CHECK-IN EMAIL SENT`,
            ``,
            `Subject: ${email.subject}`,
            ``,
            `${email.body}`,
            ``,
            `— Lifestyle Bot (Annual Nurture)`,
          ].join("\n"),
          subject: "Annual Check-In Sent",
          isHtml: false,
        });

        // Update DB record
        await db.update(annualNurtureLeads)
          .set({
            lastEmailSentAt: new Date(),
            emailsSent: sql`${annualNurtureLeads.emailsSent} + 1`,
          })
          .where(eq(annualNurtureLeads.id, lead.id));

        result.emailsSent++;
        result.details.push(`SENT: ${lead.leadName} (${leadEmail}) — "${email.subject}"`);
        console.log(`[annualNurture] Sent to ${lead.leadName} (${leadEmail})`);

        // Small delay between sends
        await new Promise(r => setTimeout(r, 2000));
      } catch (leadErr) {
        result.errors++;
        const msg = leadErr instanceof Error ? leadErr.message : String(leadErr);
        result.details.push(`ERROR: ${lead.leadName} — ${msg}`);
        console.error(`[annualNurture] Error for ${lead.leadName}:`, leadErr);
      }
    }

    // Write summary observation
    await writeObservation({
      source: "annual_nurture",
      severity: result.errors > 0 ? "warning" : "info",
      category: "annual_email",
      message: `Annual nurture: ${result.emailsSent} sent, ${result.skipped} skipped, ${result.errors} errors`,
      detail: result.details.join(" | ").slice(0, 1000),
      autoFixable: 0,
      runId,
    });

    console.log(`[annualNurture] Complete: ${result.emailsSent} sent, ${result.skipped} skipped`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[annualNurture] Fatal error:", err);
    result.errors++;

    await writeObservation({
      source: "annual_nurture",
      severity: "error",
      category: "annual_email",
      message: "Annual nurture fatal error",
      detail: msg.slice(0, 255),
      autoFixable: 0,
      runId,
    });
  }

  result.durationMs = Date.now() - startTime;
  return result;
}
