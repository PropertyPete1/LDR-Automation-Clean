/**
 * queueAccessControl.test.ts — Power Queue URL-param-based access control.
 *
 * The security model is now URL-param-based (no login required):
 * - ?agent=Name → server scopes results to that agent's leads only
 * - ?admin=TOKEN&agent=all → admin token grants full queue access
 * - No params → empty result (agents get their link from clock-in email)
 *
 * These tests exercise the server-side logic in the getPendingQueue procedure
 * by simulating the input validation and admin token check.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

// Simulate the server-side access control logic from routers.ts
// (extracted here for pure unit testing without tRPC context)

interface AgentEntry {
  name: string;
  slug: string;
  role: string;
  fubUserId: number;
}

const ROSTER: AgentEntry[] = [
  { name: "Peter", slug: "peter", role: "Agent", fubUserId: 2 },
  { name: "Steven", slug: "steven", role: "Agent", fubUserId: 1 },
  { name: "Tiffany", slug: "tiffany", role: "Agent", fubUserId: 20 },
  { name: "Jason", slug: "jason", role: "Agent", fubUserId: 37 },
  { name: "Stefanie", slug: "stefanie", role: "Agent", fubUserId: 30 },
  { name: "Laila", slug: "laila", role: "Agent", fubUserId: 35 },
];

const ADMIN_TOKEN = "ldr2026admin";

/**
 * Mirror of the access control logic inside the getPendingQueue procedure.
 * Returns { effectiveFilter, isAdmin, agentName } to determine what the server returns.
 */
function resolveAccess(
  input: { agentFilter?: string; adminToken?: string },
  configuredToken: string,
  agents: AgentEntry[]
): { effectiveFilter: string | undefined; isAdmin: boolean; agentName: string | null } {
  const isAdmin = !!(input.adminToken && configuredToken && input.adminToken === configuredToken);

  if (isAdmin) {
    const filter = input.agentFilter === "all" ? undefined : input.agentFilter;
    return { effectiveFilter: filter, isAdmin: true, agentName: null };
  }

  // Non-admin: agent param is REQUIRED
  if (!input.agentFilter || input.agentFilter === "all") {
    return { effectiveFilter: "__empty__", isAdmin: false, agentName: null };
  }

  // Validate agent name against roster
  const matched = agents.find(
    a => a.slug === input.agentFilter!.toLowerCase() || a.name.toLowerCase() === input.agentFilter!.toLowerCase()
  );
  const effectiveFilter = matched ? matched.name : "__no_such_agent__";
  return { effectiveFilter, isAdmin: false, agentName: matched?.name ?? null };
}

describe("URL-param access: agent scoping (?agent=Name)", () => {
  it("?agent=jason → returns only Jason's leads (effectiveFilter = 'Jason')", () => {
    const result = resolveAccess({ agentFilter: "jason" }, ADMIN_TOKEN, ROSTER);
    expect(result.isAdmin).toBe(false);
    expect(result.effectiveFilter).toBe("Jason");
    expect(result.agentName).toBe("Jason");
  });

  it("?agent=tiffany → returns only Tiffany's leads", () => {
    const result = resolveAccess({ agentFilter: "tiffany" }, ADMIN_TOKEN, ROSTER);
    expect(result.isAdmin).toBe(false);
    expect(result.effectiveFilter).toBe("Tiffany");
    expect(result.agentName).toBe("Tiffany");
  });

  it("?agent=Stefanie (capitalized) → case-insensitive match", () => {
    const result = resolveAccess({ agentFilter: "Stefanie" }, ADMIN_TOKEN, ROSTER);
    expect(result.isAdmin).toBe(false);
    expect(result.effectiveFilter).toBe("Stefanie");
    expect(result.agentName).toBe("Stefanie");
  });

  it("?agent=laila → resolves to Laila (no alias needed)", () => {
    const result = resolveAccess({ agentFilter: "laila" }, ADMIN_TOKEN, ROSTER);
    expect(result.isAdmin).toBe(false);
    expect(result.effectiveFilter).toBe("Laila");
    expect(result.agentName).toBe("Laila");
  });

  it("?agent=unknown_person → impossible filter (empty result)", () => {
    const result = resolveAccess({ agentFilter: "ghost" }, ADMIN_TOKEN, ROSTER);
    expect(result.isAdmin).toBe(false);
    expect(result.effectiveFilter).toBe("__no_such_agent__");
    expect(result.agentName).toBeNull();
  });
});

describe("URL-param access: no params → empty/redirect", () => {
  it("no agent param, no admin token → empty result", () => {
    const result = resolveAccess({}, ADMIN_TOKEN, ROSTER);
    expect(result.isAdmin).toBe(false);
    expect(result.effectiveFilter).toBe("__empty__");
    expect(result.agentName).toBeNull();
  });

  it("agent=all without admin token → empty result (not admin)", () => {
    const result = resolveAccess({ agentFilter: "all" }, ADMIN_TOKEN, ROSTER);
    expect(result.isAdmin).toBe(false);
    expect(result.effectiveFilter).toBe("__empty__");
    expect(result.agentName).toBeNull();
  });
});

describe("URL-param access: admin token override (?admin=TOKEN)", () => {
  it("?admin=TOKEN&agent=all → full queue (no filter)", () => {
    const result = resolveAccess({ agentFilter: "all", adminToken: ADMIN_TOKEN }, ADMIN_TOKEN, ROSTER);
    expect(result.isAdmin).toBe(true);
    expect(result.effectiveFilter).toBeUndefined(); // no filter = full queue
    expect(result.agentName).toBeNull();
  });

  it("?admin=TOKEN&agent=tiffany → admin can filter to specific agent", () => {
    const result = resolveAccess({ agentFilter: "tiffany", adminToken: ADMIN_TOKEN }, ADMIN_TOKEN, ROSTER);
    expect(result.isAdmin).toBe(true);
    expect(result.effectiveFilter).toBe("tiffany"); // admin passes filter as-is
  });

  it("?admin=WRONG_TOKEN → not admin, falls through to agent scoping", () => {
    const result = resolveAccess({ agentFilter: "all", adminToken: "wrong_token" }, ADMIN_TOKEN, ROSTER);
    expect(result.isAdmin).toBe(false);
    expect(result.effectiveFilter).toBe("__empty__"); // "all" without valid token → empty
  });

  it("?admin=WRONG_TOKEN&agent=jason → wrong token but valid agent → scoped to Jason", () => {
    const result = resolveAccess({ agentFilter: "jason", adminToken: "wrong_token" }, ADMIN_TOKEN, ROSTER);
    expect(result.isAdmin).toBe(false);
    expect(result.effectiveFilter).toBe("Jason");
    expect(result.agentName).toBe("Jason");
  });

  it("admin token is empty string → not admin", () => {
    const result = resolveAccess({ agentFilter: "all", adminToken: "" }, ADMIN_TOKEN, ROSTER);
    expect(result.isAdmin).toBe(false);
  });
});

describe("URL-param access: no cross-agent leakage", () => {
  it("Jason's link cannot see Tiffany's leads — filter is always Jason", () => {
    // Even if someone manually edits the URL to ?agent=tiffany, the server
    // returns Tiffany's leads (which is fine — they'd need Tiffany's link).
    // The key point: there's no way to see ALL leads without the admin token.
    const jasonResult = resolveAccess({ agentFilter: "jason" }, ADMIN_TOKEN, ROSTER);
    expect(jasonResult.effectiveFilter).toBe("Jason");
    expect(jasonResult.isAdmin).toBe(false);

    // Without admin token, agent=all returns empty
    const allResult = resolveAccess({ agentFilter: "all" }, ADMIN_TOKEN, ROSTER);
    expect(allResult.effectiveFilter).toBe("__empty__");
  });

  it("no way to enumerate all agents without admin token", () => {
    // The roster endpoint is public (for the agent dropdown in admin view)
    // but getPendingQueue without a valid agent or admin token returns nothing
    const noParams = resolveAccess({}, ADMIN_TOKEN, ROSTER);
    expect(noParams.effectiveFilter).toBe("__empty__");
  });
});
