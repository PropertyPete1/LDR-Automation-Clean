import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the LLM helper
vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn().mockResolvedValue({
    choices: [{ message: { content: "Hey Sarah! Still thinking about homes in Austin? 😊" } }],
  }),
}));

// Mock fetch for FUB API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

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
  },
}));

// Mock authenticated user for protectedProcedure tests
const mockUser = {
  id: 1,
  openId: "test_open_id",
  name: "Test Agent",
  email: "test@lifestyledesignrealty.com",
  role: "user" as const,
  createdAt: new Date(),
};

describe("leads.logSentNote", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("posts a note to FUB with the correct payload", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ id: 12345 }),
    });

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({
      req: {} as any,
      res: {} as any,
      user: mockUser,
    });

    const result = await caller.leads.logSentNote({
      personId: 42,
      agentName: "Steven",
      messageBody: "Hey John, hope you're doing well!",
    });

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/notes");
    const body = JSON.parse(options.body);
    expect(body.personId).toBe(42);
    expect(body.subject).toContain("Steven");
    expect(body.body).toContain("Steven");
    expect(body.body).toContain("Hey John");
  });

  it("allows unauthenticated callers (publicProcedure: agents tap from email without login)", async () => {
    // logSentNote is now publicProcedure so agents can log notes when tapping
    // tap-to-text links from their email digest without needing to be logged in.
    // Spam protection: personId must be a positive integer; FUB rejects invalid IDs.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      headers: { get: () => null },
      json: async () => ({ id: 9999 }),
    });
    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({
      req: {} as any,
      res: {} as any,
      user: null, // unauthenticated — should now succeed
    });
    const result = await caller.leads.logSentNote({
      personId: 99,
      agentName: "Irma",
      messageBody: "Hey, just checking in!",
    });
    expect(result).toEqual({ success: true });
    // Confirm FUB was called
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/notes"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("logs note without messageBody when not provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ id: 12346 }),
    });

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({
      req: {} as any,
      res: {} as any,
      user: mockUser,
    });

    const result = await caller.leads.logSentNote({
      personId: 42,
      agentName: "Laila",
    });

    expect(result.success).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.body).toContain("Laila");
    expect(body.body).not.toContain("Message:");
  });

  it("normalizes 'Maria' to 'Laila' before storing (Laila's FUB last name guard)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ id: 12347 }),
    });

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({
      req: {} as any,
      res: {} as any,
      user: mockUser,
    });

    const result = await caller.leads.logSentNote({
      personId: 43,
      agentName: "Maria",
    });

    expect(result.success).toBe(true);
    // The FUB note body must use the normalized name "Laila", not the raw "Maria"
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.body).toContain("Laila");
    expect(body.body).not.toContain("Maria");
  });
});

describe("ai.draftReply", () => {
  it("drafts a reply to a lead's inbound message", async () => {
    const { invokeLLM } = await import("./_core/llm");
    vi.mocked(invokeLLM).mockResolvedValueOnce({
      choices: [{ message: { content: "Hey Sarah! That sounds great, let's set up a showing this weekend!" } }],
    } as any);

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({
      req: {} as any,
      res: {} as any,
      user: null,
    });

    const result = await caller.ai.draftReply({
      leadName: "Sarah",
      leadCity: "Austin",
      assignedAgent: "Steven",
      inboundMessage: "Hey I'm interested in seeing that house on Oak Street",
    });

    expect(result.draft).toBeTruthy();
    expect(typeof result.draft).toBe("string");
    expect(result.draft.length).toBeGreaterThan(0);
  });

  it("strips surrounding quotes from the draft", async () => {
    const { invokeLLM } = await import("./_core/llm");
    vi.mocked(invokeLLM).mockResolvedValueOnce({
      choices: [{ message: { content: '"Hey Mike, sounds great!"' } }],
    } as any);

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({
      req: {} as any,
      res: {} as any,
      user: null,
    });

    const result = await caller.ai.draftReply({
      leadName: "Mike",
      inboundMessage: "I want to buy a house",
    });

    expect(result.draft).toBe("Hey Mike, sounds great!");
    expect(result.draft.startsWith('"')).toBe(false);
  });
});

describe("leads.logSentNote email channel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("logs an email note with the correct subject and body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      headers: { get: () => null },
      json: async () => ({ id: 12347 }),
    });

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({
      req: {} as any,
      res: {} as any,
      user: null,
    });

    const result = await caller.leads.logSentNote({
      personId: 42,
      agentName: "Peter",
      messageBody: "Still looking for a home in Austin?",
      channel: "email",
    });

    expect(result.success).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.subject).toContain("Nurture Email Sent");
    expect(body.subject).toContain("Peter");
    expect(body.body).toContain("nurture email");
    expect(body.body).toContain("Still looking");
  });
});

// Mock the db module so smsSentToday returns an empty set in pagination tests
vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getSmsSentTodayIds: vi.fn().mockResolvedValue(new Set<number>()),
    dbRecordSmsSentToday: vi.fn().mockResolvedValue(undefined),
    getSmsSentTodayCount: vi.fn().mockResolvedValue(0),
    getSmsSentByAgent: vi.fn().mockResolvedValue([]),
  };
});

describe("getPendingQueue pagination — 100-result cap fix", () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    // Clear the module-level queueCache so each test starts with a fresh fetch
    const { clearQueueCache } = await import("./dashboardData");
    clearQueueCache();
  });

  it("fetches multiple pages when the first page is full (100 leads)", async () => {
    // Page 1: 100 leads, all created 5 days ago → within 1-20 day window
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 5000, // use high IDs to avoid collision with other tests
      firstName: `Lead${i + 1}`,
      lastName: "Test",
      stage: "Lead",
      tags: [],
      phones: [{ value: `+1512555${String(i).padStart(4, "0")}` }],
      assignedUserId: 20,
      created: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      lastActivity: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    // Page 2: 10 leads, all created 22 days ago → outside 1-20 day window, excluded
    const page2 = Array.from({ length: 10 }, (_, i) => ({
      id: i + 6000,
      firstName: `OldLead${i}`,
      lastName: "Test",
      stage: "Lead",
      tags: [],
      phones: [{ value: `+1512666${String(i).padStart(4, "0")}` }],
      assignedUserId: 20,
      created: new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString(),
      lastActivity: new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    // FUB /users call
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ users: [{ id: 20, name: "Tiffany Proske", firstName: "Tiffany" }] }),
    });
    // /people page 1 (offset=0)
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ people: page1 }),
    });
    // /people page 2 (offset=100) — all too old, triggers early exit
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ people: page2 }),
    });
    // notes and texts for enrichment — return empty to keep test fast
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ notes: [], textMessages: [] }),
    });

    const { getPendingQueue } = await import("./dashboardData");
    const result = await getPendingQueue("test_fub_key", "tiffany");

    // All 100 page-1 leads should be in the queue (5 days stale = within 1-20 window)
    // The 10 page-2 leads (22 days stale) should be excluded by the staleness filter
    expect(result.length).toBe(100);
    // Confirm pagination happened: /people was called at least twice
    const peopleCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      typeof url === "string" && url.includes("/people?")
    );
    expect(peopleCalls.length).toBeGreaterThanOrEqual(2);
    // Confirm offset=100 was used on the second people call
    const secondPeopleCall = peopleCalls.find(([url]: [string]) => url.includes("offset=100"));
    expect(secondPeopleCall).toBeDefined();
  });

  it("stops after one page when the page has fewer than 100 leads", async () => {
    const page1 = Array.from({ length: 30 }, (_, i) => ({
      id: i + 7000, // high IDs to avoid collision
      firstName: `Lead${i + 1}`,
      lastName: "Test",
      stage: "Lead",
      tags: [],
      phones: [{ value: `+1512777${String(i).padStart(4, "0")}` }],
      assignedUserId: 28,
      created: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      lastActivity: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ users: [{ id: 28, name: "Abby Martinez", firstName: "Abby" }] }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ people: page1 }),
    });
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ notes: [], textMessages: [] }),
    });

    const { getPendingQueue } = await import("./dashboardData");
    const result = await getPendingQueue("test_fub_key", "abby");

    // All 30 leads should be in the queue (3 days stale, no exclusions)
    expect(result.length).toBe(30);
    const peopleCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      typeof url === "string" && url.includes("/people?")
    );
    // Only one page fetch needed since page1 < 100 results
    expect(peopleCalls.length).toBe(1);
  });
});
