import { withCompleteHistory } from "./portalHistoryTestSupport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import {
  hasPortalProvenance, normalizePortalSource, type PortalProvenance,
} from "./portalProvenance";

const { smtp } = vi.hoisted(() => ({ smtp: vi.fn().mockResolvedValue({ messageId: "synthetic" }) }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: smtp }) } }));
vi.mock("./db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));
import {
  checkLeadEmailPortalGate, getSharedExcludedSources, getSharedSuppressionTags,
  hasDncTag, isEligible, isExcludedSource, isRecruitingSource, isSOISilenced,
  reloadSharedSuppressionTags, sendClockinEmail, sendClockoffEmail, sendEmail,
  sendLeadFollowUpEmail, shouldSkipLead,
} from "./botHelpers";

const personId = 990001;
const options = {
  personId, provenance: { source: "Website Form" }, agentEmail: "agent@example.invalid", agentFirstName: "Synthetic",
  agentLastName: "Agent", leadEmail: "fixture@gmail.com", leadFirstName: null,
  messageBody: "Synthetic body", subject: "Synthetic subject",
};
const currentResponse = (person: unknown) => ({ ok: true, status: 200, json: async () => person });
const portalSources = [
  "Zillow", "ZILLOW", "zillow premier agent", "prefix Zillow suffix", "Zillow® Rentals",
  "Zillow™", "Realtor.com", "REALTOR.COM®", "Realtor com", "Realtordotcom",
  "Realtor dot com", "Realtor---com", "Realtor_dot_com", "prefix Realtor.COM suffix",
  "  Realtor \t dot\n com ℠  ",
];
const nonportalSources = [
  "", "Website Form", "Open House", "Referral", "realtor", "agent",
  "Realtor referral", "Agent Inquiry", "New Agent Inquiry", "Agent Scouting",
  "Trulia", "HotPads", "Homes.com", "Opcity",
];

beforeEach(() => {
  smtp.mockClear();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(withCompleteHistory(currentResponse({ id: personId, source: "Website Form" }))));
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("portal normalization and every selection matcher", () => {
  it("normalizes trademark symbols, punctuation, case and whitespace uniformly", () => {
    expect(normalizePortalSource("  REALTOR®---dot__COM™ ℠ ")).toBe("realtor dot com");
  });
  it.each(portalSources)("portal source variant %#: source/leadSource win independently", source => {
    for (const provenance of [{ source }, { source: "Website Form", leadSource: source }]) {
      const person = { id: personId, ...provenance };
      expect(hasPortalProvenance(person)).toBe(true);
      expect(isExcludedSource(person)).toBe("PORTAL_SOURCE");
      expect(isEligible(person)).toBe(false);
    }
  });
  it.each(nonportalSources)("nonportal source control %#", source => {
    expect(hasPortalProvenance({ source })).toBe(false);
  });
  it.each(["Zillow", "Zillow - Synthetic", "Realtor.com", "Realtor dot com Synthetic", "Realtordotcom: Synthetic"])("whole/prefix tag variant %#", tag => {
    for (const tags of [[tag], [{ name: tag }]]) {
      expect(hasPortalProvenance({ tags })).toBe(true);
      expect(hasDncTag({ id: personId, tags })).toBe(true);
      expect(isExcludedSource({ id: personId, source: "Website Form", tags })).toBe("PORTAL_SOURCE");
    }
  });
  it.each(["internal Zillow", "notzillow", "prefix realtor.com"])("nonprefix tags are not portal evidence %#", tag => {
    expect(hasPortalProvenance({ tags: [tag] })).toBe(false);
  });
  it.each([
    "https://zillow.com/synthetic", "https://www.zillow.com/synthetic",
    "https://sub.realtor.com/synthetic", "https://REALTOR.COM:443/synthetic",
  ])("authorized URL host %#", sourceUrl => {
    expect(hasPortalProvenance({ source: "Website Form", sourceUrl })).toBe(true);
    expect(isExcludedSource({ id: personId, sourceUrl })).toBe("PORTAL_SOURCE");
  });
  it.each([
    "https://notzillow.com", "https://zillow.com.example.invalid", "https://realtor.com.example.invalid",
    "https://example.invalid/realtor.com", "https://zillow.com@example.invalid",
    "https://example.invalid?source=zillow.com", "invalid", "https://evilrealtor.com",
  ])("URL lookalike rejection %#", sourceUrl => {
    expect(hasPortalProvenance({ sourceUrl })).toBe(false);
  });
  it("explicit original/event evidence wins and never scans content", () => {
    for (const provenance of [
      { originalSource: "Zillow" }, { eventSource: "Realtor.com" },
      { original: { source: "Zillow" } }, { event: { leadSource: "Realtor dot com" } },
      { event: { sourceUrl: "https://realtor.com" } },
    ]) expect(hasPortalProvenance({ source: "Website Form", ...provenance })).toBe(true);
    const content = {
      source: "Website Form", notes: [{ body: "Zillow Realtor.com" }],
      message: "Zillow", email: "realtor.com@example.invalid", sourceId: "Zillow", createdVia: "Zillow",
    };
    expect(hasPortalProvenance(content)).toBe(false);
  });
  it("selection portal skip is local and reason-code-only", async () => {
    expect(await shouldSkipLead({ id: personId, source: "Zillow" })).toEqual({ skip: true, reason: "PORTAL_SOURCE" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves unrelated exclusions and recruiting import carve-out", () => {
    expect(isExcludedSource({ id: personId, source: "Lease Listing Inquiry - Synthetic" })).toBeTruthy();
    expect(isRecruitingSource({ id: personId, source: "Agent Scouting - Synthetic" })).toBeTruthy();
    expect(isSOISilenced({ id: personId, source: "Agent Scouting", createdVia: "Import", createdById: 990002 })).toBeNull();
    for (const source of ["realtor", "agent", "Realtor referral", "Agent Inquiry"])
      expect(isExcludedSource({ id: personId, source })).toBeNull();
  });
  it("blank selection with no portal evidence remains eligible", () => {
    expect(isEligible({ id: personId, source: "", tags: [] })).toBe(true);
  });
});

describe("shared fresh-person gate at the lead SMTP boundary", () => {
  it.each(portalSources)("current portal source blocks Gmail-address recipient %#", async source => {
    vi.mocked(fetch).mockImplementation(withCompleteHistory(currentResponse({ id: personId, source })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(smtp).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith("PORTAL_SOURCE");
  });
  it.each([
    { source: "Website Form", leadSource: "Zillow" },
    { source: "", tags: ["Zillow - Synthetic"] },
    { source: "Website Form", sourceUrl: "https://sub.realtor.com" },
    { source: "Website Form", originalSource: "Zillow" },
    { source: "Website Form", event: { source: "Realtor.com" } },
  ])("current alternate evidence blocks %#", async provenance => {
    vi.mocked(fetch).mockImplementation(withCompleteHistory(currentResponse({ id: personId, ...provenance })));
    expect((await sendLeadFollowUpEmail(options)).sent).toBe(false);
    expect(smtp).not.toHaveBeenCalled();
  });
  it.each([
    { source: "Zillow" }, { leadSource: "Realtor.com" }, { tags: ["Zillow"] },
    { sourceUrl: "https://realtor.com" }, { originalSource: "Zillow" },
    { eventSource: "Realtor dot com" }, { original: { source: "Zillow" } },
  ])("already-loaded portal plus current nonportal still blocks %#", async provenance => {
    expect(await sendLeadFollowUpEmail({ ...options, provenance })).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(smtp).not.toHaveBeenCalled();
  });
  it("source changed after queue selection blocks without cached reads", async () => {
    const provenance = { source: "Website Form" };
    expect(await sendLeadFollowUpEmail({ ...options, provenance })).toEqual({ sent: true });
    vi.mocked(fetch).mockImplementation(withCompleteHistory(currentResponse({ id: personId, source: "Zillow" })));
    expect(await sendLeadFollowUpEmail({ ...options, provenance })).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(smtp).toHaveBeenCalledTimes(1);
  });
  it.each([
    undefined, null, {}, [], { id: personId }, { id: 990002, source: "Website Form" },
    { id: personId, source: 7 }, { id: personId, source: "Website Form", leadSource: {} },
    { id: personId, source: "Website Form", tags: {} }, { id: personId, source: "", tags: [null] },
  ])("unusable fresh response fails closed %#", async person => {
    vi.mocked(fetch).mockImplementation(withCompleteHistory(currentResponse(person)));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" });
    expect(smtp).not.toHaveBeenCalled();
  });
  it("unreadable fresh read fails closed and permits later retry", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("SYNTHETIC_READ_FAILURE"));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" });
    expect(smtp).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith("PORTAL_PERSON_UNAVAILABLE");
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: true });
    expect(smtp).toHaveBeenCalledTimes(1);
  });
  it("known original portal wins even if current read fails", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("SYNTHETIC_READ_FAILURE"));
    expect(await sendLeadFollowUpEmail({ ...options, provenance: { source: "Zillow" } })).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
  });
  it.each([0, -1, NaN, 1.5, undefined])("unresolved identity fails closed %#", async id => {
    expect(await checkLeadEmailPortalGate(id as number)).toEqual({ sent: false, reason: "PORTAL_PERSON_ID_UNRESOLVED" });
    expect(fetch).not.toHaveBeenCalled();
    expect(smtp).not.toHaveBeenCalled();
  });
  it.each(nonportalSources)("fresh nonportal source unchanged %#", async source => {
    vi.mocked(fetch).mockImplementation(withCompleteHistory(currentResponse({ id: personId, source })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: true });
    expect(smtp).toHaveBeenCalledTimes(1);
  });
  it("explicit null/blank alias source is usable and content ignored", async () => {
    vi.mocked(fetch).mockImplementation(withCompleteHistory(currentResponse({ id: personId, source: null, leadSource: "", notes: [{ body: "Zillow" }] })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: true });
  });
  it("fresh GET then history are the final asynchronous operations immediately before SMTP", async () => {
    const order: string[] = [];
    vi.mocked(fetch).mockImplementation(async input => {
      order.push(String(input).includes("/events?") ? "history" : "fresh");
      return withCompleteHistory(currentResponse({ id: personId, source: "Website Form" }))(input);
    });
    smtp.mockImplementationOnce(async () => { order.push("smtp"); return { messageId: "synthetic" }; });
    await sendLeadFollowUpEmail(options);
    expect(order).toEqual(["fresh", "history", "smtp"]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toMatch(/\/people\/990001\?fields=allFields$/);
  });
  it("generic lead-contact sender cannot bypass the gate", async () => {
    vi.mocked(fetch).mockImplementation(withCompleteHistory(currentResponse({ id: personId, source: "Zillow" })));
    expect(await sendEmail({ kind: "lead", to: options.leadEmail, subject: "Synthetic", html: "Synthetic", leadContact: { personId, provenance: options.provenance } })).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(smtp).not.toHaveBeenCalled();
  });
  it("generic internal emails do not call FUB", async () => {
    expect(await sendEmail({ kind: "internal", to: "internal@example.invalid", subject: "Synthetic", html: "Synthetic" })).toEqual({ sent: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(smtp).toHaveBeenCalledTimes(1);
  });
  it("both internal clock email helper paths remain ungated", async () => {
    const clock = {
      botName: "Synthetic Bot", agentFirstName: "Synthetic", agentLastName: "Agent",
      agentEmail: "internal@example.invalid", leadsQueued: 0, powerQueueCount: 0,
      accentColor: "#000000", headerGradient: "none", botSlug: "synthetic",
      sent: 0, errored: 0, skipped: 0,
    };
    await sendClockinEmail(clock);
    await sendClockoffEmail(clock);
    expect(fetch).not.toHaveBeenCalled();
    expect(smtp).toHaveBeenCalledTimes(2);
  });
  it("SMTP failures are not represented as successful delivery", async () => {
    smtp.mockRejectedValueOnce(new Error("SYNTHETIC_SMTP_FAILURE"));
    await expect(sendLeadFollowUpEmail(options)).rejects.toThrow("SYNTHETIC_SMTP_FAILURE");
  });
});

describe("bundled JSON and hardcoded fallback values agree", () => {
  it("preserves every original entry and has matching complete lists", () => {
    const bundled = JSON.parse(fs.readFileSync(new URL("../config/suppression_tags.json", import.meta.url), "utf8"));
    const expectedTags = bundled.tags.map((v: string) => v.toLowerCase());
    const expectedSources = bundled.excluded_sources.map((v: string) => v.toLowerCase());
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    reloadSharedSuppressionTags();
    expect(getSharedSuppressionTags()).toEqual(expectedTags);
    expect(getSharedExcludedSources()).toEqual(expectedSources);
    for (const source of portalSources) expect(isExcludedSource({ id: personId, source })).toBe("PORTAL_SOURCE");
    vi.restoreAllMocks();
    reloadSharedSuppressionTags();
  });
  it("an old preferred JSON cannot disable the runtime portal matcher", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ tags: [], excluded_sources: [] }));
    reloadSharedSuppressionTags();
    expect(isExcludedSource({ id: personId, source: "Realtor.com" })).toBe("PORTAL_SOURCE");
    expect(hasDncTag({ id: personId, tags: ["Zillow - Synthetic"] })).toBe(true);
    vi.restoreAllMocks();
    reloadSharedSuppressionTags();
  });
});
