/**
 * complianceAnnualFlow.test.ts — audit P0-2, the opt-out side.
 *
 * Opting out must strip/neutralize the "Annual Nurture Only" flow: before
 * this, suppressLead() re-wrote the lead's tags with "Annual Nurture Only"
 * preserved and left the annual_nurture_leads row active — one tag away from
 * a yearly email to someone who said stop. These tests drive the REAL
 * suppressLead() and pin both halves of the fix.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_core/env", () => ({
  ENV: { fubApiKey: "test_fub_key", powerQueueAdminToken: "t" },
}));

const mockWriteObservation = vi.fn().mockResolvedValue(undefined);
let inserted: any[] = [];
let updates: Array<{ table: unknown; vals: any }> = [];
const fakeDb = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  insert: (table: unknown) => ({ values: async (vals: any) => { inserted.push(vals); } }),
  update: (table: unknown) => ({
    set: (vals: any) => ({ where: async () => { updates.push({ table, vals }); } }),
  }),
};
vi.mock("./db", () => ({
  getDb: vi.fn(async () => fakeDb),
  writeObservation: (...args: any[]) => mockWriteObservation(...args),
}));

const fetchCalls: Array<{ url: string; init: any }> = [];
vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
  fetchCalls.push({ url, init });
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () =>
      init?.method === "PUT" || init?.method === "POST"
        ? { id: 1 }
        : { id: 4242, name: "Jamie Example", tags: ["Annual Nurture Only", "warm"] },
  };
}));

import { suppressLead } from "./compliance";
import { annualNurtureLeads } from "../drizzle/schema";

beforeEach(() => {
  inserted = [];
  updates = [];
  fetchCalls.length = 0;
  mockWriteObservation.mockClear();
});

describe("suppressLead neutralizes the Annual Nurture flow", () => {
  it("strips the Annual Nurture Only tag while adding opt-out", async () => {
    const result = await suppressLead({
      personId: 4242,
      reason: "opt_out_reply",
      source: "reply_intent",
    });

    expect(result.success).toBe(true);
    const put = fetchCalls.find(c => c.init?.method === "PUT");
    expect(put, "suppressLead must PUT the person").toBeDefined();
    const body = JSON.parse(put!.init.body);
    expect(body.stage).toBe("Trash");
    expect(body.tags).toContain("opt-out");
    expect(body.tags).toContain("warm");
    expect(body.tags).not.toContain("Annual Nurture Only");
  });

  it("deactivates any annual_nurture_leads enrollment for the person", async () => {
    await suppressLead({
      personId: 4242,
      reason: "unsubscribe",
      source: "power_queue",
    });

    const annualUpdate = updates.find(
      u => u.table === annualNurtureLeads && u.vals?.active === false
    );
    expect(annualUpdate, "the annual enrollment row must go inactive").toBeDefined();
  });

  it("the FUB note documents the annual-flow deactivation", async () => {
    await suppressLead({ personId: 4242, reason: "opt_out_reply", source: "reply_intent" });

    const notePost = fetchCalls.find(
      c => c.init?.method === "POST" && String(c.url).includes("/notes")
    );
    expect(notePost).toBeDefined();
    const noteBody = JSON.parse(notePost!.init.body);
    expect(noteBody.body).toContain("Annual nurture enrollment deactivated");
  });
});
