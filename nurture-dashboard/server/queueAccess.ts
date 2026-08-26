/**
 * queueAccess.ts — Shared access-control decision function for the entire tRPC surface.
 *
 * Every procedure calls resolveQueueAccess() to determine if the caller is:
 * - admin (valid POWER_QUEUE_ADMIN_TOKEN) → full access
 * - agent (?agent=Name&key=<per-agent secret> matching the live FUB roster
 *   AND that agent's key in POWER_QUEUE_AGENT_KEYS) → scoped access
 * - stale_link (roster-valid agent name but missing/invalid key — the shape of
 *   every pre-2026-08 emailed link) → rejected with a "get your new link" message
 * - denied (neither) → rejected
 *
 * A bare agent NAME stopped being an identity on 2026-08-26 (audit P0-3): a
 * guessable first name in a URL granted that agent's queue and lead PII. Every
 * agent link now carries a per-agent secret, compared in constant time.
 *
 * For PII reads (notes, SMS, lead data), agent access additionally requires
 * that the requested personId is assigned to that agent (ownership check via FUB API).
 */
import { TRPCError } from "@trpc/server";
import { createHash, timingSafeEqual } from "crypto";
import { ENV } from "./_core/env";
import { getActiveAgents, type AgentEntry } from "./agentRegistry";

// ── Types ────────────────────────────────────────────────────────────────────
export type AccessResult =
  | { type: "admin" }
  | { type: "agent"; agentName: string; fubUserId: number }
  | { type: "stale_link"; agentName: string }
  | { type: "denied" };

export interface AccessInput {
  adminToken?: string | null;
  agent?: string | null;
  key?: string | null;
}

// ── Token plumbing ───────────────────────────────────────────────────────────

/** Constant-time string comparison. Hashing first equalizes lengths so the
 * comparison leaks neither content nor length. */
export function tokensEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Valid admin token? Same POWER_QUEUE_ADMIN_TOKEN as always — only the
 * comparison changed (constant-time). Exposed so routers.ts's inline admin
 * checks stop re-implementing it. */
export function adminTokenIsValid(token: string | null | undefined): boolean {
  return !!(token && ENV.powerQueueAdminToken && tokensEqual(token, ENV.powerQueueAdminToken));
}

/**
 * Per-agent secrets from POWER_QUEUE_AGENT_KEYS, keyed by roster slug
 * (lowercase first name). Two formats:
 *   JSON:  {"stefanie":"tokA","laila":"tokB"}
 *   pairs: stefanie:tokA,laila:tokB
 * Parsed on every call, deliberately uncached: the string is tiny, the queue
 * is low-traffic, and a rotated key must take effect without a redeploy.
 */
export function getAgentKeys(): Record<string, string> {
  const raw = (process.env.POWER_QUEUE_AGENT_KEYS ?? "").trim();
  const keys: Record<string, string> = {};
  if (raw) {
    try {
      if (raw.startsWith("{")) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const [slug, tok] of Object.entries(parsed)) {
          if (typeof tok === "string" && tok) keys[slug.toLowerCase()] = tok;
        }
      } else {
        for (const pair of raw.split(",")) {
          const idx = pair.indexOf(":");
          if (idx > 0) {
            const slug = pair.slice(0, idx).trim().toLowerCase();
            const tok = pair.slice(idx + 1).trim();
            if (slug && tok) keys[slug] = tok;
          }
        }
      }
    } catch (e) {
      console.error("[queueAccess] POWER_QUEUE_AGENT_KEYS could not be parsed — all agent links will read as stale:", e);
    }
  }
  return keys;
}

// ── Core decision function ───────────────────────────────────────────────────
/**
 * Resolve access from URL-derived params. Pure logic — no DB or FUB calls
 * beyond the cached agent registry.
 */
export async function resolveQueueAccess(input: AccessInput): Promise<AccessResult> {
  // Admin path: valid token → full access (token unchanged; comparison constant-time)
  if (adminTokenIsValid(input.adminToken)) {
    return { type: "admin" };
  }

  // Agent path: roster-valid name AND that agent's per-agent key
  if (input.agent) {
    const agents = await getActiveAgents(undefined, ENV.fubApiKey);
    const matched = agents.find(
      (a) =>
        a.slug === input.agent!.toLowerCase() ||
        a.name.toLowerCase() === input.agent!.toLowerCase()
    );
    if (matched) {
      const expected = getAgentKeys()[matched.slug];
      // Fail secure: an agent with no configured key cannot be accessed —
      // POWER_QUEUE_AGENT_KEYS must list every active agent (deploy checklist).
      if (expected && input.key && tokensEqual(input.key, expected)) {
        return { type: "agent", agentName: matched.name, fubUserId: matched.fubUserId };
      }
      return { type: "stale_link", agentName: matched.name };
    }
  }

  return { type: "denied" };
}

/**
 * Marker prefix for expired agent links. The client matches on it to show the
 * friendly "ask Peter for your new link" page instead of a raw auth error.
 */
export const STALE_LINK_MARKER = "POWER_QUEUE_LINK_EXPIRED";
const STALE_LINK_MESSAGE =
  `${STALE_LINK_MARKER}: This Power Queue link is out of date. ` +
  `Ask Peter for your new personal link — it arrives in your daily clock-in email.`;

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
 * Throws UNAUTHORIZED if denied or if the agent link is missing its key.
 */
export async function requireAdminOrAgent(input: AccessInput): Promise<AccessResult> {
  const access = await resolveQueueAccess(input);
  if (access.type === "stale_link") {
    throw new TRPCError({ code: "UNAUTHORIZED", message: STALE_LINK_MESSAGE });
  }
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

  if (access.type === "stale_link") {
    throw new TRPCError({ code: "UNAUTHORIZED", message: STALE_LINK_MESSAGE });
  }
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

/**
 * KEYLESS exception, for logSentNote ONLY.
 *
 * The tap-to-text links in the Python bot's agent digest emails land on
 * /sms-redirect with ?agent=Name and no key (make_sms_uri, sms_helpers.py) —
 * the redirect then logs the "texted" FUB note that the touch-detection
 * audit trail depends on. Requiring a key here would silently break that
 * logging for every emailed link the Python side has ever generated.
 *
 * Scope of the exception: identity is the roster name alone, exactly the
 * pre-2026-08 rule, but it is accepted ONLY for writing a note about a lead
 * the named agent actually owns (the FUB ownership check still runs, and
 * admin/keyed access still passes). Nothing is read back. Closing this last
 * keyless path means tokenizing the Python-generated links — tracked in
 * AUDIT.md's roadmap, not silently forced here.
 */
export async function requirePersonOwnershipForNoteLog(
  input: AccessInput,
  personId: number
): Promise<AccessResult> {
  const access = await resolveQueueAccess(input);
  let effective: AccessResult = access;

  if (access.type === "stale_link") {
    // Keyless-but-roster-valid: resolve the agent identity the old way.
    const agents = await getActiveAgents(undefined, ENV.fubApiKey);
    const matched = agents.find((a) => a.name === access.agentName);
    if (matched) {
      effective = { type: "agent", agentName: matched.name, fubUserId: matched.fubUserId };
    }
  }

  if (effective.type === "denied" || effective.type === "stale_link") {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Valid agent or admin token required" });
  }
  if (effective.type === "admin") {
    return effective;
  }

  const assignedUserId = await getPersonAssignedUserId(personId);
  if (assignedUserId === null || assignedUserId !== effective.fubUserId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Lead is not assigned to your queue",
    });
  }
  return effective;
}

// ── Zod fragments for reuse in procedure inputs ──────────────────────────────
import { z } from "zod";

/** Standard access fields to merge into any procedure input */
export const accessFields = {
  adminToken: z.string().optional(),
  agent: z.string().optional(),
  key: z.string().optional(),
};
// ownership verification deployed 2026-07-22T03:34:32Z
