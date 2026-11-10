// The service worker: the platform's router. It sits between every page and
// the network, so it can do what a static host can't:
//
//   - answer a folder's URL with the app.html in it (sw/routes/apps.js)
//   - put the plugin-worker security policy on the runtime scripts on any host (sw/routes/headers.js)
//   - let plugins answer requests, so a link or a form can reach a plugin (sw/routes/plugins.js)
//   - keep what it served, so an app that has been opened once works offline
//
// It holds no state of its own: the browser stops it whenever it's idle. The
// kernel stays in the shared worker, and the service worker reaches it through
// an open tab (env.kernel below).
//
// Each route is a file in sw/routes/, listed in sw/routes/index.js. A route is
// `{ prefix?, handle(request, url, env) }`: it returns a Response, or nothing
// to let the next route try. When none answers, the request goes to the network.

import routes from "./sw/routes/index.js";
import { appAt } from "./sw/routes/apps.js";
import { renderBlocking } from "./sw/render-blocking.js";
import { onNotificationClick, onNotifyMessage } from "./sw/notifications.js";

const CACHE = "platform-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
// A click on a notification the worker showed, even after every tab closed (sw/notifications.js).
self.addEventListener("notificationclick", onNotificationClick);

// The first visit loads before this worker starts, so nothing it loaded was kept. The page then
// sends what it loaded (src/host/service-worker.ts), and it is fetched again and kept, so the
// app opens offline after one visit.
self.addEventListener("message", (event) => {
  // A page's notification, shown by the worker so it outlives the page (sw/notifications.js).
  if (event.data?.t === "sw:notify") return onNotifyMessage(event);
  // A page that is an app at the site's root asks, before following a link, whether its address is a screen of
  // that app or a page of its own (src/host/root-screens.ts): answered as a visit to the address would be.
  if (event.data?.t === "sw:screen" && typeof event.data.url === "string" && event.ports[0]) {
    const url = new URL(event.data.url, location.href);
    const port = event.ports[0];
    // An address another route answers (a space's /s/…, a made app's /apps/…, a person's /user/…) is never the root app's screen.
    const reserved = routes.some((route) => route.prefix && url.pathname.startsWith(route.prefix));
    const found = url.origin === location.origin && !reserved ? appAt(new Request(url), url, { fetch: (request) => cached(request, event) }) : Promise.resolve(undefined);
    return event.waitUntil(found.then((app) => port.postMessage(app?.folder === "/"), () => port.postMessage(false)));
  }
  if (event.data?.t !== "sw:warm" || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.filter((u) => typeof u === "string" && new URL(u, location.href).origin === location.origin).slice(0, 200);
  event.waitUntil(Promise.all(urls.map((u) => cached(new Request(u), event).catch(() => {}))));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  // A page it serves waits for the host before its first paint (sw/render-blocking.js).
  event.respondWith(event.request.mode === "navigate" ? answer(event, url).then(renderBlocking) : answer(event, url));
});

/** @param {FetchEvent} event @param {URL} url */
async function answer(event, url) {
  const env = { fetch: (request) => cached(request, event), kernel: (name, arg, space = "") => kernel(event.clientId, name, arg, space) };
  for (const route of routes) {
    if (route.prefix && !url.pathname.startsWith(route.prefix)) continue;
    try {
      const response = await route.handle(event.request, url, env);
      if (response) return response;
    } catch (error) {
      return new Response(`The ${route.name ?? "route"} route failed: ${error instanceof Error ? error.message : error}`, { status: 500 });
    }
  }
  return event.request.method === "GET" ? cached(event.request, event) : fetch(event.request);
}

// A kept file answers whatever headers the request has. A server that says `Vary: Origin` (Vite's does) would
// otherwise keep a file the worker fetched for itself from answering the page's own request for it, offline.
const KEPT = { ignoreVary: true };

/**
 * A file this worker has kept is answered from what it kept, at once, and
 * fetched again behind it, so the next visit has the newer copy: a repeat
 * visit doesn't wait on a round trip per file. A deploy shows on the visit
 * after the one that fetched it. Files it hasn't kept, and everything while
 * developing on this machine (localhost), come from the network first, so a
 * change shows at once there; what came back is kept, and used when the
 * network can't be reached. Keeping it is held open with waitUntil, so the
 * browser doesn't stop the worker before it is stored.
 * @param {Request} request @param {ExtendableEvent} event
 */
async function cached(request, event) {
  const cache = await caches.open(CACHE);
  const fresh = fetch(request).then((response) => {
    if (request.method === "GET" && response.ok && response.type === "basic" && !/no-store/.test(response.headers.get("Cache-Control") ?? "")) {
      const copy = response.clone();
      event.waitUntil(cache.put(request, copy).catch(() => {}));
    }
    return response;
  });
  if (cacheFirst(request)) {
    const kept = await cache.match(request, KEPT);
    // A navigation can't be answered with a redirected response.
    if (kept && !(request.mode === "navigate" && kept.redirected)) {
      event.waitUntil(fresh.catch(() => {}));
      return kept;
    }
  }
  try {
    return await fresh;
  } catch (error) {
    const kept = await cache.match(request, KEPT);
    if (kept) return kept;
    throw error;
  }
}

/** Kept files answer first except on this machine, and except where answers change: spaces and sign-in. */
const LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
/** @param {Request} request */
function cacheFirst(request) {
  if (LOCAL || request.method !== "GET") return false;
  const path = new URL(request.url).pathname;
  return !path.startsWith("/s/") && !path.startsWith("/auth/");
}

/**
 * Asks the kernel, through a tab: the tab that made the request if it has
 * the platform loaded, or else any open tab. A tab answers in its host
 * (src/host/service-worker.ts): at once with { taken }, and later with the
 * answer. Only a tab that hasn't taken the question within a second is
 * passed over, so the kernel never runs one request twice. Rejects when no
 * tab takes it. A page in a space (/s/<space>/…) has a kernel of that space's
 * own, so only its tabs are asked about it, and only the person's own tabs
 * about their own kernel.
 * @param {string} clientId @param {string} name @param {unknown} arg @param {string} [space]
 */
async function kernel(clientId, name, arg, space = "") {
  const own = clientId ? await self.clients.get(clientId) : undefined;
  const windows = await self.clients.matchAll({ type: "window" });
  const spaceOf = (/** @type {Client} */ tab) => /^\/s\/([a-z0-9][a-z0-9-]{0,62})\//.exec(new URL(tab.url).pathname)?.[1] ?? "";
  const tabs = [own, ...windows.filter((w) => w.id !== clientId)].filter((tab) => tab && spaceOf(tab) === space);
  for (const tab of tabs) {
    const answer = await ask(tab, name, arg);
    if (answer === NOT_TAKEN) continue;
    return answer.ok ? answer.value : Promise.reject(new Error(answer.error));
  }
  throw new Error("No open tab can reach the kernel");
}

const NOT_TAKEN = Symbol("not taken");

/** @param {Client} tab @param {string} name @param {unknown} arg */
function ask(tab, name, arg) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    // A tab without the platform never takes it; a route handler has ten seconds, so a taken question gets fifteen.
    let timer = setTimeout(() => resolve(NOT_TAKEN), 1000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      if (e.data?.taken) timer = setTimeout(() => reject(new Error("The kernel didn't answer in time")), 15_000);
      else resolve(e.data);
    };
    tab.postMessage({ t: "sw:kernel", name, arg }, [channel.port2]);
  });
}
