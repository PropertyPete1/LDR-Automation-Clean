/**
 * Pure, testable helpers that decide whether the "Install app" affordance
 * should be shown, based on a user-agent string, platform, touch points, and
 * display-mode/standalone signals. Kept free of `window`/`navigator` access so
 * they can be unit-tested deterministically.
 */

export interface InstallEnv {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  /** true if launched as an installed PWA (standalone display-mode or iOS standalone flag) */
  standalone?: boolean;
}

export function detectIos(env: InstallEnv): boolean {
  const ua = env.userAgent || "";
  const iOSDevice = /iphone|ipad|ipod/i.test(ua);
  // iPadOS 13+ reports as Mac; detect Mac platform + touch.
  const iPadOS = env.platform === "MacIntel" && (env.maxTouchPoints ?? 0) > 1;
  return iOSDevice || iPadOS;
}

export function detectAndroid(env: InstallEnv): boolean {
  return /android/i.test(env.userAgent || "");
}

/**
 * Whether to render the install button at all.
 * - Never when already installed (standalone).
 * - Otherwise on any phone-class device (iOS or Android), or when a native
 *   beforeinstallprompt was captured (hasNativePrompt).
 */
export function shouldShowInstall(env: InstallEnv, hasNativePrompt: boolean): boolean {
  if (env.standalone) return false;
  return detectIos(env) || detectAndroid(env) || hasNativePrompt;
}
