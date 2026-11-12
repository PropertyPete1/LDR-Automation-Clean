import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import fs from "node:fs";

const state = vi.hoisted(() => ({ smtp: vi.fn(), db: vi.fn(async () => null) }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: state.smtp }) } }));
vi.mock("./db", () => ({ getDb: state.db }));
import { hasPortalProvenance, inspectPortalProvenance, inspectPortalUrl, isUsablePortalPerson, portalEmailGate, type PortalProvenance } from "./portalEmailGate";
import { sendEmail, sendLeadFollowUpEmail, isExcludedSource, shouldSkipLead, reloadSharedSuppressionTags } from "./botHelpers";

type Case = { name: string; record: Record<string, unknown>; portal: boolean; metadataUsable: boolean };
const cases: Case[] = JSON.parse(readFileSync(new URL("../../pond-nurture-bot/tests/fixtures/portal_provenance.json", import.meta.url), "utf8"));
const ID = 900001;
const current = (record: Record<string, unknown> = {}) => ({ source: "Website", ...record, id: ID });
const fetchMock = vi.fn();
const historyFetch = vi.fn();
const mail = { to: "fixture-900001@example.invalid", subject: "fixture-900001", html: "fixture-900001" };
const followUp = { personId: ID, agentEmail: "fixture-agent-900001@example.invalid", agentFirstName: "", agentLastName: "", leadEmail: mail.to, leadFirstName: null, messageBody: "fixture-900001" };
const expected = (row: Case, snapshot = false) => row.portal
  ? { allowed: false, reason: "PORTAL_SOURCE_EXCLUDED" }
  : !row.metadataUsable
    ? { allowed: false, reason: snapshot ? "PORTAL_PROVENANCE_UNUSABLE" : "PORTAL_FRESH_PERSON_UNUSABLE" }
    : { allowed: true };

beforeEach(() => {
  historyFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ events: [], _metadata: { collection: "events", total: 0 } }) });
  vi.stubGlobal("fetch", (url: string, opts?: RequestInit) => new URL(url).pathname === "/v1/events"
    ? historyFetch(url, opts) : fetchMock(url, opts));
  vi.stubEnv("FUB_API_KEY", "synthetic-key-900001");
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => current() });
  state.smtp.mockReset().mockResolvedValue({ messageId: "fixture-900001" });
  state.db.mockClear();
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); reloadSharedSuppressionTags(); });

describe("one parent-owned shared provenance fixture, consumed in full", () => {
  it("consumes exactly all 137 uniquely named acceptance cases", () => {
    expect(cases).toHaveLength(137);
    expect(new Set(cases.map(row => row.name)).size).toBe(137);
  });
  it.each(cases)("matcher and shape: $name", row => {
    expect(inspectPortalProvenance(row.record)).toEqual({ portal: row.portal, metadataUsable: row.metadataUsable });
    expect(hasPortalProvenance(row.record as PortalProvenance)).toBe(row.portal);
  });
  it.each(cases)("fresh gate: $name", async row => {
    const person = current(row.record);
    expect(isUsablePortalPerson(person, ID)).toBe(row.metadataUsable);
    fetchMock.mockResolvedValue({ ok: true, json: async () => person });
    expect(await portalEmailGate(ID)).toEqual(expected(row));
    expect(historyFetch).toHaveBeenCalledTimes(row.portal || !row.metadataUsable ? 0 : 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(cases)("already-loaded snapshot gate: $name", async row => {
    expect(await portalEmailGate(ID, row.record as PortalProvenance)).toEqual(expected(row, true));
    expect(historyFetch).toHaveBeenCalledTimes(row.portal || !row.metadataUsable ? 0 : 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

for (const path of ["direct", "follow-up"] as const) {
  for (const location of ["fresh", "snapshot"] as const) {
    describe(`exported ${path}, ${location} acceptance`, () => {
      it.each(cases)("$name", async row => {
        const provenance = location === "snapshot" ? row.record as PortalProvenance : { source: "Website" };
        fetchMock.mockResolvedValue({ ok: true, json: async () => current(location === "fresh" ? row.record : {}) });
        const promise = path === "direct" ? sendEmail({ ...mail, personId: ID, provenance }) : sendLeadFollowUpEmail({ ...followUp, provenance });
        const verdict = expected(row, location === "snapshot");
        if (verdict.allowed) {
          await expect(promise).resolves.toBeUndefined();
          expect(state.smtp).toHaveBeenCalledTimes(1);
        } else {
          await expect(promise).rejects.toMatchObject({ reason: verdict.reason });
          expect(state.smtp).not.toHaveBeenCalled();
        }
        expect(historyFetch).toHaveBeenCalledTimes(verdict.allowed ? 1 : 0);
        expect(state.db).not.toHaveBeenCalled(); // no helper-owned sent/contacted/angle/cadence/cap/queue write
        expect(fetchMock.mock.calls.every(([, opts]) => !opts?.method || opts.method === "GET")).toBe(true); // no FUB sent note
      });
    });
  }
}

describe("explicit-source-object and unreadable metadata boundaries", () => {
  it.each(["originalSource", "eventSource"])("%s only reads name/source/leadSource, never content", async field => {
    const sourceObject: any = { name: "Referral" };
    for (const key of ["body", "payload", "data", "unknown"]) Object.defineProperty(sourceObject, key, { get() { throw new Error("FORBIDDEN_SYNTHETIC_CONTENT_READ"); } });
    const record = { source: "Website", [field]: sourceObject };
    expect(inspectPortalProvenance(record)).toEqual({ portal: false, metadataUsable: true });
    expect(await portalEmailGate(ID, record)).toEqual({ allowed: true });
  });
  it("person.name is not source metadata", async () => {
    const person = current({ name: "Zillow" });
    expect(inspectPortalProvenance(person)).toEqual({ portal: false, metadataUsable: true });
    fetchMock.mockResolvedValue({ ok: true, json: async () => person });
    expect(await portalEmailGate(ID)).toEqual({ allowed: true });
  });
  it.each(["originalSource", "eventSource", "original", "event", "originalProvenance", "eventProvenance", "provenance", "events"])("unreadable explicit %s defers", async field => {
    const person = current();
    Object.defineProperty(person, field, { get() { throw new Error("SYNTHETIC_METADATA_UNREADABLE"); } });
    expect(inspectPortalProvenance(person)).toEqual({ portal: false, metadataUsable: false });
    fetchMock.mockResolvedValue({ ok: true, json: async () => person });
    expect(await portalEmailGate(ID)).toEqual({ allowed: false, reason: "PORTAL_FRESH_PERSON_UNUSABLE" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => current() });
    expect(await portalEmailGate(ID, person)).toEqual({ allowed: false, reason: "PORTAL_PROVENANCE_UNUSABLE" });
  });
  it("cycle-safe named records retain usable shape and known portal wins over unreadable branches", async () => {
    const record: PortalProvenance = { source: "Website" };
    record.original = record; record.events = [record];
    expect(inspectPortalProvenance(record)).toEqual({ portal: false, metadataUsable: true });
    Object.defineProperty(record, "eventSource", { get() { throw new Error("SYNTHETIC_METADATA_UNREADABLE"); } });
    record.event = { originalSource: { name: "Zillow" } };
    expect(inspectPortalProvenance(record)).toEqual({ portal: true, metadataUsable: false });
    expect(await portalEmailGate(ID, record)).toEqual({ allowed: false, reason: "PORTAL_SOURCE_EXCLUDED" });
  });
  it.each(cases.filter(row => !row.metadataUsable))("known fresh portal overrides malformed old snapshot: $name", async row => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => current({ source: "Zillow" }) });
    expect(await portalEmailGate(ID, row.record as PortalProvenance)).toEqual({ allowed: false, reason: "PORTAL_SOURCE_EXCLUDED" });
  });
  it("exported selection helper defers malformed evidence without network/model/write", async () => {
    expect(await shouldSkipLead(current({ originalSource: {} }) as any)).toEqual({ skip: true, reason: "PORTAL_PROVENANCE_UNUSABLE" });
    expect(fetchMock).not.toHaveBeenCalled(); expect(state.db).not.toHaveBeenCalled();
  });
  it.each([{}, { id: ID, firstName: "Synthetic" }])("unrelated top-level snapshots are absent provenance %#", async record => {
    expect(inspectPortalProvenance(record)).toEqual({ portal: false, metadataUsable: true });
    expect(isUsablePortalPerson(record, ID)).toBe(false);
    expect(await portalEmailGate(ID, record)).toEqual({ allowed: true });
  });
  it.each(["original", "event", "originalProvenance", "eventProvenance", "originalSource", "eventSource"])("unrecognized explicit nested %s remains malformed", field => {
    expect(inspectPortalProvenance({ [field]: {} })).toEqual({ portal: false, metadataUsable: false });
  });
  it("a top-level object revisited as explicit nested provenance is checked strictly", () => {
    const record: Record<string, unknown> = {};
    Object.defineProperty(record, "event", { get() { delete record.event; return record; }, configurable: true });
    expect(inspectPortalProvenance(record)).toEqual({ portal: false, metadataUsable: false });
  });
  it("deep named metadata stays iterative and never reads unrelated content or person names", () => {
    const root: Record<string, unknown> = { source: "Website" };
    let record = root;
    for (let index = 0; index < 12_000; index++) {
      const nested: Record<string, unknown> = { source: "Referral" };
      record.event = nested;
      record = nested;
    }
    record.eventSource = { name: "Zillow" };
    for (const field of ["data", "payload", "notes", "messages", "body", "subject", "firstName", "lastName", "name"])
      Object.defineProperty(root, field, { get() { throw new Error("FORBIDDEN_SYNTHETIC_CONTENT_READ"); } });
    expect(inspectPortalProvenance(root)).toEqual({ portal: true, metadataUsable: true });
  });
});

type UnreadableCase = { name: string; record: () => Record<string, unknown> };
const revoked = (value: object = {}) => {
  const { proxy, revoke } = Proxy.revocable(value, {});
  revoke();
  return proxy;
};
const unreadableCases: UnreadableCase[] = [
  ...["originalSource", "eventSource", "original", "event", "originalProvenance", "eventProvenance"].map(field => ({
    name: `revoked ${field}`, record: () => ({ [field]: revoked() }),
  })),
  { name: "revoked tag record", record: () => ({ tags: [revoked(), "Referral"] }) },
  { name: "revoked tags array", record: () => ({ tags: revoked([]) }) },
  ...["events", "provenance"].flatMap(field => [
    { name: `revoked ${field} array`, record: () => ({ [field]: revoked([]) }) },
    { name: `revoked record in ${field}`, record: () => ({ [field]: [revoked(), { source: "Referral" }] }) },
  ]),
  { name: "revoked nested event source", record: () => ({ event: { source: "Referral", eventSource: revoked() } }) },
  { name: "revoked nested tags", record: () => ({ original: { tags: [revoked()] } }) },
  { name: "unreadable array length", record: () => ({ events: new Proxy([], { get(target, key, receiver) {
    if (key === "length") throw new Error("SYNTHETIC_ARRAY_UNREADABLE");
    return Reflect.get(target, key, receiver);
  } }) }) },
];

describe("R3 unreadable proxies never throw and readable portal branches win", () => {
  it.each(unreadableCases)("pure inspector: $name", row => {
    const record = current(row.record());
    expect(inspectPortalProvenance(record)).toEqual({ portal: false, metadataUsable: false });
    record.source = "Zillow";
    expect(inspectPortalProvenance(record)).toEqual({ portal: true, metadataUsable: false });
  });
  it("revoked top-level records are explicitly unusable without throwing", async () => {
    const record = revoked();
    expect(inspectPortalProvenance(record)).toEqual({ portal: false, metadataUsable: false });
    expect(await portalEmailGate(ID, record)).toEqual({ allowed: false, reason: "PORTAL_PROVENANCE_UNUSABLE" });
    const freshRecord = Proxy.revocable(current(), {});
    fetchMock.mockResolvedValue({ ok: true, json: async () => {
      // Resolve while readable: promise assimilation itself reads `then`.
      // Revoke before the awaiting gate resumes so inspection receives the proxy.
      queueMicrotask(freshRecord.revoke);
      return freshRecord.proxy;
    } });
    expect(await portalEmailGate(ID)).toEqual({ allowed: false, reason: "PORTAL_FRESH_PERSON_UNUSABLE" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => current({ source: "Zillow" }) });
    expect(await portalEmailGate(ID, record)).toEqual({ allowed: false, reason: "PORTAL_SOURCE_EXCLUDED" });
  });
  it.each(["tags", "events", "provenance"])("unreadable %s index does not discard readable portal sibling", field => {
    const values = field === "tags" ? ["Referral", "Zillow"] : [{ source: "Referral" }, { source: "Zillow" }];
    Object.defineProperty(values, "0", { get() { throw new Error("SYNTHETIC_ARRAY_INDEX_UNREADABLE"); } });
    expect(inspectPortalProvenance({ [field]: values })).toEqual({ portal: true, metadataUsable: false });
  });
  it.each([
    { source: "Website", event: { source: "Zillow", eventSource: revoked() } },
    { tags: [revoked()], originalSource: { name: "Zillow" } },
    { originalSource: revoked(), events: [{ source: "Zillow" }] },
    { events: [{ source: "Zillow" }, revoked()] },
    { events: [revoked(), { source: "Zillow" }] },
  ])("portal in a different readable nested branch wins %#", async record => {
    expect(inspectPortalProvenance(record)).toEqual({ portal: true, metadataUsable: false });
    expect(await portalEmailGate(ID, record)).toEqual({ allowed: false, reason: "PORTAL_SOURCE_EXCLUDED" });
  });
  for (const location of ["fresh", "snapshot"] as const) {
    for (const knownPortal of [false, true]) {
      it.each(unreadableCases)(`gate ${location}, readable portal ${knownPortal}: $name`, async row => {
        const record = current({ ...row.record(), source: knownPortal ? "Zillow" : "Website" });
        fetchMock.mockResolvedValue({ ok: true, json: async () => location === "fresh" ? record : current() });
        expect(await portalEmailGate(ID, location === "snapshot" ? record : undefined)).toEqual({ allowed: false,
          reason: knownPortal ? "PORTAL_SOURCE_EXCLUDED" : location === "snapshot" ? "PORTAL_PROVENANCE_UNUSABLE" : "PORTAL_FRESH_PERSON_UNUSABLE" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      for (const path of ["direct", "follow-up"] as const) {
        it.each(unreadableCases)(`exported ${path} ${location}, readable portal ${knownPortal}: $name`, async row => {
          const record = current({ ...row.record(), source: knownPortal ? "Zillow" : "Website" });
          const provenance = location === "snapshot" ? record : { source: "Website" };
          fetchMock.mockResolvedValue({ ok: true, json: async () => location === "fresh" ? record : current() });
          const promise = path === "direct" ? sendEmail({ ...mail, personId: ID, provenance }) : sendLeadFollowUpEmail({ ...followUp, provenance });
          await expect(promise).rejects.toMatchObject({ reason: knownPortal ? "PORTAL_SOURCE_EXCLUDED"
            : location === "snapshot" ? "PORTAL_PROVENANCE_UNUSABLE" : "PORTAL_FRESH_PERSON_UNUSABLE" });
          expect(state.smtp).not.toHaveBeenCalled();
          expect(state.db).not.toHaveBeenCalled();
          expect(fetchMock).toHaveBeenCalledTimes(1);
          expect(fetchMock.mock.calls.every(([, opts]) => !opts?.method || opts.method === "GET")).toBe(true);
        });
      }
    }
  }
  it.each(unreadableCases)("fresh portal overrides unreadable nonportal snapshot: $name", async row => {
    const provenance = current(row.record());
    fetchMock.mockResolvedValue({ ok: true, json: async () => current({ source: "Zillow" }) });
    expect(await portalEmailGate(ID, provenance)).toEqual({ allowed: false, reason: "PORTAL_SOURCE_EXCLUDED" });
    await expect(sendEmail({ ...mail, personId: ID, provenance })).rejects.toMatchObject({ reason: "PORTAL_SOURCE_EXCLUDED" });
    await expect(sendLeadFollowUpEmail({ ...followUp, provenance })).rejects.toMatchObject({ reason: "PORTAL_SOURCE_EXCLUDED" });
    expect(state.smtp).not.toHaveBeenCalled(); expect(state.db).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([, opts]) => !opts?.method || opts.method === "GET")).toBe(true);
  });
});

describe("conservative sourceUrl is readable provenance, not navigation", () => {
  it.each(["https:zillow.com/lead", "https:/zillow.com/lead", "//www.realtor.com/lead", "www.zillow.com/lead", "https://zillow.com:bad/lead"])("user example %s is portal and usable", sourceUrl => {
    expect(inspectPortalUrl(sourceUrl)).toEqual({ portal: true, metadataUsable: true });
  });
  it.each(["https://zillow.com@example.invalid/lead", "https://example.invalid/zillow.com", "https://example.invalid/?host=zillow.com", "https://zillow.com.example.invalid/lead"])("negative authority control %s remains nonportal and usable", sourceUrl => {
    expect(inspectPortalUrl(sourceUrl)).toEqual({ portal: false, metadataUsable: true });
  });
  it.each(["/zillow.com", "https://zillow.com:443:bad", "https://[::1]:443:bad"])("relative or ambiguous authority %s explicitly defers", async sourceUrl => {
    const record = { source: "Website", sourceUrl };
    expect(inspectPortalUrl(sourceUrl)).toEqual({ portal: false, metadataUsable: false });
    expect(await portalEmailGate(ID, record)).toEqual({ allowed: false, reason: "PORTAL_PROVENANCE_UNUSABLE" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => current(record) });
    expect(await portalEmailGate(ID)).toEqual({ allowed: false, reason: "PORTAL_FRESH_PERSON_UNUSABLE" });
    expect(inspectPortalProvenance({ ...record, originalSource: "Zillow" })).toEqual({ portal: true, metadataUsable: false });
  });
  it.each(["https://", "https://zillow..com/lead", "https://%zz/lead", "https://%FF/lead", "unknown", false, {}, []])("unreadable nonblank URL %# defers but readable portal wins", sourceUrl => {
    expect(inspectPortalUrl(sourceUrl)).toEqual({ portal: false, metadataUsable: false });
    expect(inspectPortalProvenance({ source: "Website", sourceUrl })).toEqual({ portal: false, metadataUsable: false });
    expect(inspectPortalProvenance({ source: "Zillow", sourceUrl })).toEqual({ portal: true, metadataUsable: false });
  });
});

describe("named user regressions at exported final senders", () => {
  it.each(["direct", "follow-up"])("regression_a_trailing_dot_blocks_final_sender: %s", async path => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => current({ sourceUrl: "https://zillow.com./lead" }) });
    const promise = path === "direct" ? sendEmail({ ...mail, personId: ID }) : sendLeadFollowUpEmail(followUp);
    await expect(promise).rejects.toMatchObject({ reason: "PORTAL_SOURCE_EXCLUDED" });
    expect(state.smtp).not.toHaveBeenCalled(); expect(state.db).not.toHaveBeenCalled();
  });
  it("regression_b_local_realtor_committee_is_nonportal, including fallback", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    reloadSharedSuppressionTags();
    const person = current({ source: "Local Realtor Committee" });
    expect(hasPortalProvenance(person)).toBe(false); expect(isExcludedSource(person)).toBeNull();
    fetchMock.mockResolvedValue({ ok: true, json: async () => person });
    await sendEmail({ ...mail, personId: ID, provenance: person });
    await sendLeadFollowUpEmail({ ...followUp, provenance: person });
    expect(state.smtp).toHaveBeenCalledTimes(2);
  });
  it.each([{}, { internal: false }, { internal: undefined }, { internal: null }, { internal: "true" }, { internal: 1 }])("regression_c_missing_audience_context_fails_closed %#", async context => {
    await expect(sendEmail({ ...mail, ...context } as any)).rejects.toMatchObject({ reason: "PORTAL_PERSON_ID_UNRESOLVED" });
    expect(state.smtp).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("explicit internal true still sends unchanged without a FUB read", async () => {
    await sendEmail({ ...mail, internal: true });
    expect(state.smtp).toHaveBeenCalledTimes(1); expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["", " ", [], [""], null, undefined])("nurture_no_email_paths_skip_without_sent_bookkeeping: direct %#", async to => {
    await expect(sendEmail({ ...mail, to, personId: ID } as any)).rejects.toThrow("LEAD_EMAIL_ADDRESS_MISSING");
    expect(state.smtp).not.toHaveBeenCalled(); expect(state.db).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["", " ", null, undefined])("nurture_no_email_paths_skip_without_sent_bookkeeping: follow-up %#", async leadEmail => {
    await expect(sendLeadFollowUpEmail({ ...followUp, leadEmail } as any)).rejects.toThrow("LEAD_EMAIL_ADDRESS_MISSING");
    expect(state.smtp).not.toHaveBeenCalled(); expect(state.db).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("candidate 3 independent decoded-host closure", () => {
  it.each(["https://%09example.invalid/x", "https://ex%09ample.invalid/x", "https://%0Aexample.invalid/x"])("decoded controls are unusable and cannot hide readable portal evidence: %s", async sourceUrl => {
    const record = { source: "Website", sourceUrl };
    expect(inspectPortalProvenance(record)).toEqual({ portal: false, metadataUsable: false });
    const withPortal = { ...record, originalSource: { name: "Zillow" } };
    expect(inspectPortalProvenance(withPortal)).toEqual({ portal: true, metadataUsable: false });
    await expect(sendEmail({ ...mail, personId: ID, provenance: withPortal })).rejects.toMatchObject({ reason: "PORTAL_SOURCE_EXCLUDED" });
    expect(state.smtp).not.toHaveBeenCalled(); expect(state.db).not.toHaveBeenCalled();
  });
});
