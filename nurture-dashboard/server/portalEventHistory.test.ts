import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanPortalEventHistory, loadPortalEventPage, type PortalHistoryLoader } from "./portalEventHistory";
import { inspectPortalProvenance, portalEmailGate, sourceMatches } from "./portalEmailGate";

const ID = 940001;
const event = (id = 1, extra: Record<string, unknown> = {}) => ({ id, personId: ID, source: "Website Form", ...extra });
const page = (events: unknown[] = [], meta: Record<string, unknown> = {}) => ({ events, _metadata: { collection: "events", total: events.length, ...meta } });
const full = (start = 1) => Array.from({ length: 100 }, (_, index) => event(start + index));
const scan = (loader: PortalHistoryLoader | null | undefined) => scanPortalEventHistory(ID, loader, sourceMatches);
const incomplete = { allowed: false, reason: "PORTAL_HISTORY_INCOMPLETE" };
const unavailable = { allowed: false, reason: "PORTAL_HISTORY_UNAVAILABLE" };
const portal = { allowed: false, reason: "PORTAL_SOURCE_EXCLUDED" };
const revoked = (value: object = {}) => { const proxy = Proxy.revocable(value, {}); proxy.revoke(); return proxy.proxy; };
function throwing(value: object, field: string) { Object.defineProperty(value, field, { get() { throw new Error("SYNTHETIC_UNREADABLE"); } }); return value; }

beforeEach(() => { vi.stubEnv("FUB_API_KEY", "synthetic-key-940001"); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("email-only bounded own-person event history", () => {
  it.each([[], [event()], full()].map(events => ({ events })))("valid complete terminal history %# authorizes", async ({ events }) => {
    const loader = vi.fn().mockResolvedValue(page(events));
    expect(await scan(loader)).toEqual({ allowed: true, pages: 1, rows: events.length });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith({ personId: ID, limit: 100 });
  });
  it.each(["Zillow", "REALTOR® . COM", "Realtor dot com", "fixture / Zillow campaign"])("own historical %s excludes behind current Website Form", async source => {
    expect(await scan(vi.fn().mockResolvedValue(page([event(1, { source })])))).toMatchObject(portal);
  });
  it("uses scalar source only, never reads event native, URLs, tags, properties or message", async () => {
    const row = event();
    for (const field of ["isZillowPACLead", "sourceUrl", "tags", "properties", "message", "description", "note", "pageTitle", "pageUrl", "type", "originalSource", "leadSource"]) throwing(row, field);
    expect(await scan(vi.fn().mockResolvedValue(page([row])))).toMatchObject({ allowed: true });
  });
  it.each([null, "", "Realtor referral", "Local Realtor Committee", "Homes.com", "Opcity"])("nonportal scalar source %# remains valid", async source => {
    expect(await scan(vi.fn().mockResolvedValue(page([event(1, { source })])))).toMatchObject({ allowed: true });
  });
  it.each([null, [], {}, { events: null }, { events: {} }, { events: [] }, page([], { collection: "people" }),
    page([], { total: null }), page([], { total: "0" }), page([], { total: -1 }), page([], { total: 0.5 }),
    page([], { total: Number.MAX_SAFE_INTEGER + 1 }), page([event()], { total: 0 }),
    { events: [], _metadata: Object.create({ collection: "events", total: 0 }) },
    Object.create(page()), page([], { next: false }), page([], { next: {} }), page([], { next: undefined }),
    page([], { nextLink: [] }), page([], { nextLink: undefined }),
  ])("malformed collection/pagination %# explicitly defers", async value => {
    expect(await scan(vi.fn().mockResolvedValue(value))).toMatchObject(incomplete);
  });
  const malformedRows = [null, [], {}, event(1, { id: undefined }), event(1, { id: "1" }), event(1, { id: true }),
    event(1, { id: 0 }), event(1, { id: -1 }), event(1, { id: 1.5 }), event(1, { id: Number.MAX_SAFE_INTEGER + 1 }),
    event(1, { personId: "940001" }), event(1, { personId: true }), event(1, { personId: ID + 1 }),
    event(1, { personId: undefined }), event(1, { source: undefined }), event(1, { source: {} }), event(1, { source: ["Zillow"] }),
    event(1, { source: false }), Object.create(event())];
  it.each(malformedRows.map(row => ({ row })))("malformed event %# cannot authorize", async ({ row }) => {
    expect(await scan(vi.fn().mockResolvedValue(page([row])))).toMatchObject(incomplete);
  });
  it.each(malformedRows.map(row => ({ row })))("readable matched portal wins over malformed sibling %# and metadata", async ({ row }) => {
    expect(await scan(vi.fn().mockResolvedValue({ events: [row, event(2, { source: "Zillow" })], _metadata: null }))).toMatchObject(portal);
  });
  it("cross-person portal cannot supply evidence for requested lead", async () => {
    expect(await scan(vi.fn().mockResolvedValue(page([event(1, { personId: ID + 1, source: "Zillow" })])))).toMatchObject(incomplete);
  });
  it("matching-person portal wins even if its id is malformed", async () => {
    expect(await scan(vi.fn().mockResolvedValue(page([event(1, { id: undefined, source: "Zillow" })])))).toMatchObject(portal);
  });
  it.each(["id", "personId", "source"])("throwing event %s defers, portal sibling still wins", async field => {
    const row = throwing(event(), field);
    expect(await scan(vi.fn().mockResolvedValue(page([row])))).toMatchObject(incomplete);
    expect(await scan(vi.fn().mockResolvedValue(page([row, event(2, { source: "Zillow" })])))).toMatchObject(portal);
  });
  it("revoked event and array-index failures cannot hide readable portal sibling", async () => {
    const rows = [event(), event(2, { source: "Zillow" }), revoked()]; throwing(rows, "0");
    expect(await scan(vi.fn().mockResolvedValue(page(rows)))).toMatchObject(portal);
    expect(await scan(vi.fn().mockResolvedValue(page([revoked()])))).toMatchObject(incomplete);
  });
  it.each(["_metadata", "events"])("throwing page %s defers safely", async field => {
    expect(await scan(vi.fn().mockResolvedValue(throwing(page(), field)))).toMatchObject(incomplete);
  });
  it("throwing metadata cannot hide portal rows", async () => {
    expect(await scan(vi.fn().mockResolvedValue(throwing(page([event(1, { source: "Realtor.com" })]), "_metadata")))).toMatchObject(portal);
  });
  it.each(["collection", "total", "next", "nextLink", "restricted"])("throwing metadata %s defers", async field => {
    const value = page(); throwing(value._metadata, field);
    expect(await scan(vi.fn().mockResolvedValue(value))).toMatchObject(incomplete);
  });
  it.each(["truncated", "incomplete", "restricted", "hasMore"])("true terminal partial flag %s defers at page and metadata levels", async flag => {
    for (const location of ["page", "metadata"]) {
      const value = page(); (location === "page" ? value : value._metadata as any)[flag] = true;
      expect(await scan(vi.fn().mockResolvedValue(value))).toMatchObject(incomplete);
    }
  });
  it.each(["truncated", "incomplete", "restricted", "hasMore"])("malformed partial flag %s defers", async flag => {
    expect(await scan(vi.fn().mockResolvedValue(page([], { [flag]: "false" })))).toMatchObject(incomplete);
  });
  it.each(["truncated", "incomplete", "restricted", "hasMore"])("null partial flag %s stays unusable at page and metadata levels", async flag => {
    for (const location of ["page", "metadata"]) {
      const value = page(); (location === "page" ? value : value._metadata as any)[flag] = null;
      expect(await scan(vi.fn().mockResolvedValue(value))).toMatchObject(incomplete);
    }
  });
  it("next cursor reads later portal despite malformed terminal metadata", async () => {
    const loader = vi.fn().mockResolvedValueOnce(page([event()], { total: 2, next: "fixture-next" }))
      .mockResolvedValueOnce(page([event(2, { source: "Zillow" })], { total: -1 }));
    expect(await scan(loader)).toMatchObject({ ...portal, pages: 2 });
    expect(loader.mock.calls[1][0]).toEqual({ personId: ID, limit: 100, next: "fixture-next" });
  });
  it("cursor takes precedence over unrelated nextLink and allows short continuing pages", async () => {
    const loader = vi.fn().mockResolvedValueOnce(page([event()], { total: 2, next: "fixture-next", nextLink: "http://unsafe.invalid/" }))
      .mockResolvedValueOnce(page([event(2)], { total: 2, next: null }));
    expect(await scan(loader)).toEqual({ allowed: true, pages: 2, rows: 2 });
  });
  it("official scoped nextLink extracts cursor without navigating the link", async () => {
    const loader = vi.fn().mockResolvedValueOnce(page([event()], { total: 2, nextLink: `https://api.followupboss.com/v1/events?personId=${ID}&limit=100&next=fixture%2Bcursor` }))
      .mockResolvedValueOnce(page([event(2)], { total: 2 }));
    expect(await scan(loader)).toMatchObject({ allowed: true, pages: 2 });
    expect(loader.mock.calls[1][0]).toEqual({ personId: ID, limit: 100, next: "fixture+cursor" });
  });
  it.each([
    { encoded: "fixture%2Bcursor", decoded: "fixture+cursor" },
    { encoded: "fixture+cursor", decoded: "fixture cursor" },
    { encoded: "%E2%9C%93%F0%9F%94%91", decoded: "\u2713\ud83d\udd11" },
    { encoded: "%252F%26%3D%23%25", decoded: "%2F&=#%" },
  ])("valid nextLink cursor $encoded decodes faithfully without query/navigation expansion", async ({ encoded, decoded }) => {
    const loader = vi.fn().mockResolvedValueOnce(page([event()], { total: 2, nextLink: `https://api.followupboss.com/v1/events?personId=${ID}&limit=100&next=${encoded}` }))
      .mockResolvedValueOnce(page([event(2)], { total: 2 }));
    expect(await scan(loader)).toEqual({ allowed: true, pages: 2, rows: 2 });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls.map(([request]) => request)).toEqual([{ personId: ID, limit: 100 }, { personId: ID, limit: 100, next: decoded }]);
  });
  it.each(["%GG", "%FF", "%", "%2", "%C3%28", "%E2%82", "%C0%AF", "%ED%A0%80", "%F4%90%80%80"])("malformed percent/UTF-8 nextLink cursor %s refuses before a prepared clean second page", async encoded => {
    const loader = vi.fn().mockResolvedValueOnce(page([event()], { total: 2, nextLink: `https://api.followupboss.com/v1/events?personId=${ID}&limit=100&next=${encoded}` }))
      .mockResolvedValueOnce(page([event(2)], { total: 2 }));
    expect(await scan(loader)).toEqual({ ...incomplete, pages: 1, rows: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith({ personId: ID, limit: 100 });
  });
  it.each(["person%GGId", "%FF", "%C3%28"])("malformed encoded query key %s refuses before forgiving query parsing", async key => {
    const loader = vi.fn().mockResolvedValueOnce(page([event()], { total: 2, nextLink: `https://api.followupboss.com/v1/events?${key}=${ID}&next=x` }))
      .mockResolvedValueOnce(page([event(2)], { total: 2 }));
    expect(await scan(loader)).toEqual({ ...incomplete, pages: 1, rows: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it.each([
    `http://api.followupboss.com/v1/events?personId=${ID}&next=x`,
    `https://unsafe.invalid/v1/events?personId=${ID}&next=x`,
    `https://api.followupboss.com/v1/people?personId=${ID}&next=x`,
    `https://api.followupboss.com/v1/events?personId=${ID + 1}&next=x`,
    "https://api.followupboss.com/v1/events?next=x",
    `https://api.followupboss.com/v1/events?personId=${ID}&next=x&limit=10`,
    `https://api.followupboss.com/v1/events?personId=${ID}&next=x&type=Inquiry`,
    `https://api.followupboss.com/v1/events?personId=${ID}&next=x&source=Zillow`,
    `https://api.followupboss.com/v1/events?personId=${ID}&next=x&offset=100`,
    `https://api.followupboss.com/v1/events?personId=${ID}&next=x&next=y`,
    `https://api.followupboss.com/v1/events?personId=${ID}&next=x#fragment`,
    `https://user@api.followupboss.com/v1/events?personId=${ID}&next=x`,
    `https://api.followupboss.com:444/v1/events?personId=${ID}&next=x`,
    `https://api.followupboss.com:443/v1/events?personId=${ID}&next=x`,
    `https://api.followupboss.com/v1/x/../events?personId=${ID}&next=x`,
    `https://api.followupboss.com/v1/./events?personId=${ID}&next=x`,
    `https://api.followupboss.com/v1/x/%2e%2e/events?personId=${ID}&next=x`,
    `https://api.followupboss.com\\v1\\events?personId=${ID}&next=x`,
    `https://API.FOLLOWUPBOSS.COM/v1/events?personId=${ID}&next=x`,
    `https://api.followupboss.com/v1/events?personId=${ID}&next=`, "not-a-link",
  ])("unsafe/unscoped/filtered nextLink %s defers without another read", async nextLink => {
    const loader = vi.fn().mockResolvedValueOnce(page([event()], { total: 2, nextLink }))
      .mockResolvedValueOnce(page([event(2)], { total: 2 }));
    expect(await scan(loader)).toEqual({ ...incomplete, pages: 1, rows: 1 }); expect(loader).toHaveBeenCalledTimes(1);
  });
  it("uses offset fallback only when page is full and total remains outstanding", async () => {
    const loader = vi.fn().mockResolvedValueOnce(page(full(), { total: 101 }))
      .mockResolvedValueOnce(page([event(101)], { total: 101 }));
    expect(await scan(loader)).toEqual({ allowed: true, pages: 2, rows: 101 });
    expect(loader.mock.calls[1][0]).toEqual({ personId: ID, limit: 100, offset: 100 });
  });
  it.each([page([event()], { total: 2 }), page([], { total: 1 }), page([], { total: 1, next: "x" }),
    page([event()], { total: 1, next: "x" }), page([event(), event()], { total: 2 })])("incomplete/empty/contradictory/duplicate history %# defers", async value => {
    expect(await scan(vi.fn().mockResolvedValue(value))).toMatchObject(incomplete);
  });
  it("total must remain consistent across pages", async () => {
    const loader = vi.fn().mockResolvedValueOnce(page([event()], { total: 2, next: "x" }))
      .mockResolvedValueOnce(page([event(2)], { total: 3 }));
    expect(await scan(loader)).toMatchObject(incomplete);
  });
  it("repeated cursor defers after inspecting its page", async () => {
    const loader = vi.fn().mockResolvedValueOnce(page([event()], { total: 3, next: "x" }))
      .mockResolvedValueOnce(page([event(2)], { total: 3, next: "x" }));
    expect(await scan(loader)).toMatchObject(incomplete); expect(loader).toHaveBeenCalledTimes(2);
  });
  it("duplicate across pages defers, but duplicate portal on same page wins", async () => {
    const loader = vi.fn().mockResolvedValueOnce(page([event()], { total: 2, next: "x" }))
      .mockResolvedValueOnce(page([event()], { total: 2 }));
    expect(await scan(loader)).toMatchObject(incomplete);
    loader.mockReset().mockResolvedValueOnce(page([event()], { total: 2, next: "x" }))
      .mockResolvedValueOnce(page([event(1, { source: "Zillow" })], { total: 2 }));
    expect(await scan(loader)).toMatchObject(portal);
  });
  it("five full pages authorize exactly 500 events, not 501", async () => {
    for (const total of [500, 501]) {
      const loader = vi.fn().mockImplementation(async request => page(full((request.offset ?? 0) + 1), { total }));
      expect(await scan(loader)).toMatchObject(total === 500 ? { allowed: true, pages: 5, rows: 500 } : { ...incomplete, pages: 5, rows: 500 });
      expect(loader).toHaveBeenCalledTimes(5);
    }
  });
  it("portal on fifth page wins despite over-cap total", async () => {
    const loader = vi.fn().mockImplementation(async request => {
      const rows = full((request.offset ?? 0) + 1);
      if (request.offset === 400) rows[99].source = "Zillow";
      return page(rows, { total: 999 });
    });
    expect(await scan(loader)).toMatchObject({ ...portal, pages: 5 });
  });
  it.each([null, undefined])("missing loader %# never authorizes", async loader => { expect(await scan(loader)).toMatchObject(unavailable); });
  it("loader failure is explicit, single-attempt and retains no negative cache", async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error("SYNTHETIC_FAILURE")).mockResolvedValueOnce(page());
    expect(await scan(loader)).toMatchObject(unavailable); expect(loader).toHaveBeenCalledTimes(1);
    expect(await scan(loader)).toMatchObject({ allowed: true }); expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("HTTP reader is restricted and single-attempt", () => {
  it("fixed scope/limit, cursor encoding, redirect error and active JSON abort", async () => {
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      signal = options.signal;
      return { ok: true, json: async () => { expect(signal!.aborted).toBe(false); return page(); } };
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadPortalEventPage({ personId: ID, limit: 100, next: "fixture + &" })).resolves.toEqual(page());
    const [url, options] = fetchMock.mock.calls[0];
    expect(new URL(url).searchParams.get("personId")).toBe(String(ID));
    expect(new URL(url).searchParams.get("limit")).toBe("100");
    expect(new URL(url).searchParams.get("next")).toBe("fixture + &");
    expect([...new URL(url).searchParams.keys()]).toEqual(["personId", "limit", "next"]);
    expect(options.method).toBe("GET"); expect(options.redirect).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([400, 403, 429, 500])("HTTP %i defers without retry or reading error body", async status => {
    const body = vi.fn(); const fetchMock = vi.fn().mockResolvedValue({ ok: false, status, json: body, text: body });
    vi.stubGlobal("fetch", fetchMock);
    expect(await scan(loadPortalEventPage)).toMatchObject(unavailable);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(body).not.toHaveBeenCalled();
  });
  it("invalid JSON defers without exception/body logging", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError("SYNTHETIC_JSON"); } });
    vi.stubGlobal("fetch", fetchMock);
    const errorLog = vi.spyOn(console, "error");
    expect(await scan(loadPortalEventPage)).toMatchObject(unavailable);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(errorLog).not.toHaveBeenCalled();
  });
  it.each(["headers", "json"])("15-second abort stays active during %s", async stage => {
    vi.useFakeTimers();
    let signal: AbortSignal;
    const pending = (value: AbortSignal) => new Promise<never>((_resolve, reject) => value.addEventListener("abort", () => reject(new Error("SYNTHETIC_ABORT")), { once: true }));
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      signal = options.signal;
      if (stage === "headers") return pending(signal);
      return { ok: true, json: () => pending(signal) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = scan(loadPortalEventPage);
    await vi.advanceTimersByTimeAsync(14_999); expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(signal!.aborted).toBe(true);
    expect(await result).toMatchObject(unavailable); expect(fetchMock).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("JSON resolving after abort still cannot authorize", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(resolve => setTimeout(() => resolve(page()), 15_001)) }));
    const result = scan(loadPortalEventPage); await vi.advanceTimersByTimeAsync(15_001);
    expect(await result).toMatchObject(unavailable);
  });
});

describe("native exact own boolean and final gate ordering", () => {
  it.each([false, null, undefined, "true", "false", 0, 1, [], {}].map(value => ({ value })))("native explicit %# remains nonportal with strict usable shape", ({ value }) => {
    expect(inspectPortalProvenance({ source: "Website", isZillowPACLead: value })).toEqual({ portal: false, metadataUsable: value === false || value === null });
  });
  it("revoked native value is unusable without throwing", () => {
    expect(inspectPortalProvenance({ source: "Website", isZillowPACLead: revoked() })).toEqual({ portal: false, metadataUsable: false });
  });
  it("inherited flag is absent, source aliases do not expand whitelist", () => {
    const person = Object.assign(Object.create({ isZillowPACLead: true }), { source: "Website" });
    expect(inspectPortalProvenance(person)).toEqual({ portal: false, metadataUsable: true });
    expect(inspectPortalProvenance({ originalSource: { name: "Referral", isZillowPACLead: true } })).toEqual({ portal: false, metadataUsable: true });
  });
  it("throwing native field defers, portal sibling wins", () => {
    const person = throwing({ source: "Website" }, "isZillowPACLead");
    expect(inspectPortalProvenance(person)).toEqual({ portal: false, metadataUsable: false });
    (person as any).source = "Zillow";
    expect(inspectPortalProvenance(person)).toEqual({ portal: true, metadataUsable: false });
  });
  it("fresh native false to true change blocks before history even for Gmail Website Form", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: ID, source: "Website Form", isZillowPACLead: true, emails: [{ value: "fixture@gmail.com" }] }) });
    vi.stubGlobal("fetch", fetchMock); const history = vi.fn().mockResolvedValue(page());
    expect(await portalEmailGate(ID, { source: "Website Form", isZillowPACLead: false }, history)).toEqual(portal);
    expect(history).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("otherwise valid gate with omitted implementation explicitly defers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: ID, source: "Website Form" }) }));
    expect(await portalEmailGate(ID, undefined, null)).toEqual(unavailable);
  });
  it("current unreadable and original malformed defer before history; portal still wins", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); const history = vi.fn();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: ID, source: [] }) });
    expect(await portalEmailGate(ID, undefined, history)).toMatchObject({ reason: "PORTAL_FRESH_PERSON_UNUSABLE" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: ID, source: "Website Form" }) });
    expect(await portalEmailGate(ID, { isZillowPACLead: undefined }, history)).toMatchObject({ reason: "PORTAL_PROVENANCE_UNUSABLE" });
    expect(history).not.toHaveBeenCalled();
  });
});


describe("reviewer explicit native/null policy and separate failure cases", () => {
  it.each([NaN, Infinity, -1, 0.5, 2, () => true, Symbol("synthetic"), BigInt(1)].map(value => ({ value })))("every additional explicit native type %# is unusable", ({ value }) => {
    expect(inspectPortalProvenance({ source: "Website", isZillowPACLead: value })).toEqual({ portal: false, metadataUsable: false });
    expect(inspectPortalProvenance({ source: "Zillow", isZillowPACLead: value })).toEqual({ portal: true, metadataUsable: false });
  });
  it.each([false, null, "absent"])("native %# is not evidence, but complete history is still required even with null current source", async flag => {
    const person = { id: ID, source: null, ...(flag === "absent" ? {} : { isZillowPACLead: flag }) };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => person }); vi.stubGlobal("fetch", fetchMock);
    const history = vi.fn().mockResolvedValue(page());
    expect(await portalEmailGate(ID, undefined, history)).toEqual({ allowed: true }); expect(history).toHaveBeenCalledTimes(1);
    history.mockResolvedValue(page([event(1, { source: "Zillow" })]));
    expect(await portalEmailGate(ID, undefined, history)).toEqual(portal); expect(history).toHaveBeenCalledTimes(2); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([null, "5"])("429 with Retry-After %# has one attempt and no backoff", async retryAfter => {
    vi.useFakeTimers();
    const headers = { get: vi.fn(() => retryAfter) };
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, headers }); vi.stubGlobal("fetch", fetchMock);
    expect(await scan(loadPortalEventPage)).toMatchObject(unavailable);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(headers.get).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("network exception independently defers without logging or retries", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("SYNTHETIC_NETWORK_ERROR")); vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "error");
    expect(await scan(loadPortalEventPage)).toMatchObject(unavailable);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(log).not.toHaveBeenCalled();
  });
  it.each([null, "", " \t\n"])("blank primary next %# allows validated official nextLink fallback", async next => {
    const loader = vi.fn().mockResolvedValueOnce(page([event()], { total: 2, next, nextLink: `https://api.followupboss.com/v1/events?personId=${ID}&limit=100&next=fixture-next` }))
      .mockResolvedValueOnce(page([event(2)], { total: 2 }));
    expect(await scan(loader)).toEqual({ allowed: true, pages: 2, rows: 2 });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls[1][0]).toEqual({ personId: ID, limit: 100, next: "fixture-next" });
  });
  it.each([null, "", " \t\n"])("blank nextLink %# is ignored only with strict valid terminal totals", async nextLink => {
    for (const events of [[], [event()]]) {
      const loader = vi.fn().mockResolvedValue(page(events, { nextLink }));
      expect(await scan(loader)).toEqual({ allowed: true, pages: 1, rows: events.length });
      expect(loader).toHaveBeenCalledTimes(1);
    }
    const loader = vi.fn().mockResolvedValue(page([event()], { total: 2, nextLink }));
    expect(await scan(loader)).toEqual({ ...incomplete, pages: 1, rows: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it.each(["%GG", "%FF"])("exact independent final-gate repro %s refuses after first history read", async encoded => {
    const personId = 990001;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: personId, source: "Website Form", isZillowPACLead: false }) }));
    const history = vi.fn().mockResolvedValueOnce({
      events: [{ id: 1, personId, source: "Website Form" }],
      _metadata: { collection: "events", total: 2, nextLink: `https://api.followupboss.com/v1/events?personId=${personId}&limit=100&next=${encoded}` },
    }).mockResolvedValueOnce({ events: [{ id: 2, personId, source: "Website Form" }], _metadata: { collection: "events", total: 2 } });
    expect(await portalEmailGate(personId, { source: "Website Form", isZillowPACLead: false }, history)).toEqual(incomplete);
    expect(history).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledWith({ personId, limit: 100 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
