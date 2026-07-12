import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db functions used by bot.getStatus
vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getSmsSentTodayByAgent: vi.fn().mockResolvedValue([
      { agentName: "Peter", todayTexts: 12 },
      { agentName: "Lifestyle Bot", todayTexts: 8 },
    ]),
    getSmsSentLastWeekByAgent: vi.fn().mockResolvedValue([
      { agentName: "Peter", weekTexts: 60 },
      { agentName: "Lifestyle Bot", weekTexts: 40 },
    ]),
  };
});

// Mock lifestyleBot to avoid real FUB calls
vi.mock("./lifestyleBot", () => ({
  runLifestyleBot: vi.fn().mockResolvedValue({
    ranAt: new Date().toISOString(),
    leadsProcessed: 3,
    leadsSkipped: 2,
    leadsErrored: 0,
    durationMs: 1200,
    summaryEmailSent: true,
    results: [],
  }),
}));

import { getSmsSentTodayByAgent, getSmsSentLastWeekByAgent } from "./db";

describe("bot.getStatus logic", () => {
  const ROSTER = ["Peter", "Steven", "Tiffany", "Stefanie", "Abby", "Irma", "Laila", "Lifestyle Bot"];
  const DAILY_GOAL = 10; // Updated: uniform soft target for all agents

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all 8 agents in the roster", async () => {
    const todayRows = await getSmsSentTodayByAgent();
    const weekRows = await getSmsSentLastWeekByAgent();

    const todayMap: Record<string, number> = {};
    for (const r of todayRows) todayMap[r.agentName] = r.todayTexts;
    const weekMap: Record<string, number> = {};
    for (const r of weekRows) weekMap[r.agentName] = r.weekTexts;

    const agents = ROSTER.map(name => ({
      name,
      isBot: name === "Lifestyle Bot",
      todayCount: todayMap[name] ?? 0,
      weekCount: weekMap[name] ?? 0,
      goal: DAILY_GOAL,
      pct: Math.min(100, Math.round(((todayMap[name] ?? 0) / DAILY_GOAL) * 100)),
    }));

    expect(agents).toHaveLength(8);
    expect(agents.find(a => a.name === "Lifestyle Bot")?.isBot).toBe(true);
    expect(agents.find(a => a.name === "Peter")?.isBot).toBe(false);
  });

  it("correctly maps today counts from DB rows", async () => {
    const todayRows = await getSmsSentTodayByAgent();
    const todayMap: Record<string, number> = {};
    for (const r of todayRows) todayMap[r.agentName] = r.todayTexts;

    expect(todayMap["Peter"]).toBe(12);
    expect(todayMap["Lifestyle Bot"]).toBe(8);
    expect(todayMap["Steven"]).toBeUndefined();
  });

  it("defaults to 0 for agents not in DB rows", async () => {
    const todayRows = await getSmsSentTodayByAgent();
    const todayMap: Record<string, number> = {};
    for (const r of todayRows) todayMap[r.agentName] = r.todayTexts;

    const agents = ROSTER.map(name => ({
      name,
      todayCount: todayMap[name] ?? 0,
    }));

    const steven = agents.find(a => a.name === "Steven");
    expect(steven?.todayCount).toBe(0);
  });

  it("calculates pct correctly and caps at 100", async () => {
    const pct = (count: number) => Math.min(100, Math.round((count / DAILY_GOAL) * 100));
    expect(pct(0)).toBe(0);
    expect(pct(10)).toBe(100);
    expect(pct(20)).toBe(100); // capped
    expect(pct(5)).toBe(50);
    expect(pct(8)).toBe(80);
  });

  it("computes totalToday and totalWeek correctly", async () => {
    const todayRows = await getSmsSentTodayByAgent();
    const weekRows = await getSmsSentLastWeekByAgent();

    const todayMap: Record<string, number> = {};
    for (const r of todayRows) todayMap[r.agentName] = r.todayTexts;
    const weekMap: Record<string, number> = {};
    for (const r of weekRows) weekMap[r.agentName] = r.weekTexts;

    const agents = ROSTER.map(name => ({
      todayCount: todayMap[name] ?? 0,
      weekCount: weekMap[name] ?? 0,
    }));

    const totalToday = agents.reduce((s, a) => s + a.todayCount, 0);
    const totalWeek = agents.reduce((s, a) => s + a.weekCount, 0);

    // Peter=12, LifestyleBot=8, rest=0 → 20
    expect(totalToday).toBe(20);
    // Peter=60, LifestyleBot=40, rest=0 → 100
    expect(totalWeek).toBe(100);
  });
});
