/**
 * Shell-only service worker.
 *
 * It caches the static app shell and nothing else — no API responses, no
 * transcripts, no tokens. That is what makes caching safe here: a revoked
 * device still loads the shell offline, then every data call returns 401 and
 * the app drops back to the pairing screen.
 */
// Stamped at build time. A service worker is only considered "new" when its
// own bytes change, so without this the browser would never look for updated
// assets and a phone would run the build it first loaded forever.
const BUILD = "__BUILD_ID__";
const CACHE = `agentbench-shell-${BUILD}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(["/", "/manifest.webmanifest"])),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Never touch the API or another machine's origin: those must always hit the
  // network so auth failures surface immediately.
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches
          .match(request)
          .then((hit) => hit ?? caches.match("/") ?? Response.error()),
      ),
  );
});
