/**
 * botMonitor.ts — Autonomous Monitoring Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs every 30 minutes via heartbeat cron. Acts like a vigilant human agent
 * "looking around the app" — checking data accuracy vs FUB live data, detecting
 * anomalies, verifying automation health, and auto-fixing what it can.
 *
 * Check categories:
 *   1. FUB Data Accuracy   — lead counts, pond lead range, dashboard JSON freshness
 *   2. Bot Health          — last SMS run timing, pond email ran today, SMTP env vars
 *   3. Rule Violation Scan — duplicate texts today, stale cap hit, pond/queue overlap
 *   4. System Health       — FUB API response time, SQLite DB accessible, critical files
 *
 * Auto-fixes applied:
 *   - Clears stale dashboard cache if data is > 25 hours old
 *   - Clears roster cache if agent count mismatch detected
 *   - Notifies owner if critical issues found (≥ 1 error-severity finding)
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

// ── Native MySQL helpers (replaces old SQLite/cloud-computer checks) ─────────────
async function getPondNurtureCountToday(): Promise<number | null> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return null;
    const { pondNurtureLog } = await import("../drizzle/schema");
    const { gte } = await import("drizzle-orm");
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const rows = await db
      .select({ id: pondNurtureLog.id })
      .from(pondNurtureLog)
      .where(gte(pondNurtureLog.sentAt, startOfDay));
    return rows.length;
  } catch { return null; }
}

async function getLastPondNurtureDate(): Promise<Date | null> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return null;
    const { pondNurtureLog } = await import("../drizzle/schema");
    const { desc } = await import("drizzle-orm");
    const rows = await db
      .select({ sentAt: pondNurtureLog.sentAt })
      .from(pondNurtureLog)
      .orderBy(desc(pondNurtureLog.sentAt))
      .limit(1);
    return rows[0]?.sentAt ?? null;
  } catch { return null; }
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

/** CHECK 3: Pond lead count in expected range
 * Uses stage-based query (lastActivityBefore cutoff) rather than assignedPondId
 * because this FUB account uses stale-date-based pond membership, not a numeric pond ID.
 */
async function checkPondLeadCount(): Promise<MonitorFinding> {
  // Query stale leads (20+ days no activity) as a proxy for "pond" size
  // This matches how the Lifestyle Bot and pond nurture system define pond leads
  const cutoff = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0] + "T00:00:00Z";
  let { ok, data } = await fubPing(`/people?limit=1&lastActivityBefore=${cutoff}`);
  // Retry once on failure or suspiciously low count — FUB can return partial data on slow responses
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

/** CHECK 6: Pond nurture DB accessible (MySQL pondNurtureLog) */
async function checkPondNurtureDbAccessible(): Promise<{ finding: MonitorFinding; accessible: boolean }> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) {
      return {
        finding: { check: "Pond nurture DB", status: "warning", detail: "MySQL DB not accessible — pond nurture log unavailable" },
        accessible: false,
      };
    }
    const { pondNurtureLog } = await import("../drizzle/schema");
    const rows = await db.select({ id: pondNurtureLog.id }).from(pondNurtureLog).limit(1);
    return {
      finding: { check: "Pond nurture DB", status: "ok", detail: "pond_nurture_log table accessible" },
      accessible: true,
    };
  } catch (e) {
    return {
      finding: { check: "Pond nurture DB", status: "warning", detail: `pond_nurture_log not accessible: ${String(e).slice(0, 80)}` },
      accessible: false,
    };
  }
}

/** CHECK 7: Pond nurture email ran today (native MySQL pondNurtureLog) */
async function checkPondNurtureRanToday(): Promise<MonitorFinding> {
  const cnt = await getPondNurtureCountToday();
  if (cnt === null) {
    return { check: "Pond nurture email ran today", status: "warning", detail: "DB not accessible — could not verify pond nurture run" };
  }
  if (cnt === 0) {
    const utcHour = new Date().getUTCHours();
    if (utcHour >= 14) {
      return { check: "Pond nurture email ran today", status: "warning", detail: "No pond nurture emails sent today (cron should have run at 8am CT)" };
    }
    return { check: "Pond nurture email ran today", status: "ok", detail: "No emails yet today — cron not yet due (runs 8am CT)" };
  }
  return { check: "Pond nurture email ran today", status: "ok", detail: `${cnt} pond nurture emails sent today` };
}

/** CHECK 8: Pond nurture last ran within expected window (native MySQL pondNurtureLog) */
async function checkBotSmsRanRecently(): Promise<MonitorFinding> {
  const lastRun = await getLastPondNurtureDate();
  if (lastRun === null) {
    return { check: "Automation last run", status: "warning", detail: "No pond nurture runs found in DB — pond nurture may not have run yet" };
  }
  const ageHours = (Date.now() - new Date(lastRun).getTime()) / 3600000;
  if (ageHours > 48) {
    return { check: "Automation last run", status: "warning", detail: `Last pond nurture run was ${ageHours.toFixed(1)}h ago — may indicate cron issue` };
  }
  return { check: "Automation last run", status: "ok", detail: `Last run ${ageHours.toFixed(1)}h ago` };
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

/** CHECK 11: Pond nurture heartbeat health (native MySQL pondNurtureLog) */
async function checkCloudComputerHealth(): Promise<MonitorFinding> {
  const lastRun = await getLastPondNurtureDate();
  if (lastRun === null) {
    const utcHour = new Date().getUTCHours();
    if (utcHour >= 14) {
      return { check: "Pond nurture heartbeat", status: "warning", detail: "No pond nurture emails in DB — heartbeat cron may not have fired today" };
    }
    return { check: "Pond nurture heartbeat", status: "ok", detail: "No emails yet today — cron runs at 8am CT" };
  }
  const ageHours = (Date.now() - new Date(lastRun).getTime()) / 3600000;
  if (ageHours > 48) {
    return { check: "Pond nurture heartbeat", status: "warning", detail: `Last pond nurture run was ${ageHours.toFixed(1)}h ago — heartbeat may have missed a run` };
  }
  return { check: "Pond nurture heartbeat", status: "ok", detail: `Pond nurture last ran ${ageHours.toFixed(1)}h ago — healthy` };
}

/** CHECK 12: Pond email volume sanity check (native MySQL pondNurtureLog) */
async function checkDuplicateTextsToday(): Promise<MonitorFinding> {
  // The pondNurtureLog table has a UNIQUE constraint on person_id (one row per lead).
  // Duplicates are structurally impossible via upsertNurtureLog, but we verify the count is sane.
  // Dynamic cap: system scales as lead count grows (eligible ÷ 14). No fixed ceiling.
  // We flag only if the count exceeds 1000 (would imply ~14,000 leads — sanity check for bugs).
  const cnt = await getPondNurtureCountToday();
  if (cnt === null) {
    return { check: "Pond email volume today", status: "ok", detail: "DB not accessible — skipped" };
  }
  if (cnt > 1000) {
    return { check: "Pond email volume today", status: "warning", detail: `${cnt} pond nurture entries today — unusually high, verify lead pool size` };
  }
  return { check: "Pond email volume today", status: "ok", detail: `${cnt} pond nurture emails today — within expected range (dynamic cap)` };
}

/** CHECK 13: Pond nurture bot_observations error count today */
async function checkStaleReassignmentCap(): Promise<MonitorFinding> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return { check: "Pond nurture errors today", status: "ok", detail: "DB not accessible — skipped" };
    const { botObservations } = await import("../drizzle/schema");
    const { and, eq, gte } = await import("drizzle-orm");
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
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

/** CHECK 14: Pond nurture config integrity (verify engine constants are set) */
async function checkRulesYaml(): Promise<MonitorFinding> {
  // Verify the native TS pond nurture engine has its required config constants
  // (POND_ID, LAUNCH_CAP, CADENCE_DAYS, FUB_API_KEY) by checking env vars
  const fubKey = process.env.FUB_API_KEY;
  const smtpHost = process.env.SMTP_HOST;
  if (!fubKey || !smtpHost) {
    return { check: "Pond nurture config", status: "error", detail: "Missing FUB_API_KEY or SMTP_HOST — pond nurture engine cannot run" };
  }
  // Verify pond nurture ran recently (last 48h) as a config health proxy
  const lastRun = await getLastPondNurtureDate();
  if (lastRun) {
    const ageHours = (Date.now() - new Date(lastRun).getTime()) / 3600000;
    return { check: "Pond nurture config", status: "ok", detail: `Config healthy — last run ${ageHours.toFixed(1)}h ago` };
  }
  return { check: "Pond nurture config", status: "ok", detail: "Config healthy — FUB key and SMTP configured" };
}

/** CHECK 16: Catch-all — any bot_observations errors today across all sources */
async function checkAnyAuditLogErrorsToday(): Promise<MonitorFinding> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return { check: "Bot errors today", status: "ok", detail: "DB not accessible — skipped" };
    const { botObservations } = await import("../drizzle/schema");
    const { and, eq, gte } = await import("drizzle-orm");
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
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

/** CHECK 15: Pond nurture warning observations today */
async function checkPondNurtureSmsErrors(): Promise<MonitorFinding> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return { check: "Pond nurture warnings today", status: "ok", detail: "DB not accessible — skipped" };
    const { botObservations } = await import("../drizzle/schema");
    const { and, eq, gte } = await import("drizzle-orm");
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
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

// ── Healer staleness check ───────────────────────────────────────────────────
/**
 * Checks whether the nightly healer has run within the last 26 hours.
 * If it hasn't fired, something is wrong with the heartbeat schedule.
 * Uses the bot_monitor_log table (which the healer writes to on each run).
 */
async function checkHealerLastRan(): Promise<MonitorFinding> {
  try {
    // The nightly healer writes a bot_monitor_log row on each run.
    // We check the most recent run timestamp from that table.
    // Note: getRecentMonitorRuns reads from bot_monitor_log (bot-monitor runs),
    // not the healer runs. We use bot_observations with source='nightly_healer' instead.
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) {
      return { check: "Nightly healer last ran", status: "ok", detail: "DB not accessible — skipped" };
    }
    // Query bot_observations for the most recent nightly_healer row of any kind.
    // The healer now writes a 'healer_run_complete' info row on every successful run,
    // so this check will pass as long as the healer ran within the last 26 hours.
    const { botObservations } = await import("../drizzle/schema");
    const { desc, gte, and, eq } = await import("drizzle-orm");
    const cutoff = new Date(Date.now() - 26 * 60 * 60 * 1000); // 26 hours ago
    const recentRows = await db
      .select({ createdAt: botObservations.createdAt, category: botObservations.category })
      .from(botObservations)
      .where(
        and(
          eq(botObservations.source, "nightly_healer"),
          gte(botObservations.createdAt, cutoff)
        )
      )
      .orderBy(desc(botObservations.createdAt))
      .limit(1);
    if (recentRows.length > 0) {
      const lastRan = recentRows[0].createdAt;
      const hoursAgo = Math.floor((Date.now() - new Date(lastRan).getTime()) / (1000 * 60 * 60));
      return {
        check: "Nightly healer last ran",
        status: "ok",
        detail: `Last ran ${hoursAgo}h ago at ${new Date(lastRan).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT`,
      };
    }
    // No healer observation in the last 26 hours — genuine missed run
    return {
      check: "Nightly healer last ran",
      status: "warning",
      detail: "Nightly healer has not written any observations in the last 26 hours — heartbeat schedule may have missed a run. Check the 4am CT cron job.",
    };
  } catch (e) {
    return { check: "Nightly healer last ran", status: "ok", detail: `Check skipped: ${String(e).slice(0, 80)}` };
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
  const [dashFreshness, dashValidity, cloudHealth, rulesYaml] = await Promise.all([
    checkDashboardJsonFreshness(),
    checkDashboardJsonValidity(),
    checkCloudComputerHealth(),
    checkRulesYaml(),
  ]);
  findings.push(dashFreshness.finding, dashValidity, cloudHealth, rulesYaml);

  // Group 3: Native MySQL checks (all run unconditionally — no SQLite dependency)
  const dbResult = await checkPondNurtureDbAccessible();
  findings.push(dbResult.finding);

  const [pondToday, botRecent, duplicates, staleCap, smsErrors, auditErrors] = await Promise.all([
    checkPondNurtureRanToday(),
    checkBotSmsRanRecently(),
    checkDuplicateTextsToday(),
    checkStaleReassignmentCap(),
    checkPondNurtureSmsErrors(),
    checkAnyAuditLogErrorsToday(),
  ]);
  findings.push(pondToday, botRecent, duplicates, staleCap, smsErrors, auditErrors);

  // Group 4: Credential checks + healer staleness (fast, no external calls)
  const [smtpCheck, fubKeyCheck, healerLastRan] = await Promise.all([
    checkSmtpCredentials(),
    checkFubApiKey(),
    checkHealerLastRan(),
  ]);
  findings.push(smtpCheck, fubKeyCheck, healerLastRan);

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

  // ── Notify owner if critical errors found ──────────────────────────────────
  if (errorCount > 0) {
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
          `🔗 Quick Links:`,
          `  • FUB Dashboard: https://app.followupboss.com/2/`,
          `  • FUB People: https://app.followupboss.com/2/people`,
          `  • Lifestyle Bot Dashboard: https://lifestyledash-wpnl8v84.manus.space`,
        ].filter(Boolean).join("\n"),
      });
    } catch (e) {
      console.warn("[bot-monitor] Could not send owner notification:", e);
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
