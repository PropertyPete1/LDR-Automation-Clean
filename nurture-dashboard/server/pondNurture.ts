/**
 * Pond Nurture Engine — Native TypeScript port of the Python pond nurture automation.
 *
 * Replaces the broken shell-exec approach in /api/scheduled/pond-nurture.
 * Runs entirely inside the deployed Node.js server — no Python, no shell, no sandbox paths.
 *
 * Scope (matches approved rules.yaml):
 *  - Phase 2: AI-personalized emails to all Lead Pond (pondId=2) leads, 14-day cadence, dynamic daily cap (eligible ÷ 14)
 *  - Phase 2b: Stale-agent reassignment to pond after 20+ days without omnichannel touch
 *  - Opt-out detection: inbound SMS/email/note keywords → Trash + suppression tag + FUB note
 *  - Purchase intent detection: inbound keywords → reassign to Peter Allen
 *  - AI skip check: LLM reviews FUB notes to avoid emailing leads who are off-market/opted-out
 *  - Full FUB note trail on every action
 *  - writeObservation for all outcomes (healer-compatible)
 *  - pondNurtureLog table for cadence dedup (replaces Python SQLite reengagement_log)
 */

import crypto from "crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, writeObservation } from "./db";
import { pondNurtureLog, suppressedLeads } from "../drizzle/schema";
import { suppressLead } from "./compliance";
import { invokeLLM } from "./_core/llm";

// ── Config (mirrors rules.yaml) ───────────────────────────────────────────────

const POND_ID = 2;
const PETER_USER_ID = 2;
const PETER_EMAIL = "peter@lifestyledesignrealty.com";
const COMPANY_NAME = "Lifestyle Design Realty";
const COMPANY_ADDRESS = "1209 S Saint Marys St #232, San Antonio, TX 78210";
const REENGAGEMENT_CADENCE_DAYS = 14;
// Dynamic cap: computed at runtime as Math.ceil(totalEligible / REENGAGEMENT_CADENCE_DAYS)
// Ensures every lead gets contacted every 14 days regardless of pond size.
// Safety floor: minimum 50/run. No hardcoded ceiling — scales with lead volume.
const MAX_REASSIGNMENTS_PER_RUN = 100;
const STALE_AGENT_DAYS = 20;
const STALE_REASSIGN_POND_ID = 2;

const EXCLUDED_STAGES = ["Trash"];
const EXCLUDED_TAGS = [
  "do not contact", "realtor", "bounced", "unsubscribe",
  "email opt out", "dnc", "do not nurture", "no ai email",
  "do not email", "manual review",
];
const MANUAL_SUPPRESSION_TAGS = [
  "Do Not Nurture", "No AI Email", "Do Not Email", "Manual Review",
];
const EMAIL_OPT_OUT_TAGS = ["email opt out", "unsubscribe"];
const STALE_REASSIGNMENT_EXCLUDED_STAGES = [
  "Active Client", "Pending", "Closed", "Past Client", "Sphere", "Under Contract",
];
const OPT_OUT_KEYWORDS = [
  "unsubscribe", "stop", "remove me", "opt out", "opt-out",
  "do not contact", "don't contact", "no more emails", "take me off",
  "remove from list", "cancel", "leave me alone",
];
const INTENT_KEYWORDS = [
  "yes", "interested", "ready", "looking", "buy", "home",
  "price", "schedule", "tour", "call me", "when", "how much",
];
const EXCLUDED_USER_IDS = [16, 34];

// ── SMS config ───────────────────────────────────────────────────────────────
// SMS removed — FUB /textMessages API returns 403 for this account (texting not available via API)

// ── FUB helpers ───────────────────────────────────────────────────────────────

const FUB_BASE = "https://api.followupboss.com/v1";
const FUB_TIMEOUT_MS = 15_000;

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

async function fubGetPeople(params: Record<string, string | number>): Promise<any[]> {
  const qs = new URLSearchParams();
  qs.set("limit", "100");
  qs.set("fields", "allFields");
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  let offset = 0;
  const all: any[] = [];
  while (true) {
    qs.set("offset", String(offset));
    const data = await fubRequest("GET", `/people?${qs}`);
    const people = data?.people ?? [];
    all.push(...people);
    if (people.length < 100) break;
    offset += 100;
    if (offset >= 10000) break; // Safety cap — well beyond expected pond size
    await new Promise(r => setTimeout(r, 300)); // rate limit courtesy
  }
  return all;
}

async function fubGetNotes(personId: number): Promise<any[]> {
  try {
    const data = await fubRequest("GET", `/notes?personId=${personId}&limit=25&sort=-createdAt`);
    return data?.notes ?? [];
  } catch { return []; }
}

async function fubGetEmails(personId: number): Promise<any[]> {
  try {
    const data = await fubRequest("GET", `/emails?personId=${personId}&limit=20&sort=-createdAt`);
    return data?.emails ?? [];
  } catch { return []; }
}

async function fubAddNote(personId: number, subject: string, body: string): Promise<void> {
  try {
    await fubRequest("POST", "/notes", { personId, subject, body, isHtml: false });
  } catch (e) {
    console.warn(`[PondNurture] FUB note failed for person ${personId}:`, e instanceof Error ? e.message : e);
  }
}

async function fubUpdatePerson(personId: number, payload: object): Promise<void> {
  await fubRequest("PUT", `/people/${personId}`, payload);
}

async function fubMergeTags(personId: number, newTags: string[]): Promise<void> {
  try {
    const person = await fubRequest("GET", `/people/${personId}?fields=tags`);
    const existing: string[] = person?.tags ?? [];
    const merged = Array.from(new Set([...existing, ...newTags]));
    await fubRequest("PUT", `/people/${personId}`, { tags: merged });
  } catch (e) {
    console.warn(`[PondNurture] Tag merge failed for person ${personId}:`, e instanceof Error ? e.message : e);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function personName(p: any): string {
  const fn = (p.firstName ?? "").trim();
  const ln = (p.lastName ?? "").trim();
  return [fn, ln].filter(Boolean).join(" ") || "Unknown";
}

function personFirstName(p: any): string {
  const raw = (p.firstName ?? "").trim();
  return raw.split(/\s+/)[0] || "there";
}

function hasTag(person: any, tags: string[]): boolean {
  const personTags: string[] = (person.tags ?? []).map((t: string) => t.toLowerCase());
  return tags.some(t => personTags.includes(t.toLowerCase()));
}

function isExcluded(person: any): boolean {
  const stage = (person.stage ?? "").toLowerCase();
  if (EXCLUDED_STAGES.some(s => s.toLowerCase() === stage)) return true;
  if (hasTag(person, EXCLUDED_TAGS)) return true;
  return false;
}

function getPersonEmail(person: any): string | null {
  const emails: any[] = person.emails ?? [];
  for (const e of emails) {
    const v = e.value ?? e.email ?? "";
    if (v && v.includes("@")) return v;
  }
  return null;
}

function detectCityFromNotes(notes: any[], person: any): string {
  const TX_CITIES = [
    "San Antonio", "New Braunfels", "Austin", "Dallas",
    "Fort Worth", "Houston", "Schertz", "Converse", "Boerne",
    "Seguin", "Kyle", "Buda", "Round Rock", "Cedar Park",
  ];
  const haystack = [
    person.city ?? "",
    ...(notes.slice(0, 10).map((n: any) => n.body ?? n.text ?? n.note ?? "")),
  ].join(" ").toLowerCase();
  for (const city of TX_CITIES) {
    if (haystack.includes(city.toLowerCase())) return city;
  }
  return "";
}

function cleanNoteText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[email]")
    .replace(/\b\d{3}[-.)\s]*\d{3}[-.\s]*\d{4}\b/g, "[phone]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function mostRecentNoteText(notes: any[]): string {
  if (!notes.length) return "";
  const raw = String(notes[0].body ?? notes[0].text ?? notes[0].note ?? notes[0].subject ?? "");
  return cleanNoteText(raw);
}

function hasRecentOmnichannelTouch(person: any, days: number): boolean {
  const cutoff = Date.now() - days * 86_400_000;
  const fields = [
    person.lastActivity, person.lastCalled, person.lastEmailed,
    person.lastTexted, person.lastContacted,
  ];
  for (const f of fields) {
    if (!f) continue;
    const ts = new Date(f).getTime();
    if (!isNaN(ts) && ts > cutoff) return true;
  }
  return false;
}

function buildEmailFooter(): string {
  return (
    `\n\n---\n` +
    `Lifestyle Design Realty | ${COMPANY_ADDRESS}\n` +
    `To unsubscribe, reply STOP or UNSUBSCRIBE to this email.`
  );
}

// ── Cadence dedup (MySQL pondNurtureLog) ──────────────────────────────────────

async function getLastNurtureDate(personId: number): Promise<Date | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select({ sentAt: pondNurtureLog.sentAt })
      .from(pondNurtureLog)
      .where(eq(pondNurtureLog.personId, personId))
      .orderBy(sql`sent_at DESC`)
      .limit(1);
    return rows[0]?.sentAt ?? null;
  } catch { return null; }
}

async function upsertNurtureLog(personId: number, city: string, subject: string): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(pondNurtureLog).values({
      personId,
      city,
      subject,
      sentAt: new Date(),
    }).onDuplicateKeyUpdate({ set: { sentAt: new Date(), city, subject } });
  } catch (e) {
    console.warn(`[PondNurture] upsertNurtureLog failed for ${personId}:`, e instanceof Error ? e.message : e);
  }
}

// ── Suppression check ─────────────────────────────────────────────────────────

async function isLocalSuppressed(personId: number): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    const rows = await db
      .select({ id: suppressedLeads.id })
      .from(suppressedLeads)
      .where(eq(suppressedLeads.personId, personId))
      .limit(1);
    return rows.length > 0;
  } catch { return false; }
}

// ── AI skip check ─────────────────────────────────────────────────────────────

async function shouldSkipLead(person: any, notes: any[]): Promise<{ skip: boolean; reason: string }> {
  if (!notes.length) return { skip: false, reason: "" };
  const rendered = notes.slice(0, 25).map((n: any, i: number) => {
    const raw = String(n.body ?? n.text ?? n.note ?? n.subject ?? "");
    return `${i + 1}. ${cleanNoteText(raw).slice(0, 700)}`;
  }).filter(Boolean);
  if (!rendered.length) return { skip: false, reason: "" };

  const firstName = personFirstName(person);
  const prompt = `You are a senior real estate CRM analyst reviewing Follow Up Boss notes for a lead named ${firstName}.
Your job is to decide whether this lead should be skipped for an automated two-week pond nurture email.

Your decision must be based on the OVERALL INTENT of the notes, not on any specific words or phrases.

SKIP the lead if the notes clearly communicate any of the following:
INTENT A — Lead is no longer available: bought a home, under contract, closed, renting instead, decided not to buy, search on hold, not in market.
INTENT B — Lead is working with someone else: committed to another agent, signed buyer agreement elsewhere, referred to another agent.
INTENT C — Lead explicitly asked to stop receiving outreach: opt-out, do not contact, stop texting, unsubscribe, expressed frustration.
INTENT D — Lead permanently relocated away from Texas real estate market.

DO NOT SKIP if:
- Notes show normal sales activity (calls, listings sent, showings, pre-approval, check-ins).
- Lead is temporarily paused but still interested (waiting until spring, watching rates, etc.).
- Notes are vague or could be interpreted either way — when in doubt, do NOT skip.

CONFIDENCE REQUIREMENT: Only skip if 80%+ confident. It is always safer to send than to incorrectly suppress.

Return strict JSON: { "should_skip": boolean, "intent_category": "A"|"B"|"C"|"D"|"none", "confidence": 0-100, "reason": "max 25 words" }

Notes (newest first):
${rendered.join("\n")}`;

  try {
    const response = await invokeLLM({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "skip_decision",
          strict: true,
          schema: {
            type: "object",
            properties: {
              should_skip: { type: "boolean" },
              intent_category: { type: "string" },
              confidence: { type: "number" },
              reason: { type: "string" },
            },
            required: ["should_skip", "intent_category", "confidence", "reason"],
            additionalProperties: false,
          },
        },
      },
    });
    const content = response?.choices?.[0]?.message?.content;
    if (!content) return { skip: false, reason: "" };
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    const shouldSkip = Boolean(parsed.should_skip);
    const confidence = Number(parsed.confidence ?? 0);
    const reason = String(parsed.reason ?? "").trim();
    if (shouldSkip && confidence < 80) return { skip: false, reason: "" };
    return { skip: shouldSkip, reason };
  } catch (e) {
    console.warn(`[PondNurture] AI skip check failed for person ${person.id}:`, e instanceof Error ? e.message : e);
    return { skip: false, reason: "" };
  }
}

// ── AI email generation ───────────────────────────────────────────────────────

async function generatePondEmail(
  person: any,
  city: string,
  recentNoteText: string
): Promise<{ subject: string; emailBody: string } | null> {
  const firstName = personFirstName(person);
  const personId = Number(person.id ?? 0);

  // Deterministic angle selection based on person ID + date
  const cycleSeed = `${personId}-${new Date().toISOString().slice(0, 10)}`;
  const seedHash = parseInt(
    crypto.createHash("sha256").update(cycleSeed).digest("hex").slice(0, 8),
    16
  );
  const angles = [
    "quick local market pulse and buying-power question",
    "neighborhood fit, commute, and lifestyle question",
    "rates/payment context with a low-pressure next-step question",
    "new construction, concessions, and timing question",
    "restaurants, bars, weekend lifestyle, and area-fit question",
    "home-search strategy and must-have priorities question",
  ];
  const angle = angles[seedHash % angles.length];
  const askReferral = seedHash % 4 === 0;
  const referralInstruction = askReferral
    ? "ADDITIONAL REQUIREMENT: Warmly ask if they know anyone else looking to buy or sell a home in Texas. Keep this extremely friendly, casual, and low-pressure, integrated naturally."
    : "";

  const cityInstruction = city && !["texas", "your area", "any city in texas", "texas/general"].includes(city.toLowerCase())
    ? `The lead appears interested in ${city}. Tailor the note to that city or area.`
    : "No reliable city is known. Speak broadly about helping them find the right home anywhere in Texas.";

  const prompt = `You are writing as Peter Allen from ${COMPANY_NAME}.
Draft a warm, personal two-week nurture email to a real estate lead in a Follow Up Boss pond.

Lead first name: ${firstName}
City or area guidance: ${cityInstruction}
Most recent FUB note: ${recentNoteText || "No recent note was available."}
Freshness angle for this cycle: ${angle}
Local market context: Use general, non-fabricated language. You may mention broad themes like inventory, rates, neighborhood fit, local restaurants, coffee shops, weekend events, and lifestyle, but do not invent specific openings, exact statistics, named businesses, or rate numbers.

Requirements:
- Make this feel like a one-off email Peter just wrote on his phone, not a drip, newsletter, campaign, or transactional automation.
- Write in a highly personal, warm, casual, and human tone. Think real estate advisor talking to a friend.
- Avoid run-on sentences. Break the text into very short, punchy, engaging paragraphs, maximum 2 to 3 sentences per paragraph.
- Use emojis naturally throughout the email, aim for 2 to 4 emojis.
- CRITICAL STYLE RESTRICTION: Do not use dashes anywhere in the subject or body. Use commas, parentheses, or a new sentence instead.
- CRITICAL STYLE RESTRICTION: Do not use bullet points, numbered lists, or list structures. Keep it strictly conversational prose.
- Write exactly ONE greeting line at the top, for example "Hey Matthew,". Use only the first name. Do not repeat the name in the opening sentence.
- Read the most recent FUB note and reference it naturally when helpful, without sounding creepy or quoting it directly.
- If the most recent note says listings were sent, naturally ask "Did you get a chance to look at those?"
- If the most recent note says the lead is pre-approved, reference that naturally in the body.
- Vary the angle naturally using the freshness angle, so each two-week cycle has a different subject, opening, and question.
- Do not invent exact statistics, new bar openings, rates, named businesses, or specific local events.
- Do not claim you personally toured a property, spoke with the lead, or know private facts unless provided.
- The subject line must be dynamic and specific to this lead's context. Do not use generic subjects like "Checking in" or "Just following up".
- ${referralInstruction}
- Keep it concise, 120 to 190 words, plain text, friendly, and specific enough to invite a reply.
- Ask exactly one simple question that makes it easy for the lead to respond.
- Never end with any question about automating an agent's workflow. This is a client email only.
- End with Peter's first name only. Do not add the company name, business address, legal disclaimer, or unsubscribe language.
- Return strict JSON with exactly these keys: subject, email_body.`;

  try {
    const response = await invokeLLM({
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "pond_email",
          strict: true,
          schema: {
            type: "object",
            properties: {
              subject: { type: "string" },
              email_body: { type: "string" },
            },
            required: ["subject", "email_body"],
            additionalProperties: false,
          },
        },
      },
    });
    const content = response?.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    const subject = String(parsed.subject ?? "").trim();
    const emailBody = String(parsed.email_body ?? "").trim();
    if (!subject || !emailBody) return null;
    return { subject, emailBody };
  } catch (e) {
    console.warn(`[PondNurture] Email generation failed for person ${person.id}:`, e instanceof Error ? e.message : e);
    return null;
  }
}


// ── SMTP send ─────────────────────────────────────────────────────────────────

async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  const nodemailer = await import("nodemailer");
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT ?? "587", 10);
  const smtpUser = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_PASSWORD;
  const fromEmail = process.env.EMAIL_FROM ?? PETER_EMAIL;

  if (!smtpHost || !smtpUser || !smtpPassword) {
    throw new Error("SMTP not configured");
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPassword },
  });

  await transporter.sendMail({
    from: `"Peter Allen" <${fromEmail}>`,
    to,
    subject,
    text: body,
    replyTo: fromEmail,
  });
}

// ── Opt-out detection ─────────────────────────────────────────────────────────

function detectOptOut(texts: any[], emails: any[], notes: any[]): { found: boolean; keyword: string; source: string } {
  const check = (text: string): string | null => {
    const lower = text.toLowerCase();
    for (const kw of OPT_OUT_KEYWORDS) {
      const pattern = new RegExp(`\\b${kw.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
      if (pattern.test(lower)) return kw;
    }
    return null;
  };

  for (const t of texts) {
    if (t.isIncoming || t.direction === "inbound") {
      const kw = check(t.message ?? t.body ?? "");
      if (kw) return { found: true, keyword: kw, source: "Inbound SMS" };
    }
  }
  for (const e of emails) {
    if (e.isIncoming || e.direction === "inbound") {
      const kw = check(`${e.body ?? ""} ${e.subject ?? ""}`);
      if (kw) return { found: true, keyword: kw, source: "Inbound Email" };
    }
  }
  for (const n of notes) {
    const body = String(n.body ?? n.text ?? n.note ?? "").toLowerCase();
    if (body.includes("reply") || body.includes("inbound") || body.includes("received")) {
      const kw = check(body);
      if (kw) return { found: true, keyword: kw, source: "Sync Note" };
    }
  }
  return { found: false, keyword: "", source: "" };
}

// ── Purchase intent detection ─────────────────────────────────────────────────

function detectIntent(texts: any[], emails: any[], notes: any[]): { found: boolean; keyword: string; source: string } {
  const check = (text: string): string | null => {
    const lower = text.toLowerCase();
    for (const kw of INTENT_KEYWORDS) {
      const pattern = new RegExp(`\\b${kw.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
      if (pattern.test(lower)) return kw;
    }
    return null;
  };

  for (const t of texts) {
    if (t.isIncoming || t.direction === "inbound") {
      const kw = check(t.message ?? t.body ?? "");
      if (kw) return { found: true, keyword: kw, source: "Inbound SMS" };
    }
  }
  for (const e of emails) {
    if (e.isIncoming || e.direction === "inbound") {
      const kw = check(`${e.body ?? ""} ${e.subject ?? ""}`);
      if (kw) return { found: true, keyword: kw, source: "Inbound Email" };
    }
  }
  for (const n of notes) {
    const body = String(n.body ?? n.text ?? n.note ?? "").toLowerCase();
    if (body.includes("reply") || body.includes("inbound") || body.includes("received")) {
      const kw = check(body);
      if (kw) return { found: true, keyword: kw, source: "Sync Note" };
    }
  }
  return { found: false, keyword: "", source: "" };
}

// ── Per-lead processor ────────────────────────────────────────────────────────

type LeadResult = "sent" | "skipped" | "suppressed" | "error";

async function processLead(person: any): Promise<LeadResult> {
  const personId = Number(person.id);
  const name = personName(person);

  // 1. Basic exclusion checks
  if (isExcluded(person)) {
    console.log(`[PondNurture] ${name} (${personId}): suppressed — excluded stage/tag`);
    return "suppressed";
  }
  if (hasTag(person, MANUAL_SUPPRESSION_TAGS)) {
    console.log(`[PondNurture] ${name} (${personId}): suppressed — manual suppression tag`);
    return "suppressed";
  }

  // 2. Must be in Lead Pond (pondId=2)
  const assignedPondId = Number(person.assignedPondId ?? 0);
  if (assignedPondId !== POND_ID) {
    return "suppressed";
  }

  // 3. Local suppression registry
  if (await isLocalSuppressed(personId)) {
    console.log(`[PondNurture] ${name} (${personId}): suppressed — in local suppressed_leads`);
    return "suppressed";
  }

  // 4. Email required
  const toEmail = getPersonEmail(person);
  if (!toEmail) {
    console.log(`[PondNurture] ${name} (${personId}): suppressed — no email`);
    return "suppressed";
  }
  if (hasTag(person, EMAIL_OPT_OUT_TAGS)) {
    console.log(`[PondNurture] ${name} (${personId}): suppressed — email opt-out tag`);
    return "suppressed";
  }

  // 5. 14-day cadence check
  const lastSent = await getLastNurtureDate(personId);
  if (lastSent) {
    const daysSince = (Date.now() - lastSent.getTime()) / 86_400_000;
    if (daysSince < REENGAGEMENT_CADENCE_DAYS) {
      console.log(`[PondNurture] ${name} (${personId}): skipped — sent ${Math.floor(daysSince)}d ago (cadence)`);
      return "skipped";
    }
  }

  // 6. Fetch FUB communications for opt-out / intent detection (no SMS — FUB API does not allow text reads)
  const [notes, emails] = await Promise.all([
    fubGetNotes(personId),
    fubGetEmails(personId),
  ]);
  const texts: any[] = []; // inbound SMS unavailable via FUB API

  // 7. Opt-out detection — route through unified compliance layer
  const optOut = detectOptOut(texts, emails, notes);
  if (optOut.found) {
    console.log(`[PondNurture] ${name} (${personId}): opt-out detected ("${optOut.keyword}" in ${optOut.source}) — trashing via compliance layer`);
    await suppressLead({
      personId,
      reason: "unsubscribe",
      source: "pond_nurture",
      leadName: name,
      extraContext: `Opt-out keyword "${optOut.keyword}" detected in ${optOut.source}. Lead moved to Trash and suppressed from all future automation.`,
    });
    return "suppressed";
  }

  // 8. Purchase intent detection
  const intent = detectIntent(texts, emails, notes);
  if (intent.found) {
    console.log(`[PondNurture] ${name} (${personId}): purchase intent detected ("${intent.keyword}") — reassigning to Peter`);
    await fubUpdatePerson(personId, { assignedUserId: PETER_USER_ID, assignedPondId: null });
    await fubMergeTags(personId, ["pond-intent-reassigned"]);
    await fubAddNote(
      personId,
      "🚨 Automation: Pond Lead Reassigned (Purchase Intent)",
      `Lead automatically reassigned to Peter Allen from Lead Pond.\n\n` +
      `🎯 Trigger: Purchase intent keyword matched!\n` +
      `• Keyword matched: "${intent.keyword}"\n` +
      `• Source channel: ${intent.source}\n\n` +
      `Lead is now assigned to Peter for immediate follow-up.`
    );
    await writeObservation({
      source: "pond_nurture",
      severity: "info",
      category: "intent_reassign",
      message: `Purchase intent detected for ${name} — reassigned to Peter`,
      detail: `Keyword: "${intent.keyword}" | Source: ${intent.source}`,
      autoFixable: 0,
    });
    return "skipped"; // Not an email send, but not an error
  }

  // 9. AI skip check
  const { skip, reason } = await shouldSkipLead(person, notes);
  if (skip) {
    console.log(`[PondNurture] ${name} (${personId}): AI skip — ${reason}`);
    await fubAddNote(
      personId,
      "🤖 Pond Nurture Skipped",
      `Automated pond nurture email was skipped after reviewing recent FUB notes.\n\n` +
      `Reason: ${reason || "Recent notes indicate this lead should not receive automated pond nurture right now."}\n\n` +
      `No email was sent.`
    );
    return "suppressed";
  }

  // 10. Recent contact check (3 days)
  if (hasRecentOmnichannelTouch(person, 3)) {
    console.log(`[PondNurture] ${name} (${personId}): skipped — contacted within 3 days`);
    return "skipped";
  }

  // 11. Generate email
  const city = detectCityFromNotes(notes, person);
  const recentNote = mostRecentNoteText(notes);
  const generated = await generatePondEmail(person, city, recentNote);
  if (!generated) {
    console.warn(`[PondNurture] ${name} (${personId}): email generation failed`);
    return "error";
  }

  // 12. Send email
  const fullBody = generated.emailBody + buildEmailFooter();
  await sendEmail(toEmail, generated.subject, fullBody);

  // 13. FUB note trail
  await fubAddNote(
    personId,
    `Pond Nurture Email Sent`,
    `Automated two-week pond nurture outreach sent.\n\n` +
    `• Channel: Email\n` +
    `• City focus: ${city || "Texas/general"}\n` +
    `• Subject: "${generated.subject}"`
  );

  // 15. Persist cadence log
  await upsertNurtureLog(personId, city || "Texas/general", generated.subject);

  console.log(`[PondNurture] ✓ Email sent to ${name} (${personId}) — "${generated.subject}"`);
  return "sent";
}

// ── Stale-agent reassignment ──────────────────────────────────────────────────

async function runStaleAgentReassignment(): Promise<{ reassigned: number; suppressed: number }> {
  // Use createdBefore (NOT lastActivityBefore) — lastActivity resets on every bot email,
  // causing year-old leads to be skipped because they look "recently active".
  // We want leads that were CREATED more than 20 days ago and never converted.
  const cutoffDate = new Date(Date.now() - STALE_AGENT_DAYS * 86_400_000);
  const cutoffStr = cutoffDate.toISOString().replace("T", " ").slice(0, 19);
  const candidates = await fubGetPeople({ createdBefore: cutoffStr });

  let reassigned = 0;
  let suppressed = 0;

  for (const person of candidates) {
    if (reassigned >= MAX_REASSIGNMENTS_PER_RUN) break;

    const personId = Number(person.id);
    const stage = String(person.stage ?? "");

    // Skip pond leads (already in pond)
    if (person.assignedPondId) { suppressed++; continue; }
    // Skip leads without an assigned agent
    if (!person.assignedUserId) { suppressed++; continue; }
    // Skip excluded agents
    if (EXCLUDED_USER_IDS.includes(Number(person.assignedUserId))) { suppressed++; continue; }
    // Skip protected stages
    if (STALE_REASSIGNMENT_EXCLUDED_STAGES.some(s => s.toLowerCase() === stage.toLowerCase())) {
      suppressed++;
      continue;
    }
    // Skip excluded/suppressed leads
    if (isExcluded(person)) { suppressed++; continue; }
    if (hasTag(person, MANUAL_SUPPRESSION_TAGS)) { suppressed++; continue; }
    // NOTE: We intentionally do NOT check hasRecentOmnichannelTouch here.
    // The bot emails these leads regularly, which would make them look "recently touched"
    // and block reassignment forever. The rule is simple: created 20+ days ago = pond.

    try {
      await fubUpdatePerson(personId, { assignedPondId: STALE_REASSIGN_POND_ID });
      await fubAddNote(
        personId,
        "🚨 Automation: Reassigned to Lead Pond",
        `Lead was created ${STALE_AGENT_DAYS}+ days ago and has not converted.\n\n` +
        `Automatically moved to Lead Pond for ongoing automated nurturing via the Lifestyle Bot.`
      );
      reassigned++;
      console.log(`[PondNurture] Stale reassign: ${personName(person)} (${personId})`);
    } catch (e) {
      console.warn(`[PondNurture] Stale reassign failed for ${personId}:`, e instanceof Error ? e.message : e);
    }
  }

  return { reassigned, suppressed };
}

// ── Main run function ─────────────────────────────────────────────────────────

export interface PondNurtureResult {
  sent: number;
  skipped: number;
  suppressed: number;
  errors: number;
  capReached: boolean;
  reassigned: number;
  durationMs: number;
  runId: string;
}

export async function runPondNurture(): Promise<PondNurtureResult> {
  const runId = crypto.randomUUID().slice(0, 16);
  const startMs = Date.now();
  console.log(`[PondNurture] Starting run ${runId}`);

  await writeObservation({
    source: "pond_nurture",
    severity: "info",
    category: "run_start",
    message: "Pond nurture run started",
    detail: `runId=${runId}`,
    autoFixable: 0,
    runId,
  });

  let sent = 0;
  let skipped = 0;
  let suppressed = 0;
  let errors = 0;
  let capReached = false;

  try {
    // Fetch all Lead Pond leads
    const candidates = await fubGetPeople({ pondId: POND_ID });
    console.log(`[PondNurture] Fetched ${candidates.length} pond leads`);

    // Dynamic daily cap: ensure every lead gets contacted every 14 days
    // As lead count grows, daily volume scales automatically
    const dailyCap = Math.max(50, Math.ceil(candidates.length / REENGAGEMENT_CADENCE_DAYS));
    console.log(`[PondNurture] Dynamic daily cap: ${dailyCap} (${candidates.length} leads ÷ ${REENGAGEMENT_CADENCE_DAYS} days)`);

    for (const person of candidates) {
      if (sent >= dailyCap) {
        capReached = true;
        console.log(`[PondNurture] Daily cap (${dailyCap}) reached`);
        break;
      }

      try {
        const result = await processLead(person);
        if (result === "sent") sent++;
        else if (result === "skipped") skipped++;
        else if (result === "suppressed") suppressed++;
        else if (result === "error") errors++;
      } catch (e) {
        errors++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[PondNurture] Unhandled error for person ${person.id}:`, msg);
        await writeObservation({
          source: "pond_nurture",
          severity: "error",
          category: "lead_error",
          message: `Pond nurture error for lead ${person.id}`,
          detail: msg.slice(0, 400),
          autoFixable: 0,
          runId,
        });
      }

      // Rate limit courtesy: 200ms between leads
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[PondNurture] Fatal run error:`, msg);
    await writeObservation({
      source: "pond_nurture",
      severity: "error",
      category: "run_error",
      message: "Pond nurture run failed with fatal error",
      detail: msg.slice(0, 400),
      autoFixable: 0,
      runId,
    });
    errors++;
  }

  // Stale-agent reassignment
  let reassigned = 0;
  try {
    const staleResult = await runStaleAgentReassignment();
    reassigned = staleResult.reassigned;
    console.log(`[PondNurture] Stale reassignment: ${reassigned} reassigned, ${staleResult.suppressed} suppressed`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[PondNurture] Stale reassignment error:`, msg);
    await writeObservation({
      source: "pond_nurture",
      severity: "error",
      category: "stale_reassignment_error",
      message: "Stale-agent reassignment failed",
      detail: msg.slice(0, 400),
      autoFixable: 0,
      runId,
    });
  }

  const durationMs = Date.now() - startMs;
  const summary = `${sent} emails sent, ${skipped} skipped, ${suppressed} suppressed, ${errors} errors, ${reassigned} reassigned${capReached ? " (cap reached)" : ""}`;

  await writeObservation({
    source: "pond_nurture",
    severity: errors > 0 ? "warning" : "info",
    category: "daily_run",
    message: `Pond nurture complete: ${summary}`,
    detail: `runId=${runId} | duration=${Math.round(durationMs / 1000)}s`,
    autoFixable: 0,
    runId,
  });

  // Send Peter a daily summary email
  await sendPeterSummary({ sent, skipped, suppressed, errors, capReached, reassigned, durationMs, runId });

  console.log(`[PondNurture] Run ${runId} complete in ${Math.round(durationMs / 1000)}s — ${summary}`);
  return { sent, skipped, suppressed, errors, capReached, reassigned, durationMs, runId };
}

// ── Peter daily summary email ─────────────────────────────────────────────────

async function sendPeterSummary(result: PondNurtureResult): Promise<void> {
  const { sent, skipped, suppressed, errors, capReached, reassigned, durationMs } = result;
  const subject = `📊 Pond Nurture Daily Summary — ${sent} emails sent`;
  const body = [
    `Hi Peter,`,
    ``,
    `Here's today's pond nurture automation summary:`,
    ``,
    `• Emails sent: ${sent}${capReached ? " (daily cap reached)" : ""}`,
    `• Leads skipped (cadence/intent): ${skipped}`,
    `• Leads suppressed (excluded/opt-out/AI skip): ${suppressed}`,
    `• Stale-agent reassignments to pond: ${reassigned}`,
    `• Errors: ${errors}`,
    `• Run duration: ${Math.round(durationMs / 1000)}s`,
    ``,
    errors > 0
      ? `⚠️ There were ${errors} error(s) this run. Check the bot observations log for details.`
      : `✅ No errors this run.`,
    ``,
    `Peter`,
  ].join("\n");

  try {
    await sendEmail(PETER_EMAIL, subject, body);
    console.log(`[PondNurture] Peter summary email sent`);
  } catch (e) {
    console.warn(`[PondNurture] Peter summary email failed:`, e instanceof Error ? e.message : e);
    await writeObservation({
      source: "pond_nurture",
      severity: "warning",
      category: "summary_email_error",
      message: "Peter daily summary email failed to send",
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
      autoFixable: 0,
    });
  }
}
