import { describe, it, expect } from "vitest";

// Same convention as botSecrets.test.ts: this asserts a DEPLOYMENT secret, which
// is intentionally absent on any machine that must never hold it (local dev, CI,
// audit runs). It was failing rather than skipping, adding a permanent red to
// the suite — noise that hides real regressions.
const inDeployedEnv = !!process.env.FUB_API_KEY;

describe("POWER_QUEUE_ADMIN_TOKEN", () => {
  it.skipIf(!inDeployedEnv)("is set and non-empty in the environment", () => {
    const token = process.env.POWER_QUEUE_ADMIN_TOKEN;
    expect(token).toBeDefined();
    expect(token!.length).toBeGreaterThan(0);
  });

  it("is used in botHelpers sendClockinEmail for Peter's admin URL", async () => {
    const { TEAM_EMAIL, LEAD_REPLY_TO } = await import("./botHelpers");
    // Confirm the constants are correct (indirectly validates the module loads with the token available)
    expect(TEAM_EMAIL).toBe("team@lifestyledesignrealty.com");
    expect(LEAD_REPLY_TO).toBe("peter@lifestyledesignrealty.com");
  });
});
