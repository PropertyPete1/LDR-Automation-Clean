/**
 * queueAccess.ts — Shared access-control decision function for the entire tRPC surface.
 *
 * Every procedure calls resolveQueueAccess() to determine if the caller is:
 * - admin (valid POWER_QUEUE_ADMIN_TOKEN) → full access
 * - agent (valid ?agent= param matching the live FUB roster) → scoped access
 * - denied (neither) → rejected
 *
 * For PII reads (notes, SMS, lead data), agent access additionally requires
 * that the requested personId is assigned to that agent (ownership check via FUB API).
 */
import { TRPCError } from "@trpc/server";
import { ENV } from "./_core/env";
import { getActiveAgents, type AgentEntry } from "./agentRegistry";

// ── Types ────────────────────────────────────────────────────────────────────
export type AccessResult =
  | { type: "admin" }
  | { type: "agent"; agentName: string; fubUserId: number }
  | { type: "denied" };

export interface AccessInput {
  adminToken?: string | null;
  agent?: string | null;
}

// ── Core decision function ───────────────────────────────────────────────────
/**
 * Resolve access from URL-derived params. Pure logic — no DB or FUB calls
 * beyond the cached agent registry.
 */
export async function resolveQueueAccess(input: AccessInput): Promise<AccessResult> {
  // Admin path: valid token → full access
  if (
    input.adminToken &&
    ENV.powerQueueAdminToken &&
    input.adminToken === ENV.powerQueueAdminToken
  ) {
    return { type: "admin" };
  }

  // Agent path: valid agent name against live roster
  if (input.agent) {
    const agents = await getActiveAgents(undefined, ENV.fubApiKey);
    const matched = agents.find(
      (a) =>
        a.slug === input.agent!.toLowerCase() ||
        a.name.toLowerCase() === input.agent!.toLowerCase()
    );
    if (matched) {
      return { type: "agent", agentName: matched.name, fubUserId: matched.fubUserId };
    }
  }

  return { type: "denied" };
}

// ── Guard helpers (throw TRPCError on denied) ────────────────────────────────

/**
 * Require admin access. Throws UNAUTHORIZED if not admin.
 */
export async function requireAdmin(input: AccessInput): Promise<void> {
  const access = await resolveQueueAccess(input);
  if (access.type !== "admin") {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Admin token required" });
  }
}

/**
 * Require admin OR agent access. Returns the resolved access.
 * Throws UNAUTHORIZED if denied.
 */
export async function requireAdminOrAgent(input: AccessInput): Promise<AccessResult> {
  const access = await resolveQueueAccess(input);
  if (access.type === "denied") {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Valid agent or admin token required" });
  }
  return access;
}

// ── Person Ownership Cache ───────────────────────────────────────────────────
/**
 * 10-minute TTL cache: personId → FUB assignedUserId (number).
 * Keeps the queue snappy by avoiding repeated FUB lookups for the same person.
 */
const personOwnerCache = new Map<number, { assignedUserId: number | null; ts: number }>();
const PERSON_OWNER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch the assignedUserId for a person from FUB, with 10-minute cache.
 * Returns the FUB user ID of the assigned agent, or null if unassigned/not found.
 */
export async function getPersonAssignedUserId(personId: number): Promise<number | null> {
  // Check cache first
  const cached = personOwnerCache.get(personId);
  if (cached && Date.now() - cached.ts < PERSON_OWNER_CACHE_TTL_MS) {
    return cached.assignedUserId;
  }

  const apiKey = ENV.fubApiKey;
  if (!apiKey) return null;

  try {
    const credentials = Buffer.from(`${apiKey}:`).toString("base64");
    const res = await fetch(`https://api.followupboss.com/v1/people/${personId}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${credentials}`,
      },
    });

    if (!res.ok) {
      // Person not found or API error — cache as null to avoid hammering
      personOwnerCache.set(personId, { assignedUserId: null, ts: Date.now() });
      return null;
    }

    const data = await res.json();
    const assignedUserId = data.assignedUserId ? Number(data.assignedUserId) : null;
    personOwnerCache.set(personId, { assignedUserId, ts: Date.now() });
    return assignedUserId;
  } catch {
    // Network error — don't cache, let it retry next time
    return null;
  }
}

/** Clear the person-owner cache (useful for tests). */
export function clearPersonOwnerCache(): void {
  personOwnerCache.clear();
}

// ── True Ownership Verification ──────────────────────────────────────────────
/**
 * Require agent-level access AND verify that the given personId belongs to
 * that agent. Admin always passes. Agent must own the lead.
 *
 * This performs a real FUB API lookup (cached 10 min) to verify the person's
 * assignedUserId matches the agent's fubUserId from the roster.
 *
 * Throws UNAUTHORIZED if:
 * - No valid access context (no agent, no admin token)
 * - Agent is valid but personId is NOT assigned to them
 */
export async function requirePersonOwnership(
  input: AccessInput,
  personId: number
): Promise<AccessResult> {
  const access = await resolveQueueAccess(input);

  if (access.type === "denied") {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Valid agent or admin token required" });
  }

  // Admin bypasses ownership check
  if (access.type === "admin") {
    return access;
  }

  // Agent: verify the personId is assigned to this agent
  const assignedUserId = await getPersonAssignedUserId(personId);

  if (assignedUserId === null) {
    // Person not found in FUB or unassigned — reject for safety
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Lead not found or not assigned to any agent",
    });
  }

  if (assignedUserId !== access.fubUserId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Lead is not assigned to your queue",
    });
  }

  return access;
}

/**
 * Legacy alias — kept for backward compatibility with tests that reference it.
 * Now delegates to requireAdminOrAgent (for procedures without a personId).
 * For per-person procedures, use requirePersonOwnership() instead.
 */
export async function requireAgentContext(input: AccessInput): Promise<AccessResult> {
  return requireAdminOrAgent(input);
}

// ── Zod fragments for reuse in procedure inputs ──────────────────────────────
import { z } from "zod";

/** Standard access fields to merge into any procedure input */
export const accessFields = {
  adminToken: z.string().optional(),
  agent: z.string().optional(),
};
// ownership verification deployed 2026-07-22T03:34:32Z
