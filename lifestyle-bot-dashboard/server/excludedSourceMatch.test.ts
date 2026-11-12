/** Unrelated source entries retain CONTAINS matching; both portals are excluded. */
import { describe, it, expect } from "vitest";
import { isExcludedSource, reloadSharedSuppressionTags } from "./botHelpers";

reloadSharedSuppressionTags();
const src = (source: string) => ({ id: 990001, source });

describe("isExcludedSource — CONTAINS matching", () => {
  it("catches suffixed and cased variants plus plain portal sources", () => {
    for (const variant of [
      "Lease Listing Inquiry - Web", "lease listing inquiry",
      "LEASE LISTING INQUIRY (Website Form)", "Zillow Rentals - Synthetic",
      "New Agent Inquiry 2026", "  BOTM Newsletter  ",
      "Zillow", "Zillow Premier Agent", "Zillow Flex", "Realtor.com",
    ]) expect(isExcludedSource(src(variant))).toBeTruthy();
  });

  it("never false-matches unrelated sources", () => {
    for (const control of [
      "Website Form", "Open House", "Referral", "Agent Referral",
      "Local Realtor Committee", "Newsletter Signup", "Lease", "realtor", "agent", "Realtor referral", "Agent Inquiry",
    ]) expect(isExcludedSource(src(control))).toBeNull();
  });

  it("empty / missing source is unchanged at selection time", () => {
    expect(isExcludedSource(src(""))).toBeNull();
    expect(isExcludedSource({ id: 990001 })).toBeNull();
  });
});
