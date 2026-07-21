/**
 * agentRegistry.test.ts — dynamic registry behavior for nurture-dashboard.
 *
 * Golden Rule: the roster is built from FUB users, so adding an agent needs no
 * code change. "Maria" is Laila's LAST name (not a separate person), so her
 * FUB firstName "Laila" resolves natively with no alias — the old maria→laila
 * alias was removed.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeAgentName,
  getAgentFirstNames,
  getRosterAgents,
  getBotStatusRoster,
  type AgentEntry,
} from "./agentRegistry";

const ROSTER: AgentEntry[] = [
  { name: "Peter", slug: "peter", role: "Agent", fubUserId: 2 },
  { name: "Steven", slug: "steven", role: "Agent", fubUserId: 1 },
  // Laila's FUB record: firstName "Laila", last name "Maria" → resolves to "Laila".
  { name: "Laila", slug: "laila", role: "Agent", fubUserId: 35 },
  { name: "Jason", slug: "jason", role: "Agent", fubUserId: 37 },
];

describe("normalizeAgentName — Laila resolves natively (no alias)", () => {
  it("returns 'Laila' from any name lookup for her row (fubUserId 35)", () => {
    expect(normalizeAgentName("Laila", ROSTER)).toBe("Laila");
    expect(normalizeAgentName("laila", ROSTER)).toBe("Laila");
    expect(normalizeAgentName("  LAILA  ", ROSTER)).toBe("Laila");
  });

  it("no longer aliases 'Maria' — it is a last name, so it title-cases", () => {
    // The maria→laila alias was removed; "Maria" is not a roster identity.
    expect(normalizeAgentName("Maria", ROSTER)).toBe("Maria");
  });

  it("resolves direct first-name and slug matches", () => {
    expect(normalizeAgentName("peter", ROSTER)).toBe("Peter");
    expect(normalizeAgentName("Jason", ROSTER)).toBe("Jason");
  });

  it("title-cases an unknown name rather than crashing", () => {
    expect(normalizeAgentName("newagent", ROSTER)).toBe("Newagent");
  });
});

describe("dynamic roster helpers propagate a new agent with no code change", () => {
  it("getAgentFirstNames includes every roster slug (incl. a new agent)", () => {
    const withTest: AgentEntry[] = [...ROSTER, { name: "TestAgent", slug: "testagent", role: "Agent", fubUserId: 999 }];
    expect(getAgentFirstNames(withTest)).toContain("testagent");
  });

  it("getRosterAgents mirrors the FUB-driven roster shape", () => {
    expect(getRosterAgents(ROSTER)).toEqual(
      ROSTER.map(a => ({ name: a.name, slug: a.slug, role: a.role }))
    );
  });

  it("getBotStatusRoster always appends 'Lifestyle Bot' as the final entry", () => {
    const roster = getBotStatusRoster(ROSTER);
    expect(roster[roster.length - 1]).toBe("Lifestyle Bot");
    expect(roster).toContain("Jason");
  });
});
