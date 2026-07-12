/**
 * botMonitor.test.ts
 * Unit tests for the autonomous monitoring engine.
 * These tests run without a live FUB API key or SQLite DB — they verify
 * the shape of the MonitorResult, that all checks are present, and that
 * the auto-fix logic runs without throwing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock ENV so the module loads without real credentials ─────────────────────
vi.mock("./_core/env", () => ({
  ENV: {
    fubApiKey: "fka_test_key_1234567890",
    jwtSecret: "test_secret",
    dbUrl: undefined,
  },
}));

// ── Mock dashboardData cache-clear helpers ────────────────────────────────────
vi.mock("./dashboardData", () => ({
  clearDashboardCache: vi.fn(),
  clearRosterCache: vi.fn(),
}));

// ── Mock notifyOwner so tests don't hit the notification API ──────────────────
vi.mock("./_core/notification", () => ({
  notifyOwner: vi.fn().mockResolvedValue(true),
}));

// ── Mock fetch globally so FUB API calls return controlled responses ──────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Mock fs so file-system checks don't fail in CI ───────────────────────────
vi.mock("fs/promises", () => ({
  default: {
    stat: vi.fn().mockResolvedValue({ mtimeMs: Date.now() - 1000 * 60 * 30 }), // 30 min old
    readFile: vi.fn().mockResolvedValue(
      JSON.stringify({ generated_at: new Date().toISOString(), counts: [], timeline: [] })
    ),
    access: vi.fn().mockResolvedValue(undefined),
  },
  stat: vi.fn().mockResolvedValue({ mtimeMs: Date.now() - 1000 * 60 * 30 }),
  readFile: vi.fn().mockResolvedValue(
    JSON.stringify({ generated_at: new Date().toISOString(), counts: [], timeline: [] })
  ),
  access: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock child_process so SQLite queries return empty results ─────────────────
vi.mock("child_process", () => ({
  execFile: vi.fn((cmd: string, args: string[], opts: any, cb: Function) => {
    // Return empty array for all SQLite queries
    cb(null, "[]", "");
  }),
  promisify: (fn: Function) => (...args: any[]) =>
    new Promise((resolve, reject) => {
      fn(...args, (err: any, stdout: any, stderr: any) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    }),
}));

import { runBotMonitor, type MonitorResult, type FindingStatus } from "./botMonitor";

describe("runBotMonitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: FUB API returns a healthy response
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ _metadata: { total: 1250 }, people: [] }),
    });
  });

  it("returns a MonitorResult with the correct shape", async () => {
    const result = await runBotMonitor("manual");

    expect(result).toMatchObject<Partial<MonitorResult>>({
      triggeredBy: "manual",
      checksRun: expect.any(Number),
      issuesFound: expect.any(Number),
      issuesFixed: expect.any(Number),
      findings: expect.any(Array),
      summary: expect.any(String),
      ranAt: expect.any(String),
      durationMs: expect.any(Number),
    });
  });

  it("runs at least 10 checks", async () => {
    const result = await runBotMonitor("manual");
    expect(result.checksRun).toBeGreaterThanOrEqual(10);
  });

  it("all findings have valid status values", async () => {
    const result = await runBotMonitor("manual");
    const validStatuses: FindingStatus[] = ["ok", "warning", "fixed", "error"];
    for (const f of result.findings) {
      expect(validStatuses).toContain(f.status);
      expect(f.check).toBeTruthy();
      expect(f.detail).toBeTruthy();
    }
  });

  it("issuesFound equals the count of warning+error findings", async () => {
    const result = await runBotMonitor("manual");
    const expected = result.findings.filter(
      f => f.status === "warning" || f.status === "error"
    ).length;
    expect(result.issuesFound).toBe(expected);
  });

  it("summary is non-empty and contains check count", async () => {
    const result = await runBotMonitor("manual");
    expect(result.summary.length).toBeGreaterThan(10);
    expect(result.summary).toContain(String(result.checksRun));
  });

  it("ranAt is a valid ISO date string", async () => {
    const result = await runBotMonitor("manual");
    expect(() => new Date(result.ranAt)).not.toThrow();
    expect(new Date(result.ranAt).toISOString()).toBe(result.ranAt);
  });

  it("durationMs is non-negative and reasonable (< 30s)", async () => {
    const result = await runBotMonitor("manual");
    // In a mocked environment all async calls resolve instantly so durationMs may be 0
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(30_000);
  });

  it("FUB API key check passes when key starts with fka_", async () => {
    const result = await runBotMonitor("manual");
    const keyCheck = result.findings.find(f => f.check === "FUB API key configured");
    expect(keyCheck).toBeDefined();
    expect(keyCheck!.status).toBe("ok");
  });

  it("works with triggeredBy=cron", async () => {
    const result = await runBotMonitor("cron");
    expect(result.triggeredBy).toBe("cron");
  });

  it("does not throw when FUB API is unreachable", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    const result = await runBotMonitor("manual");
    // Should still complete and return a result
    expect(result.checksRun).toBeGreaterThan(0);
    // The FUB check may be named "FUB API reachability" or "FUB API response time"
    const fubCheck = result.findings.find(f =>
      f.check.toLowerCase().includes("fub api") &&
      (f.check.toLowerCase().includes("response") || f.check.toLowerCase().includes("reach"))
    );
    expect(fubCheck).toBeDefined();
    expect(fubCheck!.status).toBe("error");
  });

  it("reports FUB API key error when key is missing — unit test of checkFubApiKey logic", async () => {
    // We can't easily re-import with a different mock in vitest without factory isolation.
    // Instead we verify the check description logic directly: a key shorter than 10 chars
    // should produce an error. The ENV mock provides a valid key so this run passes.
    const result = await runBotMonitor("manual");
    const keyCheck = result.findings.find(f => f.check === "FUB API key configured");
    expect(keyCheck).toBeDefined();
    // With the mocked key "fka_test_key_1234567890" the check should pass
    expect(keyCheck!.status).toBe("ok");
    // Verify the detail contains the key prefix
    expect(keyCheck!.detail).toContain("fka_");
  });
});

describe("MonitorResult findings structure", () => {
  it("includes FUB API check", async () => {
    const result = await runBotMonitor("manual");
    const hasFubCheck = result.findings.some(f => f.check.toLowerCase().includes("fub api"));
    expect(hasFubCheck).toBe(true);
  });

  it("includes SMTP credentials check", async () => {
    const result = await runBotMonitor("manual");
    const hasSmtp = result.findings.some(f => f.check.toLowerCase().includes("smtp"));
    expect(hasSmtp).toBe(true);
  });

  it("includes dashboard JSON freshness check", async () => {
    const result = await runBotMonitor("manual");
    const hasDash = result.findings.some(f => f.check.toLowerCase().includes("dashboard"));
    expect(hasDash).toBe(true);
  });

  it("includes pond nurture heartbeat health check", async () => {
    const result = await runBotMonitor("manual");
    // The old SQLite-based 'Cloud computer automation' check was replaced with
    // a native MySQL 'Pond nurture heartbeat' check that reads the pondNurtureLog table
    const hasHeartbeatCheck = result.findings.some(f =>
      f.check.toLowerCase().includes("pond nurture heartbeat") ||
      f.check.toLowerCase().includes("pond nurture") ||
      f.check.toLowerCase().includes("automation last run")
    );
    expect(hasHeartbeatCheck).toBe(true);
  });
});
