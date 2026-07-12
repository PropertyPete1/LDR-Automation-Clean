import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Mock the LLM module to avoid real API calls in tests
vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn(),
}));

// Mock the DB module (draftSms doesn't use DB, but other procedures in the router do)
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

async function mockLLMResponse(text: string) {
  const { invokeLLM } = await import("./_core/llm");
  vi.mocked(invokeLLM).mockResolvedValueOnce({
    id: "mock-id",
    created: Date.now(),
    model: "mock-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
  });
}

describe("ai.draftSms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a draft SMS string for a basic lead (no notes)", async () => {
    await mockLLMResponse(
      "Hey Sarah! Still thinking about homes in Austin? Rates are looking great this week 🏡"
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
    expect(result.draft.length).toBeLessThanOrEqual(200); // reasonable upper bound
  });

  it("strips surrounding double-quotes from the LLM response", async () => {
    // LLM sometimes wraps the response in quotes — the procedure must strip them
    await mockLLMResponse(
      '"Hey Maria! Still thinking about that San Antonio home? Let\'s chat 😊"'
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

  it("strips surrounding single-quotes from the LLM response", async () => {
    await mockLLMResponse("'Hey Abby! Hope you're having a great week 😊'");

    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.ai.draftSms({
      leadName: "Abby Chen",
      leadCity: "Austin",
      daysStale: 14,
    });

    expect(result.draft).not.toMatch(/^'/);
    expect(result.draft).not.toMatch(/'$/);
    expect(result.draft).toContain("Hey Abby");
  });

  it("uses notes in the prompt when notes are provided", async () => {
    const { invokeLLM } = await import("./_core/llm");
    const mockInvokeLLM = vi.mocked(invokeLLM);
    mockInvokeLLM.mockResolvedValueOnce({
      id: "mock-id",
      created: Date.now(),
      model: "mock-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Hey John! I saw you were looking at 3BR homes near the Riverwalk — anything catch your eye?",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 60, completion_tokens: 25, total_tokens: 85 },
    });

    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await caller.ai.draftSms({
      leadName: "John Smith",
      leadCity: "San Antonio",
      daysStale: 17,
      assignedAgent: "Peter",
      notes: "Interested in 3BR near Riverwalk, budget $400k",
    });

    expect(mockInvokeLLM).toHaveBeenCalledOnce();
    const callArgs = mockInvokeLLM.mock.calls[0]?.[0];
    // The user prompt should reference the notes
    const userMsg = callArgs?.messages.find((m: { role: string }) => m.role === "user")?.content as string;
    expect(userMsg).toContain("Interested in 3BR near Riverwalk");
  });
});
