import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({ sendMail: vi.fn().mockResolvedValue({ messageId: "fixture-910001" }) }));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: mocks.sendMail }) },
}));
vi.mock("./db", () => ({ getDb: vi.fn(async () => null) }));

import {
  hasPortalProvenance, normalizePortalSource, portalEmailGate, PORTAL_SOURCE_NAMES,
  PORTAL_SOURCE_HOSTS, type PortalProvenance,
} from "./portalEmailGate";
import {
  isExcludedSource, getSharedSuppressionConfig, reloadSharedSuppressionTags,
  sendEmail, sendLeadFollowUpEmail, shouldSkipLead,
} from "./botHelpers";

const ID = 910001;
const mockFetch = vi.fn();
const historyFetch = vi.fn();
const source = (value: PortalProvenance) => ({ id: ID, ...value });
const current = (value: Record<string, unknown> = {}) => ({ id: ID, source: "Website Form", tags: [], ...value });
const respond = (value: unknown) => ({ ok: true, json: async () => value });
const portalVariants = [
  { source: "Zillow" }, { source: "ZILLOW™ Premier Agent" }, { source: "fixture / Zillow® / campaign" },
  { source: "Realtor.com" }, { source: "REALTOR® . COM" }, { source: "Realtor com" },
  { source: "realtordotcom" }, { source: "realtor dot com" }, { source: "REALTOR__DOT__COM" },
  { source: "Website Form", leadSource: "Zillow" }, { source: "", leadSource: "Realtor.com" },
  { source: "Website Form", tags: ["Zillow"] }, { tags: ["Zillow Premier Agent - fixture"] },
  { tags: [{ name: "Realtor® .com - fixture" }] }, { tags: ["realtordotcom fixture"] },
  { sourceUrl: "https://zillow.com/fixture" }, { sourceUrl: "https://sub.zillow.com/fixture" },
  { sourceUrl: "https://REALTOR.com/fixture" }, { sourceUrl: "https://sub.realtor.com/fixture" },
  { originalSource: "Zillow" }, { eventSource: "Realtor.com" },
  { originalProvenance: { source: "Zillow" } }, { eventProvenance: { source: "Realtor.com" } },
] satisfies PortalProvenance[];
const controls = [
  { source: "realtor" }, { source: "agent" }, { source: "Realtor referral" }, { source: "Agent Inquiry" },
  { source: "Agent Referral" }, { source: "Website Form" }, { source: "Open House" },
  { source: "" }, { source: null }, {}, { source: "Trulia" }, { source: "HotPads" },
  { source: "Homes.com" }, { source: "Opcity" },
  { sourceUrl: "https://zillow.com.fixture.invalid/" }, { sourceUrl: "https://fakezillow.com/" },
  { sourceUrl: "https://realtor.com.fixture.invalid/" }, { sourceUrl: "https://fakerealtor.com/" },
  { sourceUrl: "https://zillow.com@fixture.invalid/" }, { sourceUrl: "https://fixture.invalid/zillow.com" },
  { tags: ["fixture Zillow", "fixture Realtor.com"] },
] satisfies PortalProvenance[];

beforeEach(() => {
  historyFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ events: [], _metadata: { collection: "events", total: 0 } }) });
  vi.stubGlobal("fetch", (url: string, opts?: RequestInit) => new URL(url).pathname === "/v1/events"
    ? historyFetch(url, opts) : mockFetch(url, opts));
  vi.stubEnv("FUB_API_KEY", "fixture-key-910001");
  mockFetch.mockReset();
  mocks.sendMail.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  reloadSharedSuppressionTags();
});

describe("portal provenance matcher", () => {
  it("normalizes case trademarks punctuation and whitespace", () => {
    expect(normalizePortalSource("  REALTOR®.__DOT__ COM™  ")).toBe("realtor dot com");
  });
  it.each(portalVariants.map((value, index) => [index, value] as const))("portal variant %i matches every source matcher", (_index, value) => {
    expect(hasPortalProvenance(value)).toBe(true);
    expect(isExcludedSource(source(value))).toBe("PORTAL_SOURCE_EXCLUDED");
  });
  it.each(controls.map((value, index) => [index, value] as const))("nonportal control %i stays nonportal", (_index, value) => {
    expect(hasPortalProvenance(value)).toBe(false);
    expect(isExcludedSource(source(value))).toBeNull();
  });
  it("never scans communication content sourceId or createdVia", () => {
    expect(hasPortalProvenance({
      source: "Website Form", notes: [{ body: "Zillow" }], message: "Realtor.com",
      email: "fixture-910001@zillow.com", sourceId: "Zillow", createdVia: "Realtor.com",
    } as PortalProvenance)).toBe(false);
  });
  it("portal evidence wins over all nonportal fields and avoids content reads", () => {
    const value = { source: "Website Form", leadSource: "Zillow", tags: ["agent"] };
    Object.defineProperty(value, "notes", { get() { throw new Error("FIXTURE_CONTENT_READ_FORBIDDEN"); } });
    expect(hasPortalProvenance(value)).toBe(true);
  });
  it("shared skip gate stops portal before any deal model or note access", async () => {
    expect(await shouldSkipLead(source({ source: "Zillow" }))).toEqual({ skip: true, reason: "PORTAL_SOURCE_EXCLUDED" });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("fresh shared email gate", () => {
  it.each(portalVariants.map((value, index) => [index, value] as const))("fresh portal variant %i blocks", async (_index, value) => {
    mockFetch.mockResolvedValue(respond(current(value)));
    expect(await portalEmailGate(ID)).toEqual({ allowed: false, reason: "PORTAL_SOURCE_EXCLUDED" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(historyFetch).not.toHaveBeenCalled();
  });
  it("queued source changed to Zillow blocks at the fresh read", async () => {
    mockFetch.mockResolvedValue(respond(current({ source: "Zillow" })));
    expect((await portalEmailGate(ID, { source: "Website Form" })).allowed).toBe(false);
    expect(mockFetch.mock.calls[0][0]).toContain(`/people/${ID}?fields=allFields`);
  });
  it("original portal plus current nonportal blocks", async () => {
    mockFetch.mockResolvedValue(respond(current()));
    expect(await portalEmailGate(ID, { originalProvenance: { source: "Zillow" } })).toEqual({ allowed: false, reason: "PORTAL_SOURCE_EXCLUDED" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(historyFetch).not.toHaveBeenCalled();
  });
  it.each([{}, null, [], { id: ID }, { id: ID + 1, source: "" }, { id: ID, source: {} }, { id: ID, tags: [false] }])("unusable fresh response fails closed", async value => {
    mockFetch.mockResolvedValue(respond(value));
    expect(await portalEmailGate(ID)).toEqual({ allowed: false, reason: "PORTAL_FRESH_PERSON_UNUSABLE" });
  });
  it("fresh errors fail closed and a later successful read stays eligible", async () => {
    mockFetch.mockRejectedValueOnce(new Error("FIXTURE_READ_FAILED")).mockResolvedValueOnce(respond(current()));
    expect(await portalEmailGate(ID)).toEqual({ allowed: false, reason: "PORTAL_FRESH_READ_FAILED" });
    expect(await portalEmailGate(ID)).toEqual({ allowed: true });
  });
  it("HTTP failure fails closed", async () => {
    mockFetch.mockResolvedValue({ ok: false });
    expect(await portalEmailGate(ID)).toEqual({ allowed: false, reason: "PORTAL_FRESH_READ_FAILED" });
  });
  it("missing key and missing person id never reach transport", async () => {
    vi.stubEnv("FUB_API_KEY", "");
    expect(await portalEmailGate(ID)).toEqual({ allowed: false, reason: "PORTAL_FRESH_READ_FAILED" });
    expect(await portalEmailGate(NaN)).toEqual({ allowed: false, reason: "PORTAL_PERSON_ID_UNRESOLVED" });
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it.each(["", null, "Website Form", "Realtor referral", "Agent Inquiry"])("blank and nonportal current source passes", async value => {
    mockFetch.mockResolvedValue(respond(current({ source: value })));
    expect(await portalEmailGate(ID)).toEqual({ allowed: true });
    expect(historyFetch).toHaveBeenCalledTimes(1);
  });
});

describe("configuration loader and fallback parity", () => {
  it("bundled values match the mandatory semantics without a new endpoint", () => {
    const json = JSON.parse(readFileSync(fileURLToPath(new URL("../config/suppression_tags.json", import.meta.url)), "utf8"));
    const config = getSharedSuppressionConfig();
    expect(json.portal_source_names).toEqual([...PORTAL_SOURCE_NAMES]);
    expect(json.portal_source_hosts).toEqual([...PORTAL_SOURCE_HOSTS]);
    expect(config.excluded_sources).toEqual(json.excluded_sources.map((value: string) => value.toLowerCase()));
  });
  it("missing JSON uses matching hardcoded values and preserves unrelated entries", () => {
    const expected = getSharedSuppressionConfig();
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    reloadSharedSuppressionTags();
    expect(getSharedSuppressionConfig()).toEqual(expected);
  });
  it("old shared JSON cannot remove mandatory portal exclusions", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ tags: [], excluded_sources: ["fixture source"] }));
    reloadSharedSuppressionTags();
    expect(getSharedSuppressionConfig().excluded_sources).toEqual(["fixture source", ...PORTAL_SOURCE_NAMES]);
    expect(isExcludedSource(source({ source: "Zillow" }))).toBe("PORTAL_SOURCE_EXCLUDED");
    expect(isExcludedSource(source({ source: "fixture source campaign" }))).toBeTruthy();
  });
});

describe("exported SMTP surfaces", () => {
  const mail = { to: "fixture-910001@gmail.com", subject: "fixture-910001", html: "fixture-910001" };
  const followUp = {
    personId: ID, agentEmail: "fixture-agent-910001@example.invalid", agentFirstName: "", agentLastName: "",
    leadEmail: mail.to, leadFirstName: null, messageBody: "fixture-910001", subject: "fixture-910001",
  };
  it.each(["direct", "follow-up"])("%s blocks portal Gmail recipients without returning transport success", async path => {
    mockFetch.mockResolvedValue(respond(current({ source: "Zillow" })));
    const promise = path === "direct" ? sendEmail({ ...mail, personId: ID }) : sendLeadFollowUpEmail(followUp);
    await expect(promise).rejects.toMatchObject({ reason: "PORTAL_SOURCE_EXCLUDED" });
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });
  it.each(["direct", "follow-up"])("%s preserves nonportal sends and fresh read immediately precedes SMTP", async path => {
    const events: string[] = [];
    mockFetch.mockImplementation(async () => { events.push("read"); return respond(current()); });
    historyFetch.mockImplementation(async () => { events.push("history"); return respond({ events: [], _metadata: { collection: "events", total: 0 } }); });
    mocks.sendMail.mockImplementationOnce(async () => { events.push("smtp"); });
    if (path === "direct") await sendEmail({ ...mail, personId: ID });
    else await sendLeadFollowUpEmail(followUp);
    expect(events).toEqual(["read", "history", "smtp"]);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });
  it("missing person id is explicitly blocked", async () => {
    await expect(sendEmail(mail as any)).rejects.toMatchObject({ reason: "PORTAL_PERSON_ID_UNRESOLVED" });
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });
  it("internal SMTP is unchanged and does not read FUB", async () => {
    await sendEmail({ ...mail, internal: true });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
