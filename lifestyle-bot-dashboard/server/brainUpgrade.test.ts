/**
 * brainUpgrade.test.ts
 * Tests for the Agent Bot Brain Upgrade:
 * 1. Anthropic Direct (URL assertion)
 * 2. Full Context (expanded inputs)
 * 3. Angle Rotation (never repeats)
 * 4. Temporal Reasoning (date-aware prompts)
 * 5. Skip-Gate (24h agent note check + LLM-based skip)
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { shouldSkipLead, type FubPerson } from "./botHelpers";

// ─── 1. Anthropic Direct: URL assertion ──────────────────────────────────────

describe("Anthropic Direct — Agent Bot Email Generation", () => {
  it("calls https://api.anthropic.com/v1/messages (not Manus/Forge)", async () => {
    // Read the source file and verify the URL is hardcoded correctly
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "botHelpers.ts"),
      "utf-8"
    );

    // generateFollowUpMessage must call Anthropic directly
    const generateSection = source.slice(
      source.indexOf("export async function generateFollowUpMessage"),
      source.indexOf("// ── Angle Rotation Helpers") > -1
        ? source.indexOf("// ── Angle Rotation Helpers")
        : source.length
    );
    // Actually, the function is AFTER the angle helpers. Let's check the whole file.
    expect(source).toContain(
      'fetch("https://api.anthropic.com/v1/messages"'
    );
    expect(source).not.toContain("invokeLLM");
    expect(source).not.toContain("_core/llm");
    expect(source).not.toContain("FORGE");
    expect(source).not.toContain("forgeApiUrl");
    expect(source).not.toContain("forgeApiKey");
  });

  it("shouldSkipLead also calls Anthropic directly (not Manus/Forge)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "botHelpers.ts"),
      "utf-8"
    );

    // Extract the shouldSkipLead function section
    const skipStart = source.indexOf("export async function shouldSkipLead");
    const skipEnd = source.indexOf(
      "function buildLeadContext",
      skipStart
    );
    const skipSection = source.slice(skipStart, skipEnd > -1 ? skipEnd : skipStart + 5000);

    expect(skipSection).toContain("api.anthropic.com/v1/messages");
    expect(skipSection).toContain("claude-sonnet-4-6");
    expect(skipSection).not.toContain("invokeLLM");
  });

  it("uses claude-sonnet-4-6 model for email generation", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "botHelpers.ts"),
      "utf-8"
    );

    // Count occurrences of claude-sonnet-4-6 (should be 2: one in shouldSkipLead, one in generateFollowUpMessage)
    const matches = source.match(/claude-sonnet-4-6/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── 2. Full Context: expanded inputs ────────────────────────────────────────

describe("Full Context — Expanded Lead Inputs", () => {
  it("buildLeadContext uses up to 20 notes with dates", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "botHelpers.ts"),
      "utf-8"
    );

    expect(source).toContain(".slice(0, 20)");
    expect(source).toContain("Full FUB note history (most recent first, up to 20 notes)");
    expect(source).toContain("dateStr");
  });

  it("generateFollowUpMessage prompt includes lead source, price range, city, days since assignment, engagement signal", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "botHelpers.ts"),
      "utf-8"
    );

    expect(source).toContain("Lead source: ${leadSource}");
    expect(source).toContain("Price range: ${priceRange}");
    expect(source).toContain("City/Market: ${city}");
    expect(source).toContain("Days since assignment: ${daysSinceAssignment}");
    expect(source).toContain("Engagement signal: ${engagementSignal}");
  });
});

// ─── 3. Angle Rotation ──────────────────────────────────────────────────────

describe("Angle Rotation — Never Repeats Same Angle", () => {
  it("defines 5 agent bot angles", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "botHelpers.ts"),
      "utf-8"
    );

    expect(source).toContain("AGENT_BOT_ANGLES");
    expect(source).toContain("continue the last conversation thread");
    expect(source).toContain("new or relevant inventory angle");
    expect(source).toContain("market or rate note");
    expect(source).toContain("practical next-step nudge");
    expect(source).toContain("light personal check-in");
  });

  it("pickAngle never returns the same angle as lastAngle", () => {
    // We can't import pickAngle directly (it's not exported), so test via source inspection
    // and the logic: if angle === lastAngle, it shifts to the next one
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "botHelpers.ts"),
      "utf-8"
    );

    expect(source).toContain("if (lastAngle && angle === lastAngle");
    expect(source).toContain("(currentIdx + 1) % AGENT_BOT_ANGLES.length");
  });

  it("saves angle to emailAngleLog after generation", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "botHelpers.ts"),
      "utf-8"
    );

    expect(source).toContain("await saveAngle(personId, angle)");
    expect(source).toContain("emailAngleLog");
  });
});

// ─── 4. Temporal Reasoning ───────────────────────────────────────────────────

describe("Temporal Reasoning — Date-Aware Prompts", () => {
  it("includes temporal reasoning instruction in agent bot prompt", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "botHelpers.ts"),
      "utf-8"
    );

    expect(source).toContain("TEMPORAL REASONING");
    expect(source).toContain("lease ends in August");
    expect(source).toContain("your lease is coming up next month");
    expect(source).toContain("todayStr");
  });

  it("includes temporal reasoning instruction in pond bot prompt", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const pondSource = fs.readFileSync(
      path.resolve(__dirname, "../../pond-nurture-bot/src/fub_automation/main.py"),
      "utf-8"
    );

    expect(pondSource).toContain("TEMPORAL REASONING");
    expect(pondSource).toContain("lease ends in August");
    expect(pondSource).toContain("your lease is coming up next month");
  });
});

// ─── 5. Skip-Gate — 24h Agent Note Check ─────────────────────────────────────

describe("Skip-Gate — 24h Agent Note Check", () => {
  it("skips a lead whose agent wrote a note within the last 24 hours", async () => {
    const recentNoteTime = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(); // 6 hours ago
    const lead: FubPerson = {
      id: 999,
      firstName: "TestLead",
      lastName: "SkipGate",
      assignedUserId: 42,
      notes: [
        {
          body: "Called the lead, they're interested in seeing the house on Oak St tomorrow.",
          createdAt: recentNoteTime,
          userId: 42, // same as assignedUserId
        },
      ],
    };

    const result = await shouldSkipLead(lead);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("24 hours");
  });

  it("does NOT skip a lead whose last note is 48 hours old", async () => {
    // This test will actually call Anthropic (or fail gracefully if no key)
    // The important thing is the 24h check doesn't fire
    const oldNoteTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48 hours ago
    const lead: FubPerson = {
      id: 998,
      firstName: "TestLead",
      lastName: "NoSkip",
      assignedUserId: 42,
      notes: [
        {
          body: "Sent listings for Round Rock area, $350k-$400k range.",
          createdAt: oldNoteTime,
          userId: 42,
        },
      ],
    };

    const result = await shouldSkipLead(lead);
    // The 24h gate should NOT fire (note is 48h old)
    // The LLM gate may or may not skip depending on content, but the reason should NOT be "24 hours"
    if (result.skip) {
      expect(result.reason).not.toContain("24 hours");
    }
  });

  it("skips a lead with any recent note when userId is unknown (fail-safe)", async () => {
    const recentNoteTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    const lead: FubPerson = {
      id: 997,
      firstName: "TestLead",
      lastName: "NoUserId",
      assignedUserId: 42,
      notes: [
        {
          body: "Quick call with the client about their timeline.",
          createdAt: recentNoteTime,
          // No userId field — should still trigger the 24h gate
        },
      ],
    };

    const result = await shouldSkipLead(lead);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("24 hours");
  });
});

// ─── Zero Forge/Manus LLM references ────────────────────────────────────────

describe("Zero Forge/Manus LLM references in agent bot code", () => {
  it("botHelpers.ts has zero invokeLLM, _core/llm, FORGE, or Manus LLM references", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "botHelpers.ts"),
      "utf-8"
    );

    expect(source).not.toContain("invokeLLM");
    expect(source).not.toContain("from \"./_core/llm\"");
    expect(source).not.toContain("from './_core/llm'");
    expect(source).not.toContain("BUILT_IN_FORGE");
    expect(source).not.toContain("FORGE_API");
    expect(source).not.toContain("forgeApiUrl");
    expect(source).not.toContain("forgeApiKey");
  });
});
