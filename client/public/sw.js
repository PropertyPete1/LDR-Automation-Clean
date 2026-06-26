// Self-destroying service worker.
// A previous version cached the app shell, which could show a stale/empty page
// on mobile. This version unregisters itself and clears all caches so devices
// that already installed the old worker recover automatically on next load.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        // ignore
      }
      await self.registration.unregister();
      const clientsList = await self.clients.matchAll();
      clientsList.forEach((client) => client.navigate(client.url));
    })()
  );
});

// No fetch handler — let all requests go straight to the network.
