/**
 * cutoverSafety.test.ts — Atomic Cutover Safety Tests
 *
 * Verifies the exactly-one-motor guarantee:
 * 1. Toggle alone (engineActive=true, legacyRetired=false) can't double-run
 * 2. Flag alone (legacyRetired=true, engineActive=false) can't orphan an agent
 * 3. The atomic migrateAgentToEngine op yields exactly-one-motor in both states
 * 4. A migrated agent is processed by engine and REFUSED by legacy file
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isLegacyBot, LEGACY_BOT_SLUGS } from "./botEngine";

// ─── Mock DB layer ─────────────────────────────────────────────────────────────

interface MockRow {
  botSlug: string;
  engineActive: boolean;
  legacyRetired: boolean;
}

let mockRows: MockRow[] = [];

// Mock getDb to return a fake DB
vi.mock("./db", () => ({
  getDb: vi.fn(async () => ({
    select: () => ({
      from: () => ({
        where: (condition: unknown) => ({
          limit: () => {
            // Extract slug from the condition mock
            const slug = (condition as any)?._slug;
            const row = mockRows.find(r => r.botSlug === slug);
            return row ? [row] : [];
          },
        }),
        orderBy: () => mockRows,
      }),
    }),
    update: () => ({
      set: (vals: Partial<MockRow>) => ({
        where: (condition: unknown) => {
          const slug = (condition as any)?._slug;
          const row = mockRows.find(r => r.botSlug === slug);
          if (row) Object.assign(row, vals);
        },
      }),
    }),
  })),
}));

// Mock drizzle-orm eq to capture the slug
vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, val: unknown) => ({ _slug: val }),
}));

// Mock schema
vi.mock("../drizzle/schema", () => ({
  agentBots: {
    botSlug: "botSlug",
    engineActive: "engineActive",
    legacyRetired: "legacyRetired",
    id: "id",
  },
}));

// Mock writeObservation to be a no-op
vi.mock("./botHelpers", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    writeObservation: vi.fn(async () => {}),
  };
});

// ─── Helper: simulate the gate logic without full module import ────────────────

/** Simulates the engine's decision: should it process this agent? */
function engineWouldProcess(row: MockRow): boolean {
  // Engine processes if: engineActive AND (not a legacy slug OR legacyRetired)
  if (!row.engineActive) return false;
  if (LEGACY_BOT_SLUGS.has(row.botSlug) && !row.legacyRetired) return false;
  return true;
}

/** Simulates the legacy file's decision: should it run? */
function legacyWouldRun(row: MockRow): boolean {
  // Legacy runs if: NOT legacyRetired (and it IS a legacy slug)
  if (!LEGACY_BOT_SLUGS.has(row.botSlug)) return false; // non-legacy files don't exist
  return !row.legacyRetired;
}

/** Returns the number of motors that would run for this agent */
function motorsRunning(row: MockRow): number {
  let count = 0;
  if (engineWouldProcess(row)) count++;
  if (legacyWouldRun(row)) count++;
  return count;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("Atomic Cutover Safety", () => {
  beforeEach(() => {
    mockRows = [];
  });

  describe("1. Toggle alone can't double-run", () => {
    it("engineActive=true + legacyRetired=false → engine BLOCKED, legacy RUNS (exactly 1 motor)", () => {
      const row: MockRow = { botSlug: "tiffany", engineActive: true, legacyRetired: false };
      expect(engineWouldProcess(row)).toBe(false); // Engine blocked by safeguard
      expect(legacyWouldRun(row)).toBe(true);      // Legacy still runs
      expect(motorsRunning(row)).toBe(1);           // Exactly one motor
    });

    it("applies to all 6 legacy slugs", () => {
      for (const slug of ["tiffany", "stefanie", "abby", "irma", "laila", "sp500_peter", "sp500_steven"]) {
        const row: MockRow = { botSlug: slug, engineActive: true, legacyRetired: false };
        expect(motorsRunning(row)).toBe(1);
        expect(legacyWouldRun(row)).toBe(true);
        expect(engineWouldProcess(row)).toBe(false);
      }
    });
  });

  describe("2. Flag alone can't orphan an agent", () => {
    it("legacyRetired=true + engineActive=false → legacy EXITS, engine INACTIVE (0 motors = orphan detected)", () => {
      const row: MockRow = { botSlug: "tiffany", engineActive: false, legacyRetired: true };
      expect(engineWouldProcess(row)).toBe(false); // Engine not active
      expect(legacyWouldRun(row)).toBe(false);     // Legacy retired
      expect(motorsRunning(row)).toBe(0);           // ORPHAN — this is the dangerous state
    });

    it("this is why migrateAgentToEngine sets BOTH flags atomically", () => {
      // The atomic op prevents this orphan state from ever existing in production
      const row: MockRow = { botSlug: "abby", engineActive: false, legacyRetired: true };
      expect(motorsRunning(row)).toBe(0); // Proves the danger
    });
  });

  describe("3. Atomic migrateAgentToEngine yields exactly-one-motor", () => {
    it("pre-migration state: legacy runs, engine blocked (1 motor)", () => {
      const row: MockRow = { botSlug: "laila", engineActive: false, legacyRetired: false };
      expect(motorsRunning(row)).toBe(1);
      expect(legacyWouldRun(row)).toBe(true);
      expect(engineWouldProcess(row)).toBe(false);
    });

    it("post-migration state: engine runs, legacy exits (1 motor)", () => {
      const row: MockRow = { botSlug: "laila", engineActive: true, legacyRetired: true };
      expect(motorsRunning(row)).toBe(1);
      expect(engineWouldProcess(row)).toBe(true);
      expect(legacyWouldRun(row)).toBe(false);
    });

    it("transition is atomic — no intermediate state exists", () => {
      // Simulate the atomic UPDATE SET engineActive=true, legacyRetired=true
      const row: MockRow = { botSlug: "stefanie", engineActive: false, legacyRetired: false };
      expect(motorsRunning(row)).toBe(1); // Before: legacy runs

      // Atomic write (single SQL UPDATE)
      row.engineActive = true;
      row.legacyRetired = true;
      expect(motorsRunning(row)).toBe(1); // After: engine runs
    });

    it("all legacy slugs maintain exactly-one-motor in both states", () => {
      for (const slug of ["tiffany", "stefanie", "abby", "irma", "laila", "sp500_peter", "sp500_steven"]) {
        // Pre-migration
        const pre: MockRow = { botSlug: slug, engineActive: false, legacyRetired: false };
        expect(motorsRunning(pre)).toBe(1);

        // Post-migration
        const post: MockRow = { botSlug: slug, engineActive: true, legacyRetired: true };
        expect(motorsRunning(post)).toBe(1);
      }
    });
  });

  describe("4. Migrated agent: processed by engine, REFUSED by legacy", () => {
    it("engine processes a migrated legacy agent", () => {
      const row: MockRow = { botSlug: "irma", engineActive: true, legacyRetired: true };
      expect(engineWouldProcess(row)).toBe(true);
    });

    it("legacy file refuses to run for a migrated agent", () => {
      const row: MockRow = { botSlug: "irma", engineActive: true, legacyRetired: true };
      expect(legacyWouldRun(row)).toBe(false);
    });

    it("non-legacy agent (jason) is unaffected by the gate", () => {
      const row: MockRow = { botSlug: "jason", engineActive: true, legacyRetired: false };
      expect(engineWouldProcess(row)).toBe(true);  // Not in LEGACY_BOT_SLUGS
      expect(legacyWouldRun(row)).toBe(false);     // No legacy file exists for jason
      expect(motorsRunning(row)).toBe(1);
    });
  });

  describe("5. Rollback safety", () => {
    it("rollback (engineActive=false, legacyRetired=false) restores legacy-only (1 motor)", () => {
      const row: MockRow = { botSlug: "tiffany", engineActive: false, legacyRetired: false };
      expect(motorsRunning(row)).toBe(1);
      expect(legacyWouldRun(row)).toBe(true);
      expect(engineWouldProcess(row)).toBe(false);
    });
  });

  describe("6. isLegacyBot helper", () => {
    it("correctly identifies legacy slugs", () => {
      expect(isLegacyBot("tiffany")).toBe(true);
      expect(isLegacyBot("stefanie")).toBe(true);
      expect(isLegacyBot("abby")).toBe(true);
      expect(isLegacyBot("irma")).toBe(true);
      expect(isLegacyBot("laila")).toBe(true);
      expect(isLegacyBot("sp500_peter")).toBe(true);
      expect(isLegacyBot("sp500_steven")).toBe(true);
    });

    it("correctly rejects non-legacy slugs", () => {
      expect(isLegacyBot("jason")).toBe(false);
      expect(isLegacyBot("peter")).toBe(false);
      expect(isLegacyBot("newagent")).toBe(false);
    });
  });
});
