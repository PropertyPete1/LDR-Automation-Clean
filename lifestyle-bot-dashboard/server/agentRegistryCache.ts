/**
 * Dynamic Agent Registry Cache
 * 
 * Single source of truth for agent metadata. Replaces all hardcoded maps
 * (POWER_QUEUE_AGENT_NAME, AGENT_DASHBOARD_SLUG, LEADER_AGENTS, ALL_BOTS)
 * with a cached query against the agent_bots table.
 * 
 * Cache is refreshed once per "run" (max every 60s) so a new agent added
 * via the Admin UI propagates everywhere within one minute, zero code changes.
 */

import { getDb } from "./db";

export interface AgentRegistryEntry {
  id: number;
  botSlug: string;
  botName: string;
  agentFirstName: string;
  agentLastName: string;
  agentEmail: string;
  fubUserId: number;
  powerQueueName: string | null;
  accentColor: string;
  headerGradient: string;
  engineActive: boolean;
}

let _cache: AgentRegistryEntry[] | null = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Get all agent_bots rows (cached for 60s).
 * Call this instead of hardcoded maps.
 */
export async function getAgentRegistry(): Promise<AgentRegistryEntry[]> {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL_MS) return _cache;

  const db = await getDb();
  if (!db) return _cache ?? [];

  try {
    const { agentBots } = await import("../drizzle/schema");
    const rows = await db.select().from(agentBots).orderBy(agentBots.id);
    _cache = rows.map(r => ({
      id: r.id,
      botSlug: r.botSlug,
      botName: r.botName,
      agentFirstName: r.agentFirstName,
      agentLastName: r.agentLastName,
      agentEmail: r.agentEmail,
      fubUserId: r.fubUserId,
      powerQueueName: r.powerQueueName,
      accentColor: r.accentColor,
      headerGradient: r.headerGradient,
      engineActive: r.engineActive,
    }));
    _cacheTime = now;
    return _cache;
  } catch (err) {
    console.error("[AgentRegistryCache] Failed to refresh:", err);
    return _cache ?? [];
  }
}

/** Force-clear the cache (useful after admin mutations) */
export function invalidateAgentRegistryCache(): void {
  _cache = null;
  _cacheTime = 0;
}

// ─── Derived lookups (replace hardcoded maps) ─────────────────────────────────

/**
 * Get the Power Queue agent name for a given bot slug or agent first name.
 * Replaces POWER_QUEUE_AGENT_NAME map.
 */
export async function getPowerQueueName(slugOrName: string): Promise<string | null> {
  const registry = await getAgentRegistry();
  const key = slugOrName.toLowerCase();
  // Try matching by slug first, then by agentFirstName
  const match = registry.find(r => r.botSlug === key || r.agentFirstName.toLowerCase() === key);
  if (!match) return null;
  // powerQueueName override takes priority, else use agentFirstName
  return match.powerQueueName || match.agentFirstName;
}

/**
 * Get the dashboard slug for a given agent first name.
 * Replaces AGENT_DASHBOARD_SLUG map.
 */
export async function getDashboardSlug(agentFirstName: string): Promise<string | null> {
  const registry = await getAgentRegistry();
  const key = agentFirstName.toLowerCase();
  const match = registry.find(r => r.agentFirstName.toLowerCase() === key || r.botSlug === key);
  return match?.botSlug ?? null;
}

/**
 * Check if an agent is a "leader" (gets full dashboard access).
 * Replaces LEADER_AGENTS set.
 * Leaders are defined as: Peter, Steven, Stefanie (hardcoded for now since this is a business rule,
 * not an agent-count issue — but could be a column in the future).
 */
const LEADER_NAMES = new Set(["peter", "steven", "stefanie"]);
export function isLeaderAgent(agentFirstName: string): boolean {
  return LEADER_NAMES.has(agentFirstName.toLowerCase());
}

/**
 * Get all bots for the Bot Monitor (replaces ALL_BOTS array).
 * Returns all registered agents regardless of engineActive status.
 */
export async function getAllBotsForMonitor(): Promise<Array<{ slug: string; name: string }>> {
  const registry = await getAgentRegistry();
  return registry.map(r => ({ slug: r.botSlug, name: r.botName }));
}

/**
 * Get the public agent list for client-side consumption (Power Queue dropdown, etc.)
 * Returns only the fields needed by the UI.
 */
export async function getPublicAgentList(): Promise<Array<{
  slug: string;
  firstName: string;
  lastName: string;
  botName: string;
  accentColor: string;
  headerGradient: string;
  powerQueueName: string;
}>> {
  const registry = await getAgentRegistry();
  return registry.map(r => ({
    slug: r.botSlug,
    firstName: r.agentFirstName,
    lastName: r.agentLastName,
    botName: r.botName,
    accentColor: r.accentColor,
    headerGradient: r.headerGradient,
    powerQueueName: r.powerQueueName || r.agentFirstName,
  }));
}
