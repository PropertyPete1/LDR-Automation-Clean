import { describe, expect, it } from "vitest";
import { captionFingerprint, isCaptionRecentlyPosted } from "./igHistorySync";

describe("captionFingerprint", () => {
  it("normalizes case, emoji, and punctuation to a stable fingerprint", () => {
    const a = captionFingerprint("Bright, Light & Clean Finishes! 🏠✨ in San Antonio");
    const b = captionFingerprint("bright light clean finishes in san antonio");
    expect(a).toBe(b);
  });

  it("returns empty string for null/undefined", () => {
    expect(captionFingerprint(null)).toBe("");
    expect(captionFingerprint(undefined)).toBe("");
  });
});

describe("isCaptionRecentlyPosted", () => {
  const recent = [
    { captionSnippet: "Bright light clean finishes in this stunning San Antonio home 🏠" },
    { captionSnippet: "Modern luxury living in the heart of Austin Texas" },
  ];

  it("flags the $279,990 SA house caption that was reposted under a new ID", () => {
    // Library caption vs the ig_post_history snippet — same reel, different post ID
    const candidate = "Bright light clean finishes — this San Antonio gem won't last! Call today 📞";
    expect(isCaptionRecentlyPosted(candidate, recent)).toBe(true);
  });

  it("matches when the stored snippet is a truncated prefix of the candidate", () => {
    const candidate = "Modern luxury living in the heart of Austin Texas with rooftop views";
    expect(isCaptionRecentlyPosted(candidate, recent)).toBe(true);
  });

  it("does not flag a genuinely different property", () => {
    const candidate = "Cozy ranch-style retreat on five acres just outside Boerne";
    expect(isCaptionRecentlyPosted(candidate, recent)).toBe(false);
  });

  it("ignores captions too short to fingerprint reliably", () => {
    expect(isCaptionRecentlyPosted("New listing", recent)).toBe(false);
  });

  it("returns false when there is no recent history", () => {
    expect(isCaptionRecentlyPosted("Bright light clean finishes home", [])).toBe(false);
  });
});
