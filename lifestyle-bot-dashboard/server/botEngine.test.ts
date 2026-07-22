import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Tests for the legacy safeguard in botEngine.ts.
 * These drive the REAL runEngineForAgent() through the REAL isBlockedLegacy
 * gate with a mocked agent_bots row, so the test cannot pass if the gate
 * inside the entry function drifts (not a reimplementation).
 */

// ── Mock the DB so getAgentBySlug returns a controllable row ──────────────────
// The row's slug/flags are set per-test via `currentRow`.
let currentRow: { botSlug: string; legacyRetired: boolean; engineActive: boolean } | null = null;

vi.mock("./db", () => ({
  getDb: vi.fn(async () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (currentRow ? [currentRow] : []),
        }),
      }),
    }),
  })),
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(() => ({})), and: vi.fn(), desc: vi.fn(), gte: vi.fn() }));
vi.mock("../drizzle/schema", () => ({ agentBots: { botSlug: "botSlug", engineActive: "engineActive", legacyRetired: "legacyRetired" } }));
// writeObservation must not touch a real DB
vi.mock("./botHelpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./botHelpers")>();
  return { ...actual, writeObservation: vi.fn(async () => {}) };
});

import { runEngineForAgent, LEGACY_BOT_SLUGS } from "./botEngine";

const LEGACY_WITH_ROW = ["sp500_peter", "sp500_steven", "tiffany", "stefanie", "abby", "irma", "laila"];

beforeEach(() => { currentRow = null; });

describe("botEngine legacy safeguard (real gate, mocked row)", () => {
  it("BLOCKS every legacy slug whose row is engineActive but NOT retired", async () => {
    for (const slug of LEGACY_WITH_ROW) {
      currentRow = { botSlug: slug, engineActive: true, legacyRetired: false };
      await expect(runEngineForAgent(slug)).rejects.toThrow(/BLOCKED.*legacy hardcoded bot/);
    }
  });

  it("a legacy slug that IS retired is NOT blocked (migration complete)", async () => {
    // laila retired + engineActive → passes the legacy gate; fails later only if
    // downstream (FUB fetch) errors, but never with the BLOCKED message.
    currentRow = { botSlug: "laila", engineActive: true, legacyRetired: true };
    try {
      await runEngineForAgent("laila");
    } catch (err) {
      expect(String((err as Error).message)).not.toMatch(/BLOCKED.*legacy hardcoded bot/);
    }
  });

  it("a non-legacy slug (jason) is never BLOCKED by the legacy gate", async () => {
    currentRow = { botSlug: "jason", engineActive: true, legacyRetired: false };
    try {
      await runEngineForAgent("jason");
    } catch (err) {
      expect(String((err as Error).message)).not.toMatch(/BLOCKED.*legacy hardcoded bot/);
    }
  });

  it("a missing row is refused (never silently processed)", async () => {
    currentRow = null; // no agent_bots row
    await expect(runEngineForAgent("sp500")).rejects.toThrow(/Agent not found/);
  });

  it("LEGACY_BOT_SLUGS still contains every hardcoded bot slug", () => {
    for (const slug of [...LEGACY_WITH_ROW, "sp500"]) {
      expect(LEGACY_BOT_SLUGS.has(slug)).toBe(true);
    }
  });
});
