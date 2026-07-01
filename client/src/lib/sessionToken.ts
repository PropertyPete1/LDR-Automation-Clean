// Client-side session token store.
//
// Why this exists: on some mobile browsers (Safari ITP, iOS WebViews, strict
// cross-site cookie policies) the SameSite=None session cookie is present on the
// top-level navigation but dropped on the XHR to /api/trpc. That makes owner-only
// tRPC procedures (e.g. picks.today) return 401 while public ones (auth.me) still
// resolve — the dashboard renders but shows "No picks available yet".
//
// To make auth independent of cookie behavior, the OAuth callback also hands the
// session token to the client via the URL fragment (`/#session=<token>`).
// Fragments are never transmitted to the server and never logged by proxies/CDNs.
// We capture it once, persist it in localStorage, strip it from the URL, and then
// attach it as an Authorization: Bearer header on every tRPC request. The server
// already accepts this Bearer token identically to the cookie.

const STORAGE_KEY = "lds-session";
const FRAGMENT_KEY = "session";

/**
 * Read the `#session=<token>` fragment (if present), persist it to localStorage,
 * and strip it from the URL so it is not left in history or shared links.
 * Safe to call multiple times; a no-op when there is no fragment token.
 */
export function captureSessionTokenFromUrl(): void {
  try {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash || hash.length < 2) return;

    // hash looks like "#session=...." possibly combined with other params.
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const token = params.get(FRAGMENT_KEY);
    if (!token) return;

    try {
      localStorage.setItem(STORAGE_KEY, token);
    } catch {
      // localStorage unavailable (private mode quota) — ignore; cookie/preview
      // fallbacks still apply.
    }

    // Remove only the session param, preserve any other fragment content.
    params.delete(FRAGMENT_KEY);
    const remaining = params.toString();
    const newHash = remaining ? `#${remaining}` : "";
    const url =
      window.location.pathname + window.location.search + newHash;
    window.history.replaceState(null, "", url);
  } catch {
    // Never block boot on fragment parsing.
  }
}

/** Return the persisted session token, or null if none is stored. */
export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Clear the persisted session token (used on logout). */
export function clearSessionToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
