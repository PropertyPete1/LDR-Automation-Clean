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
 * Normalize an agent name to its canonical display form.
 * Direct match by first name / slug against the dynamic roster; falls back to
 * title-casing if no match found.
 *
 * (No name aliases: "Maria" is Laila's LAST name, not a separate identity. Her
 * FUB record and agent_bots row both use firstName "Laila", so she resolves to
 * "Laila" natively — the old maria→laila alias was vestigial and was removed.)
 */
export function normalizeAgentName(raw: string, agents: AgentEntry[]): string {
  const lower = raw.trim().toLowerCase();
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

// ─── Power Queue access control ──────────────────────────────────────────────

/** FUB user IDs that always get the admin (all-agents) view: Steven=1, Peter=2. */
export const ADMIN_FUB_USER_IDS = new Set([1, 2]);

/** Dashboard login emails that always get the admin view (belt-and-suspenders). */
const ADMIN_EMAILS = new Set([
  "peter@lifestyledesignrealty.com",
  "steven@lifestyledesignrealty.com",
]);

export interface QueueViewer {
  /** Admin sees the full "All Agents" dropdown, heat chart, and every agent's leads. */
  isAdmin: boolean;
  /** For a non-admin agent, the canonical roster name they are locked to (else null). */
  agentName: string | null;
  /** The resolved FUB user id, when the caller maps to a roster agent. */
  fubUserId: number | null;
}

/**
 * Resolve the Power Queue viewer from the authenticated dashboard user.
 *
 * A caller is admin if their dashboard role is "admin", their login email is
 * Peter's/Steven's, OR they resolve to a roster agent with FUB id 1 or 2.
 * Otherwise they are a plain agent, locked to their own roster name — the
 * server uses this to force the lead filter so an agent can never see another
 * agent's leads (the client URL ?agent= param is advisory only).
 *
 * Pure and dependency-free so it is unit-testable without a DB or FUB.
 */
export function resolveQueueViewer(
  user: { email?: string | null; name?: string | null; role?: string | null } | null,
  agents: AgentEntry[]
): QueueViewer {
  if (!user) return { isAdmin: false, agentName: null, fubUserId: null };

  const email = (user.email ?? "").toLowerCase().trim();
  const emailLocal = email.split("@")[0];
  const nameFirst = (user.name ?? "").trim().toLowerCase().split(/\s+/)[0];

  // Match the caller to a roster agent by email local-part, slug, or first name.
  const matched =
    agents.find(a => a.slug === emailLocal) ??
    agents.find(a => a.slug === nameFirst) ??
    agents.find(a => a.name.toLowerCase() === nameFirst) ??
    null;

  const isAdmin =
    (user.role ?? "") === "admin" ||
    ADMIN_EMAILS.has(email) ||
    (matched != null && ADMIN_FUB_USER_IDS.has(matched.fubUserId));

  return {
    isAdmin,
    agentName: matched?.name ?? null,
    fubUserId: matched?.fubUserId ?? null,
  };
}

// ─── URL-param / admin-token access model (current — no login) ───────────────

export interface QueueAccess {
  /** The name to pass to getPendingQueue's agentFilter, or undefined = full queue.
   *  Sentinels: "__empty__" (no valid identity → return nothing),
   *  "__no_such_agent__" (agent param didn't match the roster → return nothing). */
  effectiveFilter: string | undefined;
  isAdmin: boolean;
  agentName: string | null;
}

/**
 * THE real Power Queue access decision, shared by every scoped procedure so
 * the behavior and its test can never drift (the test imports THIS function).
 *
 * Model (no login): identity comes from the URL.
 *  - ?admin=TOKEN (matching POWER_QUEUE_ADMIN_TOKEN) → admin; ?agent=all = full
 *    queue, or admin may filter to a specific agent.
 *  - ?agent=Name (valid roster name/slug, case-insensitive) → scoped to that
 *    agent only.
 *  - anything else (no params, agent=all without token, unknown agent) →
 *    an impossible/empty filter so the caller returns no leads.
 *
 * Pure and dependency-free (roster passed in) for exhaustive unit testing.
 */
export function resolveQueueAccess(
  input: { agentFilter?: string; adminToken?: string },
  configuredToken: string,
  agents: AgentEntry[]
): QueueAccess {
  const isAdmin = !!(input.adminToken && configuredToken && input.adminToken === configuredToken);

  if (isAdmin) {
    const filter = input.agentFilter === "all" ? undefined : input.agentFilter;
    return { effectiveFilter: filter, isAdmin: true, agentName: null };
  }

  // Non-admin: an agent param is REQUIRED and scopes the result.
  if (!input.agentFilter || input.agentFilter === "all") {
    return { effectiveFilter: "__empty__", isAdmin: false, agentName: null };
  }

  const matched = agents.find(
    a => a.slug === input.agentFilter!.toLowerCase() ||
         a.name.toLowerCase() === input.agentFilter!.toLowerCase()
  );
  return {
    effectiveFilter: matched ? matched.name : "__no_such_agent__",
    isAdmin: false,
    agentName: matched?.name ?? null,
  };
}

/** True iff the supplied admin token matches the configured one (non-empty). */
export function isAdminToken(adminToken: string | undefined, configuredToken: string): boolean {
  return !!(adminToken && configuredToken && adminToken === configuredToken);
}
