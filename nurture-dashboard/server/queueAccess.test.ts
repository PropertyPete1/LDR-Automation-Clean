import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// ── Mocks ────────────────────────────────────────────────────────────────────

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
    anthropicApiKey: "sk-ant-test",
  },
}));

vi.mock("./agentRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agentRegistry")>();
  return {
    ...actual,
    getActiveAgents: vi.fn().mockResolvedValue([
      { name: "Peter", slug: "peter", role: "Agent", fubUserId: 2 },
      { name: "Steven", slug: "steven", role: "Agent", fubUserId: 1 },
      { name: "Tiffany", slug: "tiffany", role: "Agent", fubUserId: 20 },
      { name: "Laila", slug: "laila", role: "Agent", fubUserId: 35 },
      { name: "Jason", slug: "jason", role: "Agent", fubUserId: 37 },
    ]),
    getBotStatusRoster: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn().mockResolvedValue({
    choices: [{ message: { content: "mock response" } }],
  }),
}));

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
    logUiError: vi.fn().mockResolvedValue(undefined),
    getSmsSentTodayByAgent: vi.fn().mockResolvedValue(0),
    getSmsSentLastWeekByAgent: vi.fn().mockResolvedValue(0),
    getRecentBotRuns: vi.fn().mockResolvedValue([]),
    getRecentMonitorRuns: vi.fn().mockResolvedValue([]),
    insertMonitorLog: vi.fn().mockResolvedValue(undefined),
    getRecentObservations: vi.fn().mockResolvedValue([]),
    markObservationFixed: vi.fn().mockResolvedValue(undefined),
    getDb: vi.fn().mockReturnValue(null),
    snoozeLead: vi.fn().mockResolvedValue(undefined),
    unsnoozeLead: vi.fn().mockResolvedValue(undefined),
    markSnoozeNoteWritten: vi.fn().mockResolvedValue(undefined),
    getActiveSnoozesForAgent: vi.fn().mockResolvedValue([]),
    getSnoozeCount: vi.fn().mockResolvedValue(0),
    recordQueueAction: vi.fn().mockResolvedValue(undefined),
    getWeeklyQueueStats: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("./dashboardData", () => ({
  getDashboardStats: vi.fn().mockResolvedValue({ totalLeads: 0, agents: [] }),
  getAgentLeads: vi.fn().mockResolvedValue([]),
  getPendingQueue: vi.fn().mockResolvedValue({ leads: [], total: 0 }),
  getAgentRoster: vi.fn().mockResolvedValue([]),
  clearRosterCache: vi.fn(),
  clearQueueCache: vi.fn(),
  clearDashboardCache: vi.fn(),
  recordSmsSentToday: vi.fn().mockResolvedValue(undefined),
  getPondSmsOnlyLeads: vi.fn().mockResolvedValue([]),
}));

vi.mock("./compliance", () => ({
  suppressLead: vi.fn().mockResolvedValue({ success: true }),
  isLeadSuppressed: vi.fn().mockResolvedValue(false),
  getSuppressionList: vi.fn().mockResolvedValue([]),
}));

vi.mock("./botMonitor", () => ({
  runBotMonitor: vi.fn().mockResolvedValue({
    ranAt: new Date().toISOString(),
    checksRun: 10,
    issuesFound: 0,
    issuesFixed: 0,
    findings: [],
    summary: "All clear",
    triggeredBy: "manual",
    durationMs: 100,
  }),
}));

vi.mock("./bounceHandler", () => ({
  runBounceHandler: vi.fn().mockResolvedValue({ processed: 0, bounced: 0 }),
}));

vi.mock("./lifestyleBot", () => ({
  runLifestyleBot: vi.fn().mockResolvedValue({ sent: 0, skipped: 0 }),
}));

vi.mock("./autoPondPromotion", () => ({
  runAutoPondPromotion: vi.fn().mockResolvedValue({ promoted: 0 }),
  getRecentPondPromotionRuns: vi.fn().mockResolvedValue([]),
}));

vi.mock("./memoryLayer", () => ({
  getLeadMemories: vi.fn().mockResolvedValue([]),
  formatMemoriesForContext: vi.fn().mockReturnValue(""),
  autoExtractAndStore: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ people: [], textMessages: [], notes: [] }),
});
vi.stubGlobal("fetch", mockFetch);

// ── Helpers ──────────────────────────────────────────────────────────────────

function createCtx(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

function caller() {
  return appRouter.createCaller(createCtx());
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Security Hardening: resolveQueueAccess gating", () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. MUTATIONS → ADMIN-TOKEN-GATED
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Admin-gated mutations reject without valid token", () => {
    it("bot.runNow rejects without adminToken", async () => {
      await expect(caller().bot.runNow({})).rejects.toThrow("Admin token required");
    });

    it("bot.runNow succeeds with valid adminToken (passes access gate)", async () => {
      // The access gate passes; downstream runLifestyleBot is mocked
      const result = await caller().bot.runNow({ adminToken: "test_admin_token" });
      expect(result).toBeDefined();
    });

    it("bot.runMonitorNow rejects without adminToken", async () => {
      await expect(caller().bot.runMonitorNow({})).rejects.toThrow("Admin token required");
    });

    it("bot.runAutoPondNow rejects without adminToken", async () => {
      await expect(caller().bot.runAutoPondNow({})).rejects.toThrow("Admin token required");
    });

    it("bot.runBounceNow rejects without adminToken", async () => {
      await expect(caller().bot.runBounceNow({})).rejects.toThrow("Admin token required");
    });

    it("bot.markObsFixed rejects without adminToken", async () => {
      await expect(
        caller().bot.markObsFixed({ id: 1 })
      ).rejects.toThrow("Admin token required");
    });

    it("agent.refreshRoster rejects without adminToken", async () => {
      await expect(caller().agent.refreshRoster({})).rejects.toThrow("Admin token required");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. LEAD-PII READS → AGENT-SCOPED
  // ═══════════════════════════════════════════════════════════════════════════

  describe("PII reads reject without agent or admin context", () => {
    it("leads.getNotes rejects with no params", async () => {
      await expect(
        caller().leads.getNotes({ personId: 123 })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("leads.getNotes succeeds with valid agent", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ notes: [] }),
      });
      const result = await caller().leads.getNotes({ personId: 123, agent: "Steven" });
      expect(result).toBeDefined();
    });

    it("leads.getNotes succeeds with valid adminToken", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ notes: [] }),
      });
      const result = await caller().leads.getNotes({ personId: 123, adminToken: "test_admin_token" });
      expect(result).toBeDefined();
    });

    it("leads.getLastInbound rejects with no params", async () => {
      await expect(
        caller().leads.getLastInbound({ personId: 123 })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("leads.getLastInbound succeeds with valid agent", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ textMessages: [] }),
      });
      const result = await caller().leads.getLastInbound({ personId: 123, agent: "Jason" });
      expect(result).toBeDefined();
    });

    it("fub.getLatestInboundSms rejects with no params", async () => {
      await expect(
        caller().fub.getLatestInboundSms({ personId: 123 })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("fub.getLatestInboundSms succeeds with valid agent", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ textMessages: [] }),
      });
      const result = await caller().fub.getLatestInboundSms({ personId: 123, agent: "Tiffany" });
      expect(result).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. STATS/ROSTER → SCOPED
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Stats and roster endpoints are scoped", () => {
    it("agent.getRoster rejects with no params", async () => {
      await expect(
        caller().agent.getRoster({})
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("agent.getRoster succeeds with valid agent", async () => {
      const result = await caller().agent.getRoster({ agent: "Steven" });
      expect(result).toBeDefined();
    });

    it("agent.getRoster succeeds with valid adminToken", async () => {
      const result = await caller().agent.getRoster({ adminToken: "test_admin_token" });
      expect(result).toBeDefined();
    });

    it("fub.getDashboardStats rejects with no params", async () => {
      await expect(
        caller().fub.getDashboardStats({})
      ).rejects.toThrow("Admin token required");
    });

    it("fub.getDashboardStats succeeds with valid adminToken", async () => {
      const result = await caller().fub.getDashboardStats({ adminToken: "test_admin_token" });
      expect(result).toBeDefined();
    });

    it("agent.getLeads rejects with no params", async () => {
      await expect(
        caller().agent.getLeads({ agentName: "Steven" })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("agent.getLeads succeeds with valid agent", async () => {
      const result = await caller().agent.getLeads({ agentName: "Steven", agent: "Steven" });
      expect(result).toBeDefined();
    });

    it("leads.getWeeklyStats rejects with no params", async () => {
      await expect(
        caller().leads.getWeeklyStats({})
      ).rejects.toThrow("Admin token required");
    });

    it("leads.getWeeklyStats succeeds with valid adminToken", async () => {
      const result = await caller().leads.getWeeklyStats({ adminToken: "test_admin_token" });
      expect(result).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. AI ENDPOINTS → SCOPED
  // ═══════════════════════════════════════════════════════════════════════════

  describe("AI endpoints require agent or admin context", () => {
    it("ai.draftSms rejects with no params", async () => {
      await expect(
        caller().ai.draftSms({ leadName: "Test", assignedAgent: "Steven" })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("ai.draftSms succeeds with valid agent", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({
          id: "msg_mock", type: "message", role: "assistant",
          content: [{ type: "text", text: "Hey Test!" }],
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 50, output_tokens: 20 },
        }),
      });
      const result = await caller().ai.draftSms({
        leadName: "Test",
        assignedAgent: "Steven",
        agent: "Steven",
      });
      expect(result).toHaveProperty("draft");
    });

    it("ai.chat rejects with no params", async () => {
      await expect(
        caller().ai.chat({ messages: [{ role: "user", content: "Hello" }] })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("ai.chat succeeds with valid agent", async () => {
      const result = await caller().ai.chat({
        messages: [{ role: "user", content: "Hello" }],
        agent: "Steven",
      });
      expect(result).toHaveProperty("content");
    });

    it("ai.draftReply rejects with no params", async () => {
      await expect(
        caller().ai.draftReply({ leadName: "Test", inboundMessage: "Hi" })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("ai.draftReply succeeds with valid adminToken", async () => {
      const result = await caller().ai.draftReply({
        leadName: "Test",
        inboundMessage: "Hi",
        adminToken: "test_admin_token",
      });
      expect(result).toHaveProperty("draft");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. COPILOT ENDPOINTS → SCOPED
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Copilot endpoints require agent or admin context", () => {
    it("copilot.saveMemory rejects with no params", async () => {
      await expect(
        caller().copilot.saveMemory({
          agentName: "Steven",
          memoryText: "test",
          category: "market_knowledge",
          importanceScore: 3,
        })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("copilot.saveMemory succeeds with valid agent", async () => {
      const result = await caller().copilot.saveMemory({
        agentName: "Steven",
        memoryText: "test",
        category: "market_knowledge",
        importanceScore: 3,
        agent: "Steven",
      });
      expect(result).toEqual({ success: true });
    });

    it("copilot.logFeedback rejects with no params", async () => {
      await expect(
        caller().copilot.logFeedback({
          agentName: "Steven",
          draftText: "test",
          draftType: "outbound",
          action: "sent",
        })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("copilot.logFeedback succeeds with valid agent", async () => {
      const result = await caller().copilot.logFeedback({
        agentName: "Steven",
        draftText: "test",
        draftType: "outbound",
        action: "sent",
        agent: "Steven",
      });
      expect(result).toEqual({ success: true });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. COMPLIANCE → SCOPED
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Compliance endpoints require agent or admin context", () => {
    it("compliance.markUnsubscribe rejects with no params", async () => {
      await expect(
        caller().compliance.markUnsubscribe({ personId: 123 })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("compliance.markUnsubscribe succeeds with valid agent", async () => {
      const result = await caller().compliance.markUnsubscribe({
        personId: 123,
        agent: "Steven",
      });
      expect(result).toBeDefined();
    });

    it("compliance.isLeadSuppressed rejects with no params", async () => {
      await expect(
        caller().compliance.isLeadSuppressed({ personId: 123 })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("compliance.getSuppressionList rejects with no params", async () => {
      await expect(
        caller().compliance.getSuppressionList({})
      ).rejects.toThrow("Admin token required");
    });

    it("compliance.getSuppressionList succeeds with valid adminToken", async () => {
      const result = await caller().compliance.getSuppressionList({ adminToken: "test_admin_token" });
      expect(result).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. MUTATIONS THAT WRITE STATE → AGENT-SCOPED
  // ═══════════════════════════════════════════════════════════════════════════

  describe("State-writing mutations require agent or admin context", () => {
    it("leads.logSentNote rejects with no params", async () => {
      await expect(
        caller().leads.logSentNote({ personId: 123, agentName: "Steven" })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("leads.logSentNote succeeds with valid agent", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 201, headers: { get: () => null },
        json: async () => ({ id: 1 }),
      });
      const result = await caller().leads.logSentNote({
        personId: 123,
        agentName: "Steven",
        agent: "Steven",
      });
      expect(result).toEqual({ success: true });
    });

    it("leads.snoozeLead rejects with no params", async () => {
      await expect(
        caller().leads.snoozeLead({ personId: 123, agentName: "Steven", snoozeUntil: "2026-08-01" })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("leads.snoozeLead succeeds with valid agent", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 201, headers: { get: () => null },
        json: async () => ({ id: 1 }),
      });
      const result = await caller().leads.snoozeLead({
        personId: 123,
        agentName: "Steven",
        snoozeUntil: "2026-08-01",
        agent: "Steven",
      });
      expect(result).toBeDefined();
    });

    it("leads.unsnoozeLead rejects with no params", async () => {
      await expect(
        caller().leads.unsnoozeLead({ personId: 123, agentName: "Steven" })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("leads.recordAction rejects with no params", async () => {
      await expect(
        caller().leads.recordAction({
          personId: 123,
          agentName: "Steven",
          actionType: "texted",
        })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("leads.recordAction succeeds with valid agent", async () => {
      const result = await caller().leads.recordAction({
        personId: 123,
        agentName: "Steven",
        actionType: "texted",
        agent: "Steven",
      });
      expect(result).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. INVALID AGENT NAME → DENIED
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Invalid agent names are rejected", () => {
    it("rejects a non-roster agent name", async () => {
      await expect(
        caller().leads.getNotes({ personId: 123, agent: "hacker" })
      ).rejects.toThrow("Valid agent or admin token required");
    });

    it("rejects an invalid admin token", async () => {
      await expect(
        caller().bot.runNow({ adminToken: "wrong_token" })
      ).rejects.toThrow("Admin token required");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. BOT STATUS/HISTORY → ADMIN-GATED
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Bot status and history are admin-gated", () => {
    it("bot.getStatus rejects without adminToken", async () => {
      await expect(caller().bot.getStatus({})).rejects.toThrow("Admin token required");
    });

    it("bot.getStatus succeeds with valid adminToken (passes access gate)", async () => {
      // The access gate passes; downstream DB helpers return mocked arrays
      const { getSmsSentTodayByAgent, getSmsSentLastWeekByAgent } = await import("./db");
      vi.mocked(getSmsSentTodayByAgent).mockResolvedValueOnce([]);
      vi.mocked(getSmsSentLastWeekByAgent).mockResolvedValueOnce([]);
      // getBotStatusRoster must return an array of strings
      const { getBotStatusRoster } = await import("./agentRegistry");
      vi.mocked(getBotStatusRoster).mockReturnValueOnce(["Steven", "Peter"]);
      const result = await caller().bot.getStatus({ adminToken: "test_admin_token" });
      expect(result).toBeDefined();
      expect(result).toHaveProperty("agents");
    });

    it("bot.getRunHistory rejects without adminToken", async () => {
      await expect(caller().bot.getRunHistory({})).rejects.toThrow("Admin token required");
    });

    it("bot.getObservations rejects without adminToken", async () => {
      await expect(caller().bot.getObservations({})).rejects.toThrow("Admin token required");
    });

    it("bot.getPondPromotionHistory rejects without adminToken", async () => {
      await expect(caller().bot.getPondPromotionHistory({})).rejects.toThrow("Admin token required");
    });
  });
});
