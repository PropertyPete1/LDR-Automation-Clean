/**
 * agentRegistry.test.ts — dynamic registry behavior for nurture-dashboard.
 *
 * Golden Rule: the roster is built from FUB users, so adding an agent needs no
 * code change. The one hardcoded business rule that MUST survive is the
 * Maria → Laila alias (Laila's FUB record surfaces her middle name "Maria").
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
  { name: "Laila", slug: "laila", role: "Agent", fubUserId: 35 },
  { name: "Jason", slug: "jason", role: "Agent", fubUserId: 37 },
];

describe("normalizeAgentName — Maria → Laila alias (business rule)", () => {
  it("maps 'Maria' to 'Laila' when Laila is in the roster", () => {
    expect(normalizeAgentName("Maria", ROSTER)).toBe("Laila");
    expect(normalizeAgentName("maria", ROSTER)).toBe("Laila");
    expect(normalizeAgentName("  MARIA  ", ROSTER)).toBe("Laila");
  });

  it("resolves direct first-name and slug matches", () => {
    expect(normalizeAgentName("peter", ROSTER)).toBe("Peter");
    expect(normalizeAgentName("Jason", ROSTER)).toBe("Jason");
  });

  it("title-cases an unknown name rather than crashing", () => {
    expect(normalizeAgentName("newagent", ROSTER)).toBe("Newagent");
  });

  it("does not alias Maria to Laila if Laila is absent from the roster", () => {
    const withoutLaila = ROSTER.filter(a => a.slug !== "laila");
    // Falls through to title-case since the alias target isn't present
    expect(normalizeAgentName("Maria", withoutLaila)).toBe("Maria");
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
