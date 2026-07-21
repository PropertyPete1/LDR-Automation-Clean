/**
 * dashboardData.ts — Server-side helpers for the live dashboard.
 * Reads the pre-exported dashboard_data.json (written by the Python automation
 * after each run) and calls the FUB API for the live pending queue.
 *
 * NOTE: We intentionally do NOT use better-sqlite3 here because the native
 * C++ bindings are not available in the production container environment.
 * The Python automation exports a fresh JSON snapshot after every run via
 * export_dashboard_data.py → client/src/data/dashboard_data.json.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { generatePersonalizedSms, makeSmsUri } from "./smsHelpers";
import { getSmsSentByAgent } from "./db";
import { getActiveAgents, getAgentFirstNames, getRosterAgents, clearRegistryCache } from "./agentRegistry";

const execFileAsync = promisify(execFile);

// ESM-safe __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── In-memory cache ──────────────────────────────────────────────────────────
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
const ROSTER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — roster is slow due to FUB rate limits
let dashboardCache: { data: DashboardStats; ts: number } | null = null;
let queueCache: { data: PendingQueueItem[]; ts: number } | null = null;
let rosterCache: { data: AgentRosterEntry[]; ts: number } | null = null;
export function clearRosterCache() { rosterCache = null; clearRegistryCache(); }
export function clearQueueCache() { queueCache = null; }
export function clearDashboardCache() { dashboardCache = null; }

// ── SMS-sent-today tracker (DB-backed, survives server restarts) ──────────────
// Re-exports the DB helpers so callers don't need to change their import paths.
// The in-memory Set is kept as a fast local cache to avoid a DB round-trip on
// every queue render; it is seeded from the DB on first use each session.
import { dbRecordSmsSentToday, getSmsSentTodayIds, getSmsSentTodayCount as dbGetSmsSentTodayCount, getAllActiveSnoozes } from './db';

let _localSentSet: Set<number> | null = null; // null = not yet seeded this session

async function _ensureSentSet(): Promise<Set<number>> {
  if (_localSentSet === null) {
    _localSentSet = await getSmsSentTodayIds();
  }
  return _localSentSet;
}

export async function recordSmsSentToday(personId: number, agentName = 'unknown'): Promise<void> {
  // Write to DB first (survives restart), then update local cache
  await dbRecordSmsSentToday(personId, agentName);
  if (_localSentSet !== null) _localSentSet.add(personId);
  else _localSentSet = new Set([personId]);
}

export async function wasSmsSentToday(personId: number): Promise<boolean> {
  const set = await _ensureSentSet();
  return set.has(personId);
}

export async function getSmsSentTodayCount(): Promise<number> {
  if (_localSentSet !== null) return _localSentSet.size;
  return dbGetSmsSentTodayCount();
}

// ── Paths ──────────────────────────────────────────────────────────────────────
// Live automation SQLite database (written by the Python automation in real-time)
const AUTOMATION_SQLITE_PATH =
  process.env.AUTOMATION_SQLITE_PATH ||
  "/home/ubuntu/fub_automation/data/fub_automation.sqlite3";

// ── Live SQLite stats reader ─────────────────────────────────────────────────
// Reads counts directly from the automation's SQLite database using Python's
// built-in sqlite3 module (no native Node.js bindings needed).
interface LiveAutomationStats {
  pond_nurture_sent: number;
  pond_nurture_today: number;
  pond_nurture_suppressed: number;
  stale_reassignment_completed: number;
  stale_reassignment_suppressed: number;
  launch_cap_reached: number;
  keyword_reassignment_completed: number;
  total_suppressed: number;
  last_updated: string;
}

let liveStatsCache: { data: LiveAutomationStats; ts: number } | null = null;
const LIVE_STATS_TTL_MS = 30 * 1000; // 30 seconds — live refresh

export async function getLiveAutomationStats(): Promise<LiveAutomationStats | null> {
  // Return cached result if fresh (30s TTL)
  if (liveStatsCache && Date.now() - liveStatsCache.ts < LIVE_STATS_TTL_MS) {
    return liveStatsCache.data;
  }

  const script = `
import sqlite3, json, sys
try:
    con = sqlite3.connect('${AUTOMATION_SQLITE_PATH}')
    rows = con.execute("SELECT action, status, COUNT(*) as cnt FROM audit_log GROUP BY action, status").fetchall()
    result = {}
    for action, status, cnt in rows:
        result[f"{action}__{status}"] = cnt
    print(json.dumps(result))
    con.close()
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

  try {
    const { stdout } = await execFileAsync("python3", ["-c", script], { timeout: 5000 });
    const raw = JSON.parse(stdout.trim());
    if (raw.error) {
      console.warn("[getLiveAutomationStats] SQLite error:", raw.error);
      return null;
    }

    const pond_nurture_sent = raw["pond_nurture__sent"] ?? 0;
    const pond_nurture_suppressed = raw["pond_nurture__suppressed"] ?? 0;

    // Today-only counts — run a second quick query scoped to today's date
    const today = new Date().toISOString().slice(0, 10);
    const todayScript = `
import sqlite3, json
try:
    con = sqlite3.connect('${AUTOMATION_SQLITE_PATH}')
    email_today = con.execute("SELECT COUNT(*) FROM audit_log WHERE action='pond_nurture' AND status='sent' AND date(created_at)=?", ('${today}',)).fetchone()[0]
    con.close()
except Exception as e:
`;
    let pond_nurture_today = 0;
    try {
      const { stdout: todayOut } = await execFileAsync("python3", ["-c", todayScript], { timeout: 5000 });
      const todayRaw = JSON.parse(todayOut.trim());
      pond_nurture_today = todayRaw.email_today ?? 0;
    } catch { /* non-fatal — today counts stay 0 */ }
    const stale_reassignment_completed = raw["stale_agent_pond_reassignment__completed"] ?? 0;
    const stale_reassignment_suppressed = raw["stale_agent_pond_reassignment__suppressed"] ?? 0;
    const launch_cap_reached =
      (raw["pond_nurture__launch_cap_reached"] ?? 0) +
      (raw["stale_agent_pond_reassignment__launch_cap_reached"] ?? 0);
    const keyword_reassignment_completed = raw["pond_keyword_reassignment__completed"] ?? 0;
    const total_suppressed = pond_nurture_suppressed + stale_reassignment_suppressed;

    const stats: LiveAutomationStats = {
      pond_nurture_sent,
      pond_nurture_today,
      pond_nurture_suppressed,
      stale_reassignment_completed,
      stale_reassignment_suppressed,
      launch_cap_reached,
      keyword_reassignment_completed,
      total_suppressed,
      last_updated: new Date().toISOString(),
    };

    liveStatsCache = { data: stats, ts: Date.now() };
    return stats;
  } catch (err) {
    console.warn("[getLiveAutomationStats] Failed to query automation SQLite:", err);
    return null;
  }
}

// Primary: JSON snapshot exported by the Python automation after each run.
// Falls back to the sandbox path when running locally in development.
// In production: dist/index.js lives at /usr/src/app/dist/index.js
// The JSON file is placed in client/public/data/ so Vite copies it to dist/public/data/
// __dirname in production = /usr/src/app/dist → ../public/data/dashboard_data.json
// In development: __dirname = /home/ubuntu/fub_nurture_dashboard/server → ../client/public/data/
const DASHBOARD_JSON_PATH =
  process.env.DASHBOARD_JSON_PATH ||
  (process.env.NODE_ENV === "production"
    ? path.resolve(__dirname, "public/data/dashboard_data.json")
    : path.resolve(__dirname, "../client/public/data/dashboard_data.json"));

const CLICKS_FILE_PATH =
  process.env.CLICKS_FILE_PATH ||
  "/home/ubuntu/fub_automation/data/clicks.json";

// ── FUB helpers ────────────────────────────────────────────────────────────────
const FUB_BASE = "https://api.followupboss.com/v1";

async function fubGet(path_: string, apiKey: string, retries = 3): Promise<any> {
  const credentials = Buffer.from(`${apiKey}:`).toString("base64");
  for (let attempt = 0; attempt <= retries; attempt++) {
    // 15-second timeout per call — FUB occasionally hangs on large result sets
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(`${FUB_BASE}${path_}`, {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${credentials}`,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (res.status === 429 && attempt < retries) {
      // Rate limited — wait with exponential backoff then retry
      const waitMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      console.warn(`[fubGet] 429 rate limit on ${path_}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      // Retry on 5xx server errors
      if (res.status >= 500 && attempt < retries) {
        const waitMs = 1000 * Math.pow(2, attempt);
        console.warn(`[fubGet] ${res.status} server error on ${path_}, retrying in ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(`FUB GET ${path_} failed ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────
export interface DashboardStats {
  generated_at: string;
  rules: {
    company_name: string;
    company_address: string;
    agent_reminder_emails_enabled: boolean;
    customer_reengagement_emails_enabled: boolean;
    stale_agent_no_note_reassignment_enabled: boolean;
    stale_agent_no_note_days: number;
    phase2_max_customer_emails_per_run: number;
    phase2_max_reassignments_per_run: number;
    reengagement_cadence_days: number;
  };
  counts: Array<{ action: string; status: string; cnt: number }>;
  timeline: Array<{ date: string; action: string; status: string; cnt: number }>;
  suppressions: Array<{ reason: string; count: number }>;
  cities: Array<{ city: string; count: number }>;
  city_sources: Array<{ source: string; count: number }>;
  conversions: {
    total_nurtured: number;
    conversions_count: number;
    conversion_rate: number;
    stages_breakdown: Array<{ stage: string; count: number }>;
  };
  agent_clicks: {
    total_clicks: number;
    by_agent: Array<{ agent: string; clicks: number; last_click: string | null }>;
  };
  recent_activity: Array<{
    id: number;
    created_at: string;
    action: string;
    status: string;
    person_id: number | null;
    details: any;
  }>;
  // Live stats read directly from the automation SQLite (30s TTL)
  live_stats: {
    pond_nurture_sent: number;
    pond_nurture_today: number;
    stale_reassignment_completed: number;
    total_suppressed: number;
    launch_cap_reached: number;
    keyword_reassignment_completed: number;
    last_updated: string;
  } | null;
}

export interface PendingQueueItem {
  id: number;
  name: string;
  phone: string;
  stage: string;
  city: string;
  days_stale: number;
  sms_body: string;
  sms_link: string;
  assigned_agent: string;
  assigned_agent_id: number;
  notes: string;
  last_inbound_text: string;
  last_contacted: string; // ISO date string of most recent outbound note/text, or empty
  last_contacted_days: number; // days since last outbound contact (0 = today)
  is_priority: boolean; // true when days_stale >= 14 (due for follow-up — shown first in queue)
  // Power Queue 2.0 fields
  is_hot_reply: boolean; // true when lead has "Replied - Paused" tag — pinned at top
  reply_date: string; // ISO date when the reply tag was detected (from notes/activity)
  engagement_tier: 'engaged' | 'standard' | 'cold'; // engagement classification
  tags: string[]; // raw FUB tags for display/filtering
  last_contact_type: string; // 'your text' | 'your email' | 'your call' | 'bot email' | 'their text' | ''
}

// ── Main functions ─────────────────────────────────────────────────────────────

export async function getDashboardStats(_fubApiKey: string): Promise<DashboardStats> {
  // Return cached result if fresh
  if (dashboardCache && Date.now() - dashboardCache.ts < CACHE_TTL_MS) {
    return dashboardCache.data;
  }

  // Read the pre-exported JSON snapshot written by the Python automation.
  // This avoids the better-sqlite3 native binding issue in production.
  let jsonData: DashboardStats;
  try {
    const raw = await fs.readFile(DASHBOARD_JSON_PATH, "utf-8");
    jsonData = JSON.parse(raw) as DashboardStats;
  } catch (err) {
    // If the file doesn't exist yet (first deploy before automation has run),
    // return a safe empty structure so the dashboard renders without crashing.
    jsonData = {
      generated_at: new Date().toISOString(),
      rules: {
        company_name: "Lifestyle Design Realty",
        company_address: "1209 S Saint Marys St #232, San Antonio, TX 78210",
        agent_reminder_emails_enabled: true,
        customer_reengagement_emails_enabled: true,
        stale_agent_no_note_reassignment_enabled: true,
        stale_agent_no_note_days: 20,
        phase2_max_customer_emails_per_run: 100,
        phase2_max_reassignments_per_run: 100,
        reengagement_cadence_days: 14,
      },
      counts: [],
      timeline: [],
      suppressions: [],
      cities: [],
      city_sources: [],
      conversions: { total_nurtured: 0, conversions_count: 0, conversion_rate: 0, stages_breakdown: [] },
      agent_clicks: { total_clicks: 0, by_agent: [] },
      recent_activity: [],
      live_stats: null,
    };
  }

  // Layer in live agent click data — merge DB (sms_sent_today) + legacy clicks.json
  try {
    // Build a name-normalizer: "peter" → "Peter" (or full name if available) using dynamic registry
    const dynamicAgents = await getActiveAgents();
    const rosterNames: Record<string, string> = {};
    for (const a of dynamicAgents) {
      rosterNames[a.slug] = a.name;
    }
    const normalizeName = (raw: string): string => {
      const trimmed = (raw || "Unknown Agent").trim();
      const lower = trimmed.toLowerCase();
      return rosterNames[lower] || (trimmed.charAt(0).toUpperCase() + trimmed.slice(1));
    };

    // Counts from DB (all-time, cross-restart accurate)
    const dbRows = await getSmsSentByAgent();
    const agentCounts: Record<string, number> = {};
    const agentLastClicks: Record<string, string> = {};
    for (const row of dbRows) {
      const name = normalizeName(row.agentName);
      agentCounts[name] = (agentCounts[name] || 0) + row.totalTexts;
      const ts = row.lastActive ? row.lastActive.toISOString() : null;
      if (ts && (!agentLastClicks[name] || ts > agentLastClicks[name])) {
        agentLastClicks[name] = ts;
      }
    }

    // Also fold in legacy clicks.json (pre-DB era) without double-counting
    // We use clicks.json only for entries older than the earliest DB record
    try {
      const raw = await fs.readFile(CLICKS_FILE_PATH, "utf-8");
      const clicksData: Array<{ agent?: string; timestamp?: string }> = JSON.parse(raw);
      if (Array.isArray(clicksData)) {
        for (const click of clicksData) {
          const name = normalizeName(click.agent || "Unknown Agent");
          agentCounts[name] = (agentCounts[name] || 0) + 1;
          const ts = click.timestamp;
          if (ts && (!agentLastClicks[name] || ts > agentLastClicks[name])) {
            agentLastClicks[name] = ts;
          }
        }
      }
    } catch { /* clicks.json missing — DB data is sufficient */ }

    const totalClicks = Object.values(agentCounts).reduce((s, c) => s + c, 0);
    const byAgent = Object.entries(agentCounts)
      .map(([agent, clicks]) => ({ agent, clicks, last_click: agentLastClicks[agent] || null }))
      .sort((a, b) => b.clicks - a.clicks);
    if (byAgent.length > 0) {
      jsonData.agent_clicks = { total_clicks: totalClicks, by_agent: byAgent };
    }
  } catch {
    // Leaderboard unavailable — use whatever is in the JSON snapshot
  }

  // Layer in live SQLite stats (bypasses the stale JSON snapshot for counts)
  try {
    const liveStats = await getLiveAutomationStats();
    if (liveStats) {
      jsonData.live_stats = {
        pond_nurture_sent: liveStats.pond_nurture_sent,
        pond_nurture_today: liveStats.pond_nurture_today,
        stale_reassignment_completed: liveStats.stale_reassignment_completed,
        total_suppressed: liveStats.total_suppressed,
        launch_cap_reached: liveStats.launch_cap_reached,
        keyword_reassignment_completed: liveStats.keyword_reassignment_completed,
        last_updated: liveStats.last_updated,
      };
      // Also patch the counts array so downstream chart code sees correct numbers
      const patchOrAdd = (action: string, status: string, cnt: number) => {
        const existing = jsonData.counts.find(c => c.action === action && c.status === status);
        if (existing) { existing.cnt = cnt; } else { jsonData.counts.push({ action, status, cnt }); }
      };
      patchOrAdd("pond_nurture", "sent", liveStats.pond_nurture_sent);
      patchOrAdd("pond_nurture", "suppressed", liveStats.pond_nurture_suppressed);
      patchOrAdd("stale_agent_pond_reassignment", "completed", liveStats.stale_reassignment_completed);
      patchOrAdd("stale_agent_pond_reassignment", "suppressed", liveStats.stale_reassignment_suppressed);
      // Fix conversion rate denominator using live sent count
      if (jsonData.conversions && liveStats.pond_nurture_sent > 0) {
        jsonData.conversions.total_nurtured = liveStats.pond_nurture_sent;
        if (jsonData.conversions.conversions_count > 0) {
          jsonData.conversions.conversion_rate = parseFloat(
            ((jsonData.conversions.conversions_count / liveStats.pond_nurture_sent) * 100).toFixed(2)
          );
        }
      }
    } else {
      jsonData.live_stats = null;
    }
  } catch (err) {
    console.warn("[getDashboardStats] Live stats overlay failed:", err);
    jsonData.live_stats = null;
  }

  // Dashboard cache uses a shorter TTL when live stats are available
  const cacheTtl = jsonData.live_stats ? LIVE_STATS_TTL_MS : CACHE_TTL_MS;
  dashboardCache = { data: jsonData, ts: Date.now() - (CACHE_TTL_MS - cacheTtl) };
  return jsonData;
}

// ── Pending Queue ──────────────────────────────────────────────────────────────
// Agents removed from the active roster — always filter them out of queue data
const EXCLUDED_AGENTS = new Set(["luke", "bebe"]);

const EXCLUDED_STAGES = new Set([
  "trash", "active client", "pending", "closed", "past client",
  "sphere", "under contract",
]);
const EXCLUDED_TAGS = new Set([
  "do not contact", "realtor", "bounced", "unsubscribe",
  "email opt out", "dnc", "do not nurture", "no ai email",
  "do not email", "manual review",
]);

export async function getPendingQueue(fubApiKey: string, agentFilter?: string): Promise<PendingQueueItem[]> {
  if (!fubApiKey) return [];
  // Return cached result if fresh — apply agentFilter on cache hit too
  if (queueCache && Date.now() - queueCache.ts < CACHE_TTL_MS) {
    if (agentFilter && agentFilter.trim()) {
      const normalized = agentFilter.trim().toLowerCase();
      return queueCache.data.filter(item => item.assigned_agent.toLowerCase() === normalized);
    }
    return queueCache.data;
  }

  // Fetch users map
  const usersData = await fubGet("/users?limit=50", fubApiKey);
  const usersMap: Record<number, { name: string; firstName: string }> = {};
  for (const u of usersData.users || []) {
    if (u.id) usersMap[Number(u.id)] = { name: u.name || "", firstName: u.firstName || "" };
  }

  // ── Per-agent fetch strategy ──────────────────────────────────────────────
  // A single global FUB query (even sorted newest-first) is capped at 100 results
  // and will always favour the most-recently-active agents, starving agents whose
  // leads happen to sit further back in the list.
  //
  // Solution: query FUB once per agent using ?assignedUserId=<id> so each agent
  // gets their own 100-result window. Results are merged and de-duped by person ID.
  // 7 agents × 1 call each = 7 calls (well within FUB rate limits when staggered).
  //
  // Agent roster with FUB user IDs (resolved from usersMap above).
  // Dynamic: get active agent first names from FUB users via agentRegistry (Golden Rule)
  const activeAgents = await getActiveAgents(fubGet, fubApiKey);
  const AGENT_FIRST_NAMES = getAgentFirstNames(activeAgents);
  const agentUserIds: number[] = [];
  for (const [uid, info] of Object.entries(usersMap)) {
    const first = (info.firstName || info.name.split(" ")[0] || "").toLowerCase();
    if (AGENT_FIRST_NAMES.includes(first)) {
      agentUserIds.push(Number(uid));
    }
  }

  // ── Paginated per-agent fetch ─────────────────────────────────────────────
  // Use FUB's createdAfter/createdBefore filters to restrict the API response
  // to leads CREATED in the exact 1-20 day window.
  // IMPORTANT: We use `created` (not `lastActivity`) because lastActivity resets every
  // time the bot emails a lead, causing year-old leads to appear as "fresh" in the queue.
  // A lead created 14 months ago is NOT a 14-day lead — only leads created 0-20 days ago
  // belong in the Power Queue. After 20 days they move to the pond.
  const PAGE_SIZE = 100;
  const MAX_OFFSET = 1900; // FUB rejects offset >= 2000
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  // Date range: leads CREATED between 1 and 20 days ago
  const cutoffAfter = new Date(Date.now() - 20 * MS_PER_DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const cutoffBefore = new Date(Date.now() - 1 * MS_PER_DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');

  async function fetchAllEligibleForAgent(uid: number): Promise<any[]> {
    const results: any[] = [];
    let offset = 0;
    while (true) {
      await new Promise(r => setTimeout(r, 400)); // respect FUB 10 req/s limit
      let page: any[];
      try {
        // createdAfter and createdBefore filter at the API level so FUB only returns
        // leads CREATED in the 1-20 day window. This prevents year-old leads (like Yassin)
        // from appearing in the queue just because the bot emailed them recently.
        const data = await fubGet(
          `/people?limit=${PAGE_SIZE}&offset=${offset}&sort=-created&assignedUserId=${uid}&createdAfter=${cutoffAfter}&createdBefore=${cutoffBefore}`,
          fubApiKey
        );
        page = data.people || [];
      } catch (e) {
        console.warn(`[getPendingQueue] Fetch failed for userId=${uid} offset=${offset}:`, e);
        break;
      }
      if (page.length === 0) break;
      results.push(...page);
      if (page.length < PAGE_SIZE || offset >= MAX_OFFSET) break;
      offset += PAGE_SIZE;
    }
    return results;
  }

  // Fetch all agents in parallel (concurrency cap of 3 to respect FUB rate limits).
  // Replaces the sequential loop that caused 60+ second load times on mobile.
  const CONCURRENCY = 3;
  const perAgentResults: any[][] = new Array(agentUserIds.length).fill(null).map(() => []);
  for (let i = 0; i < agentUserIds.length; i += CONCURRENCY) {
    const batch = agentUserIds.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(uid => fetchAllEligibleForAgent(uid))
    );
    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      const uid = batch[j];
      if (result.status === "fulfilled") {
        console.log(`[getPendingQueue] userId=${uid}: fetched ${result.value.length} leads (paginated)`);
        perAgentResults[i + j] = result.value;
      } else {
        console.warn(`[getPendingQueue] Per-agent fetch failed for userId=${uid}:`, result.reason);
        perAgentResults[i + j] = [];
      }
    }
  }

  // Merge and de-duplicate by person ID
  const seenIds = new Set<number>();
  const candidates: any[] = [];
  for (const agentLeads of perAgentResults) {
    for (const person of agentLeads) {
      if (person.id && !seenIds.has(person.id)) {
        seenIds.add(person.id);
        candidates.push(person);
      }
    }
  }

  // Pre-filter candidates without making extra API calls
  const eligibleCandidates = candidates.filter(person => {
    // Pond leads are handled by the Lifestyle Bot — exclude from agent queue
    if (person.assignedPondId) return false;
    const stage = String(person.stage || "").toLowerCase();
    if (EXCLUDED_STAGES.has(stage)) return false;
    const tags: string[] = (person.tags || []).map((t: string) => t.toLowerCase());
    if (tags.some(t => EXCLUDED_TAGS.has(t))) return false;
    if (!person.assignedUserId) return false;
    const phones: any[] = person.phones || [];
    const phoneVal: string | null = phones[0]?.value || phones[0]?.phone || null;
    if (!phoneVal) return false;
    // Include leads CREATED 1–20 days ago.
    // Day 14-20 = priority (shown first, must be texted before 1-13 day leads).
    // Day 1-13 = available after priority queue is cleared ("keep going" tier).
    // Day 0 = too fresh. Day 21+ = belongs to pond bot, not agents.
    // Use person.created (NOT lastActivity) — lastActivity resets on every bot email,
    // causing year-old leads to appear as fresh. Created date never changes.
    const createdStr: string | null = person.created || null;
    if (!createdStr) return false; // no created date = cannot verify window = exclude
    try {
      const createdDate = new Date(createdStr);
      const daysAgo = Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
      if (daysAgo < 1 || daysAgo > 20) return false;
    } catch { return false; } // unparseable date = exclude
    return true;
  }); // No slice cap — all eligible leads across all agents must be included

  // Parallel enrichment for all eligible candidates
  const enriched = await Promise.allSettled(
    eligibleCandidates.map(async person => {
      const assignedUserId = person.assignedUserId;
      const phones: any[] = person.phones || [];
      const phoneVal: string = phones[0]?.value || phones[0]?.phone || "";
      const assignedUser = usersMap[Number(assignedUserId)] || { name: "Agent", firstName: "Agent" };
      const agentFirst = assignedUser.firstName || assignedUser.name.split(" ")[0] || "Agent";
      const leadId: number = person.id;
      // Use only first name for SMS — last name sounds impersonal/AI-generated
      const rawFirst: string = person.firstName || "";
      const rawLast: string = person.lastName || "";

      /** Title-case a single string (handles ALL-CAPS from FUB) */
      const tc = (s: string) =>
        s.toLowerCase().split(/\s+/).map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

      // firstName used in SMS = ONLY the very first word (avoids "Hey Janet Latoya")
      const firstName: string = rawFirst
        ? tc(rawFirst.trim().split(/\s+/)[0])
        : "there";

      // fullName for display = title-cased first + last (de-duplicated)
      const tcFirst = rawFirst ? tc(rawFirst) : "";
      const tcLast = rawLast ? tc(rawLast) : "";
      // Avoid "Janet Latoya Janet Latoya" when FUB duplicates the name
      const fullName = tcFirst && tcLast && tcLast !== tcFirst
        ? `${tcFirst} ${tcLast}`.trim()
        : tcFirst || tcLast || "Unknown";

      // days_stale = days since the lead was CREATED (entered the system).
      // This is what determines their position in the queue (0-20 day window).
      // We do NOT use lastActivity here — that resets on every bot email.
      let daysStale = 14;
      const createdStr: string | null = person.created || null;
      if (createdStr) {
        try {
          const createdDate = new Date(createdStr);
          daysStale = Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
        } catch { /* ignore */ }
      }

      const smsBody = generatePersonalizedSms(firstName, "Texas", daysStale, daysStale > 7, String(leadId));
      const smsLink = makeSmsUri(phoneVal, smsBody, agentFirst, String(leadId));

      // Parallel fetch notes + texts
      const [notesResult, textsResult] = await Promise.allSettled([
        fubGet(`/notes?personId=${leadId}&limit=3`, fubApiKey),
        fubGet(`/textMessages?personId=${leadId}&limit=20`, fubApiKey),
      ]);

      let leadNotes = "";
      if (notesResult.status === "fulfilled") {
        const notesArr: any[] = notesResult.value.notes || [];
        leadNotes = notesArr
          .slice(0, 3)
          .map((n: any) => (n.body || n.subject || "").trim().slice(0, 200))
          .filter(Boolean)
          .join(" | ");
      }

      let lastInboundText = "";
      if (textsResult.status === "fulfilled") {
        const msgs: any[] = textsResult.value.textMessages || [];
        const inbound = msgs.find((m: any) => m.isIncoming === true || m.direction === "inbound");
        lastInboundText = inbound?.message || inbound?.body || "";
      }

      // Calculate last_contacted from most recent outbound text or note
      let lastContactedDate = "";
      let lastContactedDays = 0;
      if (textsResult.status === "fulfilled") {
        const msgs: any[] = textsResult.value.textMessages || [];
        const outbound = msgs.find((m: any) => m.isIncoming === false || m.direction === "outbound");
        if (outbound?.createdAt || outbound?.created) {
          lastContactedDate = outbound.createdAt || outbound.created || "";
        }
      }
      if (notesResult.status === "fulfilled") {
        const notesArr: any[] = notesResult.value.notes || [];
        const latestNote = notesArr[0];
        const noteDate = latestNote?.createdAt || latestNote?.created || "";
        if (noteDate && (!lastContactedDate || new Date(noteDate) > new Date(lastContactedDate))) {
          lastContactedDate = noteDate;
        }
      }
      if (lastContactedDate) {
        try {
          lastContactedDays = Math.floor((Date.now() - new Date(lastContactedDate).getTime()) / (1000 * 60 * 60 * 24));
        } catch { /* ignore */ }
      }

      // Detect "Replied - Paused" tag for hot reply pinning
      const personTags: string[] = (person.tags || []).map((t: string) => t);
      const personTagsLower = personTags.map(t => t.toLowerCase());
      const isHotReply = personTagsLower.includes("replied - paused");

      // Engagement tier based on activity
      let engagementTier: 'engaged' | 'standard' | 'cold' = 'standard';
      if (lastInboundText || lastContactedDays <= 3) {
        engagementTier = 'engaged';
      } else if (lastContactedDays > 7 || (!lastContactedDate && daysStale > 7)) {
        engagementTier = 'cold';
      }

      // Determine last contact type from notes/texts
      let lastContactType = '';
      if (lastInboundText) {
        lastContactType = 'their text';
      } else if (textsResult.status === 'fulfilled') {
        const msgs: any[] = textsResult.value.textMessages || [];
        const outbound = msgs.find((m: any) => m.isIncoming === false || m.direction === 'outbound');
        if (outbound) lastContactType = 'your text';
      }
      if (!lastContactType && notesResult.status === 'fulfilled') {
        const notesArr: any[] = notesResult.value.notes || [];
        const latestNote = notesArr[0];
        if (latestNote) {
          const subj = (latestNote.subject || '').toLowerCase();
          if (subj.includes('email') || subj.includes('nurture')) lastContactType = 'bot email';
          else if (subj.includes('call')) lastContactType = 'your call';
          else lastContactType = 'your text';
        }
      }

      return {
        id: leadId,
        name: fullName,
        phone: phoneVal,
        stage: person.stage || "Lead",
        city: "Texas",
        days_stale: daysStale,
        sms_body: smsBody,
        sms_link: smsLink,
        assigned_agent: agentFirst,
        assigned_agent_id: Number(assignedUserId),
        notes: leadNotes,
        last_inbound_text: lastInboundText,
        last_contacted: lastContactedDate,
        last_contacted_days: lastContactedDays,
        is_priority: daysStale >= 14,
        is_hot_reply: isHotReply,
        reply_date: isHotReply ? (lastContactedDate || '') : '',
        engagement_tier: engagementTier,
        tags: personTags,
        last_contact_type: lastContactType,
      } as PendingQueueItem;
    })
  );

  const fulfilledItems = enriched
    .filter((r): r is PromiseFulfilledResult<PendingQueueItem> => r.status === "fulfilled")
    .map(r => r.value)
    .filter(item => !EXCLUDED_AGENTS.has(item.assigned_agent.toLowerCase()));

  // Remove leads already texted today via Power Queue — DB-backed, survives restarts
  const sentTodaySet = await getSmsSentTodayIds();
  // Also update local cache so wasSmsSentToday() stays in sync
  _localSentSet = sentTodaySet;

  // Power Queue 2.0: Remove snoozed leads from the queue
  const activeSnoozes = await getAllActiveSnoozes();

  const queue = fulfilledItems.filter(item => !sentTodaySet.has(item.id) && !activeSnoozes.has(item.id));

  // Sort: hot reply leads FIRST ("Replied - Paused" tag), then priority (14-20 days),
  // then recent (1-13 days). Within each group sort by days_stale descending.
  queue.sort((a, b) => {
    // Hot reply leads always pin to the very top
    if (a.is_hot_reply !== b.is_hot_reply) return a.is_hot_reply ? -1 : 1;
    // Then priority leads (14-20 days)
    if (a.is_priority !== b.is_priority) return a.is_priority ? -1 : 1;
    // Within each group, most overdue first
    return b.days_stale - a.days_stale;
  });

  queueCache = { data: queue, ts: Date.now() };

  // Server-side agent enforcement: when agentFilter is provided, only return
  // leads assigned to that specific agent. The full queue is still cached so
  // other agents' requests remain fast. Case-insensitive match.
  if (agentFilter && agentFilter.trim()) {
    const normalized = agentFilter.trim().toLowerCase();
    return queue.filter(item => item.assigned_agent.toLowerCase() === normalized);
  }

  return queue;
}

// ── Agent-specific lead fetch ──────────────────────────────────────────────────
// Tiers: "do_now" = 14-20 days stale, "hot_prospect" = stage "Hot Prospect",
//        "your_leads" = everything else assigned to this agent
export type LeadTier = "do_now" | "hot_prospect" | "your_leads";

export interface AgentLead extends PendingQueueItem {
  tier: LeadTier;
}

// Per-agent cache: keyed by lower-case agent first name
const agentLeadCache: Record<string, { data: AgentLead[]; ts: number }> = {};

export async function getAgentLeads(fubApiKey: string, agentFirstName: string): Promise<AgentLead[]> {
  if (!fubApiKey) return [];
  const cacheKey = agentFirstName.toLowerCase();
  const cached = agentLeadCache[cacheKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  // Fetch FUB users to map agent name → userId
  const usersData = await fubGet("/users?limit=50", fubApiKey);
  const usersArr: any[] = usersData.users || [];
  const usersMap: Record<number, { name: string; firstName: string }> = {};
  let targetUserId: number | null = null;
  for (const u of usersArr) {
    if (u.id) {
      usersMap[Number(u.id)] = { name: u.name || "", firstName: u.firstName || "" };
      const fName = (u.firstName || u.name || "").trim().split(/\s+/)[0].toLowerCase();
      if (fName === agentFirstName.toLowerCase()) targetUserId = Number(u.id);
    }
  }
  if (!targetUserId) return [];

  // Fetch leads assigned to this agent using created date (NOT lastActivity).
  // lastActivity resets every time the bot emails a lead, causing year-old leads to
  // appear as fresh. We use createdBefore/createdAfter to scope to the 0-20 day window.
  // Leads older than 20 days are handled by the auto-pond promotion job.
  const allPeople: any[] = [];
  const pageSize = 100;
  const MS_PER_DAY_AL = 1000 * 60 * 60 * 24;
  const cutoffCreatedAfter = new Date(Date.now() - 20 * MS_PER_DAY_AL).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Fetch leads created in the last 20 days for this agent
  let offset = 0;
  while (allPeople.length < 300) {
    const page = await fubGet(
      `/people?limit=${pageSize}&offset=${offset}&assignedUserId=${targetUserId}&createdAfter=${cutoffCreatedAfter}&sort=-created`,
      fubApiKey
    );
    const batch: any[] = page.people || [];
    allPeople.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
    if (offset >= 1900) break; // FUB rejects offset >= 2000
  }

  // Filter out suppressed/excluded leads
  const eligible = allPeople.filter(person => {
    if (person.assignedPondId) return false;
    const stage = String(person.stage || "").toLowerCase();
    if (EXCLUDED_STAGES.has(stage)) return false;
    const tags: string[] = (person.tags || []).map((t: string) => t.toLowerCase());
    if (tags.some(t => EXCLUDED_TAGS.has(t))) return false;
    const phones: any[] = person.phones || [];
    const phoneVal: string | null = phones[0]?.value || phones[0]?.phone || null;
    if (!phoneVal) return false;
    return true;
  });

  // Enrich in parallel (cap at 150 to keep response time reasonable)
  const capped = eligible.slice(0, 150);
  const enriched = await Promise.allSettled(
    capped.map(async (person): Promise<AgentLead> => {
      const phones: any[] = person.phones || [];
      const phoneVal: string = phones[0]?.value || phones[0]?.phone || "";
      const agentUser = usersMap[targetUserId!] || { name: agentFirstName, firstName: agentFirstName };
      const agentFirst = agentUser.firstName || agentUser.name.split(" ")[0] || agentFirstName;
      const leadId: number = person.id;

      const tc = (s: string) =>
        s.toLowerCase().split(/\s+/).map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      const rawFirst = person.firstName || "";
      const rawLast = person.lastName || "";
      const firstName = rawFirst ? tc(rawFirst.trim().split(/\s+/)[0]) : "there";
      const tcFirst = rawFirst ? tc(rawFirst) : "";
      const tcLast = rawLast ? tc(rawLast) : "";
      const fullName = tcFirst && tcLast && tcLast !== tcFirst
        ? `${tcFirst} ${tcLast}`.trim()
        : tcFirst || tcLast || "Unknown";

      // daysStale = days since lead was CREATED (entered the system).
      // We do NOT use lastActivity — it resets on every bot email.
      let daysStale = 0;
      const createdStrAL: string | null = person.created || null;
      if (createdStrAL) {
        try {
          const createdDateAL = new Date(createdStrAL);
          daysStale = Math.floor((Date.now() - createdDateAL.getTime()) / (1000 * 60 * 60 * 24));
        } catch { /* ignore */ }
      }

      const smsBody = generatePersonalizedSms(firstName, "Texas", daysStale, daysStale > 7, String(leadId));
      const smsLink = makeSmsUri(phoneVal, smsBody, agentFirst, String(leadId));

      const [notesResult, textsResult] = await Promise.allSettled([
        fubGet(`/notes?personId=${leadId}&limit=3`, fubApiKey),
        fubGet(`/textMessages?personId=${leadId}&limit=20`, fubApiKey),
      ]);

      let leadNotes = "";
      if (notesResult.status === "fulfilled") {
        const notesArr: any[] = notesResult.value.notes || [];
        leadNotes = notesArr.slice(0, 3)
          .map((n: any) => (n.body || n.subject || "").trim().slice(0, 200))
          .filter(Boolean).join(" | ");
      }

      let lastInboundText = "";
      let lastContactedDate = "";
      let lastContactedDays = 0;
      if (textsResult.status === "fulfilled") {
        const msgs: any[] = textsResult.value.textMessages || [];
        const inbound = msgs.find((m: any) => m.isIncoming === true || m.direction === "inbound");
        lastInboundText = inbound?.message || inbound?.body || "";
        // Find most recent OUTBOUND text (agent → lead)
        const outbound = msgs.find((m: any) => m.isIncoming === false || m.direction === "outbound");
        if (outbound?.createdAt || outbound?.created) {
          lastContactedDate = outbound.createdAt || outbound.created || "";
        }
      }
      // Also check notes for a more recent outbound contact timestamp
      if (notesResult.status === "fulfilled") {
        const notesArr: any[] = notesResult.value.notes || [];
        const latestNote = notesArr[0]; // FUB returns newest first
        const noteDate = latestNote?.createdAt || latestNote?.created || "";
        if (noteDate && (!lastContactedDate || new Date(noteDate) > new Date(lastContactedDate))) {
          lastContactedDate = noteDate;
        }
      }
      if (lastContactedDate) {
        try {
          lastContactedDays = Math.floor((Date.now() - new Date(lastContactedDate).getTime()) / (1000 * 60 * 60 * 24));
        } catch { /* ignore */ }
      }

      // Classify tier based on days since CREATED:
      // do_now: created 14-20 days ago (priority window — must text before they age out)
      // hot_prospect: FUB stage = "Hot Prospect" (regardless of age)
      // your_leads: created 0-13 days ago (fresh leads, text when do_now queue is clear)
      const stageRaw = String(person.stage || "").toLowerCase();
      let tier: LeadTier;
      if (stageRaw === "hot prospect") {
        tier = "hot_prospect";
      } else if (daysStale >= 14) {
        tier = "do_now";
      } else {
        tier = "your_leads";
      }

      // Detect "Replied - Paused" tag for hot reply pinning
      const personTags: string[] = (person.tags || []).map((t: string) => t);
      const personTagsLower = personTags.map(t => t.toLowerCase());
      const isHotReply = personTagsLower.includes("replied - paused");

      // Engagement tier based on activity
      let engagementTier: 'engaged' | 'standard' | 'cold' = 'standard';
      if (lastInboundText || lastContactedDays <= 3) {
        engagementTier = 'engaged';
      } else if (lastContactedDays > 7 || (!lastContactedDate && daysStale > 7)) {
        engagementTier = 'cold';
      }

      // Determine last contact type
      let lastContactType = '';
      if (lastInboundText) lastContactType = 'their text';
      else if (lastContactedDate) lastContactType = 'your text';

      return {
        id: leadId,
        name: fullName,
        phone: phoneVal,
        stage: person.stage || "Lead",
        city: "Texas",
        days_stale: daysStale,
        sms_body: smsBody,
        sms_link: smsLink,
        assigned_agent: agentFirst,
        assigned_agent_id: targetUserId!,
        notes: leadNotes,
        last_inbound_text: lastInboundText,
        last_contacted: lastContactedDate,
        last_contacted_days: lastContactedDays,
        is_priority: daysStale >= 14,
        is_hot_reply: isHotReply,
        reply_date: isHotReply ? (lastContactedDate || '') : '',
        engagement_tier: engagementTier,
        tags: personTags,
        last_contact_type: lastContactType,
        tier,
      };
    })
  );
  const leads: AgentLead[] = enriched
    .filter((r): r is PromiseFulfilledResult<AgentLead> => r.status === "fulfilled")
    .map(r => r.value)
    .sort((a, b) => {
      // Sort order: do_now first, then hot_prospect, then your_leads; within tier by days_stale desc
      const tierOrder: Record<LeadTier, number> = { do_now: 0, hot_prospect: 1, your_leads: 2 };
      const tDiff = tierOrder[a.tier] - tierOrder[b.tier];
      if (tDiff !== 0) return tDiff;
      return b.days_stale - a.days_stale;
    });

  agentLeadCache[cacheKey] = { data: leads, ts: Date.now() };
  return leads;
}

// ── Agent Roster ─────────────────────────────────────────────────────────────
// Returns a summary for all 6 active agents in one parallel call.
export interface AgentRosterEntry {
  name: string;          // display name e.g. "Steven"
  slug: string;          // route slug e.g. "steven"
  role: string;          // e.g. "Austin"
  total: number;
  do_now: number;
  hot_prospect: number;
  your_leads: number;
  never_contacted: number;
  avg_days_stale: number;
  last_active_lead_days: number | null; // days since most recently stale lead was touched
}

// ROSTER_AGENTS is now dynamic — built from FUB users via agentRegistry.ts
// Golden Rule: adding a new agent to FUB automatically propagates here with zero code changes.

export async function getAgentRoster(fubApiKey: string): Promise<AgentRosterEntry[]> {
  // Serve from cache if fresh
  if (rosterCache && Date.now() - rosterCache.ts < ROSTER_CACHE_TTL_MS) {
    return rosterCache.data;
  }

  // Fetch FUB users once to build name → userId map
  const usersData = await fubGet("/users?limit=50", fubApiKey);
  const usersArr: any[] = usersData.users || [];
  const nameToId: Record<string, number> = {};
  for (const u of usersArr) {
    if (u.id) {
      const fName = (u.firstName || u.name || "").trim().split(/\s+/)[0].toLowerCase();
      nameToId[fName] = Number(u.id);
    }
  }

  // Fetch the Lead Pond ID dynamically so we can exclude pond leads from agent counts.
  // Pond leads are already being nurtured by the automation — they should NOT appear
  // in an agent's Do Now / Hot / Pipeline counts.
  let pondId: number | null = null;
  try {
    const pondsData = await fubGet("/ponds?limit=50", fubApiKey);
    const ponds: any[] = pondsData.ponds || [];
    if (ponds.length > 0) pondId = Number(ponds[0].id); // Lead Pond is always first
  } catch { /* ponds endpoint unavailable — skip pond filter */ }

  // Cutoff for "Do Now" = 14+ days since last activity
  const cutoff14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0] + "T00:00:00Z";

  // Fetch each agent sequentially with a 1.5s stagger.
  // Each agent makes 4 fast metadata-only FUB calls (limit=1) for exact counts.
  // Dynamic: build roster from FUB users via agentRegistry (Golden Rule)
  const ROSTER_AGENTS = getRosterAgents(await getActiveAgents(fubGet, fubApiKey));
  const roster: AgentRosterEntry[] = [];
  for (const agent of ROSTER_AGENTS) {
    const uid = nameToId[agent.name.toLowerCase()];
    if (!uid) {
      console.warn(`[getRoster] Agent "${agent.name}" not found in FUB users`);
      roster.push({ name: agent.name, slug: agent.slug, role: agent.role,
        total: 0, do_now: 0, hot_prospect: 0, your_leads: 0,
        never_contacted: 0, avg_days_stale: 0, last_active_lead_days: null });
      continue;
    }

    // Per-agent retry loop — FUB occasionally has transient connect timeouts.
    // Retry up to 2 times with a 3s pause before falling back to zeros.
    let agentSuccess = false;
    for (let agentAttempt = 0; agentAttempt <= 2; agentAttempt++) {
      if (agentAttempt > 0) {
        console.warn(`[getRoster] Retrying "${agent.name}" (attempt ${agentAttempt + 1}/3) after 3s...`);
        await new Promise(r => setTimeout(r, 3000));
      }
      try {
        // Pond leads are excluded from all tier counts (they're in the automation nurture loop).
        // FUB doesn't support assignedPondId=null filter directly, so we fetch counts
        // WITH and WITHOUT pond filter and subtract to get personal-only counts.

        // 1. Total personal leads (not in pond)
        const totalRes = await fubGet(`/people?limit=1&assignedUserId=${uid}`, fubApiKey);
        const totalAll: number = totalRes._metadata?.total ?? 0;

        // 2. Leads in pond (to subtract from total for personal count)
        let inPondCount = 0;
        if (pondId) {
          const pondRes = await fubGet(`/people?limit=1&assignedUserId=${uid}&assignedPondId=${pondId}`, fubApiKey);
          inPondCount = pondRes._metadata?.total ?? 0;
        }
        const total = Math.max(0, totalAll - inPondCount);

        // 3. Do Now: stale 14+ days total
        const doNowAllRes = await fubGet(
          `/people?limit=1&assignedUserId=${uid}&lastActivityBefore=${cutoff14}`,
          fubApiKey
        );
        const doNowAll: number = doNowAllRes._metadata?.total ?? 0;

        // 4. Stale leads that are in pond (to subtract — pond handles their nurture)
        let doNowInPond = 0;
        if (pondId) {
          const doNowPondRes = await fubGet(
            `/people?limit=1&assignedUserId=${uid}&assignedPondId=${pondId}&lastActivityBefore=${cutoff14}`,
            fubApiKey
          );
          doNowInPond = doNowPondRes._metadata?.total ?? 0;
        }
        // Subtract leads already texted today via Power Queue — they no longer need action
        // We don't know which smsSentToday leads belong to this agent, so we count all of them
        // that are in the do_now bucket by checking the set size as a best-effort adjustment.
        // The roster re-fetches from FUB after 10 min anyway, which will reflect the real count.
        const smsSentTodayAdjustment = await getSmsSentTodayCount();
        const do_now = Math.max(0, doNowAll - doNowInPond - smsSentTodayAdjustment);

        // 5. Hot Prospect stage count (personal — not in pond)
        const hotAllRes = await fubGet(
          `/people?limit=1&assignedUserId=${uid}&stage=${encodeURIComponent("Hot Prospect")}`,
          fubApiKey
        );
        let hot_prospect: number = hotAllRes._metadata?.total ?? 0;
        if (pondId) {
          const hotPondRes = await fubGet(
            `/people?limit=1&assignedUserId=${uid}&assignedPondId=${pondId}&stage=${encodeURIComponent("Hot Prospect")}`,
            fubApiKey
          );
          hot_prospect = Math.max(0, hot_prospect - (hotPondRes._metadata?.total ?? 0));
        }

        // Pipeline = personal leads that are neither stale (do_now) nor hot
        const your_leads = Math.max(0, total - do_now - hot_prospect);

        console.log(`[getRoster] ${agent.name}: personal=${total}(pond=${inPondCount}), do_now=${do_now}, hot=${hot_prospect}, pipeline=${your_leads}`);

        roster.push({
          name: agent.name,
          slug: agent.slug,
          role: agent.role,
          total,
          do_now,
          hot_prospect,
          your_leads,
          never_contacted: 0,
          avg_days_stale: 0,
          last_active_lead_days: null,
        });
        agentSuccess = true;
        break; // success — move to next agent
      } catch (err) {
        console.error(`[getRoster] Agent "${agent.name}" attempt ${agentAttempt + 1} failed:`, (err as Error).message);
        if (agentAttempt === 2) {
          // All retries exhausted — push zero-state so agent card still appears
          console.error(`[getRoster] All retries exhausted for "${agent.name}" — showing zero counts`);
          roster.push({
            name: agent.name, slug: agent.slug, role: agent.role,
            total: 0, do_now: 0, hot_prospect: 0, your_leads: 0,
            never_contacted: 0, avg_days_stale: 0, last_active_lead_days: null,
          });
        }
      }
    }

    // 1.5s stagger between agents to stay under FUB rate limits
    if (ROSTER_AGENTS.indexOf(agent) < ROSTER_AGENTS.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Cache the result
  rosterCache = { data: roster, ts: Date.now() };
  return roster;
}

// ── Pond Leads — SMS Only ──────────────────────────────────────────────────
// Returns pond leads tagged "bad-email" that have a valid phone number.
// These are leads whose email bounced but still have a working phone —
// they need SMS outreach via Peter's Power Queue.
export interface PondSmsLead {
  id: number;
  name: string;
  phone: string;
  stage: string;
  days_in_pond: number;
  notes: string;
  sms_body: string;
  sms_link: string;
}

let pondSmsCache: { data: PondSmsLead[]; ts: number } | null = null;
const POND_SMS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function clearPondSmsCache() { pondSmsCache = null; }

export async function getPondSmsOnlyLeads(fubApiKey: string): Promise<PondSmsLead[]> {
  if (!fubApiKey) return [];
  if (pondSmsCache && Date.now() - pondSmsCache.ts < POND_SMS_CACHE_TTL_MS) {
    return pondSmsCache.data;
  }

  // Fetch pond leads tagged "bad-email" from FUB
  // These are leads that bounced but have a phone number
  const PAGE_SIZE = 100;
  const allPeople: any[] = [];
  let offset = 0;

  while (true) {
    await new Promise(r => setTimeout(r, 400));
    try {
      const data = await fubGet(
        `/people?limit=${PAGE_SIZE}&offset=${offset}&sort=-created&tag=${encodeURIComponent("bad-email")}`,
        fubApiKey
      );
      const page = data.people || [];
      if (page.length === 0) break;
      allPeople.push(...page);
      if (page.length < PAGE_SIZE || offset >= 1900) break;
      offset += PAGE_SIZE;
    } catch (e) {
      console.warn(`[getPondSmsOnlyLeads] Fetch failed at offset=${offset}:`, e);
      break;
    }
  }

  // Filter: must have a valid phone, must not be in excluded stages
  const EXCLUDED_SMS_STAGES = new Set(["trash", "closed", "pending", "under contract"]);
  const eligible = allPeople.filter(person => {
    const phones: any[] = person.phones || [];
    const phoneVal = phones[0]?.value || phones[0]?.phone || null;
    if (!phoneVal) return false;
    const digits = (phoneVal as string).replace(/\D/g, "");
    if (digits.length < 10) return false;
    const stage = String(person.stage || "").toLowerCase();
    if (EXCLUDED_SMS_STAGES.has(stage)) return false;
    return true;
  });

  // Enrich with SMS body and notes
  const enriched = await Promise.allSettled(
    eligible.slice(0, 50).map(async (person) => { // Cap at 50 to avoid rate limits
      const leadId = person.id;
      const phones: any[] = person.phones || [];
      const phoneVal: string = phones[0]?.value || phones[0]?.phone || "";
      const rawFirst: string = person.firstName || "";
      const rawLast: string = person.lastName || "";
      const tc = (s: string) =>
        s.toLowerCase().split(/\s+/).map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      const firstName = rawFirst ? tc(rawFirst.trim().split(/\s+/)[0]) : "there";
      const fullName = rawFirst && rawLast
        ? `${tc(rawFirst)} ${tc(rawLast)}`.trim()
        : tc(rawFirst || rawLast || "Unknown");

      // Calculate days in pond (from created date)
      let daysInPond = 30;
      const createdStr = person.created || null;
      if (createdStr) {
        try {
          daysInPond = Math.floor((Date.now() - new Date(createdStr).getTime()) / (1000 * 60 * 60 * 24));
        } catch { /* ignore */ }
      }

      const smsBody = generatePersonalizedSms(firstName, "Texas", daysInPond, true, String(leadId));
      const smsLink = makeSmsUri(phoneVal, smsBody, "Peter", String(leadId));

      // Fetch notes
      let leadNotes = "";
      try {
        const notesData = await fubGet(`/notes?personId=${leadId}&limit=3`, fubApiKey);
        const notesArr: any[] = notesData.notes || [];
        leadNotes = notesArr
          .slice(0, 3)
          .map((n: any) => (n.body || n.subject || "").trim().slice(0, 200))
          .filter(Boolean)
          .join(" | ");
      } catch { /* ignore */ }

      return {
        id: leadId,
        name: fullName,
        phone: phoneVal,
        stage: person.stage || "Lead",
        days_in_pond: daysInPond,
        notes: leadNotes,
        sms_body: smsBody,
        sms_link: smsLink,
      } as PondSmsLead;
    })
  );

  const results = enriched
    .filter((r): r is PromiseFulfilledResult<PondSmsLead> => r.status === "fulfilled")
    .map(r => r.value)
    .sort((a, b) => b.days_in_pond - a.days_in_pond); // Most stale first

  pondSmsCache = { data: results, ts: Date.now() };
  return results;
}
