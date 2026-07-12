import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import path from "path";
import fs from "fs/promises";
import { exec } from "child_process";
import { sdk } from "./sdk";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { runNightlyHealer } from "../nightlyHealer";
import { runLifestyleBot, sendBotClockoffEmail, sendBotClockinEmail } from "../lifestyleBot";
import { runBotMonitor } from "../botMonitor";
import { runBounceHandler } from "../bounceHandler";
import { runReplyIntentHandler } from "../replyIntentHandler";
import { runPondNurture } from "../pondNurture";
import { runAutoPondPromotion } from "../autoPondPromotion";
import { getSmsSentLastWeekByAgent, insertMonitorLog, pruneOldSmsSentToday, writeObservation } from "../db";
import { notifyOwner } from "./notification";


const CLICKS_FILE_PATH = "/home/ubuntu/fub_automation/data/clicks.json";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);

  // Serve dynamically generated PDFs directly
  app.use("/pdf", express.static("/home/ubuntu/fub_nurture_dashboard/client/public/pdf"));

  // Custom API Endpoint for tracking Tap-to-Text clicks
  app.post("/api/track-click", async (req, res) => {
    try {
      const { agent, phone, body } = req.body;
      if (!agent) {
        res.status(400).json({ error: "Agent name is required" });
        return;
      }
      let clicks: Array<{ timestamp: string; agent: string; phone: string; body: string }> = [];
      try {
        const fileContent = await fs.readFile(CLICKS_FILE_PATH, "utf-8");
        clicks = JSON.parse(fileContent);
      } catch {
        // File doesn't exist or is empty, start with empty array
      }
      const newClick = {
        timestamp: new Date().toISOString(),
        agent: (agent as string).trim(),
        phone: (phone as string) || "",
        body: (body as string) || "",
      };
      clicks.push(newClick);
      await fs.mkdir(path.dirname(CLICKS_FILE_PATH), { recursive: true });
      await fs.writeFile(CLICKS_FILE_PATH, JSON.stringify(clicks, null, 2), "utf-8");
      res.status(200).json({ success: true, click: newClick });
    } catch (error) {
      console.error("Failed to track click:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Video download endpoint — forces browser to download instead of stream
  const VIDEO_CDN_MAP: Record<string, string> = {
    tiffany: "https://files.manuscdn.com/user_upload_by_module/session_file/310519663320037777/xlsPDNVculOVmZHv.mp4",
    steven: "https://files.manuscdn.com/user_upload_by_module/session_file/310519663320037777/xJSpzlBKrzolLXgM.mp4",
    abby: "https://files.manuscdn.com/user_upload_by_module/session_file/310519663320037777/jtzMcWKGccNxfskC.mp4",
    stefanie: "https://files.manuscdn.com/user_upload_by_module/session_file/310519663320037777/HHcIzogIsNrCgcSW.mp4",
    laila: "https://files.manuscdn.com/user_upload_by_module/session_file/310519663320037777/nKLQpJLflByLplpu.mp4",
    peter: "https://files.manuscdn.com/user_upload_by_module/session_file/310519663320037777/AkTZXhxLwompgOHK.mp4",
    irma: "https://files.manuscdn.com/user_upload_by_module/session_file/310519663320037777/RPEeAYLIlYChDsLF.mp4",
  };
  app.get("/api/download-video", async (req, res) => {
    try {
      const agent = ((req.query.agent as string) || "").toLowerCase().trim();
      const videoUrl = VIDEO_CDN_MAP[agent];
      if (!videoUrl) {
        res.status(404).json({ error: "No video found for agent" });
        return;
      }
      // Proxy the video with Content-Disposition: attachment to force download
      const agentName = agent.charAt(0).toUpperCase() + agent.slice(1);
      const filename = `LDR_Promo_Video_${agentName}.mp4`;
      const upstream = await fetch(videoUrl);
      if (!upstream.ok) {
        res.status(502).json({ error: "Failed to fetch video from CDN" });
        return;
      }
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      if (upstream.headers.get("content-length")) {
        res.setHeader("Content-Length", upstream.headers.get("content-length")!);
      }
      // Stream the video bytes to the client
      const reader = upstream.body?.getReader();
      if (!reader) { res.status(500).end(); return; }
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          if (!res.write(value)) {
            await new Promise(resolve => res.once("drain", resolve));
          }
        }
      };
      pump().catch(err => { console.error("Video stream error:", err); res.destroy(); });
    } catch (error) {
      console.error("Failed to serve video download:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Audit health status — returns the latest sevenx_audit.py result JSON
  // Used by the admin dashboard audit health card (no auth required — read-only)
  app.get("/api/audit-status", async (_req, res) => {
    const AUDIT_RESULT_PATH = "/home/ubuntu/fub_automation/audit_result.json";
    try {
      const content = await fs.readFile(AUDIT_RESULT_PATH, "utf-8");
      const data = JSON.parse(content);
      res.json(data);
    } catch {
      // File doesn't exist yet — return a "never run" state
      res.json({
        run_at: null,
        passed: 0,
        total: 369,
        failed: 0,
        score_pct: 0,
        clean: false,
        failures: [],
        audit_version: "7x",
        never_run: true,
      });
    }
  });

  // Run audit on-demand — triggered by the "Run Audit" button on the admin dashboard
  // Runs sevenx_audit.py (~60s) and returns the fresh result
  app.post("/api/scheduled/run-audit", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      // Allow both cron and authenticated users (Peter) to trigger the audit
      if (!user.isCron && !user.openId) {
        res.status(403).json({ error: "auth-required" });
        return;
      }
    } catch {
      res.status(403).json({ error: "auth-failed" });
      return;
    }
    const scriptPath = "/home/ubuntu/fub_automation/sevenx_audit.py";
    const cmd = `cd /home/ubuntu/fub_automation && python3 ${scriptPath}`;
    exec(cmd, { timeout: 120000 }, async (err) => {
      if (err) {
        console.error("[run-audit] script error:", err.message);
      }
      // Read and return the result file (written by sevenx_audit.py)
      try {
        const content = await fs.readFile("/home/ubuntu/fub_automation/audit_result.json", "utf-8");
        const data = JSON.parse(content);
        res.json({ ok: true, ...data });
      } catch {
        res.status(500).json({ ok: false, error: "Audit failed to produce results" });
      }
    });
  });

  // Speed-to-lead heartbeat handler — triggered every 5 minutes by manus-heartbeat
  // Runs the lightweight Python speed-to-lead checker (business hours 10am-6pm CT only)
  app.post("/api/scheduled/speed-to-lead", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) {
        res.status(403).json({ error: "cron-only" });
        return;
      }
    } catch {
      res.status(403).json({ error: "auth-failed" });
      return;
    }
    // Speed-to-lead monitoring runs on the cloud computer via nightly_health.py.
    // The web app container does not have access to the cloud computer filesystem,
    // so we perform a lightweight FUB API check here instead of running a Python script.
    const fubApiKey = process.env.FUB_API_KEY;
    if (!fubApiKey) {
      await writeObservation({
        source: "speed_to_lead",
        severity: "warning",
        category: "config",
        message: "Speed-to-lead check skipped — FUB_API_KEY not set",
        detail: null,
        autoFixable: 0,
      }).catch(() => {});
      res.json({ ok: true, skipped: "no-api-key" });
      return;
    }

    try {
      // Check for new leads in the last 35 minutes (fires every 5 min, 10am-6pm CT)
      const cutoff = new Date(Date.now() - 35 * 60 * 1000).toISOString();
      const fubRes = await fetch(
        `https://api.followupboss.com/v1/events?type=New+Lead&minCreated=${encodeURIComponent(cutoff)}&limit=10`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(fubApiKey + ":").toString("base64")}`,
            "X-System": "Lifestyle Command Center",
            "X-System-Key": fubApiKey,
          },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!fubRes.ok) {
        await writeObservation({
          source: "speed_to_lead",
          severity: "warning",
          category: "fub_api",
          message: `Speed-to-lead FUB check returned ${fubRes.status}`,
          detail: null,
          autoFixable: 1,
        }).catch(() => {});
        res.json({ ok: true, status: fubRes.status });
        return;
      }

      const data = await fubRes.json() as { events?: Array<{ id: number; created: string; personId?: number }> };
      const newLeads = data?.events ?? [];

      if (newLeads.length > 0) {
        await writeObservation({
          source: "speed_to_lead",
          severity: "info",
          category: "new_lead",
          message: `Speed-to-lead: ${newLeads.length} new lead event${newLeads.length !== 1 ? "s" : ""} in last 35 min`,
          detail: `Lead IDs: ${newLeads.map(e => e.id).join(", ").slice(0, 300)}`,
          autoFixable: 0,
        }).catch(() => {});
        console.log(`[speed-to-lead] ${newLeads.length} new lead events detected`);
      } else {
        // Silent ok — no new leads, no observation needed (keeps DB clean)
        console.log("[speed-to-lead] No new leads in last 35 min");
      }

      res.json({ ok: true, newLeads: newLeads.length });
    } catch (fetchErr: unknown) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      await writeObservation({
        source: "speed_to_lead",
        severity: "warning",
        category: "fub_api",
        message: "Speed-to-lead FUB API call failed",
        detail: msg.slice(0, 300),
        autoFixable: 1,
      }).catch(() => {});
      res.json({ ok: true, error: msg });
    }
  });

  // Weekly audit log pruning heartbeat handler
  // Deletes audit_log rows older than 90 days to prevent unbounded growth
  app.post("/api/scheduled/prune-audit-log", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) {
        res.status(403).json({ error: "cron-only" });
        return;
      }
    } catch {
      res.status(403).json({ error: "auth-failed" });
      return;
    }
    const scriptPath = "/home/ubuntu/fub_automation/prune_audit_log.py";
    const cmd = `python3 ${scriptPath}`;
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.error("[prune-audit-log] script error:", err.message);
        console.error("[prune-audit-log] stderr:", stderr);
        res.status(500).json({
          error: err.message,
          stack: err.stack,
          context: { url: req.url, taskUid: (req as any).taskUid },
          timestamp: new Date().toISOString(),
        });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        console.log("[prune-audit-log] result:", result);
        res.json({ ok: true, ...result });
      } catch {
        console.log("[prune-audit-log] stdout:", stdout.trim());
        res.json({ ok: true });
      }
    });
  });

  // Nightly self-healing orchestrator — runs eightx_audit, auto-fixes, auto-expands, emails Peter
  // Timeout: 5 minutes (audit runs twice + email send)
  app.post("/api/scheduled/nightly-health", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) {
        res.status(403).json({ error: "cron-only" });
        return;
      }
    } catch {
      res.status(403).json({ error: "auth-failed" });
      return;
    }
    try {
      console.log("[nightly-health] Starting inline healer...");
      const result = await runNightlyHealer();
      console.log("[nightly-health] Complete:", result);
      res.json({ ok: true, ...result });
        } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[nightly-health] Healer threw:", msg);
      // Critical: if the healer itself crashes, write an observation so the NEXT monitor run sees it
      writeObservation({
        source: "nightly_healer",
        severity: "error",
        category: "healer_crash",
        message: "Nightly healer crashed at top level — morning summary was NOT sent",
        detail: msg.slice(0, 500),
        autoFixable: 0,
        runId: `crash-${Date.now()}`,
      }).catch(() => {});
      res.status(500).json({
        error: msg,
        context: { url: req.url },
        timestamp: new Date().toISOString(),
      });
    }
  });
  // Weekly SMS leaderboard email — runs every Monday 9am CT via heartbeat cron
  app.post("/api/scheduled/weekly-leaderboard", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) { res.status(403).json({ error: "cron-only" }); return; }
    } catch { res.status(403).json({ error: "auth-failed" }); return; }
    try {
      const rows = await getSmsSentLastWeekByAgent();
      if (rows.length === 0) {
        await notifyOwner({ title: "📊 Weekly SMS Leaderboard", content: "No texts were recorded last week." });
        res.json({ ok: true, message: "No data" });
        return;
      }
      const medals = ["🥇", "🥈", "🥉"];
      const lines = rows.map((r, i) => `${medals[i] ?? "  "} ${r.agentName}: ${r.weekTexts} text${r.weekTexts === 1 ? "" : "s"}`);
      const total = rows.reduce((sum, r) => sum + r.weekTexts, 0);
      const content = ["Last week's SMS leaderboard:", "", ...lines, "", `Total: ${total} texts sent across the team.`, "", "Keep up the great work! 💪"].join("\n");
      await notifyOwner({ title: `📊 Weekly SMS Leaderboard — ${total} texts last week`, content });
      const pruned = await pruneOldSmsSentToday();
      console.log(`[weekly-leaderboard] Sent leaderboard. Pruned ${pruned} old rows.`);
      res.json({ ok: true, rows, pruned });
        } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[weekly-leaderboard] Error:", msg);
      writeObservation({
        source: "weekly_leaderboard",
        severity: "error",
        category: "leaderboard_crash",
        message: "Weekly SMS leaderboard email crashed",
        detail: msg.slice(0, 500),
        autoFixable: 0,
        runId: `crash-${Date.now()}`,
      }).catch(() => {});
      res.status(500).json({ error: msg });
    }
  });
  // Lifestyle Bot — 8th virtual agent, posts AI-generated FUB notes on pond leads 20+ days stale
  // Runs weekdays 10am CT via heartbeat cron
  app.post("/api/scheduled/lifestyle-bot", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) { res.status(403).json({ error: "cron-only" }); return; }
    } catch { res.status(403).json({ error: "auth-failed" }); return; }
    try {
      console.log("[lifestyle-bot] Starting Lifestyle Bot run...");
      const result = await runLifestyleBot();
      console.log(`[lifestyle-bot] Complete: ${result.leadsProcessed} processed, ${result.leadsErrored} errors`);
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[lifestyle-bot] Bot threw:", msg);
      // Write a critical observation so the nightly healer and bot monitor both see the crash
      writeObservation({
        source: "lifestyle_bot",
        severity: "error",
        category: "bot_crash",
        message: "Lifestyle Bot crashed at top level — entire run failed",
        detail: msg.slice(0, 500),
        autoFixable: 0,
        runId: `crash-${Date.now()}`,
      }).catch((obsErr: unknown) => console.warn("[lifestyle-bot] Could not write crash observation:", obsErr));
      res.status(500).json({ error: msg, context: { url: req.url }, timestamp: new Date().toISOString() });
    }
  });



  // Lifestyle Bot Morning Clock-In — 10am CT daily
  // Sends a warm morning email to Peter & Steven: leads queued for today, day's plan
  app.post("/api/scheduled/bot-clockin", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) { res.status(403).json({ error: "cron-only" }); return; }
    } catch { res.status(403).json({ error: "auth-failed" }); return; }
    try {
      console.log("[bot-clockin] Sending morning clock-in email...");
      const result = await sendBotClockinEmail();
      console.log(`[bot-clockin] ${result.sent ? "✓ Sent" : "✗ Failed"} — ${result.leadsQueued} leads queued today`);
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[bot-clockin] Threw:", msg);
      writeObservation({
        source: "bot_clockin",
        severity: "error",
        category: "clockin_crash",
        message: "Bot clock-in email crashed at top level",
        detail: msg.slice(0, 500),
        autoFixable: 0,
        runId: `crash-${Date.now()}`,
      }).catch(() => {});
      res.status(500).json({ error: msg, timestamp: new Date().toISOString() });
    }
  });

  // Lifestyle Bot Evening Clock-Off — 6pm CT daily
  // Sends a warm summary email to Peter & Steven: leads processed, FUB notes posted, any issues
  app.post("/api/scheduled/bot-clockoff", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) { res.status(403).json({ error: "cron-only" }); return; }
    } catch { res.status(403).json({ error: "auth-failed" }); return; }
    try {
      console.log("[bot-clockoff] Sending evening clock-off email...");
      const result = await sendBotClockoffEmail();
      console.log(`[bot-clockoff] ${result.sent ? "✓ Sent" : "✗ Failed"} — ${result.emailsToday} emails today`);
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[bot-clockoff] Threw:", msg);
      writeObservation({
        source: "bot_clockoff",
        severity: "error",
        category: "clockoff_crash",
        message: "Bot clock-off email crashed at top level",
        detail: msg.slice(0, 500),
        autoFixable: 0,
        runId: `crash-${Date.now()}`,
      }).catch(() => {});
      res.status(500).json({ error: msg, timestamp: new Date().toISOString() });
    }
  });

  // Bot Monitor — autonomous 30-minute health check engine
  // Checks FUB data accuracy, bot health, rule violations, and system files
  // Runs every 30 min via heartbeat cron, auto-fixes what it can
  app.post("/api/scheduled/bot-monitor", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) { res.status(403).json({ error: "cron-only" }); return; }
    } catch { res.status(403).json({ error: "auth-failed" }); return; }
    try {
      const triggeredBy = (req.body?.triggeredBy === "manual") ? "manual" : "cron";
      console.log(`[bot-monitor] Starting monitor run (triggered by: ${triggeredBy})...`);
      const result = await runBotMonitor(triggeredBy);
      // Persist to DB (non-blocking — don't let a DB failure break the response)
      insertMonitorLog({
        runAt: new Date(result.ranAt),
        checksRun: result.checksRun,
        issuesFound: result.issuesFound,
        issuesFixed: result.issuesFixed,
        findings: JSON.stringify(result.findings),
        summary: result.summary,
        triggeredBy: result.triggeredBy,
        durationMs: result.durationMs,
      }).catch(e => console.warn("[bot-monitor] DB log failed:", e));
      console.log(`[bot-monitor] Complete: ${result.summary}`);
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[bot-monitor] Monitor threw:", msg);
      res.status(500).json({ error: msg, timestamp: new Date().toISOString() });
    }
  });

  // Pond Nurture — daily AI-personalized emails to ALL pond leads from peter@lifestyledesignrealty.com
  // Runs daily at 8am CT (13:00 UTC) via heartbeat cron
  // Native TypeScript pond nurture engine — 14-day cadence, dynamic daily cap (eligible ÷ 14), AI-personalized, live FUB notes
  app.post("/api/scheduled/pond-nurture", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) { res.status(403).json({ error: "cron-only" }); return; }
    } catch { res.status(403).json({ error: "auth-failed" }); return; }
    // Respond immediately so the heartbeat doesn't time out (run is async, up to 30 min)
    res.json({ ok: true, status: "started" });
    try {
      const result = await runPondNurture();
      console.log(`[pond-nurture] Complete: ${result.sent} sent, ${result.skipped} skipped, ${result.suppressed} suppressed, ${result.errors} errors, ${result.reassigned} reassigned`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[pond-nurture] Fatal error:", msg);
      writeObservation({
        source: "pond_nurture",
        severity: "error",
        category: "run_error",
        message: "Pond nurture fatal error",
        detail: msg.slice(0, 500),
        autoFixable: 0,
      }).catch(() => {});
    }
  });

  // Auto-Pond Promotion — runs nightly at 2am CT via heartbeat cron
  // Moves all agent leads created 20+ days ago to the pond for Lifestyle Bot nurturing
  app.post("/api/scheduled/auto-pond-promotion", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) { res.status(403).json({ error: "cron-only" }); return; }
    } catch { res.status(403).json({ error: "auth-failed" }); return; }
    // Respond immediately so the heartbeat doesn't time out
    res.json({ ok: true, status: "started" });
    try {
      const result = await runAutoPondPromotion("cron");
      console.log(`[auto-pond-promotion] Complete: ${result.summary}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[auto-pond-promotion] Fatal error:", msg);
      writeObservation({
        source: "auto_pond_promotion",
        severity: "error",
        category: "run_error",
        message: "Auto-pond promotion fatal error",
        detail: msg.slice(0, 500),
        autoFixable: 0,
      }).catch(() => {});
    }
  });

  // Daily email bounce handler — runs at 4:30am CT via heartbeat cron
  // Scans Gmail for permanent delivery failures and auto-handles each bounced lead in FUB
  app.post("/api/scheduled/bounce-handler", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) {
        res.status(403).json({ error: "cron-only" });
        return;
      }
    } catch {
      res.status(403).json({ error: "auth-failed" });
      return;
    }
    try {
      console.log("[bounce-handler] Starting bounce scan...");
      const result = await runBounceHandler();
      console.log("[bounce-handler] Complete:", result);
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[bounce-handler] Fatal error:", msg);
      writeObservation({
        source: "bounce_handler",
        severity: "error",
        category: "bot_crash",
        message: "Bounce handler crashed at top level — entire run failed",
        detail: msg.slice(0, 500),
        autoFixable: 0,
        runId: `crash-${Date.now()}`,
      }).catch(() => {});
      res.status(500).json({
        error: msg,
        context: { url: req.url },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Reply Intent Handler — auto opt-out when leads reply indicating no longer interested
  // Runs every 2 hours via heartbeat cron, scans Gmail inbox for lead replies
  app.post("/api/scheduled/reply-intent-handler", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user.isCron) {
        res.status(403).json({ error: "cron-only" });
        return;
      }
    } catch {
      res.status(403).json({ error: "auth-failed" });
      return;
    }
    try {
      console.log("[reply-intent] Starting reply intent scan...");
      const result = await runReplyIntentHandler();
      console.log(`[reply-intent] Complete: ${result.optOutsApplied} opt-outs applied, ${result.messagesScanned} scanned`);
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[reply-intent] Fatal error:", msg);
      writeObservation({
        source: "reply_intent",
        severity: "error",
        category: "reply_scan",
        message: "Reply intent handler crashed at top level",
        detail: msg.slice(0, 500),
        autoFixable: 0,
        runId: `crash-${Date.now()}`,
      }).catch(() => {});
      res.status(500).json({
        error: msg,
        context: { url: req.url },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
