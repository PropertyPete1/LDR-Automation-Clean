/**
 * heartbeatBootstrap.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Ensures all required heartbeat cron jobs are registered after every deploy.
 * Called once during server startup (after listen). Uses empty userSession
 * which falls back to the project owner identity.
 *
 * If a job already exists (by name), it's left alone. If missing, it's created.
 * This prevents the "cron disappeared after redeploy" failure mode.
 */

import { createHeartbeatJob, listHeartbeatJobs, updateHeartbeatJob, type HeartbeatJob, type HeartbeatJobInfo } from "./_core/heartbeat";
import { writeObservation } from "./db";

// ── Required heartbeat jobs ──────────────────────────────────────────────────
// All times in UTC (CT = UTC-5 during CDT, UTC-6 during CST)

// NOTE: pond-nurture-daily REMOVED 2026-07-13 — GitHub Actions is now the sole
// pond nurture sender. The heartbeat cron has been disabled via API and must NOT
// be re-registered by bootstrap. The /api/scheduled/pond-nurture endpoint remains
// in index.ts but will never be called by the scheduler.
//
// NOTE: The following jobs have been PERMANENTLY RETIRED from this dashboard
// (2026-07-17) because their functions are now owned by GitHub Actions or were
// deprecated with the 8th bot cutover:
//   - speed-to-lead-5min → GitHub Actions speed-to-lead.yml (Python) owns this
//   - auto-pond-promotion-nightly → Python scan_stale_agent_no_note_reassignment owns pond moves
//   - bot-monitor-30min → deprecated with 8th bot (lifestyledash owns agent bot monitoring)
//   - lifestyle-bot-daily → deprecated with 8th bot (pond nurture on GH Actions)
//   - bot-clockin-daily → deprecated with 8th bot (lifestyledash owns agent bot clock-in)
//   - bot-clockoff-daily → deprecated with 8th bot (lifestyledash owns agent bot clock-off)
// Their heartbeat registrations have been paused/deleted via API. Do NOT re-add.

export const REQUIRED_HEARTBEAT_JOBS: HeartbeatJob[] = [
  {
    name: "nightly-health-healer",
    cron: "0 0 0 * * *", // 7pm CT = 00:00 UTC (next day)
    path: "/api/scheduled/nightly-health",
    description: "End-of-day healer: auto-fix errors, prune logs, send daily health summary to Peter after all bots have run",
  },
  {
    name: "bounce-handler-daily",
    cron: "0 30 14 * * *", // 9:30am CT = 14:30 UTC
    path: "/api/scheduled/bounce-handler",
    description: "Bounce handler: detect and suppress bounced email addresses",
  },
  {
    name: "reply-intent-handler-hourly",
    cron: "0 4 * * * *", // Every hour at :04
    path: "/api/scheduled/reply-intent-handler",
    description: "Reply intent handler: scan inbound emails for opt-out/buying intent",
  },
  {
    name: "annual-nurture-daily",
    cron: "0 30 13 * * *", // 8:30am CT = 13:30 UTC
    path: "/api/scheduled/annual-nurture",
    description: "Annual nurture: birthday/anniversary emails for pond leads",
  },
];

/**
 * Bootstrap all required heartbeat jobs. Safe to call on every startup —
 * existing jobs are skipped, missing jobs are created, disabled jobs are re-enabled.
 */
export async function bootstrapHeartbeatJobs(): Promise<{
  checked: number;
  created: number;
  reEnabled: number;
  errors: string[];
}> {
  const result = { checked: 0, created: 0, reEnabled: 0, errors: [] as string[] };

  try {
    // List existing jobs (empty session = project owner)
    const { jobs: existingJobs } = await listHeartbeatJobs("", { pageSize: 100 });
    const existingByName = new Map<string, HeartbeatJobInfo>();
    for (const job of existingJobs) {
      existingByName.set(job.name, job);
    }

    for (const required of REQUIRED_HEARTBEAT_JOBS) {
      result.checked++;
      const existing = existingByName.get(required.name);

      if (!existing) {
        // Job doesn't exist — create it
        try {
          await createHeartbeatJob(required, "");
          result.created++;
          console.log(`[heartbeat-bootstrap] Created missing job: ${required.name}`);
        } catch (e) {
          const msg = `Failed to create ${required.name}: ${e instanceof Error ? e.message : String(e)}`;
          result.errors.push(msg);
          console.error(`[heartbeat-bootstrap] ${msg}`);
        }
      } else if (!existing.isEnable) {
        // Job exists but is disabled — re-enable it
        try {
          await updateHeartbeatJob(existing.taskUid, { enable: true }, "");
          result.reEnabled++;
          console.log(`[heartbeat-bootstrap] Re-enabled disabled job: ${required.name}`);
        } catch (e) {
          const msg = `Failed to re-enable ${required.name}: ${e instanceof Error ? e.message : String(e)}`;
          result.errors.push(msg);
          console.error(`[heartbeat-bootstrap] ${msg}`);
        }
      } else {
        // Job exists and is enabled — nothing to do
        console.log(`[heartbeat-bootstrap] ✓ ${required.name} (enabled, next: ${existing.nextExecutionAt ?? "unknown"})`);
      }
    }

    // Log summary
    if (result.created > 0 || result.reEnabled > 0) {
      await writeObservation({
        source: "heartbeat_bootstrap",
        severity: "info",
        category: "bootstrap_run",
        message: `Heartbeat bootstrap: ${result.created} created, ${result.reEnabled} re-enabled, ${result.errors.length} errors`,
        detail: result.errors.length > 0 ? result.errors.join("; ") : null,
        autoFixable: 0,
      });
    }
  } catch (e) {
    const msg = `Bootstrap failed to list jobs: ${e instanceof Error ? e.message : String(e)}`;
    result.errors.push(msg);
    console.error(`[heartbeat-bootstrap] ${msg}`);
  }

  return result;
}

/**
 * RETIRED 2026-07-13 — Pond nurture is now handled exclusively by GitHub Actions.
 * This function intentionally does nothing so the nightly healer cannot
 * accidentally re-enable the disabled heartbeat cron.
 */
export async function healStalePondNurtureCron(): Promise<{ fixed: boolean; note: string }> {
  return {
    fixed: false,
    note: "Pond nurture cron intentionally disabled — GitHub Actions is the sole sender (retired 2026-07-13)",
  };
}
