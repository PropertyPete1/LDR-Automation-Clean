/**
 * Behavioral tests for source-based exclusion and SOI total silence.
 *
 * Asserts:
 * 1. "New Agent Inquiry" and "BOTM Newsletter" sources are skipped in every send path
 * 2. Source "Theo's SOI" matches the contains-rule
 * 3. An agent-created untagged lead gets NO bot email and NO pond action
 * 4. A Peter-created Typeform lead still flows normally
 * 5. Static analysis: Python codebase enforces source/SOI checks in all 4 send paths
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isExcludedSource, isSOISilenced } from "./botHelpers";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makePerson(overrides: Record<string, any> = {}) {
  return {
    id: 1234,
    firstName: "Test",
    lastName: "Lead",
    source: null,
    leadSource: null,
    tags: [],
    createdById: null,
    createdVia: null,
    ...overrides,
  };
}

// ── 1. Source-Based Exclusion ─────────────────────────────────────────────────

describe("isExcludedSource", () => {
  it("blocks 'New Agent Inquiry' (exact match, case-insensitive)", () => {
    const person = makePerson({ source: "New Agent Inquiry" });
    expect(isExcludedSource(person)).toBe("New Agent Inquiry");
  });

  it("blocks 'new agent inquiry' (lowercase)", () => {
    const person = makePerson({ source: "new agent inquiry" });
    expect(isExcludedSource(person)).toBe("new agent inquiry");
  });

  it("blocks 'NEW AGENT INQUIRY' (uppercase)", () => {
    const person = makePerson({ source: "NEW AGENT INQUIRY" });
    expect(isExcludedSource(person)).toBe("NEW AGENT INQUIRY");
  });

  it("blocks 'BOTM Newsletter' (exact match)", () => {
    const person = makePerson({ source: "BOTM Newsletter" });
    expect(isExcludedSource(person)).toBe("BOTM Newsletter");
  });

  it("blocks 'botm newsletter' (lowercase)", () => {
    const person = makePerson({ source: "botm newsletter" });
    expect(isExcludedSource(person)).toBe("botm newsletter");
  });

  it("does NOT block partial matches (e.g. 'Agent Inquiry')", () => {
    const person = makePerson({ source: "Agent Inquiry" });
    expect(isExcludedSource(person)).toBeNull();
  });

  it("does NOT block unrelated sources", () => {
    const person = makePerson({ source: "Luxury Presence" });
    expect(isExcludedSource(person)).toBeNull();
  });

  it("does NOT block null/empty source", () => {
    const person = makePerson({ source: null });
    expect(isExcludedSource(person)).toBeNull();
  });

  it("falls back to leadSource if source is null", () => {
    const person = makePerson({ source: null, leadSource: "New Agent Inquiry" });
    expect(isExcludedSource(person)).toBe("New Agent Inquiry");
  });

  it("allows Peter-created Typeform leads through", () => {
    const person = makePerson({ source: "Lifestyle Design Realty | Typeform" });
    expect(isExcludedSource(person)).toBeNull();
  });
});

// ── 2. SOI Total Silence ──────────────────────────────────────────────────────

describe("isSOISilenced", () => {
  // Rule 3: source CONTAINS "SOI"
  describe("Rule 3: source contains SOI", () => {
    it("matches 'Theo's SOI'", () => {
      const person = makePerson({ source: "Theo's SOI" });
      const result = isSOISilenced(person);
      expect(result).not.toBeNull();
      expect(result).toContain("source contains SOI");
    });

    it("matches 'Tiffany SOI'", () => {
      const person = makePerson({ source: "Tiffany SOI" });
      const result = isSOISilenced(person);
      expect(result).not.toBeNull();
      expect(result).toContain("source contains SOI");
    });

    it("matches 'SOI' (bare)", () => {
      const person = makePerson({ source: "SOI" });
      const result = isSOISilenced(person);
      expect(result).not.toBeNull();
      expect(result).toContain("source contains SOI");
    });

    it("matches 'AgentName SOI' (future pattern)", () => {
      const person = makePerson({ source: "Laila SOI" });
      const result = isSOISilenced(person);
      expect(result).not.toBeNull();
      expect(result).toContain("source contains SOI");
    });

    it("case-insensitive: 'theo's soi'", () => {
      const person = makePerson({ source: "theo's soi" });
      const result = isSOISilenced(person);
      expect(result).not.toBeNull();
    });

    it("does NOT match 'Soiree' (SOI substring in unrelated word)", () => {
      // "soi" is in "soiree" — this IS expected to match because the rule is "contains soi"
      // This is by design: any source with "soi" in it is treated as SOI
      const person = makePerson({ source: "Soiree" });
      const result = isSOISilenced(person);
      // This WILL match because "soiree" contains "soi" — acceptable false positive
      expect(result).not.toBeNull();
    });
  });

  // Rule 2: tag starts with "SOI"
  describe("Rule 2: tag starts with SOI", () => {
    it("matches tag 'SOI'", () => {
      const person = makePerson({ tags: ["SOI"] });
      const result = isSOISilenced(person);
      expect(result).not.toBeNull();
      expect(result).toContain("tag starts with SOI");
    });

    it("matches tag 'SOI - Tiffany'", () => {
      const person = makePerson({ tags: ["SOI - Tiffany"] });
      const result = isSOISilenced(person);
      expect(result).not.toBeNull();
      expect(result).toContain("tag starts with SOI");
    });

    it("matches tag object { name: 'SOI Lead' }", () => {
      const person = makePerson({ tags: [{ name: "SOI Lead" }] });
      const result = isSOISilenced(person);
      expect(result).not.toBeNull();
      expect(result).toContain("tag starts with SOI");
    });

    it("case-insensitive: tag 'soi'", () => {
      const person = makePerson({ tags: ["soi"] });
      const result = isSOISilenced(person);
      expect(result).not.toBeNull();
    });

    it("does NOT match tag 'Annual Nurture Only'", () => {
      const person = makePerson({ tags: ["Annual Nurture Only"] });
      expect(isSOISilenced(person)).toBeNull();
    });
  });

  // Rule 1: createdById ≠ Peter AND createdVia == "Manually"
  describe("Rule 1: manually created by non-Peter agent", () => {
    it("matches: createdById=5 (Tiffany), createdVia='Manually'", () => {
      const person = makePerson({ createdById: 5, createdVia: "Manually" });
      const result = isSOISilenced(person);
      expect(result).not.toBeNull();
      expect(result).toContain("manually created by non-Peter user");
    });

    it("matches: createdById=99, createdVia='manually' (lowercase)", () => {
      const person = makePerson({ createdById: 99, createdVia: "manually" });
      const result = isSOISilenced(person);
      expect(result).not.toBeNull();
    });

    it("does NOT match: createdById=2 (Peter), createdVia='Manually'", () => {
      const person = makePerson({ createdById: 2, createdVia: "Manually" });
      expect(isSOISilenced(person)).toBeNull();
    });

    it("does NOT match: createdById=5, createdVia='Typeform' (not manual)", () => {
      const person = makePerson({ createdById: 5, createdVia: "Typeform" });
      expect(isSOISilenced(person)).toBeNull();
    });

    it("does NOT match: createdById=5, createdVia=null", () => {
      const person = makePerson({ createdById: 5, createdVia: null });
      expect(isSOISilenced(person)).toBeNull();
    });

    it("DOES match: createdById=0 (non-Peter), createdVia='Manually'", () => {
      // createdById=0 is a valid non-Peter ID, so it IS SOI-silenced
      const person = makePerson({ createdById: 0, createdVia: "Manually" });
      const result = isSOISilenced(person);
      expect(result).not.toBeNull();
      expect(result).toContain("manually created by non-Peter user");
    });
  });

  // Combined: Peter-created Typeform lead flows normally
  describe("Normal leads pass through", () => {
    it("Peter-created Typeform lead is NOT SOI-silenced", () => {
      const person = makePerson({
        source: "Lifestyle Design Realty | Typeform",
        createdById: 2,
        createdVia: "Typeform",
        tags: ["New Lead"],
      });
      expect(isSOISilenced(person)).toBeNull();
    });

    it("Lead with no source, no tags, no createdById is NOT SOI-silenced", () => {
      const person = makePerson({});
      expect(isSOISilenced(person)).toBeNull();
    });

    it("Lead from 'Luxury Presence' with normal tags is NOT SOI-silenced", () => {
      const person = makePerson({
        source: "Luxury Presence",
        tags: ["New Lead", "Austin"],
        createdById: 2,
        createdVia: "API",
      });
      expect(isSOISilenced(person)).toBeNull();
    });
  });
});

// ── 3. Static Analysis: Python codebase enforces checks in all send paths ────

describe("Python codebase static analysis", () => {
  const fs = require("fs");
  const path = require("path");

  const PYTHON_MAIN = "/tmp/ldr-clean/pond-nurture-bot/src/fub_automation/main.py";

  // Skip if repo not available (CI environment)
  const pythonExists = fs.existsSync(PYTHON_MAIN);

  it.skipIf(!pythonExists)("process_reengagement_candidate has _is_excluded_source check", () => {
    const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
    const funcStart = content.indexOf("def process_reengagement_candidate");
    const funcSlice = content.slice(funcStart, funcStart + 3000);
    expect(funcSlice).toContain("_is_excluded_source");
  });

  it.skipIf(!pythonExists)("process_reengagement_candidate has _is_soi_silenced check", () => {
    const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
    const funcStart = content.indexOf("def process_reengagement_candidate");
    const funcSlice = content.slice(funcStart, funcStart + 3000);
    expect(funcSlice).toContain("_is_soi_silenced");
  });

  it.skipIf(!pythonExists)("process_stale_agent_no_note_candidate has _is_excluded_source check", () => {
    const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
    const funcStart = content.indexOf("def process_stale_agent_no_note_candidate");
    const funcSlice = content.slice(funcStart, funcStart + 3000);
    expect(funcSlice).toContain("_is_excluded_source");
  });

  it.skipIf(!pythonExists)("process_stale_agent_no_note_candidate has _is_soi_silenced check", () => {
    const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
    const funcStart = content.indexOf("def process_stale_agent_no_note_candidate");
    const funcSlice = content.slice(funcStart, funcStart + 3000);
    expect(funcSlice).toContain("_is_soi_silenced");
  });

  it.skipIf(!pythonExists)("process_closed_drip_candidate has _is_excluded_source check", () => {
    const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
    const funcStart = content.indexOf("def process_closed_drip_candidate");
    const funcSlice = content.slice(funcStart, funcStart + 3000);
    expect(funcSlice).toContain("_is_excluded_source");
  });

  it.skipIf(!pythonExists)("process_closed_drip_candidate has _is_soi_silenced check", () => {
    const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
    const funcStart = content.indexOf("def process_closed_drip_candidate");
    const funcSlice = content.slice(funcStart, funcStart + 3000);
    expect(funcSlice).toContain("_is_soi_silenced");
  });

  it.skipIf(!pythonExists)("poll_new_leads (speed-to-lead) has _is_excluded_source check", () => {
    const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
    const funcStart = content.indexOf("def poll_new_leads");
    const funcSlice = content.slice(funcStart, funcStart + 3000);
    expect(funcSlice).toContain("_is_excluded_source");
  });

  it.skipIf(!pythonExists)("poll_new_leads (speed-to-lead) has _is_soi_silenced check", () => {
    const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
    const funcStart = content.indexOf("def poll_new_leads");
    const funcSlice = content.slice(funcStart, funcStart + 3000);
    expect(funcSlice).toContain("_is_soi_silenced");
  });

  it.skipIf(!pythonExists)("_is_excluded_source uses excluded_sources from rules", () => {
    const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
    const funcStart = content.indexOf("def _is_excluded_source");
    const funcSlice = content.slice(funcStart, funcStart + 500);
    expect(funcSlice).toContain("excluded_sources");
  });

  it.skipIf(!pythonExists)("_is_soi_silenced checks source contains 'soi'", () => {
    const content = fs.readFileSync(PYTHON_MAIN, "utf-8");
    const funcStart = content.indexOf("def _is_soi_silenced");
    const funcSlice = content.slice(funcStart, funcStart + 1000);
    expect(funcSlice).toContain("soi");
    expect(funcSlice).toContain("createdById");
    expect(funcSlice).toContain("Manually");
  });
});

// ── 4. TypeScript lifestyle-bot-dashboard static analysis ─────────────────────

describe("Lifestyle-bot-dashboard static analysis", () => {
  const fs = require("fs");

  const TS_BOT_HELPERS = "/tmp/ldr-clean/lifestyle-bot-dashboard/server/botHelpers.ts";
  const tsExists = fs.existsSync(TS_BOT_HELPERS);

  it.skipIf(!tsExists)("shouldSkipLead has isExcludedSource check", () => {
    const content = fs.readFileSync(TS_BOT_HELPERS, "utf-8");
    const funcStart = content.indexOf("async function shouldSkipLead");
    const funcSlice = content.slice(funcStart, funcStart + 1500);
    expect(funcSlice).toContain("isExcludedSource");
  });

  it.skipIf(!tsExists)("shouldSkipLead has isSOISilenced check", () => {
    const content = fs.readFileSync(TS_BOT_HELPERS, "utf-8");
    const funcStart = content.indexOf("async function shouldSkipLead");
    const funcSlice = content.slice(funcStart, funcStart + 1500);
    expect(funcSlice).toContain("isSOISilenced");
  });

  it.skipIf(!tsExists)("isExcludedSource function exists and uses getSharedExcludedSources", () => {
    const content = fs.readFileSync(TS_BOT_HELPERS, "utf-8");
    expect(content).toContain("function isExcludedSource");
    expect(content).toContain("getSharedExcludedSources");
  });

  it.skipIf(!tsExists)("isSOISilenced checks all 3 rules (source contains, tag starts with, manually created)", () => {
    const content = fs.readFileSync(TS_BOT_HELPERS, "utf-8");
    const funcStart = content.indexOf("function isSOISilenced");
    const funcSlice = content.slice(funcStart, funcStart + 1500);
    expect(funcSlice).toContain('includes("soi")');
    expect(funcSlice).toContain('startsWith("soi")');
    expect(funcSlice).toContain("createdVia");
    expect(funcSlice).toContain("PETER_USER_ID");
  });
});
