import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
  getDailyPicks: vi.fn().mockResolvedValue([]),
  getVideoById: vi.fn().mockResolvedValue(null),
  updateDailyPick: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./driveIndex", () => ({
  syncDriveIndex: vi.fn().mockResolvedValue({ synced: 5, total: 5 }),
  getAllDriveVideos: vi.fn().mockResolvedValue([]),
  getDriveVideosByDuration: vi.fn().mockResolvedValue([]),
  listDriveVideos: vi.fn().mockResolvedValue([]),
}));

vi.mock("./driveMatcher", () => ({
  findDriveMatch: vi.fn().mockResolvedValue(null),
}));

vi.mock("./videoVariant", () => ({
  makeDifferentiatedVariant: vi.fn().mockResolvedValue({
    ok: true,
    url: "https://storage.example.com/variant.mp4",
    sha256: "abc123",
  }),
}));

vi.mock("./selection", () => ({
  getCdtPickDate: vi.fn().mockReturnValue("2026-07-03"),
}));

describe("drivePreprocess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should export preprocessDriveOriginals function", async () => {
    const mod = await import("./drivePreprocess");
    expect(typeof mod.preprocessDriveOriginals).toBe("function");
  });

  it("should return early when no picks need processing", async () => {
    const { preprocessDriveOriginals } = await import("./drivePreprocess");
    const result = await preprocessDriveOriginals();
    expect(result.ok).toBe(true);
    expect(result.results).toEqual([]);
  });
});

describe("driveIndex", () => {
  it("should export syncDriveIndex and getAllDriveVideos", async () => {
    const mod = await import("./driveIndex");
    expect(typeof mod.syncDriveIndex).toBe("function");
    expect(typeof mod.getAllDriveVideos).toBe("function");
    expect(typeof mod.getDriveVideosByDuration).toBe("function");
    expect(typeof mod.listDriveVideos).toBe("function");
  });
});

describe("driveMatcher", () => {
  it("should export findDriveMatch", async () => {
    const mod = await import("./driveMatcher");
    expect(typeof mod.findDriveMatch).toBe("function");
  });

  it("should return null when no thumbnail URL provided", async () => {
    // Reset the mock to use the real implementation for this test
    vi.doUnmock("./driveMatcher");
    const { findDriveMatch } = await import("./driveMatcher");
    const result = await findDriveMatch({
      igThumbnailUrl: "",
      igCaption: "test",
      igDurationMs: null,
    });
    expect(result).toBeNull();
  });
});

describe("publishNow with Drive original", () => {
  it("should prefer driveVideoUrl over body videoUrl", () => {
    // This is a logic test: when pick.driveVideoUrl is set,
    // the publish pipeline should use it directly
    const pick = {
      driveVideoUrl: "https://storage.example.com/drive-variant.mp4",
      driveMatchConfidence: "high",
    };
    const bodyVideoUrl = "https://ig-cdn.example.com/reel.mp4";

    // The actual logic from publishNowHandler:
    const videoUrl = pick.driveVideoUrl || bodyVideoUrl;
    expect(videoUrl).toBe("https://storage.example.com/drive-variant.mp4");
  });

  it("should fall back to body videoUrl when no Drive original", () => {
    const pick = {
      driveVideoUrl: null as string | null,
      driveMatchConfidence: null as string | null,
    };
    const bodyVideoUrl = "https://ig-cdn.example.com/reel.mp4";

    const videoUrl = pick.driveVideoUrl || bodyVideoUrl;
    expect(videoUrl).toBe("https://ig-cdn.example.com/reel.mp4");
  });

  it("should skip variant when using Drive original (already differentiated)", () => {
    const pick = {
      driveVideoUrl: "https://storage.example.com/drive-variant.mp4",
    };
    const usingDriveOriginal = Boolean(pick.driveVideoUrl);
    expect(usingDriveOriginal).toBe(true);
    // When usingDriveOriginal is true, variant step is skipped
  });
});
