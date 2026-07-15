/* Service worker for the Japanese N5/N4 study app.
 *
 * Registered with scope "/japanese.html" so it ONLY controls that page and its
 * subresource fetches — the rest of the admin console is untouched. It caches
 * the app shell + dataset so the tab opens and works fully offline (e.g. on a
 * train with no signal); progress is kept in localStorage and syncs when the
 * connection returns. Auth/sync endpoints are never cached — the app handles
 * those offline itself. Bump CACHE to invalidate old assets. */
const CACHE = "jp-n5-v2";
const SHELL = [
  "/japanese.html",
  "/japanese-data.js",
  "/japanese-n4-data.js",
  "/theme.js",
  "/admin-nav.js",
  "/japanese-icon-192.png",
  "/japanese-icon-512.png",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  // Pre-cache the app shell so it works offline from the first install. Install
  // runs from the already-authenticated page, so the /japanese.html fetch
  // succeeds; if it ever 401s (no session) that entry is just skipped
  // (allSettled), never caching a login redirect.
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Let the app own its auth + sync — never serve these from cache.
  if (url.pathname === "/whoami" || url.pathname.startsWith("/japanese/state")) return;

  // The page itself: network-first (fresh when online), cache fallback offline.
  if (req.mode === "navigate" || url.pathname === "/japanese.html") {
    e.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res && res.ok) {
            const c = await caches.open(CACHE);
            c.put("/japanese.html", res.clone());
          }
          return res;
        } catch (err) {
          return (await caches.match("/japanese.html")) || Response.error();
        }
      })(),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  e.respondWith(
    (async () => {
      const cached = await caches.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => null);
      return cached || (await network) || Response.error();
    })(),
  );
});
