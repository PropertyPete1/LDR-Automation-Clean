import { withCompleteHistory } from "./portalHistoryTestSupport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import {
  hasPortalProvenance, hasUsableProvenanceMetadata, inspectPortalProvenance,
  hasUsableFreshProvenance, type PortalProvenance,
} from "./portalProvenance";
const fixture = vi.hoisted(() => ({
  smtp: vi.fn().mockResolvedValue({ messageId: "synthetic" }),
  transport: vi.fn(),
}));
vi.mock("nodemailer", () => ({ default: { createTransport: (...args: unknown[]) => {
  fixture.transport(...args); return { sendMail: fixture.smtp };
} } }));
vi.mock("./db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));
import { hasRequiredEmailContext, isExcludedSource, reloadSharedSuppressionTags, sendEmail, sendLeadFollowUpEmail } from "./botHelpers";

interface ConformanceCase { name: string; record: Record<string, unknown>; portal: boolean; metadataUsable: boolean }
const cases: ConformanceCase[] = JSON.parse(fs.readFileSync(
  new URL("../../pond-nurture-bot/tests/fixtures/portal_provenance.json", import.meta.url), "utf8",
));
const personId = 900001;
const options = {
  personId, provenance: { source: "Website" } as PortalProvenance,
  agentEmail: "agent@example.invalid", agentFirstName: "Synthetic", agentLastName: "Agent",
  leadEmail: "fixture@example.invalid", leadFirstName: null, messageBody: "Synthetic", subject: "Synthetic",
};
const response = (person: unknown) => ({ ok: true, status: 200, json: async () => person });
const expectedDelivery = (item: ConformanceCase) => item.portal
  ? { sent: false, reason: "PORTAL_SOURCE" }
  : item.metadataUsable ? { sent: true } : { sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(withCompleteHistory(response({ id: personId, source: "Website" }))));
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("parent-owned shared provenance conformance (one fixture)", () => {
  it("consumes all 137 parent-owned cases, including independent decoded-host regressions", () => {
    expect(cases).toHaveLength(137);
    expect(new Set(cases.map(item => item.name)).size).toBe(137);
  });
  it.each(cases)("pure matcher and metadata validity: $name", item => {
    expect(hasPortalProvenance(item.record)).toBe(item.portal);
    expect(hasUsableProvenanceMetadata(item.record)).toBe(item.metadataUsable);
    expect(inspectPortalProvenance(item.record)).toEqual({ portal: item.portal, metadataUsable: item.metadataUsable });
    expect(hasUsableFreshProvenance({ source: "Website", ...item.record, id: personId }, personId)).toBe(item.metadataUsable);
  });
  it.each(cases)("fresh final sender conformance: $name", async item => {
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ source: "Website", ...item.record, id: personId })));
    expect(await sendLeadFollowUpEmail(options)).toEqual(expectedDelivery(item));
    expect(fixture.smtp).toHaveBeenCalledTimes(!item.portal && item.metadataUsable ? 1 : 0);
    expect(vi.mocked(fetch).mock.calls.filter(call => String(call[0]).includes("/events?")).length).toBe(!item.portal && item.metadataUsable ? 1 : 0);
  });
  it.each(cases)("already-loaded final sender conformance: $name", async item => {
    expect(await sendLeadFollowUpEmail({ ...options, provenance: item.record as PortalProvenance })).toEqual(expectedDelivery(item));
    expect(fixture.smtp).toHaveBeenCalledTimes(!item.portal && item.metadataUsable ? 1 : 0);
    expect(vi.mocked(fetch).mock.calls.filter(call => String(call[0]).includes("/events?")).length).toBe(!item.portal && item.metadataUsable ? 1 : 0);
  });
});

describe("explicit context and source object validation", () => {
  it("regression_a_trailing_dot_blocks_final_sender", async () => {
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: personId, source: "Website", sourceUrl: "https://zillow.com./lead" })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(fixture.smtp).not.toHaveBeenCalled();
    expect(fixture.transport).not.toHaveBeenCalled();
  });
  it("regression_b_local_realtor_committee_is_nonportal", async () => {
    const person = { id: personId, source: "Local Realtor Committee" };
    expect(hasPortalProvenance(person)).toBe(false);
    expect(isExcludedSource(person)).toBeNull();
    expect(isExcludedSource(person, false)).toBeNull();
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    reloadSharedSuppressionTags();
    expect(isExcludedSource(person)).toBeNull();
    expect(isExcludedSource(person, false)).toBeNull();
    vi.restoreAllMocks(); reloadSharedSuppressionTags();
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response(person)));
    expect(await sendLeadFollowUpEmail({ ...options, provenance: person })).toEqual({ sent: true });
    expect(fixture.smtp).toHaveBeenCalledTimes(1);
  });
  it("regression_c_missing_audience_context_fails_closed", async () => {
    const missing = { to: "fixture@example.invalid", subject: "Synthetic", html: "Synthetic" };
    expect(hasRequiredEmailContext(missing)).toBe(false);
    expect(await sendEmail(missing as any)).toEqual({ sent: false, reason: "EMAIL_CONTEXT_REQUIRED" });
    expect(fixture.smtp).not.toHaveBeenCalled();
    expect(fixture.transport).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    undefined, null, [], {}, { kind: "unknown" }, { kind: false },
    { kind: "lead" }, { kind: "lead", leadContact: null }, { kind: "lead", leadContact: [] },
    { kind: "lead", leadContact: {} }, { kind: "lead", leadContact: { personId } },
    { kind: "lead", leadContact: { personId, provenance: null } },
    { kind: "lead", leadContact: { personId, provenance: [] } },
    { kind: "lead", leadContact: { provenance: { source: "Website" } } },
    { kind: "internal", leadContact: { personId, provenance: { source: "Zillow" } } },
    Object.create({ kind: "internal" }),
  ])("malformed JavaScript context fails before transport or lookup %#", async context => {
    const opts = context && !Array.isArray(context) ? Object.assign(Object.create(Object.getPrototypeOf(context)), {
      to: "fixture@example.invalid", subject: "Synthetic", html: "Synthetic",
    }, context) : context;
    expect(await sendEmail(opts as any)).toEqual({ sent: false, reason: "EMAIL_CONTEXT_REQUIRED" });
    expect(fixture.smtp).not.toHaveBeenCalled(); expect(fixture.transport).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("explicit internal mail still sends without source or person context", async () => {
    expect(await sendEmail({ kind: "internal", to: "internal@example.invalid", subject: "Synthetic", html: "Synthetic" })).toEqual({ sent: true });
    expect(fixture.smtp).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("followup missing provenance never silently becomes internal", async () => {
    const { provenance: _ignored, ...missing } = options;
    expect(await sendLeadFollowUpEmail(missing as any)).toEqual({ sent: false, reason: "EMAIL_CONTEXT_REQUIRED" });
    expect(fixture.smtp).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["originalSource", "eventSource"])("explicit source objects alone may read name; key %s", async key => {
    const record = { source: "Website", [key]: { name: "REALTOR®---DOT__COM™" } };
    expect(inspectPortalProvenance(record)).toEqual({ portal: true, metadataUsable: true });
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: personId, ...record })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(fixture.smtp).not.toHaveBeenCalled();
  });
  it("never reads person.name or arbitrary original content as source", async () => {
    const record = { source: "Website", name: "Zillow", notes: [{ source: "Zillow" }], body: "Realtor.com" };
    expect(inspectPortalProvenance(record)).toEqual({ portal: false, metadataUsable: true });
    expect(await sendLeadFollowUpEmail({ ...options, provenance: record })).toEqual({ sent: true });
    expect(inspectPortalProvenance({ source: "Website", originalSource: { body: "Zillow" } })).toEqual({ portal: false, metadataUsable: false });
  });
  it.each(["originalSource", "eventSource", "original", "event", "originalProvenance", "eventProvenance", "events", "provenance"])("unreadable metadata defers and known portal wins: %s", async key => {
    const record = { source: "Website" };
    Object.defineProperty(record, key, { enumerable: true, get: () => { throw new Error("SYNTHETIC_UNREADABLE"); } });
    expect(inspectPortalProvenance(record)).toEqual({ portal: false, metadataUsable: false });
    expect(await sendLeadFollowUpEmail({ ...options, provenance: record })).toEqual({ sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" });
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: personId, source: "Zillow" })));
    expect(await sendLeadFollowUpEmail({ ...options, provenance: record })).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(fixture.smtp).not.toHaveBeenCalled();
  });
  it("unreadable explicit source object defers; another portal field still wins", () => {
    const originalSource = Object.defineProperty({}, "name", { get: () => { throw new Error("SYNTHETIC_UNREADABLE"); } });
    expect(inspectPortalProvenance({ source: "Website", originalSource })).toEqual({ portal: false, metadataUsable: false });
    expect(inspectPortalProvenance({ source: "Zillow", originalSource })).toEqual({ portal: true, metadataUsable: false });
  });
  it.each(["originalSource", "eventSource", "original", "event", "originalProvenance", "eventProvenance", "events", "provenance"])("explicit undefined metadata is not a missing alias: %s", async key => {
    const record = { source: "Website", [key]: undefined };
    expect(inspectPortalProvenance(record)).toEqual({ portal: false, metadataUsable: false });
    expect(await sendLeadFollowUpEmail({ ...options, provenance: record })).toEqual({ sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" });
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: personId, ...record })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" });
    expect(inspectPortalProvenance({ ...record, source: "Zillow" })).toEqual({ portal: true, metadataUsable: false });
    expect(fixture.smtp).not.toHaveBeenCalled();
  });
  it.each(["originalSource", "eventSource", "original", "event", "originalProvenance", "eventProvenance", "tags"])("revoked unreadable nested object defers but cannot hide portal: %s", async key => {
    const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
    const record = { source: "Website", [key]: proxy };
    expect(inspectPortalProvenance(record)).toEqual({ portal: false, metadataUsable: false });
    expect(await sendLeadFollowUpEmail({ ...options, provenance: record as PortalProvenance })).toEqual({ sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" });
    expect(inspectPortalProvenance({ ...record, source: "Zillow" })).toEqual({ portal: true, metadataUsable: false });
    expect(fixture.smtp).not.toHaveBeenCalled();
  });
  it("cycle-safe validation and matching retain malformed and portal results", () => {
    const record: any = { source: "Website" }; record.original = record;
    record.originalSource = { name: "Referral", eventSource: record }; record.events = [record];
    expect(inspectPortalProvenance(record)).toEqual({ portal: false, metadataUsable: true });
    record.events.push({ originalSource: {} });
    expect(inspectPortalProvenance(record)).toEqual({ portal: false, metadataUsable: false });
    record.events.push({ eventSource: { name: "Zillow" } });
    expect(inspectPortalProvenance(record)).toEqual({ portal: true, metadataUsable: false });
  });
  it("15000-level metadata validation is iterative, not recursive", () => {
    let record: PortalProvenance = { source: "Referral" };
    for (let depth = 0; depth < 15000; depth++) record = { original: record };
    expect(hasUsableProvenanceMetadata(record)).toBe(true);
  });
});

describe("candidate 3 no-recipient and absent-snapshot closure", () => {
  it.each(["", " ", "\t\n", [], ["", " "], null, undefined])("shared lead sender rejects blank To before lookup/SMTP %#", async to => {
    const result = await sendEmail({ kind: "lead", leadContact: { personId, provenance: { source: "Website" } }, to, bcc: "internal@example.invalid", subject: "Synthetic", html: "Synthetic" } as any);
    expect(result).toEqual({ sent: false, reason: "LEAD_EMAIL_ADDRESS_MISSING" });
    expect(fetch).not.toHaveBeenCalled(); expect(fixture.smtp).not.toHaveBeenCalled(); expect(fixture.transport).not.toHaveBeenCalled();
  });
  it.each(["", " ", "\t\n", null, undefined])("exported follow-up refuses no lead recipient despite owner BCC %#", async leadEmail => {
    expect(await sendLeadFollowUpEmail({ ...options, leadEmail } as any)).toEqual({ sent: false, reason: "LEAD_EMAIL_ADDRESS_MISSING" });
    expect(fetch).not.toHaveBeenCalled(); expect(fixture.smtp).not.toHaveBeenCalled(); expect(fixture.transport).not.toHaveBeenCalled();
  });
  it.each([{}, { id: 1, firstName: "Synthetic" }])("unrelated loaded top-level snapshot is absent, not malformed %#", async provenance => {
    expect(await sendLeadFollowUpEmail({ ...options, provenance: provenance as PortalProvenance })).toEqual({ sent: true });
    expect(fixture.smtp).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: personId })));
    expect(await sendLeadFollowUpEmail({ ...options, provenance: provenance as PortalProvenance })).toEqual({ sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" });
    expect(fixture.smtp).toHaveBeenCalledTimes(1);
  });
});

describe("candidate 3 ambiguous authority parity", () => {
  it.each(["/zillow.com", "https://zillow.com:443:bad/lead", "https://[::1]:443:bad/lead",
    "https://%09example.invalid/x", "https://ex%09ample.invalid/x", "https://%0Aexample.invalid/x"])("unreadable URL explicitly defers; readable portal sibling wins: %s", async sourceUrl => {
    const record = { source: "Website", sourceUrl };
    expect(inspectPortalProvenance(record)).toEqual({ portal: false, metadataUsable: false });
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ ...record, id: personId })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" });
    const withPortal = { ...record, originalSource: { name: "Zillow" } };
    expect(inspectPortalProvenance(withPortal)).toEqual({ portal: true, metadataUsable: false });
    expect(await sendLeadFollowUpEmail({ ...options, provenance: withPortal })).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(fixture.smtp).not.toHaveBeenCalled(); expect(fixture.transport).not.toHaveBeenCalled();
  });
});
