/**
 * legacyGate.ts — Retirement gate for legacy hardcoded bot files.
 *
 * Each legacy bot file calls `checkLegacyRetired(slug)` at the top of its run function.
 * If the agent's `legacyRetired` flag is true in the DB, the function returns true
 * and the bot exits immediately — the engine takes over.
 *
 * This is the OTHER half of the zero-overlap guarantee:
 *   - Engine gate: refuses to process a legacy slug unless legacyRetired=true
 *   - Legacy gate: refuses to run if legacyRetired=true
 *   - Together: exactly one motor runs for any given agent at any time
 */
import { getDb } from "./db";
import { agentBots } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { writeObservation } from "./botHelpers";

/**
 * Check if this legacy bot has been retired (migrated to engine).
 * Returns true if the bot should EXIT IMMEDIATELY.
 * Writes one observation log line when retiring.
 */
export async function checkLegacyRetired(botSlug: string): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false; // If DB unavailable, let legacy bot run (safe default)
    const [row] = await db
      .select({ legacyRetired: agentBots.legacyRetired })
      .from(agentBots)
      .where(eq(agentBots.botSlug, botSlug))
      .limit(1);
    if (row?.legacyRetired) {
      await writeObservation({
        source: `${botSlug}_bot`,
        category: "legacy_retired",
        severity: "info",
        message: `[LegacyGate] ${botSlug} is retired — legacy file exiting, engine handles this agent now.`,
      });
      return true;
    }
    return false;
  } catch {
    // On error, let legacy bot run (safe default — better than orphaning)
    return false;
  }
}
