/**
 * botMonitor.ts — Nightly health checker for all agent Lifestyle Bots.
 * Runs at 4am CT via heartbeat cron.
 * Checks each bot's last run time, surfaces warnings if any bot missed its daily run,
 * and sends a morning summary email to Peter + Steven.
 */

import { getDb } from "./db";
import { botRunLogs, botObservations } from "../drizzle/schema";
import { desc, gte, eq, and } from "drizzle-orm";
import { sendEmail, PETER_EMAIL, STEVEN_EMAIL } from "./botHelpers";

/**
 * LEGACY FALLBACK ONLY — used when the agent_bots table is unreachable.
 * The live watched-bot list is built dynamically from agent_bots
 * (Golden Rule: a new agent row is monitored with zero code changes).
 */
const ALL_BOTS_FALLBACK = [
  { slug: "sp500_peter",  name: "S&P500 Lifestyle Bot (Peter)" },
  { slug: "sp500_steven", name: "S&P500 Lifestyle Bot (Steven)" },
  { slug: "tiffany",     name: "Tiffany's Lifestyle Bot" },
  { slug: "stefanie",    name: "Rue Lifestyle Bot" },
  { slug: "abby",        name: "Abby's Lifestyle Bot" },
  { slug: "irma",        name: "Irma's Lifestyle Bot" },
  { slug: "laila",       name: "Laila's Lifestyle Bot" },
  { slug: "jason",       name: "Jason's Lifestyle Bot" },
];

/** Pure mapper (exported for tests): agent_bots rows → watched bot list */
export function buildWatchedBotList(
  rows: Array<{ botSlug: string; botName: string }>
): Array<{ slug: string; name: string }> {
  if (!rows.length) return ALL_BOTS_FALLBACK;
  return rows.map(r => ({ slug: r.botSlug, name: r.botName }));
}

/** Dynamic watched-bot list from the agent_bots table (fallback to static). */
async function getAllBots(): Promise<Array<{ slug: string; name: string }>> {
  try {
    const db = await getDb();
    if (!db) return ALL_BOTS_FALLBACK;
    const { agentBots } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(agentBots).where(eq(agentBots.engineActive, true));
    return buildWatchedBotList(rows);
  } catch {
    return ALL_BOTS_FALLBACK;
  }
}

export interface BotHealthResult {
  slug: string;
  name: string;
  lastRanAt: Date | null;
  sent: number;
  errored: number;
  skipped: number;
  status: "ok" | "warning" | "error" | "not_run";
  /** Calendar-day flag, for the "N bots ran today" DISPLAY counters only. */
  ranToday: boolean;
  /** Ran within STALE_AFTER_HOURS. This — not ranToday — drives alerting. */
  ranRecently: boolean;
  /** Hours since the last run, so the alert email can say why it fired. */
  hoursSinceLastRun: number | null;
}

/**
 * A bot is "stale" only after missing more than a full daily cycle.
 *
 * The monitor runs at 4:00 AM CT; the bots run at ~10:00 AM CT. So "did it run
 * since midnight?" is false for EVERY bot at 4am on a perfectly healthy night —
 * which is exactly what produced the nightly "8 Bot(s) Need Attention" false
 * alarm. Staleness has to be measured against the ~24h run cadence, not the
 * calendar day. 26h gives two hours of slack for jitter and DST, and matches
 * the threshold routers.ts already uses for the same judgement.
 */
export const STALE_AFTER_HOURS = 26;

export async function checkAllBotHealth(): Promise<BotHealthResult[]> {
  const db = await getDb();
  const allBots = await getAllBots();
  if (!db) return allBots.map(b => ({ ...b, lastRanAt: null, sent: 0, errored: 0, skipped: 0, status: "not_run" as const, ranToday: false, ranRecently: false, hoursSinceLastRun: null }));

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const staleCutoff = new Date(Date.now() - STALE_AFTER_HOURS * 3_600_000);

  const results: BotHealthResult[] = [];

  for (const bot of allBots) {
    // Get the most recent run for this bot
    const [lastRun] = await db
      .select()
      .from(botRunLogs)
      .where(eq(botRunLogs.botSlug, bot.slug))
      .orderBy(desc(botRunLogs.ranAt))
      .limit(1);

    const ranToday = lastRun
      ? new Date(lastRun.ranAt) >= todayStart
      : false;
    const ranRecently = lastRun
      ? new Date(lastRun.ranAt) >= staleCutoff
      : false;
    const hoursSinceLastRun = lastRun
      ? (Date.now() - new Date(lastRun.ranAt).getTime()) / 3_600_000
      : null;

    let status: BotHealthResult["status"] = "not_run";
    if (lastRun) {
      // Staleness is judged on ranRecently, NOT ranToday — see STALE_AFTER_HOURS.
      if (!ranRecently) {
        status = "warning";
      } else {
        status = lastRun.status as "ok" | "warning" | "error";
      }
    }

    results.push({
      slug: bot.slug,
      name: bot.name,
      lastRanAt: lastRun ? new Date(lastRun.ranAt) : null,
      sent: lastRun?.sent ?? 0,
      errored: lastRun?.errored ?? 0,
      skipped: lastRun?.skipped ?? 0,
      status,
      ranToday,
      ranRecently,
      hoursSinceLastRun,
    });
  }

  return results;
}

export async function runBotMonitor(): Promise<void> {
  const results = await checkAllBotHealth();

  // sp500_peter and sp500_steven are newly split slugs — not_run is expected until they accumulate history
  const newSlugs = new Set(["sp500_peter", "sp500_steven"]);
  const warnings = results.filter(r =>
    (r.status === "warning" || r.status === "error" || r.status === "not_run") &&
    !(newSlugs.has(r.slug) && r.status === "not_run")
  );
  const allOk = warnings.length === 0;

  // Build email HTML
  const rows = results
    .map(r => {
      const statusEmoji =
        r.status === "ok" ? "✅" :
        r.status === "warning" ? "⚠️" :
        r.status === "error" ? "❌" : "🔴";
      const lastRan = r.lastRanAt
        ? r.lastRanAt.toLocaleString("en-US", { timeZone: "America/Chicago" })
        : "Never";
      return `
        <tr style="border-bottom: 1px solid #eee;">
          <td style="padding: 8px;">${statusEmoji} ${r.name}</td>
          <td style="padding: 8px;">${lastRan} CT</td>
          <td style="padding: 8px;">${r.sent}</td>
          <td style="padding: 8px;">${r.errored}</td>
          <td style="padding: 8px;">${
            r.hoursSinceLastRun === null
              ? "Never"
              : r.ranRecently
                ? `${r.hoursSinceLastRun.toFixed(1)}h ago`
                : `⚠️ ${r.hoursSinceLastRun.toFixed(1)}h ago (> ${STALE_AFTER_HOURS}h)`
          }</td>
        </tr>`;
    })
    .join("");

  const subject = allOk
    ? "✅ 4am Bot Health Check — All Systems Go"
    : `⚠️ 4am Bot Health Check — ${warnings.length} Bot(s) Need Attention`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
      <h2 style="color: #2c5f2e;">🌙 Nightly Bot Health Report</h2>
      <p>Good morning! Here's the 4am health check for all Lifestyle Bots.</p>
      <table style="width: 100%; border-collapse: collapse; font-size: 0.9em;">
        <thead>
          <tr style="background: #f0f4f0;">
            <th style="padding: 8px; text-align: left;">Bot</th>
            <th style="padding: 8px; text-align: left;">Last Run</th>
            <th style="padding: 8px; text-align: left;">Sent</th>
            <th style="padding: 8px; text-align: left;">Errors</th>
            <th style="padding: 8px; text-align: left;">Last Run Age</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${warnings.length > 0 ? `
        <div style="background: #fff3cd; border: 1px solid #ffc107; padding: 12px; margin-top: 16px; border-radius: 4px;">
          <strong>⚠️ Bots that need attention:</strong>
          <ul>${warnings.map(w => `<li>${w.name} — Status: ${w.status}</li>`).join("")}</ul>
        </div>
      ` : `
        <div style="background: #d4edda; border: 1px solid #28a745; padding: 12px; margin-top: 16px; border-radius: 4px;">
          <strong>✅ All bots ran successfully today!</strong>
        </div>
      `}
      <p style="color: #666; font-size: 0.9em; margin-top: 24px;">
        Is there anything else I can automate to make your life easier?
      </p>
      <p>Truly,<br/><strong>Lifestyle Bot Monitor</strong><br/>Lifestyle Design Realty Automation</p>
    </div>
  `;

  await sendEmail({
    to: [PETER_EMAIL, STEVEN_EMAIL],
    subject,
    html,
  });
}
