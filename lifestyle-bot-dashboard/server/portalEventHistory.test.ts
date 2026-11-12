import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPortalEventHistoryPage, scanPortalEventHistory,
  PORTAL_HISTORY_HTTP_TIMEOUT_MS, type PortalHistoryLoader,
} from "./portalEventHistory";
import { inspectPortalProvenance } from "./portalProvenance";
const fixture = vi.hoisted(() => ({ smtp: vi.fn().mockResolvedValue({ messageId: "synthetic" }) }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: fixture.smtp }) } }));
vi.mock("./db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));
import { checkLeadEmailPortalGate, sendEmail, sendLeadFollowUpEmail } from "./botHelpers";
const personId = 990001;
const row = (id = 1, source: unknown = "Website Form", person: unknown = personId) => ({ id, personId: person, source });
const page = (events: unknown[] = [], total = events.length, metadata: Record<string, unknown> = {}) => ({
  events, _metadata: { collection: "events", total, ...metadata },
});
const hundred = (start = 1) => Array.from({ length: 100 }, (_, index) => row(start + index));
const response = (value: unknown) => ({ ok: true, status: 200, json: async () => value }) as Response;
const unavailable = { sent: false, reason: "PORTAL_HISTORY_UNAVAILABLE" };
const incomplete = { sent: false, reason: "PORTAL_HISTORY_INCOMPLETE" };
const options = {
  personId, provenance: { source: "Website Form", isZillowPACLead: false },
  agentEmail: "agent@example.invalid", agentFirstName: "Synthetic", agentLastName: "Agent",
  leadEmail: "fixture@gmail.com", leadFirstName: null, messageBody: "Synthetic", subject: "Synthetic",
};
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function scan(...pages: unknown[]) {
  const loader = vi.fn<PortalHistoryLoader>();
  pages.forEach(value => loader.mockResolvedValueOnce(value));
  const result = await scanPortalEventHistory(personId, loader);
  return { result, loader };
}
describe("bounded own-person history authorization", () => {
  it.each([page(), page([row()]), page([row(1, ""), row(2, null)]), page(hundred())])("complete terminal page allows %#", async value => {
    const { result, loader } = await scan(value);
    expect(result).toEqual({ sent: true, pages: 1, rows: value.events.length });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith({ personId, limit: 100 });
  });
  it.each(["Zillow", "prefix REALTOR® dot COM campaign", "Realtordotcom", "Zillow Rentals"])('only own event scalar source blocks: %s', async source => {
    const { result } = await scan(page([row(1, source)]));
    expect(result).toMatchObject({ sent: false, reason: "PORTAL_SOURCE" });
  });
  it("does not infer portal from native/contact/content/url/property/tag fields on history events", async () => {
    const { result } = await scan(page([{ ...row(), isZillowPACLead: true, sourceUrl: "https://zillow.com", tags: ["Zillow"], message: "Zillow", property: { source: "Zillow" } }]));
    expect(result.sent).toBe(true);
  });
  it.each([
    null, {}, { events: [] }, { events: null, _metadata: { collection: "events", total: 0 } },
    page([null]), page([[]]), page([{}]), page([{ id: 1, personId }]),
    page([{ ...row(), source: undefined }]), page([row(1, {})]), page([row(1, false)]),
    page([row(0)]), page([row(-1)]), page([row(1.5)]), page([row(Number.MAX_SAFE_INTEGER + 1)]),
    page([row(1, "Website", personId + 1)]), page([row(1, "Zillow", personId + 1)]),
    page([{ id: 1, source: "Zillow" }]), page([row(1, "Zillow", "990001")]),
    page([row(1, "Website", true)]), page([Object.create(row())]),
    page([], -1), page([], 0.5), page([], Number.MAX_SAFE_INTEGER + 1),
    { events: [], _metadata: { collection: "people", total: 0 } },
    { events: [], _metadata: { collection: "events" } },
    { events: [], _metadata: { collection: "events", total: "0" } },
    { events: [], _metadata: Object.create({ collection: "events", total: 0 }) },
    Object.create(page()),
  ])("malformed/missing/partial own history defers %#", async value => {
    const { result } = await scan(value);
    expect(result).toMatchObject(unavailable);
  });
  it.each(["truncated", "incomplete", "restricted", "hasMore"])('partial flags cannot authorize: %s', async key => {
    expect((await scan(page([], 0, { [key]: true }))).result).toMatchObject(incomplete);
    for (const value of ["true", undefined, null]) {
      expect((await scan(page([], 0, { [key]: value }))).result).toMatchObject(unavailable);
    }
    expect((await scan(page([], 0, { [key]: false }))).result.sent).toBe(true);
    expect((await scan({ ...page(), [key]: true })).result).toMatchObject(incomplete);
  });
  it("readable matching portal wins over bad identity/source siblings, repeated IDs and bad metadata", async () => {
    const value = { events: [null, row(2, "Zillow", personId + 1), row(1, "Website"), row(1, "Realtor.com"), row(0, "Zillow")], _metadata: null };
    const { result } = await scan(value);
    expect(result).toEqual({ sent: false, reason: "PORTAL_SOURCE", pages: 1, rows: 5 });
  });
  it("throwing row and metadata getters defer; later readable portal still wins", async () => {
    const event = Object.defineProperty(row(), "source", { get: () => { throw new Error("SYNTHETIC_PRIVATE"); } });
    const value = Object.defineProperty(page([event]), "_metadata", { get: () => { throw new Error("SYNTHETIC_PRIVATE"); } });
    expect((await scan(value)).result).toMatchObject(unavailable);
    value.events.push(row(2, "Zillow"));
    expect((await scan(value)).result).toMatchObject({ sent: false, reason: "PORTAL_SOURCE" });
    const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
    expect((await scan(page([proxy]))).result).toMatchObject(unavailable);
    expect((await scan(proxy)).result).toMatchObject(unavailable);
  });
  it("next cursor, safe nextLink and offset each preserve scope and complete terminal totals", async () => {
    for (const metadata of [
      { next: "cursor & synthetic" },
      { nextLink: `https://api.followupboss.com/v1/events?personId=${personId}&limit=100&next=cursor%20%26%20synthetic` },
      {},
    ]) {
      const { result, loader } = await scan(page(hundred(), 101, metadata), page([row(101)], 101));
      expect(result).toEqual({ sent: true, pages: 2, rows: 101 });
      expect(loader.mock.calls[1][0]).toEqual(metadata.next || metadata.nextLink
        ? { personId, limit: 100, next: "cursor & synthetic" } : { personId, limit: 100, offset: 100 });
    }
  });
  it("primary next cursor wins without navigating even an unsafe secondary nextLink", async () => {
    const { result, loader } = await scan(page([row()], 2, { next: "first", nextLink: "https://example.invalid" }), page([row(2)], 2));
    expect(result.sent).toBe(true); expect(loader.mock.calls[1][0]).toEqual({ personId, limit: 100, next: "first" });
  });
  it.each([null, "", " \t\n"])("no nonblank primary cursor %j honors valid nextLink and completes two ordinary pages", async next => {
    const nextLink = `https://api.followupboss.com/v1/events?personId=${personId}&limit=100&next=cursor%20%26%20synthetic`;
    const { result, loader } = await scan(page([row()], 2, { next, nextLink }), page([row(2)], 2));
    expect(result).toEqual({ sent: true, pages: 2, rows: 2 });
    expect(loader.mock.calls).toEqual([[{ personId, limit: 100 }], [{ personId, limit: 100, next: "cursor & synthetic" }]]);
  });
  it.each([null, "", " \t\n"])("valid nextLink with no nonblank primary %j contradicts an already satisfied terminal total", async next => {
    const nextLink = `https://api.followupboss.com/v1/events?personId=${personId}&limit=100&next=synthetic`;
    const { result, loader } = await scan(page([row()], 1, { next, nextLink }), page([row(2)], 2));
    expect(result).toEqual({ ...incomplete, pages: 1, rows: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith({ personId, limit: 100 });
  });
  it.each([{}, { next: null }, { next: "" }, { next: " \t\n" }])("whitespace-only nextLink is blank with no primary cursor %#", async primary => {
    for (const value of [page([], 0, { ...primary, nextLink: " \t\n" }), page([row()], 1, { ...primary, nextLink: " \t\n" })]) {
      const { result, loader } = await scan(value);
      expect(result).toEqual({ sent: true, pages: 1, rows: value.events.length });
      expect(loader).toHaveBeenCalledTimes(1);
    }
    const { result, loader } = await scan(page([row()], 2, { ...primary, nextLink: " \t\n" }));
    expect(result).toMatchObject(incomplete);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it.each([null, "", " \t\n"])("no nonblank primary %j cannot hide an unsafe secondary link", async next => {
    const { result, loader } = await scan(page([row()], 1, { next, nextLink: "https://example.invalid/v1/events?next=synthetic" }));
    expect(result).toEqual({ ...incomplete, pages: 1, rows: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it.each([
    `http://api.followupboss.com/v1/events?personId=${personId}&next=x`,
    `https://api.followupboss.com.evil.invalid/v1/events?personId=${personId}&next=x`,
    `https://api.followupboss.com/v1/people?personId=${personId}&next=x`,
    `https://api.followupboss.com/v1/events?personId=${personId + 1}&next=x`,
    `https://api.followupboss.com/v1/events?next=x`,
    `https://api.followupboss.com/v1/events?personId=${personId}&next=x&type=Inquiry`,
    `https://api.followupboss.com/v1/events?personId=${personId}&next=x&source=Website`,
    `https://api.followupboss.com/v1/events?personId=${personId}&next=x&limit=1`,
    `https://api.followupboss.com/v1/events?personId=${personId}&next=x&personId=${personId}`,
    `https://api.followupboss.com/v1/events?personId=${personId}&next=`,
    `https://api.followupboss.com/v1/events?personId=${personId}&next=x#hidden`,
    `https://user@api.followupboss.com/v1/events?personId=${personId}&next=x`,
    `https://api.followupboss.com/v1/a/../events?personId=${personId}&next=x`,
    `https://api.followupboss.com/v1/x/../events?personId=${personId}&next=x`,
    `https://api.followupboss.com/v1/events?personId=${personId}&next=%GG`,
    `https://api.followupboss.com/v1/events?personId=${personId}&next=%FF`,
    7, {}, undefined,
  ])("unsafe or malformed nextLink defers without second request %#", async nextLink => {
    const { result, loader } = await scan(page([row()], 2, { nextLink }));
    expect(result).toMatchObject(incomplete); expect(loader).toHaveBeenCalledTimes(1);
  });
  it("later portal page wins even if later total/duplicates/partial flags are corrupt", async () => {
    const { result } = await scan(page([row()], 2, { next: "synthetic" }), page([row(1, "Zillow"), {}], 9999, { restricted: true }));
    expect(result).toMatchObject({ sent: false, reason: "PORTAL_SOURCE", pages: 2 });
  });
  it("nonportal duplicate IDs, inconsistent total, repeated cursor and empty continuation defer", async () => {
    for (const second of [page([row()], 2), page([row(2)], 3), page([row(2)], 3, { next: "synthetic" }), page([], 2, { next: "other" })]) {
      expect((await scan(page([row()], 2, { next: "synthetic" }), second)).result).toMatchObject(incomplete);
    }
  });
  it("exactly 500 terminal rows allow, while page cap and total above 500 defer after bounded inspection", async () => {
    for (const total of [500, 501, 9000]) {
      const { result, loader } = await scan(...Array.from({ length: 5 }, (_, index) => page(hundred(index * 100 + 1), total)));
      expect(result).toMatchObject(total === 500 ? { sent: true, pages: 5, rows: 500 } : { ...incomplete, pages: 5, rows: 500 });
      expect(loader).toHaveBeenCalledTimes(5);
    }
    const values = Array.from({ length: 5 }, (_, index) => page(hundred(index * 100 + 1), 9000));
    values[4].events[99] = row(500, "Zillow");
    expect((await scan(...values)).result).toMatchObject({ sent: false, reason: "PORTAL_SOURCE", pages: 5 });
    expect((await scan(page(hundred(), 100, { next: "synthetic" }))).result).toMatchObject(incomplete);
  });
  it("missing loader and loader failures have only reason codes", async () => {
    expect(await scanPortalEventHistory(personId)).toMatchObject(unavailable);
    expect(await scanPortalEventHistory(personId, null)).toMatchObject(unavailable);
    const loader = vi.fn().mockRejectedValue(new Error("PRIVATE_IDENTIFIER_BODY_URL"));
    const result = await scanPortalEventHistory(personId, loader);
    expect(result).toEqual({ ...unavailable, pages: 1, rows: 0 }); expect(loader).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
});
describe("single-attempt email-only HTTP loading", () => {
  it("fixed GET endpoint, no filters/redirects, cursor encoded, offset fixed, timer cleaned", async () => {
    vi.useFakeTimers(); const mock = vi.fn().mockResolvedValue(response(page())); vi.stubGlobal("fetch", mock);
    await loadPortalEventHistoryPage({ personId, limit: 100, next: "synthetic & cursor" }, "synthetic-key");
    const [input, init] = mock.mock.calls[0]; const url = new URL(input);
    expect(url.origin + url.pathname).toBe("https://api.followupboss.com/v1/events");
    expect([...url.searchParams]).toEqual([["personId", String(personId)], ["limit", "100"], ["next", "synthetic & cursor"]]);
    expect(init).toMatchObject({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) });
    expect(vi.getTimerCount()).toBe(0);
    await loadPortalEventHistoryPage({ personId, limit: 100, offset: 100 }, "synthetic-key");
    expect(new URL(mock.mock.calls[1][0]).searchParams.get("offset")).toBe("100");
  });
  it.each([429, 500, 302])("HTTP %i fails once without inspecting body or retry", async status => {
    const json = vi.fn(); const mock = vi.fn().mockResolvedValue({ ok: false, status, json }); vi.stubGlobal("fetch", mock);
    expect(await scanPortalEventHistory(personId, request => loadPortalEventHistoryPage(request, "synthetic"))).toMatchObject(unavailable);
    expect(mock).toHaveBeenCalledTimes(1); expect(json).not.toHaveBeenCalled();
  });
  it("network error, redirect and invalid JSON fail closed with redacted errors", async () => {
    for (const value of [
      { ...response(page()), redirected: true },
      { ok: true, json: async () => { throw new Error("PRIVATE_JSON"); } },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(value));
      await expect(loadPortalEventHistoryPage({ personId, limit: 100 }, "synthetic")).rejects.toThrow("PORTAL_HISTORY_UNAVAILABLE");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("PRIVATE_HTTP")));
    await expect(loadPortalEventHistoryPage({ personId, limit: 100 }, "synthetic")).rejects.toThrow("PORTAL_HISTORY_UNAVAILABLE");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["http", "body"])("15 second abort remains active during %s", async phase => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      signal = init.signal;
      const waiting = () => new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("PRIVATE_TIMEOUT")), { once: true }));
      if (phase === "http") return waiting();
      return { ok: true, json: waiting };
    }));
    const promise = loadPortalEventHistoryPage({ personId, limit: 100 }, "synthetic");
    const assertion = expect(promise).rejects.toThrow("PORTAL_HISTORY_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(PORTAL_HISTORY_HTTP_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await assertion;
    expect(signal?.aborted).toBe(true); expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects an elapsed parse deadline even if body completed before timer callback", async () => {
    vi.useFakeTimers(); const started = Date.now();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => { vi.setSystemTime(started + 15_001); return page(); } }));
    await expect(loadPortalEventHistoryPage({ personId, limit: 100 }, "synthetic")).rejects.toThrow("PORTAL_HISTORY_UNAVAILABLE");
    expect(vi.getTimerCount()).toBe(0);
  });
});
describe("native-field and final actual transport boundaries", () => {
  it.each([false, null, "absent"])("native %s requires fresh complete history, not a nonportal inference", async native => {
    const current: any = { id: personId, source: "Website Form" }; if (native !== "absent") current.isZillowPACLead = native;
    vi.stubGlobal("fetch", vi.fn(async input => response(String(input).includes("/events?") ? page([row()]) : current)));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: true });
    expect(fetch).toHaveBeenCalledTimes(2); expect(fixture.smtp).toHaveBeenCalledTimes(1);
  });
  it("fresh native change false to true blocks reviewer Website Form with zero history reads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ id: personId, source: "Website Form", isZillowPACLead: true })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(fetch).toHaveBeenCalledTimes(1); expect(fixture.smtp).not.toHaveBeenCalled();
  });
  it.each([undefined, "true", "false", 0, 1, [], {}, Object.create(null)])("unusable own native type blocks before history %#", async native => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ id: personId, source: "Website Form", isZillowPACLead: native })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" });
    expect(fetch).toHaveBeenCalledTimes(1); expect(fixture.smtp).not.toHaveBeenCalled();
    expect(inspectPortalProvenance({ source: "Zillow", isZillowPACLead: native })).toEqual({ portal: true, metadataUsable: false });
  });
  it("throwing accessor/revoked native value are unreadable, but readable portal sibling wins", async () => {
    const getter = Object.defineProperty({ id: personId, source: "Website" }, "isZillowPACLead", { get: () => { throw new Error("SYNTHETIC_PRIVATE"); } });
    const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
    for (const current of [getter, { id: personId, source: "Website", isZillowPACLead: proxy }]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(current)));
      expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" });
      expect(fetch).toHaveBeenCalledTimes(1); expect(fixture.smtp).not.toHaveBeenCalled();
      expect(inspectPortalProvenance({ source: "Zillow", original: current })).toEqual({ portal: true, metadataUsable: false });
    }
    expect(inspectPortalProvenance(Object.create({ isZillowPACLead: true }))).toEqual({ portal: false, metadataUsable: true });
    expect(inspectPortalProvenance({ originalSource: { name: "Website", isZillowPACLead: true } })).toEqual({ portal: false, metadataUsable: true });
    expect(inspectPortalProvenance({ isZillowPACLead: true, source: {} })).toEqual({ portal: true, metadataUsable: false });
  });
  it("every otherwise-allowed attempt loads uncached history; historical portal then failure refuse SMTP", async () => {
    const histories = [page([row(1, "Zillow")]), null, page()];
    vi.stubGlobal("fetch", vi.fn(async input => response(String(input).includes("/events?") ? histories.shift() : { id: personId, source: "Website" })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(fixture.smtp).not.toHaveBeenCalled();
    expect(await sendLeadFollowUpEmail(options)).toEqual(unavailable); expect(fixture.smtp).not.toHaveBeenCalled();
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: true });
    expect(fetch).toHaveBeenCalledTimes(6); expect(fixture.smtp).toHaveBeenCalledTimes(1);
  });
  it("null injectable loader explicitly defers and internal mail does not load history", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ id: personId, source: "Website" })));
    expect(await checkLeadEmailPortalGate(personId, options.provenance, null)).toEqual(unavailable);
    expect(fetch).toHaveBeenCalledTimes(1); expect(fixture.smtp).not.toHaveBeenCalled();
    vi.mocked(fetch).mockClear();
    expect(await sendEmail({ kind: "internal", to: "internal@example.invalid", subject: "Synthetic", html: "Synthetic" })).toEqual({ sent: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("independent reviewer API-visible boundaries", () => {
  it("never reads event free-form fields, even poisoned getters, and ignores event type metadata", async () => {
    const getters = vi.fn(() => { throw new Error("SYNTHETIC_POISONED_CONTENT"); });
    const event: Record<string, unknown> = { ...row(), type: "Synthetic inquiry" };
    for (const key of ["message", "description", "note", "pageTitle", "pageUrl", "body", "property", "sourceUrl", "tags", "isZillowPACLead"]) {
      Object.defineProperty(event, key, { enumerable: true, get: getters });
    }
    vi.stubGlobal("fetch", vi.fn(async input => response(String(input).includes("/events?") ? page([event]) : { id: personId, source: "Website Form" })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: true });
    expect(getters).not.toHaveBeenCalled(); expect(fixture.smtp).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("portal words only in message/description/note/page fields do not exclude an explicit ordinary source", async () => {
    const event = { ...row(), message: "Zillow Realtor.com", description: "Realtor.com", note: "Zillow", pageTitle: "Zillow", pageUrl: "https://realtor.com/synthetic" };
    vi.stubGlobal("fetch", vi.fn(async input => response(String(input).includes("/events?") ? page([event]) : { id: personId, source: "Website Form" })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: true }); expect(fixture.smtp).toHaveBeenCalledTimes(1);
  });
  it("missing next terminates only under consistent exact API-visible total validation", async () => {
    const { result, loader } = await scan(page([row()], 1));
    expect(result.sent).toBe(true); expect(loader).toHaveBeenCalledTimes(1);
    expect((await scan(page([row()], 2))).result).toMatchObject(incomplete);
  });
  it.each([{ cursors: ["a", "a"] }, { cursors: ["a", "b", "a"] }])("repeated/cyclic next defers with otherwise valid unique rows and constant total %#", async ({ cursors }) => {
    const { result, loader } = await scan(...cursors.map((next, index) => page([row(index + 1)], 10, { next })));
    expect(result).toMatchObject(incomplete); expect(loader).toHaveBeenCalledTimes(cursors.length);
  });
  it("page cap with cursor continuation defers at five pages even when total is exactly the rows read", async () => {
    const { result, loader } = await scan(...Array.from({ length: 5 }, (_, index) => page(hundred(index * 100 + 1), 500, { next: `synthetic-${index}` })));
    expect(result).toEqual({ ...incomplete, pages: 5, rows: 500 }); expect(loader).toHaveBeenCalledTimes(5);
  });
  it("more than requested page rows cannot authorize an ordinary history", async () => {
    const { result, loader } = await scan(page([...hundred(), row(101)], 101));
    expect(result).toMatchObject(incomplete); expect(loader).toHaveBeenCalledTimes(1);
  });
  it("clean first send does not cache a negative history: fresh again and portal history block second send", async () => {
    let historyReads = 0; let freshReads = 0;
    vi.stubGlobal("fetch", vi.fn(async input => {
      if (String(input).includes("/events?")) return response(++historyReads === 1 ? page() : page([row(1, "Zillow")]));
      freshReads++; return response({ id: personId, source: "Website Form", isZillowPACLead: false });
    }));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: true }); expect(fixture.smtp).toHaveBeenCalledTimes(1);
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
    expect(historyReads).toBe(2); expect(freshReads).toBe(2); expect(fetch).toHaveBeenCalledTimes(4); expect(fixture.smtp).toHaveBeenCalledTimes(1);
  });
  it.each(["http-500", "429-with-retry-after", "429-without-retry-after", "network-exception", "non-json", "missing-array", "wrong-events-type", "missing-event-source", "cross-person", "missing-person"])(
    "actual transport gate distinct $0 history failure defers with zero SMTP and a single history attempt", async failure => {
      let historyReads = 0;
      vi.stubGlobal("fetch", vi.fn(async input => {
        if (!String(input).includes("/events?")) return response({ id: personId, source: "Website Form" });
        historyReads++;
        if (failure === "network-exception") throw new Error("SYNTHETIC_NETWORK_EXCEPTION");
        if (failure === "http-500" || failure.startsWith("429-")) return {
          ok: false, status: failure === "http-500" ? 500 : 429,
          headers: new Headers(failure === "429-with-retry-after" ? { "Retry-After": "120" } : {}),
        } as Response;
        if (failure === "non-json") return { ok: true, json: async () => { throw new SyntaxError("SYNTHETIC_NON_JSON"); } } as unknown as Response;
        if (failure === "missing-array") return response({ _metadata: { collection: "events", total: 0 } });
        if (failure === "wrong-events-type") return response({ events: {}, _metadata: { collection: "events", total: 0 } });
        if (failure === "missing-event-source") return response(page([{ id: 1, personId }]));
        if (failure === "missing-person") return response(page([{ id: 1, source: "Zillow" }]));
        return response(page([row(1, "Zillow", personId + 1)]));
      }));
      expect(await sendLeadFollowUpEmail(options)).toEqual(unavailable);
      expect(historyReads).toBe(1); expect(fetch).toHaveBeenCalledTimes(2); expect(fixture.smtp).not.toHaveBeenCalled();
    },
  );
  it("actual final gate history timeout aborts body and defers with zero SMTP", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (!String(input).includes("/events?")) return response({ id: personId, source: "Website Form" });
      return { ok: true, json: () => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("SYNTHETIC_TIMEOUT")), { once: true })) } as unknown as Response;
    }));
    const delivery = sendLeadFollowUpEmail(options);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await delivery).toEqual(unavailable); expect(fetch).toHaveBeenCalledTimes(2); expect(fixture.smtp).not.toHaveBeenCalled();
  });
  it.each([false, null, "absent"])("native %s alone is not permission when history fails", async native => {
    const current: Record<string, unknown> = { id: personId, source: "Website Form" }; if (native !== "absent") current.isZillowPACLead = native;
    vi.stubGlobal("fetch", vi.fn(async input => response(String(input).includes("/events?") ? null : current)));
    expect(await sendLeadFollowUpEmail(options)).toEqual(unavailable); expect(fetch).toHaveBeenCalledTimes(2); expect(fixture.smtp).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -1, 1.5, "", Symbol("synthetic"), BigInt(1), () => true, new Boolean(true), new Date(0)])("every other explicit native type is unreadable without coercion %#", async native => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ id: personId, source: "Website Form", isZillowPACLead: native })));
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: false, reason: "PORTAL_PERSON_UNAVAILABLE" });
    expect(fetch).toHaveBeenCalledTimes(1); expect(fixture.smtp).not.toHaveBeenCalled();
  });
});

describe("explicit incomplete pagination reason", () => {
  it.each([
    page([row()], 0), page([], 1), page([row()], 2), page([row(), row()]),
    page([], 0, { next: false }), page([], 0, { next: undefined }),
    page([], 0, { next: "cursor" }), page([], 1, { next: "cursor" }),
    page([], 0, { nextLink: "https://example.invalid/v1/events?next=x" }),
    page(hundred(), 100, { next: "synthetic" }),
    page(hundred(), 9000, { truncated: true }),
  ])("partial or contradictory pagination is explicitly incomplete %#", async value => {
    const { result } = await scan(value);
    expect(result).toMatchObject(incomplete);
  });
});
