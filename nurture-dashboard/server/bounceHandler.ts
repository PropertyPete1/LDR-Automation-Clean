/**
 * bounceHandler.ts
 *
 * Automated email bounce handler.
 * Runs daily at 4:30am CT via heartbeat cron.
 *
 * Logic:
 *   1. Connect to peter@lifestyledesignrealty.com via IMAP (Google Workspace)
 *   2. Search for permanent delivery failure messages (mailer-daemon) from the last 48h
 *   3. For each bounced email address:
 *      a. Look up the lead in FUB by email
 *      b. If lead HAS a valid phone → keep lead active, remove bad email, add "bad-email" tag,
 *         post FUB note. Lead stays in system for SMS outreach via Peter's Power Queue.
 *      c. If lead has NO phone → move to Trash via compliance layer (no way to reach them)
 *   4. Write bot_observations for everything processed
 *   5. Return a summary
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { ENV } from "./_core/env";
import { writeObservation } from "./db";
import { suppressLead } from "./compliance";

const FUB_BASE = "https://api.followupboss.com/v1";
const FUB_REQUEST_TIMEOUT_MS = 15_000;

// ── FUB helpers ───────────────────────────────────────────────────────────────

function getFubCredentials(): string {
  const apiKey = ENV.fubApiKey;
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

// ── IMAP helpers ──────────────────────────────────────────────────────────────

/**
 * Scan the inbox for permanent delivery failure messages in the last 48 hours.
 * Returns a list of bounced email addresses (deduplicated).
 */
async function scanBouncedEmails(): Promise<string[]> {
  const smtpUser     = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_PASSWORD;

  if (!smtpUser || !smtpPassword) {
    throw new Error("SMTP_USER or SMTP_PASSWORD not configured — cannot connect to IMAP");
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: smtpUser,
      pass: smtpPassword,
    },
    logger: false, // suppress verbose IMAP logs
  });

  const bouncedEmails = new Set<string>();

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      // Search for mailer-daemon messages in the last 48 hours
      const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const searchResult = await client.search({ from: "mailer-daemon", since });
      const messages: number[] = Array.isArray(searchResult) ? searchResult : [];

      if (messages.length === 0) {
        return [];
      }

      // Fetch and parse each bounce message
      for await (const msg of client.fetch(messages, { source: true })) {
        try {
          const rawSource = msg.source;
          if (!rawSource) continue;
          const parsed = await simpleParser(rawSource as Buffer);
          const subject = (parsed.subject ?? "").toLowerCase();
          const text    = (parsed.text ?? "").toLowerCase();
          const htmlRaw = parsed.html;
          const html    = (typeof htmlRaw === "string" ? htmlRaw : "").toLowerCase();
          const body    = text + " " + html;

          // Only process permanent failures (not temporary soft bounces)
          const isPermanent =
            subject.includes("delivery status notification") ||
            subject.includes("undeliverable") ||
            subject.includes("delivery failure") ||
            subject.includes("returned mail") ||
            subject.includes("mail delivery failed") ||
            body.includes("550") || // permanent failure SMTP code
            body.includes("551") ||
            body.includes("552") ||
            body.includes("553") ||
            body.includes("554") ||
            body.includes("user unknown") ||
            body.includes("no such user") ||
            body.includes("mailbox full") ||
            body.includes("account does not exist") ||
            body.includes("address rejected") ||
            body.includes("permanent error");

          if (!isPermanent) continue;

          // Extract the bounced email address from the message
          // Look in the "Final-Recipient" header first, then body
          const allHtml = typeof parsed.html === "string" ? parsed.html : "";
          const allText = (parsed.text ?? "") + " " + allHtml;
          const emailRegex = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
          const foundEmails = allText.match(emailRegex) ?? [];

          // Filter out system addresses (mailer-daemon, postmaster, noreply, etc.)
          const systemDomains = ["mailer-daemon", "postmaster", "noreply", "no-reply", "bounce", "lifestyledesignrealty.com"];
          for (const email of foundEmails) {
            const lower = email.toLowerCase();
            const isSystem = systemDomains.some(d => lower.includes(d));
            if (!isSystem && lower.includes("@")) {
              bouncedEmails.add(lower);
            }
          }
        } catch (parseErr) {
          console.warn("[bounceHandler] Failed to parse bounce message:", parseErr);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return Array.from(bouncedEmails);
}

// ── FUB lead operations ───────────────────────────────────────────────────────

interface FubPerson {
  id: number;
  name: string;
  emails: Array<{ value: string; type?: string }>;
  phones: Array<{ value: string; type?: string }>;
  tags: string[];
  stage?: string;
}

async function findLeadByEmail(email: string): Promise<FubPerson | null> {
  try {
    const data = await fubGet(`/people?email=${encodeURIComponent(email)}&limit=1`);
    const people = data?.people ?? [];
    if (people.length === 0) return null;
    return people[0] as FubPerson;
  } catch (e) {
    console.warn(`[bounceHandler] FUB lookup failed for ${email}:`, e);
    return null;
  }
}

function extractValidPhone(person: FubPerson): string | null {
  for (const phone of (person.phones ?? [])) {
    const digits = (phone.value ?? "").replace(/\D/g, "");
    if (digits.length >= 10) return digits;
  }
  return null;
}

async function removeBadEmailAndTag(person: FubPerson, badEmail: string): Promise<void> {
  // Remove the bad email from the emails array
  const updatedEmails = (person.emails ?? []).filter(
    e => e.value.toLowerCase() !== badEmail.toLowerCase()
  );

  // Add bad-email tag if not already present
  const currentTags = person.tags ?? [];
  const updatedTags = currentTags.includes("bad-email")
    ? currentTags
    : [...currentTags, "bad-email"];

  await fubPut(`/people/${person.id}`, {
    emails: updatedEmails,
    tags: updatedTags,
  });

  // Add a FUB note documenting the action
  const dateStr = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  await fubPost("/notes", {
    personId: person.id,
    subject: "Bad Email Removed — Bounce Handler",
    body: `Automated bounce handler removed bad email address "${badEmail}" on ${dateStr}. Gmail returned a permanent delivery failure (inbox full or address invalid). Lead has a valid phone number on file — kept in system with "bad-email" tag. Will continue to receive AI-powered nurture outreach from Lifestyle Bot via FUB notes.`,
    isHtml: false,
  });
}

async function moveLeadToTrash(person: FubPerson, badEmail: string): Promise<void> {
  // Delegate entirely to the Unified Compliance Layer
  await suppressLead({
    personId: person.id,
    reason: "bounce_no_phone",
    source: "bounce_handler",
    email: badEmail,
    leadName: person.name,
    extraContext: `Gmail returned a permanent delivery failure for "${badEmail}" (inbox full or address invalid). No valid phone number on file.`,
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export interface BounceHandlerResult {
  bouncesFound: number;
  leadsFound: number;
  leadsNotFound: number;
  emailRemovedPhoneKept: number;
  movedToTrash: number;
  errors: number;
  durationMs: number;
  details: string[];
}

export async function runBounceHandler(): Promise<BounceHandlerResult> {
  const startTime = Date.now();
  const result: BounceHandlerResult = {
    bouncesFound: 0,
    leadsFound: 0,
    leadsNotFound: 0,
    emailRemovedPhoneKept: 0,
    movedToTrash: 0,
    errors: 0,
    durationMs: 0,
    details: [],
  };

  const runId = `bounce-${Date.now()}`;

  try {
    console.log("[bounceHandler] Starting bounce scan...");

    // Step 1: Scan Gmail for bounced emails
    const bouncedEmails = await scanBouncedEmails();
    result.bouncesFound = bouncedEmails.length;
    console.log(`[bounceHandler] Found ${bouncedEmails.length} bounced email(s)`);

    if (bouncedEmails.length === 0) {
      await writeObservation({
        source: "bounce_handler",
        severity: "info",
        category: "email_bounce",
        message: "Bounce scan complete — no permanent failures found",
        detail: "Scanned last 48h of Gmail inbox for mailer-daemon messages",
        autoFixable: 0,
        runId,
      });
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Step 2: Process each bounced email
    for (const email of bouncedEmails) {
      try {
        const lead = await findLeadByEmail(email);

        if (!lead) {
          result.leadsNotFound++;
          result.details.push(`NOT FOUND in FUB: ${email}`);
          console.log(`[bounceHandler] No FUB lead found for ${email}`);
          continue;
        }

        result.leadsFound++;
        const phone = extractValidPhone(lead);

        if (phone) {
          // HAS PHONE → Keep lead active, remove bad email, tag for SMS-only outreach
          await removeBadEmailAndTag(lead, email);
          result.emailRemovedPhoneKept++;
          result.details.push(`KEPT (SMS-only): ${lead.name} — ${email} removed, phone ${phone} on file`);
          console.log(`[bounceHandler] Kept ${lead.name} (ID ${lead.id}) — bad email removed, phone ${phone} on file for SMS outreach`);
          await writeObservation({
            source: "bounce_handler",
            severity: "info",
            category: "email_bounce",
            message: `Bad email removed, lead kept for SMS — ${lead.name}`,
            detail: `Bad email: ${email}. Phone ${phone} on file. Tagged "bad-email", lead stays active for Power Queue SMS outreach.`,
            autoFixable: 0,
            runId,
          });
        } else {
          // NO PHONE → Trash (no way to reach this lead)
          await moveLeadToTrash(lead, email);
          result.movedToTrash++;
          result.details.push(`TRASHED (no phone): ${lead.name} — ${email}`);
          console.log(`[bounceHandler] Trashed ${lead.name} (ID ${lead.id}) — bad email, no phone`);
          await writeObservation({
            source: "bounce_handler",
            severity: "warning",
            category: "email_bounce",
            message: `Lead moved to Trash — ${lead.name} (no phone, bad email)`,
            detail: `Bad email: ${email}. No phone on file. Moved to Trash stage.`,
            autoFixable: 0,
            runId,
          });
        }
      } catch (leadErr) {
        result.errors++;
        const msg = leadErr instanceof Error ? leadErr.message : String(leadErr);
        result.details.push(`ERROR processing ${email}: ${msg}`);
        console.error(`[bounceHandler] Error processing ${email}:`, leadErr);

        await writeObservation({
          source: "bounce_handler",
          severity: "error",
          category: "email_bounce",
          message: `Bounce handler error for ${email}`,
          detail: msg.slice(0, 255),
          autoFixable: 0,
          runId,
        });
      }
    }

    // Step 3: Write summary observation
    const summaryMsg = `Bounce scan: ${result.bouncesFound} bounces, ${result.emailRemovedPhoneKept} emails removed (kept), ${result.movedToTrash} trashed, ${result.errors} errors`;
    await writeObservation({
      source: "bounce_handler",
      severity: result.errors > 0 ? "warning" : "info",
      category: "email_bounce",
      message: summaryMsg,
      detail: result.details.join(" | ").slice(0, 1000),
      autoFixable: 0,
      runId,
    });

    console.log(`[bounceHandler] Complete: ${summaryMsg}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[bounceHandler] Fatal error:", err);
    result.errors++;

    await writeObservation({
      source: "bounce_handler",
      severity: "error",
      category: "email_bounce",
      message: "Bounce handler fatal error",
      detail: msg.slice(0, 255),
      autoFixable: 0,
      runId,
    });
  }

  result.durationMs = Date.now() - startTime;
  return result;
}
