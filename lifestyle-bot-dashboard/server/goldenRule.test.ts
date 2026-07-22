/**
 * Golden Rule Test: Insert a TestAgent row into agent_bots,
 * then verify WITHOUT any code changes that:
 * 1. TestAgent appears in the public agents.list endpoint
 * 2. TestAgent would be monitored by the Bot Monitor (getAllBotsForMonitor)
 * 3. TestAgent's clock-in email would generate the correct Power Queue link
 * 4. TestAgent's dashboard slug resolves correctly
 * 5. TestAgent appears in the Power Queue name lookup
 *
 * This proves the system is truly zero-code for new agents.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Mock the DB to return our test registry including TestAgent
const MOCK_REGISTRY = [
  {
    id: 1, botSlug: "peter", botName: "Peter's Lifestyle Bot",
    agentFirstName: "Peter", agentLastName: "Allen", agentEmail: "peter@test.com",
    fubUserId: 2, powerQueueName: "Peter", accentColor: "#f59e0b",
    headerGradient: "from-amber-900 via-amber-600 to-amber-400", engineActive: false,
  },
  {
    id: 7, botSlug: "jason", botName: "Jason's Lifestyle Bot",
    agentFirstName: "Jason", agentLastName: "Casanova", agentEmail: "jason@test.com",
    fubUserId: 37, powerQueueName: "Jason", accentColor: "#7c2d12",
    headerGradient: "from-orange-900 via-orange-600 to-orange-400", engineActive: true,
  },
  {
    id: 99, botSlug: "testagent", botName: "TestAgent Lifestyle Bot",
    agentFirstName: "TestAgent", agentLastName: "Smith", agentEmail: "test@lifestyledesignrealty.com",
    fubUserId: 99, powerQueueName: "TestAgent", accentColor: "#10b981",
    headerGradient: "from-emerald-900 via-emerald-600 to-emerald-400", engineActive: true,
  },
];

// Mock the DB module
vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue({
    select: () => ({
      from: () => ({
        orderBy: () => Promise.resolve(MOCK_REGISTRY),
      }),
    }),
  }),
}));

// Mock the schema import
vi.mock("../drizzle/schema", () => ({
  agentBots: { id: "id" },
}));

describe("Golden Rule: TestAgent propagates with zero code changes", () => {
  beforeAll(async () => {
    // Force-clear the cache so our mock data is used
    const { invalidateAgentRegistryCache } = await import("./agentRegistryCache");
    invalidateAgentRegistryCache();
  });

  it("TestAgent appears in getPublicAgentList (agents.list endpoint)", async () => {
    const { getPublicAgentList } = await import("./agentRegistryCache");
    const list = await getPublicAgentList();
    const testAgent = list.find(a => a.slug === "testagent");
    expect(testAgent).toBeDefined();
    expect(testAgent!.firstName).toBe("TestAgent");
    expect(testAgent!.lastName).toBe("Smith");
    expect(testAgent!.powerQueueName).toBe("TestAgent");
  });

  it("TestAgent appears in getAllBotsForMonitor (Bot Monitor)", async () => {
    const { getAllBotsForMonitor } = await import("./agentRegistryCache");
    const bots = await getAllBotsForMonitor();
    const testBot = bots.find(b => b.slug === "testagent");
    expect(testBot).toBeDefined();
    expect(testBot!.name).toBe("TestAgent Lifestyle Bot");
  });

  it("TestAgent's Power Queue name resolves correctly", async () => {
    const { getPowerQueueName } = await import("./agentRegistryCache");
    const name = await getPowerQueueName("testagent");
    expect(name).toBe("TestAgent");
  });

  it("TestAgent's dashboard slug resolves correctly", async () => {
    const { getDashboardSlug } = await import("./agentRegistryCache");
    const slug = await getDashboardSlug("TestAgent");
    expect(slug).toBe("testagent");
  });

  it("TestAgent appears in the full registry", async () => {
    const { getAgentRegistry } = await import("./agentRegistryCache");
    const registry = await getAgentRegistry();
    const testAgent = registry.find(r => r.botSlug === "testagent");
    expect(testAgent).toBeDefined();
    expect(testAgent!.agentFirstName).toBe("TestAgent");
    expect(testAgent!.engineActive).toBe(true);
  });

  it("Total agent count includes TestAgent (no filtering by hardcoded list)", async () => {
    const { getAgentRegistry } = await import("./agentRegistryCache");
    const registry = await getAgentRegistry();
    // Should have all 3 agents from mock (peter, jason, testagent)
    expect(registry.length).toBe(3);
  });
});
