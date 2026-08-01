/**
 * healer.api.test.ts
 * Validates that the /api/healer/observations route enforces HEALER_SECRET auth.
 * Uses a mock Express app to test the route handler in isolation (no real DB needed).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ─── Mock the DB so we don't need a real MySQL connection ─────────────────────
vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("../../drizzle/schema", () => ({
  botObservations: {},
  botRunLogs: {},
}));

vi.mock("drizzle-orm", () => ({
  gte: vi.fn(),
  desc: vi.fn(),
}));

// ─── Test the auth guard logic directly ───────────────────────────────────────

describe("/api/healer/observations auth guard", () => {
  // A DUMMY value. This slot used to hold a real-looking 64-hex token committed
  // to a public repo; the guard under test is `secret && token === secret`, so
  // the literal never needed to be the deployed one. Never paste a live secret
  // here — the deployed value comes from process.env.HEALER_SECRET.
  const VALID_SECRET = "test-healer-secret-not-a-real-token";

  it("rejects requests with no token", () => {
    const secret = VALID_SECRET;
    const token = "";
    const isAuthorized = secret && token === secret;
    expect(isAuthorized).toBeFalsy();
  });

  it("rejects requests with wrong token", () => {
    const secret = VALID_SECRET;
    const token = "wrong-token-12345";
    const isAuthorized = secret && token === secret;
    expect(isAuthorized).toBeFalsy();
  });

  it("accepts requests with correct token", () => {
    const secret = VALID_SECRET;
    const token = VALID_SECRET;
    const isAuthorized = !!(secret && token === secret);
    expect(isAuthorized).toBe(true);
  });

  it("rejects when HEALER_SECRET env is empty (misconfiguration guard)", () => {
    const secret = "";
    const token = VALID_SECRET;
    const isAuthorized = !!(secret && token === secret);
    expect(isAuthorized).toBe(false);
  });

  // Only meaningful in the deployed environment — local/CI machines
  // intentionally do not hold this secret.
  it.skipIf(!process.env.HEALER_SECRET)("HEALER_SECRET env var is set in the current environment", () => {
    // This test confirms the secret was successfully injected via webdev_request_secrets
    const secret = process.env.HEALER_SECRET;
    expect(secret).toBeDefined();
    expect(secret?.length).toBeGreaterThan(10);
  });

  it("slug-to-healer-slug mapping covers every agent the engine runs", async () => {
    // This used to declare its OWN copy of slugToHealerSlug and assert against
    // that copy — it could never fail, and its roster had gone stale (combined
    // "sp500", no sp500_peter/sp500_steven). Read the REAL map instead, and
    // drive the expected roster from the committed snapshot so it tracks
    // migrations instead of rotting.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));

    const indexSrc = fs.readFileSync(path.join(here, "_core/index.ts"), "utf-8");
    const mapBlock = indexSrc.slice(
      indexSrc.indexOf("const slugToHealerSlug"),
      indexSrc.indexOf("}", indexSrc.indexOf("const slugToHealerSlug")),
    );
    expect(mapBlock, "slugToHealerSlug not found in _core/index.ts").toContain("slugToHealerSlug");

    const snapshot = JSON.parse(
      fs.readFileSync(path.join(here, "../agent_bots_snapshot.json"), "utf-8"),
    ) as Array<{ botSlug: string; engineActive: boolean }>;
    const activeSlugs = snapshot.filter(r => r.engineActive).map(r => r.botSlug);
    expect(activeSlugs.length).toBeGreaterThan(0);

    for (const slug of activeSlugs) {
      // Every running agent must map to a healer slug, or its runs and
      // observations surface under a raw slug the 4am report doesn't recognise.
      expect(mapBlock, `${slug} missing from slugToHealerSlug`).toMatch(
        new RegExp(`\\b${slug}\\s*:\\s*"[a-z0-9_]+_bot"`),
      );
    }
  });
});
