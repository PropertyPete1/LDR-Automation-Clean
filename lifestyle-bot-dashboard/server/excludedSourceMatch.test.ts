/**
 * excluded_sources uses CONTAINS, not equality (audit-fix).
 *
 * FUB sources carry channel/campaign suffixes — "Lease Listing Inquiry - Web",
 * "Zillow Rentals - Austin". Exact matching silently let every variant through,
 * so the suppression entry only ever caught a source spelled byte-for-byte.
 *
 * The direction is the safety property: source.includes(excluded), never the
 * reverse. "zillow" does not contain "zillow rentals", so a legitimate Zillow
 * buyer lead stays unsuppressed while "Zillow Rentals - Austin" is caught.
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
    ]) {
      expect(isExcludedSource(src(variant)), `${variant} should be suppressed`).toBeTruthy();
    }
  });

  it("never false-matches a legitimate buyer source", () => {
    for (const legit of [
      "Zillow",              // must NOT be caught by "Zillow Rentals"
      "Zillow Premier Agent",
      "Zillow Flex",
      "Realtor.com",
      "Website Form",
      "Open House",
      "Referral",
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
