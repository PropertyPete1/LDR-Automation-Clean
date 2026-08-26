/**
 * annualNurture.compliance.test.ts — audit P0-2.
 *
 * Annual nurture was the one LIVE lead-facing sender with no unsubscribe
 * language, no TREC links, and no opt-out check: a lead tagged "opt-out" who
 * still carried "Annual Nurture Only" would get the yearly email. These tests
 * mirror the Python suite's test_branding_compliance.py: the footer is pinned
 * piece by piece, and the suppression gate is driven through runAnnualNurture
 * with the same tag classes every other sender honours.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSendMail = vi.fn().mockResolvedValue({ messageId: "test-id" });
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: mockSendMail }) },
}));

const mockWriteObservation = vi.fn().mockResolvedValue(undefined);
let fakeDueLeads: any[] = [];
let fakeUpdates: any[] = [];
const fakeDb = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => fakeDueLeads }) }) }),
  update: () => ({ set: (vals: any) => ({ where: async () => { fakeUpdates.push(vals); } }) }),
};
vi.mock("./db", () => ({
  getDb: vi.fn(async () => fakeDb),
  writeObservation: (...args: any[]) => mockWriteObservation(...args),
}));

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({
      subject: "Thinking of you",
      body: "Hi there,\n\nHope all is well! If you know anyone moving to Texas, keep us in mind.\n\nPeter Allen\nLifestyle Design Realty",
    }) } }],
  }),
}));

let mockRegistrySuppressed = false;
vi.mock("./compliance", () => ({
  isLeadSuppressed: vi.fn(async () => mockRegistrySuppressed),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { runAnnualNurture, annualSuppressionVerdict } from "./annualNurture";
import {
  appendPlainTextEmailFooter,
  TREC_IABS_URL,
  TREC_CONSUMER_PROTECTION_URL,
  COMPANY_ADDRESS,
} from "./botHelpers";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fubPerson(overrides: Record<string, unknown> = {}) {
  return {
    id: 999,
    firstName: "Jamie",
    tags: ["Annual Nurture Only"],
    emails: [{ value: "jamie@example.com" }],
    ...overrides,
  };
}

function primeFub(person: Record<string, unknown>) {
  // GET /people/:id, then POST /notes (and anything after) succeed
  mockFetch.mockImplementation(async (url: string, init?: any) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => (init?.method === "POST" ? { id: 1 } : person),
  }));
}

const DUE_LEAD = {
  id: 7,
  personId: 999,
  leadName: "Jamie Example",
  email: "jamie@example.com",
  triggerSnippet: "no longer moving",
  enrolledAt: new Date("2025-01-01").toISOString(),
};

beforeEach(() => {
  mockSendMail.mockClear();
  mockWriteObservation.mockClear();
  mockFetch.mockReset();
  fakeDueLeads = [];
  fakeUpdates = [];
  mockRegistrySuppressed = false;
  process.env.SMTP_HOST = "smtp.test.com";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "test@test.com";
  process.env.SMTP_PASSWORD = "pw";
  process.env.EMAIL_FROM = "peter@lifestyledesignrealty.com";
  process.env.FUB_API_KEY = "test-key";
});

// ── The footer, piece by piece (mirror of test_branding_compliance.py) ───────

describe("appendPlainTextEmailFooter — the standard compliance footer", () => {
  const body = "Hi Jamie,\n\nJust checking in!";
  const footered = appendPlainTextEmailFooter(body);

  it("contains the TREC IABS link", () => {
    expect(footered).toContain(TREC_IABS_URL);
    expect(TREC_IABS_URL).toContain("trec.texas.gov");
  });

  it("contains the TREC Consumer Protection Notice link", () => {
    expect(footered).toContain(TREC_CONSUMER_PROTECTION_URL);
    expect(footered).toContain("TREC Consumer Protection Notice");
  });

  it("contains the unsubscribe instruction", () => {
    expect(footered).toContain("reply UNSUBSCRIBE");
  });

  it("contains the postal address", () => {
    expect(footered).toContain(COMPANY_ADDRESS);
  });

  it("contains the team wordmark and team email", () => {
    expect(footered).toContain("LIFESTYLE DESIGN REALTY");
    expect(footered).toContain("team@lifestyledesignrealty.com");
  });

  it("keeps the body first, footer after", () => {
    expect(footered.indexOf("Just checking in!")).toBeLessThan(
      footered.indexOf("LIFESTYLE DESIGN REALTY")
    );
  });
});

// ── The suppression gate, end to end through runAnnualNurture ────────────────

describe("runAnnualNurture honours the shared suppression set", () => {
  it("a lead tagged opt-out is never emailed and the enrollment is deactivated", async () => {
    fakeDueLeads = [DUE_LEAD];
    primeFub(fubPerson({ tags: ["Annual Nurture Only", "opt-out"] }));

    const result = await runAnnualNurture();

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(result.emailsSent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fakeUpdates).toContainEqual({ active: false });
    const obs = mockWriteObservation.mock.calls.map(c => c[0]);
    expect(obs.some(o => o.category === "suppressed_skip")).toBe(true);
  });

  it("Do Not Nurture and No AI Email suppress and deactivate", async () => {
    for (const tag of ["Do Not Nurture", "No AI Email", "unsubscribed", "dnc"]) {
      fakeDueLeads = [DUE_LEAD];
      fakeUpdates = [];
      mockSendMail.mockClear();
      primeFub(fubPerson({ tags: ["Annual Nurture Only", tag] }));

      await runAnnualNurture();

      expect(mockSendMail, `tag "${tag}" must suppress the send`).not.toHaveBeenCalled();
      expect(fakeUpdates, `tag "${tag}" must deactivate the enrollment`).toContainEqual({ active: false });
    }
  });

  it("FUB's own unsubscribed flag suppresses and deactivates", async () => {
    fakeDueLeads = [DUE_LEAD];
    primeFub(fubPerson({ unsubscribed: true }));

    await runAnnualNurture();

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(fakeUpdates).toContainEqual({ active: false });
  });

  it("a compliance-registry hit suppresses and deactivates", async () => {
    fakeDueLeads = [DUE_LEAD];
    mockRegistrySuppressed = true;
    primeFub(fubPerson());

    await runAnnualNurture();

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(fakeUpdates).toContainEqual({ active: false });
  });

  it("a temporary pause tag skips this run but keeps the enrollment", async () => {
    fakeDueLeads = [DUE_LEAD];
    primeFub(fubPerson({ tags: ["Annual Nurture Only", "Replied - Paused"] }));

    const result = await runAnnualNurture();

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(fakeUpdates).not.toContainEqual({ active: false });
  });

  it("a clean lead is emailed WITH the full compliance footer", async () => {
    fakeDueLeads = [DUE_LEAD];
    primeFub(fubPerson());

    const result = await runAnnualNurture();

    expect(result.emailsSent).toBe(1);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const sent = mockSendMail.mock.calls[0][0];
    expect(sent.to).toBe("jamie@example.com");
    expect(sent.text).toContain(TREC_IABS_URL);
    expect(sent.text).toContain(TREC_CONSUMER_PROTECTION_URL);
    expect(sent.text).toContain("reply UNSUBSCRIBE");
    expect(sent.text).toContain(COMPANY_ADDRESS);
    expect(sent.text.indexOf("Hi there,")).toBeLessThan(sent.text.indexOf("LIFESTYLE DESIGN REALTY"));
  });
});

// ── The verdict function's carve-out ─────────────────────────────────────────

describe("annualSuppressionVerdict", () => {
  it("does NOT treat the enrollment tag itself as a suppression", async () => {
    const verdict = await annualSuppressionVerdict(999, fubPerson(), ["annual nurture only"]);
    expect(verdict).toBeNull();
  });

  it("classifies hard opt-outs as deactivating and soft tags as skip-only", async () => {
    const hard = await annualSuppressionVerdict(999, fubPerson(), ["annual nurture only", "opt-out"]);
    expect(hard?.deactivate).toBe(true);
    const soft = await annualSuppressionVerdict(999, fubPerson(), ["annual nurture only", "manual review"]);
    expect(soft).not.toBeNull();
    expect(soft?.deactivate).toBe(false);
  });
});
