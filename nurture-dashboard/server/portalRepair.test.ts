import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

vi.mock("./db", () => ({ getDb: vi.fn(async () => null) }));
import { hasPortalProvenance, isUsablePortalPerson, portalEmailGate, type PortalProvenance, PORTAL_SOURCE_NAMES } from "./portalEmailGate";
import { getSharedSuppressionTags, getSharedSuppressionConfig, reloadSharedSuppressionTags, isExcludedSource, hasDncTag, isEligible } from "./botHelpers";

const ID = 930001;
const fetchMock = vi.fn();
const historyFetch = vi.fn();
const fresh = (extra: Record<string, unknown> = {}) => ({ id: ID, source: "Website Form", tags: [], ...extra });
const person = (extra: PortalProvenance = {}) => ({ id: ID, source: "Website Form", ...extra });

beforeEach(() => {
  historyFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ events: [], _metadata: { collection: "events", total: 0 } }) });
  vi.stubGlobal("fetch", (url: string, opts?: RequestInit) => new URL(url).pathname === "/v1/events"
    ? historyFetch(url, opts) : fetchMock(url, opts));
  vi.stubEnv("FUB_API_KEY", "synthetic-key-930001");
  fetchMock.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); reloadSharedSuppressionTags();
});

describe("repaired usable current source and identity", () => {
  const invalidRecords = [
    { id: ID }, { id: ID, tags: [] }, { id: ID, tags: null }, { id: ID, sourceUrl: "" },
    { id: ID, sourceUrl: "https://fixture.invalid", tags: [] }, { id: ID, source: undefined },
    fresh({ source: [], leadSource: "" }), fresh({ leadSource: false }), fresh({ sourceUrl: false }),
    fresh({ tags: false }), fresh({ tags: [{}] }), fresh({ tags: [["Zillow"]] }), fresh({ tags: undefined }),
    fresh({ id: true }), fresh({ id: false }), fresh({ id: [ID] }), fresh({ id: ID + 0.5 }),
    fresh({ id: `${ID}.0` }), fresh({ id: `0${ID}` }), fresh({ id: ` ${ID}` }),
    fresh({ id: `+${ID}` }), fresh({ id: "9.30001e5" }), fresh({ id: 0 }), fresh({ id: -1 }),
    fresh({ id: NaN }), fresh({ id: Infinity }), fresh({ id: Number.MAX_SAFE_INTEGER + 1 }),
  ];
  it.each(invalidRecords.map((value, index) => [index, value] as const))("invalid fresh record %i fails closed", async (_index, value) => {
    expect(isUsablePortalPerson(value, ID)).toBe(false);
    fetchMock.mockResolvedValue({ ok: true, json: async () => value });
    expect(await portalEmailGate(ID)).toEqual({ allowed: false, reason: "PORTAL_FRESH_PERSON_UNUSABLE" });
  });
  it.each([true, false, [], [ID], 0, -1, ID + 0.5, NaN, Infinity, "01", "1.0", " 1", Number.MAX_SAFE_INTEGER + 1])("invalid requested identity %# cannot authorize a matching fresh record", async id => {
    expect(isUsablePortalPerson(fresh({ id }), id as number)).toBe(false);
    expect(await portalEmailGate(id as number)).toEqual({ allowed: false, reason: "PORTAL_PERSON_ID_UNRESOLVED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    { id: ID, source: "" }, { id: ID, source: null }, { id: ID, leadSource: "" },
    { id: ID, leadSource: null }, fresh({ id: String(ID) }), fresh({ tags: null }),
    fresh({ tags: [{ name: "fixture" }], sourceUrl: null }),
  ])("explicit valid blank/null source and canonical identities remain usable %#", async value => {
    expect(isUsablePortalPerson(value, ID)).toBe(true);
    fetchMock.mockResolvedValue({ ok: true, json: async () => value });
    expect(await portalEmailGate(ID)).toEqual({ allowed: true });
    expect(historyFetch).toHaveBeenCalledTimes(1);
  });
  it("known fresh portal evidence takes precedence over every malformed field", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: true, source: {}, sourceUrl: "https://zillow.com./fixture", tags: false }) });
    expect(await portalEmailGate(ID)).toEqual({ allowed: false, reason: "PORTAL_SOURCE_EXCLUDED" });
  });
  it.each([null, fresh({ id: true }), { id: ID, tags: [] }])("known original portal evidence wins when fresh is unusable %#", async value => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => value });
    expect(await portalEmailGate(ID, { events: [{ source: "Zillow" }] })).toEqual({ allowed: false, reason: "PORTAL_SOURCE_EXCLUDED" });
  });
  it("portal evidence wins even over unresolved requested identity", async () => {
    expect(await portalEmailGate(true as any, { original: { source: "Realtor.com" } })).toEqual({ allowed: false, reason: "PORTAL_SOURCE_EXCLUDED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("complete Realtor forms and conservative DNS host boundaries", () => {
  it.each(["Local Realtor Committee", "Realtor company", "Realtor.commercial", "realtor dot commercial", "realtordotcommercial", "Realtor referral", "realtor", "agent"])("source %s is not a portal", value => {
    expect(hasPortalProvenance({ source: value })).toBe(false);
    expect(isExcludedSource(person({ source: value }))).toBeNull();
  });
  it.each(["REALTOR® . COM™ - campaign", "fixture / realtor com:campaign", "Realtor dot com℠ campaign", "realtordotcom / fixture"])("complete source %s is a portal", source => {
    expect(hasPortalProvenance({ source })).toBe(true);
  });
  it.each(["Realtor company", "Realtor.commercial", "realtor dot commercial", "realtordotcommercial", "fixture Realtor.com", "fixture Zillow"])("partial/nonprefix tag %s is not portal evidence", name => {
    expect(hasPortalProvenance({ tags: [name, { name }] })).toBe(false);
  });
  it.each(["ZILLOW®campaign", "REALTOR®.COM™ / campaign", "realtor com fixture", "realtor dot com fixture", "realtordotcom fixture"])("whole-tag prefix %s is portal evidence", name => {
    expect(hasPortalProvenance({ tags: [{ name }] })).toBe(true);
  });
  it.each([
    "https://zillow.com./fixture", "https://sub.ZILLOW.com./fixture", "http://realtor.com./fixture",
    "https://sub.realtor.com.:443/fixture", "https://fixture@zillow.com./fixture",
    "ftp://zillow.com./fixture", "//zillow.com./fixture",
  ])("readable portal DNS host %s blocks at fresh gate", async sourceUrl => {
    expect(hasPortalProvenance({ sourceUrl })).toBe(true);
    fetchMock.mockResolvedValue({ ok: true, json: async () => fresh({ sourceUrl }) });
    expect(await portalEmailGate(ID)).toEqual({ allowed: false, reason: "PORTAL_SOURCE_EXCLUDED" });
  });
  it.each([
    "https://zillow.com.fixture.invalid./", "https://fakezillow.com./", "https://fakerealtor.com./",
    "https://realtor.com.fixture.invalid./", "https://zillow.com.@fixture.invalid/", "https://fixture.invalid/zillow.com.",
    "https://fixture.invalid/?host=realtor.com.",
  ])("lookalike or path/query/userinfo URL %s is not portal evidence", sourceUrl => {
    expect(hasPortalProvenance({ sourceUrl })).toBe(false);
  });
});

describe("explicit cycle-safe provenance whitelist", () => {
  it.each(["original", "event", "originalProvenance", "eventProvenance"])("nested %s record is inspected", key => {
    expect(hasPortalProvenance({ [key]: { events: [{ original: { source: "Zillow" } }] } })).toBe(true);
  });
  it.each(["provenance", "events"])("explicit %s record array is inspected", key => {
    expect(hasPortalProvenance({ [key]: [{ source: "Website Form" }, { eventSource: "Realtor.com" }] })).toBe(true);
    expect(hasPortalProvenance({ [key]: ["Zillow", [person({ source: "Zillow" })]] } as any)).toBe(false);
  });
  it.each(["data", "payload", "note", "notes", "message", "email", "body", "subject", "triggerSnippet", "sourceId", "createdVia", "arbitrary"])("nonwhitelisted %s cannot supply provenance", key => {
    expect(hasPortalProvenance({ source: "Website Form", [key]: { source: "Zillow", events: [{ source: "Realtor.com" }] } })).toBe(false);
  });
  it("cycles terminate and another explicit branch can still win", () => {
    const value: PortalProvenance = { source: "Website Form" };
    value.original = value; value.events = [value];
    expect(hasPortalProvenance(value)).toBe(false);
    value.event = { original: { tags: ["Realtor.com"] } };
    expect(hasPortalProvenance(value)).toBe(true);
  });
  it("arbitrary nested content is never accessed", () => {
    const content = {};
    Object.defineProperty(content, "source", { get() { throw new Error("SYNTHETIC_CONTENT_READ_FORBIDDEN"); } });
    expect(hasPortalProvenance({ payload: content, notes: content, triggerSnippet: content } as any)).toBe(false);
  });
});

describe("email-only projections preserve every baseline exclusion", () => {
  it.each(PORTAL_SOURCE_NAMES)("source/tag %s bypasses only new semantics with includePortal=false", value => {
    expect(isExcludedSource(person({ source: value }), false)).toBeNull();
    expect(getSharedSuppressionTags(false)).not.toContain(value);
    expect(getSharedSuppressionTags()).toContain(value);
  });
  it.each(["Zillow Rentals - Austin", "New Agent Inquiry campaign", "Agent Scouting campaign", "BOTM Newsletter campaign", "Lease Listing Inquiry - Web"])("old source %s stays excluded without portal semantics", source => {
    expect(isExcludedSource(person({ source }), false)).toBe(source);
  });
  it.each(["realtor", "agent", "dnc", "do not contact", "opt-out", "annual nurture only", "SOI", "landlord", "lease listing inquiry"])("old tag %s stays excluded without portal semantics", name => {
    expect(getSharedSuppressionTags(false)).toContain(name.toLowerCase());
    expect(hasDncTag(person({ tags: [name] }), false)).toBe(true);
  });
  it("generic SMS eligibility does not gain Zillow tag suppression", () => {
    const eligible = { ...person({ source: "Zillow", tags: ["Zillow Buyer Campaign"] }), lastActivity: new Date(Date.now() - 5 * 86400000).toISOString() };
    expect(hasDncTag(eligible, false)).toBe(false);
    expect(hasDncTag(eligible)).toBe(true);
    expect(isEligible(eligible)).toBe(true);
    expect(isEligible({ ...eligible, textOptOut: true })).toBe(false);
    expect(isEligible({ ...eligible, tags: ["agent"] })).toBe(false);
  });
  it("hardcoded fallback contains literal portal tags/sources and every bundled unrelated entry", () => {
    const expected = getSharedSuppressionConfig();
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    reloadSharedSuppressionTags();
    expect(getSharedSuppressionConfig()).toEqual(expected);
    for (const portal of PORTAL_SOURCE_NAMES) expect(getSharedSuppressionConfig().tags).toContain(portal);
    expect(getSharedSuppressionTags(false)).toContain("realtor");
    expect(getSharedSuppressionTags(false)).toContain("agent");
    expect(isExcludedSource(person({ source: "Zillow Rentals - fixture" }), false)).toBeTruthy();
    expect(isExcludedSource(person({ source: "Local Realtor Committee" }))).toBeNull();
    expect(hasPortalProvenance({ source: "Local Realtor Committee" })).toBe(false);
  });
});
