/**
 * dealProtection.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests for the Deal-Based Pond Protection system (Rules A/B/C) in botHelpers.ts
 * Validates: getPersonDeals, hasAnyDeal, hasClosedPurchaseDeal, isLeaseListingSilenced,
 * shouldSkipLead deal protection, and clearDealCache
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Read the source file for static analysis
const botHelpersPath = path.resolve(__dirname, "botHelpers.ts");
const botHelpersSrc = fs.readFileSync(botHelpersPath, "utf-8");

describe("Deal-Based Pond Protection — Static Analysis", () => {
  it("exports getPersonDeals function", () => {
    expect(botHelpersSrc).toContain("export async function getPersonDeals");
  });

  it("exports hasAnyDeal function (Rule A)", () => {
    expect(botHelpersSrc).toContain("export async function hasAnyDeal");
  });

  it("exports hasClosedPurchaseDeal function (Rule B)", () => {
    expect(botHelpersSrc).toContain("export async function hasClosedPurchaseDeal");
  });

  it("exports isLeaseListingSilenced function (Rule C)", () => {
    expect(botHelpersSrc).toContain("export async function isLeaseListingSilenced");
  });

  it("exports clearDealCache function", () => {
    expect(botHelpersSrc).toContain("export function clearDealCache");
  });

  it("defines correct pipeline constants", () => {
    // Buyers=1, Sellers=2
    expect(botHelpersSrc).toContain("PURCHASE_PIPELINE_IDS = new Set([1, 2])");
    // Residential Lease Listings=5
    expect(botHelpersSrc).toContain("LEASE_LISTING_PIPELINE_ID = 5");
  });

  it("getPersonDeals uses in-memory cache", () => {
    const section = botHelpersSrc.slice(
      botHelpersSrc.indexOf("export async function getPersonDeals"),
      botHelpersSrc.indexOf("export async function hasAnyDeal")
    );
    expect(section).toContain("dealCache.has(personId)");
    expect(section).toContain("dealCache.get(personId)");
    expect(section).toContain("dealCache.set(personId");
  });

  it("getPersonDeals calls FUB /deals?personId= endpoint", () => {
    const section = botHelpersSrc.slice(
      botHelpersSrc.indexOf("export async function getPersonDeals"),
      botHelpersSrc.indexOf("export async function hasAnyDeal")
    );
    expect(section).toContain("/deals?personId=");
  });

  it("hasAnyDeal returns true if deals.length > 0 (Rule A)", () => {
    const section = botHelpersSrc.slice(
      botHelpersSrc.indexOf("export async function hasAnyDeal"),
      botHelpersSrc.indexOf("export async function hasClosedPurchaseDeal")
    );
    expect(section).toContain("deals.length > 0");
  });

  it("hasClosedPurchaseDeal checks PURCHASE_PIPELINE_IDS and closed stage (Rule B)", () => {
    const section = botHelpersSrc.slice(
      botHelpersSrc.indexOf("export async function hasClosedPurchaseDeal"),
      botHelpersSrc.indexOf("export async function isLeaseListingSilenced")
    );
    expect(section).toContain("PURCHASE_PIPELINE_IDS.has(d.pipelineId)");
    expect(section).toContain("closedStage");
  });

  it("isLeaseListingSilenced checks pipeline 5 and purchase deal exception (Rule C)", () => {
    const section = botHelpersSrc.slice(
      botHelpersSrc.indexOf("export async function isLeaseListingSilenced"),
      botHelpersSrc.indexOf("export function clearDealCache")
    );
    expect(section).toContain("LEASE_LISTING_PIPELINE_ID");
    expect(section).toContain("hasClosedLease");
    expect(section).toContain("hasClosedPurchase");
    // Purchase deal wins over lease listing
    expect(section).toContain("hasClosedLease && !hasClosedPurchase");
  });

  it("shouldSkipLead checks hasAnyDeal (deal-room leads protected)", () => {
    const section = botHelpersSrc.slice(
      botHelpersSrc.indexOf("export async function shouldSkipLead"),
      botHelpersSrc.indexOf("export async function shouldSkipLead") + 1500
    );
    // hasAnyDeal must exist and come before isLeaseListingSilenced
    const anyDealIdx = section.indexOf("hasAnyDeal");
    const leaseIdx = section.indexOf("isLeaseListingSilenced");
    expect(anyDealIdx).toBeGreaterThan(-1);
    expect(leaseIdx).toBeGreaterThan(-1);
    expect(anyDealIdx).toBeLessThan(leaseIdx);
    // Source/SOI checks come BEFORE deal checks (cheap conditions first)
    const sourceIdx = section.indexOf("isExcludedSource");
    const soiIdx = section.indexOf("isSOISilenced");
    expect(sourceIdx).toBeGreaterThan(-1);
    expect(soiIdx).toBeGreaterThan(-1);
    expect(sourceIdx).toBeLessThan(anyDealIdx);
    expect(soiIdx).toBeLessThan(anyDealIdx);
  });

  it("shouldSkipLead returns skip=true with deal protection reason", () => {
    const section = botHelpersSrc.slice(
      botHelpersSrc.indexOf("export async function shouldSkipLead"),
      botHelpersSrc.indexOf("export async function shouldSkipLead") + 1500
    );
    expect(section).toContain("Lead has active deal in FUB deal room");
    expect(section).toContain("protected from all automation");
  });
});

describe("Deal-Based Pond Protection — Unit Tests (mocked FUB)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("getPersonDeals returns deals from FUB API", async () => {
    const mockDeals = [
      { id: 1, pipelineId: 1, pipelineName: "Buyers", stageId: 10, stageName: "Closed", status: "Active", closedStage: true },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ deals: mockDeals }),
    }) as unknown as typeof fetch;

    // Dynamic import to get fresh module with mocked fetch
    const { getPersonDeals, clearDealCache } = await import("./botHelpers");
    clearDealCache(); // ensure clean cache
    const deals = await getPersonDeals(99999);
    expect(deals).toHaveLength(1);
    expect(deals[0].pipelineId).toBe(1);
    expect(deals[0].stageName).toBe("Closed");
  });

  it("hasAnyDeal returns true when lead has deals", async () => {
    const mockDeals = [
      { id: 5, pipelineId: 6, pipelineName: "Lease Applications", stageId: 20, stageName: "Invoice Paid", status: "Active", closedStage: false },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ deals: mockDeals }),
    }) as unknown as typeof fetch;

    const { hasAnyDeal, clearDealCache } = await import("./botHelpers");
    clearDealCache();
    const result = await hasAnyDeal(88888);
    expect(result).toBe(true);
  });

  it("hasAnyDeal returns false when lead has no deals", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ deals: [] }),
    }) as unknown as typeof fetch;

    const { hasAnyDeal, clearDealCache } = await import("./botHelpers");
    clearDealCache();
    const result = await hasAnyDeal(77777);
    expect(result).toBe(false);
  });

  it("hasClosedPurchaseDeal returns true for closed Buyers deal", async () => {
    const mockDeals = [
      { id: 10, pipelineId: 1, pipelineName: "Buyers", stageId: 5, stageName: "Closed", status: "Won", closedStage: true },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ deals: mockDeals }),
    }) as unknown as typeof fetch;

    const { hasClosedPurchaseDeal, clearDealCache } = await import("./botHelpers");
    clearDealCache();
    const result = await hasClosedPurchaseDeal(66666);
    expect(result).toBe(true);
  });

  it("hasClosedPurchaseDeal returns false for open Buyers deal", async () => {
    const mockDeals = [
      { id: 11, pipelineId: 1, pipelineName: "Buyers", stageId: 3, stageName: "Active", status: "Active", closedStage: false },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ deals: mockDeals }),
    }) as unknown as typeof fetch;

    const { hasClosedPurchaseDeal, clearDealCache } = await import("./botHelpers");
    clearDealCache();
    const result = await hasClosedPurchaseDeal(55555);
    expect(result).toBe(false);
  });

  it("isLeaseListingSilenced returns true for closed lease listing without purchase deal", async () => {
    const mockDeals = [
      { id: 20, pipelineId: 5, pipelineName: "Residential Lease Listings", stageId: 8, stageName: "Lease Listing - Closed", status: "Active", closedStage: true },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ deals: mockDeals }),
    }) as unknown as typeof fetch;

    const { isLeaseListingSilenced, clearDealCache } = await import("./botHelpers");
    clearDealCache();
    const result = await isLeaseListingSilenced(44444);
    expect(result).toBe(true);
  });

  it("isLeaseListingSilenced returns false when purchase deal also exists (purchase wins)", async () => {
    const mockDeals = [
      { id: 20, pipelineId: 5, pipelineName: "Residential Lease Listings", stageId: 8, stageName: "Lease Listing - Closed", status: "Active", closedStage: true },
      { id: 21, pipelineId: 1, pipelineName: "Buyers", stageId: 5, stageName: "Closed", status: "Won", closedStage: true },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ deals: mockDeals }),
    }) as unknown as typeof fetch;

    const { isLeaseListingSilenced, clearDealCache } = await import("./botHelpers");
    clearDealCache();
    const result = await isLeaseListingSilenced(33333);
    expect(result).toBe(false);
  });

  it("isLeaseListingSilenced returns false for non-closed lease listing", async () => {
    const mockDeals = [
      { id: 22, pipelineId: 5, pipelineName: "Residential Lease Listings", stageId: 2, stageName: "Active", status: "Active", closedStage: false },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ deals: mockDeals }),
    }) as unknown as typeof fetch;

    const { isLeaseListingSilenced, clearDealCache } = await import("./botHelpers");
    clearDealCache();
    const result = await isLeaseListingSilenced(22222);
    expect(result).toBe(false);
  });

  it("shouldSkipLead skips lead with any deal (Rule A protection)", async () => {
    const mockDeals = [
      { id: 30, pipelineId: 7, pipelineName: "Referral Fees", stageId: 1, stageName: "Active", status: "Active", closedStage: false },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ deals: mockDeals }),
    }) as unknown as typeof fetch;

    const { shouldSkipLead, clearDealCache } = await import("./botHelpers");
    clearDealCache();
    const result = await shouldSkipLead({ id: 11111, notes: [] } as any);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("deal");
  });

  it("shouldSkipLead does NOT skip lead without deals (proceeds to other checks)", async () => {
    // No deals — fetch returns empty
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/deals")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ deals: [] }),
        });
      }
      // Anthropic API call for skip-gate — return NO skip
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: [{ text: "SKIP: NO" }] }),
      });
    });

    const { shouldSkipLead, clearDealCache } = await import("./botHelpers");
    clearDealCache();
    const result = await shouldSkipLead({
      id: 10101,
      notes: [{ body: "Just checking in", createdAt: "2026-01-01T10:00:00Z" }],
    } as any);
    expect(result.skip).toBe(false);
  });

  it("clearDealCache resets the cache", async () => {
    const { clearDealCache, getPersonDeals } = await import("./botHelpers");

    // First call — populate cache
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ deals: [{ id: 1, pipelineId: 1, pipelineName: "Buyers", stageId: 5, stageName: "Closed", status: "Won", closedStage: true }] }),
    }) as unknown as typeof fetch;
    await getPersonDeals(12345);

    // Clear cache
    clearDealCache();

    // Second call — should hit API again (new mock returns empty)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ deals: [] }),
    }) as unknown as typeof fetch;
    const deals = await getPersonDeals(12345);
    expect(deals).toHaveLength(0);
  });
});

describe("Deal-Based Pond Protection — Python Pond Bot (Static Analysis)", () => {
  const pondBotPath = "/tmp/ldr-clean/pond-nurture-bot/src/fub_automation/main.py";
  let pondBotSrc: string;

  beforeEach(() => {
    try {
      pondBotSrc = fs.readFileSync(pondBotPath, "utf-8");
    } catch {
      pondBotSrc = "";
    }
  });

  it("defines _has_any_deal method (Rule A)", () => {
    expect(pondBotSrc).toContain("def _has_any_deal(self, person_id: int) -> bool:");
  });

  it("defines _has_closed_purchase_deal method (Rule B)", () => {
    expect(pondBotSrc).toContain("def _has_closed_purchase_deal(self, person_id: int) -> bool:");
  });

  it("defines _is_lease_listing_silenced method (Rule C)", () => {
    expect(pondBotSrc).toContain("def _is_lease_listing_silenced(self, person_id: int) -> bool:");
  });

  it("stale reassignment uses _has_any_deal to block reassignment", () => {
    // The stale reassignment function must call _has_any_deal
    // Look for the actual reassignment candidate processing function
    const funcIdx = pondBotSrc.indexOf("# CRITICAL: Never reassign leads that have ANY deal");
    expect(funcIdx).toBeGreaterThan(-1);
    const staleSection = pondBotSrc.slice(funcIdx, funcIdx + 500);
    expect(staleSection).toContain("_has_any_deal");
  });

  it("process_reengagement_candidate uses _has_any_deal to block pond nurture emails", () => {
    const section = pondBotSrc.slice(
      pondBotSrc.indexOf("def process_reengagement_candidate"),
      pondBotSrc.indexOf("def process_reengagement_candidate") + 3000
    );
    expect(section).toContain("_has_any_deal");
    expect(section).toContain("protected from all automation");
    // Source/SOI checks come BEFORE deal checks
    expect(section).toContain("_is_excluded_source");
    expect(section).toContain("_is_soi_silenced");
  });

  it("process_reengagement_candidate checks _is_lease_listing_silenced (Rule C)", () => {
    const section = pondBotSrc.slice(
      pondBotSrc.indexOf("def process_reengagement_candidate"),
      pondBotSrc.indexOf("def process_reengagement_candidate") + 3000
    );
    expect(section).toContain("_is_lease_listing_silenced");
  });

  it("process_closed_drip_candidate uses _is_lease_listing_silenced (Rule C)", () => {
    const section = pondBotSrc.slice(
      pondBotSrc.indexOf("def process_closed_drip_candidate"),
      pondBotSrc.indexOf("def process_closed_drip_candidate") + 800
    );
    expect(section).toContain("_is_lease_listing_silenced");
  });

  it("process_closed_drip_candidate uses _has_closed_purchase_deal for Phase 3 eligibility (Rule B)", () => {
    const section = pondBotSrc.slice(
      pondBotSrc.indexOf("def process_closed_drip_candidate"),
      pondBotSrc.indexOf("def process_closed_drip_candidate") + 3500
    );
    expect(section).toContain("_has_closed_purchase_deal");
    // Source/SOI checks also present
    expect(section).toContain("_is_excluded_source");
    expect(section).toContain("_is_soi_silenced");
  });

  it("_is_lease_listing_silenced implements purchase-deal-wins exception", () => {
    const section = pondBotSrc.slice(
      pondBotSrc.indexOf("def _is_lease_listing_silenced"),
      pondBotSrc.indexOf("def _is_lease_listing_silenced") + 600
    );
    expect(section).toContain("has_closed_purchase");
    expect(section).toContain("has_closed_lease");
  });
});
