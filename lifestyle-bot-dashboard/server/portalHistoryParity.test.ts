import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scanPortalEventHistory, type PortalHistoryRequest } from "./portalEventHistory";

const shared: { personId: number; cases: Array<{ name: string; pages: unknown[]; expected: string; error: boolean }> } = JSON.parse(
  readFileSync(new URL("../../pond-nurture-bot/tests/fixtures/portal_history_parity.json", import.meta.url), "utf8"),
);

describe("single shared API-visible history contract", () => {
  it("consumes all 90 unique cases", () => {
    expect(shared.cases).toHaveLength(90);
    expect(new Set(shared.cases.map(item => item.name)).size).toBe(90);
  });
  it.each(shared.cases)("$name", async item => {
    const requests: PortalHistoryRequest[] = [];
    let index = 0;
    const result = await scanPortalEventHistory(shared.personId, async request => {
      requests.push({ ...request });
      if (item.error || index >= item.pages.length) throw new Error("SYNTHETIC_HISTORY_FAILURE");
      return structuredClone(item.pages[index++]);
    });
    const classification = result.sent ? "allow" : result.reason === "PORTAL_SOURCE" ? "block" : "defer";
    expect(classification).toBe(item.expected);
    expect(requests.length).toBeLessThanOrEqual(5);
    expect(requests.every(request => request.personId === shared.personId && request.limit === 100)).toBe(true);
    if (["nextLink_invalid_percent", "nextLink_invalid_utf8", "nextLink_traversal", "null_primary_terminal_link_contradiction"].includes(item.name)) {
      expect(requests).toHaveLength(1);
      expect(result).toEqual(expect.objectContaining({ sent: false, reason: "PORTAL_HISTORY_INCOMPLETE" }));
    }
  });
});
