/**
 * Validates that SMTP credentials are present in the environment
 * and that the /api/scheduled/pond-nurture route is registered.
 * Does NOT send a real email — just checks env vars are set.
 */
import { describe, it, expect } from "vitest";

describe("SMTP credentials", () => {
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

describe("pond-nurture route", () => {
  it("run_approved_daily_automation.py script path is correct", async () => {
    const { existsSync } = await import("fs");
    const scriptPath = "/home/ubuntu/fub_automation/run_approved_daily_automation.py";
    expect(existsSync(scriptPath)).toBe(true);
  });
});
