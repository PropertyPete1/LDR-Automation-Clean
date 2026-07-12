/**
 * scheduledHandlers.ts
 * Express handlers for all heartbeat cron endpoints.
 * Each handler is mounted at /api/scheduled/* in server/_core/index.ts.
 *
 * ALL handler-level crashes are written to bot_observations (bot_crash severity: error)
 * so the nightly healer can detect and surface them in the 4am morning summary email.
 *
 * Cron schedule (all times CT = UTC-6 in summer CDT):
 *   Clock-in     (10:00am CT): 0 0 15 * * *   (UTC)
 *   SP Peter run (10:05am CT): 0 5 15 * * *   (UTC)
 *   SP Steven run(10:07am CT): 0 7 15 * * *   (UTC)
 *   Agent runs   (10:05am CT): 0 5 15 * * *   (UTC)
 *   Clock-off    (6:00pm CT):  0 0 0  * * *   (UTC = midnight)
 *   Lead replies (3:50am CT):  0 50 8 * * *   (UTC)
 *   Bot monitor  (4:00am CT):  0 0 9  * * *   (UTC)
 */

import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { writeObservation } from "./botHelpers";
import { getTodayBotRunResults } from "./db";

// ─── Bot imports ──────────────────────────────────────────────────────────────

import { runSpBot, runSpBotPeter, runSpBotSteven, sendSpBotClockinEmail, sendSpBotClockoffEmail } from "./spBot";
import { runTiffanyBot, sendTiffanyBotClockinEmail, sendTiffanyBotClockoffEmail } from "./tiffanyBot";
import { runStefanieBot, sendStefanieBotClockinEmail, sendStefanieBotClockoffEmail } from "./stefanieBot";
import { runAbbyBot, sendAbbyBotClockinEmail, sendAbbyBotClockoffEmail } from "./abbyBot";
import { runIrmaBot, sendIrmaBotClockinEmail, sendIrmaBotClockoffEmail } from "./irmaBot";
import { runLailaBot, sendLailaBotClockinEmail, sendLailaBotClockoffEmail } from "./lailaBot";
import { runBotMonitor } from "./botMonitor";
import { runLeadReplyChecker } from "./leadReplyChecker";

// ─── Auth guard ───────────────────────────────────────────────────────────────

async function requireCron(req: Request, res: Response): Promise<boolean> {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      res.status(403).json({ error: "cron-only endpoint" });
      return false;
    }
    return true;
  } catch {
    res.status(403).json({ error: "unauthorized" });
    return false;
  }
}

/**
 * Wrap a handler action with full crash observation logging.
 * Any unhandled exception writes a bot_crash observation so the night healer
 * can detect and surface it in the 4am morning summary email.
 */
async function withCrashObservation(
  botSlug: string,
  action: string,
  fn: () => Promise<void>,
  res: Response
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Write crash to bot_observations for the night healer
    await writeObservation({
      source: `${botSlug}_bot`,
      category: "bot_crash",
      severity: "error",
      message: `[CRASH] ${botSlug} ${action} failed at ${new Date().toISOString()}: ${msg}`,
    }).catch(() => {}); // never let observation write block the 500 response
    res.status(500).json({ error: msg, bot: botSlug, action });
  }
}

// ─── S&P500 Bot handlers ──────────────────────────────────────────────────────

export async function handleSpClockin(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("sp500", "clockin", async () => {
    await sendSpBotClockinEmail();
    res.json({ ok: true, bot: "sp500", action: "clockin" });
  }, res);
}

export async function handleSpRun(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("sp500", "run", async () => {
    const result = await runSpBot();
    // Clock-off email is sent at 6 PM by handleSpClockoff — not here.
    res.json({ ok: true, bot: "sp500", ...result });
  }, res);
}

/** Peter-only run — split to avoid 2-min heartbeat timeout */
export async function handleSpPeterRun(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("sp500_peter", "run", async () => {
    const result = await runSpBotPeter();
    res.json({ ok: true, bot: "sp500_peter", ...result });
  }, res);
}

/** Steven-only run — split to avoid 2-min heartbeat timeout */
export async function handleSpStevenRun(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("sp500_steven", "run", async () => {
    const result = await runSpBotSteven();
    res.json({ ok: true, bot: "sp500_steven", ...result });
  }, res);
}

export async function handleSpClockoff(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("sp500", "clockoff", async () => {
    // Read today's real results from the DB (written by the 10:05am -run handler)
    const results = await getTodayBotRunResults("sp500");
    await sendSpBotClockoffEmail(results.sent, results.errored, results.skipped);
    res.json({ ok: true, bot: "sp500", action: "clockoff", ...results });
  }, res);
}

// ─── Tiffany Bot handlers ─────────────────────────────────────────────────────

export async function handleTiffanyClockin(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("tiffany", "clockin", async () => {
    await sendTiffanyBotClockinEmail();
    res.json({ ok: true, bot: "tiffany", action: "clockin" });
  }, res);
}

export async function handleTiffanyRun(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("tiffany", "run", async () => {
    const result = await runTiffanyBot();
    // Clock-off email is sent at 6 PM by handleTiffanyClockoff — not here.
    res.json({ ok: true, bot: "tiffany", ...result });
  }, res);
}

export async function handleTiffanyClockoff(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("tiffany", "clockoff", async () => {
    const results = await getTodayBotRunResults("tiffany");
    await sendTiffanyBotClockoffEmail(results.sent, results.errored, results.skipped);
    res.json({ ok: true, bot: "tiffany", action: "clockoff", ...results });
  }, res);
}

// ─── Stefanie / Rue Bot handlers ──────────────────────────────────────────────

export async function handleStefanieClockin(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("stefanie", "clockin", async () => {
    await sendStefanieBotClockinEmail();
    res.json({ ok: true, bot: "stefanie", action: "clockin" });
  }, res);
}

export async function handleStefanieRun(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("stefanie", "run", async () => {
    const result = await runStefanieBot();
    // Clock-off email is sent at 6 PM by handleStefanieClockoff — not here.
    res.json({ ok: true, bot: "stefanie", ...result });
  }, res);
}

export async function handleStefanieClockoff(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("stefanie", "clockoff", async () => {
    const results = await getTodayBotRunResults("stefanie");
    await sendStefanieBotClockoffEmail(results.sent, results.errored, results.skipped);
    res.json({ ok: true, bot: "stefanie", action: "clockoff", ...results });
  }, res);
}

// ─── Abby Bot handlers ────────────────────────────────────────────────────────

export async function handleAbbyClockin(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("abby", "clockin", async () => {
    await sendAbbyBotClockinEmail();
    res.json({ ok: true, bot: "abby", action: "clockin" });
  }, res);
}

export async function handleAbbyRun(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("abby", "run", async () => {
    const result = await runAbbyBot();
    // Clock-off email is sent at 6 PM by handleAbbyClockoff — not here.
    res.json({ ok: true, bot: "abby", ...result });
  }, res);
}

export async function handleAbbyClockoff(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("abby", "clockoff", async () => {
    const results = await getTodayBotRunResults("abby");
    await sendAbbyBotClockoffEmail(results.sent, results.errored, results.skipped);
    res.json({ ok: true, bot: "abby", action: "clockoff", ...results });
  }, res);
}

// ─── Irma Bot handlers ────────────────────────────────────────────────────────

export async function handleIrmaClockin(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("irma", "clockin", async () => {
    await sendIrmaBotClockinEmail();
    res.json({ ok: true, bot: "irma", action: "clockin" });
  }, res);
}

export async function handleIrmaRun(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("irma", "run", async () => {
    const result = await runIrmaBot();
    // Clock-off email is sent at 6 PM by handleIrmaClockoff — not here.
    res.json({ ok: true, bot: "irma", ...result });
  }, res);
}

export async function handleIrmaClockoff(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("irma", "clockoff", async () => {
    const results = await getTodayBotRunResults("irma");
    await sendIrmaBotClockoffEmail(results.sent, results.errored, results.skipped);
    res.json({ ok: true, bot: "irma", action: "clockoff", ...results });
  }, res);
}

// ─── Laila Bot handlers ───────────────────────────────────────────────────────

export async function handleLailaClockin(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("laila", "clockin", async () => {
    await sendLailaBotClockinEmail();
    res.json({ ok: true, bot: "laila", action: "clockin" });
  }, res);
}

export async function handleLailaRun(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("laila", "run", async () => {
    const result = await runLailaBot();
    // Clock-off email is sent at 6 PM by handleLailaClockoff — not here.
    res.json({ ok: true, bot: "laila", ...result });
  }, res);
}

export async function handleLailaClockoff(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("laila", "clockoff", async () => {
    const results = await getTodayBotRunResults("laila");
    await sendLailaBotClockoffEmail(results.sent, results.errored, results.skipped);
    res.json({ ok: true, bot: "laila", action: "clockoff", ...results });
  }, res);
}

// ─── Lead Reply Checker handler ──────────────────────────────────────────────
// Runs at 3:50am CT (08:50 UTC) — 10 min before the 4am healer report.
// Scans Gmail for replies from leads in the past 24h and writes lead_reply observations.

export async function handleLeadReplyCheck(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("lead_reply_checker", "scan", async () => {
    const result = await runLeadReplyChecker();
    res.json({ ok: true, action: "lead_reply_check", ...result });
  }, res);
}

// ─── Bot Monitor handler ──────────────────────────────────────────────────────

export async function handleBotMonitor(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("bot_monitor", "nightly_check", async () => {
    await runBotMonitor();
    res.json({ ok: true, action: "bot_monitor" });
  }, res);
}
