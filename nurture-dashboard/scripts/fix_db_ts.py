DB_PATH = "server/db.ts"

NEW_FUNCTION = """
/**
 * Get per-agent text counts for last week (Mon-Sun, CT).
 * Used by the weekly leaderboard email sent every Monday morning.
 */
export async function getSmsSentLastWeekByAgent(): Promise<Array<{ agentName: string; weekTexts: number }>> {
  try {
    const db = await getDb();
    if (!db) return [];
    const CT_OFFSET_MS = 6 * 60 * 60 * 1000;
    const nowCT = new Date(Date.now() - CT_OFFSET_MS);
    const dayOfWeek = nowCT.getUTCDay();
    const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek;
    const lastMonday = new Date(nowCT);
    lastMonday.setUTCDate(nowCT.getUTCDate() - daysToLastMonday);
    const lastSunday = new Date(lastMonday);
    lastSunday.setUTCDate(lastMonday.getUTCDate() + 6);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const startDate = fmt(lastMonday);
    const endDate = fmt(lastSunday);
    const rows = await db
      .select({
        agentName: smsSentToday.agentName,
        weekTexts: sql<number>`COUNT(*)`,
      })
      .from(smsSentToday)
      .where(sql`${smsSentToday.sentDate} >= ${startDate} AND ${smsSentToday.sentDate} <= ${endDate}`)
      .groupBy(smsSentToday.agentName)
      .orderBy(sql`COUNT(*) DESC`);
    return rows.map(r => ({ agentName: r.agentName, weekTexts: Number(r.weekTexts) }));
  } catch (err) {
    console.warn('[getSmsSentLastWeekByAgent] Failed:', err);
    return [];
  }
}

"""

with open(DB_PATH, "r", encoding="utf-8") as f:
    content = f.read()

if "getSmsSentLastWeekByAgent" in content:
    print("Already present")
else:
    target = "/**\n * Prune sms_sent_today rows older than 7 days."
    if target in content:
        content = content.replace(target, NEW_FUNCTION + target, 1)
    else:
        content = content.rstrip() + "\n" + NEW_FUNCTION
    with open(DB_PATH, "w", encoding="utf-8") as f:
        f.write(content)
    print("Inserted")

with open(DB_PATH, "r") as f:
    final = f.read()
count = final.count("getSmsSentLastWeekByAgent")
print(f"Occurrences in file: {count}")
