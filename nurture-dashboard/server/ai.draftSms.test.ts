import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Mock the DB module
vi.mock("./db", async (importOriginal) => {
  const original = await importOriginal<typeof import("./db")>();
  return {
    ...original,
    getMemories: vi.fn().mockResolvedValue([]),
    getWinningPatterns: vi.fn().mockResolvedValue([]),
    saveMemory: vi.fn().mockResolvedValue(undefined),
    logFeedback: vi.fn().mockResolvedValue(undefined),
    getCachedDraft: vi.fn().mockResolvedValue(null),
    setCachedDraft: vi.fn().mockResolvedValue(undefined),
    getLeadMemories: vi.fn().mockResolvedValue([]),
  };
});

// Mock the LLM module (still used by other ai.* procedures)
vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn().mockResolvedValue({
    id: "mock-id",
    created: Date.now(),
    model: "mock-model",
    choices: [{ index: 0, message: { role: "assistant", content: "mock" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }),
}));

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

function mockAnthropicResponse(text: string) {
  const mockFetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      id: "msg_mock",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 50, output_tokens: 20 },
    }),
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

describe("ai.draftSms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure ANTHROPIC_API_KEY is set for tests
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test-key-for-testing";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a draft SMS string for a basic lead (no notes)", async () => {
    mockAnthropicResponse(
      "Hey Sarah! Still thinking about homes in Austin? Rates are looking great this week."
    );

    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.ai.draftSms({
      leadName: "Sarah Johnson",
      leadCity: "Austin",
      daysStale: 18,
      assignedAgent: "Steven",
    });

    expect(result).toHaveProperty("draft");
    expect(typeof result.draft).toBe("string");
    expect(result.draft.length).toBeGreaterThan(0);
    expect(result.draft.length).toBeLessThanOrEqual(200);
  });

  it("strips surrounding double-quotes from the Anthropic response", async () => {
    mockAnthropicResponse(
      '"Hey Maria! Still thinking about that San Antonio home? Let\'s chat!"'
    );

    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.ai.draftSms({
      leadName: "Maria Lopez",
      leadCity: "San Antonio",
      daysStale: 21,
      assignedAgent: "Stefanie",
    });

    expect(result.draft).not.toMatch(/^"/);
    expect(result.draft).not.toMatch(/"$/);
    expect(result.draft).toContain("Hey Maria");
  });

  it("calls Anthropic API directly (not Manus/Forge LLM)", async () => {
    const mockFetch = mockAnthropicResponse(
      "Hey John! Saw you were eyeing homes near the Riverwalk — anything catch your eye?"
    );

    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await caller.ai.draftSms({
      leadName: "John Smith",
      leadCity: "San Antonio",
      daysStale: 17,
      assignedAgent: "Peter",
      notes: "Interested in 3BR near Riverwalk, budget $400k",
    });

    // Verify it called Anthropic API directly
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(options.headers["x-api-key"]).toBeDefined();
    expect(options.headers["anthropic-version"]).toBe("2023-06-01");

    // Verify the body contains the correct model and notes reference
    const body = JSON.parse(options.body);
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.messages[0].content).toContain("Interested in 3BR near Riverwalk");
  });

  it("uses the Anthropic API URL (not Manus/Forge)", async () => {
    const mockFetch = mockAnthropicResponse("Hey! Quick question about your home search.");

    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await caller.ai.draftSms({
      leadName: "Test Lead",
      leadCity: "Austin",
      daysStale: 10,
      assignedAgent: "Steven",
    });

    const [url] = mockFetch.mock.calls[0];
    // Must hit Anthropic directly, NOT the Manus/Forge proxy
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(url).not.toContain("forge");
    expect(url).not.toContain("manus");
  });
});
