import { withCompleteHistory } from "./portalHistoryTestSupport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

const fixture = vi.hoisted(() => ({
  personId: 990001,
  agent: {
    id: 990002, botSlug: "synthetic", botName: "Synthetic Bot", engineActive: true,
    legacyRetired: true, agentFirstName: "Synthetic", agentLastName: "Agent",
    agentEmail: "internal@example.invalid", fubUserId: 990003,
    powerQueueName: "Synthetic", accentColor: "#000000", headerGradient: "none", introSentAt: null,
  },
  selected: { id: 990001, source: "Website Form", emails: [{ value: "fixture@gmail.com" }] } as any,
  smtp: vi.fn().mockResolvedValue({ messageId: "synthetic" }),
  note: vi.fn().mockResolvedValue(undefined),
  contact: vi.fn().mockResolvedValue(undefined),
  dedup: vi.fn().mockResolvedValue(undefined),
  angleRecord: vi.fn().mockResolvedValue(undefined),
  angle: vi.fn().mockResolvedValue(undefined),
  skip: vi.fn().mockResolvedValue({ skip: false }),
  observation: vi.fn().mockResolvedValue(undefined),
  runLog: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: fixture.smtp }) } }));
vi.mock("./db", () => ({
  getDb: vi.fn(async () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([fixture.agent]).then(resolve),
          limit: async () => [fixture.agent],
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: fixture.update }) }),
  })),
}));
vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: vi.fn(async () => ({ isCron: true })) } }));
vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify({
    openingLine: "Synthetic", originStory: "Synthetic", whatIDo: "Synthetic",
    powerQueueNote: "Synthetic", hype: "Synthetic",
  }) } }] })),
}));
vi.mock("./botHelpers", async importOriginal => {
  const actual = await importOriginal<typeof import("./botHelpers")>();
  return {
    ...actual,
    fetchLeadsForAgent: vi.fn(async () => [fixture.selected]),
    shouldSkipLead: fixture.skip,
    wasContactedRecently: vi.fn(async () => false),
    generateFollowUpMessage: vi.fn(async (opts: any) => {
      if (!opts.deferSentRecord) await fixture.angleRecord();
      return { body: "Synthetic body", subject: "Synthetic subject", recordDelivery: fixture.angleRecord };
    }),
    getSmsSentTodayIds: vi.fn(async () => new Set()),
    postFubNote: fixture.note,
    logContactedLead: fixture.contact,
    recordSmsSentToday: fixture.dedup,
    writeObservation: fixture.observation,
    logBotRun: fixture.runLog,
    fetchPowerQueueCount: vi.fn(async () => 0),
  };
});

import { runAllEngineAgents, runEngineForAgent, sendEngineClockinForAgent, sendEngineClockoffForAgent } from "./botEngine";
import {
  handleEngineRun, handleEngineRunSingle, handleSpPeterRun, handleSpStevenRun,
} from "./scheduledHandlers";
import { generateFollowUpMessage } from "./botHelpers";

const response = (person: unknown) => ({ ok: true, status: 200, json: async () => person });
const runHandler = async (handler: Function) => {
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
  await handler({ query: { slug: "synthetic" } }, res);
  expect(res.status).not.toHaveBeenCalled();
};
const entryPaths = [
  () => runEngineForAgent("synthetic"),
  () => runAllEngineAgents(),
  () => runHandler(handleEngineRun),
  () => runHandler(handleEngineRunSingle),
  () => runHandler(handleSpPeterRun),
  () => runHandler(handleSpStevenRun),
];
const conformanceCases: Array<{ name: string; record: Record<string, unknown>; portal: boolean; metadataUsable: boolean }> = JSON.parse(
  fs.readFileSync(new URL("../../pond-nurture-bot/tests/fixtures/portal_provenance.json", import.meta.url), "utf8"),
);
const refusedPaths = conformanceCases.filter(item => item.portal || !item.metadataUsable).flatMap(item =>
  entryPaths.map((run, path) => ({ ...item, run, path })),
);

beforeEach(() => {
  vi.clearAllMocks();
  fixture.selected = { id: fixture.personId, source: "Website Form", emails: [{ value: "fixture@gmail.com" }] };
  fixture.skip.mockResolvedValue({ skip: false });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(withCompleteHistory(response({ id: fixture.personId, source: "Zillow" }))));
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function expectNoSentBookkeeping() {
  expect(fixture.smtp).not.toHaveBeenCalled();
  expect(fixture.note).not.toHaveBeenCalled();
  expect(fixture.contact).not.toHaveBeenCalled();
  expect(fixture.dedup).not.toHaveBeenCalled();
  expect(fixture.angleRecord).not.toHaveBeenCalled();
  expect(fixture.runLog).toHaveBeenCalledWith(expect.objectContaining({ sent: 0, skipped: 1, errored: 0 }));
}

describe("all lead email entry paths share the final gate", () => {
  it.each(entryPaths)("queued source change blocks path %# and every sent record", async run => {
    await run();
    expectNoSentBookkeeping();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(generateFollowUpMessage).toHaveBeenCalledWith(expect.objectContaining({ deferSentRecord: true }));
  });
  it.each(entryPaths)("fresh read failure blocks path %# without marking sent", async run => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("SYNTHETIC_READ_FAILURE"));
    await run();
    expectNoSentBookkeeping();
  });
  it("denied lead remains eligible for a later successful retry", async () => {
    expect(await runEngineForAgent("synthetic")).toEqual({ sent: 0, errored: 0, skipped: 1 });
    expectNoSentBookkeeping();
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: fixture.personId, source: "Website Form" })));
    expect(await runEngineForAgent("synthetic")).toEqual({ sent: 1, errored: 0, skipped: 0 });
    for (const fn of [fixture.smtp, fixture.note, fixture.contact, fixture.dedup, fixture.angleRecord])
      expect(fn).toHaveBeenCalledTimes(1);
  });
  it.each(refusedPaths)("fresh shared-fixture refusal leaves all sent state untouched: $name path $path", async ({ record, run }) => {
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ source: "Website", ...record, id: fixture.personId })));
    await run();
    expectNoSentBookkeeping();
    expect(fixture.update).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.filter(call => String(call[0]).includes("/events?")).length).toBe(0);
  });
  it.each(refusedPaths)("loaded shared-fixture refusal survives fresh nonportal: $name path $path", async ({ record, run }) => {
    fixture.selected = { ...fixture.selected, ...record };
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: fixture.personId, source: "Website" })));
    await run();
    expectNoSentBookkeeping();
    expect(fixture.update).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.filter(call => String(call[0]).includes("/events?")).length).toBe(0);
  });
  it("regression_d_no_email_engine_skips_without_sent_bookkeeping", async () => {
    fixture.selected = { id: 990001, source: "Website Form", emails: [] };
    expect(await runEngineForAgent("synthetic")).toEqual({ sent: 0, errored: 0, skipped: 1 });
    expectNoSentBookkeeping();
    expect(generateFollowUpMessage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.update).not.toHaveBeenCalled();
  });
  it.each(entryPaths)("no-email path %# cannot consume sent eligibility and a later address can retry", async run => {
    fixture.selected = { id: 990001, source: "Website Form", emails: [] };
    await run(); expectNoSentBookkeeping();
    expect(generateFollowUpMessage).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    fixture.selected.emails = [{ value: "fixture@gmail.com" }];
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: fixture.personId, source: "Website Form" })));
    await run();
    for (const fn of [fixture.smtp, fixture.note, fixture.contact, fixture.dedup, fixture.angleRecord])
      expect(fn).toHaveBeenCalledTimes(1);
  });
  it.each([
    { id: 990001, tags: [] }, { id: 990001, sourceUrl: "" },
    { id: true, source: "" }, { id: 990001.5, source: "" },
    { id: 990001, source: "", tags: true },
  ])("malformed fresh record preserves every sent/retry record %#", async person => {
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response(person)));
    expect(await runEngineForAgent("synthetic")).toEqual({ sent: 0, errored: 0, skipped: 1 });
    expectNoSentBookkeeping();
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: fixture.personId, source: "" })));
    expect(await runEngineForAgent("synthetic")).toEqual({ sent: 1, errored: 0, skipped: 0 });
    for (const fn of [fixture.smtp, fixture.note, fixture.contact, fixture.dedup, fixture.angleRecord])
      expect(fn).toHaveBeenCalledTimes(1);
  });
  it.each([
    { source: "Zillow" }, { source: "Website Form", leadSource: "Realtor.com" },
    { source: "", tags: ["Zillow - Synthetic"] }, { source: "Website Form", sourceUrl: "https://realtor.com" },
    { source: "Website Form", originalSource: "Zillow" }, { source: "Website Form", event: { source: "Realtor.com" } },
  ])("selection portal evidence filters before drafting %#", async provenance => {
    fixture.selected = { ...fixture.selected, ...provenance };
    expect(await runEngineForAgent("synthetic")).toEqual({ sent: 0, errored: 0, skipped: 1 });
    expectNoSentBookkeeping();
    expect(fetch).not.toHaveBeenCalled();
    expect(generateFollowUpMessage).not.toHaveBeenCalled();
  });
  it("portal reason at the pre-send skip check never writes a skipped FUB note", async () => {
    fixture.skip.mockResolvedValueOnce({ skip: true, reason: "PORTAL_SOURCE" } as any);
    await runEngineForAgent("synthetic");
    expectNoSentBookkeeping();
    expect(console.info).toHaveBeenCalledWith("PORTAL_SOURCE");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["", "Website Form", "realtor", "agent", "Realtor referral", "Agent Inquiry", "Local Realtor Committee"])("nonportal control proceeds path %#", async source => {
    fixture.selected.source = source;
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: fixture.personId, source })));
    expect(await runEngineForAgent("synthetic")).toEqual({ sent: 1, errored: 0, skipped: 0 });
    for (const fn of [fixture.smtp, fixture.note, fixture.contact, fixture.dedup, fixture.angleRecord])
      expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("internal engine email paths remain unchanged", () => {
  it("engine clock-in and clock-off never fetch a fresh person", async () => {
    await sendEngineClockinForAgent("synthetic");
    await sendEngineClockoffForAgent("synthetic");
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.smtp).toHaveBeenCalledTimes(2);
  });
  it.each([
    { provenance: { source: "Zillow" }, count: 1 },
    { provenance: { source: "Realtor.com" }, count: 1 },
    { provenance: { tags: ["Zillow - Synthetic"] }, count: 1 },
    { provenance: { source: "Zillow Rentals" }, count: 1 },
    { provenance: { tags: ["Realtor.com"] }, count: 0 },
    { provenance: { tags: ["agent"] }, count: 0 },
    { provenance: { tags: ["opt-out"] }, count: 0 },
  ])("clock-in internal queue count keeps base eligibility %#", async ({ provenance, count }) => {
    fixture.selected = { ...fixture.selected, ...provenance };
    await sendEngineClockinForAgent("synthetic");
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.smtp).toHaveBeenCalledTimes(1);
    const html = fixture.smtp.mock.calls[0][0].html;
    expect(html).toContain(`font-size:42px;font-weight:800;color:#ffffff;">${count}</p>`);
    expect(fixture.note).not.toHaveBeenCalled();
    expect(fixture.dedup).not.toHaveBeenCalled();
  });
  it("internal intro sends with mocked copy and no FUB gate", async () => {
    const { sendEngineIntroEmail } = await import("./botEngineIntro");
    expect(await sendEngineIntroEmail("synthetic")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.smtp).toHaveBeenCalledTimes(1);
    expect(fixture.update).toHaveBeenCalledTimes(1);
  });
  it("internal monitor digest with mocked health never reads current person", async () => {
    const { getDb } = await import("./db");
    vi.mocked(getDb).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const { runBotMonitor } = await import("./botMonitor");
    await runBotMonitor();
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.smtp).toHaveBeenCalledTimes(1);
  });
});

describe("candidate 3 whitespace recipient cannot produce false lead delivery", () => {
  it.each(entryPaths.flatMap((run, path) => ["", " ", "\t\n"].map(value => ({ run, path, value }))))("blank recipient path $path preserves every delivery record", async ({ run, value }) => {
    fixture.selected = { id: fixture.personId, source: "Website Form", emails: [{ value }] };
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: fixture.personId, source: "Website Form" })));
    await run(); expectNoSentBookkeeping();
    expect(generateFollowUpMessage).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(fixture.update).not.toHaveBeenCalled();
    fixture.selected.emails[0].value = "fixture@example.invalid";
    await run();
    for (const fn of [fixture.smtp, fixture.note, fixture.contact, fixture.dedup, fixture.angleRecord]) expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("candidate 4 actual engine native and history refusal preserve delivery state", () => {
  const historyPage = (events: unknown[], total = events.length, metadata: Record<string, unknown> = {}) => ({
    events, _metadata: { collection: "events", total, ...metadata },
  });
  const eventRow = (id: number, source = "Website Form") => ({ id, personId: fixture.personId, source });
  const failures = ["history-only-portal", "later-portal", "unavailable", "network-exception", "http-500", "429", "429-with-retry-after", "invalid-json", "later-failure", "partial"];
  it.each(entryPaths)("native reviewer Website Form current false->true blocks public path %# before history", async run => {
    fixture.selected.isZillowPACLead = false;
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: fixture.personId, source: "Website Form", isZillowPACLead: true })));
    await run(); expectNoSentBookkeeping(); expect(fixture.update).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls.filter(call => String(call[0]).includes("/events?")).length).toBe(0);
  });
  it.each(entryPaths.flatMap((run, path) => failures.map(failure => ({ run, path, failure }))))(
    "history $failure refusal on public path $path records zero delivery and permits retry", async ({ run, failure }) => {
      fixture.selected.isZillowPACLead = false;
      let historyReads = 0;
      vi.mocked(fetch).mockImplementation(async input => {
        if (!String(input).includes("/events?")) return response({ id: fixture.personId, source: "Website Form", isZillowPACLead: false }) as Response;
        historyReads++;
        if (failure === "history-only-portal") return response(historyPage([eventRow(1, "Zillow")])) as Response;
        if (failure === "partial") return response(historyPage([], 0, { restricted: true })) as Response;
        if (failure === "unavailable" || failure === "network-exception") throw new Error("SYNTHETIC_HISTORY_UNAVAILABLE");
        if (failure === "429" || failure === "429-with-retry-after" || failure === "http-500") return { ok: false, status: failure === "http-500" ? 500 : 429, headers: new Headers(failure === "429-with-retry-after" ? { "Retry-After": "120" } : {}) } as Response;
        if (failure === "invalid-json") return { ok: true, json: async () => { throw new Error("SYNTHETIC_JSON"); } } as unknown as Response;
        if (historyReads === 1) return response(historyPage([eventRow(1)], 2, { next: "synthetic-cursor" })) as Response;
        if (failure === "later-failure") throw new Error("SYNTHETIC_HISTORY_UNAVAILABLE");
        return response(historyPage([eventRow(2, "Realtor.com")], 2)) as Response;
      });
      await run(); expectNoSentBookkeeping(); expect(fixture.update).not.toHaveBeenCalled();
      expect(historyReads).toBe(failure.startsWith("later-") ? 2 : 1);
      expect(console.info).toHaveBeenCalledWith(failure.includes("portal") ? "PORTAL_SOURCE" : failure === "partial" ? "PORTAL_HISTORY_INCOMPLETE" : "PORTAL_HISTORY_UNAVAILABLE");
      expect(generateFollowUpMessage).toHaveBeenCalledWith(expect.objectContaining({ deferSentRecord: true }));
      vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: fixture.personId, source: "Website Form", isZillowPACLead: false })));
      await run();
      for (const fn of [fixture.smtp, fixture.note, fixture.contact, fixture.dedup, fixture.angleRecord]) expect(fn).toHaveBeenCalledTimes(1);
      expect(fixture.runLog).toHaveBeenLastCalledWith(expect.objectContaining({ sent: 1, skipped: 0, errored: 0 }));
      expect(fixture.update).not.toHaveBeenCalled();
    },
  );
  it("protected engine cadence/caps/counters remain fixed and sent-state code stays after refusal", () => {
    const engine = fs.readFileSync(new URL("./botEngine.ts", import.meta.url), "utf8");
    const refusal = engine.indexOf("if (!delivery.sent)");
    for (const marker of ["await recordDelivery?.()", "[${agent.botName}] Follow-up email sent", "await logContactedLead({", "await recordSmsSentToday(personId", "alreadySentToday.add(personId)", "sent++;"]) {
      expect(engine.indexOf(marker)).toBeGreaterThan(refusal);
    }
    expect(engine).toMatch(/if \(!delivery\.sent\) \{\s*skipped\+\+;\s*continue;/);
  });
});

describe("candidate 4 null/blank primary nextLink closure at all six actual public engine paths", () => {
  const fallbackPaths = entryPaths.flatMap((run, path) => [null, "", " \t\n"].map(next => ({ run, path, next })));
  const nextLink = `https://api.followupboss.com/v1/events?personId=${fixture.personId}&limit=100&next=cursor%20%26%20synthetic`;
  const ordinaryPage = (id: number, total: number, metadata: Record<string, unknown> = {}) => ({
    events: [{ id, personId: fixture.personId, source: "Website Form" }],
    _metadata: { collection: "events", total, ...metadata },
  });
  it.each(fallbackPaths)("primary $next terminal-link contradiction on public path $path refuses every delivery mutation and remains retry eligible", async ({ run, next }) => {
    let historyReads = 0;
    let freshReads = 0;
    vi.mocked(fetch).mockImplementation(async input => {
      if (!String(input).includes("/events?")) {
        freshReads++;
        return response({ id: fixture.personId, source: "Website Form", isZillowPACLead: false }) as Response;
      }
      historyReads++;
      return response(ordinaryPage(1, 1, { next, nextLink })) as Response;
    });
    await run();
    expectNoSentBookkeeping();
    expect(fixture.update).not.toHaveBeenCalled();
    expect(fixture.angle).not.toHaveBeenCalled();
    expect(historyReads).toBe(1); expect(freshReads).toBe(1); expect(fetch).toHaveBeenCalledTimes(2);
    expect(console.info).toHaveBeenCalledWith("PORTAL_HISTORY_INCOMPLETE");
    expect(generateFollowUpMessage).toHaveBeenCalledWith(expect.objectContaining({ deferSentRecord: true }));
    vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: fixture.personId, source: "Website Form", isZillowPACLead: false })));
    await run();
    for (const fn of [fixture.smtp, fixture.note, fixture.contact, fixture.dedup, fixture.angleRecord]) expect(fn).toHaveBeenCalledTimes(1);
    expect(fixture.runLog).toHaveBeenLastCalledWith(expect.objectContaining({ sent: 1, skipped: 0, errored: 0 }));
    expect(fixture.update).not.toHaveBeenCalled();
  });
  it.each(fallbackPaths)("primary $next valid scoped nextLink on public path $path completes two ordinary pages and sends once", async ({ run, next }) => {
    let historyReads = 0;
    let freshReads = 0;
    vi.mocked(fetch).mockImplementation(async input => {
      if (!String(input).includes("/events?")) {
        freshReads++;
        return response({ id: fixture.personId, source: "Website Form", isZillowPACLead: false }) as Response;
      }
      historyReads++;
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://api.followupboss.com/v1/events");
      expect([...url.searchParams]).toEqual(historyReads === 1
        ? [["personId", String(fixture.personId)], ["limit", "100"]]
        : [["personId", String(fixture.personId)], ["limit", "100"], ["next", "cursor & synthetic"]]);
      return response(historyReads === 1 ? ordinaryPage(1, 2, { next, nextLink }) : ordinaryPage(2, 2)) as Response;
    });
    await run();
    expect(historyReads).toBe(2); expect(freshReads).toBe(1); expect(fetch).toHaveBeenCalledTimes(3);
    for (const fn of [fixture.smtp, fixture.note, fixture.contact, fixture.dedup, fixture.angleRecord]) expect(fn).toHaveBeenCalledTimes(1);
    expect(fixture.runLog).toHaveBeenLastCalledWith(expect.objectContaining({ sent: 1, skipped: 0, errored: 0 }));
    expect(generateFollowUpMessage).toHaveBeenCalledWith(expect.objectContaining({ deferSentRecord: true }));
    expect(fixture.update).not.toHaveBeenCalled();
  });
});

describe("candidate 4 no negative history cache in actual public engine", () => {
  it.each(entryPaths)("clean first attempt then historical portal blocks public path %# with fresh reads twice and only one sent record", async run => {
    let historyReads = 0;
    let freshReads = 0;
    vi.mocked(fetch).mockImplementation(async input => {
      if (String(input).includes("/events?")) {
        historyReads++;
        return response({
          events: historyReads === 1 ? [] : [{ id: 1, personId: fixture.personId, source: "Zillow" }],
          _metadata: { collection: "events", total: historyReads === 1 ? 0 : 1 },
        }) as Response;
      }
      freshReads++;
      return response({ id: fixture.personId, source: "Website Form", isZillowPACLead: false }) as Response;
    });
    await run();
    for (const fn of [fixture.smtp, fixture.note, fixture.contact, fixture.dedup, fixture.angleRecord]) expect(fn).toHaveBeenCalledTimes(1);
    await run();
    for (const fn of [fixture.smtp, fixture.note, fixture.contact, fixture.dedup, fixture.angleRecord]) expect(fn).toHaveBeenCalledTimes(1);
    expect(freshReads).toBe(2); expect(historyReads).toBe(2); expect(fetch).toHaveBeenCalledTimes(4);
    expect(fixture.runLog).toHaveBeenLastCalledWith(expect.objectContaining({ sent: 0, skipped: 1, errored: 0 }));
    expect(fixture.update).not.toHaveBeenCalled();
  });
});

describe("candidate 4 actual engine history timeout", () => {
  it("body abort at per-page timeout refuses all SMTP/sent note/contact/angle/counter/queue sent-state and retry works", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (!String(input).includes("/events?")) return response({ id: fixture.personId, source: "Website Form" }) as Response;
        return {
          ok: true,
          json: () => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("SYNTHETIC_HISTORY_TIMEOUT")), { once: true })),
        } as unknown as Response;
      });
      const run = runEngineForAgent("synthetic");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await run).toEqual({ sent: 0, errored: 0, skipped: 1 });
      expectNoSentBookkeeping(); expect(fixture.update).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(2);
      expect(console.info).toHaveBeenCalledWith("PORTAL_HISTORY_UNAVAILABLE");
      vi.mocked(fetch).mockImplementation(withCompleteHistory(response({ id: fixture.personId, source: "Website Form" })));
      expect(await runEngineForAgent("synthetic")).toEqual({ sent: 1, errored: 0, skipped: 0 });
      for (const fn of [fixture.smtp, fixture.note, fixture.contact, fixture.dedup, fixture.angleRecord]) expect(fn).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
