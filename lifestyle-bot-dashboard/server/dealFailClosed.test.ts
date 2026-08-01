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
  getPersonDeals, hasAnyDeal, isLeaseListingSilenced,
  DealCheckUnavailable, clearDealCache,
  getDealCheckFailedClosedCount, resetDealCheckFailedClosedCount,
} from "./botHelpers";

const PERSON = 4242;

beforeEach(() => {
  clearDealCache?.();
  resetDealCheckFailedClosedCount();
  vi.stubEnv("FUB_API_KEY", "test-key");
  // Plain fake timers — the clock is driven explicitly by flushRetries() below.
  vi.useFakeTimers();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

/** Every fetch fails. */
function alwaysFailing() {
  const fn = vi.fn(async () => { throw new Error("FUB 500"); });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/**
 * Release the retry backoff deterministically.
 *
 * This suite used to run on `useFakeTimers({ shouldAdvanceTime: true })`, which
 * advances the fake clock from REAL elapsed time — so covering the retry
 * backoff depended on the machine keeping up, and the suite went intermittently
 * red under load. A flaky test on the send-blocking guard is the worst place to
 * have one: red becomes the normal colour and a real regression hides in it.
 * Driving the clock ourselves removes the timing coupling entirely (and drops
 * ~9s of real sleeping). The window is deliberately larger than any single
 * backoff so the test does not encode the production constant.
 */
async function flushRetries() {
  await vi.advanceTimersByTimeAsync(10_000);
}

describe("deal protection — fail closed", () => {
  it("throws rather than reporting 'no deals' when the API is down", async () => {
    alwaysFailing();
    const settled = expect(getPersonDeals(PERSON)).rejects.toBeInstanceOf(DealCheckUnavailable);
    await flushRetries();
    await settled;
  });

  it("retries once before giving up", async () => {
    const fn = alwaysFailing();
    const settled = expect(getPersonDeals(PERSON)).rejects.toThrow();
    await flushRetries();
    await settled;
    expect(fn.mock.calls.length).toBe(2); // initial + one retry
  });

  it("hasAnyDeal blocks (true) when the check is unavailable", async () => {
    alwaysFailing();
    const blocked = hasAnyDeal(PERSON);
    await flushRetries();
    await expect(blocked).resolves.toBe(true);
  });

  it("isLeaseListingSilenced silences (true) when the check is unavailable", async () => {
    alwaysFailing();
    const silenced = isLeaseListingSilenced(PERSON);
    await flushRetries();
    await expect(silenced).resolves.toBe(true);
  });

  it("counts the failure so the daily/4am report can surface it", async () => {
    alwaysFailing();
    const done = hasAnyDeal(PERSON);
    await flushRetries();
    await done;
    expect(getDealCheckFailedClosedCount()).toBeGreaterThan(0);
  });

  it("a transient blip recovers on retry — does not suppress the lead", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (++n === 1) throw new Error("transient");
      return { ok: true, status: 200, json: async () => ({ deals: [] }) } as unknown as Response;
    }));
    const recovered = hasAnyDeal(PERSON);
    await flushRetries();
    await expect(recovered).resolves.toBe(false); // normal send path
  });
});
