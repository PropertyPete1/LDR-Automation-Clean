/**
 * bots.test.ts
 * Tests for bot helper utilities and tRPC bot procedures.
 */
import { describe, expect, it } from "vitest";
import {
  isEligible,
  hasDncTag,
  daysStale,
  extractPhone,
  SKIP_STAGES,
  STALE_DAYS_THRESHOLD,
  type FubPerson,
} from "./botHelpers";

// ─── isEligible ───────────────────────────────────────────────────────────────

describe("isEligible", () => {
  const baseLead: FubPerson = {
    id: 1,
    firstName: "John",
    lastName: "Doe",
    stage: "Lead",
    tags: [],
    phones: [{ value: "5125551234", type: "mobile" }],
    emails: [{ value: "john@example.com" }],
    textOptOut: false,
    assignedPondId: null,
    lastActivityAt: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(), // 25 days ago
    assignedUserId: 1,
  };

  it("returns true for a stale lead with no skip stage and no pond", () => {
    expect(isEligible(baseLead)).toBe(true);
  });

  it("returns false for Hot Prospect stage", () => {
    expect(isEligible({ ...baseLead, stage: "Hot Prospect" })).toBe(false);
  });

  it("returns false for Active Client stage", () => {
    expect(isEligible({ ...baseLead, stage: "Active Client" })).toBe(false);
  });

  it("returns false for Closed stage", () => {
    expect(isEligible({ ...baseLead, stage: "Closed" })).toBe(false);
  });

  it("returns false for lead assigned to a pond", () => {
    expect(isEligible({ ...baseLead, assignedPondId: 42 })).toBe(false);
  });

  it("returns false for textOptOut leads", () => {
    expect(isEligible({ ...baseLead, textOptOut: true })).toBe(false);
  });

  it("returns false for leads with DNC tag", () => {
    expect(isEligible({ ...baseLead, tags: [{ name: "opt-out" }] })).toBe(false);
  });

  it("returns false for leads active within threshold", () => {
    const recentLead = {
      ...baseLead,
      lastActivityAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days ago
    };
    expect(isEligible(recentLead)).toBe(false);
  });

  it("returns false for Under Contract stage", () => {
    expect(isEligible({ ...baseLead, stage: "Under Contract" })).toBe(false);
  });
});

// ─── hasDncTag ────────────────────────────────────────────────────────────────

describe("hasDncTag", () => {
  it("detects opt-out string tag", () => {
    const lead: FubPerson = { id: 1, tags: ["opt-out"] };
    expect(hasDncTag(lead)).toBe(true);
  });

  it("detects dnc object tag", () => {
    const lead: FubPerson = { id: 1, tags: [{ name: "DNC" }] };
    expect(hasDncTag(lead)).toBe(true);
  });

  it("detects do-not-contact tag", () => {
    const lead: FubPerson = { id: 1, tags: ["do-not-contact"] };
    expect(hasDncTag(lead)).toBe(true);
  });

  it("returns false for normal tags", () => {
    const lead: FubPerson = { id: 1, tags: ["buyer", "hot-lead"] };
    expect(hasDncTag(lead)).toBe(false);
  });

  it("returns false for empty tags", () => {
    const lead: FubPerson = { id: 1, tags: [] };
    expect(hasDncTag(lead)).toBe(false);
  });
});

// ─── daysStale ────────────────────────────────────────────────────────────────

describe("daysStale", () => {
  it("returns threshold for leads with no lastActivityAt", () => {
    const lead: FubPerson = { id: 1, lastActivityAt: null };
    expect(daysStale(lead)).toBe(STALE_DAYS_THRESHOLD);
  });

  it("calculates correct days for a 30-day-old lead", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const lead: FubPerson = { id: 1, lastActivityAt: thirtyDaysAgo };
    expect(daysStale(lead)).toBeGreaterThanOrEqual(29);
    expect(daysStale(lead)).toBeLessThanOrEqual(31);
  });

  it("returns 0 for a lead active today", () => {
    const lead: FubPerson = { id: 1, lastActivityAt: new Date().toISOString() };
    expect(daysStale(lead)).toBe(0);
  });
});

// ─── extractPhone ─────────────────────────────────────────────────────────────

describe("extractPhone", () => {
  it("prefers mobile phone", () => {
    const lead: FubPerson = {
      id: 1,
      phones: [
        { value: "5125550001", type: "home" },
        { value: "5125550002", type: "mobile" },
      ],
    };
    expect(extractPhone(lead)).toBe("5125550002");
  });

  it("falls back to first phone if no mobile", () => {
    const lead: FubPerson = {
      id: 1,
      phones: [{ value: "5125550001", type: "home" }],
    };
    expect(extractPhone(lead)).toBe("5125550001");
  });

  it("strips non-digit characters", () => {
    const lead: FubPerson = {
      id: 1,
      phones: [{ value: "(512) 555-1234", type: "mobile" }],
    };
    expect(extractPhone(lead)).toBe("5125551234");
  });

  it("returns null for no phones", () => {
    const lead: FubPerson = { id: 1, phones: [] };
    expect(extractPhone(lead)).toBeNull();
  });

  it("returns null for short phone numbers", () => {
    const lead: FubPerson = { id: 1, phones: [{ value: "123", type: "mobile" }] };
    expect(extractPhone(lead)).toBeNull();
  });
});

// ─── SKIP_STAGES ─────────────────────────────────────────────────────────────

describe("SKIP_STAGES", () => {
  it("contains Hot Prospect", () => {
    expect(SKIP_STAGES.has("Hot Prospect")).toBe(true);
  });

  it("contains Active Client", () => {
    expect(SKIP_STAGES.has("Active Client")).toBe(true);
  });

  it("contains Closed", () => {
    expect(SKIP_STAGES.has("Closed")).toBe(true);
  });

  it("does not contain Lead", () => {
    expect(SKIP_STAGES.has("Lead")).toBe(false);
  });

  it("does not contain Prospect", () => {
    expect(SKIP_STAGES.has("Prospect")).toBe(false);
  });
});
