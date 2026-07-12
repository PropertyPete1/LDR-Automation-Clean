// ============================================================================
// UNIFIED HEALER API BRIDGE — Add to server/_core/index.ts
// ============================================================================
// Add this import near the top of index.ts (alongside other imports):
//
//   import { db } from "../db";
//   import { botObservations } from "../schema";
//   import { and, gte, inArray } from "drizzle-orm";
//
// Then paste the route handler below into index.ts, after the existing
// scheduled bot routes (around line 415+), before the final app.listen().
// ============================================================================

// ---------------------------------------------------------------------------
// GET /api/healer/observations
// Used by the cloud computer's nightly_health.py to pull all bot_observations
// from the past 24 hours with severity 'error' or 'warning'.
// Authentication: x-healer-token header must match HEALER_SECRET env var.
// ---------------------------------------------------------------------------
app.get("/api/healer/observations", async (req, res) => {
  try {
    // ── Auth check ───────────────────────────────────────────────────────────
    const token = req.headers["x-healer-token"];
    const secret = process.env.HEALER_SECRET;
    if (!secret) {
      console.error("[healer-api] HEALER_SECRET env var is not set");
      return res.status(500).json({ error: "Server misconfiguration: HEALER_SECRET not set" });
    }
    if (!token || token !== secret) {
      return res.status(401).json({ error: "Unauthorized: invalid or missing x-healer-token" });
    }

    // ── Query window: last 24 hours ──────────────────────────────────────────
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // ── Fetch error/warning observations from bot_observations ───────────────
    const rows = await db
      .select({
        id: botObservations.id,
        source: botObservations.source,
        category: botObservations.category,
        severity: botObservations.severity,
        message: botObservations.message,
        detail: botObservations.detail,
        autoFixable: botObservations.autoFixable,
        resolved: botObservations.resolved,
        createdAt: botObservations.createdAt,
      })
      .from(botObservations)
      .where(
        and(
          inArray(botObservations.severity, ["error", "warning"]),
          gte(botObservations.createdAt, since)
        )
      )
      .orderBy(botObservations.createdAt);

    // ── Also fetch today's run_complete observations for each known bot ───────
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const runCompletes = await db
      .select({
        id: botObservations.id,
        source: botObservations.source,
        category: botObservations.category,
        severity: botObservations.severity,
        message: botObservations.message,
        detail: botObservations.detail,
        autoFixable: botObservations.autoFixable,
        resolved: botObservations.resolved,
        createdAt: botObservations.createdAt,
      })
      .from(botObservations)
      .where(
        and(
          inArray(botObservations.category, ["run_complete", "run_start"]),
          gte(botObservations.createdAt, todayStart)
        )
      )
      .orderBy(botObservations.createdAt);

    return res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      window_hours: 24,
      observations: rows,
      run_status: runCompletes,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[healer-api] Error fetching observations:", msg);
    return res.status(500).json({ error: msg });
  }
});

// ============================================================================
// ENVIRONMENT VARIABLE TO ADD
// ============================================================================
// In your WebDev project's environment variables (via the Manus WebDev UI),
// add the following variable:
//
//   HEALER_SECRET=<a long random string, e.g. 64 hex chars>
//
// Generate one with: python3 -c "import secrets; print(secrets.token_hex(32))"
//
// Then add the SAME value to the cloud computer's .env file as:
//   DASHBOARD_URL=https://<your-webdev-domain>.manus.app
//   HEALER_SECRET=<same value as above>
// ============================================================================
