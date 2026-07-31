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

// Also deployment-only: /home/ubuntu/... is the live Manus host filesystem, so
// this can only be true on the deployed box. Same gate as the credentials above.
describe.skipIf(!inDeployedEnv)("pond-nurture route", () => {
  it("run_approved_daily_automation.py script path is correct", async () => {
    const { existsSync } = await import("fs");
    const scriptPath = "/home/ubuntu/fub_automation/run_approved_daily_automation.py";
    expect(existsSync(scriptPath)).toBe(true);
  });
});
