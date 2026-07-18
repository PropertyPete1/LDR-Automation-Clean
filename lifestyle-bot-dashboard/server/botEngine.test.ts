import { describe, expect, it } from "vitest";

/**
 * Tests for the legacy safeguard in botEngine.ts.
 * These verify that the engine refuses to process legacy hardcoded bot slugs
 * even if they somehow have engineActive=true in the database.
 */

// We import the functions directly to test the safeguard logic
import { runEngineForAgent, getActiveEngineAgents } from "./botEngine";

const LEGACY_SLUGS = [
  "sp500",
  "sp500_peter",
  "sp500_steven",
  "tiffany",
  "stefanie",
  "abby",
  "irma",
  "laila",
];

describe("botEngine legacy safeguard", () => {
  it("runEngineForAgent throws BLOCKED error for each legacy slug", async () => {
    for (const slug of LEGACY_SLUGS) {
      await expect(runEngineForAgent(slug)).rejects.toThrow(
        /BLOCKED.*legacy hardcoded bot/
      );
    }
  });

  it("runEngineForAgent does NOT throw BLOCKED for non-legacy slug 'jason'", async () => {
    // This will throw a different error (e.g., "not engine-active" or DB error)
    // but it should NOT throw the legacy BLOCKED error
    try {
      await runEngineForAgent("jason");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toMatch(/BLOCKED.*legacy hardcoded bot/);
    }
  });

  it("getActiveEngineAgents filters out legacy slugs from results", async () => {
    // This test verifies the filter at the list level
    const agents = await getActiveEngineAgents();
    for (const agent of agents) {
      expect(LEGACY_SLUGS).not.toContain(agent.botSlug);
    }
  });
});
