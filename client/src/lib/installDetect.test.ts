import { describe, it, expect } from "vitest";
import { detectIos, detectAndroid, shouldShowInstall } from "./installDetect";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPADOS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

describe("install detection", () => {
  it("detects iPhone as iOS", () => {
    expect(detectIos({ userAgent: IPHONE })).toBe(true);
  });

  it("detects iPadOS (Mac UA + touch) as iOS", () => {
    expect(detectIos({ userAgent: IPADOS, platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
  });

  it("does not treat a real desktop Mac (no touch) as iOS", () => {
    expect(detectIos({ userAgent: DESKTOP, platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
  });

  it("detects Android", () => {
    expect(detectAndroid({ userAgent: ANDROID })).toBe(true);
    expect(detectAndroid({ userAgent: IPHONE })).toBe(false);
  });

  it("shows install button on iPhone Safari (no native prompt)", () => {
    expect(shouldShowInstall({ userAgent: IPHONE }, false)).toBe(true);
  });

  it("shows install button on Android Chrome (no native prompt yet)", () => {
    expect(shouldShowInstall({ userAgent: ANDROID }, false)).toBe(true);
  });

  it("shows install button on desktop only when a native prompt is captured", () => {
    expect(shouldShowInstall({ userAgent: DESKTOP }, false)).toBe(false);
    expect(shouldShowInstall({ userAgent: DESKTOP }, true)).toBe(true);
  });

  it("hides install button entirely once running standalone (installed)", () => {
    expect(shouldShowInstall({ userAgent: IPHONE, standalone: true }, false)).toBe(false);
    expect(shouldShowInstall({ userAgent: ANDROID, standalone: true }, true)).toBe(false);
  });
});
