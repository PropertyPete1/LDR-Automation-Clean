/**
 * registryPropagation.test.ts — Golden Rule verification for lifestyle-bot-dashboard.
 *
 * The Golden Rule: adding an agent to the agent_bots table must propagate to
 * the Power Queue link, the dashboard slug, and the Bot Monitor watched list
 * with ZERO code changes. These tests exercise the pure resolution functions
 * that back those paths (the DB-reading wrappers just feed rows into them).
 */
import { describe, expect, it } from "vitest";
import {
  derivePowerQueueName,
  deriveDashboardSlug,
} from "./botHelpers";
import { buildWatchedBotList } from "./botMonitor";

describe("Power Queue name resolution (Golden Rule)", () => {
  it("Jason's clock-in resolves to Power Queue agent=Jason from his agent_bots row", () => {
    const jasonRow = { botSlug: "jason", powerQueueName: null, agentFirstName: "Jason" };
    const pqName = derivePowerQueueName(jasonRow, "Jason");
    expect(pqName).toBe("Jason");
    // The clock-in email builds: OLD_DASHBOARD_BASE/sms-queue?agent=<encoded pqName>
    expect(`/sms-queue?agent=${encodeURIComponent(pqName)}`).toBe("/sms-queue?agent=Jason");
  });

  it("a brand-new TestAgent row propagates with no code change", () => {
    const testRow = { botSlug: "testagent", powerQueueName: null, agentFirstName: "TestAgent" };
    expect(derivePowerQueueName(testRow, "TestAgent")).toBe("TestAgent");
    expect(deriveDashboardSlug(undefined, testRow, "TestAgent")).toBe("testagent");
  });

  it("powerQueueName override on the row wins (e.g. Rue bot → Stefanie)", () => {
    const rueRow = { botSlug: "stefanie", powerQueueName: "Stefanie", agentFirstName: "Rue" };
    expect(derivePowerQueueName(rueRow, "Rue")).toBe("Stefanie");
  });

  it("falls back to the legacy static map only when no row exists", () => {
    // No agent_bots row → legacy fallback map still resolves the original agents
    expect(derivePowerQueueName(null, "Laila")).toBe("Laila");
    expect(derivePowerQueueName(null, "rue")).toBe("Stefanie");
    // Unknown agent with no row and no fallback → title-cased first name (never crashes)
    expect(derivePowerQueueName(null, "newperson")).toBe("Newperson");
  });
});

describe("Dashboard slug resolution (Golden Rule)", () => {
  it("prefers explicit botSlug, then the agent_bots row, then the fallback map", () => {
    expect(deriveDashboardSlug("explicit", { botSlug: "row" }, "Tiffany")).toBe("explicit");
    expect(deriveDashboardSlug(undefined, { botSlug: "row" }, "Tiffany")).toBe("row");
    expect(deriveDashboardSlug(undefined, null, "tiffany")).toBe("tiffany"); // fallback map
    expect(deriveDashboardSlug(undefined, null, "unknownagent")).toBeNull();
  });
});

describe("Bot Monitor watched list (Golden Rule)", () => {
  it("builds the watched list dynamically from agent_bots rows", () => {
    const rows = [
      { botSlug: "jason", botName: "Jason's Lifestyle Bot" },
      { botSlug: "testagent", botName: "TestAgent's Lifestyle Bot" },
    ];
    const watched = buildWatchedBotList(rows);
    expect(watched).toEqual([
      { slug: "jason", name: "Jason's Lifestyle Bot" },
      { slug: "testagent", name: "TestAgent's Lifestyle Bot" },
    ]);
    // TestAgent is now monitored with zero code change
    expect(watched.map(w => w.slug)).toContain("testagent");
  });

  it("falls back to the static list only when agent_bots is empty/unreachable", () => {
    const fallback = buildWatchedBotList([]);
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback.map(b => b.slug)).toContain("jason");
  });
});
