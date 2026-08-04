/**
 * dbReachable.ts — test-support probe.
 *
 * The DB-backed suites used to gate on `!!process.env.DATABASE_URL`, i.e. on
 * the PRESENCE of a credential rather than on whether the database is actually
 * usable. `drizzle(url)` is lazy — it never connects — so a URL pointing at
 * nothing still produced a non-null client, the gate opened, and the failure
 * surfaced later as a query error.
 *
 * That is exactly how a partially-provisioned environment (a sandbox that
 * injects secrets but has no MySQL) turned a suite that skips cleanly on a bare
 * machine into a wall of red. Presence of a secret is not availability of a
 * service; this probe checks the thing the tests actually need.
 *
 * Returns false — never throws — so a probe failure can only ever skip a test,
 * never invent one.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";

const PROBE_TIMEOUT_MS = 5_000;

let cached: boolean | null = null;

export async function dbReachable(): Promise<boolean> {
  if (cached !== null) return cached;
  cached = await probe();
  return cached;
}

async function probe(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    const db = await getDb();
    if (!db) return false;
    // Bounded: an unreachable host would otherwise sit on the driver's own
    // connect timeout and stall the whole run.
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("db probe timed out")), PROBE_TIMEOUT_MS)
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}
