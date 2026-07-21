/**
 * queueAccessControl.test.ts — Power Queue URL-param / admin-token access model.
 *
 * IMPORTANT: this imports the REAL decision function `resolveQueueAccess` from
 * agentRegistry.ts (the exact code the getPendingQueue procedure runs), so the
 * test can never drift from production. (Previously this file re-implemented a
 * copy of the logic — a test that couldn't catch the real code changing.)
 *
 * Model (no login): identity from the URL.
 *  - ?admin=TOKEN → admin; ?agent=all = full queue, or filter to one agent.
 *  - ?agent=Name  → scoped to that agent (case-insensitive, name or slug).
 *  - no/invalid params → "__empty__" / "__no_such_agent__" → zero leads.
 */
import { describe, expect, it } from "vitest";
import { resolveQueueAccess, type AgentEntry } from "./agentRegistry";

const ROSTER: AgentEntry[] = [
  { name: "Peter", slug: "peter", role: "Agent", fubUserId: 2 },
  { name: "Steven", slug: "steven", role: "Agent", fubUserId: 1 },
  { name: "Tiffany", slug: "tiffany", role: "Agent", fubUserId: 20 },
  { name: "Jason", slug: "jason", role: "Agent", fubUserId: 37 },
  { name: "Stefanie", slug: "stefanie", role: "Agent", fubUserId: 30 },
  { name: "Laila", slug: "laila", role: "Agent", fubUserId: 35 },
];

const TOKEN = "ldr2026admin";

describe("resolveQueueAccess — agent scoping (?agent=Name)", () => {
  it("?agent=jason → scoped to Jason (name resolved from slug)", () => {
    const r = resolveQueueAccess({ agentFilter: "jason" }, TOKEN, ROSTER);
    expect(r).toEqual({ effectiveFilter: "Jason", isAdmin: false, agentName: "Jason" });
  });

  it("?agent=Stefanie (mixed case) → case-insensitive match", () => {
    expect(resolveQueueAccess({ agentFilter: "Stefanie" }, TOKEN, ROSTER).effectiveFilter).toBe("Stefanie");
  });

  it("?agent=laila → resolves to Laila with no alias", () => {
    expect(resolveQueueAccess({ agentFilter: "laila" }, TOKEN, ROSTER).effectiveFilter).toBe("Laila");
  });

  it("?agent=ghost (unknown) → __no_such_agent__ → empty result", () => {
    const r = resolveQueueAccess({ agentFilter: "ghost" }, TOKEN, ROSTER);
    expect(r.effectiveFilter).toBe("__no_such_agent__");
    expect(r.isAdmin).toBe(false);
    expect(r.agentName).toBeNull();
  });
});

describe("resolveQueueAccess — no params / agent=all without token", () => {
  it("no params → __empty__", () => {
    expect(resolveQueueAccess({}, TOKEN, ROSTER).effectiveFilter).toBe("__empty__");
  });
  it("agent=all without token → __empty__ (never leaks full queue)", () => {
    expect(resolveQueueAccess({ agentFilter: "all" }, TOKEN, ROSTER).effectiveFilter).toBe("__empty__");
  });
});

describe("resolveQueueAccess — admin token (?admin=TOKEN)", () => {
  it("?admin=TOKEN&agent=all → full queue (undefined filter)", () => {
    const r = resolveQueueAccess({ agentFilter: "all", adminToken: TOKEN }, TOKEN, ROSTER);
    expect(r).toEqual({ effectiveFilter: undefined, isAdmin: true, agentName: null });
  });
  it("?admin=TOKEN&agent=tiffany → admin may filter to one agent", () => {
    const r = resolveQueueAccess({ agentFilter: "tiffany", adminToken: TOKEN }, TOKEN, ROSTER);
    expect(r.isAdmin).toBe(true);
    expect(r.effectiveFilter).toBe("tiffany");
  });
  it("wrong token + agent=all → not admin → __empty__", () => {
    const r = resolveQueueAccess({ agentFilter: "all", adminToken: "nope" }, TOKEN, ROSTER);
    expect(r.isAdmin).toBe(false);
    expect(r.effectiveFilter).toBe("__empty__");
  });
  it("wrong token + valid agent → scoped to that agent, not admin", () => {
    const r = resolveQueueAccess({ agentFilter: "jason", adminToken: "nope" }, TOKEN, ROSTER);
    expect(r.isAdmin).toBe(false);
    expect(r.effectiveFilter).toBe("Jason");
  });
  it("empty admin token → not admin", () => {
    expect(resolveQueueAccess({ agentFilter: "all", adminToken: "" }, TOKEN, ROSTER).isAdmin).toBe(false);
  });
  it("empty CONFIGURED token can never grant admin (unset env)", () => {
    // If POWER_QUEUE_ADMIN_TOKEN is unset, no adminToken value should match.
    const r = resolveQueueAccess({ agentFilter: "all", adminToken: "" }, "", ROSTER);
    expect(r.isAdmin).toBe(false);
    expect(r.effectiveFilter).toBe("__empty__");
  });
});

describe("resolveQueueAccess — no cross-agent leakage", () => {
  it("there is no way to get the full queue without the admin token", () => {
    for (const attempt of [{}, { agentFilter: "all" }, { agentFilter: "all", adminToken: "guess" }]) {
      const r = resolveQueueAccess(attempt, TOKEN, ROSTER);
      expect(r.isAdmin).toBe(false);
      expect(r.effectiveFilter).toBe("__empty__");
    }
  });
});
