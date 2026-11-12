import { withCompleteHistory } from "./portalHistoryTestSupport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import {
  hasPortalProvenance, hasUsableFreshProvenance, type PortalProvenance,
} from "./portalProvenance";

const { smtp } = vi.hoisted(() => ({ smtp: vi.fn().mockResolvedValue({ messageId: "synthetic" }) }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: smtp }) } }));
vi.mock("./db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));
import {
  checkLeadEmailPortalGate, hasDncTag, isEligible, isExcludedSource,
  reloadSharedSuppressionTags, sendLeadFollowUpEmail,
} from "./botHelpers";

const personId = 990001;
const options = {
  personId, provenance: { source: "Website Form" }, agentEmail: "agent@example.invalid", agentFirstName: "Synthetic",
  agentLastName: "Agent", leadEmail: "fixture@example.invalid", leadFirstName: null,
  messageBody: "Synthetic body", subject: "Synthetic subject",
};
const response = (value: unknown) => ({ ok: true, status: 200, json: async () => value });
const partialForms = [
  "Realtor company", "Realtor.commercial", "Realtordotcompany", "Realtor dot company",
  "Local Realtor Committee", "Realtor com2", "Realtor dot comé", "Realtordotcommerical",
];

beforeEach(() => {
  smtp.mockClear();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(withCompleteHistory(response({ id: personId, source: "Website Form" }))));
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("complete portal form boundaries survive JSON and hardcoded fallback", () => {
  it.each(partialForms)("partial source form is not portal and is not substring-suppressed %#", async source => {
    for (const provenance of [{ source }, { source: "Website Form", leadSource: source }]) {
      expect(hasPortalProvenance(provenance)).toBe(false);
      expect(isExcludedSource({ id: personId, ...provenance })).toBeNull();
    }
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: personId, source })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: true });
    expect(smtp).toHaveBeenCalledTimes(1);
  });
  it.each([
    "prefix REALTOR®---COM™ campaign", "prefix REALTOR℠ dot COM:campaign",
    "prefix realtordotcom/campaign", "Realtor.com", "Realtor dot com", "notzillow",
  ])("complete source form permits campaign suffixes %#", source => {
    expect(hasPortalProvenance({ source })).toBe(true);
    expect(isExcludedSource({ id: personId, source })).toBe("PORTAL_SOURCE");
  });
  it.each(partialForms)("partial whole tag is not new portal evidence (old realtor tag remains) %#", tag => {
    for (const tags of [[tag], [{ name: tag }]]) {
      expect(hasPortalProvenance({ tags })).toBe(false);
      expect(isExcludedSource({ id: personId, source: "Website Form", tags })).toBeNull();
      expect(hasDncTag({ id: personId, tags }, false)).toBe(true);
    }
  });
  it.each([
    "REALTOR.COM®-Synthetic", "Realtor dot com:campaign", "Realtordotcom/campaign",
    "ZillowSuffix", "Zillow®_campaign",
  ])("complete whole-tag prefixes remain portal evidence %#", tag => {
    expect(hasPortalProvenance({ tags: [tag] })).toBe(true);
    expect(hasDncTag({ id: personId, tags: [tag] })).toBe(true);
  });
  it("fallback does not reintroduce broad source or tag substring matching", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    reloadSharedSuppressionTags();
    for (const source of partialForms) expect(isExcludedSource({ id: personId, source })).toBeNull();
    expect(hasDncTag({ id: personId, tags: ["internal Zillow"] })).toBe(false);
    expect(isExcludedSource({ id: personId, source: "Zillow" }, false)).toBeNull();
    expect(isExcludedSource({ id: personId, source: "Zillow Rentals - Synthetic" }, false)).toBeTruthy();
    vi.restoreAllMocks();
    reloadSharedSuppressionTags();
  });
});

describe("absolute URL hostname canonicalization", () => {
  it.each([
    "https://zillow.com./synthetic", "http://sub.zillow.com./synthetic",
    "https://sub.realtor.com./synthetic", "https://REALTOR.COM.:443/synthetic",
    "ftp://zillow.com./synthetic", "//zillow.com./synthetic",
    "https:zillow.com./synthetic", "https:/zillow.com./synthetic",
  ])("terminal DNS-dot portal host blocks directly at SMTP %#", async sourceUrl => {
    expect(hasPortalProvenance({ sourceUrl })).toBe(true);
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: personId, source: "Website Form", sourceUrl })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(smtp).not.toHaveBeenCalled();
  });
  it.each([
    "https://zillow.com.example.invalid./synthetic", "https://notzillow.com./synthetic",
    "https://realtor.com.example.invalid./synthetic", "https://evilrealtor.com./synthetic",
    "https://zillow.com.@example.invalid./synthetic", "https://example.invalid./zillow.com.",
    "https://example.invalid./?portal=realtor.com.",
  ])("terminal-dot and absolute-URL lookalikes are not portal evidence %#", sourceUrl => {
    expect(hasPortalProvenance({ sourceUrl })).toBe(false);
  });
});

describe("unified explicit provenance whitelist is cycle-safe", () => {
  it.each(["original", "event", "originalProvenance", "eventProvenance"])("object alias can nest other explicit aliases %#", key => {
    const provenance = { source: "Website Form", [key]: { eventProvenance: { original: { leadSource: "Realtor.com" } } } };
    expect(hasPortalProvenance(provenance)).toBe(true);
    expect(isExcludedSource({ id: personId, ...provenance })).toBe("PORTAL_SOURCE");
  });
  it.each(["provenance", "events"])("explicit loaded record array traverses source metadata only %#", async key => {
    const provenance = { [key]: [{ source: "Website Form" }, { originalSource: "Zillow" }] };
    expect(hasPortalProvenance(provenance)).toBe(true);
    expect(await sendLeadFollowUpEmail({ ...options, provenance })).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(smtp).not.toHaveBeenCalled();
    expect(hasPortalProvenance({ [key]: [{ payload: { source: "Zillow" }, body: "Realtor.com" }] })).toBe(false);
  });
  it("cycles and repeated records terminate without losing later portal evidence", () => {
    const record: PortalProvenance = { source: "Website Form" };
    record.original = record;
    record.eventProvenance = { originalProvenance: record };
    record.events = [record, record.eventProvenance];
    expect(hasPortalProvenance(record)).toBe(false);
    record.events.push({ event: { sourceUrl: "https://sub.zillow.com./synthetic" } });
    expect(hasPortalProvenance(record)).toBe(true);
  });
  it("very deep explicit metadata uses iterative traversal", () => {
    let record: PortalProvenance = { source: "Realtor.com" };
    for (let depth = 0; depth < 15000; depth++) record = { original: record };
    expect(hasPortalProvenance(record)).toBe(true);
  });
  it.each([
    "payload", "data", "notes", "note", "message", "email", "body", "subject", "triggerSnippet",
    "sourceId", "createdVia",
  ])("arbitrary field does not become provenance even with nested source metadata %#", key => {
    expect(hasPortalProvenance({ source: "Website Form", [key]: { source: "Zillow", tags: ["Realtor.com"] } })).toBe(false);
  });
  it("named provenance objects and arrays reject the wrong container and primitive types", () => {
    for (const value of [null, false, "Zillow", 7, ["Zillow"], [{ source: "Zillow" }]]) {
      expect(hasPortalProvenance(value)).toBe(false);
      expect(hasPortalProvenance({ original: value })).toBe(false);
    }
    expect(hasPortalProvenance({ events: { source: "Zillow" } })).toBe(false);
    expect(hasPortalProvenance({ provenance: ["Zillow", { payload: { source: "Zillow" } }] })).toBe(false);
  });
  it("caller-selected event source metadata blocks but arbitrary event payload does not", () => {
    const event = { source: "Zillow", body: "Synthetic" };
    expect(hasPortalProvenance({ event })).toBe(true);
    expect(hasPortalProvenance({ event: { payload: event, body: "Zillow" } })).toBe(false);
  });
});

describe("fresh record and identity validation never coerces or infers missing sources", () => {
  it.each([true, false, [], [personId], personId + 0.5, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "990001", "0990001"])("malformed returned identity fails closed %#", async id => {
    const person = { id, source: "" };
    expect(hasUsableFreshProvenance(person, personId)).toBe(false);
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response(person)));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" });
    expect(smtp).not.toHaveBeenCalled();
  });
  it.each([true, false, [], [personId], 0, -1, personId + 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "990001"])("malformed requested identity is refused before lookup %#", async id => {
    expect(hasUsableFreshProvenance({ id, source: "" }, id as number)).toBe(false);
    expect(await checkLeadEmailPortalGate(id as number)).toEqual({ sent: false, reason: "PORTAL_PERSON_ID_UNRESOLVED" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { tags: [] }, { tags: null }, { sourceUrl: "" }, { sourceUrl: null },
    { source: undefined }, { leadSource: undefined }, { source: undefined, tags: [] },
  ])("missing source is not equivalent to an explicit blank %#", async provenance => {
    const person = { id: personId, ...provenance };
    expect(hasUsableFreshProvenance(person, personId)).toBe(false);
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response(person)));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" });
    expect(smtp).not.toHaveBeenCalled();
  });
  it.each([
    { source: "" }, { source: null }, { leadSource: "" }, { leadSource: null },
  ])("explicit blank/null source remains usable %#", async provenance => {
    const person = { id: personId, ...provenance };
    expect(hasUsableFreshProvenance(person, personId)).toBe(true);
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response(person)));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: true });
  });
  it.each([
    { sourceUrl: 7 }, { originalSource: [] }, { eventSource: {} }, { tags: {} },
    { tags: true }, { tags: [null] }, { tags: [7] }, { tags: [{}] }, { tags: [{ name: 7 }] },
  ])("malformed optional source/tag shape fails closed %#", async provenance => {
    const person = { id: personId, source: "", ...provenance };
    expect(hasUsableFreshProvenance(person, personId)).toBe(false);
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response(person)));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" });
    expect(smtp).not.toHaveBeenCalled();
  });
  it("array impostor tags, records and inherited identity/source cannot authorize mail", () => {
    const tag = Object.assign([], { name: "Synthetic" });
    const person = Object.assign([], { id: personId, source: "" });
    expect(hasUsableFreshProvenance({ id: personId, source: "", tags: [tag] }, personId)).toBe(false);
    expect(hasUsableFreshProvenance(person, personId)).toBe(false);
    expect(hasUsableFreshProvenance(Object.create({ id: personId, source: "" }), personId)).toBe(false);
    expect(hasUsableFreshProvenance(Object.assign(Object.create({ id: personId }), { source: "" }), personId)).toBe(false);
  });
  it.each([
    { id: true, source: "Zillow" }, { id: personId + 0.5, tags: ["Realtor.com"] },
    { sourceUrl: "https://zillow.com./synthetic" },
    { id: personId, source: {}, events: [{ originalProvenance: { source: "Realtor.com" } }] },
  ])("known fresh portal evidence wins before malformed rejection %#", async person => {
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response(person)));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(smtp).not.toHaveBeenCalled();
  });
  it("explicit original portal wins even when requested identity is malformed", async () => {
    expect(await checkLeadEmailPortalGate(true as unknown as number, { events: [{ source: "Zillow" }] })).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("portal-only bypass retains original non-email exclusions", () => {
  it.each([
    { source: "Zillow" }, { source: "Realtor.com" }, { source: "Realtor dot com" },
    { source: "Website Form", leadSource: "Zillow" }, { tags: ["Zillow"] },
    { sourceUrl: "https://zillow.com./synthetic" }, { events: [{ originalSource: "Realtor.com" }] },
  ])("non-email source matcher bypasses only new portal evidence %#", provenance => {
    const person = { id: personId, ...provenance };
    expect(isExcludedSource(person)).toBe("PORTAL_SOURCE");
    expect(isExcludedSource(person, false)).toBeNull();
  });
  it.each([
    "Zillow Rentals - Synthetic", "New Agent Inquiry - Synthetic", "Agent Scouting - Synthetic",
    "BOTM Newsletter - Synthetic", "Lease Listing Inquiry - Synthetic",
  ])("every original excluded source remains excluded with bypass %#", source => {
    expect(isExcludedSource({ id: personId, source }, false)).toBe(source);
  });
  it("new Zillow tags do not suppress internal eligibility but old realtor/agent/DNC tags still do", () => {
    for (const source of ["Zillow", "Realtor.com"]) {
      expect(isEligible({ id: personId, source }, false)).toBe(true);
      expect(isEligible({ id: personId, source })).toBe(false);
    }
    expect(hasDncTag({ id: personId, tags: ["Zillow - Synthetic"] }, false)).toBe(false);
    expect(isEligible({ id: personId, tags: ["Zillow - Synthetic"] }, false)).toBe(true);
    for (const tag of ["Realtor.com", "agent", "do not contact", "opt-out", "replied - paused"]) {
      expect(hasDncTag({ id: personId, tags: [tag] }, false)).toBe(true);
      expect(isEligible({ id: personId, tags: [tag] }, false)).toBe(false);
    }
    // Base isEligible did not apply source exclusions to internal queue counts.
    expect(isEligible({ id: personId, source: "Zillow Rentals" }, false)).toBe(true);
    expect(isExcludedSource({ id: personId, source: "Zillow Rentals" }, false)).toBe("Zillow Rentals");
  });
  it("non-email bypass cannot override stage, pond, opt-out or stale-window protections", () => {
    for (const extra of [
      { stage: "Closed" }, { assignedPondId: 990002 }, { textOptOut: true },
      { lastActivity: new Date().toISOString() },
      { lastActivity: new Date(Date.now() - 25 * 86400000).toISOString() },
    ]) expect(isEligible({ id: personId, source: "Zillow", ...extra }, false)).toBe(false);
  });
});
