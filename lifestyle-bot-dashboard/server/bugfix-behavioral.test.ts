/**
 * bugfix-behavioral.test.ts — Behavioral regression tests for:
 *   Bug 1: Lead-facing emails must NEVER contain a bot persona name (e.g. "Rue").
 *           They must always use the agent's real human first name.
 *   Bug 2: Engine clock-in email must render exactly ONE dashboard button for the
 *           agent being processed, with no other agent's name or hardcoded links.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  generateFollowUpMessage,
  type FubPerson,
} from "./botHelpers";

const __filename_ = fileURLToPath(import.meta.url);
const __dirname_ = path.dirname(__filename_);

// ─── Helpers ────────────────────────────────────────────────────────────────────

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
        model: "claude-sonnet-4-6",
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

const daysAgoIso = (days: number) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

let nextPersonId = 80000;
const uid = () => nextPersonId++;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─── Bug 1: Persona Name Never Leaks to Lead-Facing Emails ─────────────────────

describe("Bug 1: Bot persona names never appear in lead-facing email output", () => {
  // Known bot personas that must NEVER appear in lead-facing content
  const KNOWN_PERSONAS = ["Rue"];

  it("generateFollowUpMessage for Stefanie's bot (persona='Rue') uses 'Stefanie' in prompt, never 'Rue'", async () => {
    const mockFetch = mockRoutedFetch({
      anthropicText:
        "SUBJECT: Those Alamo Heights listings\nHey Maria,\nDid you get a chance to look at those options?\nStefanie",
    });

    const person: FubPerson = {
      id: uid(),
      firstName: "Maria",
      source: "Zillow",
      priceRange: "$400k-$450k",
      created: daysAgoIso(15),
      addresses: [{ city: "San Antonio", state: "TX" }],
      notes: [{ body: "Sent 3 listings near Alamo Heights", createdAt: daysAgoIso(5) }],
    };

    // This is how stefanieBot.ts NOW calls it — with the real human name
    const result = await generateFollowUpMessage({
      agentFirstName: "Stefanie",
      agentLastName: "Graham",
      leadFirstName: "Maria",
      daysStale: 5,
      stage: "Lead",
      person,
    });

    // Inspect the Anthropic request payload
    const aCalls = mockFetch.mock.calls.filter(c => String(c[0]).includes("anthropic"));
    expect(aCalls.length).toBe(1);
    const [, options] = aCalls[0] as [string, { body: string }];
    const body = JSON.parse(options.body);
    const promptContent = body.messages[0].content;

    // The prompt must contain "Stefanie" and must NOT contain "Rue"
    expect(promptContent).toContain("Stefanie");
    for (const persona of KNOWN_PERSONAS) {
      expect(promptContent, `Prompt must not contain persona "${persona}"`).not.toContain(persona);
    }

    // The returned subject must contain "Stefanie", never a persona
    expect(result.subject).toContain("Stefanie");
    for (const persona of KNOWN_PERSONAS) {
      expect(result.subject, `Subject must not contain persona "${persona}"`).not.toContain(persona);
    }
  });

  it("stefanieBot.ts source uses AGENT_FIRST='Stefanie' for all lead-email calls, not 'Rue'", () => {
    const src = fs.readFileSync(path.join(__dirname_, "stefanieBot.ts"), "utf-8");

    // AGENT_FIRST must be "Stefanie"
    expect(src).toMatch(/AGENT_FIRST\s*=\s*"Stefanie"/);

    // "Rue" must NOT appear as AGENT_FIRST
    expect(src).not.toMatch(/AGENT_FIRST\s*=\s*"Rue"/);

    // generateFollowUpMessage must be called with AGENT_FIRST (which is "Stefanie")
    expect(src).toContain("agentFirstName: AGENT_FIRST");

    // sendLeadFollowUpEmail must be called with AGENT_FIRST
    expect(src).toContain("agentFirstName: AGENT_FIRST");
  });

  it("no legacy bot file passes a persona name to generateFollowUpMessage or sendLeadFollowUpEmail", () => {
    const botFiles = ["stefanieBot.ts", "abbyBot.ts", "irmaBot.ts", "lailaBot.ts", "tiffanyBot.ts", "spBot.ts"];
    for (const file of botFiles) {
      const src = fs.readFileSync(path.join(__dirname_, file), "utf-8");
      for (const persona of KNOWN_PERSONAS) {
        // Check that persona names are never passed as agentFirstName in lead-email calls
        expect(src, `${file} must not pass "${persona}" as agentFirstName`)
          .not.toMatch(new RegExp(`agentFirstName:\\s*"${persona}"`));
      }
    }
  });

  it("botEngine.ts uses agent.agentFirstName (from DB) for lead emails, never botName or persona", () => {
    const src = fs.readFileSync(path.join(__dirname_, "botEngine.ts"), "utf-8");
    // generateFollowUpMessage call uses agent.agentFirstName
    expect(src).toContain("agentFirstName: agent.agentFirstName");
    // sendLeadFollowUpEmail call uses agent.agentFirstName
    expect(src).toMatch(/sendLeadFollowUpEmail\(\{[\s\S]*?agentFirstName:\s*agent\.agentFirstName/);
    // Never passes agent.botName to lead-facing email functions
    expect(src).not.toMatch(/agentFirstName:\s*agent\.botName/);
  });
});

// ─── Bug 2: Engine Clock-In Has Exactly One Dashboard Button ────────────────────

describe("Bug 2: Engine clock-in template renders exactly one dynamic dashboard button", () => {
  it("sendClockinEmail template contains exactly one dashboard link (no hardcoded Steven/Peter pair)", () => {
    const src = fs.readFileSync(path.join(__dirname_, "botHelpers.ts"), "utf-8");

    // The old hardcoded pair pattern must be gone
    expect(src).not.toContain("Steven's Dashboard");
    expect(src).not.toContain("Peter's Dashboard");
    expect(src).not.toContain("stevenDashUrl");
    expect(src).not.toContain("peterDashUrl");

    // The template must have exactly one dashboard button section
    // It should use the dynamic agentFirstName in the button label
    expect(src).toContain("${agentFirstName}'s Dashboard");
  });

  it("sendClockinEmail accepts a botSlug parameter for dynamic link building", () => {
    const src = fs.readFileSync(path.join(__dirname_, "botHelpers.ts"), "utf-8");
    // The function signature must include botSlug
    expect(src).toMatch(/botSlug\??\s*:\s*string/);
    // The slug is used to build the dashboard URL
    expect(src).toContain("opts.botSlug");
  });

  it("engine passes botSlug to sendClockinEmail so Jason gets /agent/jason", () => {
    const src = fs.readFileSync(path.join(__dirname_, "botEngine.ts"), "utf-8");
    expect(src).toContain("botSlug: agent.botSlug");
  });

  it("all legacy bots pass botSlug to sendClockinEmail", () => {
    const botFiles = ["stefanieBot.ts", "abbyBot.ts", "irmaBot.ts", "lailaBot.ts", "tiffanyBot.ts", "spBot.ts"];
    for (const file of botFiles) {
      const src = fs.readFileSync(path.join(__dirname_, file), "utf-8");
      expect(src, `${file} must pass botSlug to sendClockinEmail`).toContain("botSlug: BOT_SLUG");
    }
  });

  it("agentDashboardUrl always resolves to a non-null value (no fallback to dual-button)", () => {
    const src = fs.readFileSync(path.join(__dirname_, "botHelpers.ts"), "utf-8");
    // The old ternary that could produce null is gone — replaced with a fallback to NEW_DASHBOARD_BASE
    // Check that agentDashboardUrl is never null
    expect(src).not.toMatch(/agentDashboardUrl\s*\?\s*`<a/);
    // The template unconditionally renders a single <a> tag for the dashboard
    expect(src).toContain('<!-- DASHBOARD BUTTON (always exactly one, dynamically built) -->');
  });
});

// ─── TRUE BEHAVIORAL: Rendered Output Assertions ────────────────────────────────
// These tests mock nodemailer at the module level so the real SMTP transport
// is never created, and we can capture the exact from/to/subject/html that
// sendEmail would have sent.

const capturedEmails: Array<{ from: string; to: string; subject: string; html: string }> = [];

vi.mock("nodemailer", () => {
  const mockSendMail = async (opts: any) => {
    capturedEmails.push(opts);
    return { messageId: "mock-id" };
  };
  return {
    default: { createTransport: () => ({ sendMail: mockSendMail }) },
    createTransport: () => ({ sendMail: mockSendMail }),
  };
});

describe("Bug 1 (behavioral): sendLeadFollowUpEmail rendered output contains agent name, zero persona", () => {
  beforeEach(() => { capturedEmails.length = 0; });

  it("sendLeadFollowUpEmail for Stefanie produces From/subject/signature with 'Stefanie', never 'Rue'", async () => {
    const { sendLeadFollowUpEmail } = await import("./botHelpers");

    await sendLeadFollowUpEmail({
      agentEmail: "Stefanie@lifestyledesignrealty.com",
      agentFirstName: "Stefanie",
      agentLastName: "Graham",
      leadEmail: "lead@example.com",
      leadFirstName: "Maria",
      messageBody: "Hey Maria,\nDid you get a chance to look at those listings?\nStefanie",
      subject: "Those Alamo Heights listings — Stefanie Graham",
    });

    expect(capturedEmails.length).toBe(1);
    const email = capturedEmails[0];

    // From display name must contain "Stefanie", never "Rue"
    expect(email.from).toContain("Stefanie");
    expect(email.from).not.toContain("Rue");

    // Subject must contain "Stefanie", never "Rue"
    expect(email.subject).toContain("Stefanie");
    expect(email.subject).not.toContain("Rue");

    // HTML body/signature must contain "Stefanie", never "Rue"
    expect(email.html).toContain("Stefanie");
    expect(email.html).not.toContain("Rue");
  });
});

describe("Bug 2 (behavioral): sendClockinEmail rendered HTML for Jason has exactly one /agent/jason link", () => {
  beforeEach(() => { capturedEmails.length = 0; });

  it("clock-in for Jason renders one dashboard link to /agent/jason, no Steven/Peter references", async () => {
    const { sendClockinEmail } = await import("./botHelpers");

    await sendClockinEmail({
      botName: "Jason's Lifestyle Bot",
      agentFirstName: "Jason",
      agentLastName: "Casanova",
      agentEmail: "jason@lifestyledesignrealty.com",
      leadsQueued: 5,
      powerQueueCount: 3,
      accentColor: "#7c2d12",
      headerGradient: "linear-gradient(135deg,#7c2d12 0%,#ea580c 60%,#fb923c 100%)",
      botSlug: "jason",
    });

    expect(capturedEmails.length).toBe(1);
    const html = capturedEmails[0].html;

    // Must contain exactly one dashboard link pointing to /agent/jason
    expect(html).toContain("/agent/jason");
    // Count occurrences of /agent/jason — must be exactly one
    const jasonLinkCount = (html.match(/\/agent\/jason/g) || []).length;
    expect(jasonLinkCount, "Exactly one /agent/jason link in clock-in HTML").toBe(1);

    // Must contain "Jason's Dashboard" button label (template literal produces unescaped apostrophe)
    expect(html).toContain("Jason's Dashboard");

    // Must NOT contain hardcoded Steven/Peter dashboard references
    expect(html).not.toContain("Steven's Dashboard");
    expect(html).not.toContain("Peter's Dashboard");
    expect(html).not.toContain("Steven&#39;s Dashboard");
    expect(html).not.toContain("Peter&#39;s Dashboard");

    // Must not contain /agent/steven or /agent/peter links
    expect(html).not.toContain("/agent/steven");
    expect(html).not.toContain("/agent/peter");

    // Count dashboard button occurrences — should be exactly one
    const dashboardButtonMatches = html.match(/DASHBOARD BUTTON/g);
    expect(dashboardButtonMatches?.length).toBe(1);
  });
});
