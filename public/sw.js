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

// The app mirrors its paired-gateway list (url + token per machine) into
// IndexedDB, because a notification action handled here has to reach the
// gateway itself — there is no window, and a service worker cannot read
// localStorage.
function readGateways() {
  return new Promise((resolve) => {
    const req = indexedDB.open("agentbench", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const get = db.transaction("kv").objectStore("kv").get("gateways");
        get.onsuccess = () => resolve(Array.isArray(get.result) ? get.result : []);
        get.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    };
  });
}

// A push arrives whether or not the app is open — that is the entire point of
// carrying it on a phone rather than watching a screen.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { title: "AgentBench", body: event.data?.text() ?? "" };
  }
  // A question can carry its options as buttons: answering happens right on
  // the notification, without the app ever opening. Capped — Android shows at
  // most three actions, and "Open" must always survive the cut.
  const actions = Array.isArray(data.actions)
    ? data.actions
        .slice(0, 2)
        .map((title, i) => ({ action: `pick:${i}`, title: String(title) }))
    : [];
  if (actions.length) actions.push({ action: "open", title: "Open" });
  const jobs = [
    self.registration.showNotification(data.title || "AgentBench", {
      body: data.body || "",
      // Replacing by tag keeps a busy agent from stacking a wall of
      // notifications; each pane and kind owns one.
      tag: data.tag || "agentbench",
      renotify: true,
      icon: "/icon-192.png",
      // Android draws the badge from the alpha channel alone — an opaque
      // square renders as a solid white blob, so this must be the monochrome
      // white-on-transparent silhouette, not the app icon.
      badge: "/badge-96.png",
      timestamp: Date.now(),
      actions,
      data,
    }),
  ];
  // Something is waiting on the user — dot the app icon. The app itself owns
  // the exact count and clears it; from here "nonzero" is all that's knowable.
  if (data.kind && data.kind !== "done" && data.kind !== "test" && navigator.setAppBadge) {
    jobs.push(navigator.setAppBadge().catch(() => {}));
  }
  event.waitUntil(Promise.all(jobs));
});

/** POST the picked option straight to the gateway that raised the question. */
async function answerFromNotification(data, pick) {
  const gateways = await readGateways();
  const gw = gateways.find(
    (g) => g.machine === data.machine || g.name === data.machine,
  );
  if (!gw) throw new Error("machine not paired");
  const res = await fetch(`${gw.url.replace(/\/+$/, "")}/api/answer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gw.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ paneId: data.paneId, toolId: data.toolId ?? null, pick }),
  });
  if (!res.ok) throw new Error(`answer failed (${res.status})`);
}

// Tapping a notification should land on the agent it is about, reusing an
// open window rather than piling up new ones. Tapping an answer button
// resolves the question in place instead.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const { machine, paneId } = data;
  const m = /^pick:(\d+)$/.exec(event.action ?? "");
  if (m) {
    event.waitUntil(
      answerFromNotification(data, Number(m[1])).catch(() =>
        // The gateway refused (someone else answered, claim expired, offline)
        // — fall back to opening the pane so the question is still reachable.
        self.clients.openWindow(
          `/?pane=${paneId}&machine=${encodeURIComponent(machine ?? "")}`,
        ),
      ),
    );
    return;
  }
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
