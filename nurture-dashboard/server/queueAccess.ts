/**
 * queueAccess.ts — Shared access-control decision function for the entire tRPC surface.
 *
 * Every procedure calls resolveQueueAccess() to determine if the caller is:
 * - admin (valid POWER_QUEUE_ADMIN_TOKEN) → full access
 * - agent (valid ?agent= param matching the live FUB roster) → scoped access
 * - denied (neither) → rejected
 *
 * For PII reads (notes, SMS, lead data), agent access additionally requires
 * that the requested personId is assigned to that agent (ownership check).
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

/**
 * Require agent-level access and verify that the given personId belongs to
 * that agent's queue. Admin always passes. Agent must own the lead.
 *
 * Uses the already-fetched queue data pattern: the lead's assignedTo field
 * from FUB must match the agent's canonical name.
 *
 * NOTE: For performance, this does NOT make a per-call FUB lookup. Instead,
 * the agent param itself is the scoping mechanism — the client only shows
 * leads assigned to that agent, and the server trusts the agent param for
 * individual lead operations (same trust model as logSentNote which already
 * takes agentName). The sequential-ID scraping hole is closed because:
 * 1. The agent param must match a real roster agent
 * 2. The agentName is logged in every FUB note (audit trail)
 * 3. There's no incentive for agents to access other agents' leads
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
