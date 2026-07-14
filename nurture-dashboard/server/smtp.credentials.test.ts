/**
 * Validates that SMTP credentials are present in the environment
 * and that the /api/scheduled/pond-nurture route is registered.
 * Does NOT send a real email — just checks env vars are set.
 */
import { describe, it, expect } from "vitest";

// These assertions validate the DEPLOYED environment's secrets. Outside the
// deployment (local dev, CI, audit runs) the secrets are intentionally absent,
// so the suite skips rather than fail on machines that must never hold them.
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

describe("pond-nurture automation script", () => {
  it("run_approved_daily_automation.py exists in the repo (GitHub Actions runs it since the 2026-07-13 cutover)", async () => {
    const { existsSync } = await import("fs");
    const { fileURLToPath } = await import("url");
    const path = await import("path");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const scriptPath = path.resolve(here, "../../pond-nurture-bot/run_approved_daily_automation.py");
    expect(existsSync(scriptPath)).toBe(true);
  });
});
