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

// A push arrives whether or not the app is open — that is the entire point of
// carrying it on a phone rather than watching a screen.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { title: "AgentBench", body: event.data?.text() ?? "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "AgentBench", {
      body: data.body || "",
      // Replacing by tag keeps a busy agent from stacking a wall of
      // notifications; each pane and kind owns one.
      tag: data.tag || "agentbench",
      renotify: true,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      timestamp: Date.now(),
      data,
    }),
  );
});

// Tapping a notification should land on the agent it is about, reusing an
// open window rather than piling up new ones.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { machine, paneId } = event.notification.data ?? {};
  const target = paneId ? `/?pane=${paneId}&machine=${encodeURIComponent(machine ?? "")}` : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin)) {
          client.postMessage({ type: "open-pane", machine, paneId });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
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
