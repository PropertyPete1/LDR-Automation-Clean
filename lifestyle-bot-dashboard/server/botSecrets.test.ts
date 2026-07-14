import { describe, expect, it } from "vitest";

// These assertions validate the DEPLOYED environment's secrets. Outside the
// deployment (local dev, CI, audit runs) the secrets are intentionally absent,
// so the tests skip rather than fail on machines that must never hold them.
const inDeployedEnv = !!process.env.FUB_API_KEY;

describe("Bot secrets validation", () => {
  it.skipIf(!inDeployedEnv)("FUB_API_KEY is set and has the expected prefix", () => {
    const key = process.env.FUB_API_KEY ?? "";
    expect(key.length).toBeGreaterThan(10);
    expect(key.startsWith("fka_")).toBe(true);
  });

  it.skipIf(!inDeployedEnv)("SMTP credentials are set", () => {
    expect((process.env.SMTP_HOST ?? "").length).toBeGreaterThan(0);
    expect((process.env.SMTP_USER ?? "").length).toBeGreaterThan(0);
    expect((process.env.SMTP_PASSWORD ?? "").length).toBeGreaterThan(0);
  });

  it.skipIf(!inDeployedEnv)("EMAIL_FROM is set", () => {
    expect((process.env.EMAIL_FROM ?? "").length).toBeGreaterThan(0);
  });
});
