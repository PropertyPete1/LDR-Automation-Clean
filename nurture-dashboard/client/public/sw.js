/**
 * Lifestyle Command Center — Service Worker
 *
 * Strategy:
 * - API calls (/api/*): Network-only — always fresh data, no caching
 * - Static assets (JS, CSS, fonts, images): Cache-first with versioned cache
 * - HTML pages: Network-first with cache fallback for offline shell
 *
 * This ensures agents always see live lead data while still getting
 * fast asset loads and a usable offline shell.
 */

const CACHE_VERSION = "lcc-v2";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGES_CACHE = `${CACHE_VERSION}-pages`;

// Assets to pre-cache on install (app shell)
const PRECACHE_URLS = [
  "/",
  "/sms-queue",
  "/manifest.json",
];

// ── Message: handle SKIP_WAITING from UpdateBanner ──────────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// ── Install: pre-cache the app shell ──────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PAGES_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        // Non-fatal: pre-cache failures should not block install
        console.warn("[SW] Pre-cache failed (non-fatal):", err);
      });
    })
  );
  // Activate immediately without waiting for old tabs to close
  self.skipWaiting();
});

// ── Activate: clean up old caches ─────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("lcc-") && key !== STATIC_CACHE && key !== PAGES_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Take control of all open clients immediately
  self.clients.claim();
});

// ── Fetch: route requests to the right strategy ───────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and cross-origin requests
  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // API calls: always go to network, never cache
  if (url.pathname.startsWith("/api/")) {
    return; // Let the browser handle it normally
  }

  // Static assets (JS, CSS, images, fonts, manus-storage): cache-first
  if (
    url.pathname.match(/\.(js|css|woff2?|ttf|otf|png|jpg|jpeg|svg|ico|webp)$/) ||
    url.pathname.startsWith("/manus-storage/") ||
    url.pathname.startsWith("/assets/")
  ) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          cache.put(request, response.clone());
        }
        return response;
      })
    );
    return;
  }

  // HTML pages: network-first, fall back to cache
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          caches.open(PAGES_CACHE).then((cache) => cache.put(request, response.clone()));
        }
        return response;
      })
      .catch(async () => {
        // Offline fallback: serve cached page or root
        const cached = await caches.match(request);
        if (cached) return cached;
        const root = await caches.match("/");
        if (root) return root;
        return new Response("Offline — please reconnect to use Lifestyle Command Center.", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      })
  );
});
