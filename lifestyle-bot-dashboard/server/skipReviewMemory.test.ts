import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearDealCache,
  notesForSkipReview,
  setSkipReviewStoreForTests,
  shouldSkipLead,
  skipReviewFingerprint,
  type FubPerson,
  type SkipReviewStore,
} from "./botHelpers";

/**
 * The engine's AI skip check, remembered per version of the lead's notes
 * (2026-09 cost audit). The decision used to be forgotten, so a skipped lead
 * went back to Claude on every run while it stayed in the 3–19-day window, and
 * each re-check posted another "[Bot] Skipped automated follow-up" note that
 * the next check read as evidence.
 */

const OLD = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(); // clear of the 24h human-note gate
const HUMAN = { body: "Talked to her: they closed on a house in Leander last month.", createdAt: OLD, userId: 42 };
const BOT_SKIP = { body: "[Lexi] Skipped automated follow-up. Reason: lead bought a home", createdAt: OLD };
const BOT_SENT = { body: "[Lexi] Follow-up email sent by Steven Smith on 9/1/2026", createdAt: OLD };
const POND_SENT = { body: "Automated two-week pond nurture outreach sent.", createdAt: OLD };
const COWORK = { body: "[COWORK REENGAGE] Texted lead; replied STOP. Tagged DNC-Text.", createdAt: OLD };

function lead(notes: FubPerson["notes"]): FubPerson {
  return { id: 777, firstName: "Pat", assignedUserId: 42, notes };
}

function memoryStore(): SkipReviewStore & { rows: Map<number, { fp: string; skip: boolean; reason: string | null }> } {
  const rows = new Map<number, { fp: string; skip: boolean; reason: string | null }>();
  return {
    rows,
    async get(personId, fingerprint) {
      const row = rows.get(personId);
      return row && row.fp === fingerprint ? { shouldSkip: row.skip, reason: row.reason } : null;
    },
    async set(personId, fingerprint, shouldSkip, reason) {
      rows.set(personId, { fp: fingerprint, skip: shouldSkip, reason });
    },
  };
}

describe("which notes the AI skip check reads", () => {
  it("drops the bots' own logs and Cowork's texting notes", () => {
    const kept = notesForSkipReview([HUMAN, BOT_SKIP, BOT_SENT, POND_SENT, COWORK]);
    expect(kept).toEqual([HUMAN]);
  });

  it("fingerprint ignores bot and Cowork notes and moves with a human note", () => {
    const base = skipReviewFingerprint([HUMAN]);
    expect(skipReviewFingerprint([HUMAN, BOT_SKIP, BOT_SENT, COWORK])).toBe(base);
    expect(skipReviewFingerprint([HUMAN, { body: "Back in the market!", createdAt: OLD, userId: 42 }])).not.toBe(base);
    expect(skipReviewFingerprint([{ ...HUMAN, body: HUMAN.body + " Actually no." }])).not.toBe(base);
  });
});

describe("shouldSkipLead remembers its AI verdict", () => {
  let originalFetch: typeof global.fetch;
  let claudeCalls: number;
  let claudeAnswer: { ok: boolean; text: string };
  let store: ReturnType<typeof memoryStore>;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test-key";
    clearDealCache();
    store = memoryStore();
    setSkipReviewStoreForTests(store);
    claudeCalls = 0;
    claudeAnswer = { ok: true, text: "SKIP: YES | reason: lead bought a home" };
    originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("followupboss.com")) {
        return { ok: true, json: async () => ({ deals: [] }), text: async () => "{}" } as any;
      }
      if (u.includes("anthropic.com")) {
        claudeCalls++;
        return {
          ok: claudeAnswer.ok,
          json: async () => ({ content: [{ type: "text", text: claudeAnswer.text }] }),
          text: async () => "error",
        } as any;
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setSkipReviewStoreForTests(null);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("asks Claude once per version of the notes", async () => {
    const first = await shouldSkipLead(lead([HUMAN]));
    expect(first).toMatchObject({ skip: true, reason: "lead bought a home" });
    expect(first.remembered).toBeUndefined();
    expect(claudeCalls).toBe(1);

    // Next run: FUB now also holds the bot's own skip note — not a change.
    const second = await shouldSkipLead(lead([HUMAN, BOT_SKIP]));
    expect(second).toMatchObject({ skip: true, reason: "lead bought a home", remembered: true });
    expect(claudeCalls).toBe(1);

    const third = await shouldSkipLead(lead([HUMAN, BOT_SKIP, { body: "Deal fell through, looking again", createdAt: OLD, userId: 42 }]));
    expect(third.remembered).toBeUndefined();
    expect(claudeCalls).toBe(2);
  });

  it("a Cowork note does not reopen the decision", async () => {
    await shouldSkipLead(lead([HUMAN]));
    await shouldSkipLead(lead([HUMAN, COWORK]));
    expect(claudeCalls).toBe(1);
  });

  it("a 'send' verdict is remembered too", async () => {
    claudeAnswer = { ok: true, text: "SKIP: NO" };
    expect((await shouldSkipLead(lead([HUMAN]))).skip).toBe(false);
    expect(await shouldSkipLead(lead([HUMAN]))).toMatchObject({ skip: false, remembered: true });
    expect(claudeCalls).toBe(1);
  });

  it("a lead with only bot notes never reaches Claude", async () => {
    expect(await shouldSkipLead(lead([BOT_SKIP, BOT_SENT, POND_SENT]))).toEqual({ skip: false });
    expect(claudeCalls).toBe(0);
  });

  it("a failed Claude call is not remembered — the next run asks again", async () => {
    claudeAnswer = { ok: false, text: "" };
    expect((await shouldSkipLead(lead([HUMAN]))).skip).toBe(false);
    claudeAnswer = { ok: true, text: "SKIP: YES | reason: lead bought a home" };
    expect((await shouldSkipLead(lead([HUMAN]))).skip).toBe(true);
    expect(claudeCalls).toBe(2);
  });
});

describe("the engine loop", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const engine = readFileSync(join(here, "botEngine.ts"), "utf8");
  const loop = engine.slice(engine.indexOf("for (const person of candidates)"));

  it("checks the 3-day contact gap (a DB read) before the Claude skip check", () => {
    expect(loop.indexOf("await wasContactedRecently(personId)")).toBeGreaterThan(-1);
    expect(loop.indexOf("await wasContactedRecently(personId)")).toBeLessThan(loop.indexOf("await shouldSkipLead(person)"));
  });

  it("writes the skip note once per decision, not on a remembered verdict", () => {
    const skipBlock = loop.slice(loop.indexOf("if (skipCheck.skip)"), loop.indexOf("continue;", loop.indexOf("if (skipCheck.skip)")));
    expect(skipBlock).toContain("if (!skipCheck.remembered)");
    expect(skipBlock.indexOf("if (!skipCheck.remembered)")).toBeLessThan(skipBlock.indexOf("postFubNote("));
  });
});
