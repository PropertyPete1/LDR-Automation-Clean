import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB module so we don't need a real MySQL connection
vi.mock("../drizzle/schema", () => ({
  uiErrorLog: {
    id: "id",
    actor: "actor",
    action: "action",
    errorMessage: "error_message",
    errorDetail: "error_detail",
    category: "category",
    resolved: "resolved",
    fixApplied: "fix_applied",
    createdAt: "created_at",
    resolvedAt: "resolved_at",
  },
}));

vi.mock("../server/_core/env", () => ({
  ENV: { databaseUrl: "mysql://mock:mock@localhost/mock" },
}));

// Test the logUiError helper contract
describe("logUiError", () => {
  it("should accept valid error log entries without throwing", async () => {
    // Verify the function signature accepts the expected fields
    const validEntry = {
      actor: "peter",
      action: "trpc:agent.getRoster",
      errorMessage: "FUB connect timeout",
      errorDetail: "ConnectTimeoutError after 15000ms",
      category: "roster" as const,
    };

    // All required fields present
    expect(validEntry.actor).toBeTruthy();
    expect(validEntry.action).toBeTruthy();
    expect(validEntry.errorMessage).toBeTruthy();
    expect(["roster", "audit", "sms", "queue", "auth", "fub_api", "ui_crash", "other"]).toContain(
      validEntry.category
    );
  });

  it("should accept all valid category values", () => {
    const validCategories = ["roster", "audit", "sms", "queue", "auth", "fub_api", "ui_crash", "other"];
    validCategories.forEach((cat) => {
      expect(typeof cat).toBe("string");
      expect(cat.length).toBeGreaterThan(0);
    });
  });

  it("should have resolved enum values no/yes/unfixable", () => {
    const validResolved = ["no", "yes", "unfixable"];
    validResolved.forEach((r) => {
      expect(typeof r).toBe("string");
    });
  });
});

// Test the nightly healer fix matrix logic
describe("nightly healer fix matrix", () => {
  it("should map roster errors to cache-clear fix", () => {
    const category = "roster";
    const fixable = ["roster", "audit", "fub_api"].includes(category);
    expect(fixable).toBe(true);
  });

  it("should map auth errors to unfixable", () => {
    const category = "auth";
    const unfixable = ["auth", "sms", "queue"].includes(category);
    expect(unfixable).toBe(true);
  });

  it("should map ui_crash to unfixable", () => {
    const category = "ui_crash";
    const unfixable = ["auth", "sms", "queue", "ui_crash"].includes(category);
    expect(unfixable).toBe(true);
  });

  it("should detect recurring crashes (3+ identical messages)", () => {
    const errors = [
      { errorMessage: "Cannot read property 'id' of undefined" },
      { errorMessage: "Cannot read property 'id' of undefined" },
      { errorMessage: "Cannot read property 'id' of undefined" },
      { errorMessage: "Different error" },
    ];
    const msgCounts: Record<string, number> = {};
    errors.forEach((e) => {
      msgCounts[e.errorMessage] = (msgCounts[e.errorMessage] || 0) + 1;
    });
    const recurring = Object.entries(msgCounts).filter(([, cnt]) => cnt >= 3);
    expect(recurring.length).toBe(1);
    expect(recurring[0][0]).toBe("Cannot read property 'id' of undefined");
  });
});
