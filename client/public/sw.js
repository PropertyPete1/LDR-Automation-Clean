// Minimal service worker — required for Android "Add to Home Screen" installability.
// Network-first passthrough; no aggressive caching so the dashboard always shows fresh data.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Pass through to the network. A fetch handler must exist for the app to be
  // considered installable by Chrome/Android.
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
