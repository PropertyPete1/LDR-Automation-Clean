import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

// Mock the SDK so we don't hit the real OAuth server.
vi.mock("./_core/sdk", () => {
  return {
    sdk: {
      exchangeCodeForToken: vi.fn(async () => ({ accessToken: "access-xyz" })),
      getUserInfo: vi.fn(async () => ({
        openId: "owner-open-id",
        name: "Peter Allen",
        email: "peter@example.com",
        loginMethod: "google",
      })),
      createSessionToken: vi.fn(async () => "signed.session.token"),
    },
  };
});

// Mock db so upsertUser is a no-op.
vi.mock("./db", () => ({
  upsertUser: vi.fn(async () => undefined),
}));

import { registerOAuthRoutes } from "./_core/oauth";

async function startServer() {
  const app = express();
  registerOAuthRoutes(app);
  return new Promise<{ url: string; close: () => void }>(resolve => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

describe("OAuth callback mobile Bearer fragment", () => {
  let srv: { url: string; close: () => void };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets the session cookie AND redirects to /#session=<token>", async () => {
    srv = await startServer();
    try {
      const res = await fetch(
        `${srv.url}/api/oauth/callback?code=abc&state=xyz`,
        { redirect: "manual" }
      );

      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toBe(
        `/#session=${encodeURIComponent("signed.session.token")}`
      );

      // Cookie is still set for the primary (desktop) flow.
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain("signed.session.token");
    } finally {
      srv.close();
    }
  });
});
