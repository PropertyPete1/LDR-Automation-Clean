import { describe, expect, it } from "vitest";

/**
 * Tests for the legacy safeguard in botEngine.ts.
 * Post-migration: most legacy slugs now have legacyRetired=true, so the engine
 * correctly ALLOWS them. Only slugs that are still legacyRetired=false (laila)
 * should be blocked.
 */

import { runEngineForAgent, getActiveEngineAgents, isLegacyBot } from "./botEngine";
import { getDb } from "./db";
import { agentBots } from "../drizzle/schema";
import { eq } from "drizzle-orm";

// Slugs that have been migrated (legacyRetired=true) — engine should NOT block them
const MIGRATED_SLUGS = [
  "sp500_peter",
  "sp500_steven",
  "tiffany",
  "stefanie",
  "irma",
];

// Slugs still on legacy (legacyRetired=false) — engine should block them
const STILL_LEGACY_SLUGS = ["laila"];

// Offboarded slugs (legacyRetired=true but engineActive=false) — not blocked but not active
const OFFBOARDED_SLUGS = ["abby", "jason"];

describe("botEngine legacy safeguard", () => {
  it("migrated slugs are in LEGACY_BOT_SLUGS but have legacyRetired=true so engine allows them", async () => {
    const db = await getDb();
    for (const slug of MIGRATED_SLUGS) {
      // Confirm they are legacy slugs
      expect(isLegacyBot(slug)).toBe(true);
      // Confirm their DB row has legacyRetired=true (so isBlockedLegacy returns false)
      const [agent] = await db!.select().from(agentBots).where(eq(agentBots.botSlug, slug)).limit(1);
      expect(agent).toBeTruthy();
      expect(agent.legacyRetired).toBe(true);
      expect(agent.engineActive).toBe(true);
    }
  });

  it("runEngineForAgent throws BLOCKED for still-legacy slugs (laila)", async () => {
    for (const slug of STILL_LEGACY_SLUGS) {
      await expect(runEngineForAgent(slug)).rejects.toThrow(
        /BLOCKED.*legacy hardcoded bot/
      );
    }
  });

  it("offboarded agents are not blocked but are not engine-active", async () => {
    for (const slug of OFFBOARDED_SLUGS) {
      try {
        await runEngineForAgent(slug);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toMatch(/BLOCKED.*legacy hardcoded bot/);
        expect(msg).toMatch(/not engine-active/);
      }
    }
  });

  it("getActiveEngineAgents returns only engine-active agents", async () => {
    const agents = await getActiveEngineAgents();
    for (const agent of agents) {
      // All returned agents should have engineActive=true
      expect(agent.engineActive).toBe(true);
      // None should be offboarded
      expect(OFFBOARDED_SLUGS).not.toContain(agent.botSlug);
    }
  });
});
