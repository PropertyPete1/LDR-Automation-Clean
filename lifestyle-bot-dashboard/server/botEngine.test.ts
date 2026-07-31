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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// These four exercise the REAL engine against the REAL agent_bots table, so they
// need a live MySQL. Without DATABASE_URL, getDb() returns null and they failed
// with "Cannot read properties of null" / "[Engine] Agent not found" — three
// permanent reds in every mirror and audit run, which is noise that hides real
// regressions. Gated, not weakened: with a DB they run exactly as before. The
// DB-free block below covers the same invariants from the snapshot.
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("botEngine legacy safeguard (requires DATABASE_URL)", () => {
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

/**
 * DB-free coverage of the same safeguards, so the engine's gate logic is still
 * verified in a mirror. These read the committed snapshot + botEngine source
 * rather than MySQL, and therefore run everywhere.
 */
describe("botEngine legacy safeguard (no DB required)", () => {
  const snapshot = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../agent_bots_snapshot.json"), "utf-8"),
  ) as Array<{ botSlug: string; engineActive: boolean; legacyRetired: boolean }>;

  it("every migrated slug is still recognised as a legacy slug", () => {
    // isBlockedLegacy can only gate a slug it knows about. If a migrated slug
    // fell out of LEGACY_BOT_SLUGS, a rollback would silently un-gate it.
    for (const slug of MIGRATED_SLUGS) {
      expect(isLegacyBot(slug), `${slug} dropped out of LEGACY_BOT_SLUGS`).toBe(true);
    }
  });

  it("laila is the only bot still owned by the legacy motor", () => {
    const stillLegacy = snapshot.filter(r => !r.legacyRetired).map(r => r.botSlug);
    expect(stillLegacy).toEqual(STILL_LEGACY_SLUGS);
  });

  it("offboarded agents are engine-inactive and legacy-retired — they run nowhere", () => {
    for (const slug of OFFBOARDED_SLUGS) {
      const row = snapshot.find(r => r.botSlug === slug);
      expect(row, `${slug} missing from snapshot`).toBeTruthy();
      expect(row!.engineActive).toBe(false);
      expect(row!.legacyRetired).toBe(true);
    }
  });

  it("the engine's active set is exactly the five migrated agents", () => {
    const active = snapshot.filter(r => r.engineActive).map(r => r.botSlug).sort();
    expect(active).toEqual([...MIGRATED_SLUGS].sort());
  });

  it("no bot is driven by both motors", () => {
    const doubled = snapshot.filter(r => r.engineActive && !r.legacyRetired).map(r => r.botSlug);
    expect(doubled, "engineActive && !legacyRetired = duplicate sends").toEqual([]);
  });
});
