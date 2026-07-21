/**
 * agentBotBrain.test.ts — behavioral verification of the Agent Bot Brain Upgrade.
 *
 * brainUpgrade.test.ts checks the source text; these tests exercise the actual
 * functions with a mocked fetch and assert BEHAVIOR:
 *   1. generateFollowUpMessage / shouldSkipLead actually CALL
 *      https://api.anthropic.com/v1/messages with claude-sonnet-4-6 + x-api-key
 *   2. The real prompt string contains the full context (dated notes, source,
 *      price, city, days since assignment, engagement signal) and the
 *      temporal-reasoning instructions
 *   3. The 24h skip gate fires on human notes but NOT on bot-authored notes
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import {
  generateFollowUpMessage,
  shouldSkipLead,
  isBotAuthoredNote,
  clearDealCache,
  type FubPerson,
} from "./botHelpers";

/**
 * Mock fetch that handles both FUB deal check (returns empty deals) and Anthropic API calls.
 * The deal protection check (hasAnyDeal) calls FUB first, then the LLM skip-gate calls Anthropic.
 */
function mockAnthropicFetch(text: string) {
  const mockFetch = vi.fn().mockImplementation((url: string) => {
    // FUB API call for deal check — return empty deals (no protection)
    if (typeof url === "string" && url.includes("followupboss.com")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ deals: [] }),
      });
    }
    // Anthropic API call
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 40 },
      }),
    });
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

const daysAgoIso = (days: number) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test-key";
  clearDealCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Anthropic URL is actually called (spec 1)", () => {
  it("generateFollowUpMessage calls api.anthropic.com with claude-sonnet-4-6 and x-api-key", async () => {
    const mockFetch = mockAnthropicFetch(
      "SUBJECT: Those Alamo Heights listings\nHey Maria,\nDid you get a chance to look at those listings I sent?\nPeter"
    );

    const person: FubPerson = {
      id: 4242,
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

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(url).not.toContain("forge");
    expect(url).not.toContain("manus");
    expect(options.headers["x-api-key"]).toBe("sk-ant-api03-test-key");
    expect(options.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(options.body);
    expect(body.model).toBe("claude-sonnet-4-6");

    // Subject/body parsing works
    expect(result.subject).toContain("Those Alamo Heights listings");
    expect(result.body).toContain("Hey Maria,");
  });

  it("full context and temporal instructions reach the actual prompt (specs 2 + 4)", async () => {
    const mockFetch = mockAnthropicFetch("SUBJECT: s\nHey Maria,\nbody\nPeter");
    const person: FubPerson = {
      id: 4242,
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

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const prompt: string = body.messages[0].content;

    // Spec 2 — full context
    expect(prompt).toContain("Lead source: Zillow");
    expect(prompt).toContain("Price range: $400k-$450k");
    expect(prompt).toContain("City/Market: San Antonio");
    expect(prompt).toContain("Days since assignment: 45");
    expect(prompt).toContain("Engagement signal:");
    // Notes carry their dates in brackets
    expect(prompt).toContain(`[${daysAgoIso(9).slice(0, 10)}]`);
    expect(prompt).toContain("Sent 3 listings near Alamo Heights");
    // 20-note history section present
    expect(prompt).toContain("Full FUB note history");

    // Spec 4 — temporal reasoning relative to TODAY
    const todayStr = new Date().toISOString().slice(0, 10);
    expect(prompt).toContain(`Today's date is ${todayStr}`);
    expect(prompt).toContain("TEMPORAL REASONING");
    // Angle rotation instruction present (spec 3)
    expect(prompt).toContain("FRESHNESS ANGLE FOR THIS EMAIL:");
    expect(prompt).toContain("Do NOT use the same angle as last time");
  });

  it("shouldSkipLead calls api.anthropic.com for the intent check", async () => {
    const mockFetch = mockAnthropicFetch("SKIP: NO");
    const person: FubPerson = {
      id: 101,
      notes: [{ body: "Sent updated listings, waiting to hear back", createdAt: daysAgoIso(6) }],
    };
    const result = await shouldSkipLead(person);
    expect(result.skip).toBe(false);
    // Now called twice: once for FUB deal check, once for Anthropic LLM skip-gate
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Find the Anthropic call (not the FUB call)
    const anthropicCall = mockFetch.mock.calls.find((c: any[]) => String(c[0]).includes("anthropic.com"));
    expect(anthropicCall).toBeDefined();
    const [url, options] = anthropicCall!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(options.body).model).toBe("claude-sonnet-4-6");
  });

  it("generateFollowUpMessage throws (no generic fallback email) when Anthropic fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    }));
    await expect(
      generateFollowUpMessage({
        agentFirstName: "Peter",
        agentLastName: "Allen",
        leadFirstName: "Maria",
        daysStale: 8,
        stage: "Lead",
        person: { id: 1, notes: [] },
      })
    ).rejects.toThrow(/Anthropic API error 500/);
  });
});

describe("Skip gate distinguishes bot notes from human notes (spec 5)", () => {
  it("identifies bot-authored notes", () => {
    expect(isBotAuthoredNote("[S&P500 Lifestyle Bot] Follow-up email sent by Peter Allen")).toBe(true);
    expect(isBotAuthoredNote("[Abby's Lifestyle Bot] Skipped automated follow-up. Reason: x")).toBe(true);
    expect(isBotAuthoredNote("Automation: speed-to-lead warning")).toBe(true);
    expect(isBotAuthoredNote("Automated two-week pond nurture outreach sent.\n\n• Channels: EMAIL")).toBe(true);
    expect(isBotAuthoredNote("Talked to Maria — wants to see homes this weekend")).toBe(false);
    expect(isBotAuthoredNote("Left voicemail, will try again tomorrow")).toBe(false);
  });

  it("skips when a HUMAN note exists within 24h (no LLM call needed)", async () => {
    const mockFetch = mockAnthropicFetch("SKIP: NO");
    const person: FubPerson = {
      id: 99,
      assignedUserId: 42,
      notes: [{ body: "Just talked to them \u2014 showing set for Saturday", createdAt: new Date().toISOString(), userId: 42 }],
    };
    const result = await shouldSkipLead(person);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("24 hours");
    // FUB deal check is called (returns empty deals), but Anthropic LLM is NOT called
    const anthropicCalls = mockFetch.mock.calls.filter((c: any[]) => String(c[0]).includes("anthropic.com"));
    expect(anthropicCalls).toHaveLength(0);
  });

  it("does NOT treat a fresh BOT note as a human conversation", async () => {
    const mockFetch = mockAnthropicFetch("SKIP: NO");
    const person: FubPerson = {
      id: 100,
      assignedUserId: 42,
      notes: [
        // Bot noted its own send 2 hours ago \u2014 must NOT block the pipeline
        { body: "[Tiffany's Lifestyle Bot] Follow-up email sent by Tiffany", createdAt: new Date().toISOString() },
        { body: "Talked about budget", createdAt: daysAgoIso(10), userId: 42 },
      ],
    };
    const result = await shouldSkipLead(person);
    // Falls through to the LLM intent check, which says no-skip
    expect(result.skip).toBe(false);
    // Called twice: FUB deal check + Anthropic LLM skip-gate
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("skips via LLM intent check with a logged reason (bought elsewhere)", async () => {
    mockAnthropicFetch("SKIP: YES | reason: lead purchased a home elsewhere");
    const person: FubPerson = {
      id: 101,
      notes: [{ body: "They closed on a house with another builder last month", createdAt: daysAgoIso(5) }],
    };
    const result = await shouldSkipLead(person);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("purchased a home elsewhere");
  });

  it("fails open (send) when the LLM call errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const person: FubPerson = {
      id: 103,
      notes: [{ body: "Some note", createdAt: daysAgoIso(6) }],
    };
    const result = await shouldSkipLead(person);
    expect(result.skip).toBe(false);
  });
});

describe("Rule 12: no phantom prior-contact references", () => {
  it("lead with no outreach notes → generated email must not imply prior contact", async () => {
    // Mock LLM to return a clean first-touch email (simulating correct behavior)
    mockAnthropicFetch(
      "SUBJECT: Austin homes in your price range\nHey Sarah,\nI saw you're looking at homes in the Austin area around the $350k range. There are some great options right now in neighborhoods like Circle C and Buda — would you like me to send a few your way?\nPeter"
    );

    const person: FubPerson = {
      id: 5555,
      firstName: "Sarah",
      source: "Zillow",
      priceRange: "$300k-$400k",
      created: daysAgoIso(5),
      addresses: [{ city: "Austin", state: "TX" }],
      // Notes contain NO prior outreach — only a system note about lead creation
      notes: [{ body: "New lead from Zillow, looking in Austin area", createdAt: daysAgoIso(5) }],
    };

    const result = await generateFollowUpMessage({
      agentFirstName: "Peter",
      agentLastName: "Allen",
      leadFirstName: "Sarah",
      daysStale: 5,
      stage: "Lead",
      person,
    });

    // The prompt sent to the LLM must contain rule 12
    const anthropicCalls = (globalThis.fetch as any).mock.calls.filter(
      (c: any[]) => String(c[0]).includes("anthropic.com")
    );
    expect(anthropicCalls.length).toBeGreaterThan(0);
    const body = JSON.parse(anthropicCalls[0][1].body);
    const promptText = body.messages[0].content;
    expect(promptText).toContain("NEVER reference a previous email, message, call, attachment, or conversation unless it appears explicitly");

    // The generated email must NOT contain phantom prior-contact phrases
    const fullEmail = `${result.subject} ${result.body}`.toLowerCase();
    const forbiddenPhrases = [
      "the email",
      "my last message",
      "i sent",
      "we sent",
      "as i mentioned",
      "following up on",
    ];
    for (const phrase of forbiddenPhrases) {
      expect(fullEmail).not.toContain(phrase);
    }
  });
});
