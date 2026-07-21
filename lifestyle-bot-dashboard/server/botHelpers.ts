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
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDb } from "./db";
import { botObservations, botRunLogs, smsSentToday, contactedLeads, emailAngleLog, purchaseWindow } from "../drizzle/schema";
import { and, eq, gte, desc } from "drizzle-orm";
import { ENV } from "./_core/env";

// ESM-safe __dirname
const __botHelpers_filename = fileURLToPath(import.meta.url);
const __botHelpers_dirname = path.dirname(__botHelpers_filename);

// ─── Shared Suppression List (single source of truth) ────────────────────────
// Both Python (pond-nurture-bot) and TypeScript (lifestyle-bot-dashboard) read
// from config/suppression_tags.json. Adding a tag there protects leads everywhere.
const SUPPRESSION_TAGS_PATH = path.resolve(__botHelpers_dirname, "../../fub_automation/config/suppression_tags.json");
const FALLBACK_SUPPRESSION_TAGS_PATH = path.resolve(__botHelpers_dirname, "../config/suppression_tags.json");

let _sharedSuppressionTags: string[] | null = null;
let _sharedExcludedSources: string[] | null = null;

/** Load the shared suppression tag list from the canonical JSON file */
export function getSharedSuppressionTags(): string[] {
  if (_sharedSuppressionTags !== null) return _sharedSuppressionTags;
  const paths = [SUPPRESSION_TAGS_PATH, FALLBACK_SUPPRESSION_TAGS_PATH];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, "utf-8"));
        _sharedSuppressionTags = (data.tags ?? []).map((t: string) => t.toLowerCase());
        // Also load excluded_sources while we have the file open
        if (!_sharedExcludedSources) {
          _sharedExcludedSources = (data.excluded_sources ?? []).map((s: string) => s.toLowerCase());
          console.log(`[botHelpers] Loaded ${_sharedExcludedSources!.length} excluded sources`);
        }
        console.log(`[botHelpers] Loaded ${_sharedSuppressionTags!.length} shared suppression tags from ${p}`);
        return _sharedSuppressionTags!;
      }
    } catch (e) {
      console.warn(`[botHelpers] Failed to load suppression tags from ${p}:`, e);
    }
  }
  // Hardcoded fallback if file is missing (should never happen in production)
  console.warn("[botHelpers] Shared suppression_tags.json not found, using hardcoded fallback");
  _sharedSuppressionTags = [
    "do not contact", "do not email", "do not nurture", "no ai email",
    "manual review", "bounced", "unsubscribe", "unsubscribed",
    "email opt out", "opt out", "opt-out", "opt-out-auto-trash",
    "dnc", "realtor", "agent", "spam", "annual nurture only",
    "replied - paused", "bot_suppress", "soi",
  ];
  return _sharedSuppressionTags;
}

/** Get the shared excluded sources list (case-insensitive, loaded from suppression_tags.json) */
export function getSharedExcludedSources(): string[] {
  if (_sharedExcludedSources !== null) return _sharedExcludedSources;
  // Trigger tag load which also loads sources
  getSharedSuppressionTags();
  if (_sharedExcludedSources) return _sharedExcludedSources;
  // Fallback
  _sharedExcludedSources = ["new agent inquiry", "botm newsletter"];
  return _sharedExcludedSources;
}

/** Force reload of suppression tags (used after adding a new tag) */
export function reloadSharedSuppressionTags(): string[] {
  _sharedSuppressionTags = null;
  _sharedExcludedSources = null;
  return getSharedSuppressionTags();
}

const PETER_USER_ID = 2;

/**
 * Check if a lead's source is in the excluded_sources list (case-insensitive exact match).
 * Returns the matched source string or null.
 */
export function isExcludedSource(person: FubPerson): string | null {
  const source = (person.source ?? person.leadSource ?? "").toLowerCase().trim();
  if (!source) return null;
  const excludedSources = getSharedExcludedSources();
  for (const excluded of excludedSources) {
    if (source === excluded) return person.source ?? person.leadSource ?? source;
  }
  return null;
}

/**
 * Check if a lead is SOI-silenced (total silence from ALL automation).
 * A lead is SOI if ANY of:
 *   1. createdById ≠ Peter (user_id 2) AND createdVia == "Manually"
 *   2. Any tag starting with "SOI" (case-insensitive)
 *   3. Source CONTAINS "SOI" (case-insensitive) — catches "Theo's SOI", "Tiffany SOI", etc.
 * Returns the matched rule description or null.
 */
export function isSOISilenced(person: FubPerson): string | null {
  // Rule 3: source CONTAINS "SOI" (case-insensitive)
  const source = (person.source ?? person.leadSource ?? "").toLowerCase();
  if (source.includes("soi")) {
    return `source contains SOI: "${person.source ?? person.leadSource}"`;
  }

  // Rule 2: any tag starting with "SOI" (case-insensitive)
  const tags = person.tags ?? [];
  for (const t of tags) {
    const tagName = (typeof t === "string" ? t : t?.name ?? "").trim();
    if (tagName.toLowerCase().startsWith("soi")) {
      return `tag starts with SOI: "${tagName}"`;
    }
  }

  // Rule 1: createdById ≠ Peter AND createdVia == "Manually"
  const createdVia = (person.createdVia ?? "").toLowerCase();
  const createdById = person.createdById ?? 0;
  if (createdVia === "manually" && createdById !== 0 && createdById !== PETER_USER_ID) {
    return `manually created by non-Peter user (createdById=${createdById}, createdVia=Manually)`;
  }

  return null;
}

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
  notes?: Array<{ body?: string; createdAt?: string; userId?: number }>;
  // Full context fields (FUB API returns these when available)
  source?: string | null;
  leadSource?: string | null;
  priceRange?: string | null;
  price?: string | null;
  created?: string | null;
  createdAt?: string | null;
  createdById?: number | null;
  createdVia?: string | null;
  addresses?: Array<{ city?: string; state?: string }> | null;
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

/** Check if a lead has a DNC / opt-out / suppression tag.
 * Now reads from the shared suppression_tags.json (single source of truth).
 */
export function hasDncTag(person: FubPerson): boolean {
  const suppressionTags = getSharedSuppressionTags();
  const tags = person.tags ?? [];
  // Normalize hyphens/underscores to spaces so tag variants like
  // "do-not-contact" still match the shared list entry "do not contact".
  const normalize = (s: string) => s.toLowerCase().replace(/[-_]+/g, " ");
  return tags.some(t => {
    const tag = normalize(typeof t === "string" ? t : (t as { name?: string })?.name ?? "");
    return suppressionTags.some(st => tag.includes(normalize(st)));
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
  const days = daysStale(person);

  // Stale override: Active Client leads with 3+ days no activity still need follow-up.
  // The agent clearly isn't working them, so the bot steps in.
  const STALE_OVERRIDE_DAYS = 3;
  const STALE_OVERRIDE_STAGES = new Set(["Active Client", "Hot Prospect"]);
  const isStaleOverride = STALE_OVERRIDE_STAGES.has(stage) && days >= STALE_OVERRIDE_DAYS;

  // Skip stages — UNLESS the stale override applies
  if (SKIP_STAGES.has(stage) && !isStaleOverride) return false;

  if (person.assignedPondId) return false; // already on a pond — handled by pond nurture
  if (person.textOptOut) return false;
  if (hasDncTag(person)) return false;

  // For stale override leads, don't apply the normal day window — they're already past it
  if (isStaleOverride) return true;

  if (days < STALE_DAYS_THRESHOLD) return false;   // too fresh — agent is on it
  if (days >= BOT_WINDOW_MAX_DAYS) return false;    // 20+ days → pond reassignment handles it (correct — this is the boundary)
  return true;
}

// ─── Power Queue integration ─────────────────────────────────────────────────

/**
 * The FUB Nurture Dashboard Power Queue URL — source of truth for 1-20 day stale leads.
 * The Power Queue shows leads the AGENT should personally text (days 1-20).
 * The bot handles leads 3–19 days stale via email — monitoring notes so it only
 * follows up when the agent hasn't already. At 20 days, Python automation moves
 * the lead to the pond and the pond nurture bot takes over.
 */
const POWER_QUEUE_API = "https://fub-nurture-phfprjui.manus.space/api/trpc/fub.getPendingQueue";

/**
 * Fetch the live Power Queue count for a specific agent from the FUB Nurture Dashboard portal.
 * The portal is the authoritative source — it applies smarter filters (phone required,
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
  // Get start of today in CT
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const todayStart = new Date(todayStr + "T00:00:00-05:00");
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
    .values({ personId, agentName })
    .onDuplicateKeyUpdate({ set: { agentName } });
}

// ─── Contacted Leads audit log ───────────────────────────────────────────────

/**
 * Returns true if this lead was contacted within the last MIN_CONTACT_GAP_DAYS days.
 * Prevents the same lead from being emailed on consecutive days.
 */
const MIN_CONTACT_GAP_DAYS = 3;

export async function wasContactedRecently(personId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const cutoff = new Date(Date.now() - MIN_CONTACT_GAP_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ personId: contactedLeads.personId })
    .from(contactedLeads)
    .where(and(eq(contactedLeads.personId, personId), gte(contactedLeads.sentAt, cutoff)))
    .limit(1);
  return rows.length > 0;
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
 * Detect notes written by our own automation (agent bots, pond nurture,
 * Python automation) as opposed to a human agent. Bots write FUB notes on
 * every send/skip — those must NOT count as "a human is talking to this lead",
 * otherwise automation notes would permanently block bot sends.
 *
 * Known bot note markers:
 *   - TS agent bots:  "[S&P500 Lifestyle Bot] …", "[Abby's Lifestyle Bot] …"
 *   - Python pond bot: "Automated two-week pond nurture outreach sent." /
 *     "Automation: …" prefixed notes (speed-to-lead, reassignment, opt-out)
 */
export function isBotAuthoredNote(body: string | undefined | null): boolean {
  const b = (body ?? "").trim();
  if (!b) return false;
  return (
    /^\[[^\]]*bot[^\]]*\]/i.test(b) ||
    b.startsWith("Automation:") ||
    /^automated /i.test(b) ||
    b.includes("Automated two-week pond nurture outreach sent") ||
    b.includes("Skipped automated follow-up") ||
    /^pond nurture .* sent/i.test(b)
  );
}

// ─── Deal-Based Pond Protection ─────────────────────────────────────────────
// Prevents ALL automation from touching leads that have deals in FUB.
// Rule A: Any deal → skip (agent owns the relationship)
// Rule C: Closed Residential Lease Listing (no purchase deal) → total silence

/** In-memory cache for deal lookups — cleared between bot runs */
const dealCache = new Map<number, { deals: any[]; ts: number }>();
const DEAL_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/** Clear the deal cache (call between bot runs or in tests) */
export function clearDealCache(): void {
  dealCache.clear();
}

/** Fetch all deals for a person from FUB /deals?personId=X */
export async function getPersonDeals(personId: number): Promise<any[]> {
  const cached = dealCache.get(personId);
  if (cached && Date.now() - cached.ts < DEAL_CACHE_TTL) return cached.deals;
  try {
    const data = await fubRequest<{ deals?: any[] }>(`/deals?personId=${personId}`);
    const deals = data.deals ?? [];
    dealCache.set(personId, { deals, ts: Date.now() });
    return deals;
  } catch (err) {
    console.warn(`[dealProtection] Failed to fetch deals for person ${personId}:`, err);
    return [];
  }
}

/** Rule A: Returns true if the person has ANY deal in FUB (open or closed) */
export async function hasAnyDeal(personId: number): Promise<boolean> {
  const deals = await getPersonDeals(personId);
  return deals.length > 0;
}

/**
 * Rule C: Returns true if the person has a closed Residential Lease Listing
 * deal but NO closed purchase deal (Buyers/Sellers pipeline).
 * Purchase deal wins — if they also bought, they get Phase 3 quarterly drip.
 */
export async function isLeaseListingSilenced(personId: number): Promise<boolean> {
  const deals = await getPersonDeals(personId);
  if (deals.length === 0) return false;
  const LEASE_PIPELINE_IDS = [5, 6]; // Residential Lease Listings, Lease Applications
  const PURCHASE_PIPELINE_IDS = [1, 2]; // Buyers, Sellers
  const hasClosedLease = deals.some(
    (d: any) => LEASE_PIPELINE_IDS.includes(d.pipelineId) &&
      (d.stageName?.toLowerCase() === "closed" || d.stageId === 99)
  );
  if (!hasClosedLease) return false;
  const hasClosedPurchase = deals.some(
    (d: any) => PURCHASE_PIPELINE_IDS.includes(d.pipelineId) &&
      (d.stageName?.toLowerCase() === "closed" || d.stageId === 99)
  );
  // Purchase deal wins over lease listing
  return hasClosedLease && !hasClosedPurchase;
}

/**
 * Uses Anthropic Claude to intelligently decide whether a lead should be skipped.
 * Understands natural language context — "decided to move to Florida",
 * "bought a house", "working with John at KW", "not in the market anymore" —
 * without needing a hardcoded keyword list.
 *
 * Also checks:
 * - Deal protection: ANY lead with a FUB deal is excluded from bot sends
 * - Lease listing silence: Closed lease listing (no purchase) = total silence
 * - 24h note check: if a HUMAN wrote a note within the last 24h, skip
 * Bot-authored notes are excluded from this check.
 *
 * Returns { skip: true, reason: string } if the lead should be skipped.
 * Returns { skip: false } if it's safe to send a follow-up.
 */
export async function shouldSkipLead(person: FubPerson): Promise<{ skip: boolean; reason?: string }> {
  // Source-based exclusion (cheap local check — no API call)
  const excludedSrc = isExcludedSource(person);
  if (excludedSrc) {
    return { skip: true, reason: `excluded source: ${excludedSrc}` };
  }

  // SOI Total Silence (cheap local check — no API call)
  const soiRule = isSOISilenced(person);
  if (soiRule) {
    return { skip: true, reason: `soi_silenced (rule matched: ${soiRule})` };
  }

  // Deal-Based Protection: ANY lead with a deal in FUB is protected
  // Rule A: Any deal → skip (human agent owns active deals)
  if (await hasAnyDeal(person.id)) {
    return { skip: true, reason: "Lead has active deal in FUB deal room — protected from all automation" };
  }

  // Rule C: Lease listing silenced leads get TOTAL SILENCE — no agent-bot emails
  // (Technically redundant since hasAnyDeal catches it, but kept for explicit logging)
  if (await isLeaseListingSilenced(person.id)) {
    return { skip: true, reason: "Lease listing silenced (closed Residential Lease Listing, no purchase deal)" };
  }

  const notes = person.notes ?? [];
  if (notes.length === 0) return { skip: false };

  // ── Feature 5: 24h agent note check ──────────────────────────────────────
  // If a human agent wrote a note within the last 24 hours, skip.
  // This means a human is actively working the lead.
  const now = Date.now();
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
  const assignedUserId = person.assignedUserId;
  for (const note of notes) {
    if (!note.createdAt) continue;
    const noteTime = new Date(note.createdAt).getTime();
    if (noteTime > twentyFourHoursAgo) {
      // Bot-authored notes (our own automation) never count as human activity.
      if (isBotAuthoredNote(note.body)) continue;
      // If the note has a userId matching the assigned agent, or if we can't tell
      // who wrote it (no userId field), treat the recent human note as agent activity
      if (!assignedUserId || note.userId === assignedUserId || !note.userId) {
        // person_id only — no lead names/emails in logs (public repo)
        console.log(`[skipGate] person ${person.id} skipped: human note within 24h`);
        return { skip: true, reason: "Agent wrote a note within the last 24 hours (active human conversation)" };
      }
    }
  }

  // ── Anthropic Direct: Intelligent skip decision ──────────────────────────
  // Build a compact note summary (most recent 5, max 400 chars each)
  const sorted = [...notes].sort((a, b) => {
    const aDate = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bDate = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bDate - aDate;
  }).slice(0, 5);

  const notesSummary = sorted.map((n, i) =>
    `Note ${i + 1} (${n.createdAt ?? "unknown date"}): ${(n.body ?? "").substring(0, 400)}`
  ).join("\n");

  const prompt = `You are a real estate CRM assistant. Your job is to decide whether a lead should be skipped for automated follow-up email outreach.

READ THESE NOTES FROM THE LEAD'S FILE:
${notesSummary}

SKIP the lead (answer YES) if you are at least 80% confident the notes indicate ANY of the following:
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
- You are less than 80% confident the lead should be skipped

PRIVACY: In your reason, refer to the person only as "lead" — never include names, emails, or phone numbers.

Respond with EXACTLY one line in this format:
SKIP: YES | reason: <brief reason>
or
SKIP: NO`;

  try {
    const anthropicKey = ENV.anthropicApiKey;
    if (!anthropicKey) {
      console.warn("[shouldSkipLead] ANTHROPIC_API_KEY not configured, defaulting to no-skip");
      return { skip: false };
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 100,
        system: "You are a precise real estate CRM assistant. Answer only in the exact format requested.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[shouldSkipLead] Anthropic API error ${res.status}: ${errBody}`);
      return { skip: false };
    }
    const data = await res.json() as { content?: Array<{ text?: string }> };
    const raw = (data.content?.[0]?.text ?? "").trim();
    if (raw.toUpperCase().startsWith("SKIP: YES")) {
      const reasonMatch = raw.match(/reason:\s*(.+)/i);
      // person_id only — no lead names/emails in logs (public repo)
      console.log(`[skipGate] person ${person.id} skipped: LLM intent check`);
      return { skip: true, reason: reasonMatch?.[1]?.trim() ?? "Notes indicate lead should be skipped" };
    }
    return { skip: false };
  } catch (err) {
    console.error("[shouldSkipLead] Anthropic call failed:", err);
    // On error, default to NOT skipping (fail open — better to send than miss)
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
 * Feature 2: Expanded to 20 notes with dates for full context.
 * The MOST RECENT note is labeled clearly so the LLM knows to base the follow-up on it.
 */
function buildLeadContext(person: FubPerson): string {
  const notes = person.notes ?? [];
  if (notes.length === 0) return "No prior notes on this lead. Write a general friendly check-in.";
  const sorted = [...notes]
    .sort((a, b) => {
      const aDate = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bDate = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bDate - aDate;
    })
    .slice(0, 20);
  const lines = sorted.map((n, i) => {
    const dateStr = n.createdAt ? `[${n.createdAt.slice(0, 10)}]` : "[unknown date]";
    const label = i === 0
      ? `MOST RECENT NOTE ${dateStr} (base your follow-up on this)`
      : `Note ${i + 1} ${dateStr}`;
    return `${label}: ${(n.body ?? "").substring(0, 500)}`;
  });
  return `Full FUB note history (most recent first, up to 20 notes):\n${lines.join("\n")}`;
}

// ── Angle Rotation Helpers ──────────────────────────────────────────────────────────

/** Agent bot angles — tuned for daily cadence during active search */
const AGENT_BOT_ANGLES = [
  "continue the last conversation thread (reference the most recent note directly)",
  "new or relevant inventory angle (mention homes, listings, or options for their criteria)",
  "market or rate note for their price range and city (rates, payment context, market pulse)",
  "practical next-step nudge (pre-approval, tour scheduling, neighborhood question)",
  "light personal check-in (how's the move going, how's the search feeling, any questions)",
];

/** Get the last angle used for a lead from the DB */
async function getLastAngle(personId: number): Promise<string | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select({ lastAngle: emailAngleLog.lastAngle })
      .from(emailAngleLog)
      .where(eq(emailAngleLog.personId, personId))
      .limit(1);
    return rows[0]?.lastAngle ?? null;
  } catch (e) {
    console.warn(`[getLastAngle] DB unavailable for person ${personId}, defaulting to null`);
    return null;
  }
}

/** Save the angle used for a lead (upsert) */
async function saveAngle(personId: number, angle: string): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db
      .insert(emailAngleLog)
      .values({ personId, lastAngle: angle, sentAt: new Date() })
      .onDuplicateKeyUpdate({ set: { lastAngle: angle, sentAt: new Date() } });
  } catch (e) {
    console.warn(`[saveAngle] DB unavailable for person ${personId}, skipping save`);
  }
}

/** Pick an angle that is NOT the same as lastAngle */
function pickAngle(personId: number, lastAngle: string | null): string {
  // Deterministic seed based on personId + today's date
  const today = new Date().toISOString().slice(0, 10);
  const seed = `${personId}-${today}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % AGENT_BOT_ANGLES.length;
  let angle = AGENT_BOT_ANGLES[idx]!;
  // Never repeat same angle twice in a row
  if (lastAngle && angle === lastAngle && AGENT_BOT_ANGLES.length > 1) {
    const currentIdx = AGENT_BOT_ANGLES.indexOf(angle);
    angle = AGENT_BOT_ANGLES[(currentIdx + 1) % AGENT_BOT_ANGLES.length]!;
  }
  return angle;
}

// ─── Timeline-Aware Cadence ──────────────────────────────────────────────────

/**
 * Extract a purchase timeline window from a lead's notes using Anthropic.
 * Returns the detected window_start date (when the lead plans to buy) or null.
 * Re-extracts every cycle — newer notes override older windows.
 */
export async function extractPurchaseWindow(person: FubPerson): Promise<{
  windowStart: Date | null;
  rawText: string | null;
  detectedFromNoteDate: Date | null;
}> {
  const notes = person.notes ?? [];
  if (notes.length === 0) return { windowStart: null, rawText: null, detectedFromNoteDate: null };

  // Build compact note summary (most recent 10 notes)
  const sorted = [...notes].sort((a, b) => {
    const aDate = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bDate = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bDate - aDate;
  }).slice(0, 10);

  const notesSummary = sorted.map((n, i) =>
    `Note ${i + 1} (${n.createdAt ?? "unknown"}): ${(n.body ?? "").substring(0, 300)}`
  ).join("\n");

  const todayStr = new Date().toISOString().slice(0, 10);

  const prompt = `You are a real estate CRM assistant. Today's date is ${todayStr}.

Analyze these lead notes and extract any FUTURE purchase timeline or window:
${notesSummary}

Look for:
- Explicit dates: "buying in January", "moving in August", "closing in March"
- Relative timeframes: "in 6 months", "next spring", "not until fall"
- Life events with dates: "lease ends in August", "job starts in September", "baby due in October"
- Builder timelines: "orders expected Jan-March", "completion in Q2"
- Seasonal: "after the holidays", "next summer", "when school starts"

If you find a purchase window, respond EXACTLY:
WINDOW: YYYY-MM-DD | SOURCE_NOTE_DATE: YYYY-MM-DD | RAW: <the exact phrase>

The WINDOW date should be your best estimate of when they plan to buy/move (use the 1st of the month if only a month is given, use reasonable estimates for seasons).
SOURCE_NOTE_DATE is the date of the note containing the timeline info.

If NO timeline is found, respond exactly:
NO_WINDOW`;

  try {
    const anthropicKey = ENV.anthropicApiKey;
    if (!anthropicKey) return { windowStart: null, rawText: null, detectedFromNoteDate: null };

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 100,
        system: "You are a precise date extraction assistant. Respond only in the exact format requested.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return { windowStart: null, rawText: null, detectedFromNoteDate: null };

    const data = await res.json() as { content?: Array<{ text?: string }> };
    const raw = (data.content?.[0]?.text ?? "").trim();

    if (raw.startsWith("NO_WINDOW")) return { windowStart: null, rawText: null, detectedFromNoteDate: null };

    const match = raw.match(/WINDOW:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*SOURCE_NOTE_DATE:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*RAW:\s*(.+)/i);
    if (!match) return { windowStart: null, rawText: null, detectedFromNoteDate: null };

    const windowStart = new Date(match[1]!);
    const detectedFromNoteDate = new Date(match[2]!);
    const rawText = match[3]!.trim();

    if (isNaN(windowStart.getTime())) return { windowStart: null, rawText: null, detectedFromNoteDate: null };

    return { windowStart, rawText, detectedFromNoteDate: isNaN(detectedFromNoteDate.getTime()) ? null : detectedFromNoteDate };
  } catch (err) {
    console.error("[extractPurchaseWindow] Anthropic call failed:", err);
    return { windowStart: null, rawText: null, detectedFromNoteDate: null };
  }
}

/** Persist the detected purchase window (upsert by personId) */
export async function savePurchaseWindow(personId: number, windowStart: Date, rawText: string | null, detectedFromNoteDate: Date | null): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db
      .insert(purchaseWindow)
      .values({
        personId,
        windowStart,
        rawText: rawText?.substring(0, 500) ?? null,
        detectedFromNoteDate,
      })
      .onDuplicateKeyUpdate({
        set: {
          windowStart,
          rawText: rawText?.substring(0, 500) ?? null,
          detectedFromNoteDate,
          updatedAt: new Date(),
        },
      });
  } catch (e) {
    console.warn(`[savePurchaseWindow] DB error for person ${personId}:`, e);
  }
}

/** Get the stored purchase window for a lead */
export async function getPurchaseWindow(personId: number): Promise<{ windowStart: Date; rawText: string | null } | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select({ windowStart: purchaseWindow.windowStart, rawText: purchaseWindow.rawText })
      .from(purchaseWindow)
      .where(eq(purchaseWindow.personId, personId))
      .limit(1);
    if (rows.length === 0) return null;
    return { windowStart: rows[0]!.windowStart, rawText: rows[0]!.rawText };
  } catch {
    return null;
  }
}

/**
 * Timeline-Aware Cadence check for AGENT BOTS.
 *
 * Rules:
 * - First 10 days after assignment: ALWAYS send (relationship-building phase)
 * - After day 10, if purchase window >120 days out: weekly (skip unless 7+ days since last contact)
 * - After day 10, if purchase window >60 days out: every 3-4 days
 * - No window detected: normal daily cadence
 *
 * PRECEDENCE: This never overrides Replied-Paused, suppression, 3-day contact gap, or SOI.
 * Timeline stretching only ever REDUCES frequency, never increases it.
 *
 * Returns: { shouldSend: boolean, reason: string, daysUntilWindow: number | null }
 */
export async function checkTimelineCadence(person: FubPerson): Promise<{
  shouldSend: boolean;
  reason: string;
  daysUntilWindow: number | null;
  isValueLed: boolean;
}> {
  const personId = person.id;

  // Calculate days since assignment
  const createdStr = person.created ?? person.createdAt;
  let daysSinceAssignment = 0;
  if (createdStr) {
    try {
      daysSinceAssignment = Math.floor((Date.now() - new Date(createdStr).getTime()) / (1000 * 60 * 60 * 24));
    } catch { /* ignore */ }
  }

  // First 10 days: always send (relationship-building phase)
  if (daysSinceAssignment <= 10) {
    return { shouldSend: true, reason: "Within 10-day relationship-building phase", daysUntilWindow: null, isValueLed: false };
  }

  // Extract and persist purchase window
  const extraction = await extractPurchaseWindow(person);
  if (extraction.windowStart) {
    await savePurchaseWindow(personId, extraction.windowStart, extraction.rawText, extraction.detectedFromNoteDate);
  }

  // Get the current stored window (may be from this cycle or a previous one)
  const stored = extraction.windowStart
    ? { windowStart: extraction.windowStart, rawText: extraction.rawText }
    : await getPurchaseWindow(personId);

  if (!stored) {
    // No timeline detected — normal cadence
    return { shouldSend: true, reason: "No purchase window detected, normal cadence", daysUntilWindow: null, isValueLed: false };
  }

  const daysUntilWindow = Math.floor((stored.windowStart.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  // If window is in the past or very soon (<60 days), normal cadence
  if (daysUntilWindow < 60) {
    return { shouldSend: true, reason: `Purchase window <60 days out (${daysUntilWindow}d), normal cadence`, daysUntilWindow, isValueLed: false };
  }

  // Check days since last contact to determine if it's time to send
  const db = await getDb();
  let daysSinceLastContact = 999;
  if (db) {
    try {
      const rows = await db
        .select({ sentAt: contactedLeads.sentAt })
        .from(contactedLeads)
        .where(eq(contactedLeads.personId, personId))
        .orderBy(desc(contactedLeads.sentAt))
        .limit(1);
      if (rows.length > 0 && rows[0]!.sentAt) {
        daysSinceLastContact = Math.floor((Date.now() - new Date(rows[0]!.sentAt).getTime()) / (1000 * 60 * 60 * 24));
      }
    } catch { /* default to 999 = send */ }
  }

  if (daysUntilWindow > 120) {
    // >120 days out: weekly cadence
    if (daysSinceLastContact >= 7) {
      return { shouldSend: true, reason: `Purchase window >120 days out (${daysUntilWindow}d), weekly cadence — ${daysSinceLastContact}d since last contact`, daysUntilWindow, isValueLed: true };
    }
    return { shouldSend: false, reason: `Purchase window >120 days out (${daysUntilWindow}d), weekly cadence — only ${daysSinceLastContact}d since last contact (need 7+)`, daysUntilWindow, isValueLed: true };
  }

  // 60-120 days out: every 3-4 days
  if (daysSinceLastContact >= 3) {
    return { shouldSend: true, reason: `Purchase window 60-120 days out (${daysUntilWindow}d), 3-4 day cadence — ${daysSinceLastContact}d since last contact`, daysUntilWindow, isValueLed: true };
  }
  return { shouldSend: false, reason: `Purchase window 60-120 days out (${daysUntilWindow}d), 3-4 day cadence — only ${daysSinceLastContact}d since last contact (need 3+)`, daysUntilWindow, isValueLed: true };
}

/**
 * Generate a highly personalized, intelligent AI follow-up email for a lead.
 * Brain Upgrade: Anthropic Direct + Full Context + Angle Rotation + Temporal Reasoning.
 * Returns both the email body AND a context-aware subject line.
 */
export async function generateFollowUpMessage(opts: {
  agentFirstName: string;
  agentLastName: string;
  leadFirstName: string | null;
  daysStale: number;
  stage: string;
  person?: FubPerson;
  isValueLed?: boolean;
}): Promise<{ body: string; subject: string }> {
  const { agentFirstName, agentLastName, leadFirstName, daysStale: staleDays, stage, person, isValueLed } = opts;
  const hasName = !!leadFirstName && leadFirstName.toLowerCase() !== "there";
  const nameContext = hasName
    ? `The lead's first name is ${leadFirstName}. Use only their first name — never their last name. The greeting must be exactly "Hey ${leadFirstName}," — ONE greeting, ONE name, nothing else on that line.`
    : `We do not have the lead's first name. Open with "Hey, it's ${agentFirstName} with Lifestyle Design Realty!" — do not repeat any greeting.`;

  const leadContext = person ? buildLeadContext(person) : "No prior notes available.";

  // ── Feature 2: Full Context ──────────────────────────────────────────────────
  const leadSource = person?.source ?? person?.leadSource ?? "Unknown";
  const priceRange = person?.priceRange ?? person?.price ?? "Not specified";
  const city = person?.addresses?.[0]?.city ?? "Unknown";
  let daysSinceAssignment = "Unknown";
  const createdStr = person?.created ?? person?.createdAt;
  if (createdStr) {
    try {
      const createdDate = new Date(createdStr);
      daysSinceAssignment = String(Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));
    } catch { /* ignore */ }
  }
  // Engagement signal: count notes in last 14 days
  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recentNoteCount = (person?.notes ?? []).filter(n =>
    n.createdAt && new Date(n.createdAt).getTime() > twoWeeksAgo
  ).length;
  const engagementSignal = recentNoteCount >= 3 ? "High (3+ notes in 14 days)" :
    recentNoteCount >= 1 ? "Medium (some recent activity)" : "Low (no recent notes)";

  // ── Feature 3: Angle Rotation ────────────────────────────────────────────────
  const personId = person?.id ?? 0;
  const lastAngle = await getLastAngle(personId);
  const angle = pickAngle(personId, lastAngle);

  // Determine urgency/tone based on staleness
  let urgencyNote = "";
  if (staleDays >= 60) {
    urgencyNote = "This lead has been completely cold for 2+ months. Write a gentle re-engagement message that acknowledges time has passed without being pushy.";
  } else if (staleDays >= 40) {
    urgencyNote = "This lead has been inactive for 40+ days. Write a warm check-in that feels natural and not salesy.";
  } else if (staleDays >= 14) {
    urgencyNote = "This lead has been inactive for 2+ weeks. Write a friendly, casual follow-up.";
  } else {
    urgencyNote = "This lead was recently contacted but the agent hasn't followed up in a few days. Write a natural continuation.";
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
    case "active client":
    case "hot prospect":
      stageGuidance = "This is a HOT lead who should be getting active attention. The agent hasn't followed up, so step in with urgency and specificity.";
      break;
    default:
      stageGuidance = `This lead is in the "${stage}" stage. Tailor your message appropriately.`;
  }

  const todayStr = new Date().toISOString().slice(0, 10);

  const prompt = `You are ${agentFirstName} ${agentLastName}, a real estate agent at Lifestyle Design Realty in Texas.
You are writing a personalized follow-up email to a real estate lead.

LEAD CONTEXT:
- ${nameContext}
- Days since last contact: ${staleDays}
- Lead stage: ${stage}
- Lead source: ${leadSource}
- Price range: ${priceRange}
- City/Market: ${city}
- Days since assignment: ${daysSinceAssignment}
- Engagement signal: ${engagementSignal}
- ${urgencyNote}
- ${stageGuidance}

FRESHNESS ANGLE FOR THIS EMAIL: ${angle}
IMPORTANT: Do NOT use the same angle as last time. Last angle was: ${lastAngle ?? "none/first email"}
${isValueLed ? `
VALUE-LED EMAIL (Timeline-stretched cadence): This lead has a purchase window far in the future, so emails are less frequent. This email MUST be VALUE-LED — provide genuinely useful content:
- Market updates, rate changes, or incentive programs for their stated price range/city
- New builder deals, inventory updates, or community developments in their target area
- Practical prep steps (VA pre-qualification, credit optimization, down payment programs)
- Neighborhood insights, school ratings, or lifestyle info for their target area
NEVER write a generic "just checking in" — every stretched-cadence email must deliver tangible value.
` : ""}
PRIOR NOTES:
${leadContext}

CRITICAL INSTRUCTIONS — READ CAREFULLY:
1. The MOST RECENT NOTE above is the single most important piece of context. Your email MUST be a direct, natural continuation of whatever happened in that note.
   - If the note says home options/listings were sent → ask "Did you get a chance to look at those options I sent?"
   - If the note says a showing was scheduled → ask how the showing went
   - If the note says they mentioned a specific city/budget/timeline → reference it directly
   - If there are no notes → write a general friendly check-in using the freshness angle
2. NEVER write a generic "just checking in" email if the notes show a specific prior action. That is unprofessional and confusing to the client.
3. Write 2-4 sentences only. Warm, casual, genuine — like a real person texting a friend.
4. Never mention automation, AI, or that this is a follow-up system.
5. Include a soft call-to-action that makes sense given the note context.
6. Sign off with just your first name.
7. CRITICAL DATE AWARENESS: Today's date is ${todayStr}. Notes include their dates in brackets like [2024-10-15]. If a note is more than 30 days old, treat it as HISTORICAL context only. NEVER reference events, meetings, conversations, or actions from old notes as if they are current or upcoming. For example, if an 8-month-old note says "this Friday" or "setting a time," those events are LONG PAST — do not mention them. If the most recent note is very old (60+ days), acknowledge the time gap naturally (e.g., "It's been a while" or "Wanted to reach back out") rather than pretending there's an active ongoing conversation.
8. TEMPORAL REASONING: Extract any dates or time-bound life events mentioned in notes (lease ending, job start, baby due, "not until spring", "moving in August"). Calculate their relationship to today's date and reference them naturally. For example: a March note saying "lease ends in August" should produce, in July: "your lease is coming up next month, right?" A note from January saying "not ready until summer" should produce, in June: "you mentioned wanting to start looking around summer — is now a good time?"
9. ONLY reference listings, options, or properties being sent if the FUB notes EXPLICITLY state that listings/options were sent. NEVER claim you sent listings when you did not.
10. CRITICAL: Do NOT state where the lead is relocating FROM as a fact. Only reference the DESTINATION city/area.
11. CRITICAL: Do NOT invent or assume personal details about the lead unless explicitly stated in the notes.
12. CRITICAL: NEVER reference a previous email, message, call, attachment, or conversation unless it appears explicitly in the provided FUB notes. Real prior outreach always appears in the notes (every bot email logs one). If the notes show no prior outreach, write as a natural FIRST touch — do not imply any earlier contact existed.

FORMAT:
- Line 1: SUBJECT: <a natural, context-aware subject line — NOT "Checking in". Make it specific to this lead's situation and the angle.>
- Line 2 onwards: The email body. Start with ONE single greeting line only (e.g. "Hey Matthew,"). Do NOT repeat the name or write two greetings. The very next line after the greeting should be the first sentence of the message.

IMPORTANT:
1. The subject line MUST reflect the actual context from the notes. Never use a generic subject like "Checking in" if the notes show a specific prior action.
2. NEVER write "Hey Matthew, Hi Matthew" or any double greeting. One greeting, one name, period.
3. Keep it concise: 80–150 words, plain text, friendly, and specific enough to invite a reply.`;

  try {
    const anthropicKey = ENV.anthropicApiKey;
    if (!anthropicKey) {
      throw new Error("ANTHROPIC_API_KEY not configured");
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 512,
        system: "You are an expert real estate agent writing highly personalized, intelligent follow-up emails. Your emails feel handcrafted and genuine, never automated. You always reference specific context when available. You are strategic about temporal reasoning — you know what date it is and reference time-bound events relative to today.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${errBody}`);
    }
    const data = await res.json() as { content?: Array<{ text?: string }> };
    const raw = (data.content?.[0]?.text ?? "").trim();

    // Extract subject line from first line if present
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    let subject = `Following up — ${opts.agentFirstName} ${opts.agentLastName}, Lifestyle Design Realty`;
    let bodyLines = lines;

    if (lines[0]?.toUpperCase().startsWith("SUBJECT:")) {
      const subjectText = lines[0].replace(/^SUBJECT:\s*/i, "").trim();
      if (subjectText) subject = `${subjectText} — ${opts.agentFirstName} ${opts.agentLastName}`;
      bodyLines = lines.slice(1);
    }

    const body = bodyLines
      .join("\n")
      // Strip any leaked automation/AI-assistant lines the LLM may add
      .replace(/Is there anything else I can automate to make your life easier\?/gi, "")
      .replace(/Is there anything (else )?I can (help|automate|do) to make your (life|day|work) easier\??/gi, "")
      .replace(/Would you like me to automate anything[^\n]*/gi, "")
      .replace(/Let me know if there['’]?s anything (else )?I can automate[^\n]*/gi, "")
      .replace(/Reply to this email with any(thing)?[^\n]*automate[^\n]*/gi, "")
      // Remove any trailing blank lines left by the strips
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // ── Feature 3: Save the angle used ─────────────────────────────────────────
    if (personId) {
      await saveAngle(personId, angle);
    }

    return { body, subject };
  } catch (err) {
    console.error("[generateFollowUpMessage] Anthropic call failed:", err);
    // Do NOT fall back to a generic "just checking in" email — that is exactly
    // the low-quality send the brain upgrade exists to prevent. Rethrow so the
    // bot's per-lead error handling counts it as errored and sends nothing.
    throw err;
  }
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
    from: `${agentFirstName} | Lifestyle Design Realty <${agentEmail}>`,
    to: leadEmail,
    subject,
    html,
    bcc: PETER_EMAIL,
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
  bcc?: string | string[];
}): Promise<void> {
  const transporter = getTransporter();
  await transporter.sendMail({
    from: opts.from ?? EMAIL_FROM,
    to: Array.isArray(opts.to) ? opts.to.join(", ") : opts.to,
    subject: opts.subject,
    html: opts.html,
    replyTo: opts.replyTo,
    bcc: opts.bcc,
  });
}

// ─── Clock-in / Clock-off emails ─────────────────────────────────────────────

/**
 * Clock-in email sent at 10am CT.
 * Asks the agent if they want anything automated — replies go to Peter's email.
 * Recipients: Peter, Steven, and the agent.
 */
const OLD_DASHBOARD_BASE = "https://fub-nurture-phfprjui.manus.space";

/** New Lifestyle Bot Dashboard base URL */
const NEW_DASHBOARD_BASE = "https://lifestyledash-wpnl8v84.manus.space";

/**
 * Leaders who see the full multi-agent dashboard (/).
 * All other agents get their own scoped /agent/:slug view.
 */
const LEADER_AGENTS = new Set(["peter", "steven", "stefanie", "rue"]);

/**
 * LEGACY FALLBACK ONLY — used when the agent_bots table is unreachable or has
 * no row for the agent (e.g. legacy "Rue" alias). The live source of truth is
 * the agent_bots table (Golden Rule: new agents propagate with zero code
 * changes via resolveAgentBotRow below).
 */
const AGENT_DASHBOARD_SLUG_FALLBACK: Record<string, string> = {
  peter: "peter",
  steven: "steven",
  tiffany: "tiffany",
  stefanie: "stefanie",
  rue: "stefanie",   // Rue is Stefanie's bot name — map to her slug
  abby: "abby",
  irma: "irma",
  laila: "laila",
};

/** LEGACY FALLBACK ONLY — see AGENT_DASHBOARD_SLUG_FALLBACK note above. */
const POWER_QUEUE_AGENT_NAME_FALLBACK: Record<string, string> = {
  peter: "Peter",
  steven: "Steven",
  tiffany: "Tiffany",
  stefanie: "Stefanie",
  rue: "Stefanie",   // Rue bot is assigned to Stefanie Graham
  abby: "Abby",
  irma: "Irma",
  laila: "Laila",
};

/**
 * Dynamic agent lookup (Golden Rule): resolve the agent_bots row for an agent
 * first name. Any agent added to agent_bots automatically gets a correct
 * Power Queue link and dashboard slug with zero code changes.
 */
export async function resolveAgentBotRow(
  agentFirstName: string
): Promise<{ botSlug: string; powerQueueName: string | null; agentFirstName: string } | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const { agentBots } = await import("../drizzle/schema");
    const rows = await db.select().from(agentBots);
    const lower = agentFirstName.trim().toLowerCase();
    const row = rows.find(
      r => r.agentFirstName.toLowerCase() === lower || r.botSlug.toLowerCase() === lower
    );
    if (!row) return null;
    return { botSlug: row.botSlug, powerQueueName: row.powerQueueName, agentFirstName: row.agentFirstName };
  } catch {
    return null;
  }
}

/**
 * Pure resolution logic (exported for tests): given an optional agent_bots row
 * and the agent first name, produce the Power Queue display name and slug.
 * Precedence: agent_bots row → legacy fallback map → title-cased first name.
 */
export function derivePowerQueueName(
  row: { powerQueueName: string | null; agentFirstName: string } | null,
  agentFirstName: string
): string {
  if (row) return row.powerQueueName ?? row.agentFirstName;
  const lower = agentFirstName.toLowerCase();
  return (
    POWER_QUEUE_AGENT_NAME_FALLBACK[lower] ??
    agentFirstName.charAt(0).toUpperCase() + agentFirstName.slice(1).toLowerCase()
  );
}

/** Pure resolution logic (exported for tests): dashboard slug precedence. */
export function deriveDashboardSlug(
  explicitSlug: string | null | undefined,
  row: { botSlug: string } | null,
  agentFirstName: string
): string | null {
  return (
    explicitSlug ??
    row?.botSlug ??
    AGENT_DASHBOARD_SLUG_FALLBACK[agentFirstName.toLowerCase()] ??
    null
  );
}

export async function sendClockinEmail(opts: {
  botName: string;
  agentFirstName: string;
  agentLastName: string;
  agentEmail: string;
  leadsQueued: number;          // Bot's job: 3-19 day stale leads the bot will email today
  powerQueueCount?: number;     // Agent's job: 1-20 day stale leads in the Power Queue
  accentColor?: string;
  headerGradient?: string;
  botSlug?: string;             // Used to build the dynamic dashboard link
}): Promise<void> {
  const { botName, agentFirstName, agentLastName, agentEmail, leadsQueued } = opts;
  const powerQueueCount = opts.powerQueueCount ?? 0;
  const accent = opts.accentColor ?? "#2c5f2e";
  const gradient = opts.headerGradient ?? "linear-gradient(135deg,#1a3d1c 0%,#2c5f2e 60%,#3a7d3c 100%)";
  const isCombined = agentFirstName === "Steven & Peter";
  const greeting = isCombined ? "Good morning, Steven and Peter!" : `Good morning, ${agentFirstName}!`;
  const agentDisplay = isCombined ? "Steven Van Orden and Peter Allen" : `${agentFirstName} ${agentLastName}`;
  const dailyQuote = getDailyQuote();

  // Build Power Queue + agent dashboard links.
  // Golden Rule: resolve from the agent_bots table first (any new agent row
  // propagates here automatically), fall back to the legacy static maps.
  const agentRow = isCombined ? null : await resolveAgentBotRow(agentFirstName);
  const pqAgentName = isCombined ? null : derivePowerQueueName(agentRow, agentFirstName);
  const powerQueueUrl = pqAgentName
    ? `${OLD_DASHBOARD_BASE}/sms-queue?agent=${encodeURIComponent(pqAgentName)}`
    : `${OLD_DASHBOARD_BASE}/sms-queue`;
  // Derive the slug: prefer explicit botSlug param, then agent_bots row, then fallback map
  const agentSlug = isCombined ? null : deriveDashboardSlug(opts.botSlug, agentRow, agentFirstName);
  const isLeader = isCombined || (agentFirstName && LEADER_AGENTS.has(agentFirstName.toLowerCase()));
  // Every agent gets exactly ONE dashboard button — leaders go to /, non-leaders go to /agent/:slug
  const agentDashboardUrl = isLeader
    ? `${NEW_DASHBOARD_BASE}/`
    : agentSlug
      ? `${NEW_DASHBOARD_BASE}/agent/${agentSlug}`
      : `${NEW_DASHBOARD_BASE}/`; // Fallback: always produce a link, never null

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

        <!-- DASHBOARD BUTTON (always exactly one, dynamically built) -->
        <tr>
          <td style="padding:20px 44px 0;text-align:center;">
            <a href="${agentDashboardUrl}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:0.3px;">📊 ${isCombined ? 'View Dashboard' : `${agentFirstName}'s Dashboard`}</a>
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
  timelineAdjusted?: number;
  avgWindowDaysOut?: number;
  accentColor?: string;
  headerGradient?: string;
}): Promise<void> {
  const { botName, agentFirstName, agentLastName, agentEmail, sent, errored, skipped } = opts;
  const timelineAdjusted = opts.timelineAdjusted ?? 0;
  const avgWindowDaysOut = opts.avgWindowDaysOut ?? 0;
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
                <td style="padding:20px 24px;${timelineAdjusted > 0 ? 'border-bottom:1px solid #e5e7eb;' : ''}">
                  <table cellpadding="0" cellspacing="0" width="100%"><tr>
                    <td style="font-size:14px;color:#374151;">${errored > 0 ? '⚠️ &nbsp;<strong>Errors encountered</strong>' : '✅ &nbsp;No errors'}</td>
                    <td style="text-align:right;font-size:28px;font-weight:800;color:${errored > 0 ? '#ef4444' : '#10b981'};">${errored}</td>
                  </tr></table>
                </td>
              </tr>
              ${timelineAdjusted > 0 ? `<tr style="background:#eff6ff;">
                <td style="padding:20px 24px;">
                  <table cellpadding="0" cellspacing="0" width="100%"><tr>
                    <td style="font-size:14px;color:#374151;">📅 &nbsp;<strong>Timeline-adjusted leads</strong> (avg ${avgWindowDaysOut}d out)</td>
                    <td style="text-align:right;font-size:28px;font-weight:800;color:#2563eb;">${timelineAdjusted}</td>
                  </tr></table>
                </td>
              </tr>` : ''}
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
  });
}
