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

const ALL_BOTS = [
  { slug: "sp500_peter",  name: "S&P500 Lifestyle Bot (Peter)" },
  { slug: "sp500_steven", name: "S&P500 Lifestyle Bot (Steven)" },
  { slug: "tiffany",     name: "Tiffany's Lifestyle Bot" },
  { slug: "stefanie",    name: "Rue Lifestyle Bot" },
  { slug: "abby",        name: "Abby's Lifestyle Bot" },
  { slug: "irma",        name: "Irma's Lifestyle Bot" },
  { slug: "laila",       name: "Laila's Lifestyle Bot" },
];

export interface BotHealthResult {
  slug: string;
  name: string;
  lastRanAt: Date | null;
  sent: number;
  errored: number;
  skipped: number;
  status: "ok" | "warning" | "error" | "not_run";
  ranToday: boolean;
}

export async function checkAllBotHealth(): Promise<BotHealthResult[]> {
  const db = await getDb();
  if (!db) return ALL_BOTS.map(b => ({ ...b, lastRanAt: null, sent: 0, errored: 0, skipped: 0, status: "not_run" as const, ranToday: false }));

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const results: BotHealthResult[] = [];

  for (const bot of ALL_BOTS) {
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

    let status: BotHealthResult["status"] = "not_run";
    if (lastRun) {
      if (!ranToday) {
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
          <td style="padding: 8px;">${r.ranToday ? "Yes" : "⚠️ No"}</td>
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
            <th style="padding: 8px; text-align: left;">Ran Today?</th>
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
