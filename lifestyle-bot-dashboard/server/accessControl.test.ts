import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

/**
 * Access Control Tests — Item 3
 *
 * Verifies:
 * (a) /agent-registry route: non-admins get redirected (tested client-side via component logic)
 * (b) Every agentRegistry tRPC procedure rejects non-admin callers
 * (c) Nav link hidden for non-admins (tested client-side via component logic)
 * (d) /agent/:name endpoints do NOT leak other agents' rows (scoped by slug)
 *
 * Tests (b) and (d) are server-side and can be tested here.
 */

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAdminContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "admin-user",
    email: "peter@lifestyledesignrealty.com",
    name: "Peter Allen",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

function createNonAdminContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 2,
    openId: "regular-user",
    email: "jason@lifestyledesignrealty.com",
    name: "Jason Casanova",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

function createUnauthContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

describe("Access Control — Item 3", () => {
  describe("(b) agentRegistry tRPC procedures reject non-admin callers", () => {
    it("agentRegistry.list rejects unauthenticated", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      await expect(caller.agentRegistry.list()).rejects.toThrow(/permission/i);
    });

    it("agentRegistry.list rejects non-admin", async () => {
      const caller = appRouter.createCaller(createNonAdminContext());
      await expect(caller.agentRegistry.list()).rejects.toThrow(/permission/i);
    });

    it("agentRegistry.fubUsers rejects unauthenticated", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      await expect(caller.agentRegistry.fubUsers()).rejects.toThrow(/permission/i);
    });

    it("agentRegistry.fubUsers rejects non-admin", async () => {
      const caller = appRouter.createCaller(createNonAdminContext());
      await expect(caller.agentRegistry.fubUsers()).rejects.toThrow(/permission/i);
    });

    it("agentRegistry.toggleActive rejects non-admin", async () => {
      const caller = appRouter.createCaller(createNonAdminContext());
      await expect(
        caller.agentRegistry.toggleActive({ id: 7, active: true })
      ).rejects.toThrow(/permission/i);
    });

    it("agentRegistry.create rejects non-admin", async () => {
      const caller = appRouter.createCaller(createNonAdminContext());
      await expect(
        caller.agentRegistry.create({
          botSlug: "test",
          botName: "Test Bot",
          agentFirstName: "Test",
          agentEmail: "test@example.com",
          fubUserId: 99,
        })
      ).rejects.toThrow(/permission/i);
    });

    it("agentRegistry.update rejects non-admin", async () => {
      const caller = appRouter.createCaller(createNonAdminContext());
      await expect(
        caller.agentRegistry.update({ id: 7, botName: "Hacked" })
      ).rejects.toThrow(/permission/i);
    });

    it("agentRegistry.delete rejects non-admin", async () => {
      const caller = appRouter.createCaller(createNonAdminContext());
      await expect(
        caller.agentRegistry.delete({ id: 7 })
      ).rejects.toThrow(/permission/i);
    });
  });

  describe("(d) /agent/:slug endpoint isolation — no cross-agent data leakage", () => {
    it("bots.agentView only returns data for the requested slug", async () => {
      // This is a public procedure (linked from clock-in emails), so test with no auth
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.bots.agentView({ slug: "jason" });

      // The result should only contain data for 'jason', never other slugs
      if (result.weeklyRuns.length > 0) {
        for (const run of result.weeklyRuns) {
          expect(run.botSlug).toBe("jason");
        }
      }
      if (result.recentLeads.length > 0) {
        for (const lead of result.recentLeads) {
          expect(lead.botSlug).toBe("jason");
        }
      }
      // Even if no data, the structure is correct and scoped
      expect(result).toHaveProperty("bot");
      expect(result).toHaveProperty("weeklyRuns");
      expect(result).toHaveProperty("recentLeads");
    });

    it("bots.agentView for tiffany does NOT return jason data", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.bots.agentView({ slug: "tiffany" });

      if (result.weeklyRuns.length > 0) {
        for (const run of result.weeklyRuns) {
          expect(run.botSlug).toBe("tiffany");
          expect(run.botSlug).not.toBe("jason");
        }
      }
      if (result.recentLeads.length > 0) {
        for (const lead of result.recentLeads) {
          expect(lead.botSlug).toBe("tiffany");
          expect(lead.botSlug).not.toBe("jason");
        }
      }
    });

    it("bots.agentView for a nonexistent slug returns null bot", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      const result = await caller.bots.agentView({ slug: "nonexistent_agent_xyz" });
      expect(result.bot).toBeNull();
      expect(result.weeklyRuns).toHaveLength(0);
      expect(result.recentLeads).toHaveLength(0);
    });
  });
});
