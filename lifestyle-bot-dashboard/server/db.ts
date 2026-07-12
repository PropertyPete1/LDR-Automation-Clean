import { and, eq, gte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { botRunLogs, InsertUser, users } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// ─── Bot Run Results ─────────────────────────────────────────────────────────

/**
 * Returns today's aggregated run results for a given bot slug.
 * Sums all runs that happened after midnight UTC today.
 * Returns { sent: 0, errored: 0, skipped: 0 } if no run found.
 */
export async function getTodayBotRunResults(botSlug: string): Promise<{ sent: number; errored: number; skipped: number }> {
  const db = await getDb();
  if (!db) return { sent: 0, errored: 0, skipped: 0 };

  // Midnight UTC today
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  try {
    const rows = await db
      .select({
        sent: sql<number>`SUM(${botRunLogs.sent})`,
        errored: sql<number>`SUM(${botRunLogs.errored})`,
        skipped: sql<number>`SUM(${botRunLogs.skipped})`,
      })
      .from(botRunLogs)
      .where(and(eq(botRunLogs.botSlug, botSlug), gte(botRunLogs.ranAt, todayUtc)))
      .limit(1);

    const row = rows[0];
    return {
      sent: Number(row?.sent ?? 0),
      errored: Number(row?.errored ?? 0),
      skipped: Number(row?.skipped ?? 0),
    };
  } catch (error) {
    console.error(`[DB] getTodayBotRunResults failed for ${botSlug}:`, error);
    return { sent: 0, errored: 0, skipped: 0 };
  }
}
