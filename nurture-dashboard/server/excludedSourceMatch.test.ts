/**
 * excluded_sources uses CONTAINS, not equality (audit-fix).
 *
 * FUB sources carry channel/campaign suffixes — "Lease Listing Inquiry - Web",
 * "Zillow Rentals - Austin". Exact matching silently let every variant through,
 * so the suppression entry only ever caught a source spelled byte-for-byte.
 *
 * Unrelated sources retain the old contains rule. Zillow and Realtor.com
 * sources are now excluded by the explicit portal provenance rule.
 */
import { describe, it, expect } from "vitest";
import { isExcludedSource, reloadSharedSuppressionTags } from "./botHelpers";

reloadSharedSuppressionTags(); // ensure the shared JSON is loaded

const src = (source: string) => ({ source }) as Parameters<typeof isExcludedSource>[0];

describe("isExcludedSource — CONTAINS matching", () => {
  it("catches suffixed and cased variants", () => {
    for (const variant of [
      "Lease Listing Inquiry - Web",
      "lease listing inquiry",
      "LEASE LISTING INQUIRY (Website Form)",
      "Zillow Rentals - Austin",
      "New Agent Inquiry 2026",
      "  BOTM Newsletter  ",
      "Zillow",
      "Zillow Premier Agent",
      "Zillow Flex",
      "Realtor.com",
    ]) {
      expect(isExcludedSource(src(variant)), `${variant} should be suppressed`).toBeTruthy();
    }
  });

  it("never false-matches a legitimate buyer source", () => {
    for (const legit of [
      "Website Form",
      "Open House",
      "Referral",
      "realtor",
      "agent",
      "Realtor referral",
      "Agent Inquiry",
      "Agent Referral",      // must NOT be caught by "New Agent Inquiry"
      "Newsletter Signup",   // must NOT be caught by "BOTM Newsletter"
      "Lease",               // shorter than the excluded entry
    ]) {
      expect(isExcludedSource(src(legit)), `${legit} must NOT be suppressed`).toBeNull();
    }
  });

  it("empty / missing source is safe", () => {
    expect(isExcludedSource(src(""))).toBeNull();
    expect(isExcludedSource({} as Parameters<typeof isExcludedSource>[0])).toBeNull();
  });
});
