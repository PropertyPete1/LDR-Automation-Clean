import { describe, expect, it } from "vitest";

/**
 * Tests for the legacy safeguard in botEngine.ts.
 *
 * Post-migration AND post-deletion: all six agents are on the engine, and the
 * hardcoded legacy bot files are gone. The engine is the only motor that exists.
 */

import { runEngineForAgent, getActiveEngineAgents, isLegacyBot } from "./botEngine";
import { getDb } from "./db";
import { agentBots } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Slugs that have been migrated (legacyRetired=true) — engine should NOT block them
const MIGRATED_SLUGS = [
  "sp500_peter",
  "sp500_steven",
  "tiffany",
  "stefanie",
  "irma",
  "laila",
];

// Offboarded slugs (legacyRetired=true but engineActive=false) — not blocked but not active
const OFFBOARDED_SLUGS = ["abby", "jason"];

// These exercise the REAL engine against the REAL agent_bots table, so they need
// a live MySQL. Without DATABASE_URL getDb() returns null and they fail with
// "Cannot read properties of null" / "[Engine] Agent not found" rather than
// exercising the gate — permanent reds in every mirror and audit run, which is
// the noise that hides real regressions. Gated, not weakened: with a DB they run
// exactly as before, and the DB-free block below covers the same invariants.
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
 * verified in a mirror. These read the committed snapshot + the server directory
 * rather than MySQL, and therefore run everywhere.
 */
describe("botEngine legacy safeguard (no DB required)", () => {
  const serverDir = dirname(fileURLToPath(import.meta.url));
  const snapshot = JSON.parse(
    readFileSync(join(serverDir, "../agent_bots_snapshot.json"), "utf-8"),
  ) as Array<{ botSlug: string; engineActive: boolean; legacyRetired: boolean; offboarded?: boolean }>;

  it("every migrated slug is still recognised as a legacy slug", () => {
    // isBlockedLegacy can only gate a slug it knows about. If a migrated slug
    // fell out of LEGACY_BOT_SLUGS, a rollback would silently un-gate it.
    for (const slug of MIGRATED_SLUGS) {
      expect(isLegacyBot(slug), `${slug} dropped out of LEGACY_BOT_SLUGS`).toBe(true);
    }
  });

  it("no bot is driven by both motors", () => {
    const doubled = snapshot.filter(r => r.engineActive && !r.legacyRetired).map(r => r.botSlug);
    expect(doubled, "engineActive && !legacyRetired = duplicate sends").toEqual([]);
  });

  it("no bot is left with zero motors", () => {
    // Since the legacy files were deleted the legacy motor no longer exists at
    // all, so engineActive=false now means the agent runs NOWHERE. That is
    // intended for the offboarded pair and a silent outage for anyone else.
    const orphaned = snapshot
      .filter(r => !r.engineActive && !r.offboarded)
      .map(r => r.botSlug);
    expect(orphaned, "not engine-active and not offboarded = agent sends nothing").toEqual([]);
  });

  it("the engine's active set is exactly the six migrated agents", () => {
    const active = snapshot.filter(r => r.engineActive).map(r => r.botSlug).sort();
    expect(active).toEqual([...MIGRATED_SLUGS].sort());
  });

  it("offboarded agents are engine-inactive and legacy-retired — they run nowhere", () => {
    for (const slug of OFFBOARDED_SLUGS) {
      const row = snapshot.find(r => r.botSlug === slug);
      expect(row, `${slug} missing from snapshot`).toBeTruthy();
      expect(row!.engineActive).toBe(false);
      expect(row!.legacyRetired).toBe(true);
    }
  });

  it("no legacy bot file remains — the engine is the only motor", () => {
    // Derived from the directory rather than a hardcoded list, so a legacy file
    // reappearing (a bad revert, a restored backup) fails here immediately
    // instead of quietly resurrecting a second motor.
    const legacyFiles = readdirSync(serverDir).filter(
      f => /Bot\.ts$/.test(f) && !f.includes(".test."),
    );
    expect(legacyFiles, "a hardcoded legacy bot file is back — two motors").toEqual([]);
  });
});
