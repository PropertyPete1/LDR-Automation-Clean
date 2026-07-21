import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Mock ENV
vi.mock("./_core/env", () => ({
  ENV: {
    fubApiKey: "test_fub_key",
    forgeApiUrl: "https://api.test.com",
    forgeApiKey: "test_forge_key",
    appId: "test_app_id",
    cookieSecret: "test_secret",
    databaseUrl: "mysql://test",
    oAuthServerUrl: "https://oauth.test.com",
    ownerOpenId: "test_owner",
    isProduction: false,
    powerQueueAdminToken: "test_admin_token",
  },
}));

// Mock agent registry for access control
vi.mock("./agentRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agentRegistry")>();
  return {
    ...actual,
    getActiveAgents: vi.fn().mockResolvedValue([
      { name: "Peter", slug: "peter", role: "Agent", fubUserId: 2 },
      { name: "Steven", slug: "steven", role: "Agent", fubUserId: 1 },
      { name: "Tiffany", slug: "tiffany", role: "Agent", fubUserId: 20 },
      { name: "Stefanie", slug: "stefanie", role: "Agent", fubUserId: 31 },
    ]),
  };
});

// Mock the LLM module to avoid real API calls in tests
vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn().mockResolvedValue({
    id: "mock-id",
    created: Date.now(),
    model: "mock-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Hey Sarah! Hope you're having a great week. Still thinking about homes in Austin? 😊",
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
  }),
}));

// Mock the DB module to avoid real database calls in tests
vi.mock("./db", async (importOriginal) => {
  const original = await importOriginal<typeof import("./db")>();
  return {
    ...original,
    getMemories: vi.fn().mockResolvedValue([]),
    getWinningPatterns: vi.fn().mockResolvedValue([]),
    saveMemory: vi.fn().mockResolvedValue(undefined),
    logFeedback: vi.fn().mockResolvedValue(undefined),
  };
});

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

describe("ai.chat", () => {
  it("returns an assistant response for a basic user message", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.ai.chat({
      messages: [{ role: "user", content: "Draft a quick SMS for a lead in Austin" }],
      adminToken: "test_admin_token",
    });

    expect(result).toHaveProperty("content");
    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("accepts lead context and still returns a string response", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.ai.chat({
      messages: [{ role: "user", content: "Summarize this lead and recommend next action" }],
      leadContext: {
        id: 1234,
        name: "Sarah Johnson",
        phone: "(512) 555-0199",
        stage: "Lead",
        city: "Austin",
        days_stale: 22,
        assigned_agent: "Steven",
        sms_body: "Hey Sarah, hope you had a great week!",
      },
      agent: "Steven",
    });

    expect(result).toHaveProperty("content");
    expect(typeof result.content).toBe("string");
  });

  it("handles multi-turn conversation messages", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.ai.chat({
      messages: [
        { role: "user", content: "Draft an SMS for a lead" },
        { role: "assistant", content: "Hey! Are you still looking for homes in Texas? 😊" },
        { role: "user", content: "Make it shorter and more casual" },
      ],
      adminToken: "test_admin_token",
    });

    expect(result).toHaveProperty("content");
    expect(typeof result.content).toBe("string");
  });

  it("includes notes and last_inbound_text in system prompt when provided", async () => {
    const { invokeLLM } = await import("./_core/llm");
    const mockInvokeLLM = vi.mocked(invokeLLM);
    mockInvokeLLM.mockClear();

    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await caller.ai.chat({
      messages: [{ role: "user", content: "How should I respond to this lead?" }],
      leadContext: {
        id: 5678,
        name: "Maria Lopez",
        phone: "(210) 555-0142",
        stage: "Lead",
        city: "San Antonio",
        days_stale: 15,
        assigned_agent: "Stefanie",
        sms_body: "Hey Maria, still looking for homes?",
        notes: "Interested in 3BR, budget around $350k | Called back last week",
        last_inbound_text: "Yes I am still interested, what are the rates?",
      },
      agent: "Stefanie",
    });

    expect(mockInvokeLLM).toHaveBeenCalledOnce();
    const callArgs = mockInvokeLLM.mock.calls[0]?.[0];
    const systemMsg = callArgs?.messages[0]?.content as string;
    expect(systemMsg).toContain("Recent FUB Notes:");
    expect(systemMsg).toContain("Interested in 3BR, budget around $350k");
    expect(systemMsg).toContain("Last Inbound Text from Lead:");
    expect(systemMsg).toContain("Yes I am still interested");
  });

  it("prepends system message when not already present", async () => {
    const { invokeLLM } = await import("./_core/llm");
    const mockInvokeLLM = vi.mocked(invokeLLM);
    mockInvokeLLM.mockClear();

    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await caller.ai.chat({
      messages: [{ role: "user", content: "Hello" }],
      adminToken: "test_admin_token",
    });

    expect(mockInvokeLLM).toHaveBeenCalledOnce();
    const callArgs = mockInvokeLLM.mock.calls[0]?.[0];
    expect(callArgs?.messages[0]?.role).toBe("system");
    expect(callArgs?.messages[0]?.content).toContain("Lifestyle Design Realty AI Broker");
  });

  it("injects agent memories into system prompt when memories exist", async () => {
    const { invokeLLM } = await import("./_core/llm");
    const mockInvokeLLM = vi.mocked(invokeLLM);
    mockInvokeLLM.mockClear();

    // Override getMemories to return a test memory
    const { getMemories } = await import("./db");
    vi.mocked(getMemories).mockResolvedValueOnce([
      {
        id: 1,
        agentName: "Steven",
        memoryText: "Steven prefers casual tone and uses first names only",
        category: "agent_style",
        importanceScore: 3,
        createdAt: new Date(),
      },
    ]);

    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await caller.ai.chat({
      messages: [{ role: "user", content: "Draft a message for this lead" }],
      leadContext: {
        id: 9999,
        name: "Test Lead",
        assigned_agent: "Steven",
      },
      agent: "Steven",
    });

    expect(mockInvokeLLM).toHaveBeenCalledOnce();
    const callArgs = mockInvokeLLM.mock.calls[0]?.[0];
    const systemMsg = callArgs?.messages[0]?.content as string;
    expect(systemMsg).toContain("AGENT MEMORY (Steven)");
    expect(systemMsg).toContain("Steven prefers casual tone");
  });

  it("injects winning SMS patterns into system prompt when feedback exists", async () => {
    const { invokeLLM } = await import("./_core/llm");
    const mockInvokeLLM = vi.mocked(invokeLLM);
    mockInvokeLLM.mockClear();

    // Override getWinningPatterns to return a test pattern
    const { getWinningPatterns } = await import("./db");
    vi.mocked(getWinningPatterns).mockResolvedValueOnce([
      {
        id: 1,
        agentName: "Steven",
        draftText: "Hey John! Still thinking about that Austin home? Rates are looking good this week 🏡",
        leadCity: "Austin",
        leadStage: "Lead",
        draftType: "outbound",
        action: "sent",
        createdAt: new Date(),
      },
    ]);

    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await caller.ai.chat({
      messages: [{ role: "user", content: "Draft a message for this lead" }],
      leadContext: {
        id: 9998,
        name: "Test Lead 2",
        assigned_agent: "Steven",
      },
      agent: "Steven",
    });

    expect(mockInvokeLLM).toHaveBeenCalledOnce();
    const callArgs = mockInvokeLLM.mock.calls[0]?.[0];
    const systemMsg = callArgs?.messages[0]?.content as string;
    expect(systemMsg).toContain("WINNING SMS PATTERNS");
    expect(systemMsg).toContain("Still thinking about that Austin home");
  });
});

describe("copilot.saveMemory", () => {
  it("saves a memory and returns success", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.copilot.saveMemory({
      agentName: "Steven",
      memoryText: "Steven's leads are mostly in Austin and prefer new construction",
      category: "market_knowledge",
      importanceScore: 3,
      agent: "Steven",
    });

    expect(result).toEqual({ success: true });
  });
});

describe("copilot.logFeedback", () => {
  it("logs a sent feedback signal and returns success", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.copilot.logFeedback({
      agentName: "Steven",
      draftText: "Hey Maria! Still thinking about that San Antonio home? 🏡",
      leadCity: "San Antonio",
      draftType: "outbound",
      action: "sent",
      agent: "Steven",
    });

    expect(result).toEqual({ success: true });
  });

  it("logs a regenerated feedback signal and returns success", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.copilot.logFeedback({
      agentName: "Tiffany",
      draftText: "Hello, I wanted to follow up regarding your home search.",
      leadCity: "Austin",
      draftType: "outbound",
      action: "regenerated",
      agent: "Tiffany",
    });

    expect(result).toEqual({ success: true });
  });
});
