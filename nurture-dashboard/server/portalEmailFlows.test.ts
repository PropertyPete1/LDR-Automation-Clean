import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { setTimeout as realSetTimeout } from "node:timers";

const state = vi.hoisted(() => ({
  due: [] as any[], updates: [] as any[], inserts: [] as any[],
  sendMail: vi.fn(), observation: vi.fn(), model: vi.fn(), registry: vi.fn(),
  suppress: vi.fn(),
}));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: state.sendMail }) },
  createTransport: () => ({ sendMail: state.sendMail }),
}));
vi.mock("./db", () => ({
  getDb: vi.fn(async () => ({
    select: () => {
      const query: any = { from: () => query, where: () => query, orderBy: () => query, limit: async () => state.due };
      return query;
    },
    update: () => ({ set: (value: any) => ({ where: async () => { state.updates.push(value); } }) }),
    insert: () => ({ values: (value: any) => ({ onDuplicateKeyUpdate: async () => { state.inserts.push(value); } }) }),
  })),
  writeObservation: (...args: any[]) => state.observation(...args),
}));
vi.mock("./_core/llm", () => ({ invokeLLM: (...args: any[]) => state.model(...args) }));
vi.mock("./compliance", () => ({ isLeadSuppressed: (...args: any[]) => state.registry(...args), suppressLead: (...args: any[]) => state.suppress(...args) }));

import { runAnnualNurture, annualSuppressionVerdict } from "./annualNurture";
import { runPondNurture } from "./pondNurture";
import * as portalGate from "./portalEmailGate";

const ID = 920001;
const fixtureEmail = "fixture-920001@gmail.com";
const fixture = (extra: Record<string, unknown> = {}) => ({
  id: ID, source: "Website Form", tags: [], assignedPondId: 2,
  emails: [{ value: fixtureEmail }], ...extra,
});
const enrollment = (extra: Record<string, unknown> = {}) => ({
  id: 920002, personId: ID, leadName: "", email: fixtureEmail,
  enrolledAt: "2025-01-01T00:00:00.000Z", ...extra,
});
const mockFetch = vi.fn();
let notePosts: any[];
let fresh: unknown;
let candidate: any;
let initial: any;
let freshFails: boolean;
let initialFails: boolean;
let events: string[];
let inboundEmails: any[];
let inboundNotes: any[];
let personWrites: any[];
let staleCandidates: any[];
let pondCandidates: any[] | null;
let historyValue: unknown;
let historyFailure: "none" | "error" | "timeout" | "invalid-json" | "http-error" | "429-retry-after" | "429-no-retry-after";
let historyPages: unknown[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", mockFetch);
  for (const [key, value] of Object.entries({
    FUB_API_KEY: "fixture-key-920001", SMTP_HOST: "fixture.invalid", SMTP_USER: "fixture-920001@example.invalid",
    SMTP_PASSWORD: "fixture-value-920001", SMTP_PORT: "587", EMAIL_FROM: "fixture-920001@example.invalid",
  })) vi.stubEnv(key, value);
  state.due = []; state.updates = []; state.inserts = [];
  state.observation.mockReset().mockResolvedValue(undefined);
  state.registry.mockReset().mockResolvedValue(false);
  state.suppress.mockReset().mockResolvedValue(undefined);
  state.sendMail.mockReset().mockImplementation(async () => { events.push("smtp"); return { messageId: "fixture-920001" }; });
  state.model.mockReset().mockImplementation(async (opts: any) => ({
    choices: [{ message: { content: JSON.stringify(opts.response_format.json_schema.name === "skip_decision"
      ? { should_skip: false, confidence: 100, reason: "" }
      : { subject: "fixture-920001", body: "fixture-920001", email_body: "fixture-920001" }) } }],
  }));
  notePosts = []; events = []; freshFails = false; initialFails = false;
  candidate = fixture(); initial = fixture({ tags: ["Annual Nurture Only"] }); fresh = fixture();
  inboundEmails = []; inboundNotes = []; personWrites = []; staleCandidates = []; pondCandidates = null;
  historyValue = { events: [], _metadata: { collection: "events", total: 0 } }; historyFailure = "none"; historyPages = [];
  mockFetch.mockReset().mockImplementation(async (url: string, opts?: any) => {
    const parsed = new URL(url);
    let data: unknown;
    if (opts?.method === "POST") {
      notePosts.push(JSON.parse(opts.body)); events.push("note"); data = { id: 920003 };
    } else if (opts?.method === "PUT") {
      personWrites.push(JSON.parse(opts.body)); data = { id: ID };
    } else if (parsed.pathname.endsWith(`/people/${ID}`)) {
      if (parsed.searchParams.get("fields") === "allFields") {
        events.push("fresh");
        if (freshFails) throw new Error("FIXTURE_READ_FAILED");
        data = fresh;
      } else {
        if (initialFails) throw new Error("FIXTURE_READ_FAILED");
        data = initial;
      }
    } else if (parsed.pathname.endsWith("/people")) {
      data = { people: parsed.searchParams.has("pondId") ? (pondCandidates ?? [candidate]) : staleCandidates };
    } else if (parsed.pathname.endsWith("/notes")) data = { notes: inboundNotes };
    else if (parsed.pathname.endsWith("/emails")) data = { emails: inboundEmails };
    else if (parsed.pathname.endsWith("/deals")) data = { deals: [] };
    else if (parsed.pathname === "/v1/events") {
      events.push("history");
      if (historyFailure === "http-error" || historyFailure === "429-retry-after" || historyFailure === "429-no-retry-after") return { ok: false, status: historyFailure === "http-error" ? 500 : 429, headers: { get: () => historyFailure === "429-retry-after" ? "5" : null } };
      if (historyFailure === "error") throw new Error("SYNTHETIC_HISTORY_ERROR");
      if (historyFailure === "timeout") return { ok: true, json: () => new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(new Error("SYNTHETIC_HISTORY_ABORT")), { once: true });
      }) };
      if (historyFailure === "invalid-json") return { ok: true, json: async () => { throw new SyntaxError("SYNTHETIC_HISTORY_JSON"); } };
      data = historyPages.length ? historyPages.shift() : historyValue;
    }
    else throw new Error("FIXTURE_UNEXPECTED_REQUEST");
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => data };
  });
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
async function complete<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  for (let tick = 0; tick < 400 && !settled; tick++) {
    await new Promise<void>(resolve => realSetTimeout(resolve, 5));
    await vi.advanceTimersByTimeAsync(250);
  }
  return promise;
}
function leadSends() { return state.sendMail.mock.calls.filter(([mail]) => mail.to === fixtureEmail); }

const portalEvidence = [
  { source: "Zillow" }, { source: "Realtor® . com" }, { source: "realtordotcom" },
  { source: "realtor dot com" }, { source: "Website Form", leadSource: "Zillow" },
  { source: "", tags: ["Zillow Premier Agent"] }, { source: "", sourceUrl: "https://sub.realtor.com/fixture" },
  { source: "Website Form", originalSource: "Zillow" }, { source: "Website Form", eventSource: "Realtor.com" },
  { source: "Website Form", originalSource: { name: "Zillow" } },
  { source: "Website Form", eventSource: { leadSource: "Realtor.com" } },
  { source: "Website Form", original: { eventProvenance: { source: "Zillow" } } },
  { source: "Website Form", events: [{ provenance: [{ source: "Realtor.com" }] }] },
];

describe("pond sender and original queued provenance", () => {
  it.each(portalEvidence.map((evidence, index) => [index, evidence] as const))("selection portal %i blocks without notes or cadence record", async (_index, evidence) => {
    candidate = fixture(evidence);
    const result = await complete(runPondNurture());
    expect(result.sent).toBe(0); expect(result.suppressed).toBe(1);
    expect(leadSends()).toHaveLength(0); expect(notePosts).toHaveLength(0); expect(state.inserts).toHaveLength(0);
    expect(state.model).not.toHaveBeenCalled();
    expect(state.sendMail).toHaveBeenCalledTimes(1); // internal daily summary unchanged
  });
  it.each(portalEvidence.map((evidence, index) => [index, evidence] as const))("fresh portal %i blocks after queue selection", async (_index, evidence) => {
    fresh = fixture(evidence);
    const result = await complete(runPondNurture());
    expect(result.sent).toBe(0); expect(result.skipped).toBe(1);
    expect(events).toContain("fresh"); expect(leadSends()).toHaveLength(0);
    expect(notePosts).toHaveLength(0); expect(state.inserts).toHaveLength(0);
  });
  it.each([null, { id: ID }, { id: ID, source: {} }])("unusable fresh data leaves later cadence retry eligible", async value => {
    fresh = value;
    const result = await complete(runPondNurture());
    expect(result.sent).toBe(0); expect(result.skipped).toBe(1);
    expect(notePosts).toHaveLength(0); expect(state.inserts).toHaveLength(0);
  });
  it("failed fresh read cannot send and later successful retry can", async () => {
    freshFails = true;
    expect((await complete(runPondNurture())).sent).toBe(0);
    expect(leadSends()).toHaveLength(0); expect(state.inserts).toHaveLength(0);
    freshFails = false;
    expect((await complete(runPondNurture())).sent).toBe(1);
    expect(leadSends()).toHaveLength(1); expect(notePosts).toHaveLength(1); expect(state.inserts).toHaveLength(1);
  });
  it.each(["", "Website Form", "Realtor referral", "Agent Inquiry"])("nonportal %s retains email and sent bookkeeping", async value => {
    candidate = fixture({ source: value }); fresh = fixture({ source: value });
    const result = await complete(runPondNurture());
    expect(result.sent).toBe(1); expect(leadSends()).toHaveLength(1);
    expect(state.inserts).toHaveLength(1); expect(notePosts).toHaveLength(1);
    expect(events.slice(0, 3)).toEqual(["fresh", "history", "smtp"]);
  });
});

describe("annual due backlog sender", () => {
  it.each(portalEvidence.map((evidence, index) => [index, evidence] as const))("selection portal %i blocks without deactivating enrollment", async (_index, evidence) => {
    state.due = [enrollment()]; initial = fixture({ ...evidence, tags: ["Annual Nurture Only", ...(evidence.tags ?? [])] });
    const result = await complete(runAnnualNurture());
    expect(result.emailsSent).toBe(0); expect(result.skipped).toBe(1);
    expect(result.details).toEqual(["PORTAL_SOURCE_EXCLUDED"]);
    expect(leadSends()).toHaveLength(0); expect(notePosts).toHaveLength(0); expect(state.updates).toHaveLength(0);
    expect(state.model).not.toHaveBeenCalled();
  });
  it.each(portalEvidence.map((evidence, index) => [index, evidence] as const))("fresh portal %i blocks after generation without sent bookkeeping", async (_index, evidence) => {
    state.due = [enrollment()]; fresh = fixture(evidence);
    const result = await complete(runAnnualNurture());
    expect(result.emailsSent).toBe(0); expect(result.skipped).toBe(1);
    expect(leadSends()).toHaveLength(0); expect(notePosts).toHaveLength(0); expect(state.updates).toHaveLength(0);
    expect(events).toEqual(["fresh"]);
  });
  it("enrollment original portal plus current nonportal blocks", async () => {
    state.due = [enrollment({ originalSource: "Zillow" })];
    const result = await complete(runAnnualNurture());
    expect(result.emailsSent).toBe(0); expect(state.updates).toHaveLength(0); expect(leadSends()).toHaveLength(0);
  });
  it.each([null, { id: ID }, { id: ID, source: {} }])("unusable initial read never deactivates a retry", async value => {
    state.due = [enrollment()]; initial = value;
    const result = await complete(runAnnualNurture());
    expect(result.emailsSent).toBe(0); expect(state.updates).toHaveLength(0); expect(notePosts).toHaveLength(0);
  });
  it("failed fresh read leaves annual row unchanged and later retry succeeds", async () => {
    state.due = [enrollment()]; freshFails = true;
    const blocked = await complete(runAnnualNurture());
    expect(blocked.emailsSent).toBe(0); expect(state.updates).toHaveLength(0); expect(notePosts).toHaveLength(0);
    freshFails = false;
    const retried = await complete(runAnnualNurture());
    expect(retried.emailsSent).toBe(1); expect(state.updates).toHaveLength(1); expect(notePosts).toHaveLength(1);
  });
  it("failed initial read leaves annual enrollment untouched", async () => {
    state.due = [enrollment()]; initialFails = true;
    expect((await complete(runAnnualNurture())).emailsSent).toBe(0);
    expect(state.updates).toHaveLength(0); expect(notePosts).toHaveLength(0);
  });
  it.each(["", "Website Form", "Realtor referral", "Agent Inquiry"])("nonportal %s preserves annual sends", async value => {
    state.due = [enrollment()]; initial = fixture({ source: value, tags: ["Annual Nurture Only"] }); fresh = fixture({ source: value });
    const result = await complete(runAnnualNurture());
    expect(result.emailsSent).toBe(1); expect(state.updates).toHaveLength(1); expect(notePosts).toHaveLength(1);
    expect(events.slice(0, 3)).toEqual(["fresh", "history", "smtp"]);
  });
  it("verdict matcher classifies portal as skip-only", async () => {
    expect(await annualSuppressionVerdict(ID, fixture({ source: "Zillow" }), [])).toEqual({ reason: "PORTAL_SOURCE_EXCLUDED", deactivate: false });
  });
});

describe("transport inventory coverage", () => {
  it("pins all three lead surfaces and leaves internal transport sites ungated", () => {
    const pond = readFileSync(new URL("./pondNurture.ts", import.meta.url), "utf8");
    const annual = readFileSync(new URL("./annualNurture.ts", import.meta.url), "utf8");
    const helpers = readFileSync(new URL("./botHelpers.ts", import.meta.url), "utf8");
    const legacy = readFileSync(new URL("./lifestyleBot.ts", import.meta.url), "utf8");
    expect(pond).toContain("portalEmailGate(leadAudience?.personId as number, leadAudience?.provenance)");
    expect(annual).toContain("portalEmailGate(lead.personId, { originalProvenance: fubData, eventProvenance: enrollmentEvidence })");
    expect(helpers).toContain("portalEmailGate(opts.personId, opts.provenance)");
    expect((pond.match(/transporter\.sendMail\(/g) ?? []).length).toBe(1);
    expect((annual.match(/transporter\.sendMail\(/g) ?? []).length).toBe(1);
    expect((helpers.match(/transporter\.sendMail\(/g) ?? []).length).toBe(1);
    expect((legacy.match(/transporter\.sendMail\(/g) ?? []).length).toBe(2);
    expect(legacy).not.toContain("portalEmailGate");
  });
});


describe("portal policy stays email-only in baseline inbound and assignment lanes", () => {
  it.each(portalEvidence.map((evidence, index) => [index, evidence] as const))("portal %i still processes verified inbound email opt-out", async (_index, evidence) => {
    candidate = fixture(evidence);
    inboundEmails = [{ isIncoming: true, body: "UNSUBSCRIBE", subject: "fixture-920001" }];
    const result = await complete(runPondNurture());
    expect(result.errors).toBe(0); expect(result.sent).toBe(0);
    expect(state.suppress).toHaveBeenCalledWith(expect.objectContaining({ personId: ID, reason: "unsubscribe", source: "pond_nurture" }));
    expect(leadSends()).toHaveLength(0); expect(state.inserts).toHaveLength(0);
    expect(personWrites).toHaveLength(0); expect(state.model).not.toHaveBeenCalled();
    expect(state.sendMail).toHaveBeenCalledTimes(1); // operator summary, not contact SMTP
  });
  it.each(portalEvidence.map((evidence, index) => [index, evidence] as const))("portal %i still processes inbound sync-note opt-out", async (_index, evidence) => {
    candidate = fixture(evidence); inboundNotes = [{ body: "Inbound reply received: STOP" }];
    await complete(runPondNurture());
    expect(state.suppress).toHaveBeenCalledTimes(1);
    expect(leadSends()).toHaveLength(0); expect(state.inserts).toHaveLength(0);
  });
  it.each(portalEvidence.map((evidence, index) => [index, evidence] as const))("portal %i still follows the existing purchase-intent assignment decision", async (_index, evidence) => {
    candidate = fixture(evidence); initial = fixture(evidence);
    inboundEmails = [{ direction: "inbound", body: "Ready to buy", subject: "fixture-920001" }];
    const result = await complete(runPondNurture());
    expect(result.errors).toBe(0); expect(result.skipped).toBe(1); expect(result.sent).toBe(0);
    expect(personWrites).toContainEqual({ assignedUserId: 2, assignedPondId: null });
    expect(personWrites).toContainEqual(expect.objectContaining({ tags: expect.arrayContaining(["pond-intent-reassigned"]) }));
    expect(notePosts).toHaveLength(1); // existing intent note, never an email sent note
    expect(state.observation).toHaveBeenCalledWith(expect.objectContaining({ category: "intent_reassign" }));
    expect(state.suppress).not.toHaveBeenCalled(); expect(leadSends()).toHaveLength(0);
    expect(state.inserts).toHaveLength(0); expect(state.model).not.toHaveBeenCalled();
  });
  it("ordinary non-intent reply is fetched before portal selection without sent/skip writes", async () => {
    candidate = fixture({ source: "Zillow", tags: ["Zillow"] });
    inboundEmails = [{ isIncoming: true, body: "Thanks for the update", subject: "fixture-920001" }];
    expect((await complete(runPondNurture())).sent).toBe(0);
    expect(mockFetch.mock.calls.some(([url]) => new URL(url).pathname.endsWith("/emails"))).toBe(true);
    expect(state.suppress).not.toHaveBeenCalled(); expect(personWrites).toHaveLength(0);
    expect(notePosts).toHaveLength(0); expect(state.inserts).toHaveLength(0); expect(state.model).not.toHaveBeenCalled();
  });
  it.each(["Zillow Rentals - fixture", "New Agent Inquiry fixture", "BOTM Newsletter fixture", "Lease Listing Inquiry fixture"])("baseline excluded source %s retains its pre-inbound exclusion", async source => {
    candidate = fixture({ source }); inboundEmails = [{ isIncoming: true, body: "STOP" }];
    await complete(runPondNurture());
    expect(state.suppress).not.toHaveBeenCalled();
    expect(mockFetch.mock.calls.some(([url]) => new URL(url).pathname.endsWith("/emails"))).toBe(false);
    expect(personWrites).toHaveLength(0); expect(leadSends()).toHaveLength(0);
  });
  it.each(["agent", "realtor", "do not contact", "replied - paused"])("baseline tag %s retains its pre-inbound exclusion", tag => {
    candidate = fixture({ source: "Zillow", tags: [tag] }); inboundEmails = [{ isIncoming: true, body: "STOP" }];
    return complete(runPondNurture()).then(() => {
      expect(state.suppress).not.toHaveBeenCalled(); expect(leadSends()).toHaveLength(0);
      expect(mockFetch.mock.calls.some(([url]) => new URL(url).pathname.endsWith("/emails"))).toBe(false);
    });
  });
  it.each(portalEvidence.map((evidence, index) => [index, evidence] as const))("portal %i retains existing stale-agent reassignment", async (_index, evidence) => {
    pondCandidates = [];
    staleCandidates = [fixture({ ...evidence, assignedPondId: null, assignedUserId: 3, stage: "Lead" })];
    const result = await complete(runPondNurture());
    expect(result.errors).toBe(0); expect(result.reassigned).toBe(1);
    expect(personWrites).toEqual([{ assignedPondId: 2 }]);
    expect(notePosts).toHaveLength(1); expect(leadSends()).toHaveLength(0); expect(state.inserts).toHaveLength(0);
    expect(state.sendMail).toHaveBeenCalledTimes(1);
  });
  it.each([
    { source: "Zillow Rentals - fixture" }, { source: "New Agent Inquiry fixture" },
    { source: "Zillow", tags: ["agent"] }, { source: "Zillow", tags: ["realtor"] },
    { source: "Zillow", stage: "Active Client" }, { source: "Zillow", assignedUserId: 16 },
    { source: "Zillow", tags: ["dnc"] },
  ])("stale assignment still honors unrelated baseline protection %#", async protection => {
    pondCandidates = []; staleCandidates = [fixture({ assignedPondId: null, assignedUserId: 3, stage: "Lead", ...protection })];
    const result = await complete(runPondNurture());
    expect(result.reassigned).toBe(0); expect(personWrites).toHaveLength(0); expect(notePosts).toHaveLength(0);
  });
  it("legacy SMS drafts and internal previews explicitly use only baseline tags", () => {
    const legacy = readFileSync(new URL("./lifestyleBot.ts", import.meta.url), "utf8");
    expect((legacy.match(/getSharedSuppressionTags\(false\)/g) ?? [])).toHaveLength(2);
    expect(legacy).not.toContain("getSharedSuppressionTags()");
    const speed = readFileSync(new URL("./speedToLead.ts", import.meta.url), "utf8");
    expect(speed).not.toContain("portalEmailGate"); expect(speed).not.toContain("getSharedSuppressionTags");
  });
});

describe("source-less and malformed fresh records never advance send bookkeeping", () => {
  const invalid = [
    { id: ID, tags: [] }, { id: ID, sourceUrl: "" }, { id: ID, tags: null },
    fixture({ id: true }), fixture({ id: [ID] }), fixture({ id: ID + 0.5 }),
    fixture({ id: `0${ID}` }), fixture({ source: undefined }),
  ];
  it.each(invalid.map((value, index) => [index, value] as const))("pond refusal %i leaves the ordinary retry eligible", async (_index, value) => {
    fresh = value;
    expect((await complete(runPondNurture())).sent).toBe(0);
    expect(notePosts).toHaveLength(0); expect(state.inserts).toHaveLength(0); expect(leadSends()).toHaveLength(0);
    fresh = fixture();
    expect((await complete(runPondNurture())).sent).toBe(1);
    expect(leadSends()).toHaveLength(1); expect(state.inserts).toHaveLength(1);
  });
  it.each(invalid.map((value, index) => [index, value] as const))("annual final refusal %i does not deactivate or advance its row", async (_index, value) => {
    state.due = [enrollment()]; fresh = value;
    expect((await complete(runAnnualNurture())).emailsSent).toBe(0);
    expect(notePosts).toHaveLength(0); expect(state.updates).toHaveLength(0); expect(leadSends()).toHaveLength(0);
    fresh = fixture();
    expect((await complete(runAnnualNurture())).emailsSent).toBe(1);
    expect(leadSends()).toHaveLength(1); expect(state.updates).toHaveLength(1);
  });
  it.each(invalid.map((value, index) => [index, value] as const))("annual initial refusal %i cannot remove enrollment", async (_index, value) => {
    state.due = [enrollment()]; initial = value;
    expect((await complete(runAnnualNurture())).emailsSent).toBe(0);
    expect(state.updates).toHaveLength(0); expect(notePosts).toHaveLength(0); expect(state.model).not.toHaveBeenCalled();
  });
  it("annual enrolling SYSTEM and trigger content never become acquisition evidence", async () => {
    state.due = [enrollment({ source: "Zillow", triggerSnippet: "Realtor.com" })];
    expect((await complete(runAnnualNurture())).emailsSent).toBe(1);
    expect(leadSends()).toHaveLength(1); expect(state.updates).toHaveLength(1);
  });
  it("explicit original acquisition evidence wins even over missing annual initial source", async () => {
    state.due = [enrollment({ original: { source: "Zillow" } })]; initial = { id: ID, tags: [] };
    const result = await complete(runAnnualNurture());
    expect(result.details).toEqual(["PORTAL_SOURCE_EXCLUDED"]); expect(state.updates).toHaveLength(0);
    expect(notePosts).toHaveLength(0); expect(leadSends()).toHaveLength(0);
  });
});


describe("outbound selected identity is never coerced into a different person", () => {
  it.each([true, false, [ID], [], ID + 0.5, `0${ID}`, `${ID}.0`])("invalid selected identity %# cannot authorize email", async id => {
    candidate = fixture({ id });
    fresh = fixture({ id: typeof id === "boolean" ? Number(id) : ID });
    const result = await complete(runPondNurture());
    expect(result.sent).toBe(0); expect(result.errors).toBe(0); expect(result.skipped).toBe(1);
    expect(leadSends()).toHaveLength(0); expect(notePosts).toHaveLength(0); expect(state.inserts).toHaveLength(0);
    expect(events).not.toContain("fresh");
  });
});


type SharedProvenanceCase = { name: string; record: Record<string, unknown>; portal: boolean; metadataUsable: boolean };
const sharedCases: SharedProvenanceCase[] = JSON.parse(readFileSync(new URL("../../pond-nurture-bot/tests/fixtures/portal_provenance.json", import.meta.url), "utf8"));
const refusalCases = sharedCases.filter(row => row.portal || !row.metadataUsable);
function expectNoDeliveryWrites() {
  expect(leadSends()).toHaveLength(0);
  expect(notePosts).toHaveLength(0); // FUB sent or skip-note writes
  expect(state.inserts).toHaveLength(0); // cadence/contacted/angle/queue-as-sent
  expect(state.updates).toHaveLength(0); // annual count/timestamp/active/cap/claim-as-sent
  expect(personWrites).toHaveLength(0);
}

for (const lane of ["pond", "annual"] as const) {
  for (const location of ["fresh", "snapshot"] as const) {
    describe(`${lane} shared fixture refusal: ${location}`, () => {
      it.each(refusalCases)("$name has no SMTP/sent/cadence/count/queue consumption", async row => {
        const evidence = fixture(row.record);
        if (lane === "pond") {
          if (location === "fresh") fresh = evidence; else candidate = evidence;
          const result = await complete(runPondNurture());
          expect(result.sent).toBe(0); expect(result.errors).toBe(0);
          expectNoDeliveryWrites(); expect(events).not.toContain("history");
          expect(state.sendMail).toHaveBeenCalledTimes(1); // baseline operator summary only
          expect(state.sendMail.mock.calls[0][0].text).toContain("Emails sent: 0");
        } else {
          state.due = [enrollment()];
          if (location === "fresh") fresh = evidence;
          else initial = fixture({ ...row.record, tags: ["Annual Nurture Only", ...((row.record.tags as any[]) ?? [])] });
          const result = await complete(runAnnualNurture());
          expect(result.emailsSent).toBe(0); expect(result.errors).toBe(0);
          expectNoDeliveryWrites(); expect(events).not.toContain("history"); expect(state.sendMail).not.toHaveBeenCalled();
        }
        if (location === "snapshot") expect(state.model).not.toHaveBeenCalled();
      });
    });
  }
}

describe("annual explicit enrollment metadata refusal and retry", () => {
  const rows = refusalCases.filter(row => Object.keys(row.record).some(key => ["originalSource", "eventSource", "original", "event", "originalProvenance", "eventProvenance", "provenance", "events"].includes(key)));
  it.each(rows)("$name cannot remove or advance an annual row", async row => {
    state.due = [enrollment(row.record)];
    const result = await complete(runAnnualNurture());
    expect(result.emailsSent).toBe(0); expect(result.errors).toBe(0);
    expectNoDeliveryWrites(); expect(state.model).not.toHaveBeenCalled();
    // Annual enrollment.source is SYSTEM metadata, never acquisition proof.
    const hasExplicitPortal = row.portal && row.name !== "any-portal-wins-invalid-original";
    expect(result.details).toEqual([hasExplicitPortal ? "PORTAL_SOURCE_EXCLUDED" : "PORTAL_PROVENANCE_UNUSABLE"]);
  });
  it.each(["pond", "annual"])("malformed snapshot defers and a repaired ordinary retry can send: %s", async lane => {
    if (lane === "pond") {
      candidate = fixture({ originalSource: {} });
      expect((await complete(runPondNurture())).sent).toBe(0); expectNoDeliveryWrites();
      candidate = fixture();
      expect((await complete(runPondNurture())).sent).toBe(1);
      expect(state.inserts).toHaveLength(1); expect(notePosts).toHaveLength(1);
    } else {
      state.due = [enrollment({ eventProvenance: { unknown: "Zillow" } })];
      expect((await complete(runAnnualNurture())).emailsSent).toBe(0); expectNoDeliveryWrites();
      state.due = [enrollment()];
      expect((await complete(runAnnualNurture())).emailsSent).toBe(1);
      expect(state.updates).toHaveLength(1); expect(notePosts).toHaveLength(1);
    }
    expect(leadSends()).toHaveLength(1);
  });
});

describe("named user regressions on real pond and annual entrypoints", () => {
  it.each(["pond", "annual"])("regression_a_trailing_dot_blocks_final_sender: %s", async lane => {
    fresh = fixture({ sourceUrl: "https://zillow.com./lead" });
    if (lane === "pond") expect((await complete(runPondNurture())).sent).toBe(0);
    else { state.due = [enrollment()]; expect((await complete(runAnnualNurture())).emailsSent).toBe(0); }
    expect(events).toContain("fresh"); expectNoDeliveryWrites();
  });
  it.each(["pond", "annual"])("regression_b_local_realtor_committee_is_nonportal: %s", async lane => {
    fresh = fixture({ source: "Local Realtor Committee" });
    if (lane === "pond") {
      candidate = fixture({ source: "Local Realtor Committee" });
      expect((await complete(runPondNurture())).sent).toBe(1); expect(state.inserts).toHaveLength(1);
    } else {
      state.due = [enrollment()]; initial = fixture({ source: "Local Realtor Committee", tags: ["Annual Nurture Only"] });
      expect((await complete(runAnnualNurture())).emailsSent).toBe(1); expect(state.updates).toHaveLength(1);
    }
    expect(leadSends()).toHaveLength(1); expect(notePosts).toHaveLength(1);
  });
  it.each(["pond", "annual"])("nurture_no_email_paths_skip_without_sent_bookkeeping: %s", async lane => {
    fresh = fixture({ emails: [] });
    if (lane === "pond") {
      candidate = fixture({ emails: [] });
      const result = await complete(runPondNurture());
      expect(result.sent).toBe(0); expect(result.suppressed).toBe(1); // unchanged base no-email classification
      expect(state.sendMail).toHaveBeenCalledTimes(1); // operator summary remains
    } else {
      state.due = [enrollment({ email: "" })]; initial = fixture({ emails: [], tags: ["Annual Nurture Only"] });
      const result = await complete(runAnnualNurture());
      expect(result.emailsSent).toBe(0); expect(result.skipped).toBe(1);
      expect(state.sendMail).not.toHaveBeenCalled();
    }
    expectNoDeliveryWrites(); expect(state.model).not.toHaveBeenCalled(); expect(events).not.toContain("fresh");
  });
  it.each(["pond", "annual"])("old nonportal snapshot cannot override fresh portal plus malformed metadata: %s", async lane => {
    fresh = fixture({ source: "Website", originalSource: { name: "Zillow" }, eventSource: 42 });
    if (lane === "pond") expect((await complete(runPondNurture())).sent).toBe(0);
    else { state.due = [enrollment()]; expect((await complete(runAnnualNurture())).emailsSent).toBe(0); }
    expectNoDeliveryWrites();
  });
  it("malformed portal-only metadata does not suppress the existing inbound opt-out", async () => {
    candidate = fixture({ originalSource: {}, eventSource: true });
    inboundEmails = [{ isIncoming: true, body: "UNSUBSCRIBE" }];
    expect((await complete(runPondNurture())).sent).toBe(0);
    expect(state.suppress).toHaveBeenCalledTimes(1); expectNoDeliveryWrites();
  });
  it("non-email inbound entrypoint sources remain byte-for-byte base and contain no portal gate", () => {
    for (const file of ["bounceHandler.ts", "replyIntentHandler.ts", "speedToLead.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source).not.toContain("portalEmailGate");
      expect(source).not.toContain("inspectPortalProvenance");
    }
    const index = readFileSync(new URL("./_core/index.ts", import.meta.url), "utf8");
    expect(index).not.toContain("suppressionTagsEndpoint");
    expect(index).not.toContain('"/api/suppression-tags"');
    expect(index).toContain('"/api/power-queue/weekly-stats"');
    expect(index).toContain('"/api/audit-status"');
  });
});


describe("Candidate 4 history-only final refusal preserves all delivery state", () => {
  const histories = [
    { name: "historical Zillow", value: { events: [{ id: 950001, personId: ID, source: "Zillow" }], _metadata: { collection: "events", total: 1 } }, failure: "none", reason: "PORTAL_SOURCE_EXCLUDED" },
    { name: "historical Realtor", value: { events: [{ id: 950001, personId: ID, source: "Realtor.com" }], _metadata: { collection: "events", total: 1 } }, failure: "none", reason: "PORTAL_SOURCE_EXCLUDED" },
    { name: "unreadable metadata", value: { events: [], _metadata: {} }, failure: "none", reason: "PORTAL_HISTORY_INCOMPLETE" },
    { name: "restricted history", value: { events: [], _metadata: { collection: "events", total: 0, restricted: true } }, failure: "none", reason: "PORTAL_HISTORY_INCOMPLETE" },
    { name: "HTTP 500", value: null, failure: "http-error", reason: "PORTAL_HISTORY_UNAVAILABLE" },
    { name: "HTTP 429 with Retry-After", value: null, failure: "429-retry-after", reason: "PORTAL_HISTORY_UNAVAILABLE" },
    { name: "HTTP 429 without Retry-After", value: null, failure: "429-no-retry-after", reason: "PORTAL_HISTORY_UNAVAILABLE" },
    { name: "network exception", value: null, failure: "error", reason: "PORTAL_HISTORY_UNAVAILABLE" },
    { name: "cross-person portal", value: { events: [{ id: 950001, personId: ID + 1, source: "Zillow" }], _metadata: { collection: "events", total: 1 } }, failure: "none", reason: "PORTAL_HISTORY_INCOMPLETE" },
    { name: "missing event person", value: { events: [{ id: 950001, source: "Zillow" }], _metadata: { collection: "events", total: 1 } }, failure: "none", reason: "PORTAL_HISTORY_INCOMPLETE" },
    { name: "missing event source", value: { events: [{ id: 950001, personId: ID }], _metadata: { collection: "events", total: 1 } }, failure: "none", reason: "PORTAL_HISTORY_INCOMPLETE" },
    { name: "missing events array", value: { _metadata: { collection: "events", total: 0 } }, failure: "none", reason: "PORTAL_HISTORY_INCOMPLETE" },
    { name: "wrong events type", value: { events: {}, _metadata: { collection: "events", total: 0 } }, failure: "none", reason: "PORTAL_HISTORY_INCOMPLETE" },
    { name: "non-JSON page scalar", value: "synthetic not JSON object", failure: "none", reason: "PORTAL_HISTORY_INCOMPLETE" },
    { name: "history body timeout", value: null, failure: "timeout", reason: "PORTAL_HISTORY_UNAVAILABLE" },
    { name: "invalid history JSON", value: null, failure: "invalid-json", reason: "PORTAL_HISTORY_UNAVAILABLE" },
  ] as const;
  for (const lane of ["pond", "annual"] as const) {
    it.each(histories)(`${lane}: $name has no SMTP/sent note/contact/cadence/cap/count/queue mutation and retry can send`, async row => {
      candidate = fixture({ isZillowPACLead: false }); fresh = fixture({ isZillowPACLead: false });
      if (lane === "annual") state.due = [enrollment()];
      historyValue = row.value; historyFailure = row.failure;
      const refused = lane === "pond" ? await complete(runPondNurture()) : await complete(runAnnualNurture());
      expect(lane === "pond" ? (refused as any).sent : (refused as any).emailsSent).toBe(0);
      expect(refused.errors).toBe(0); expect(refused.skipped).toBe(1); expectNoDeliveryWrites();
      expect(events.filter(value => value !== "smtp")).toEqual(["fresh", "history"]);
      expect(mockFetch.mock.calls.filter(([url]) => new URL(url).pathname === "/v1/events")).toHaveLength(1);
      expect(state.sendMail).toHaveBeenCalledTimes(lane === "pond" ? 1 : 0); // internal summary only
      if (lane === "annual") expect((refused as any).details).toEqual([row.reason]);
      historyValue = { events: [], _metadata: { collection: "events", total: 0 } }; historyFailure = "none";
      const retry = lane === "pond" ? await complete(runPondNurture()) : await complete(runAnnualNurture());
      expect(lane === "pond" ? (retry as any).sent : (retry as any).emailsSent).toBe(1);
      expect(leadSends()).toHaveLength(1); expect(notePosts).toHaveLength(1);
      expect(lane === "pond" ? state.inserts : state.updates).toHaveLength(1);
      expect((retry as any).capReached ?? false).toBe(false);
    });
    it.each(["fresh", "snapshot"] as const)(`${lane}: native true Website Form at %s has zero history reads`, async location => {
      const evidence = fixture({ isZillowPACLead: true });
      if (lane === "pond") { if (location === "snapshot") candidate = evidence; else fresh = evidence; }
      else { state.due = [enrollment()]; if (location === "snapshot") initial = fixture({ isZillowPACLead: true, tags: ["Annual Nurture Only"] }); else fresh = evidence; }
      const result = lane === "pond" ? await complete(runPondNurture()) : await complete(runAnnualNurture());
      expect(lane === "pond" ? (result as any).sent : (result as any).emailsSent).toBe(0);
      expectNoDeliveryWrites(); expect(events).not.toContain("history");
    });
  }
  for (const path of ["direct", "follow-up"] as const) {
    it.each(histories)(`exported ${path}: $name refuses before all delivery mutations`, async row => {
      const helpers = await import("./botHelpers");
      historyValue = row.value; historyFailure = row.failure;
      const promise = path === "direct" ? helpers.sendEmail({ to: fixtureEmail, subject: "synthetic", html: "synthetic", personId: ID })
        : helpers.sendLeadFollowUpEmail({ personId: ID, agentEmail: "fixture-agent@example.invalid", agentFirstName: "", agentLastName: "", leadEmail: fixtureEmail, leadFirstName: null, messageBody: "synthetic" });
      await expect(complete(promise)).rejects.toMatchObject({ reason: row.reason });
      expectNoDeliveryWrites(); expect(state.sendMail).not.toHaveBeenCalled();
      expect(events).toEqual(["fresh", "history"]);
    });
  }
});


describe("Candidate 4 pagination and no-negative-cache send boundaries", () => {
  const row = (id: number, source = "Website Form") => ({ id, personId: ID, source });
  const historyPage = (rows: any[], total: number, extra: Record<string, unknown> = {}) => ({ events: rows, _metadata: { collection: "events", total, ...extra } });
  const hundred = (start: number) => Array.from({ length: 100 }, (_, index) => row(start + index));
  for (const lane of ["pond", "annual", "direct", "follow-up"] as const) {
    async function send() {
      if (lane === "pond") return complete(runPondNurture());
      if (lane === "annual") { state.due = [enrollment()]; return complete(runAnnualNurture()); }
      const helpers = await import("./botHelpers");
      const promise = lane === "direct" ? helpers.sendEmail({ to: fixtureEmail, subject: "synthetic", html: "synthetic", personId: ID })
        : helpers.sendLeadFollowUpEmail({ personId: ID, agentEmail: "fixture-agent@example.invalid", agentFirstName: "", agentLastName: "", leadEmail: fixtureEmail, leadFirstName: null, messageBody: "synthetic" });
      try { await complete(promise); return { allowed: true }; }
      catch (error) { return { allowed: false, reason: (error as any).reason }; }
    }
    function refused(value: any, reason: string) {
      if (lane === "pond") { expect(value.sent).toBe(0); expect(value.skipped).toBe(1); expect(value.errors).toBe(0); }
      else if (lane === "annual") { expect(value.emailsSent).toBe(0); expect(value.details).toEqual([reason]); expect(value.errors).toBe(0); }
      else expect(value).toEqual({ allowed: false, reason });
      expectNoDeliveryWrites();
    }
    it.each([
      { name: "exact malformed %GG cursor", link: `https://api.followupboss.com/v1/events?personId=${ID}&limit=100&next=%GG` },
      { name: "exact invalid UTF-8 %FF cursor", link: `https://api.followupboss.com/v1/events?personId=${ID}&limit=100&next=%FF` },
      { name: "raw dot-segment path", link: `https://api.followupboss.com/v1/x/../events?personId=${ID}&limit=100&next=synthetic-next` },
      { name: "encoded dot-segment path", link: `https://api.followupboss.com/v1/x/%2e%2e/events?personId=${ID}&limit=100&next=synthetic-next` },
      { name: "raw backslash path", link: `https://api.followupboss.com\\v1\\events?personId=${ID}&limit=100&next=synthetic-next` },
      { name: "credential-bearing authority", link: `https://user@api.followupboss.com/v1/events?personId=${ID}&limit=100&next=synthetic-next` },
      { name: "explicit default HTTPS port", link: `https://api.followupboss.com:443/v1/events?personId=${ID}&limit=100&next=synthetic-next` },
    ])(`${lane}: $name is INCOMPLETE after first history read, with no lead SMTP/FUB sent/queue/cadence/count writes`, async ({ link }) => {
      candidate = fixture({ isZillowPACLead: false }); fresh = fixture({ isZillowPACLead: false });
      // This spy calls the real gate unchanged; pond's public result exposes only
      // skipped, so observe its actual returned reason without substituting it.
      const gate = vi.spyOn(portalGate, "portalEmailGate");
      historyPages = [historyPage([row(1)], 2, { nextLink: link }), historyPage([row(2)], 2)];
      refused(await send(), "PORTAL_HISTORY_INCOMPLETE");
      expect(gate).toHaveBeenCalledTimes(1);
      await expect(gate.mock.results[0].value).resolves.toEqual({ allowed: false, reason: "PORTAL_HISTORY_INCOMPLETE" });
      expect(events.filter(value => value !== "smtp")).toEqual(["fresh", "history"]);
      const historyReads = mockFetch.mock.calls.filter(([url]) => new URL(url).pathname === "/v1/events");
      expect(historyReads).toHaveLength(1);
      const [url, options] = historyReads[0];
      expect(url).toBe(`https://api.followupboss.com/v1/events?personId=${ID}&limit=100`);
      expect(options.redirect).toBe("error");
      expect(historyPages).toHaveLength(1); // Prepared clean second page was not requested.
      expect(state.sendMail).toHaveBeenCalledTimes(lane === "pond" ? 1 : 0);
      if (lane === "pond") expect(state.sendMail.mock.calls[0][0].text).toContain("Emails sent: 0");
    });
    it.each([
      { encoded: "fixture%2Bcursor", decoded: "fixture+cursor", next: null },
      { encoded: "fixture+cursor", decoded: "fixture cursor", next: "" },
      { encoded: "%E2%9C%93%F0%9F%94%91", decoded: "\u2713\ud83d\udd11", next: " \t\n" },
      { encoded: "%252F%26%3D%23%25", decoded: "%2F&=#%", next: null },
    ])(`${lane}: valid $encoded cursor sends after faithful decoding and fixed-endpoint continuation`, async ({ encoded, decoded, next }) => {
      candidate = fixture({ isZillowPACLead: false }); fresh = fixture({ isZillowPACLead: false });
      historyPages = [historyPage([row(1)], 2, { next, nextLink: `https://api.followupboss.com/v1/events?personId=${ID}&limit=100&next=${encoded}` }), historyPage([row(2)], 2)];
      const result: any = await send();
      if (lane === "pond") expect(result.sent).toBe(1);
      else if (lane === "annual") expect(result.emailsSent).toBe(1);
      else expect(result).toEqual({ allowed: true });
      expect(leadSends()).toHaveLength(1);
      expect(events.slice(0, 4)).toEqual(["fresh", "history", "history", "smtp"]);
      const historyReads = mockFetch.mock.calls.filter(([url]) => new URL(url).pathname === "/v1/events");
      expect(historyReads).toHaveLength(2);
      const [url, options] = historyReads[1];
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe("https://api.followupboss.com/v1/events");
      expect([...parsed.searchParams.entries()]).toEqual([["personId", String(ID)], ["limit", "100"], ["next", decoded]]);
      expect(options.method).toBe("GET"); expect(options.redirect).toBe("error");
      expect(historyPages).toHaveLength(0);
    });
    it(`${lane}: later-page-only portal excludes without delivery state`, async () => {
      historyPages = [historyPage([row(950001)], 2, { next: "synthetic-later" }), historyPage([row(950002, "Zillow")], 2)];
      refused(await send(), "PORTAL_SOURCE_EXCLUDED");
      expect(events.filter(value => value !== "smtp")).toEqual(["fresh", "history", "history"]);
    });
    it(`${lane}: missing next valid total terminal nonportal sends`, async () => {
      historyValue = historyPage([row(950001, "Realtor referral")], 1);
      await send(); expect(leadSends()).toHaveLength(1); expect(events.slice(0, 3)).toEqual(["fresh", "history", "smtp"]);
    });
    it(`${lane}: missing next short outstanding total defers`, async () => {
      historyValue = historyPage([row(950001)], 2);
      refused(await send(), "PORTAL_HISTORY_INCOMPLETE");
      expect(events.filter(value => value !== "smtp")).toEqual(["fresh", "history"]);
    });
    it.each(["repeated", "cyclic"])(`${lane}: %s cursor defers with zero delivery`, async kind => {
      historyPages = [historyPage([row(950001)], 4, { next: "x" }), historyPage([row(950002)], 4, { next: kind === "repeated" ? "x" : "y" })];
      if (kind === "cyclic") historyPages.push(historyPage([row(950003)], 4, { next: "x" }));
      refused(await send(), "PORTAL_HISTORY_INCOMPLETE");
      expect(events.filter(value => value === "history")).toHaveLength(kind === "repeated" ? 2 : 3);
    });
    it(`${lane}: five-page/event cap with outstanding history defers`, async () => {
      historyPages = Array.from({ length: 5 }, (_, index) => historyPage(hundred(index * 100 + 1), 501));
      refused(await send(), "PORTAL_HISTORY_INCOMPLETE");
      expect(events.filter(value => value === "history")).toHaveLength(5);
    });
    it(`${lane}: first clean send, second fresh read plus portal history refuses without second delivery state`, async () => {
      historyValue = historyPage([row(950001)], 1);
      await send(); expect(leadSends()).toHaveLength(1);
      const notes = notePosts.length, inserts = state.inserts.length, updates = state.updates.length;
      historyValue = historyPage([row(950001, "Zillow")], 1);
      const second: any = await send();
      if (lane === "pond") { expect(second.sent).toBe(0); expect(second.skipped).toBe(1); }
      else if (lane === "annual") { expect(second.emailsSent).toBe(0); expect(second.details).toEqual(["PORTAL_SOURCE_EXCLUDED"]); }
      else expect(second).toEqual({ allowed: false, reason: "PORTAL_SOURCE_EXCLUDED" });
      expect(leadSends()).toHaveLength(1); expect(notePosts).toHaveLength(notes);
      expect(state.inserts).toHaveLength(inserts); expect(state.updates).toHaveLength(updates);
      expect(personWrites).toHaveLength(0);
      expect(events.filter(value => value === "fresh")).toHaveLength(2);
      expect(events.filter(value => value === "history")).toHaveLength(2);
    });
    it(`${lane}: poisoned event content cannot supply portal evidence or be read`, async () => {
      const contentGetter = vi.fn(() => { throw new Error("SYNTHETIC_CONTENT_READ_FORBIDDEN"); });
      const ordinary = row(950001);
      for (const field of ["message", "description", "note", "pageTitle", "pageUrl", "properties", "type"]) Object.defineProperty(ordinary, field, { get: contentGetter });
      const messageOnly = { ...row(950002), message: "Zillow Realtor.com", description: "Zillow", note: "Zillow", pageTitle: "Zillow", pageUrl: "https://zillow.com/" };
      historyValue = historyPage([ordinary, messageOnly], 2);
      await send(); expect(leadSends()).toHaveLength(1); expect(contentGetter).not.toHaveBeenCalled();
    });
  }
});


describe("Candidate 4 actual Lifestyle public entrypoint remains deprecated no-op", () => {
  it.each(["native Website Form", "portal history", "history timeout"])("%s cannot introduce any Lifestyle transport/sent state/history call", async condition => {
    if (condition === "native Website Form") fresh = fixture({ isZillowPACLead: true });
    if (condition === "portal history") historyValue = { events: [{ id: 950001, personId: ID, source: "Zillow" }], _metadata: { collection: "events", total: 1 } };
    if (condition === "history timeout") historyFailure = "timeout";
    const { runLifestyleBot } = await import("./lifestyleBot");
    const result = await runLifestyleBot("manual");
    expect(result.leadsProcessed).toBe(0); expect(result.results).toEqual([]); expect(result.summaryEmailSent).toBe(false);
    expectNoDeliveryWrites(); expect(state.sendMail).not.toHaveBeenCalled(); expect(mockFetch).not.toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
  });
});
