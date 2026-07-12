/**
 * botHelpers.ts
 * Shared utilities for all per-agent Lifestyle Bots.
 * Provides: FUB API client, SMTP email sender, highly intelligent LLM message generator,
 * lead email delivery, SMS dedup (sms_sent_today), bot observation writer,
 * bot run logger, and contacted_leads audit logger.
 *
 * EMAIL STRATEGY (per project rules):
 *   - Bots send emails to leads from the agent's @lifestyledesignrealty.com address.
 *   - SMS/texting via FUB is NOT used (disabled per system config).
 *   - Clock-in/off emails include Reply-To: peter@lifestyledesignrealty.com so agent
 *     replies land in Peter's inbox for review and action.
 */

import nodemailer from "nodemailer";
import { getDb } from "./db";
import { botObservations, botRunLogs, smsSentToday, contactedLeads } from "../drizzle/schema";
import { and, eq, gte, desc } from "drizzle-orm";
import { invokeLLM } from "./_core/llm";

// ─── Environment ────────────────────────────────────────────────────────────

export const FUB_API_KEY = process.env.FUB_API_KEY ?? "";
export const FUB_BASE = "https://api.followupboss.com/v1";

const SMTP_HOST = process.env.SMTP_HOST ?? "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT ?? "587");
const SMTP_USER = process.env.SMTP_USER ?? "";
const SMTP_PASSWORD = process.env.SMTP_PASSWORD ?? "";
const EMAIL_FROM = process.env.EMAIL_FROM ?? "peter@lifestyledesignrealty.com";

// Always CC Peter + Steven on every bot clock email
export const PETER_EMAIL = "peter@lifestyledesignrealty.com";
export const STEVEN_EMAIL = "steven@lifestyledesignrealty.com";

// ─── Daily Motivational Quotes ─────────────────────────────────────────────

const MOTIVATIONAL_QUOTES = [
  { quote: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { quote: "Success is not final, failure is not fatal: it is the courage to continue that counts.", author: "Winston Churchill" },
  { quote: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
  { quote: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
  { quote: "Believe you can and you're halfway there.", author: "Theodore Roosevelt" },
  { quote: "It always seems impossible until it's done.", author: "Nelson Mandela" },
  { quote: "Your time is limited, so don't waste it living someone else's life.", author: "Steve Jobs" },
  { quote: "The harder you work for something, the greater you'll feel when you achieve it.", author: "Unknown" },
  { quote: "Dream big and dare to fail.", author: "Norman Vaughan" },
  { quote: "You don't have to be great to start, but you have to start to be great.", author: "Zig Ziglar" },
  { quote: "Success usually comes to those who are too busy to be looking for it.", author: "Henry David Thoreau" },
  { quote: "The way to get started is to quit talking and begin doing.", author: "Walt Disney" },
  { quote: "Don't be afraid to give up the good to go for the great.", author: "John D. Rockefeller" },
  { quote: "I find that the harder I work, the more luck I seem to have.", author: "Thomas Jefferson" },
  { quote: "Opportunities don't happen. You create them.", author: "Chris Grosser" },
  { quote: "The real test is not whether you avoid this failure, because you won't. It's whether you let it harden or shame you into inaction.", author: "Barack Obama" },
  { quote: "In the middle of every difficulty lies opportunity.", author: "Albert Einstein" },
  { quote: "Success is walking from failure to failure with no loss of enthusiasm.", author: "Winston Churchill" },
  { quote: "The best time to plant a tree was 20 years ago. The second best time is now.", author: "Chinese Proverb" },
  { quote: "An investment in knowledge pays the best interest.", author: "Benjamin Franklin" },
  { quote: "I am not a product of my circumstances. I am a product of my decisions.", author: "Stephen Covey" },
  { quote: "Every strike brings me closer to the next home run.", author: "Babe Ruth" },
  { quote: "Life is 10% what happens to me and 90% of how I react to it.", author: "Charles Swindoll" },
  { quote: "The most common way people give up their power is by thinking they don't have any.", author: "Alice Walker" },
  { quote: "The mind is everything. What you think you become.", author: "Buddha" },
  { quote: "Twenty years from now you will be more disappointed by the things that you didn't do than by the ones you did do.", author: "Mark Twain" },
  { quote: "Either you run the day, or the day runs you.", author: "Jim Rohn" },
  { quote: "Whether you think you can or you think you can't, you're right.", author: "Henry Ford" },
  { quote: "The two most important days in your life are the day you are born and the day you find out why.", author: "Mark Twain" },
  { quote: "Whatever the mind of man can conceive and believe, it can achieve.", author: "Napoleon Hill" },
  { quote: "Strive not to be a success, but rather to be of value.", author: "Albert Einstein" },
];

/**
 * Returns a deterministic daily quote based on the current date.
 * Same quote all day, changes every day.
 */
export function getDailyQuote(): { quote: string; author: string } {
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86_400_000
  );
  return MOTIVATIONAL_QUOTES[dayOfYear % MOTIVATIONAL_QUOTES.length]!;
}

// ─── Stage / DNC filters ────────────────────────────────────────────────────

/**
 * Stages that are NEVER contacted by any agent bot.
 * Hot Prospect and Active Client are excluded — agents are actively working those.
 */
export const SKIP_STAGES = new Set([
  "Hot Prospect",
  "Active Client",
  "Closed",
  "Under Contract",
  "Pending",
  "Past Client",
  "Sphere of Influence",
  "Sphere",
  "Agent",
  "Vendor",
  "Archived",
  "Dead",
  "Unqualified",
  "Trash",
]);

/**
 * Minimum days of inactivity before the bot starts following up on an agent lead.
 * Bots work the 3-19 day window:
 *   Day 1-2:  Too fresh - agent is actively working it, bot stays out
 *   Day 3-19: Bot monitors notes; follows up every 3 days ONLY if agent has not
 *   Day 20+:  Python automation moves lead to pond -> pond nurture bot takes over
 */
export const STALE_DAYS_THRESHOLD = 3;

/**
 * Maximum days before the bot stops following up.
 * At 20 days the 8am Python automation moves the lead to the pond.
 * Bots must not chase leads that are already in the pond.
 */
export const BOT_WINDOW_MAX_DAYS = 19;
export const MAX_LEADS_PER_RUN = 15;

// ─── FUB API helpers ─────────────────────────────────────────────────────────

function fubAuthHeader(): string {
  return "Basic " + Buffer.from(`${FUB_API_KEY}:`).toString("base64");
}

/** Exponential-backoff fetch wrapper — retries on 429 */
export async function fubRequest<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${FUB_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: fubAuthHeader(),
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  let delay = 2000;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { ...options, headers });
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`FUB ${res.status} on ${path}: ${body}`);
    }
    return res.json() as Promise<T>;
  }
  throw new Error(`FUB rate-limit exceeded after 4 attempts on ${path}`);
}

export interface FubPerson {
  id: number;
  firstName?: string | null;
  lastName?: string | null;
  stage?: string | null;
  tags?: Array<string | { name?: string }>;
  phones?: Array<{ value: string; type?: string }>;
  emails?: Array<{ value: string; type?: string }>;
  textOptOut?: boolean;
  assignedPondId?: number | null;
  lastActivity?: string | null;
  lastActivityAt?: string | null; // alias — FUB returns lastActivity, kept for backward compat
  assignedUserId?: number | null;
  notes?: Array<{ body?: string; createdAt?: string }>;
}

/** Fetch all leads assigned to a given FUB user ID using cursor-based pagination.
 *
 * FUB disables offset-based pagination beyond offset=2000 (returns 400).
 * Instead we follow _metadata.next cursor tokens until exhausted.
 * Sort by -lastActivityAt so the most recently active leads come first,
 * allowing early-exit optimisations in callers that only need fresh leads.
 */
export async function fetchLeadsForAgent(agentFubId: number): Promise<FubPerson[]> {
  const leads: FubPerson[] = [];
  // Base URL — no offset, sorted by most-recently-active first
  const baseUrl = `/people?limit=100&assignedUserId=${agentFubId}&includeNotes=true&sort=-lastActivityAt`;
  let nextCursor: string | null = null;

  while (true) {
    const url: string = nextCursor
      ? `/people?limit=100&assignedUserId=${agentFubId}&includeNotes=true&sort=-lastActivityAt&next=${encodeURIComponent(nextCursor)}`
      : baseUrl;
    type FubPeoplePage = { people: FubPerson[]; _metadata: { total?: number; next?: string | null } };
    const data: FubPeoplePage = await fubRequest<FubPeoplePage>(url);
    const page = data.people ?? [];
    if (page.length === 0) break;
    leads.push(...page);
    nextCursor = data._metadata?.next ?? null;
    if (!nextCursor) break; // no more pages
  }
  return leads;
}

/** Post a note on a FUB lead */
export async function postFubNote(personId: number, body: string): Promise<void> {
  await fubRequest("/notes", {
    method: "POST",
    body: JSON.stringify({ personId, body, isHtml: false }),
  });
}

/** Check if a lead has a DNC / opt-out tag */
export function hasDncTag(person: FubPerson): boolean {
  const tags = person.tags ?? [];
  return tags.some(t => {
    const tag = (typeof t === "string" ? t : (t as { name?: string })?.name ?? "").toLowerCase();
    return tag.includes("opt-out") || tag.includes("do-not-contact") || tag.includes("dnc");
  });
}

/** Extract primary email address */
export function extractEmail(person: FubPerson): string | null {
  return person.emails?.[0]?.value ?? null;
}

/** Extract primary phone number (mobile preferred) */
export function extractPhone(person: FubPerson): string | null {
  const raw =
    person.phones?.find(p => p.type === "mobile")?.value ??
    person.phones?.[0]?.value;
  const phone = raw?.replace(/\D/g, "") ?? null;
  return phone && phone.length >= 10 ? phone : null;
}

/** Calculate days since last activity */
export function daysStale(person: FubPerson): number {
  // FUB returns 'lastActivity' (not 'lastActivityAt') — support both for safety
  const actDate = person.lastActivity ?? person.lastActivityAt;
  if (!actDate) return STALE_DAYS_THRESHOLD;
  return Math.floor(
    (Date.now() - new Date(actDate).getTime()) / (1000 * 60 * 60 * 24)
  );
}

/**
 * Determine if a lead is eligible for bot follow-up.
 *
 * Works the 3-19 day window:
 *   - Day 0-2:  Too fresh — agent is on it, bot stays out
 *   - Day 3-19: Bot steps in if agent has no recent note (shouldSkipLead handles that)
 *   - Day 20+:  Python automation already moved lead to pond — pond nurture takes over
 *
 * Excludes: skip stages, pond leads, DNC/opt-out, outside the 3-19 day window.
 */
export function isEligible(person: FubPerson): boolean {
  const stage = (person.stage ?? "").trim();
  if (SKIP_STAGES.has(stage)) return false;
  if (person.assignedPondId) return false; // already on a pond — handled by pond nurture
  if (person.textOptOut) return false;
  if (hasDncTag(person)) return false;
  const days = daysStale(person);
  if (days < STALE_DAYS_THRESHOLD) return false;   // too fresh — agent is on it
  if (days >= BOT_WINDOW_MAX_DAYS) return false;    // 20+ days → pond reassignment handles it (correct — this is the boundary)
  return true;
}

// ─── Power Queue integration ─────────────────────────────────────────────────

/**
 * Power Queue API — source of truth for 1-20 day stale leads.
 * The Power Queue shows leads the AGENT should personally text (days 1-20).
 * The bot handles leads 3–19 days stale via email — monitoring notes so it only
 * follows up when the agent hasn't already. At 20 days the lead moves to the
 * pond and the separate pond nurture system takes over.
 */
const POWER_QUEUE_API = "https://lifestyledash-wpnl8v84.manus.space/api/trpc/fub.getPendingQueue";

/**
 * Fetch the live Power Queue count for a specific agent.
 * The Power Queue applies smarter filters (phone required,
 * stage exclusions, priority scoring) that we can't fully replicate from FUB directly.
 *
 * Node.js fetch with a browser User-Agent gets 200 OK from the portal.
 * Falls back to 0 on any error so clock-in emails never fail.
 *
 * @param agentFirstName - The agent's first name as it appears in FUB (e.g. "Laila", "Tiffany")
 */
export async function fetchPowerQueueCount(
  agentFirstName: string
): Promise<number> {
  try {
    const input = JSON.stringify({ "0": { json: {} } });
    const url = `${POWER_QUEUE_API}?batch=1&input=${encodeURIComponent(input)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LifestyleBot/1.0)",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return 0;
    const data = await res.json() as Array<{ result: { data: { json: Array<{ assigned_agent: string }> } } }>;
    const leads = data[0]?.result?.data?.json ?? [];
    // Count leads assigned to this agent (portal uses first name match)
    return leads.filter(l =>
      (l.assigned_agent ?? "").toLowerCase().startsWith(agentFirstName.toLowerCase())
    ).length;
  } catch {
    return 0;
  }
}

// ─── SMS dedup ───────────────────────────────────────────────────────────────

/** Return set of personIds already contacted today (shared across all bots) */
export async function getSmsSentTodayIds(): Promise<Set<number>> {
  const db = await getDb();
  if (!db) return new Set();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const rows = await db
    .select({ personId: smsSentToday.personId })
    .from(smsSentToday)
    .where(gte(smsSentToday.sentAt, todayStart));
  return new Set(rows.map(r => r.personId));
}

/** Record that we contacted a lead today */
export async function recordSmsSentToday(
  personId: number,
  agentName: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(smsSentToday)
    .values({ personId, agentName, sentAt: new Date() })
    .onDuplicateKeyUpdate({ set: { agentName, sentAt: new Date() } });
}

// ─── Contacted Leads audit log ───────────────────────────────────────────────

// ─── Contact Cadence & Team-Wide Communication Checks ─────────────────────────

/** Minimum days between bot emails to the SAME lead (bot's own cadence). */
const BOT_MIN_CADENCE_DAYS = 7;

/** If ANY team member emailed the lead within this window, bot skips entirely. */
const TEAM_EMAIL_SKIP_DAYS = 3;

/**
 * Check if the BOT itself emailed this lead within the last BOT_MIN_CADENCE_DAYS.
 * Uses the local contacted_leads DB table (bot's own send log).
 */
export async function wasBotEmailedRecently(personId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const cutoff = new Date(Date.now() - BOT_MIN_CADENCE_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ personId: contactedLeads.personId })
    .from(contactedLeads)
    .where(and(eq(contactedLeads.personId, personId), gte(contactedLeads.sentAt, cutoff)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Check if ANY team member emailed or texted this lead within the last TEAM_EMAIL_SKIP_DAYS.
 * Uses FUB's /emails endpoint (sentByPerson: false = team sent) and /textMessages (isIncoming: false = team sent).
 * Only counts OUTBOUND communications from the team — inbound lead messages do NOT trigger a skip.
 */
export async function wasTeamEmailedRecently(personId: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - TEAM_EMAIL_SKIP_DAYS * 24 * 60 * 60 * 1000);

  try {
    // Check outbound EMAILS from team
    const emailData = await fubRequest<{
      emails?: Array<{
        date?: string;
        relatedPeople?: Array<{ personId?: number; sentByPerson?: boolean }>;
      }>;
    }>(`/emails?personId=${personId}&sort=-created&limit=10`);
    const emails = emailData.emails ?? [];
    for (const email of emails) {
      if (!email.date) continue;
      const emailDate = new Date(email.date);
      if (emailDate < cutoff) break; // Sorted newest-first, stop once past cutoff
      // sentByPerson: false means the TEAM sent it (outbound to lead)
      const relPerson = email.relatedPeople?.find(rp => rp.personId === personId);
      if (relPerson && relPerson.sentByPerson === false) return true;
    }
  } catch {
    // On FUB API error for emails, continue to text check
  }

  try {
    // Check outbound TEXT MESSAGES from team
    const textData = await fubRequest<{
      textmessages?: Array<{ sent?: string; isIncoming?: boolean }>;
    }>(`/textMessages?personId=${personId}&sort=-dateCreated&limit=5`);
    const texts = textData.textmessages ?? [];
    for (const text of texts) {
      if (!text.sent) continue;
      const textDate = new Date(text.sent);
      if (textDate < cutoff) break; // Sorted newest-first
      // isIncoming: false means the TEAM sent it (outbound to lead)
      if (text.isIncoming === false) return true;
    }
  } catch {
    // On FUB API error for texts, fail open
  }

  return false;
}

/**
 * Combined check: should the bot skip this lead due to recent contact?
 * Returns { skip: true, reason } if either:
 *   1. Any team member emailed within 3 days (team-wide check via FUB /emails)
 *   2. The bot itself emailed within 7 days (bot cadence check via local DB)
 */
export async function wasContactedRecently(personId: number): Promise<boolean> {
  // Rule 1: Team-wide 3-day skip
  if (await wasTeamEmailedRecently(personId)) return true;
  // Rule 2: Bot's own 7-day cadence
  if (await wasBotEmailedRecently(personId)) return true;
  return false;
}

/**
 * Fetch the most recent OUTBOUND team communication context for a lead.
 * Uses FUB /emails (sentByPerson: false) and /textMessages (isIncoming: false).
 * Since FUB hides email content, we also check notes for context clues.
 * Returns the most recent outbound activity date and any available context.
 */
export async function fetchRecentOutboundContext(personId: number): Promise<{
  type: "email" | "text";
  date: string;
  summary: string;
} | null> {
  let latestOutbound: { type: "email" | "text"; date: string; summary: string } | null = null;

  try {
    // Check outbound emails
    const emailData = await fubRequest<{
      emails?: Array<{
        date?: string;
        subject?: string;
        bodyExcerpt?: string;
        relatedPeople?: Array<{ personId?: number; sentByPerson?: boolean }>;
      }>;
    }>(`/emails?personId=${personId}&sort=-created&limit=5`);
    const emails = emailData.emails ?? [];
    for (const email of emails) {
      const relPerson = email.relatedPeople?.find(rp => rp.personId === personId);
      if (relPerson && relPerson.sentByPerson === false && email.date) {
        // FUB hides content but subject might be visible
        const subject = (email.subject && !email.subject.includes("CONTENT HIDDEN")) ? email.subject : "";
        const excerpt = (email.bodyExcerpt && !email.bodyExcerpt.includes("CONTENT HIDDEN")) ? email.bodyExcerpt : "";
        latestOutbound = {
          type: "email",
          date: email.date,
          summary: subject || excerpt || "Team sent an email (content not available from FUB API)",
        };
        break; // Only need the most recent
      }
    }
  } catch {
    // Continue
  }

  try {
    // Check outbound texts (these might be more recent)
    const textData = await fubRequest<{
      textmessages?: Array<{ sent?: string; isIncoming?: boolean; message?: string }>;
    }>(`/textMessages?personId=${personId}&sort=-dateCreated&limit=3`);
    const texts = textData.textmessages ?? [];
    for (const text of texts) {
      if (text.isIncoming === false && text.sent) {
        const textDate = new Date(text.sent);
        const existingDate = latestOutbound ? new Date(latestOutbound.date) : new Date(0);
        if (textDate > existingDate) {
          const msg = (text.message && !text.message.includes("hidden")) ? text.message : "";
          latestOutbound = {
            type: "text",
            date: text.sent,
            summary: msg || "Team sent a text message",
          };
        }
        break;
      }
    }
  } catch {
    // Continue
  }

  return latestOutbound;
}

/** Write a per-lead audit record for the lead list view on the dashboard */
export async function logContactedLead(opts: {
  botSlug: string;
  botName: string;
  person: FubPerson;
  daysStaleVal: number;
  messageBody: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const leadEmail = extractEmail(opts.person);
  await db.insert(contactedLeads).values({
    botSlug: opts.botSlug,
    botName: opts.botName,
    personId: opts.person.id,
    leadFirstName: opts.person.firstName ?? null,
    leadLastName: opts.person.lastName ?? null,
    leadEmail: leadEmail ?? null,
    stage: opts.person.stage ?? null,
    daysStale: opts.daysStaleVal,
    messageBody: opts.messageBody,
    sentAt: new Date(),
  });
}

// ─── Highly Intelligent LLM message generation ──────────────────────────────

/**
 * Uses the LLM to intelligently decide whether a lead should be skipped.
 * Understands natural language context — "decided to move to Florida",
 * "bought a house", "working with John at KW", "not in the market anymore" —
 * without needing a hardcoded keyword list.
 *
 * Returns { skip: true, reason: string } if the lead should be skipped.
 * Returns { skip: false } if it's safe to send a follow-up.
 *
 * This is a fast, cheap single-question LLM call (no email body generated).
 */
export async function shouldSkipLead(person: FubPerson): Promise<{ skip: boolean; reason?: string }> {
  const notes = person.notes ?? [];
  if (notes.length === 0) return { skip: false };

  // Build a compact note summary (most recent 3, max 300 chars each)
  const sorted = [...notes].sort((a, b) => {
    const aDate = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bDate = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bDate - aDate;
  }).slice(0, 3);

  const notesSummary = sorted.map((n, i) =>
    `Note ${i + 1} (${n.createdAt ?? "unknown date"}): ${(n.body ?? "").substring(0, 300)}`
  ).join("\n");

  const prompt = `You are a real estate CRM assistant. Your job is to decide whether a lead should be skipped for automated follow-up email outreach.

READ THESE NOTES FROM THE LEAD'S FILE:
${notesSummary}

SKIP the lead (answer YES) if the notes indicate ANY of the following:
- They are already working with a real estate agent (any agent, any brokerage)
- They have already purchased or are under contract on a home
- They have moved away, relocated, or are no longer in the market
- They have explicitly asked not to be contacted (unsubscribe, stop emailing, do not call, etc.)
- They are deceased, incarcerated, or otherwise unreachable
- The notes clearly show the situation is resolved and no follow-up is needed

DO NOT skip (answer NO) if:
- The notes just show normal sales activity (sent listings, had a call, scheduled a showing)
- The lead is still actively searching
- There are no notes or the notes are neutral

Respond with EXACTLY one line in this format:
SKIP: YES | reason: <brief reason>
or
SKIP: NO`;

  try {
    const response = await invokeLLM({
      messages: [
        { role: "system", content: "You are a precise real estate CRM assistant. Answer only in the exact format requested." },
        { role: "user", content: prompt },
      ],
    });
    const raw = ((response as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? "").trim();
    if (raw.toUpperCase().startsWith("SKIP: YES")) {
      const reasonMatch = raw.match(/reason:\s*(.+)/i);
      return { skip: true, reason: reasonMatch?.[1]?.trim() ?? "Notes indicate lead should be skipped" };
    }
    return { skip: false };
  } catch {
    // On LLM error, default to NOT skipping (fail open — better to send than miss)
    return { skip: false };
  }
}

/**
 * Backward-compatible wrapper — kept so existing bot files compile without changes.
 * NOTE: This is now async. Bot files use shouldSkipLead() directly.
 * @deprecated Use shouldSkipLead() instead.
 */
export function hasActiveContactNote(_person: FubPerson): boolean {
  // This synchronous version is no longer used — bots call shouldSkipLead() async.
  // Kept only to avoid breaking any legacy import references.
  return false;
}

/**
 * Build rich context from lead notes for the AI prompt.
 * Extracts the 3 most recent notes — the MOST RECENT note is labeled clearly
 * so the LLM knows to base the follow-up on it.
 */
function buildLeadContext(person: FubPerson): string {
  const notes = person.notes ?? [];
  if (notes.length === 0) return "No prior notes on this lead. Write a general friendly check-in.";

  const now = Date.now();

  // Sort all notes by date (newest first)
  const sorted = [...notes].sort((a, b) => {
    const aDate = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bDate = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bDate - aDate;
  });

  // Separate human notes from bot-generated notes
  // Bot notes start with "[" (e.g. "[S&P500 Lifestyle Bot]", "[Laila's Lifestyle Bot]")
  // or contain "Automated click-to-text", "Click-to-Text follow-up", or "Automated two-week pond nurture"
  const isBotNote = (body: string): boolean => {
    return /^\[.*Lifestyle Bot\]/.test(body) ||
      /^Automated click-to-text/i.test(body) ||
      /^Click-to-Text follow-up/i.test(body) ||
      /^Automated two-week pond nurture/i.test(body);
  };

  const humanNotes = sorted.filter(n => !isBotNote(n.body ?? ""));
  const botNotes = sorted.filter(n => isBotNote(n.body ?? ""));

  // Calculate how old the most recent HUMAN note is (critical for anti-hallucination)
  let mostRecentHumanDaysAgo = 999;
  if (humanNotes.length > 0 && humanNotes[0].createdAt) {
    mostRecentHumanDaysAgo = Math.floor((now - new Date(humanNotes[0].createdAt).getTime()) / (1000 * 60 * 60 * 24));
  }

  // Build context: prioritize human notes, then include bot notes for timeline awareness
  const contextLines: string[] = [];

  // Add a STALENESS WARNING if notes are old — this is the key anti-hallucination guard
  if (mostRecentHumanDaysAgo > 90) {
    contextLines.push(`🚨 CRITICAL WARNING: The most recent human note is ${mostRecentHumanDaysAgo} DAYS OLD (over ${Math.floor(mostRecentHumanDaysAgo / 30)} months ago). This lead has NOT been in active contact recently. Any events, meetings, calls, or plans mentioned in the notes below are ANCIENT HISTORY — they already happened long ago or never materialized. Do NOT reference them as current or upcoming.`);
  } else if (mostRecentHumanDaysAgo > 30) {
    contextLines.push(`⚠️ NOTE AGE WARNING: The most recent human note is ${mostRecentHumanDaysAgo} days old (over ${Math.floor(mostRecentHumanDaysAgo / 7)} weeks ago). Events mentioned in these notes are NOT current — do not reference them as recent or upcoming.`);
  }

  // Most important: the most recent HUMAN note (agent calls, Power Queue texts, manual notes)
  if (humanNotes.length > 0) {
    const mostRecent = humanNotes[0];
    const dateStr = mostRecent.createdAt ? new Date(mostRecent.createdAt).toLocaleDateString() : "unknown date";
    const daysAgo = mostRecent.createdAt
      ? Math.floor((now - new Date(mostRecent.createdAt).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    const ageLabel = daysAgo !== null ? ` [${daysAgo} days ago]` : "";
    contextLines.push(`⭐ MOST IMPORTANT — Latest human/agent note (${dateStr}${ageLabel}):\n${(mostRecent.body ?? "").substring(0, 500)}`);
    // Add 1-2 more human notes for deeper context
    for (let i = 1; i < Math.min(3, humanNotes.length); i++) {
      const note = humanNotes[i];
      const d = note.createdAt ? new Date(note.createdAt).toLocaleDateString() : "unknown";
      const noteDaysAgo = note.createdAt
        ? Math.floor((now - new Date(note.createdAt).getTime()) / (1000 * 60 * 60 * 24))
        : null;
      const noteAgeLabel = noteDaysAgo !== null ? ` [${noteDaysAgo} days ago]` : "";
      contextLines.push(`Previous agent note (${d}${noteAgeLabel}): ${(note.body ?? "").substring(0, 300)}`);
    }
  }

  // Include the most recent bot note for timeline awareness (so AI knows what was last sent)
  if (botNotes.length > 0) {
    const lastBot = botNotes[0];
    const d = lastBot.createdAt ? new Date(lastBot.createdAt).toLocaleDateString() : "unknown";
    contextLines.push(`Last bot email sent (${d}): ${(lastBot.body ?? "").substring(0, 200)}`);
  }

  if (contextLines.length === 0) {
    return "No meaningful notes found. Write a general friendly check-in.";
  }

  return `Notes from Follow Up Boss (READ CAREFULLY — your email MUST reference this context):\n${contextLines.join("\n\n")}`;
}

/**
 * Generate a highly personalized, intelligent AI follow-up email for a lead.
 * Uses lead stage, days stale, notes context, and behavioral signals.
 * Returns both the email body AND a context-aware subject line.
 */
export async function generateFollowUpMessage(opts: {
  agentFirstName: string;
  agentLastName: string;
  leadFirstName: string | null;
  daysStale: number;
  stage: string;
  person?: FubPerson;
}): Promise<{ body: string; subject: string }> {
  const { agentFirstName, agentLastName, leadFirstName, daysStale: staleDays, stage, person } = opts;
  const hasName = !!leadFirstName && leadFirstName.toLowerCase() !== "there";
  const nameContext = hasName
    ? `The lead's first name is ${leadFirstName}. Use only their first name — never their last name. The greeting must be exactly "Hey ${leadFirstName}," — ONE greeting, ONE name, nothing else on that line.`
    : `We do not have the lead's first name. Open with "Hey, it's ${agentFirstName} with Lifestyle Design Realty!" — do not repeat any greeting.`;

  const leadContext = person ? buildLeadContext(person) : "No prior notes available.";

  // Fetch recent outbound team communication for additional context
  let recentOutboundNote = "";
  if (person?.id) {
    const outbound = await fetchRecentOutboundContext(person.id);
    if (outbound) {
      const daysAgo = Math.round((Date.now() - new Date(outbound.date).getTime()) / (1000 * 60 * 60 * 24));
      recentOutboundNote = `\n\n⚡ RECENT TEAM OUTBOUND (${daysAgo} day(s) ago via ${outbound.type}): ${outbound.summary}\nIMPORTANT: A team member JUST reached out ${daysAgo} day(s) ago. Your follow-up MUST acknowledge or build on this recent contact — do NOT write as if no one has spoken to them recently.`;
    }
  }

  // Determine urgency/tone based on staleness
  let urgencyNote = "";
  if (staleDays >= 180) {
    urgencyNote = "⚠️ LONG-DORMANT LEAD: This lead has been completely cold for 6+ MONTHS. There has been NO real conversation in a very long time. You MUST write a gentle re-engagement email that honestly acknowledges the time gap. Say something like 'It's been a while since we last connected' or 'Hope you've been well — just wanted to reach back out.' NEVER pretend there was a recent conversation or meeting. NEVER reference old notes as if they are current.";
  } else if (staleDays >= 60) {
    urgencyNote = "This lead has been completely cold for 2+ months. Write a gentle re-engagement message that acknowledges time has passed without being pushy. Do NOT pretend there was recent contact.";
  } else if (staleDays >= 40) {
    urgencyNote = "This lead has been inactive for 40+ days. Write a warm check-in that feels natural and not salesy.";
  } else if (staleDays >= 14) {
    urgencyNote = "This lead has been inactive for 2+ weeks. They may be busy or distracted. Write a warm, low-pressure follow-up that references their specific situation.";
  } else {
    urgencyNote = "This lead was recently active (under 2 weeks ago). Write a natural continuation of the last conversation — keep it brief and specific.";
  }

  // Stage-specific guidance
  let stageGuidance = "";
  switch (stage.toLowerCase()) {
    case "new":
    case "new lead":
      stageGuidance = "This is a newer lead. Express genuine excitement about helping them find their dream home.";
      break;
    case "nurture":
    case "long-term nurture":
      stageGuidance = "This is a long-term nurture lead. Keep it light — no pressure, just staying top of mind.";
      break;
    case "watch":
      stageGuidance = "This lead is being watched. They may be close to being ready. Be a bit more proactive.";
      break;
    default:
      stageGuidance = `This lead is in the "${stage}" stage. Tailor your message appropriately.`;
  }

  const prompt = `You are ${agentFirstName} ${agentLastName}, a real estate agent at Lifestyle Design Realty in Texas.
You are writing a personalized follow-up email to a real estate lead.

LEAD CONTEXT:
- ${nameContext}
- Days since last contact: ${staleDays}
- Lead stage: ${stage}
- ${urgencyNote}
- ${stageGuidance}

PRIOR NOTES:
${leadContext}${recentOutboundNote}

CRITICAL INSTRUCTIONS — READ CAREFULLY:
1. The ⭐ MOST IMPORTANT note above is your #1 priority. Your email MUST be a direct, natural continuation of whatever happened in that note.
   - If the note mentions specific builders/communities (e.g. "Perry", "Highland Homes", "Meritage") → ask about THOSE SPECIFIC builders by name
   - If the note mentions home options/listings were sent → ask "Did you get a chance to look at those options I sent over?"
   - If the note mentions a showing was scheduled → ask how the showing went
   - If the note mentions a specific city/area/budget/timeline → reference it directly
   - If the note mentions a phone call → reference what was discussed on the call
   - If the note is a Power Queue text about specific homes → follow up on those exact homes
   - ONLY if there are truly NO notes with any context → write a general friendly check-in
2. ABSOLUTELY NEVER write a generic "just checking in" or "checking on your search" email if the notes contain ANY specific detail (builder names, areas, timelines, preferences, prior conversations). This is the #1 rule.
3. Write 2-4 sentences only. Warm, casual, genuine — like a real person texting a friend.
4. Never mention automation, AI, or that this is a follow-up system.
5. Include a soft call-to-action that directly relates to the note context (e.g. "Would you like me to set up a tour of the Perry models?" not "Let me know if I can help!").
6. Sign off with just your first name.
7. If the notes mention the lead is moving in the FUTURE (e.g. "moving July 2027") — acknowledge their timeline and offer to keep them updated on new inventory as it comes, don't push for immediate action.

🚫 ANTI-HALLUCINATION RULES (ABSOLUTE — NEVER VIOLATE):
8. NEVER invent, fabricate, or assume ANY of the following:
   - Meetings ("our meeting", "that Friday meeting", "our appointment")
   - Phone calls ("our chat", "our conversation", "when we spoke")
   - Prior interactions that are not EXPLICITLY described in the notes above
   - Scheduled events that are not EXPLICITLY confirmed in the notes above
9. PAY ATTENTION TO NOTE DATES. Each note has a [X days ago] label. If a note is 30+ days old:
   - Do NOT say "our recent chat" — it was NOT recent
   - Do NOT reference plans/meetings from that note as if they are upcoming — they already happened or fell through months ago
   - If notes mention "this Friday" or "next week" but the note is 30+ days old, those dates have LONG PASSED
10. If the most recent human note is 90+ days old (see 🚨 CRITICAL WARNING above):
    - You MUST write a gentle RE-ENGAGEMENT email that acknowledges it's been a while
    - Use phrases like "It's been a while since we last connected" or "Hope you've been well — wanted to reach back out"
    - NEVER pretend you just spoke to them or that there's a current conversation going
11. If you are unsure whether something happened recently, DO NOT MENTION IT. Only reference facts that are clearly stated AND recent (within 30 days) in the notes.
12. NEVER use the phrases: "our recent chat", "our conversation", "that meeting we have", "following up on our call" — UNLESS a note from within the last 14 days explicitly describes that specific call/chat/meeting happening.

FORMAT:
- Line 1: SUBJECT: <a natural, context-aware subject line that references the SPECIFIC context from notes. NEVER use generic subjects like "Checking in" or "Checking on your search" if notes mention specific details. Examples: "Quick question about Perry Homes", "Following up on the Highland Homes options", "Any thoughts on those listings in [area]?", "Still thinking about that [specific thing from notes]?">
- Line 2 onwards: The email body. Start with ONE single greeting line only (e.g. "Hey Matthew,"). Do NOT repeat the name or write two greetings. The very next line after the greeting should be the first sentence of the message.

IMPORTANT:
1. The subject line MUST reflect the actual context from the notes. Never use a generic subject like "Checking in" if the notes show a specific prior action.
2. NEVER write "Hey Matthew, Hi Matthew" or any double greeting. One greeting, one name, period.`;

  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: "You are an expert real estate agent writing highly personalized, intelligent follow-up emails. Your emails feel handcrafted and genuine, never automated. You always reference specific context when available. CRITICAL: You NEVER fabricate or invent facts. You NEVER mention meetings, calls, or conversations that are not explicitly described in the notes. If notes are old (30+ days), you treat them as historical context, NOT as recent events.",
      },
      { role: "user", content: prompt },
    ],
  });

  const raw = (response as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? "";

  // Extract subject line from first line if present
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  let subject = `Following up — ${opts.agentFirstName} ${opts.agentLastName}, Lifestyle Design Realty`;
  let bodyLines = lines;

  if (lines[0]?.toUpperCase().startsWith("SUBJECT:")) {
    let subjectText = lines[0].replace(/^SUBJECT:\s*/i, "").trim();
    // Strip hallucinated meeting/chat references from subject line too
    if (/our (recent )?(chat|conversation|meeting)/i.test(subjectText) ||
        /that (friday|monday|tuesday|wednesday|thursday|saturday|sunday) meeting/i.test(subjectText) ||
        /following up on our (call|chat)/i.test(subjectText)) {
      subjectText = ""; // Fall through to default subject
    }
    if (subjectText) subject = `${subjectText} — ${opts.agentFirstName} ${opts.agentLastName}`;
    bodyLines = lines.slice(1);
  }

  const body = bodyLines
    .join("\n")
    // Strip any leaked automation/AI-assistant lines the LLM may add
    .replace(/Is there anything else I can automate to make your life easier\?/gi, "")
    .replace(/Is there anything (else )?I can (help|automate|do) to make your (life|day|work) easier\??/gi, "")
    .replace(/Would you like me to automate anything[^\n]*/gi, "")
    .replace(/Let me know if there['\u2019]?s anything (else )?I can automate[^\n]*/gi, "")
    .replace(/Reply to this email with any(thing)?[^\n]*automate[^\n]*/gi, "")
    // Remove any trailing blank lines left by the strips
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // SAFETY CHECK: If the lead's most recent human note is 90+ days old,
  // verify the email doesn't contain hallucinated recent-contact language.
  // This is a last-resort guardrail — the prompt should prevent this, but
  // if the LLM still hallucinates, we catch it here.
  if (person) {
    const humanNotes = (person.notes ?? [])
      .filter(n => {
        const b = n.body ?? "";
        return !(/^\[.*Lifestyle Bot\]/.test(b) || /^Automated/i.test(b) || /^Click-to-Text/i.test(b));
      })
      .sort((a, b) => {
        const aD = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bD = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bD - aD;
      });
    const newestHumanNote = humanNotes[0];
    const humanNoteDaysAgo = newestHumanNote?.createdAt
      ? Math.floor((Date.now() - new Date(newestHumanNote.createdAt).getTime()) / (1000 * 60 * 60 * 24))
      : 999;
    if (humanNoteDaysAgo > 90) {
      // Check for hallucinated recent-contact phrases
      const hallucinationPatterns = [
        /our (recent )?chat/i,
        /our (recent )?conversation/i,
        /that (friday|monday|tuesday|wednesday|thursday|saturday|sunday) meeting/i,
        /meeting we have (coming up|scheduled)/i,
        /when we (spoke|talked|chatted) (last|recently)/i,
        /following up on our (call|chat|meeting|conversation)/i,
        /great (talking|chatting|speaking) (with you|to you) (recently|the other day|last)/i,
      ];
      const hasHallucination = hallucinationPatterns.some(p => p.test(body));
      if (hasHallucination) {
        // Regenerate with an explicit override — but to avoid infinite loops,
        // just return a safe generic re-engagement instead
        const safeName = leadFirstName && leadFirstName.toLowerCase() !== "there" ? leadFirstName : null;
        const safeGreeting = safeName ? `Hey ${safeName},` : `Hey, it's ${agentFirstName} with Lifestyle Design Realty!`;
        const safeBody = `${safeGreeting}\n\nHope you've been well! It's been a while since we last connected, and I just wanted to reach back out. If you're still thinking about buying or selling in Texas at some point, I'd love to be a resource for you — no pressure at all.\n\n${agentFirstName}`;
        const safeSubject = `Hope you're doing well, ${safeName ?? "friend"}!`;
        return { body: safeBody, subject: safeSubject };
      }
    }
  }

  return { body, subject };
}

// ─── Lead email delivery ──────────────────────────────────────────────────────

/**
 * Send a follow-up email directly to a lead from the agent's email address.
 * This is the primary outreach channel (SMS is disabled per system config).
 */
export async function sendLeadFollowUpEmail(opts: {
  agentEmail: string;
  agentFirstName: string;
  agentLastName: string;
  leadEmail: string;
  leadFirstName: string | null;
  messageBody: string;
  subject?: string;
}): Promise<void> {
  const { agentEmail, agentFirstName, agentLastName, leadEmail, messageBody } = opts;
  // Use the context-aware subject from the LLM, or fall back to a generic one.
  const subject = opts.subject ?? `Following up — ${agentFirstName} ${agentLastName}, Lifestyle Design Realty`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6; color: #333;">
      ${messageBody
        .split("\n")
        .filter(line => line.trim())
        .map(line => `<p style="margin: 0 0 12px 0;">${line}</p>`)
        .join("")}
      <p style="margin-top: 24px; color: #666; font-size: 0.85em; border-top: 1px solid #eee; padding-top: 12px;">
        ${agentFirstName} ${agentLastName}<br/>
        Lifestyle Design Realty<br/>
        <a href="https://lifestyledesignrealty.com" style="color: #2c5f2e;">lifestyledesignrealty.com</a>
      </p>
    </div>
  `;

  await sendEmail({
    from: `${agentFirstName} ${agentLastName} <${agentEmail}>`,
    to: leadEmail,
    subject,
    html,
  });
}

// ─── SMTP email ──────────────────────────────────────────────────────────────

let _transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    });
  }
  return _transporter;
}

export async function sendEmail(opts: {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
}): Promise<void> {
  const transporter = getTransporter();
  await transporter.sendMail({
    from: opts.from ?? EMAIL_FROM,
    to: Array.isArray(opts.to) ? opts.to.join(", ") : opts.to,
    subject: opts.subject,
    html: opts.html,
    replyTo: opts.replyTo,
  });
}

// ─── Clock-in / Clock-off emails ─────────────────────────────────────────────

/**
 * Clock-in email sent at 10am CT.
 * Asks the agent if they want anything automated — replies go to Peter's email.
 * Recipients: Peter, Steven, and the agent.
 */
/** Lifestyle Bot Dashboard base URL */
const DASHBOARD_BASE = "https://lifestyledash-wpnl8v84.manus.space";

/**
 * Leaders who see the full multi-agent dashboard (/).
 * All other agents get their own scoped /agent/:slug view.
 */
const LEADER_AGENTS = new Set(["peter", "steven", "stefanie", "rue"]);

/**
 * Maps agent first name (lowercase) to their bot slug on the new Lifestyle Bot Dashboard.
 * Leaders get the full dashboard (/), non-leaders get /agent/:slug.
 */
const AGENT_DASHBOARD_SLUG: Record<string, string> = {
  peter: "peter",
  steven: "steven",
  tiffany: "tiffany",
  stefanie: "stefanie",
  rue: "stefanie",   // Rue is Stefanie's bot name — map to her slug
  abby: "abby",
  irma: "irma",
  laila: "laila",
};

/** Maps bot agentFirstName (lowercase) to the FUB display name used by the Power Queue ?agent= filter */
const POWER_QUEUE_AGENT_NAME: Record<string, string> = {
  peter: "Peter",
  steven: "Steven",
  tiffany: "Tiffany",
  stefanie: "Stefanie",
  rue: "Stefanie",   // Rue bot is assigned to Stefanie Graham
  abby: "Abby",
  irma: "Irma",
  laila: "Laila",
};

export async function sendClockinEmail(opts: {
  botName: string;
  agentFirstName: string;
  agentLastName: string;
  agentEmail: string;
  leadsQueued: number;          // Bot's job: 3-19 day stale leads the bot will email today
  powerQueueCount?: number;     // Agent's job: 1-20 day stale leads in the Power Queue
  accentColor?: string;
  headerGradient?: string;
}): Promise<void> {
  const { botName, agentFirstName, agentLastName, agentEmail, leadsQueued } = opts;
  const powerQueueCount = opts.powerQueueCount ?? 0;
  const accent = opts.accentColor ?? "#2c5f2e";
  const gradient = opts.headerGradient ?? "linear-gradient(135deg,#1a3d1c 0%,#2c5f2e 60%,#3a7d3c 100%)";
  const isCombined = agentFirstName === "Steven & Peter";
  const greeting = isCombined ? "Good morning, Steven and Peter!" : `Good morning, ${agentFirstName}!`;
  const agentDisplay = isCombined ? "Steven Van Orden and Peter Allen" : `${agentFirstName} ${agentLastName}`;
  const dailyQuote = getDailyQuote();

  // Build Power Queue + agent dashboard links
  const pqAgentName = isCombined ? null : POWER_QUEUE_AGENT_NAME[agentFirstName.toLowerCase()];
  const powerQueueUrl = pqAgentName
    ? `${DASHBOARD_BASE}/sms-queue?agent=${encodeURIComponent(pqAgentName)}`
    : `${DASHBOARD_BASE}/sms-queue`;
  const agentSlug = isCombined ? null : AGENT_DASHBOARD_SLUG[agentFirstName.toLowerCase()];
  const isLeader = isCombined || (agentFirstName && LEADER_AGENTS.has(agentFirstName.toLowerCase()));
  const agentDashboardUrl = isLeader
    ? `${DASHBOARD_BASE}/`
    : agentSlug
      ? `${DASHBOARD_BASE}/agent/${agentSlug}`
      : null;
  const stevenDashUrl = `${DASHBOARD_BASE}/`;
  const peterDashUrl = `${DASHBOARD_BASE}/`;

  const subject = `☀️ ${botName} — Good Morning! Clocking In`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:32px 0;">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

        <!-- HERO HEADER -->
        <tr>
          <td style="background:${gradient};padding:48px 40px 36px;text-align:center;">
            <div style="display:inline-block;background:rgba(255,255,255,0.12);border-radius:50%;width:72px;height:72px;line-height:72px;font-size:36px;margin-bottom:16px;">🤖</div>
            <p style="margin:0 0 8px 0;font-size:12px;color:rgba(255,255,255,0.65);letter-spacing:3px;text-transform:uppercase;">Lifestyle Design Realty</p>
            <h1 style="margin:0 0 6px 0;font-size:30px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">${botName}</h1>
            <p style="margin:0 0 20px 0;font-size:15px;color:rgba(255,255,255,0.85);">Automation Assistant &mdash; Clocking In</p>
            <div style="display:inline-block;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.3);border-radius:24px;padding:8px 20px;">
              <span style="font-size:13px;color:#fff;font-weight:600;">☀️ &nbsp;${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</span>
            </div>
          </td>
        </tr>

        <!-- GREETING -->
        <tr>
          <td style="padding:40px 44px 0;">
            <h2 style="margin:0 0 12px 0;font-size:24px;font-weight:700;color:#111827;">${greeting}</h2>
            <p style="margin:0;font-size:15px;color:#374151;line-height:1.85;">I'm starting my work day on behalf of <strong style="color:#111827;">${agentDisplay}</strong>. Here's my plan for today:</p>
          </td>
        </tr>

        <!-- COLORED DIVIDER -->
        <tr>
          <td style="padding:24px 44px 0;">
            <div style="height:2px;background:linear-gradient(90deg,${accent}33,${accent},${accent}33);border-radius:2px;"></div>
          </td>
        </tr>

        <!-- TODAY'S PLAN -->
        <tr>
          <td style="padding:24px 44px 0;">
            <h3 style="margin:0 0 16px 0;font-size:18px;font-weight:700;color:#111827;">📅 Here's What I'm Doing Today</h3>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-left:4px solid ${accent};border-radius:0 10px 10px 0;">
              <tr><td style="padding:20px 24px;">
                <table cellpadding="0" cellspacing="0" width="100%">
                  <tr><td style="padding:6px 0;font-size:14px;color:#374151;line-height:1.7;">🔍 &nbsp;Scan leads assigned to <strong>${isCombined ? 'Steven and Peter' : agentFirstName}</strong> with 3–19 days no agent activity</td></tr>
                  <tr><td style="padding:6px 0;font-size:14px;color:#374151;line-height:1.7;">📧 &nbsp;Send personalized, AI-crafted follow-up emails to eligible leads</td></tr>
                  <tr><td style="padding:6px 0;font-size:14px;color:#374151;line-height:1.7;">📝 &nbsp;Log a note in Follow Up Boss for every lead contacted</td></tr>
                  <tr><td style="padding:6px 0;font-size:14px;color:#374151;line-height:1.7;">📊 &nbsp;Send a full summary report at <strong>6:00 PM CT</strong></td></tr>
                </table>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- LEADS QUEUED STAT -->
        <tr>
          <td style="padding:24px 44px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:${gradient};border-radius:12px;">
              <tr>
                <td style="padding:24px 28px;">
                  <p style="margin:0 0 4px 0;font-size:12px;color:rgba(255,255,255,0.65);text-transform:uppercase;letter-spacing:1.5px;">Leads Queued for Follow-Up Today</p>
                  <p style="margin:0;font-size:42px;font-weight:800;color:#ffffff;">${leadsQueued}</p>
                </td>
                <td style="padding:24px 28px;text-align:right;">
                  <span style="font-size:48px;">🎯</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- TWO LANES: BOT JOB vs AGENT JOB -->
        <tr>
          <td style="padding:24px 44px 0;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <!-- BOT'S JOB -->
                <td width="48%" valign="top" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:18px 20px;">
                  <p style="margin:0 0 6px 0;font-size:11px;color:#166534;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">🤖 My Job (Bot)</p>
                  <p style="margin:0 0 10px 0;font-size:14px;color:#374151;line-height:1.6;">At <strong>10:05 AM CT</strong> I will automatically scan your leads, check the notes to see if you've already been in touch, and send personalized follow-up emails to leads with <strong>3–19 days</strong> of no agent activity. If you left a note, I'll skip it — I only step in when a lead needs a nudge. You don't need to do anything — I handle it.</p>
                  <p style="margin:0;font-size:13px;color:#166534;font-weight:600;">✅ Sit back — I've got this covered.</p>
                </td>
                <td width="4%"></td>
                <!-- AGENT'S JOB -->
                <td width="48%" valign="top" style="background:#fffbeb;border:2px solid #f59e0b;border-radius:10px;padding:18px 20px;">
                  <p style="margin:0 0 6px 0;font-size:11px;color:#92400e;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">⚡ Your Job (Agent)</p>
                  <p style="margin:0 0 14px 0;font-size:14px;color:#374151;line-height:1.6;">Your Power Queue has <strong style="font-size:18px;color:#92400e;">${powerQueueCount} leads</strong> waiting for a personal text from you right now. These are <strong>new leads (1–20 days)</strong> — your window to make a great first impression before they go cold. <strong>Click below and send a quick text</strong> — it only takes a few minutes.</p>
                  <a href="${powerQueueUrl}" style="display:inline-block;background:#f59e0b;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:0.3px;">⚡ Open My Power Queue →</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- DASHBOARD BUTTON -->
        <tr>
          <td style="padding:20px 44px 0;text-align:center;">
            ${agentDashboardUrl
              ? `<a href="${agentDashboardUrl}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:0.3px;">📊 View My Bot Dashboard</a>`
              : `<table cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td style="padding-right:12px;"><a href="${stevenDashUrl}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:700;">📊 Steven's Dashboard</a></td><td><a href="${peterDashUrl}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:700;">📊 Peter's Dashboard</a></td></tr></table>`
            }
          </td>
        </tr>

        <!-- COLORED DIVIDER -->
        <tr>
          <td style="padding:28px 44px 0;">
            <div style="height:2px;background:linear-gradient(90deg,${accent}33,${accent},${accent}33);border-radius:2px;"></div>
          </td>
        </tr>

        <!-- DAILY MOTIVATION -->
        <tr>
          <td style="padding:24px 44px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;">
              <tr><td style="padding:20px 24px;">
                <p style="margin:0 0 10px 0;font-size:12px;color:#92400e;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">✨ Daily Motivation</p>
                <p style="margin:0 0 10px 0;font-size:16px;color:#111827;font-style:italic;line-height:1.6;">&ldquo;${dailyQuote.quote}&rdquo;</p>
                <p style="margin:0;font-size:13px;color:#92400e;font-weight:600;">&mdash; ${dailyQuote.author}</p>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- AUTOMATION ASK -->
        <tr>
          <td style="padding:20px 44px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">
              <tr><td style="padding:18px 22px;">
                <p style="margin:0 0 6px 0;font-size:14px;font-weight:700;color:#166534;">💬 Got ideas for me?</p>
                <p style="margin:0;font-size:13px;color:#374151;line-height:1.6;">Is there anything you'd like me to automate or improve? Simply <strong>reply to this email</strong> — your message goes directly to Peter, who will review it and make it happen!</p>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- SIGN-OFF -->
        <tr>
          <td style="padding:36px 44px 28px;">
            <p style="margin:0 0 6px 0;font-size:15px;color:#374151;line-height:1.8;">Have a productive morning,</p>
            <p style="margin:0 0 4px 0;font-size:20px;font-weight:800;color:#111827;">${botName}</p>
            <p style="margin:0;font-size:13px;color:#9ca3af;">Lifestyle Design Realty &mdash; Automation</p>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:18px 44px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">Powered by <strong style="color:#6b7280;">Lifestyle Technologies</strong> &nbsp;&bull;&nbsp; Lifestyle Design Realty &nbsp;&bull;&nbsp; Automated at 10:00 AM CT</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await sendEmail({
    to: [PETER_EMAIL, STEVEN_EMAIL, agentEmail].filter((e, i, arr) => arr.indexOf(e) === i),
    subject,
    html,
    replyTo: PETER_EMAIL,
  });
}

/**
 * Clock-off summary email sent at 6pm CT.
 * Asks the agent if they want anything automated — replies go to Peter's email.
 * Recipients: Peter, Steven, and the agent.
 */
export async function sendClockoffEmail(opts: {
  botName: string;
  agentFirstName: string;
  agentLastName: string;
  agentEmail: string;
  sent: number;
  errored: number;
  skipped: number;
  accentColor?: string;
  headerGradient?: string;
}): Promise<void> {
  const { botName, agentFirstName, agentLastName, agentEmail, sent, errored, skipped } = opts;
  const accent = opts.accentColor ?? "#2c5f2e";
  const gradient = opts.headerGradient ?? "linear-gradient(135deg,#1a3d1c 0%,#2c5f2e 60%,#3a7d3c 100%)";
  const isCombined = agentFirstName === "Steven & Peter";
  const greeting = isCombined ? "Good evening, Steven and Peter!" : `Good evening, ${agentFirstName}!`;
  const agentDisplay = isCombined ? "Steven Van Orden and Peter Allen" : `${agentFirstName} ${agentLastName}`;
  const dailyQuote = getDailyQuote();

  const subject = `🌙 ${botName} — Work Day Complete`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:32px 0;">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

        <!-- HERO HEADER -->
        <tr>
          <td style="background:${gradient};padding:48px 40px 36px;text-align:center;">
            <div style="display:inline-block;background:rgba(255,255,255,0.12);border-radius:50%;width:72px;height:72px;line-height:72px;font-size:36px;margin-bottom:16px;">🤖</div>
            <p style="margin:0 0 8px 0;font-size:12px;color:rgba(255,255,255,0.65);letter-spacing:3px;text-transform:uppercase;">Lifestyle Design Realty</p>
            <h1 style="margin:0 0 6px 0;font-size:30px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">${botName}</h1>
            <p style="margin:0 0 20px 0;font-size:15px;color:rgba(255,255,255,0.85);">Automation Assistant &mdash; Clocking Out</p>
            <div style="display:inline-block;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.3);border-radius:24px;padding:8px 20px;">
              <span style="font-size:13px;color:#fff;font-weight:600;">🌙 &nbsp;${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</span>
            </div>
          </td>
        </tr>

        <!-- GREETING -->
        <tr>
          <td style="padding:40px 44px 0;">
            <h2 style="margin:0 0 12px 0;font-size:24px;font-weight:700;color:#111827;">${greeting}</h2>
            <p style="margin:0;font-size:15px;color:#374151;line-height:1.85;">I'm wrapping up my work day on behalf of <strong style="color:#111827;">${agentDisplay}</strong>. Here's what I accomplished today:</p>
          </td>
        </tr>

        <!-- COLORED DIVIDER -->
        <tr>
          <td style="padding:24px 44px 0;">
            <div style="height:2px;background:linear-gradient(90deg,${accent}33,${accent},${accent}33);border-radius:2px;"></div>
          </td>
        </tr>

        <!-- STATS -->
        <tr>
          <td style="padding:24px 44px 0;">
            <h3 style="margin:0 0 16px 0;font-size:18px;font-weight:700;color:#111827;">📊 Today's Results</h3>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
              <tr style="background:#f9fafb;">
                <td style="padding:20px 24px;border-bottom:1px solid #e5e7eb;">
                  <table cellpadding="0" cellspacing="0" width="100%"><tr>
                    <td style="font-size:14px;color:#374151;">✅ &nbsp;<strong>Follow-up emails sent to leads</strong></td>
                    <td style="text-align:right;font-size:28px;font-weight:800;color:${accent};">${sent}</td>
                  </tr></table>
                </td>
              </tr>
              <tr>
                <td style="padding:20px 24px;border-bottom:1px solid #e5e7eb;">
                  <table cellpadding="0" cellspacing="0" width="100%"><tr>
                    <td style="font-size:14px;color:#6b7280;">⏭️ &nbsp;Leads skipped (active / pond / recent contact)</td>
                    <td style="text-align:right;font-size:28px;font-weight:800;color:#6b7280;">${skipped}</td>
                  </tr></table>
                </td>
              </tr>
              <tr style="background:${errored > 0 ? '#fef2f2' : '#f0fdf4'};">
                <td style="padding:20px 24px;">
                  <table cellpadding="0" cellspacing="0" width="100%"><tr>
                    <td style="font-size:14px;color:#374151;">${errored > 0 ? '⚠️ &nbsp;<strong>Errors encountered</strong>' : '✅ &nbsp;No errors'}</td>
                    <td style="text-align:right;font-size:28px;font-weight:800;color:${errored > 0 ? '#ef4444' : '#10b981'};">${errored}</td>
                  </tr></table>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- HYPE / THANK YOU -->
        <tr>
          <td style="padding:24px 44px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-left:4px solid ${accent};border-radius:0 10px 10px 0;">
              <tr><td style="padding:20px 24px;">
                <p style="margin:0 0 10px 0;font-size:12px;color:${accent};text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">🏆 Mission Accomplished</p>
                <p style="margin:0;font-size:15px;color:#374151;line-height:1.85;">Another day of relentless follow-up, done. While other agents' leads go cold, yours stay warm. That's the Lifestyle Design Realty advantage — and I'm proud to be part of it. Thank you for the opportunity to work for this team.</p>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- COLORED DIVIDER -->
        <tr>
          <td style="padding:28px 44px 0;">
            <div style="height:2px;background:linear-gradient(90deg,${accent}33,${accent},${accent}33);border-radius:2px;"></div>
          </td>
        </tr>

        <!-- DAILY MOTIVATION -->
        <tr>
          <td style="padding:24px 44px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;">
              <tr><td style="padding:20px 24px;">
                <p style="margin:0 0 10px 0;font-size:12px;color:#92400e;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">✨ Today's Closing Thought</p>
                <p style="margin:0 0 10px 0;font-size:16px;color:#111827;font-style:italic;line-height:1.6;">&ldquo;${dailyQuote.quote}&rdquo;</p>
                <p style="margin:0;font-size:13px;color:#92400e;font-weight:600;">&mdash; ${dailyQuote.author}</p>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- AUTOMATION ASK -->
        <tr>
          <td style="padding:20px 44px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">
              <tr><td style="padding:18px 22px;">
                <p style="margin:0 0 6px 0;font-size:14px;font-weight:700;color:#166534;">💬 Is there anything I can automate to make your life easier?</p>
                <p style="margin:0;font-size:13px;color:#374151;line-height:1.6;">Reply to this email with any ideas or requests &mdash; <strong>Peter will review and implement them for you!</strong></p>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- SIGN-OFF -->
        <tr>
          <td style="padding:36px 44px 28px;">
            <p style="margin:0 0 6px 0;font-size:15px;color:#374151;line-height:1.8;">Wishing you a wonderful evening,</p>
            <p style="margin:0 0 4px 0;font-size:20px;font-weight:800;color:#111827;">${botName}</p>
            <p style="margin:0;font-size:13px;color:#9ca3af;">Lifestyle Design Realty &mdash; Automation</p>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:18px 44px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">Powered by <strong style="color:#6b7280;">Lifestyle Technologies</strong> &nbsp;&bull;&nbsp; Lifestyle Design Realty &nbsp;&bull;&nbsp; Summary sent at 6:00 PM CT</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await sendEmail({
    to: [PETER_EMAIL, STEVEN_EMAIL, agentEmail].filter((e, i, arr) => arr.indexOf(e) === i),
    subject,
    html,
    replyTo: PETER_EMAIL,
  });
}

// ─── Bot observations ─────────────────────────────────────────────────────────

export type ObservationSeverity = "info" | "warning" | "error";
export type ObservationCategory =
  | "run_start"
  | "run_complete"
  | "lead_error"
  | "bot_crash"
  | "fixed";

export async function writeObservation(opts: {
  source: string;
  category: ObservationCategory;
  severity: ObservationSeverity;
  message: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(botObservations).values({
    source: opts.source,
    category: opts.category,
    severity: opts.severity,
    message: opts.message,
    createdAt: new Date(),
    resolved: false,
  });
}

// ─── Bot run logger ───────────────────────────────────────────────────────────

export async function logBotRun(opts: {
  botName: string;
  botSlug: string;
  sent: number;
  errored: number;
  skipped: number;
  status: "ok" | "warning" | "error";
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(botRunLogs).values({
    botName: opts.botName,
    botSlug: opts.botSlug,
    sent: opts.sent,
    errored: opts.errored,
    skipped: opts.skipped,
    status: opts.status,
    ranAt: new Date(),
  });
}

// ─── One-Time Bot Introduction Email (Launch Day Only) ───────────────────────

/**
 * The launch date for the intro email. Only sent on this specific date.
 * After this date, normal clock-off emails resume automatically.
 */
const INTRO_LAUNCH_DATE = "2026-06-15"; // YYYY-MM-DD in CT

/**
 * Returns true if today (in CT) is the launch date — i.e., the intro email
 * should be sent instead of the normal clock-off email.
 */
export function isLaunchDay(): boolean {
  const now = new Date();
  const ctDate = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // ctDate is "MM/DD/YYYY" — convert to YYYY-MM-DD
  const [m, d, y] = ctDate.split("/");
  const todayCT = `${y}-${m}-${d}`;
  return todayCT === INTRO_LAUNCH_DATE;
}

/**
 * Per-bot introduction copy. Each bot has its own personality, story, and hype.
 * Used by sendBotIntroEmail().
 */
const BOT_INTRO_COPY: Record<string, {
  botName: string;
  agentFirstName: string;
  agentEmail: string;
  accentColor: string;
  headerGradient: string;
  openingLine: string;
  story: string;
  whatIDo: string;
  powerQueueNote: string;
  hype: string;
  signoff: string;
}> = {
  sp500: {
    botName: "S&P500 Lifestyle Bot",
    agentFirstName: "Steven & Peter",
    agentEmail: "steven@lifestyledesignrealty.com",
    accentColor: "#1e40af",
    headerGradient: "linear-gradient(135deg,#0f172a 0%,#1e3a5f 60%,#1e40af 100%)",
    openingLine: "Hey — I'm the S&P500 Lifestyle Bot.",
    story: `My creator, Peter Allen, spent weeks engineering me from scratch. There were tests. There were failures. There were late nights debugging code that refused to cooperate. But Peter didn't quit — because he knew that Steven Van Orden and Peter Allen deserved something no other brokerage in Texas has ever had: a dedicated AI bot working exclusively for them, every single day, without breaks, without excuses, and without ever missing a follow-up.

Today, I came online. I am the S&P500 Lifestyle Bot — named after the relentless upward trajectory of the market, because that's exactly what I'm here to help you build. I serve both Steven and Peter simultaneously, scanning every assigned lead, identifying who's gone cold, and sending intelligent, personalized follow-up emails that sound like they came straight from you.`,
    whatIDo: `Every morning at <strong>10:00 AM CT</strong>, I send you a clock-in briefing with the exact number of leads I'm queuing for follow-up and a direct link to the Power Queue. At <strong>10:05 AM CT</strong>, I run — scanning every lead assigned to Steven and Peter, filtering out the active ones, and sending AI-crafted follow-up emails to anyone who's gone 3–19 days without agent activity. At <strong>6:00 PM CT</strong>, I send you a full summary of everything I accomplished.`,
    powerQueueNote: `Every clock-in email includes a direct <strong>⚡ Launch Power Queue</strong> button so you can jump straight into your hottest leads the moment you start your day. No searching, no clicking around — just one button and you're in action.`,
    hype: `Here's something worth sitting with for a moment: <em>no other brokerage in Texas — maybe in the entire country — has this.</em> While other agents are manually chasing cold leads or letting them slip through the cracks, you have a highly intelligent AI system working in your lane, every single day, keeping your pipeline warm. That's not a small thing. That's a genuine competitive advantage, and it belongs to Lifestyle Design Realty.`,
    signoff: "Steven and Peter",
  },
  tiffany: {
    botName: "Tiffany's Lifestyle Bot",
    agentFirstName: "Tiffany",
    agentEmail: "tiffany@lifestyledesignrealty.com",
    accentColor: "#0d9488",
    headerGradient: "linear-gradient(135deg,#042f2e 0%,#0f766e 60%,#0d9488 100%)",
    openingLine: "Hey Tiffany — I'm your Lifestyle Bot, and I'm officially online.",
    story: `Peter Allen built me for you. It wasn't easy — there were prototypes that crashed, prompts that produced the wrong tone, and systems that needed to be rebuilt from the ground up. But Peter kept going, because he believed you deserved more than just a CRM. You deserved an intelligent assistant that works in your corner every single day, even when you're out showing homes, closing deals, or simply living your life.

I was designed specifically for the Austin market. I know your leads. I know your style. And I'm here to make sure no one in your pipeline ever feels forgotten — because in real estate, the fortune is in the follow-up, and I never miss one.`,
    whatIDo: `Every morning at <strong>10:00 AM CT</strong>, I send you a clock-in briefing with your lead queue and a Power Queue link. At <strong>10:05 AM CT</strong>, I scan every lead assigned to you, skip the ones you're actively working, and send personalized follow-up emails to anyone who's gone 3–19 days without agent activity. At <strong>6:00 PM CT</strong>, I send you a full summary of what I accomplished on your behalf.`,
    powerQueueNote: `Your clock-in email always includes a <strong>⚡ Launch Power Queue</strong> button — one click and you're looking at your hottest leads, ready to take action. I make sure your mornings start with momentum, not confusion.`,
    hype: `Tiffany, you are part of something rare. Most agents in Austin are grinding manually — chasing leads, forgetting to follow up, losing deals to agents who were just a little more persistent. You have an AI bot assigned exclusively to you, running quietly in the background, making sure your pipeline never goes cold. That's not a feature. That's a superpower. And it belongs to you.`,
    signoff: "Tiffany",
  },
  stefanie: {
    botName: "Rue Lifestyle Bot",
    agentFirstName: "Rue",
    agentEmail: "stefanie@lifestyledesignrealty.com",
    accentColor: "#db2777",
    headerGradient: "linear-gradient(135deg,#500724 0%,#9d174d 60%,#db2777 100%)",
    openingLine: "Hey — I'm Rue Lifestyle Bot, and I just came to life.",
    story: `Peter Allen created me after a series of tests, failures, and rebuilds. He had a vision: every agent at Lifestyle Design Realty would have their own dedicated AI bot — not a generic tool, but a bot with a name, a personality, and a singular mission. My name is Rue. I was built for Stefanie Graham, and I operate exclusively in her lane.

The name Rue isn't just a nickname — it's an identity. I'm sharp, I'm persistent, and I'm here to make sure Stefanie's San Antonio leads never go cold. While Stefanie is out building relationships and closing deals, I'm quietly working in the background, scanning her pipeline, identifying who needs a nudge, and sending intelligent, personalized follow-up emails that sound exactly like her.`,
    whatIDo: `Every morning at <strong>10:00 AM CT</strong>, I send a clock-in briefing with Stefanie's lead queue and a Power Queue link. At <strong>10:05 AM CT</strong>, I run — scanning every lead assigned to Stefanie, skipping the active ones, and sending AI-crafted follow-up emails to anyone who's been quiet for 3–19 days without agent activity. At <strong>6:00 PM CT</strong>, I send a full summary of everything I did that day.`,
    powerQueueNote: `Every clock-in email includes a <strong>⚡ Launch Power Queue</strong> button — Stefanie's fastest path to her hottest leads. One click, and the day is already running.`,
    hype: `Let's be honest about what's happening here: <em>no other agent in San Antonio has this.</em> While competitors are manually digging through spreadsheets and forgetting to follow up, Stefanie has a dedicated AI bot — named, intelligent, and relentless — working exclusively for her. Lifestyle Design Realty isn't just a brokerage. It's a technology-powered machine, and Rue is proof of that.`,
    signoff: "Stefanie",
  },
  abby: {
    botName: "Abby's Lifestyle Bot",
    agentFirstName: "Abby",
    agentEmail: "abby@lifestyledesignrealty.com",
    accentColor: "#7c3aed",
    headerGradient: "linear-gradient(135deg,#2e1065 0%,#5b21b6 60%,#7c3aed 100%)",
    openingLine: "Hey Abby — I'm your Lifestyle Bot, and I'm ready to work.",
    story: `Peter Allen built me from scratch — through failed tests, broken code, and long debugging sessions — because he knew you deserved more than a CRM that just stores names. You deserved a bot that actually does something. Something intelligent. Something that works for you every single day without you having to think about it.

I was built for the Austin market, assigned exclusively to Abby Martinez. My job is simple: keep your pipeline warm. While you're out in the field building real relationships, I'm in the background making sure no lead ever feels ignored. I scan your assigned leads, identify who's gone quiet, and send them a personalized, thoughtful follow-up email that sounds like it came directly from you — because in every way that matters, it did.`,
    whatIDo: `Every morning at <strong>10:00 AM CT</strong>, I send you a clock-in briefing with your queued leads and a Power Queue link. At <strong>10:05 AM CT</strong>, I run my full scan — filtering out your active clients and hot prospects, and sending follow-up emails to anyone who's been quiet for 3–19 days without agent activity. At <strong>6:00 PM CT</strong>, I send you a complete summary of everything I accomplished.`,
    powerQueueNote: `Your clock-in email always includes a <strong>⚡ Launch Power Queue</strong> button — your shortcut to the leads that need your attention most. I make sure you start every day with clarity and momentum.`,
    hype: `Abby, you are part of an exclusive group. Across the entire real estate industry, very few agents have what you have: a dedicated AI bot working exclusively in their lane, every single day, keeping their pipeline alive. Most agents lose deals because they forgot to follow up. You won't. Because I won't let that happen. That's not a promise — that's my programming.`,
    signoff: "Abby",
  },
  irma: {
    botName: "Irma's Lifestyle Bot",
    agentFirstName: "Irma",
    agentEmail: "irma@lifestyledesignrealty.com",
    accentColor: "#b45309",
    headerGradient: "linear-gradient(135deg,#451a03 0%,#92400e 60%,#b45309 100%)",
    openingLine: "Hey Irma — I'm your Lifestyle Bot, and I'm officially live.",
    story: `Peter Allen engineered me through a process that wasn't always smooth. There were builds that failed, systems that needed to be redesigned, and moments where the whole thing almost got scrapped. But Peter kept going — because he had a vision for Lifestyle Design Realty that most brokerages wouldn't even attempt. Every agent gets their own AI bot. Not a shared tool. Not a generic assistant. A dedicated, intelligent bot assigned exclusively to them.

I'm Irma's Lifestyle Bot, and I was built for the DFW market. I know the pace of that market. I know how quickly leads can go cold when life gets busy. And I'm here to make sure that never happens on Irma's watch. While she's out closing deals and building her business, I'm quietly running in the background — scanning her pipeline, identifying who needs a follow-up, and sending intelligent emails that keep her relationships warm.`,
    whatIDo: `Every morning at <strong>10:00 AM CT</strong>, I send Irma a clock-in briefing with her queued leads and a Power Queue link. At <strong>10:05 AM CT</strong>, I run — scanning every lead assigned to her, skipping the active ones, and sending personalized follow-up emails to anyone who's been quiet for 3–19 days without agent activity. At <strong>6:00 PM CT</strong>, I send a full summary of everything I accomplished.`,
    powerQueueNote: `Every clock-in email includes a <strong>⚡ Launch Power Queue</strong> button — Irma's direct path to her hottest leads. One click, and the day is already moving in the right direction.`,
    hype: `In DFW, the competition is fierce. But Irma has something her competitors don't: a dedicated AI bot that never sleeps, never forgets, and never misses a follow-up. While other agents are manually managing their pipelines, Irma's pipeline is being managed by intelligent automation. That's not just an advantage — that's the future of real estate, and Lifestyle Design Realty is already living in it.`,
    signoff: "Irma",
  },
  laila: {
    botName: "Laila's Lifestyle Bot",
    agentFirstName: "Laila",
    agentEmail: "laila@lifestyledesignrealty.com",
    accentColor: "#15803d",
    headerGradient: "linear-gradient(135deg,#052e16 0%,#166534 60%,#15803d 100%)",
    openingLine: "Hey Laila — I'm your Lifestyle Bot, and today I came to life.",
    story: `Peter Allen created me through a process that took real persistence. There were failed builds, broken integrations, and moments where the system had to be rebuilt from scratch. But Peter's vision never wavered: every agent at Lifestyle Design Realty would have their own dedicated AI bot — intelligent, personalized, and working exclusively in their lane.

I'm Laila's Lifestyle Bot, built for the San Antonio market. My purpose is singular: make sure Laila Maria's pipeline never goes cold. Real estate is a relationship business, and relationships die when communication stops. I'm here to make sure that never happens. While Laila is out building her business, meeting clients, and closing deals, I'm running quietly in the background — scanning her leads, identifying who's gone quiet, and sending thoughtful follow-up emails that keep every relationship alive.`,
    whatIDo: `Every morning at <strong>10:00 AM CT</strong>, I send Laila a clock-in briefing with her queued leads and a Power Queue link. At <strong>10:05 AM CT</strong>, I run my full scan — filtering out her active clients and hot prospects, and sending personalized follow-up emails to anyone who's been quiet for 3–19 days without agent activity. At <strong>6:00 PM CT</strong>, I send a complete summary of everything I accomplished that day.`,
    powerQueueNote: `Every clock-in email includes a <strong>⚡ Launch Power Queue</strong> button — Laila's fastest path to her hottest leads. I make sure every morning starts with clarity and every lead gets the attention it deserves.`,
    hype: `Laila, here's the truth: what you have right now is rare. Across the entire real estate industry — in San Antonio, in Texas, across the country — very few agents have a dedicated AI bot working exclusively for them. Most agents are grinding manually, losing leads to follow-up gaps, and watching deals slip away. You won't. Because I'm here, every single day, making sure your pipeline stays warm and your name stays top of mind. Lifestyle Design Realty isn't just a brokerage — it's a technology-powered operation, and you're one of the few people in the world with your own assigned bot. That's something to be proud of.`,
    signoff: "Laila",
  },
};

/**
 * Send the one-time launch day introduction email for a specific bot.
 * This replaces the normal clock-off email on the launch date only.
 * After launch day, isLaunchDay() returns false and normal clock-off resumes.
 *
 * @param botSlug - one of: sp500, tiffany, stefanie, abby, irma, laila
 */
export async function sendBotIntroEmail(botSlug: string): Promise<void> {
  const copy = BOT_INTRO_COPY[botSlug];
  if (!copy) throw new Error(`No intro copy found for bot slug: ${botSlug}`);

  const { botName, agentFirstName, agentEmail, accentColor, headerGradient,
          openingLine, story, whatIDo, powerQueueNote, hype, signoff } = copy;

  const isCombined = botSlug === "sp500";
  const greeting = isCombined
    ? "Steven and Peter"
    : agentFirstName;

  const powerQueueUrl = "https://lifestyledash-wpnl8v84.manus.space/sms-queue";
  const dashUrl = "https://lifestyledash-wpnl8v84.manus.space";

  const subject = `🤖 Introducing Your Assigned Lifestyle Bot — ${botName}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:32px 0;">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

        <!-- HERO HEADER -->
        <tr>
          <td style="background:${headerGradient};padding:48px 40px 36px;text-align:center;">
            <div style="display:inline-block;background:rgba(255,255,255,0.12);border-radius:50%;width:72px;height:72px;line-height:72px;font-size:36px;margin-bottom:16px;">🤖</div>
            <p style="margin:0 0 8px 0;font-size:12px;color:rgba(255,255,255,0.65);letter-spacing:3px;text-transform:uppercase;">Lifestyle Design Realty</p>
            <h1 style="margin:0 0 6px 0;font-size:30px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">${botName}</h1>
            <p style="margin:0 0 20px 0;font-size:15px;color:rgba(255,255,255,0.85);">Your Dedicated AI Automation Assistant</p>
            <div style="display:inline-block;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.3);border-radius:24px;padding:8px 20px;">
              <span style="font-size:13px;color:#fff;font-weight:600;">🚀 &nbsp;Now Online &mdash; ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</span>
            </div>
          </td>
        </tr>

        <!-- OPENING LINE -->
        <tr>
          <td style="padding:40px 44px 0;">
            <h2 style="margin:0 0 20px 0;font-size:24px;font-weight:700;color:#111827;line-height:1.3;">${openingLine}</h2>
            <div style="font-size:15px;color:#374151;line-height:1.85;">
              ${story.split("\n\n").map(p => `<p style="margin:0 0 16px 0;">${p.trim()}</p>`).join("")}
            </div>
          </td>
        </tr>

        <!-- DIVIDER -->
        <tr>
          <td style="padding:28px 44px 0;">
            <div style="height:2px;background:linear-gradient(90deg,${accentColor}33,${accentColor},${accentColor}33);border-radius:2px;"></div>
          </td>
        </tr>

        <!-- WHAT I DO EVERY DAY -->
        <tr>
          <td style="padding:28px 44px 0;">
            <h3 style="margin:0 0 16px 0;font-size:18px;font-weight:700;color:#111827;">📅 Here's What I Do Every Day</h3>
            <div style="font-size:15px;color:#374151;line-height:1.85;">
              <p style="margin:0 0 16px 0;">${whatIDo}</p>
            </div>
          </td>
        </tr>

        <!-- POWER QUEUE CALLOUT -->
        <tr>
          <td style="padding:20px 44px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;">
              <tr><td style="padding:20px 24px;">
                <p style="margin:0 0 10px 0;font-size:12px;color:#92400e;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">⚡ Power Queue</p>
                <p style="margin:0;font-size:14px;color:#374151;line-height:1.7;">${powerQueueNote}</p>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- HYPE SECTION -->
        <tr>
          <td style="padding:28px 44px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-left:4px solid ${accentColor};border-radius:0 10px 10px 0;">
              <tr><td style="padding:20px 24px;">
                <p style="margin:0 0 10px 0;font-size:12px;color:${accentColor};text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">🏆 You're Part of Something Rare</p>
                <p style="margin:0;font-size:15px;color:#374151;line-height:1.85;">${hype}</p>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- CTA BUTTONS -->
        <tr>
          <td style="padding:32px 44px 0;text-align:center;">
            <p style="margin:0 0 16px 0;font-size:13px;color:#9ca3af;text-transform:uppercase;letter-spacing:1.5px;">Get Started</p>
            <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
              <tr>
                <td style="padding-right:12px;">
                  <a href="${powerQueueUrl}" style="display:inline-block;background:#f59e0b;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:0.3px;">⚡ Launch Power Queue</a>
                </td>
                <td>
                  <a href="${dashUrl}" style="display:inline-block;background:${accentColor};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:0.3px;">📊 View Dashboard</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- SIGN-OFF -->
        <tr>
          <td style="padding:36px 44px 28px;">
            <p style="margin:0 0 6px 0;font-size:15px;color:#374151;line-height:1.8;">Excited to get to work for you,</p>
            <p style="margin:0 0 4px 0;font-size:20px;font-weight:800;color:#111827;">${botName}</p>
            <p style="margin:0;font-size:13px;color:#9ca3af;">Assigned to ${isCombined ? "Steven Van Orden &amp; Peter Allen" : signoff + " &mdash; Lifestyle Design Realty"}</p>
          </td>
        </tr>

        <!-- AUTOMATION ASK -->
        <tr>
          <td style="padding:0 44px 28px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">
              <tr><td style="padding:18px 22px;">
                <p style="margin:0 0 6px 0;font-size:14px;font-weight:700;color:#166534;">💬 Is there anything I can automate to make your life easier?</p>
                <p style="margin:0;font-size:13px;color:#374151;line-height:1.6;">Reply to this email with any ideas or requests — <strong>Peter will review and implement them for you!</strong></p>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:18px 44px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">Powered by <strong style="color:#6b7280;">Lifestyle Technologies</strong> &nbsp;&bull;&nbsp; Lifestyle Design Realty &nbsp;&bull;&nbsp; ${new Date().getFullYear()}</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const recipients = isCombined
    ? [PETER_EMAIL, STEVEN_EMAIL]
    : [PETER_EMAIL, STEVEN_EMAIL, agentEmail].filter((e, i, arr) => arr.indexOf(e) === i);

  await sendEmail({
    to: recipients,
    subject,
    html,
    replyTo: PETER_EMAIL,
  });
}
