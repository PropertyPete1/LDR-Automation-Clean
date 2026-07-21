/**
 * agentRegistry.ts — Dynamic agent registry for the nurture-dashboard.
 * 
 * Replaces all hardcoded agent name arrays (ROSTER_AGENTS, AGENT_FIRST_NAMES,
 * AGENT_ROSTER_MAP, AGENT_MAP, ROSTER) with dynamic FUB-driven lookups.
 * 
 * Golden Rule: Adding a new agent to FUB automatically propagates everywhere
 * with ZERO code changes.
 * 
 * Architecture:
 * - Fetches FUB users via the FUB API
 * - Filters out EXCLUDED_AGENTS (luke, bebe) and readonly/inactive users
 * - Caches for 10 minutes (same TTL as roster cache)
 * - Provides helpers used by dashboardData.ts, routers.ts, and client pages
 */
import { ENV } from "./_core/env";

const FUB_BASE = "https://api.followupboss.com/v1";

// Agents permanently removed from the active roster — never show in any UI
const EXCLUDED_AGENTS = new Set(["luke", "bebe"]);

// FUB user roles that indicate non-agent accounts
const EXCLUDED_FUB_ROLES = new Set(["readonly"]);

export interface AgentEntry {
  name: string;       // Display name (first name) e.g. "Peter"
  slug: string;       // URL slug e.g. "peter"
  role: string;       // Market/title e.g. "Agent" (cosmetic)
  fubUserId: number;  // FUB user ID
}

// In-memory cache
let registryCache: { data: AgentEntry[]; ts: number } | null = null;
const REGISTRY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Internal FUB GET helper (used when no external fubGet is provided).
 */
async function internalFubGet(path: string, apiKey: string): Promise<any> {
  const credentials = Buffer.from(`${apiKey}:`).toString("base64");
  const res = await fetch(`${FUB_BASE}${path}`, {
    headers: { Accept: "application/json", Authorization: `Basic ${credentials}` },
  });
  if (!res.ok) throw new Error(`FUB ${path} returned ${res.status}`);
  return res.json();
}

/**
 * Fetch the dynamic agent registry from FUB users.
 * Returns all active agents (excluding EXCLUDED_AGENTS and readonly users).
 * Accepts an optional fubGet function (for dashboardData.ts which has retry logic).
 */
export async function getActiveAgents(fubGet?: (path: string, apiKey: string) => Promise<any>, fubApiKey?: string): Promise<AgentEntry[]> {
  if (registryCache && Date.now() - registryCache.ts < REGISTRY_CACHE_TTL_MS) {
    return registryCache.data;
  }

  const apiKey = fubApiKey || ENV.fubApiKey;
  if (!apiKey) return [];
  const fetcher = fubGet || internalFubGet;

  const usersData = await fetcher("/users?limit=50", apiKey);
  const usersArr: any[] = usersData.users || [];

  const agents: AgentEntry[] = [];
  for (const u of usersArr) {
    if (!u.id) continue;
    const firstName = (u.firstName || u.name || "").trim().split(/\s+/)[0];
    const slug = firstName.toLowerCase();
    
    // Skip excluded agents
    if (EXCLUDED_AGENTS.has(slug)) continue;
    
    // Skip readonly/system accounts
    const fubRole = (u.role || "").toLowerCase();
    if (EXCLUDED_FUB_ROLES.has(fubRole)) continue;

    // Skip users without a proper email (system accounts)
    const email = (u.email || "").toLowerCase();
    if (!email || !email.includes("@")) continue;

    agents.push({
      name: firstName,
      slug,
      role: "Agent", // Generic role — the roster UI shows lead counts, not roles
      fubUserId: Number(u.id),
    });
  }

  registryCache = { data: agents, ts: Date.now() };
  return agents;
}

/**
 * Clear the registry cache (used when refreshing roster).
 */
export function clearRegistryCache(): void {
  registryCache = null;
}

/**
 * Known aliases: FUB sometimes exposes a user's middle/last name instead of their
 * display first name. This map catches those cases.
 * Key = alias (lowercase), Value = canonical slug.
 */
const AGENT_ALIASES: Record<string, string> = {
  maria: "laila", // Laila's FUB full name includes "Maria"
};

/**
 * Normalize an agent name to its canonical display form.
 * Handles aliases (e.g., "Maria" → "Laila") via AGENT_ALIASES map.
 * Falls back to title-casing the input if no match found.
 */
export function normalizeAgentName(raw: string, agents: AgentEntry[]): string {
  const lower = raw.trim().toLowerCase();
  // Check alias map first
  const aliasSlug = AGENT_ALIASES[lower];
  if (aliasSlug) {
    const aliased = agents.find(a => a.slug === aliasSlug);
    if (aliased) return aliased.name;
  }
  // Direct match by first name / slug
  const direct = agents.find(a => a.slug === lower || a.name.toLowerCase() === lower);
  if (direct) return direct.name;
  // Title-case fallback
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/**
 * Get agent first names for FUB user ID resolution.
 * Used by getPendingQueue to filter FUB users to active agents only.
 */
export function getAgentFirstNames(agents: AgentEntry[]): string[] {
  return agents.map(a => a.slug);
}

/**
 * Build the roster agents array (name, slug, role) for getAgentRoster().
 */
export function getRosterAgents(agents: AgentEntry[]): Array<{ name: string; slug: string; role: string }> {
  return agents.map(a => ({ name: a.name, slug: a.slug, role: a.role }));
}

/**
 * Get agent display names for the bot.getStatus ROSTER.
 * Always includes "Lifestyle Bot" as the last entry.
 */
export function getBotStatusRoster(agents: AgentEntry[]): string[] {
  return [...agents.map(a => a.name), "Lifestyle Bot"];
}
