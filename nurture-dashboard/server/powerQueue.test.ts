import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDb, getCachedDraft, setCachedDraft, snoozeLead, unsnoozeLead, getActiveSnoozesForAgent, getSnoozeCount, recordQueueAction, getWeeklyQueueStats } from "./db";

describe("Power Queue 2.0 - SMS Draft Cache", () => {
  it("setCachedDraft stores and getCachedDraft retrieves", async () => {
    const personId = 99999;
    const agentName = "TestAgent";
    const draftText = "Hey John, still looking in Austin?";

    await setCachedDraft(personId, agentName, draftText);
    const cached = await getCachedDraft(personId, agentName);

    expect(cached).toBe(draftText);
  });

  it("getCachedDraft returns null for non-existent entry", async () => {
    const cached = await getCachedDraft(88888, "NonExistentAgent");
    expect(cached).toBeNull();
  });

  it("setCachedDraft overwrites existing cache for same lead/agent/day", async () => {
    const personId = 99998;
    const agentName = "TestAgent2";

    await setCachedDraft(personId, agentName, "First draft");
    await setCachedDraft(personId, agentName, "Second draft");

    const cached = await getCachedDraft(personId, agentName);
    expect(cached).toBe("Second draft");
  });
});

describe("Power Queue 2.0 - Snooze", () => {
  const personId = 77777;
  const agentName = "SnoozeTestAgent";
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const snoozeUntil = tomorrow.toISOString().slice(0, 10);

  it("snoozeLead creates a snooze entry", async () => {
    await snoozeLead(personId, agentName, snoozeUntil, "Testing", "Test Lead");

    const snoozes = await getActiveSnoozesForAgent(agentName);
    expect(snoozes.has(personId)).toBe(true);
    expect(snoozes.get(personId)).toBe(snoozeUntil);
  });

  it("getSnoozeCount returns correct count", async () => {
    // Add another snooze for same agent
    await snoozeLead(77778, agentName, snoozeUntil, undefined, "Lead 2");

    const count = await getSnoozeCount(agentName);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("unsnoozeLead removes the snooze", async () => {
    await unsnoozeLead(personId, agentName);

    const snoozes = await getActiveSnoozesForAgent(agentName);
    expect(snoozes.has(personId)).toBe(false);
  });
});

describe("Power Queue 2.0 - Queue Actions & Stats", () => {
  const personId = 66666;
  const agentName = "StatsTestAgent";

  it("recordQueueAction stores an action", async () => {
    await recordQueueAction(personId, agentName, "texted", 15, false);
    // No throw = success
    expect(true).toBe(true);
  });

  it("recordQueueAction stores a hot lead action", async () => {
    await recordQueueAction(66667, agentName, "hot_lead_responded", 18, true);
    expect(true).toBe(true);
  });

  it("getWeeklyQueueStats returns stats for current week", async () => {
    const stats = await getWeeklyQueueStats();
    expect(Array.isArray(stats)).toBe(true);

    // Should have at least one entry from the actions we just recorded
    const agentStat = stats.find((s: any) => s.agentName === agentName);
    if (agentStat) {
      expect(agentStat.totalActions).toBeGreaterThanOrEqual(2);
      expect(agentStat.hotLeadsResponded).toBeGreaterThanOrEqual(1);
    }
  });

  it("getWeeklyQueueStats with specific weekKey returns empty for future week", async () => {
    const futureWeek = "2099-W01";
    const stats = await getWeeklyQueueStats(futureWeek);
    expect(Array.isArray(stats)).toBe(true);
    expect(stats.length).toBe(0);
  });
});
