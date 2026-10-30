/* Offline cache for the kanji trainer (scope: /kanji/ only).
 * Network first, so a new deck.json or app.js shows up as soon as there is
 * signal; after 3.5 s with no answer (a tunnel) the cached copy is used. */
const CACHE = "kanji-v1";
const ASSETS = ["./", "index.html", "kanji.css", "app.js", "deck.json", "manifest.json", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(networkFirst(req));
});

function networkFirst(req) {
  return caches.open(CACHE).then(
    (cache) =>
      new Promise((resolve) => {
        let done = false;
        const fromCache = () =>
          cache.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === "navigate" ? cache.match("./") : undefined));
        const timer = setTimeout(() => {
          fromCache().then((hit) => {
            if (hit && !done) {
              done = true;
              resolve(hit);
            }
          });
        }, 3500);
        fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            if (!done) {
              done = true;
              clearTimeout(timer);
              resolve(res);
            }
          })
          .catch(() => {
            clearTimeout(timer);
            fromCache().then((hit) => {
              if (!done) {
                done = true;
                resolve(hit || Response.error());
              }
            });
          });
      })
  );
}
