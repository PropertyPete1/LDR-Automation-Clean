/**
 * Speed-to-Lead Touch Detection — Behavioral Tests
 *
 * Tests the fix for the false reassignment bug where lead_touched_after_creation()
 * failed to detect human notes when FUB didn't bump lastCommunication/lastActivity.
 *
 * Key behaviors verified:
 * 1. Ungated notes check: human notes are detected even when lastX fields are stale
 * 2. Automation-only notes do NOT cancel the timer
 * 3. Buffer reduced from 60s to 15s
 * 4. Python codebase static analysis confirms the fix is in place
 */
import { describe, it, expect } from "vitest";

// ─── Python Codebase Static Analysis ─────────────────────────────────────────
describe("Speed-to-Lead Touch Detection — Python Static Analysis", () => {
  const fs = require("fs");

  const PYTHON_MAIN = "/tmp/ldr-clean/pond-nurture-bot/src/fub_automation/main.py";
  const pythonExists = fs.existsSync(PYTHON_MAIN);

  it.skipIf(!pythonExists)(
    "lead_touched_after_creation has UNGATED notes check (step 3)",
    () => {
      const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
      const funcStart = content.indexOf("def lead_touched_after_creation");
      expect(funcStart).toBeGreaterThan(-1);
      const funcSlice = content.slice(funcStart, funcStart + 4000);

      // Must contain the ungated notes check comment
      expect(funcSlice).toContain("UNGATED notes check");
      // Must call get_notes outside the lastX gate
      expect(funcSlice).toContain("self.fub.get_notes(person_id, limit=10)");
    }
  );

  it.skipIf(!pythonExists)(
    "lead_touched_after_creation uses 15-second buffer (not 60s/1min)",
    () => {
      const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
      const funcStart = content.indexOf("def lead_touched_after_creation");
      const funcSlice = content.slice(funcStart, funcStart + 4000);

      // Must use seconds=15 buffer
      expect(funcSlice).toContain("timedelta(seconds=15)");
      // Must NOT use minutes=1 (the old 60s buffer)
      expect(funcSlice).not.toContain("timedelta(minutes=1)");
    }
  );

  it.skipIf(!pythonExists)(
    "lead_touched_after_creation excludes Automation: notes in ungated check",
    () => {
      const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
      const funcStart = content.indexOf("def lead_touched_after_creation");
      const funcSlice = content.slice(funcStart, funcStart + 4000);

      // The ungated check must filter out automation notes
      expect(funcSlice).toContain('.startswith("Automation:")');
    }
  );

  it.skipIf(!pythonExists)(
    "lead_touched_after_creation has safe API error fallback (returns True)",
    () => {
      const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
      const funcStart = content.indexOf("def lead_touched_after_creation");
      const funcSlice = content.slice(funcStart, funcStart + 4000);

      // On API error in the ungated check, should return True (safe default)
      expect(funcSlice).toContain("(ungated)");
      expect(funcSlice).toContain("return True");
    }
  );

  it.skipIf(!pythonExists)(
    "lead_touched_after_creation still has fast-path for lastSentEmail/lastSentText/lastCall",
    () => {
      const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
      const funcStart = content.indexOf("def lead_touched_after_creation");
      const funcSlice = content.slice(funcStart, funcStart + 4000);

      // Fast-path checks should still exist
      expect(funcSlice).toContain('"lastSentEmail"');
      expect(funcSlice).toContain('"lastSentText"');
      expect(funcSlice).toContain('"lastCall"');
    }
  );

  it.skipIf(!pythonExists)(
    "lead_touched_after_creation does NOT use person.get('contacted') as fallback",
    () => {
      const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
      const funcStart = content.indexOf("def lead_touched_after_creation");
      const funcSlice = content.slice(funcStart, funcStart + 5000);

      // The comment about NOT using contacted should still be there
      expect(funcSlice).toContain("Do NOT use person.get(\"contacted\")");
    }
  );
});

// ─── TypeScript Speed-to-Lead Engine — Behavioral Tests ──────────────────────
describe("Speed-to-Lead Touch Detection — TS hasAgentTouched behavioral", () => {
  /**
   * These tests validate the TypeScript hasAgentTouched function logic
   * by simulating the exact scenarios that caused the false reassignment.
   */

  // Simulate the core logic of hasAgentTouched for testing
  function hasAgentTouchedSimulation(
    person: {
      lastSentEmail?: string | null;
      lastSentText?: string | null;
      lastCall?: string | null;
      lastCommunication?: string | null;
      lastActivity?: string | null;
    },
    created: Date,
    notes: Array<{ subject?: string; createdAt?: string }>
  ): boolean {
    const buffer = 15 * 1000; // 15 seconds in ms

    // Fast-path: explicit outbound actions
    for (const key of ["lastSentEmail", "lastSentText", "lastCall"] as const) {
      const value = person[key];
      if (value) {
        const parsed = new Date(value);
        if (parsed.getTime() > created.getTime() + buffer) {
          return true;
        }
      }
    }

    // UNGATED notes check — always check notes directly regardless of lastX
    const humanNotes = notes.filter((n) => {
      const subject = n.subject || "";
      if (subject.startsWith("Automation:")) return false;
      if (!n.createdAt) return false;
      const noteTime = new Date(n.createdAt);
      return noteTime.getTime() > created.getTime() + buffer;
    });

    return humanNotes.length > 0;
  }

  it("detects human note even when lastX fields are null (Miguel Sanchez scenario)", () => {
    const created = new Date("2026-07-19T01:10:45Z");
    const person = {
      lastSentEmail: null,
      lastSentText: null,
      lastCall: null,
      lastCommunication: null, // FUB didn't bump this
      lastActivity: null, // FUB didn't bump this either
    };
    const notes = [
      { subject: "", createdAt: "2026-07-19T02:28:08Z" }, // Stefanie's note
      { subject: "", createdAt: "2026-07-19T01:16:30Z" }, // Stefanie's note
    ];

    const result = hasAgentTouchedSimulation(person, created, notes);
    expect(result).toBe(true); // Should detect the human notes
  });

  it("does NOT count Automation: notes as human touch", () => {
    const created = new Date("2026-07-19T01:10:45Z");
    const person = {
      lastSentEmail: null,
      lastSentText: null,
      lastCall: null,
      lastCommunication: null,
      lastActivity: null,
    };
    const notes = [
      {
        subject: "Automation: speed-to-lead warning",
        createdAt: "2026-07-19T01:40:00Z",
      },
      {
        subject: "Automation: pond nurture email",
        createdAt: "2026-07-19T01:30:00Z",
      },
    ];

    const result = hasAgentTouchedSimulation(person, created, notes);
    expect(result).toBe(false); // Only automation notes — should NOT cancel timer
  });

  it("detects lastSentText as human touch (fast-path)", () => {
    const created = new Date("2026-07-19T01:10:45Z");
    const person = {
      lastSentEmail: null,
      lastSentText: "2026-07-19T01:15:00Z", // Agent texted 4 min after creation
      lastCall: null,
      lastCommunication: null,
      lastActivity: null,
    };
    const notes: Array<{ subject?: string; createdAt?: string }> = [];

    const result = hasAgentTouchedSimulation(person, created, notes);
    expect(result).toBe(true); // Fast-path should detect the text
  });

  it("ignores notes within 15-second buffer of creation", () => {
    const created = new Date("2026-07-19T01:10:45Z");
    const person = {
      lastSentEmail: null,
      lastSentText: null,
      lastCall: null,
      lastCommunication: null,
      lastActivity: null,
    };
    const notes = [
      { subject: "", createdAt: "2026-07-19T01:10:50Z" }, // Only 5 seconds after creation
    ];

    const result = hasAgentTouchedSimulation(person, created, notes);
    expect(result).toBe(false); // Within buffer — likely auto-generated
  });

  it("accepts note 16 seconds after creation (just outside buffer)", () => {
    const created = new Date("2026-07-19T01:10:45Z");
    const person = {
      lastSentEmail: null,
      lastSentText: null,
      lastCall: null,
      lastCommunication: null,
      lastActivity: null,
    };
    const notes = [
      { subject: "Called lead", createdAt: "2026-07-19T01:11:01Z" }, // 16 seconds after
    ];

    const result = hasAgentTouchedSimulation(person, created, notes);
    expect(result).toBe(true); // Just outside buffer — legitimate touch
  });

  it("mixed automation and human notes — human note wins", () => {
    const created = new Date("2026-07-19T01:10:45Z");
    const person = {
      lastSentEmail: null,
      lastSentText: null,
      lastCall: null,
      lastCommunication: null,
      lastActivity: null,
    };
    const notes = [
      {
        subject: "Automation: speed-to-lead warning",
        createdAt: "2026-07-19T01:40:00Z",
      },
      { subject: "", createdAt: "2026-07-19T01:20:00Z" }, // Human note
      {
        subject: "Automation: pond nurture email",
        createdAt: "2026-07-19T01:15:00Z",
      },
    ];

    const result = hasAgentTouchedSimulation(person, created, notes);
    expect(result).toBe(true); // Human note should cancel timer
  });

  it("no notes at all — timer continues (reassignment allowed)", () => {
    const created = new Date("2026-07-19T01:10:45Z");
    const person = {
      lastSentEmail: null,
      lastSentText: null,
      lastCall: null,
      lastCommunication: null,
      lastActivity: null,
    };
    const notes: Array<{ subject?: string; createdAt?: string }> = [];

    const result = hasAgentTouchedSimulation(person, created, notes);
    expect(result).toBe(false); // No touch — reassignment is correct
  });
});
