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
 *   Clock-off    (6:00pm CT):  0 0 0  * * *   (UTC = midnight)
 *   Lead replies (3:50am CT):  0 50 8 * * *   (UTC)
 *   Bot monitor  (4:00am CT):  0 0 9  * * *   (UTC)
 */

import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { writeObservation } from "./botHelpers";
import { runBotMonitor } from "./botMonitor";
import { runLeadReplyChecker } from "./leadReplyChecker";
import {
  runAllEngineAgents,
  sendAllEngineClockins,
  sendAllEngineClockoffs,
  runEngineForAgent,
  getActiveEngineAgents,
} from "./botEngine";
import { sendAllPendingIntroEmails } from "./botEngineIntro";

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

// ─── S&P500 Peter/Steven individual run handlers ─────────────────────────────

/** Peter-only run — split to avoid 2-min heartbeat timeout */
export async function handleSpPeterRun(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("sp500_peter", "run", async () => {
    const result = await runEngineForAgent("sp500_peter");
    res.json({ ok: true, bot: "sp500_peter", ...result });
  }, res);
}

/** Steven-only run — split to avoid 2-min heartbeat timeout */
export async function handleSpStevenRun(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("sp500_steven", "run", async () => {
    const result = await runEngineForAgent("sp500_steven");
    res.json({ ok: true, bot: "sp500_steven", ...result });
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

// ─── Engine Bot handlers (data-driven) ───────────────────────────────────────

/**
 * Clock-in for ALL engine-active agents.
 * Heartbeat cron: same time as other clock-ins (10:00am CT).
 */
export async function handleEngineClockin(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("engine", "clockin", async () => {
    // Send intro emails to any new engine agents that haven't received one yet
    const introResult = await sendAllPendingIntroEmails();
    // Then send normal clock-in emails
    await sendAllEngineClockins();
    const agents = await getActiveEngineAgents();
    res.json({ ok: true, action: "engine_clockin", introsSent: introResult.sent, agents: agents.map(a => a.botSlug) });
  }, res);
}

/**
 * Run follow-up pipeline for ALL engine-active agents.
 * Heartbeat cron: 10:10am CT (after clock-in).
 */
export async function handleEngineRun(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("engine", "run", async () => {
    const { results } = await runAllEngineAgents();
    res.json({ ok: true, action: "engine_run", results });
  }, res);
}

/**
 * Run follow-up pipeline for a SINGLE engine agent (by slug in query param).
 * Useful for testing or staggered scheduling.
 * Example: POST /api/scheduled/engine-run-single?slug=laila
 */
export async function handleEngineRunSingle(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  const slug = (req.query.slug as string) ?? "";
  if (!slug) { res.status(400).json({ error: "slug query param required" }); return; }
  await withCrashObservation(slug, "run", async () => {
    const result = await runEngineForAgent(slug);
    res.json({ ok: true, bot: slug, ...result });
  }, res);
}

/**
 * Clock-off for ALL engine-active agents.
 * Heartbeat cron: same time as other clock-offs (6:00pm CT).
 */
export async function handleEngineClockoff(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("engine", "clockoff", async () => {
    await sendAllEngineClockoffs();
    const agents = await getActiveEngineAgents();
    res.json({ ok: true, action: "engine_clockoff", agents: agents.map(a => a.botSlug) });
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

// ─── Engine Intro Email (manual trigger) ─────────────────────────────────────

/**
 * Send intro emails to all engine-active agents that haven't received one yet.
 * Can be triggered manually or via cron.
 */
export async function handleEngineIntro(req: Request, res: Response): Promise<void> {
  if (!(await requireCron(req, res))) return;
  await withCrashObservation("engine", "intro", async () => {
    const result = await sendAllPendingIntroEmails();
    res.json({ ok: true, action: "engine_intro", ...result });
  }, res);
}
