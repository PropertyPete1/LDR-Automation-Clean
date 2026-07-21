/**
 * queueAccessControl.test.ts — Power Queue access control (Job 2).
 *
 * The security boundary is the SERVER: a non-admin agent must only ever see
 * their own leads, regardless of the client-supplied agentFilter or URL param.
 * These tests exercise resolveQueueViewer (the pure decision function) and the
 * effective-filter logic the getPendingQueue procedure applies.
 */
import { describe, expect, it } from "vitest";
import { resolveQueueViewer, type AgentEntry } from "./agentRegistry";

const ROSTER: AgentEntry[] = [
  { name: "Peter", slug: "peter", role: "Agent", fubUserId: 2 },
  { name: "Steven", slug: "steven", role: "Agent", fubUserId: 1 },
  { name: "Tiffany", slug: "tiffany", role: "Agent", fubUserId: 20 },
  { name: "Jason", slug: "jason", role: "Agent", fubUserId: 37 },
];

/** Mirror of the effective-filter logic inside the getPendingQueue procedure. */
function effectiveFilter(viewer: ReturnType<typeof resolveQueueViewer>, clientFilter?: string): string | undefined {
  return viewer.isAdmin ? clientFilter : (viewer.agentName ?? "__no_such_agent__");
}

describe("resolveQueueViewer — admin detection", () => {
  it("Peter (FUB 2, by name) is admin", () => {
    expect(resolveQueueViewer({ name: "Peter Allen", email: "peter@lifestyledesignrealty.com" }, ROSTER).isAdmin).toBe(true);
  });
  it("Steven (FUB 1) is admin", () => {
    expect(resolveQueueViewer({ name: "Steven", email: "steven@lifestyledesignrealty.com" }, ROSTER).isAdmin).toBe(true);
  });
  it("dashboard role=admin is admin regardless of name", () => {
    expect(resolveQueueViewer({ name: "Someone", email: "x@y.com", role: "admin" }, ROSTER).isAdmin).toBe(true);
  });
  it("admin email wins even if not resolvable to a roster agent", () => {
    expect(resolveQueueViewer({ email: "PETER@lifestyledesignrealty.com", name: "" }, ROSTER).isAdmin).toBe(true);
  });
});

describe("resolveQueueViewer — non-admin agents are locked to themselves", () => {
  it("Tiffany (FUB 20) is NOT admin and resolves to her own name", () => {
    const v = resolveQueueViewer({ name: "Tiffany Proske", email: "tiffany@lifestyledesignrealty.com" }, ROSTER);
    expect(v.isAdmin).toBe(false);
    expect(v.agentName).toBe("Tiffany");
    expect(v.fubUserId).toBe(20);
  });
  it("Jason resolves by email local-part", () => {
    const v = resolveQueueViewer({ email: "jason@lifestyledesignrealty.com", name: "" }, ROSTER);
    expect(v.isAdmin).toBe(false);
    expect(v.agentName).toBe("Jason");
  });
  it("an unauthenticated caller is not admin and has no agent", () => {
    const v = resolveQueueViewer(null, ROSTER);
    expect(v.isAdmin).toBe(false);
    expect(v.agentName).toBeNull();
  });
});

describe("effective server-side filter (the enforcement)", () => {
  it("admin may pass any agentFilter (Peter viewing Tiffany's leads)", () => {
    const v = resolveQueueViewer({ name: "Peter", email: "peter@lifestyledesignrealty.com" }, ROSTER);
    expect(effectiveFilter(v, "tiffany")).toBe("tiffany");
    expect(effectiveFilter(v, undefined)).toBeUndefined(); // full queue
  });

  it("non-admin's client filter is IGNORED — forced to their own name", () => {
    const v = resolveQueueViewer({ name: "Tiffany", email: "tiffany@lifestyledesignrealty.com" }, ROSTER);
    // Tiffany tries to view Jason's leads by crafting agentFilter="jason"
    expect(effectiveFilter(v, "jason")).toBe("Tiffany");
    // Tiffany removes the filter entirely hoping to see everyone
    expect(effectiveFilter(v, undefined)).toBe("Tiffany");
  });

  it("an unresolved non-admin gets an impossible filter → empty result (deny by default)", () => {
    const v = resolveQueueViewer({ name: "Ghost", email: "ghost@example.com" }, ROSTER);
    expect(v.isAdmin).toBe(false);
    expect(effectiveFilter(v, "jason")).toBe("__no_such_agent__");
  });
});
