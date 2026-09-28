/**
 * agentBotBrain.test.ts — behavioral verification of the Agent Bot Brain Upgrade
 * and the skip-gate protection stack (deal protection, SOI, excluded sources).
 *
 * brainUpgrade.test.ts checks the source text; these tests exercise the actual
 * functions with a mocked fetch and assert BEHAVIOR:
 *   1. generateFollowUpMessage / shouldSkipLead actually CALL
 *      https://api.anthropic.com/v1/messages with claude-haiku-4-5 + x-api-key
 *   2. Deal protection actually CALLS https://api.followupboss.com/v1/deals
 *      (north-star: the "/v1deals" 404 bug class — a malformed path would fail here)
 *   3. The real prompt string contains full context + temporal reasoning
 *   4. The 24h skip gate fires on human notes but NOT on bot-authored notes
 *   5. SOI / excluded-source leads are skipped BEFORE any network call
 *   6. Zero Forge/Manus LLM references in any agent-bot code path (incl. engine)
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  generateFollowUpMessage,
  shouldSkipLead,
  isBotAuthoredNote,
  isSOISilenced,
  isExcludedSource,
  clearDealCache,
  fetchLeadsForAgent,
  HUMAN_CREATED_VIA,
  RECRUITING_SOURCES,
  isRecruitingSource,
  type FubPerson,
} from "./botHelpers";

const __filename_ = fileURLToPath(import.meta.url);
const __dirname_ = path.dirname(__filename_);

/**
 * URL-routing fetch mock: FUB calls get FUB-shaped responses, Anthropic calls
 * get an Anthropic message. Returns the mock so tests can inspect every call.
 */
function mockRoutedFetch(opts: { anthropicText?: string; fubDeals?: unknown[] }) {
  const mockFetch = vi.fn(async (url: string) => {
    if (String(url).includes("api.followupboss.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ deals: opts.fubDeals ?? [] }),
        text: async () => "",
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: opts.anthropicText ?? "SKIP: NO" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 40 },
      }),
      text: async () => "",
    };
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

const fubCalls = (mockFetch: ReturnType<typeof vi.fn>) =>
  mockFetch.mock.calls.map(c => String(c[0])).filter(u => u.includes("followupboss"));
const anthropicCalls = (mockFetch: ReturnType<typeof vi.fn>) =>
  mockFetch.mock.calls.map(c => String(c[0])).filter(u => u.includes("anthropic"));

const daysAgoIso = (days: number) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

let nextPersonId = 90000;
const uid = () => nextPersonId++; // unique ids so the 10-min deal cache never crosses tests

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test-key";
  clearDealCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Anthropic URL is actually called (spec 1)", () => {
  it("generateFollowUpMessage calls api.anthropic.com with claude-haiku-4-5 and x-api-key", async () => {
    const mockFetch = mockRoutedFetch({
      anthropicText:
        "SUBJECT: Those Alamo Heights listings\nHey Maria,\nDid you get a chance to look at those listings I sent?\nPeter",
    });

    const person: FubPerson = {
      id: uid(),
      firstName: "Maria",
      source: "Zillow",
      priceRange: "$400k-$450k",
      created: daysAgoIso(45),
      addresses: [{ city: "San Antonio", state: "TX" }],
      notes: [{ body: "Sent 3 listings near Alamo Heights", createdAt: daysAgoIso(9) }],
    };

    const result = await generateFollowUpMessage({
      agentFirstName: "Peter",
      agentLastName: "Allen",
      leadFirstName: "Maria",
      daysStale: 8,
      stage: "Lead",
      person,
    });

    const aCalls = mockFetch.mock.calls.filter(c => String(c[0]).includes("anthropic"));
    expect(aCalls.length).toBe(1);
    const [url, options] = aCalls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(options.headers["x-api-key"]).toBe("sk-ant-api03-test-key");
    expect(options.headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(options.body).model).toBe("claude-haiku-4-5");

    expect(result.subject).toContain("Those Alamo Heights listings");
    expect(result.body).toContain("Hey Maria,");
  });

  it("full context and temporal instructions reach the actual prompt (specs 2 + 4)", async () => {
    const mockFetch = mockRoutedFetch({ anthropicText: "SUBJECT: s\nHey Maria,\nbody\nPeter" });
    const person: FubPerson = {
      id: uid(),
      firstName: "Maria",
      source: "Zillow",
      priceRange: "$400k-$450k",
      created: daysAgoIso(45),
      addresses: [{ city: "San Antonio", state: "TX" }],
      notes: [
        { body: "Sent 3 listings near Alamo Heights", createdAt: daysAgoIso(9) },
        { body: "Call — wants 3BR, lease ends in October", createdAt: daysAgoIso(40) },
      ],
    };

    await generateFollowUpMessage({
      agentFirstName: "Peter",
      agentLastName: "Allen",
      leadFirstName: "Maria",
      daysStale: 8,
      stage: "Lead",
      person,
    });

    const aCall = mockFetch.mock.calls.find(c => String(c[0]).includes("anthropic"))!;
    const body = JSON.parse((aCall[1] as { body: string }).body);
    const prompt: string = body.messages[0].content;

    expect(prompt).toContain("Lead source: Zillow");
    expect(prompt).toContain("Price range: $400k-$450k");
    expect(prompt).toContain("City/Market: San Antonio");
    expect(prompt).toContain("Days since assignment: 45");
    expect(prompt).toContain("Engagement signal:");
    expect(prompt).toContain(`[${daysAgoIso(9).slice(0, 10)}]`);
    expect(prompt).toContain("Full FUB note history");

    const todayStr = new Date().toISOString().slice(0, 10);
    expect(prompt).toContain(`Today's date is ${todayStr}`);
    expect(prompt).toContain("TEMPORAL REASONING");
    expect(prompt).toContain("FRESHNESS ANGLE FOR THIS EMAIL:");
    // Rule 12 anti-phantom class: never invent prior outreach absent from notes
    expect(prompt).toMatch(/NEVER (claim|reference)[\s\S]*?(sent|outreach|contact)/i);
  });

  it("shouldSkipLead calls the FUB /v1/deals URL, then api.anthropic.com (north-star path test)", async () => {
    const mockFetch = mockRoutedFetch({ anthropicText: "SKIP: NO", fubDeals: [] });
    const person: FubPerson = {
      id: uid(),
      notes: [{ body: "Sent updated listings, waiting to hear back", createdAt: daysAgoIso(6) }],
    };
    const result = await shouldSkipLead(person);
    expect(result.skip).toBe(false);

    // North-star assertion: the deals call must be the EXACT well-formed path.
    // The historical bug built "deals" (no slash) → /v1deals → 404 → silent fail-open.
    const fub = fubCalls(mockFetch);
    expect(fub.length).toBeGreaterThanOrEqual(1);
    for (const u of fub) {
      expect(u).toContain("https://api.followupboss.com/v1/deals?personId=");
      expect(u).not.toContain("/v1deals");
    }
    expect(anthropicCalls(mockFetch)).toEqual(["https://api.anthropic.com/v1/messages"]);
  });

  it("a lead WITH a deal is skipped after the /v1/deals call — no LLM call made", async () => {
    const mockFetch = mockRoutedFetch({
      fubDeals: [{ id: 1, pipelineId: 1, stageName: "Active", pipelineName: "Buyers" }],
    });
    const person: FubPerson = {
      id: uid(),
      notes: [{ body: "Great showing last week", createdAt: daysAgoIso(5) }],
    };
    const result = await shouldSkipLead(person);
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/deal/i);
    expect(anthropicCalls(mockFetch).length).toBe(0);
  });

  it("generateFollowUpMessage throws (no generic fallback email) when Anthropic fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("followupboss")) {
        return { ok: true, status: 200, json: async () => ({ deals: [] }), text: async () => "" };
      }
      return { ok: false, status: 500, text: async () => "boom", json: async () => ({}) };
    }));
    await expect(
      generateFollowUpMessage({
        agentFirstName: "Peter",
        agentLastName: "Allen",
        leadFirstName: "Maria",
        daysStale: 8,
        stage: "Lead",
        person: { id: uid(), notes: [] },
      })
    ).rejects.toThrow(/Anthropic API error 500/);
  });
});

describe("Skip gate distinguishes bot notes from human notes (spec 5)", () => {
  it("identifies bot-authored notes", () => {
    expect(isBotAuthoredNote("[S&P500 Lifestyle Bot] Follow-up email sent by Peter Allen")).toBe(true);
    expect(isBotAuthoredNote("[Jason's Lifestyle Bot] Skipped automated follow-up. Reason: x")).toBe(true);
    expect(isBotAuthoredNote("Automation: speed-to-lead warning")).toBe(true);
    expect(isBotAuthoredNote("Automated two-week pond nurture outreach sent.\n\n• Channels: EMAIL")).toBe(true);
    expect(isBotAuthoredNote("Talked to Maria — wants to see homes this weekend")).toBe(false);
    expect(isBotAuthoredNote("Left voicemail, will try again tomorrow")).toBe(false);
  });

  it("skips when a HUMAN note exists within 24h (deals checked, but no LLM call)", async () => {
    const mockFetch = mockRoutedFetch({ fubDeals: [] });
    const person: FubPerson = {
      id: uid(),
      assignedUserId: 42,
      notes: [{ body: "Just talked to them — showing set for Saturday", createdAt: new Date().toISOString(), userId: 42 }],
    };
    const result = await shouldSkipLead(person);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("24 hours");
    expect(anthropicCalls(mockFetch).length).toBe(0);
  });

  it("does NOT treat a fresh BOT note as a human conversation", async () => {
    const mockFetch = mockRoutedFetch({ anthropicText: "SKIP: NO", fubDeals: [] });
    const person: FubPerson = {
      id: uid(),
      assignedUserId: 42,
      notes: [
        { body: "[Tiffany's Lifestyle Bot] Follow-up email sent by Tiffany", createdAt: new Date().toISOString() },
        { body: "Talked about budget", createdAt: daysAgoIso(10), userId: 42 },
      ],
    };
    const result = await shouldSkipLead(person);
    // Falls through to the LLM intent check, which says no-skip
    expect(result.skip).toBe(false);
    expect(anthropicCalls(mockFetch).length).toBe(1);
  });

  it("skips via LLM intent check with a logged reason (bought elsewhere)", async () => {
    mockRoutedFetch({ anthropicText: "SKIP: YES | reason: lead purchased a home elsewhere", fubDeals: [] });
    const person: FubPerson = {
      id: uid(),
      notes: [{ body: "They closed on a house with another builder last month", createdAt: daysAgoIso(5) }],
    };
    const result = await shouldSkipLead(person);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("purchased a home elsewhere");
  });

  it("fails open (send) when the LLM call errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("followupboss")) {
        return { ok: true, status: 200, json: async () => ({ deals: [] }), text: async () => "" };
      }
      throw new Error("network down");
    }));
    const person: FubPerson = {
      id: uid(),
      notes: [{ body: "Some note", createdAt: daysAgoIso(6) }],
    };
    const result = await shouldSkipLead(person);
    expect(result.skip).toBe(false);
  });
});

describe("SOI + excluded-source total silence (engine protection inheritance)", () => {
  it("an SOI lead (source \"Theo's SOI\") is skipped with NO network calls at all", async () => {
    const mockFetch = mockRoutedFetch({});
    const person: FubPerson = {
      id: uid(),
      source: "Theo's SOI",
      notes: [{ body: "Nice lead", createdAt: daysAgoIso(5) }],
    };
    const result = await shouldSkipLead(person);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("soi_silenced");
    expect(mockFetch.mock.calls.length).toBe(0); // cheap local check — zero API calls
  });

  it("SOI rule set matches spec (tag prefix, source contains, manual non-Peter creation)", () => {
    expect(isSOISilenced({ id: 1, tags: ["SOI - Church"] })).toBeTruthy();
    expect(isSOISilenced({ id: 2, source: "Tiffany SOI list" })).toBeTruthy();
    expect(isSOISilenced({ id: 3, createdVia: "Manually", createdById: 7 })).toBeTruthy();
    // Control: Peter-created API/Typeform lead flows normally
    expect(isSOISilenced({ id: 4, createdVia: "API", createdById: 2, source: "Typeform" })).toBeNull();
    expect(isSOISilenced({ id: 5, createdVia: "Manually", createdById: 2 })).toBeNull();
  });

  it("a 'New Agent Inquiry' source lead is skipped with a logged reason and no API calls", async () => {
    const mockFetch = mockRoutedFetch({});
    const person: FubPerson = {
      id: uid(),
      source: "New Agent Inquiry",
      notes: [{ body: "note", createdAt: daysAgoIso(5) }],
    };
    const result = await shouldSkipLead(person);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("excluded source");
    expect(mockFetch.mock.calls.length).toBe(0);
    // Case-insensitive
    expect(isExcludedSource({ id: 1, source: "BOTM NEWSLETTER" })).toBeTruthy();
  });

  it("a clean company lead flows through the whole gate to a send decision", async () => {
    const mockFetch = mockRoutedFetch({ anthropicText: "SKIP: NO", fubDeals: [] });
    const person: FubPerson = {
      id: uid(),
      source: "Zillow",
      createdVia: "API",
      createdById: 2,
      notes: [{ body: "Sent listings, awaiting reply", createdAt: daysAgoIso(6) }],
    };
    const result = await shouldSkipLead(person);
    expect(result.skip).toBe(false);
    expect(fubCalls(mockFetch).length).toBeGreaterThanOrEqual(1); // deals checked
    expect(anthropicCalls(mockFetch).length).toBe(1); // LLM consulted
  });
});

describe("SOI rule 1 covers every human channel (Peter's rule of 2026-09-28)", () => {
  // FUB records the channel in createdVia — "Manually" for the web UI and the
  // mobile app, "Import" for a spreadsheet — and the person in createdById.
  // The account carries exactly four values: API, Email Parsing, Import,
  // Manually (read-only census, Actions run 36367093517, 7,746 contacts).
  const STEVEN = 1;
  const PETER = 2;
  const LAILA = 35;

  it("an agent's manual add is silenced, whatever the source", () => {
    const why = isSOISilenced({ id: 1, createdVia: "Manually", createdById: STEVEN, source: "<unspecified>" });
    expect(why).toContain("createdVia=Manually");
    expect(why).toContain("createdById=1");
    expect(isSOISilenced({ id: 2, createdVia: "Manually", createdById: LAILA, source: "Zillow" })).toBeTruthy();
  });

  it("an agent's spreadsheet import with a blank source is silenced (the gap this closes)", () => {
    expect(isSOISilenced({ id: 3, createdVia: "Import", createdById: STEVEN })).toContain("createdVia=Import");
    expect(isSOISilenced({ id: 4, createdVia: "Import", createdById: STEVEN, source: "" })).toBeTruthy();
    // FUB spells a blank source "<unspecified>"
    expect(isSOISilenced({ id: 5, createdVia: "Import", createdById: STEVEN, source: "<unspecified>" })).toBeTruthy();
    // ...and a typed (non-recruiting) source changes nothing
    expect(isSOISilenced({ id: 6, createdVia: "IMPORT", createdById: STEVEN, source: "Open House" })).toBeTruthy();
  });

  it("a mobile-app add — recorded like a web-UI add: Manually, by the agent, source <unspecified> — is silenced", () => {
    expect(isSOISilenced({ id: 7, createdVia: "Manually", createdById: LAILA, source: "<unspecified>", tags: [] })).toBeTruthy();
  });

  it("Peter's own adds and imports are not silenced", () => {
    expect(isSOISilenced({ id: 8, createdVia: "Manually", createdById: PETER })).toBeNull();
    expect(isSOISilenced({ id: 9, createdVia: "Import", createdById: PETER, source: "Open House" })).toBeNull();
  });

  it("API and Email Parsing leads are not silenced — no person added them", () => {
    expect(isSOISilenced({ id: 10, createdVia: "API", createdById: PETER, source: "Typeform Link" })).toBeNull();
    expect(isSOISilenced({ id: 11, createdVia: "API", createdById: STEVEN, source: "lifestyledesignrealty.com" })).toBeNull();
    expect(isSOISilenced({ id: 12, createdVia: "Email Parsing", createdById: -1, source: "Realtor.com - Rental" })).toBeNull();
    expect(isSOISilenced({ id: 13, createdVia: null, createdById: STEVEN })).toBeNull();
    // The default /people payload has createdVia but no createdById: no verdict
    expect(isSOISilenced({ id: 14, createdVia: "Import", createdById: null })).toBeNull();
    expect(isSOISilenced({ id: 15, createdVia: "Import" })).toBeNull();
  });

  it("HUMAN_CREATED_VIA names exactly the two human channels", () => {
    expect([...HUMAN_CREATED_VIA].sort()).toEqual(["import", "manually"]);
  });

  it("shouldSkipLead refuses an agent's import before any network call", async () => {
    const mockFetch = mockRoutedFetch({});
    const person: FubPerson = {
      id: uid(),
      createdVia: "Import",
      createdById: STEVEN,
      source: "<unspecified>",
      notes: [{ body: "Call back next week", createdAt: daysAgoIso(4) }],
    };
    const result = await shouldSkipLead(person);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("soi_silenced");
    expect(result.reason).toContain("createdVia=Import");
    expect(mockFetch.mock.calls.length).toBe(0);
  });

  it("carve-out: an agent-imported recruiting-source contact is not SOI (keeps the recruiting track) yet the agent bots still refuse it", async () => {
    const recruit: FubPerson = {
      id: uid(),
      createdVia: "Import",
      createdById: STEVEN,
      source: "Agent Scouting",
      notes: [],
    };
    expect(isRecruitingSource(recruit)).toBe("Agent Scouting");
    expect(isSOISilenced(recruit)).toBeNull();
    // CONTAINS, like excluded sources — and both recruiting sources
    expect(isSOISilenced({ ...recruit, id: uid(), source: "Agent Scouting - LinkedIn" })).toBeNull();
    expect(isSOISilenced({ ...recruit, id: uid(), source: "New Agent Inquiry" })).toBeNull();
    // Every lead path here (the agent bots) still blocks it: excluded source, before any network call
    const mockFetch = mockRoutedFetch({});
    const result = await shouldSkipLead(recruit);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("excluded source");
    expect(mockFetch.mock.calls.length).toBe(0);
  });

  it("the carve-out stops at the Import channel: a recruit added by hand, an SOI-tagged recruit and a non-recruit import stay silent", () => {
    expect(isSOISilenced({ id: 1, createdVia: "Manually", createdById: STEVEN, source: "New Agent Inquiry" })).toBeTruthy();
    expect(isSOISilenced({ id: 2, createdVia: "Import", createdById: STEVEN, source: "Agent Scouting", tags: ["SOI"] })).toBeTruthy();
    expect(isSOISilenced({ id: 3, createdVia: "Import", createdById: STEVEN, source: "<unspecified>" })).toBeTruthy();
    expect(isSOISilenced({ id: 4, createdVia: "Import", createdById: PETER, source: "Agent Scouting" })).toBeNull();
    expect(isRecruitingSource({ id: 5, source: "Zillow" })).toBeNull();
    expect(isRecruitingSource({ id: 6 })).toBeNull();
  });

  it("RECRUITING_SOURCES mirrors rules.yaml recruiting_sources", () => {
    expect([...RECRUITING_SOURCES].sort()).toEqual(["Agent Scouting", "New Agent Inquiry"]);
  });

  it("fetchLeadsForAgent asks FUB for fields=allFields — the default payload never carries createdById", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ people: [], _metadata: {} }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", mockFetch);
    await fetchLeadsForAgent(STEVEN);
    expect(mockFetch.mock.calls.length).toBe(1);
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain("https://api.followupboss.com/v1/people?");
    expect(url).toContain(`assignedUserId=${STEVEN}`);
    expect(url).toContain("includeNotes=true");
    expect(url).toContain("fields=allFields");
  });
});

describe("Engine wiring + zero Forge references (launch guard)", () => {
  it("botEngine routes through the audited pipeline (isEligible, shouldSkipLead, generateFollowUpMessage, sendLeadFollowUpEmail)", () => {
    const src = fs.readFileSync(path.join(__dirname_, "botEngine.ts"), "utf-8");
    for (const fn of ["isEligible", "shouldSkipLead", "generateFollowUpMessage", "sendLeadFollowUpEmail", "wasContactedRecently", "recordSmsSentToday"]) {
      expect(src, `botEngine.ts must use ${fn}`).toContain(fn);
    }
    expect(src).toContain("LEGACY_BOT_SLUGS");
  });

  it("agent-bot code paths contain zero Forge/BUILT_IN/manus.im LLM references", () => {
    const llmPathFiles = [
      "botHelpers.ts",
      "botEngine.ts",
      "botEngineIntro.ts",
      "botMonitor.ts",
      "scheduledHandlers.ts",
      "_core/llm.ts",
    ];
    for (const file of llmPathFiles) {
      const src = fs.readFileSync(path.join(__dirname_, file), "utf-8");
      expect(src, `${file} must not reference the Forge LLM host`).not.toMatch(/forge\.manus\.im/i);
      expect(src, `${file} must not reference BUILT_IN env keys`).not.toMatch(/BUILT_IN/);
      expect(src, `${file} must not reference manus.im`).not.toMatch(/manus\.im/);
    }
    const llmSrc = fs.readFileSync(path.join(__dirname_, "_core/llm.ts"), "utf-8");
    expect(llmSrc).toContain("https://api.anthropic.com/v1/messages");
    expect(llmSrc).toContain("claude-haiku-4-5");
  });

  it("all legacy bot files have been deleted — engine is the sole execution path", () => {
    const deletedFiles = ["spBot.ts", "tiffanyBot.ts", "stefanieBot.ts", "abbyBot.ts", "irmaBot.ts", "lailaBot.ts"];
    for (const file of deletedFiles) {
      expect(
        fs.existsSync(path.join(__dirname_, file)),
        `${file} must be deleted (legacy code removed)`
      ).toBe(false);
    }
  });
});
