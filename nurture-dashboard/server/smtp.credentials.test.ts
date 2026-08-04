/**
 * Validates that SMTP credentials are present in the environment
 * and that the /api/scheduled/pond-nurture route is registered.
 * Does NOT send a real email — just checks env vars are set.
 */
import { describe, it, expect } from "vitest";


// Env-gated: this suite asserts against a live external dependency that is
// intentionally absent on any machine that must not hold it (local dev, CI,
// audit runs). It was FAILING rather than skipping, which kept the suite
// permanently red and hid real regressions in the noise.
const inDeployedEnv = !!process.env.SMTP_HOST;

describe.skipIf(!inDeployedEnv)("SMTP credentials", () => {
  it("SMTP_HOST is set", () => {
    expect(process.env.SMTP_HOST).toBeTruthy();
  });

  it("SMTP_PORT is set", () => {
    expect(process.env.SMTP_PORT).toBeTruthy();
  });

  it("SMTP_USER is set to peter@lifestyledesignrealty.com", () => {
    expect(process.env.SMTP_USER).toBe("peter@lifestyledesignrealty.com");
  });

  it("EMAIL_FROM is set to peter@lifestyledesignrealty.com", () => {
    expect(process.env.EMAIL_FROM).toBe("peter@lifestyledesignrealty.com");
  });

  it("SMTP_PASSWORD is set and non-empty", () => {
    expect(process.env.SMTP_PASSWORD).toBeTruthy();
    expect((process.env.SMTP_PASSWORD ?? "").length).toBeGreaterThan(10);
  });
});

/**
 * This block used to assert that
 *   /home/ubuntu/fub_automation/run_approved_daily_automation.py
 * exists on disk, gated on SMTP_HOST being set.
 *
 * Two things were wrong with it. The gate and the assertion were unrelated —
 * holding SMTP credentials says nothing about whether you are on the Manus host
 * — so any environment with mail configured but a different filesystem went red.
 * And the assertion had outlived its subject: pondNurture.ts is a native
 * TypeScript port that explicitly replaced the shell-exec approach ("no Python,
 * no shell, no sandbox paths"), so the route has not depended on that script for
 * some time. It was pinning a dependency the code deliberately removed.
 *
 * Replaced with the invariant actually worth protecting, which needs no
 * environment at all: the route is registered, and it does NOT shell out to the
 * Python entrypoint that GitHub Actions already owns. If it ever did again,
 * pond leads would be emailed twice — once by Actions, once by the route.
 */
describe("pond-nurture route", () => {
  it("is registered and runs the native engine, never a Python shell-exec", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const indexSrc = fs.readFileSync(path.join(here, "_core/index.ts"), "utf-8");

    expect(indexSrc).toContain('app.post("/api/scheduled/pond-nurture"');
    expect(indexSrc).toContain("runPondNurture");

    // The duplicate-send guard: no shelling out to the Actions entrypoint.
    expect(indexSrc).not.toContain("run_approved_daily_automation.py");
    expect(indexSrc).not.toMatch(/exec(Sync|File)?\(\s*['"`][^'"`]*python/i);
  });
});
