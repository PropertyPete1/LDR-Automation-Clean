import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

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
    email: "agent@lifestyledesignrealty.com",
    name: "Regular Agent",
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

describe("agentRegistry", () => {
  describe("authorization", () => {
    it("list - rejects unauthenticated users", async () => {
      const caller = appRouter.createCaller(createUnauthContext());
      await expect(caller.agentRegistry.list()).rejects.toThrow(/permission/);
    });

    it("list - rejects non-admin users", async () => {
      const caller = appRouter.createCaller(createNonAdminContext());
      await expect(caller.agentRegistry.list()).rejects.toThrow(/permission/);
    });

    it("toggleActive - rejects non-admin users", async () => {
      const caller = appRouter.createCaller(createNonAdminContext());
      await expect(
        caller.agentRegistry.toggleActive({ id: 1, active: true })
      ).rejects.toThrow(/permission/);
    });

    it("create - rejects non-admin users", async () => {
      const caller = appRouter.createCaller(createNonAdminContext());
      await expect(
        caller.agentRegistry.create({
          botSlug: "test",
          botName: "Test Bot",
          agentFirstName: "Test",
          agentEmail: "test@example.com",
          fubUserId: 99,
        })
      ).rejects.toThrow(/permission/);
    });

    it("update - rejects non-admin users", async () => {
      const caller = appRouter.createCaller(createNonAdminContext());
      await expect(
        caller.agentRegistry.update({ id: 1, botName: "Hacked" })
      ).rejects.toThrow(/permission/);
    });

    it("delete - rejects non-admin users", async () => {
      const caller = appRouter.createCaller(createNonAdminContext());
      await expect(
        caller.agentRegistry.delete({ id: 1 })
      ).rejects.toThrow(/permission/);
    });
  });

  describe("input validation", () => {
    it("create - requires mandatory fields", async () => {
      const caller = appRouter.createCaller(createAdminContext());
      await expect(
        caller.agentRegistry.create({
          botSlug: "",
          botName: "",
          agentFirstName: "",
          agentEmail: "",
          fubUserId: 0,
        } as any)
      ).rejects.toThrow();
    });

    it("toggleActive - requires id", async () => {
      const caller = appRouter.createCaller(createAdminContext());
      await expect(
        caller.agentRegistry.toggleActive({ id: 0, active: true } as any)
      ).rejects.toThrow();
    });

    it("delete - requires id", async () => {
      const caller = appRouter.createCaller(createAdminContext());
      await expect(
        caller.agentRegistry.delete({ id: 0 } as any)
      ).rejects.toThrow();
    });
  });

  describe("fubUsers", () => {
    it("returns an array (admin procedure)", async () => {
      const caller = appRouter.createCaller(createAdminContext());
      const result = await caller.agentRegistry.fubUsers();
      expect(Array.isArray(result)).toBe(true);
    });

    it("rejects non-admin callers", async () => {
      const caller = appRouter.createCaller(createNonAdminContext());
      await expect(caller.agentRegistry.fubUsers()).rejects.toThrow(/permission/i);
    });
  });
});
