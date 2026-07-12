import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { botRunLogs, botObservations, contactedLeads } from "../drizzle/schema";
import { desc, eq, gte, and, sql } from "drizzle-orm";
import { checkAllBotHealth } from "./botMonitor";
import { fubRequest, FUB_API_KEY, fetchPowerQueueCount } from "./botHelpers";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // ─── Bot Activity ───────────────────────────────────────────────────────────────────────────────────────
  bots: router({
    health: protectedProcedure.query(async () => {
      return checkAllBotHealth();
    }),

    recentRuns: protectedProcedure
      .input((input: unknown) => {
        const i = input as { slug: string; limit?: number };
        return { slug: i.slug, limit: Math.min(i.limit ?? 10, 50) };
      })
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return [];
        return db
          .select()
          .from(botRunLogs)
          .where(eq(botRunLogs.botSlug, input.slug))
          .orderBy(desc(botRunLogs.ranAt))
          .limit(input.limit);
      }),

    recentObservations: protectedProcedure.query(async () => {
      const db = await getDb();
      if (!db) return [];
      const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
      return db
        .select()
        .from(botObservations)
        .where(gte(botObservations.createdAt, since))
        .orderBy(desc(botObservations.createdAt))
        .limit(100);
    }),

    weeklyStats: protectedProcedure.query(async () => {
      const db = await getDb();
      if (!db) return [];
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      return db
        .select()
        .from(botRunLogs)
        .where(gte(botRunLogs.ranAt, since))
        .orderBy(desc(botRunLogs.ranAt));
    }),

    // Today-only stats: accurate "Sent Today" and "Errors Today" across all bots
    todayStats: protectedProcedure.query(async () => {
      const db = await getDb();
      if (!db) return { sentToday: 0, errorsToday: 0, botsRanToday: 0 };
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const runs = await db
        .select()
        .from(botRunLogs)
        .where(gte(botRunLogs.ranAt, todayStart))
        .orderBy(desc(botRunLogs.ranAt));
      // Dedupe to latest run per bot slug today
      const seenSlugs = new Set<string>();
      const todayRuns = runs.filter(r => {
        if (seenSlugs.has(r.botSlug)) return false;
        seenSlugs.add(r.botSlug);
        return true;
      });
      const sentToday = todayRuns.reduce((s, r) => s + (r.sent ?? 0), 0);
      const errorsToday = todayRuns.reduce((s, r) => s + (r.errored ?? 0), 0);
      const botsRanToday = todayRuns.length;
      return { sentToday, errorsToday, botsRanToday };
    }),

    // Public single-agent view — no auth required (used by email dashboard links)
    agentView: publicProcedure
      .input((input: unknown) => {
        const i = input as { slug: string };
        if (!i.slug || typeof i.slug !== "string") throw new Error("slug required");
        return { slug: i.slug };
      })
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return { bot: null, weeklyRuns: [], recentLeads: [] };

        // Latest run for this bot
        const latestRuns = await db
          .select()
          .from(botRunLogs)
          .where(eq(botRunLogs.botSlug, input.slug))
          .orderBy(desc(botRunLogs.ranAt))
          .limit(1);
        const latest = latestRuns[0] ?? null;

        // Today's run for this bot
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayRuns = await db
          .select()
          .from(botRunLogs)
          .where(and(eq(botRunLogs.botSlug, input.slug), gte(botRunLogs.ranAt, todayStart)))
          .orderBy(desc(botRunLogs.ranAt))
          .limit(1);
        const todayRun = todayRuns[0] ?? null;

        // 7-day run history
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const weeklyRuns = await db
          .select()
          .from(botRunLogs)
          .where(and(eq(botRunLogs.botSlug, input.slug), gte(botRunLogs.ranAt, since)))
          .orderBy(desc(botRunLogs.ranAt));

        // Recent leads contacted (last 24h)
        const leadsSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentLeads = await db
          .select()
          .from(contactedLeads)
          .where(and(eq(contactedLeads.botSlug, input.slug), gte(contactedLeads.sentAt, leadsSince)))
          .orderBy(desc(contactedLeads.sentAt))
          .limit(50);

        // Derive status
        const now = new Date();
        const ranToday = todayRun !== null;
        let status: "ok" | "warning" | "error" | "not_run" = "not_run";
        if (latest) {
          if (latest.status === "error" || (latest.errored ?? 0) > 0) status = "error";
          else if (ranToday) status = "ok";
          else {
            const hoursSince = (now.getTime() - new Date(latest.ranAt).getTime()) / 3_600_000;
            status = hoursSince > 26 ? "warning" : "ok";
          }
        }

        return {
          bot: latest ? {
            slug: input.slug,
            name: latest.botName,
            lastRanAt: latest.ranAt,
            sent: todayRun?.sent ?? 0,
            errored: todayRun?.errored ?? 0,
            skipped: todayRun?.skipped ?? 0,
            status,
            ranToday,
          } : null,
          weeklyRuns,
          recentLeads,
        };
      }),

    // Per-agent lead list: returns leads contacted today (or last 48h) for a given bot slug
    contactedLeads: protectedProcedure
      .input((input: unknown) => {
        const i = input as { slug: string; hours?: number };
        return { slug: i.slug, hours: Math.min(i.hours ?? 24, 72) };
      })
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return [];
        const since = new Date(Date.now() - input.hours * 60 * 60 * 1000);
        return db
          .select()
          .from(contactedLeads)
          .where(
            eq(contactedLeads.botSlug, input.slug)
          )
          .orderBy(desc(contactedLeads.sentAt))
          .limit(100);
      }),
  }),

  // ─── Pond Nurture metrics ──────────────────────────────────────────────────
  pondNurture: router({
    agentStats: protectedProcedure.query(async () => {
      if (!FUB_API_KEY) return [];
      try {
        // Fetch all FUB users (agents)
        const usersResp = await fubRequest<{ users: Array<{ id: number; name: string; email: string; role: string; isAdmin: boolean }> }>("/users?limit=50");
        const agents = (usersResp.users ?? []).filter(
          (u) => u.role !== "readonly" && u.email?.includes("lifestyledesignrealty.com")
        );

        // For each agent, fetch their lead counts by stage
        const agentStats = await Promise.all(
          agents.map(async (agent) => {
            try {
              const leadsResp = await fubRequest<{ _metadata: { total: number } }>(
                `/people?assignedUserId=${agent.id}&limit=1`
              );
              const total = leadsResp._metadata?.total ?? 0;

              // Fetch hot prospects
              const hotResp = await fubRequest<{ _metadata: { total: number } }>(
                `/people?assignedUserId=${agent.id}&stage=Hot+Prospect&limit=1`
              );
              const hot = hotResp._metadata?.total ?? 0;

              // Fetch active clients
              const activeResp = await fubRequest<{ _metadata: { total: number } }>(
                `/people?assignedUserId=${agent.id}&stage=Active+Client&limit=1`
              );
              const active = activeResp._metadata?.total ?? 0;

              return {
                id: agent.id,
                name: agent.name,
                email: agent.email,
                totalLeads: total,
                hotLeads: hot,
                activeClients: active,
                pipeline: Math.max(0, total - hot - active),
              };
            } catch {
              return {
                id: agent.id,
                name: agent.name,
                email: agent.email,
                totalLeads: 0,
                hotLeads: 0,
                activeClients: 0,
                pipeline: 0,
              };
            }
          })
        );
        return agentStats;
      } catch {
        return [];
      }
    }),

    pondMetrics: protectedProcedure.query(async () => {
      if (!FUB_API_KEY) return { pondTotal: 0, staleTotal: 0, recentlyNurtured: 0 };
      try {
        // Count pond leads using FUB pond filter
        const pondResp = await fubRequest<{ _metadata: { total: number } }>(
          `/people?isPond=true&limit=1`
        );
        const pondTotal = pondResp._metadata?.total ?? 0;

        // Count stale leads (20+ days no activity)
        const staleDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
        const staleDateStr = staleDate.toISOString().split("T")[0];
        const staleResp = await fubRequest<{ _metadata: { total: number } }>(
          `/people?lastActivityBefore=${staleDateStr}&limit=1`
        );
        const staleTotal = staleResp._metadata?.total ?? 0;

        // Count recently nurtured (contacted in last 14 days)
        const recentDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        const recentDateStr = recentDate.toISOString().split("T")[0];
        const recentResp = await fubRequest<{ _metadata: { total: number } }>(
          `/people?isPond=true&lastActivityAfter=${recentDateStr}&limit=1`
        );
        const recentlyNurtured = recentResp._metadata?.total ?? 0;

        return { pondTotal, staleTotal, recentlyNurtured };
      } catch {
        return { pondTotal: 0, staleTotal: 0, recentlyNurtured: 0 };
      }
    }),
    }),

  // ─── Power Queue (direct FUB query for 1-20 day stale leads) ──────────────────────────────────
  powerQueue: router({
    /**
     * Returns the live Power Queue count for a specific agent by querying FUB directly.
     * Power Queue = leads in the 1-20 day stale window the agent should personally text.
     * Uses agentName to look up the FUB ID from a static map.
     */
    getLiveCount: publicProcedure
      .input((input: unknown) => {
        const i = input as { agentName?: string };
        return { agentName: i?.agentName ?? "" };
      })
      .query(async ({ input }) => {
        // Map "Rue" (bot nickname) to "Stefanie" (FUB/portal name)
        const portalName = input.agentName.toLowerCase() === "rue" ? "Stefanie" : input.agentName;
        if (!portalName) return { count: 0, agentName: input.agentName, fetchedAt: Date.now() };
        try {
          const count = await fetchPowerQueueCount(portalName);
          return { count, agentName: input.agentName, fetchedAt: Date.now() };
        } catch {
          return { count: 0, agentName: input.agentName, fetchedAt: Date.now() };
        }
      }),
  }),
});
export type AppRouter = typeof appRouter;
