import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import {
  handleSpClockin, handleSpRun, handleSpClockoff,
  handleSpPeterRun, handleSpStevenRun,
  handleTiffanyClockin, handleTiffanyRun, handleTiffanyClockoff,
  handleStefanieClockin, handleStefanieRun, handleStefanieClockoff,
  handleAbbyClockin, handleAbbyRun, handleAbbyClockoff,
  handleIrmaClockin, handleIrmaRun, handleIrmaClockoff,
  handleLailaClockin, handleLailaRun, handleLailaClockoff,
  handleBotMonitor,
  handleLeadReplyCheck,
} from "../scheduledHandlers";
import { getDb } from "../db";
import { botObservations, botRunLogs } from "../../drizzle/schema";
import { gte, desc } from "drizzle-orm";

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
  // ─── Scheduled bot endpoints (must be before Vite/static fallthrough) ───────
  app.post("/api/scheduled/sp-clockin", handleSpClockin);
  app.post("/api/scheduled/sp-run", handleSpRun);
  app.post("/api/scheduled/sp-peter-run", handleSpPeterRun);
  app.post("/api/scheduled/sp-steven-run", handleSpStevenRun);
  app.post("/api/scheduled/sp-clockoff", handleSpClockoff);
  app.post("/api/scheduled/tiffany-clockin", handleTiffanyClockin);
  app.post("/api/scheduled/tiffany-run", handleTiffanyRun);
  app.post("/api/scheduled/tiffany-clockoff", handleTiffanyClockoff);
  app.post("/api/scheduled/stefanie-clockin", handleStefanieClockin);
  app.post("/api/scheduled/stefanie-run", handleStefanieRun);
  app.post("/api/scheduled/stefanie-clockoff", handleStefanieClockoff);
  app.post("/api/scheduled/abby-clockin", handleAbbyClockin);
  app.post("/api/scheduled/abby-run", handleAbbyRun);
  app.post("/api/scheduled/abby-clockoff", handleAbbyClockoff);
  app.post("/api/scheduled/irma-clockin", handleIrmaClockin);
  app.post("/api/scheduled/irma-run", handleIrmaRun);
  app.post("/api/scheduled/irma-clockoff", handleIrmaClockoff);
  app.post("/api/scheduled/laila-clockin", handleLailaClockin);
  app.post("/api/scheduled/laila-run", handleLailaRun);
  app.post("/api/scheduled/laila-clockoff", handleLailaClockoff);
  app.post("/api/scheduled/bot-monitor", handleBotMonitor);
  app.post("/api/scheduled/lead-reply-check", handleLeadReplyCheck);

  // ─── Healer API — read-only endpoint for the 4am nightly health report ────────
  // Read-only endpoint for the nightly health report system.
  // Auth: x-healer-token header must match HEALER_SECRET env var.
  app.get("/api/healer/observations", async (req, res) => {
    const secret = process.env.HEALER_SECRET ?? "";
    const token = (req.headers["x-healer-token"] as string) ?? "";
    if (!secret || token !== secret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      // Look back 26 hours to cover the full prior day's bot runs
      const since = new Date(Date.now() - 26 * 60 * 60 * 1000);
      const [observations, runStatus] = await Promise.all([
        db
          .select()
          .from(botObservations)
          .where(gte(botObservations.createdAt, since))
          .orderBy(desc(botObservations.createdAt))
          .limit(200),
        db
          .select()
          .from(botRunLogs)
          .where(gte(botRunLogs.ranAt, since))
          .orderBy(desc(botRunLogs.ranAt))
          .limit(50),
      ]);
      // Map botRunLogs rows to the shape the healer expects:
      // { source: "tiffany_bot", category: "run_complete"|"run_start", createdAt }
      // We use botSlug (e.g. "tiffany") → healer slug ("tiffany_bot")
      const slugToHealerSlug: Record<string, string> = {
        sp500: "lifestyle_bot",
        sp500_peter: "peter_bot",
        sp500_steven: "steven_bot",
        tiffany: "tiffany_bot",
        stefanie: "rue_bot",
        abby: "abby_bot",
        irma: "irma_bot",
        laila: "laila_bot",
      };
      type RunRow = typeof runStatus[number];
      type ObsRow = typeof observations[number];
      const runStatusMapped = runStatus.map((r: RunRow) => ({
        source: slugToHealerSlug[r.botSlug] ?? r.botSlug,
        category: "run_complete" as const,
        createdAt: r.ranAt,
        sent: r.sent,
        errored: r.errored,
        skipped: r.skipped,
        status: r.status,
      }));
      // Map observations to healer slug too
      const observationsMapped = observations.map((o: ObsRow) => ({
        ...o,
        source: slugToHealerSlug[o.source] ?? o.source,
      }));
      res.json({
        observations: observationsMapped,
        run_status: runStatusMapped,
        generatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[healer/observations] Error:", err);
      res.status(500).json({ error: "Internal server error" });
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
