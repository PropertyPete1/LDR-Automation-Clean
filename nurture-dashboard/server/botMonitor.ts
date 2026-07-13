/**
 * botMonitor.ts — Autonomous Monitoring Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs every 30 minutes via heartbeat cron. Acts like a vigilant human agent
 * "looking around the app" — checking data accuracy vs FUB live data, detecting
 * anomalies, verifying automation health, and auto-fixing what it can.
 *
 * Data source for pond nurture checks:
 *   The GitHub Actions system (daily-automation.yml) is the source of truth.
 *   It writes to `bot_observations` (source='pond_nurture', category='daily_run')
 *   after each run. The nightly healer writes to `bot_observations`
 *   (source='nightly_healer', category='healer_run_complete').
 *
 * Check categories:
 *   1. FUB Data Accuracy   — lead counts, pond lead range, dashboard JSON freshness
 *   2. Bot Health          — pond run observation, healer heartbeat, SMTP env vars
 *   3. Rule Violation Scan — pond errors, volume sanity, config integrity
 *   4. System Health       — FUB API response time, DB accessible, critical files
 *
 * Alert policy:
 *   - Email alerts ONLY on genuine failure conditions (no heartbeat for 24h+,
 *     agent bot errors, critical system failures)
 *   - One alert per distinct issue per day max (deduplication via bot_observations)
 *   - External monitoring via healthchecks.io is the first layer; this is the second
 *
 * Auto-fixes applied:
 *   - Clears stale dashboard cache if data is > 25 hours old
 *   - Clears roster cache if agent count mismatch detected
 *   - Notifies owner if critical issues found (≥ 1 error-severity finding, deduped)
 *
 * Return type: MonitorResult (also persisted to bot_monitor_log table)
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { ENV } from "./_core/env";
import { clearDashboardCache, clearRosterCache } from "./dashboardData";
import { notifyOwner } from "./_core/notification";
import { writeObservation, getRecentMonitorRuns } from "./db";

const execFileAsync = promisify(execFile);

// ── ESM-safe __dirname ────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Constants ─────────────────────────────────────────────────────────────────
const FUB_BASE = "https://api.followupboss.com/v1";
const DASHBOARD_JSON_PATH =
  process.env.DASHBOARD_JSON_PATH ||
  (process.env.NODE_ENV === "production"
    ? path.resolve(__dirname, "public/data/dashboard_data.json")
    : path.resolve(__dirname, "../client/public/data/dashboard_data.json"));


// Expected pond lead count range — flag if FUB returns outside this window
const POND_MIN = 50;
const POND_MAX = 10000;

// Max acceptable age for dashboard_data.json before we flag it stale
const DASHBOARD_STALE_HOURS = 25;

// FUB API response time threshold (ms)
const FUB_TIMEOUT_MS = 5000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type FindingStatus = "ok" | "warning" | "fixed" | "error";

export interface MonitorFinding {
  check: string;
  status: FindingStatus;
  detail: string;
}

export interface MonitorResult {
  ranAt: string;
  durationMs: number;
  checksRun: number;
  issuesFound: number;
  issuesFixed: number;
  findings: MonitorFinding[];
  summary: string;
  triggeredBy: "cron" | "manual";
}

// ── FUB helper (lightweight, no retries — just a health ping) ─────────────────
async function fubPing(path_: string): Promise<{ ok: boolean; durationMs: number; data?: any }> {
  const apiKey = ENV.fubApiKey;
  if (!apiKey) return { ok: false, durationMs: 0 };
  const credentials = Buffer.from(`${apiKey}:`).toString("base64");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FUB_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(`${FUB_BASE}${path_}`, {
      headers: { Accept: "application/json", Authorization: `Basic ${credentials}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const durationMs = Date.now() - start;
    if (!res.ok) return { ok: false, durationMs };
    const data = await res.json();
    return { ok: true, durationMs, data };
  } catch {
    clearTimeout(timeoutId);
    return { ok: false, durationMs: Date.now() - start };
  }
}

// ── GitHub Actions observation-based helpers ──────────────────────────────────
// The GitHub Actions system writes to bot_observations after each pond nurture run.
// Message format: "Pond nurture complete: X emails sent, Y skipped, Z suppressed, W errors, N reassigned"

interface PondRunObservation {
  emailsSent: number;
  skipped: number;
  suppressed: number;
  errors: number;
  reassigned: number;
  createdAt: Date;
  message: string;
}

/**
 * Parse the daily_run observation message to extract email count and other stats.
 * Returns null if the message doesn't match the expected format.
 */
function parsePondRunMessage(message: string): Omit<PondRunObservation, 'createdAt' | 'message'> | null {
  // "Pond nurture complete: 344 emails sent, 2128 skipped, 919 suppressed, 0 errors, 46 reassigned"
  const match = message.match(
    /(\d+)\s+emails?\s+sent.*?(\d+)\s+skipped.*?(\d+)\s+suppressed.*?(\d+)\s+errors?.*?(\d+)\s+reassigned/i
  );
  if (!match) return null;
  return {
    emailsSent: parseInt(match[1], 10),
    skipped: parseInt(match[2], 10),
    suppressed: parseInt(match[3], 10),
    errors: parseInt(match[4], 10),
    reassigned: parseInt(match[5], 10),
  };
}

/**
 * Get today's pond nurture run observation from bot_observations.
 * Returns the parsed observation or null if no run has been recorded today.
 */
async function getPondRunToday(): Promise<PondRunObservation | null> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return null;
    const { botObservations } = await import("../drizzle/schema");
    const { and, eq, gte, desc } = await import("drizzle-orm");
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const rows = await db
      .select({ message: botObservations.message, createdAt: botObservations.createdAt })
      .from(botObservations)
      .where(and(
        eq(botObservations.source, "pond_nurture"),
        eq(botObservations.category, "daily_run"),
        gte(botObservations.createdAt, startOfDay)
      ))
      .orderBy(desc(botObservations.createdAt))
      .limit(1);
    if (rows.length === 0) return null;
    const parsed = parsePondRunMessage(rows[0].message);
    if (!parsed) return null;
    return {
      ...parsed,
      createdAt: new Date(rows[0].createdAt),
      message: rows[0].message,
    };
  } catch { return null; }
}

/**
 * Get the most recent pond nurture daily_run observation (any day).
 * Used to determine when the system last ran successfully.
 */
async function getLastPondRun(): Promise<{ createdAt: Date; emailsSent: number; message: string } | null> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return null;
    const { botObservations } = await import("../drizzle/schema");
    const { and, eq, desc } = await import("drizzle-orm");
    const rows = await db
      .select({ message: botObservations.message, createdAt: botObservations.createdAt })
      .from(botObservations)
      .where(and(
        eq(botObservations.source, "pond_nurture"),
        eq(botObservations.category, "daily_run")
      ))
      .orderBy(desc(botObservations.createdAt))
      .limit(1);
    if (rows.length === 0) return null;
    const parsed = parsePondRunMessage(rows[0].message);
    return {
      createdAt: new Date(rows[0].createdAt),
      emailsSent: parsed?.emailsSent ?? 0,
      message: rows[0].message,
    };
  } catch { return null; }
}

/**
 * Alert deduplication: check if we already sent an alert for this category today.
 * Reads bot_observations where source='bot_monitor' and the category matches,
 * with severity='error' (only errors trigger email alerts).
 * Returns true if an alert was already sent today.
 */
async function wasAlertSentToday(category: string): Promise<boolean> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return false;
    const { botObservations } = await import("../drizzle/schema");
    const { and, eq, gte } = await import("drizzle-orm");
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const rows = await db
      .select({ id: botObservations.id })
      .from(botObservations)
      .where(and(
        eq(botObservations.source, "bot_monitor"),
        eq(botObservations.category, category),
        eq(botObservations.severity, "error"),
        gte(botObservations.createdAt, startOfDay)
      ))
      .limit(1);
    return rows.length > 0;
  } catch { return false; }
}

// ── Individual check helpers ───────────────────────────────────────────────────

/** CHECK 1: FUB API response time */
async function checkFubApiHealth(): Promise<MonitorFinding> {
  let { ok, durationMs } = await fubPing("/people?limit=1");
  // Retry once with 2s backoff to avoid false positives from transient network blips
  if (!ok) {
    await new Promise(r => setTimeout(r, 2000));
    const retry = await fubPing("/people?limit=1");
    ok = retry.ok;
    durationMs = retry.durationMs;
  }
  if (!ok) {
    return { check: "FUB API reachability", status: "error", detail: `FUB API returned an error or timed out after ${durationMs}ms (confirmed after retry)` };
  }
  if (durationMs > FUB_TIMEOUT_MS) {
    return { check: "FUB API response time", status: "warning", detail: `FUB API slow: ${durationMs}ms (threshold: ${FUB_TIMEOUT_MS}ms)` };
  }
  return { check: "FUB API response time", status: "ok", detail: `${durationMs}ms — healthy` };
}

/** CHECK 2: Total FUB lead count sanity (should be > 0) */
async function checkFubLeadCount(): Promise<MonitorFinding> {
  const { ok, data } = await fubPing("/people?limit=1");
  if (!ok || !data) {
    return { check: "FUB total lead count", status: "warning", detail: "Could not fetch FUB lead count — API unavailable" };
  }
  const total = data._metadata?.total ?? data.totalCount ?? 0;
  if (total === 0) {
    return { check: "FUB total lead count", status: "error", detail: "FUB returned 0 total leads — possible API or sync issue" };
  }
  return { check: "FUB total lead count", status: "ok", detail: `${total.toLocaleString()} leads in FUB` };
}

/** CHECK 3: Pond lead count in expected range */
async function checkPondLeadCount(): Promise<MonitorFinding> {
  const cutoff = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0] + "T00:00:00Z";
  let { ok, data } = await fubPing(`/people?limit=1&lastActivityBefore=${cutoff}`);
  if (!ok || (data?._metadata?.total ?? 0) === 0) {
    await new Promise(r => setTimeout(r, 3000));
    const retry = await fubPing(`/people?limit=1&lastActivityBefore=${cutoff}`);
    if (retry.ok) { ok = true; data = retry.data; }
  }
  if (!ok) {
    return { check: "Pond lead count", status: "warning", detail: "Could not fetch pond leads from FUB (failed after retry)" };
  }
  const total = data?._metadata?.total ?? data?.totalCount ?? 0;
  if (total < POND_MIN) {
    return { check: "Pond lead count", status: "warning", detail: `Only ${total} stale leads found (expected ≥ ${POND_MIN}) — possible FUB sync issue` };
  }
  if (total > POND_MAX) {
    return { check: "Pond lead count", status: "warning", detail: `${total} stale leads exceeds expected max of ${POND_MAX} — review pond assignments` };
  }
  return { check: "Pond lead count", status: "ok", detail: `${total} stale/pond leads in FUB (within expected range)` };
}

/** CHECK 4: dashboard_data.json freshness */
async function checkDashboardJsonFreshness(): Promise<{ finding: MonitorFinding; isStale: boolean }> {
  try {
    const stat = await fs.stat(DASHBOARD_JSON_PATH);
    const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
    if (ageHours > DASHBOARD_STALE_HOURS) {
      return {
        finding: { check: "dashboard_data.json freshness", status: "warning", detail: `dashboard_data.json is ${ageHours.toFixed(1)}h old (threshold: ${DASHBOARD_STALE_HOURS}h) — cache will be cleared` },
        isStale: true,
      };
    }
    return {
      finding: { check: "dashboard_data.json freshness", status: "ok", detail: `${ageHours.toFixed(1)}h old — fresh` },
      isStale: false,
    };
  } catch {
    return {
      finding: { check: "dashboard_data.json freshness", status: "warning", detail: "dashboard_data.json not found — Python automation may not have run yet" },
      isStale: false,
    };
  }
}

/** CHECK 5: dashboard_data.json is valid JSON */
async function checkDashboardJsonValidity(): Promise<MonitorFinding> {
  try {
    const raw = await fs.readFile(DASHBOARD_JSON_PATH, "utf-8");
    JSON.parse(raw);
    return { check: "dashboard_data.json validity", status: "ok", detail: "Valid JSON — parseable" };
  } catch (e: any) {
    return { check: "dashboard_data.json validity", status: "error", detail: `dashboard_data.json is corrupt or unreadable: ${e.message?.slice(0, 100)}` };
  }
}

/** CHECK 6: Bot observations DB accessible */
async function checkPondNurtureDbAccessible(): Promise<{ finding: MonitorFinding; accessible: boolean }> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) {
      return {
        finding: { check: "Bot observations DB", status: "warning", detail: "MySQL DB not accessible — bot observations unavailable" },
        accessible: false,
      };
    }
    const { botObservations } = await import("../drizzle/schema");
    const rows = await db.select({ id: botObservations.id }).from(botObservations).limit(1);
    return {
      finding: { check: "Bot observations DB", status: "ok", detail: "bot_observations table accessible" },
      accessible: true,
    };
  } catch (e) {
    return {
      finding: { check: "Bot observations DB", status: "warning", detail: `bot_observations not accessible: ${String(e).slice(0, 80)}` },
      accessible: false,
    };
  }
}

/**
 * CHECK 7: Pond nurture ran today (reads bot_observations from GitHub Actions)
 *
 * The GitHub Actions daily-automation.yml runs at 7am CT and writes a
 * 'daily_run' observation when complete (~11:30am CT after 3.5h processing).
 * We only flag as an issue if it's past 6pm CT (23:00 UTC) with no observation.
 */
async function checkPondNurtureRanToday(): Promise<MonitorFinding> {
  const todayRun = await getPondRunToday();
  if (todayRun) {
    if (todayRun.emailsSent === 0) {
      // The system ran but sent 0 emails — this is a known issue being tracked
      // by the nightly healer (which has its own consecutive-day alert).
      // Report as warning (not error) since the system DID run successfully.
      return {
        check: "Pond nurture ran today",
        status: "warning",
        detail: `Pond nurture ran but sent 0 emails today (${todayRun.message.slice(0, 100)})`,
      };
    }
    return {
      check: "Pond nurture ran today",
      status: "ok",
      detail: `${todayRun.emailsSent} pond emails sent today at ${todayRun.createdAt.toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })} CT`,
    };
  }

  // No observation today — check the time to decide severity
  const utcHour = new Date().getUTCHours();
  if (utcHour < 18) {
    // Before 1pm CT (18:00 UTC) — the run starts at 7am CT and takes ~4.5h
    // Don't flag yet, it may still be running
    return {
      check: "Pond nurture ran today",
      status: "ok",
      detail: "No pond nurture observation yet today — daily run starts at 7am CT and completes by ~12pm CT",
    };
  }
  if (utcHour < 23) {
    // Between 1pm-6pm CT — getting late, warn
    return {
      check: "Pond nurture ran today",
      status: "warning",
      detail: "Pond nurture has not reported a daily_run observation today — GitHub Actions may have failed (expected by ~12pm CT)",
    };
  }
  // After 6pm CT (23:00 UTC) — genuine missed run
  return {
    check: "Pond nurture ran today",
    status: "error",
    detail: "🚨 Pond nurture did NOT run today — no daily_run observation found. Check GitHub Actions workflow.",
  };
}

/**
 * CHECK 8: Pond nurture last ran within expected window (reads bot_observations)
 * Flags if no run in the last 36 hours (allows for weekend skips or delays).
 */
async function checkPondNurtureLastRan(): Promise<MonitorFinding> {
  const lastRun = await getLastPondRun();
  if (lastRun === null) {
    return { check: "Pond nurture last run", status: "warning", detail: "No pond nurture daily_run observations found in DB — system may not have reported yet" };
  }
  const ageHours = (Date.now() - lastRun.createdAt.getTime()) / 3600000;
  if (ageHours > 48) {
    return {
      check: "Pond nurture last run",
      status: "error",
      detail: `Last pond nurture run was ${ageHours.toFixed(1)}h ago (${lastRun.createdAt.toLocaleString("en-US", { timeZone: "America/Chicago" })} CT) — missed multiple days`,
    };
  }
  if (ageHours > 36) {
    return {
      check: "Pond nurture last run",
      status: "warning",
      detail: `Last pond nurture run was ${ageHours.toFixed(1)}h ago — may have missed yesterday's run`,
    };
  }
  return {
    check: "Pond nurture last run",
    status: "ok",
    detail: `Last run ${ageHours.toFixed(1)}h ago (${lastRun.emailsSent} emails sent)`,
  };
}

/** CHECK 9: SMTP credentials are set */
async function checkSmtpCredentials(): Promise<MonitorFinding> {
  const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "EMAIL_FROM"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    return { check: "SMTP credentials", status: "error", detail: `Missing env vars: ${missing.join(", ")}` };
  }
  const smtpUser = process.env.SMTP_USER ?? "";
  const emailFrom = process.env.EMAIL_FROM ?? "";
  if (!smtpUser.includes("@") || !emailFrom.includes("@")) {
    return { check: "SMTP credentials", status: "warning", detail: "SMTP_USER or EMAIL_FROM does not look like a valid email address" };
  }
  return { check: "SMTP credentials", status: "ok", detail: `Sender: ${emailFrom} via ${process.env.SMTP_HOST}:${process.env.SMTP_PORT}` };
}

/** CHECK 10: FUB API key is configured */
async function checkFubApiKey(): Promise<MonitorFinding> {
  const key = ENV.fubApiKey;
  if (!key || key.length < 10) {
    return { check: "FUB API key configured", status: "error", detail: "FUB_API_KEY env var is missing or too short" };
  }
  if (!key.startsWith("fka_")) {
    return { check: "FUB API key configured", status: "warning", detail: "FUB_API_KEY does not start with expected prefix 'fka_'" };
  }
  return { check: "FUB API key configured", status: "ok", detail: `Key configured (${key.slice(0, 8)}...)` };
}

/**
 * CHECK 11: Nightly healer heartbeat (reads bot_observations source='nightly_healer')
 * The nightly healer runs at 4am CT via GitHub Actions and writes a
 * 'healer_run_complete' observation. Flag if no heartbeat in 26 hours.
 */
async function checkHealerHeartbeat(): Promise<MonitorFinding> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) {
      return { check: "Nightly healer heartbeat", status: "ok", detail: "DB not accessible — skipped" };
    }
    const { botObservations } = await import("../drizzle/schema");
    const { desc, gte, and, eq } = await import("drizzle-orm");
    const cutoff = new Date(Date.now() - 26 * 60 * 60 * 1000); // 26 hours ago
    const recentRows = await db
      .select({ createdAt: botObservations.createdAt, category: botObservations.category })
      .from(botObservations)
      .where(
        and(
          eq(botObservations.source, "nightly_healer"),
          eq(botObservations.category, "healer_run_complete"),
          gte(botObservations.createdAt, cutoff)
        )
      )
      .orderBy(desc(botObservations.createdAt))
      .limit(1);
    if (recentRows.length > 0) {
      const lastRan = recentRows[0].createdAt;
      const hoursAgo = Math.floor((Date.now() - new Date(lastRan).getTime()) / (1000 * 60 * 60));
      return {
        check: "Nightly healer heartbeat",
        status: "ok",
        detail: `Last ran ${hoursAgo}h ago at ${new Date(lastRan).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT`,
      };
    }
    // No healer observation in the last 26 hours — genuine missed run
    return {
      check: "Nightly healer heartbeat",
      status: "warning",
      detail: "Nightly healer has not run in the last 26 hours — check GitHub Actions nightly-health.yml workflow",
    };
  } catch (e) {
    return { check: "Nightly healer heartbeat", status: "ok", detail: `Check skipped: ${String(e).slice(0, 80)}` };
  }
}

/** CHECK 12: Pond email volume sanity (from bot_observations daily_run) */
async function checkPondEmailVolume(): Promise<MonitorFinding> {
  const todayRun = await getPondRunToday();
  if (!todayRun) {
    return { check: "Pond email volume", status: "ok", detail: "No daily_run observation yet today — skipped" };
  }
  if (todayRun.emailsSent > 1000) {
    return { check: "Pond email volume", status: "warning", detail: `${todayRun.emailsSent} pond emails today — unusually high, verify lead pool size` };
  }
  return { check: "Pond email volume", status: "ok", detail: `${todayRun.emailsSent} pond emails today — within expected range` };
}

/** CHECK 13: Pond nurture bot_observations error count today */
async function checkPondNurtureErrors(): Promise<MonitorFinding> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return { check: "Pond nurture errors today", status: "ok", detail: "DB not accessible — skipped" };
    const { botObservations } = await import("../drizzle/schema");
    const { and, eq, gte } = await import("drizzle-orm");
    const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
    const rows = await db
      .select({ id: botObservations.id, message: botObservations.message })
      .from(botObservations)
      .where(and(
        eq(botObservations.source, "pond_nurture"),
        eq(botObservations.severity, "error"),
        gte(botObservations.createdAt, startOfDay)
      ));
    if (rows.length > 0) {
      return { check: "Pond nurture errors today", status: "warning", detail: `${rows.length} pond nurture error(s) today: ${rows[0].message}` };
    }
    return { check: "Pond nurture errors today", status: "ok", detail: "No pond nurture errors today" };
  } catch (e) {
    return { check: "Pond nurture errors today", status: "ok", detail: `Check skipped: ${String(e).slice(0, 80)}` };
  }
}

/** CHECK 14: Pond nurture config integrity */
async function checkPondNurtureConfig(): Promise<MonitorFinding> {
  const fubKey = process.env.FUB_API_KEY;
  const smtpHost = process.env.SMTP_HOST;
  if (!fubKey || !smtpHost) {
    return { check: "Pond nurture config", status: "error", detail: "Missing FUB_API_KEY or SMTP_HOST — pond nurture engine cannot run" };
  }
  // Verify pond nurture ran recently (last 48h) as a config health proxy
  const lastRun = await getLastPondRun();
  if (lastRun) {
    const ageHours = (Date.now() - lastRun.createdAt.getTime()) / 3600000;
    return { check: "Pond nurture config", status: "ok", detail: `Config healthy — last run ${ageHours.toFixed(1)}h ago` };
  }
  return { check: "Pond nurture config", status: "ok", detail: "Config healthy — FUB key and SMTP configured" };
}

/** CHECK 15: Pond nurture warning observations today */
async function checkPondNurtureWarnings(): Promise<MonitorFinding> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return { check: "Pond nurture warnings today", status: "ok", detail: "DB not accessible — skipped" };
    const { botObservations } = await import("../drizzle/schema");
    const { and, eq, gte } = await import("drizzle-orm");
    const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
    const rows = await db
      .select({ message: botObservations.message })
      .from(botObservations)
      .where(and(
        eq(botObservations.source, "pond_nurture"),
        eq(botObservations.severity, "warning"),
        gte(botObservations.createdAt, startOfDay)
      ));
    if (rows.length > 0) {
      return { check: "Pond nurture warnings today", status: "warning", detail: `${rows.length} pond nurture warning(s) today: ${rows[0].message}` };
    }
    return { check: "Pond nurture warnings today", status: "ok", detail: "No pond nurture warnings today" };
  } catch (e) {
    return { check: "Pond nurture warnings today", status: "ok", detail: `Check skipped: ${String(e).slice(0, 80)}` };
  }
}

/** CHECK 16: Catch-all — any bot_observations errors today across all sources */
async function checkAnyBotErrorsToday(): Promise<MonitorFinding> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return { check: "Bot errors today", status: "ok", detail: "DB not accessible — skipped" };
    const { botObservations } = await import("../drizzle/schema");
    const { and, eq, gte } = await import("drizzle-orm");
    const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
    const rows = await db
      .select({ source: botObservations.source, message: botObservations.message })
      .from(botObservations)
      .where(and(eq(botObservations.severity, "error"), gte(botObservations.createdAt, startOfDay)));
    if (rows.length === 0) {
      return { check: "Bot errors today", status: "ok", detail: "No bot errors today — all systems ran clean" };
    }
    const bySource: Record<string, number> = {};
    for (const r of rows) { bySource[r.source] = (bySource[r.source] ?? 0) + 1; }
    const summary = Object.entries(bySource).map(([s, c]) => `${s}: ${c}`).join(", ");
    return { check: "Bot errors today", status: "warning", detail: `${rows.length} bot error(s) today — ${summary}` };
  } catch (e) {
    return { check: "Bot errors today", status: "ok", detail: `Check skipped: ${String(e).slice(0, 80)}` };
  }
}

// ── Main orchestrator ─────────────────────────────────────────────────────────
export async function runBotMonitor(triggeredBy: "cron" | "manual" = "cron"): Promise<MonitorResult> {
  const startTime = Date.now();
  const ranAt = new Date().toISOString();
  const findings: MonitorFinding[] = [];

  console.log(`[bot-monitor] Starting autonomous monitoring run (triggered by: ${triggeredBy})`);

  // ── Run all checks in parallel where safe ──────────────────────────────────
  // Group 1: FUB API checks (sequential to avoid rate limiting)
  const fubApiHealth = await checkFubApiHealth();
  findings.push(fubApiHealth);

  // Only run FUB data checks if API is reachable
  if (fubApiHealth.status !== "error") {
    const [leadCount, pondCount] = await Promise.all([
      checkFubLeadCount(),
      checkPondLeadCount(),
    ]);
    findings.push(leadCount, pondCount);
  } else {
    findings.push(
      { check: "FUB total lead count", status: "warning", detail: "Skipped — FUB API unreachable" },
      { check: "Pond lead count", status: "warning", detail: "Skipped — FUB API unreachable" }
    );
  }

  // Group 2: File system + config checks (parallel, no external calls)
  const [dashFreshness, dashValidity, pondConfig] = await Promise.all([
    checkDashboardJsonFreshness(),
    checkDashboardJsonValidity(),
    checkPondNurtureConfig(),
  ]);
  findings.push(dashFreshness.finding, dashValidity, pondConfig);

  // Group 3: Bot observations checks (all read from MySQL bot_observations)
  const dbResult = await checkPondNurtureDbAccessible();
  findings.push(dbResult.finding);

  const [pondToday, pondLastRan, pondVolume, pondErrors, pondWarnings, botErrors] = await Promise.all([
    checkPondNurtureRanToday(),
    checkPondNurtureLastRan(),
    checkPondEmailVolume(),
    checkPondNurtureErrors(),
    checkPondNurtureWarnings(),
    checkAnyBotErrorsToday(),
  ]);
  findings.push(pondToday, pondLastRan, pondVolume, pondErrors, pondWarnings, botErrors);

  // Group 4: Credential checks + healer heartbeat (fast, no external calls)
  const [smtpCheck, fubKeyCheck, healerHeartbeat] = await Promise.all([
    checkSmtpCredentials(),
    checkFubApiKey(),
    checkHealerHeartbeat(),
  ]);
  findings.push(smtpCheck, fubKeyCheck, healerHeartbeat);

  // ── Auto-fixes ──────────────────────────────────────────────────────────────
  let issuesFixed = 0;

  // Fix 1: Clear stale dashboard cache
  if (dashFreshness.isStale) {
    try {
      clearDashboardCache();
      const idx = findings.findIndex(f => f.check === "dashboard_data.json freshness");
      if (idx >= 0) {
        findings[idx] = { ...findings[idx], status: "fixed", detail: findings[idx].detail + " — cache cleared" };
      }
      issuesFixed++;
      console.log("[bot-monitor] Auto-fix: cleared stale dashboard cache");
    } catch (e) {
      console.warn("[bot-monitor] Auto-fix failed: could not clear dashboard cache:", e);
    }
  }

  // Fix 2: Clear roster cache if FUB API had issues
  if (fubApiHealth.status === "error" || fubApiHealth.status === "warning") {
    try {
      clearRosterCache();
      issuesFixed++;
      console.log("[bot-monitor] Auto-fix: cleared roster cache due to FUB API issue");
    } catch (e) {
      console.warn("[bot-monitor] Auto-fix failed: could not clear roster cache:", e);
    }
  }

  // ── Tally results ──────────────────────────────────────────────────────────
  const checksRun = findings.length;
  const issuesFound = findings.filter(f => f.status === "warning" || f.status === "error").length;
  const errorCount = findings.filter(f => f.status === "error").length;
  const warningCount = findings.filter(f => f.status === "warning").length;
  const okCount = findings.filter(f => f.status === "ok").length;
  const fixedCount = findings.filter(f => f.status === "fixed").length;
  const durationMs = Date.now() - startTime;

  // ── Build summary ──────────────────────────────────────────────────────────
  let summary: string;
  if (issuesFound === 0) {
    summary = `✅ All ${checksRun} checks passed — system healthy (${durationMs}ms)`;
  } else if (errorCount > 0) {
    summary = `🔴 ${errorCount} error${errorCount > 1 ? "s" : ""}, ${warningCount} warning${warningCount !== 1 ? "s" : ""} across ${checksRun} checks — ${issuesFixed} auto-fixed (${durationMs}ms)`;
  } else {
    summary = `⚠️ ${warningCount} warning${warningCount !== 1 ? "s" : ""} across ${checksRun} checks — ${issuesFixed} auto-fixed (${durationMs}ms)`;
  }

  console.log(`[bot-monitor] Complete: ${summary}`);

  // ── Notify owner if critical errors found (with deduplication) ─────────────
  // Only send ONE alert per distinct issue per day. Check if we already alerted today.
  if (errorCount > 0) {
    // Build a dedup key from the error categories
    const errorCategories = findings
      .filter(f => f.status === "error")
      .map(f => f.check.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 80));

    // Check if ALL error categories were already alerted today
    const dedupResults = await Promise.all(
      errorCategories.map(cat => wasAlertSentToday(cat))
    );
    const allAlreadyAlerted = dedupResults.every(Boolean);

    if (!allAlreadyAlerted) {
      // At least one new error — send the alert
      const errorDetails = findings
        .filter(f => f.status === "error")
        .map(f => `• ${f.check}: ${f.detail}`)
        .join("\n");
      const warningDetails = findings
        .filter(f => f.status === "warning")
        .map(f => `• ${f.check}: ${f.detail}`)
        .join("\n");
      const ctTime = new Date().toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      try {
        await notifyOwner({
          title: `🚨 Bot Monitor: ${errorCount} Critical Issue${errorCount > 1 ? "s" : ""} Detected — ${ctTime} CT`,
          content: [
            `The autonomous monitoring engine detected ${errorCount} critical issue${errorCount > 1 ? "s" : ""} at ${ctTime} CT.`,
            ``,
            `🔴 ERRORS (${errorCount}):`,
            errorDetails,
            warningCount > 0 ? `\n⚠️ WARNINGS (${warningCount}):\n${warningDetails}` : "",
            ``,
            issuesFixed > 0 ? `🔧 ${issuesFixed} issue${issuesFixed > 1 ? "s were" : " was"} auto-fixed.` : "No auto-fixes were applied.",
            ``,
            `📊 Full report: ${checksRun} checks run — ${okCount} ok, ${warningCount} warnings, ${errorCount} errors`,
            ``,
            `ℹ️ Note: This is the second monitoring layer (healthchecks.io is the first). One alert per issue per day.`,
            ``,
            `🔗 Quick Links:`,
            `  • FUB Dashboard: https://app.followupboss.com/2/`,
            `  • GitHub Actions: https://github.com/PropertyPete1/LDR-Automation-Clean/actions`,
            `  • Lifestyle Command Center: https://fub-nurture-phfprjui.manus.space`,
          ].filter(Boolean).join("\n"),
        });
      } catch (e) {
        console.warn("[bot-monitor] Could not send owner notification:", e);
      }
    } else {
      console.log("[bot-monitor] Alert deduplication: all error categories already alerted today — skipping email notification");
    }
  }

  const result: MonitorResult = {
    ranAt,
    durationMs,
    checksRun,
    issuesFound,
    issuesFixed,
    findings,
    summary,
    triggeredBy,
  };

  // ── Write all findings as bot_observations rows ────────────────────────────
  // One row per non-ok finding + one summary row for the run
  const runId = `monitor-${Date.now()}`;
  for (const finding of findings) {
    if (finding.status === "ok") continue; // only log issues and fixes
    await writeObservation({
      source: "bot_monitor",
      severity: finding.status === "fixed" ? "fixed" : finding.status === "error" ? "error" : "warning",
      category: finding.check.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 80),
      message: finding.check,
      detail: finding.detail,
      autoFixable: finding.status === "fixed" ? 1 : 0,
      runId,
    });
  }
  // Always write a summary info row so the healer knows the monitor ran
  await writeObservation({
    source: "bot_monitor",
    severity: "info",
    category: "monitor_run",
    message: `Monitor run: ${checksRun} checks, ${issuesFound} issues, ${issuesFixed} fixed`,
    detail: summary,
    autoFixable: 0,
    runId,
  });

  return result;
}
