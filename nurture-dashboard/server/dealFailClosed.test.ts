/**
 * Deal protection fails CLOSED (audit-fix).
 *
 * getPersonDeals used to swallow a fetch error and return [] — which every
 * caller reads as "this person has no deals", silently disabling the strongest
 * do-not-email guard in the system. One FUB hiccup and a lead mid-transaction
 * gets a nurture email. It now retries once, then throws DealCheckUnavailable,
 * and each rule resolves it in whichever direction means DO NOT SEND.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPersonDeals, hasAnyDeal, isLeaseListingSilenced, hasClosedPurchaseDeal,
  DealCheckUnavailable, clearDealCache,
  getDealCheckFailedClosedCount, resetDealCheckFailedClosedCount,
} from "./botHelpers";

const PERSON = 4242;

beforeEach(() => {
  clearDealCache?.();
  resetDealCheckFailedClosedCount();
  vi.stubEnv("FUB_API_KEY", "test-key");
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

/** Every fetch fails. */
function alwaysFailing() {
  const fn = vi.fn(async () => { throw new Error("FUB 500"); });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("deal protection — fail closed", () => {
  it("throws rather than reporting 'no deals' when the API is down", async () => {
    alwaysFailing();
    await expect(getPersonDeals(PERSON)).rejects.toBeInstanceOf(DealCheckUnavailable);
  });

  it("retries once before giving up", async () => {
    const fn = alwaysFailing();
    await expect(getPersonDeals(PERSON)).rejects.toThrow();
    expect(fn.mock.calls.length).toBe(2); // initial + one retry
  });

  it("hasAnyDeal blocks (true) when the check is unavailable", async () => {
    alwaysFailing();
    await expect(hasAnyDeal(PERSON)).resolves.toBe(true);
  });

  it("isLeaseListingSilenced silences (true) when the check is unavailable", async () => {
    alwaysFailing();
    await expect(isLeaseListingSilenced(PERSON)).resolves.toBe(true);
  });

  it("counts the failure so the daily/4am report can surface it", async () => {
    alwaysFailing();
    await hasAnyDeal(PERSON);
    expect(getDealCheckFailedClosedCount()).toBeGreaterThan(0);
  });

  it("a transient blip recovers on retry — does not suppress the lead", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (++n === 1) throw new Error("transient");
      return { ok: true, status: 200, json: async () => ({ deals: [] }) } as unknown as Response;
    }));
    await expect(hasAnyDeal(PERSON)).resolves.toBe(false); // normal send path
  });
});
