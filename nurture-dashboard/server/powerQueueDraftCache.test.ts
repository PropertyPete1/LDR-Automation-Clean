import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Power Queue AI drafts are cached per lead per day on the server
 * (routers.ts ai.draftSms → getCachedDraft), keyed on personId. The main queue
 * never sent personId, so the cache never applied there: every page load, for
 * every lead viewed, by every viewer, paid for a fresh Claude draft with
 * identical inputs (2026-09 cost audit).
 */

const here = dirname(fileURLToPath(import.meta.url));
const smsQueue = readFileSync(join(here, "../client/src/pages/SmsQueue.tsx"), "utf8");

function draftCalls(source: string): string[] {
  return source
    .split("draftSmsMutation.mutateAsync({")
    .slice(1)
    .map(rest => rest.slice(0, rest.indexOf("});")));
}

describe("Power Queue drafts use the per-lead-per-day cache", () => {
  it("every draftSms call in the queue passes personId, the cache key", () => {
    const calls = draftCalls(smsQueue);
    expect(calls.length).toBeGreaterThanOrEqual(2); // main queue + expanded pond lead
    for (const call of calls) {
      expect(call).toMatch(/personId:\s*lead\.id/);
    }
  });
});
