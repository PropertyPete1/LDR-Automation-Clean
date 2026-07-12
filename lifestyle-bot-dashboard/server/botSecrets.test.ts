import { describe, expect, it } from "vitest";

describe("Bot secrets validation", () => {
  it("FUB_API_KEY is set and has the expected prefix", () => {
    const key = process.env.FUB_API_KEY ?? "";
    expect(key.length).toBeGreaterThan(10);
    expect(key.startsWith("fka_")).toBe(true);
  });

  it("SMTP credentials are set", () => {
    expect((process.env.SMTP_HOST ?? "").length).toBeGreaterThan(0);
    expect((process.env.SMTP_USER ?? "").length).toBeGreaterThan(0);
    expect((process.env.SMTP_PASSWORD ?? "").length).toBeGreaterThan(0);
  });

  it("EMAIL_FROM is set", () => {
    expect((process.env.EMAIL_FROM ?? "").length).toBeGreaterThan(0);
  });
});
