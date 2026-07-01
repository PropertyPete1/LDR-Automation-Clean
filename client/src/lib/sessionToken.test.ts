import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A minimal localStorage shim.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, v);
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  clear() {
    this.store.clear();
  }
}

describe("sessionToken (mobile Bearer fallback)", () => {
  let replaceStateCalls: Array<{ url: string }>;

  beforeEach(() => {
    replaceStateCalls = [];
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", {
      location: {
        hash: "",
        pathname: "/",
        search: "",
      },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          replaceStateCalls.push({ url });
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("captures token from #session fragment, persists it, and strips the fragment", async () => {
    (window as unknown as { location: { hash: string } }).location.hash =
      "#session=abc.def.ghi";

    const mod = await import("./sessionToken");
    mod.captureSessionTokenFromUrl();

    expect(mod.getSessionToken()).toBe("abc.def.ghi");
    // Fragment removed from the URL so it is not left in history/shared links.
    expect(replaceStateCalls.length).toBe(1);
    expect(replaceStateCalls[0].url).toBe("/");
  });

  it("url-decodes an encoded token", async () => {
    const raw = "a b+c/d";
    (window as unknown as { location: { hash: string } }).location.hash =
      `#session=${encodeURIComponent(raw)}`;

    const mod = await import("./sessionToken");
    mod.captureSessionTokenFromUrl();

    expect(mod.getSessionToken()).toBe(raw);
  });

  it("preserves other fragment params while removing session", async () => {
    (window as unknown as { location: { hash: string } }).location.hash =
      "#session=tok&foo=bar";

    const mod = await import("./sessionToken");
    mod.captureSessionTokenFromUrl();

    expect(mod.getSessionToken()).toBe("tok");
    expect(replaceStateCalls[0].url).toBe("/#foo=bar");
  });

  it("is a no-op when there is no fragment", async () => {
    const mod = await import("./sessionToken");
    mod.captureSessionTokenFromUrl();
    expect(mod.getSessionToken()).toBeNull();
    expect(replaceStateCalls.length).toBe(0);
  });

  it("clearSessionToken removes the stored token", async () => {
    (window as unknown as { location: { hash: string } }).location.hash =
      "#session=tok";
    const mod = await import("./sessionToken");
    mod.captureSessionTokenFromUrl();
    expect(mod.getSessionToken()).toBe("tok");

    mod.clearSessionToken();
    expect(mod.getSessionToken()).toBeNull();
  });
});
