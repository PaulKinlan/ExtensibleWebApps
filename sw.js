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
import { onPush, onSubscriptionChange } from "./sw/push.js";
import { keepParts } from "./sw/parts.js";

const CACHE = "platform-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
// A click on a notification the worker showed, even after every tab closed (sw/notifications.js).
self.addEventListener("notificationclick", onNotificationClick);
// A notification from a space's server, which arrives with every tab closed (sw/push.js).
self.addEventListener("push", onPush);
self.addEventListener("pushsubscriptionchange", onSubscriptionChange);

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
  // And the site's front page, which answering an app's folder reads to tell the app's page from a server's
  // fallback page (sw/routes/apps.js): not kept, the first visit back to an app waited on the network for it.
  const urls = ["/index.html", ...event.data.urls.filter((u) => typeof u === "string" && new URL(u, location.href).origin === location.origin).slice(0, 200)];
  event.waitUntil(Promise.all(urls.map((u) => cached(new Request(u), event).catch(() => {}))));
  // And, a little later, the parts no visit has used yet, so each works offline the first time too (sw/parts.js).
  // (Not while developing on this machine, where the network answers first and files change under the worker.)
  if (!LOCAL) event.waitUntil(keepParts(CACHE));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  // A visit begins: once the page has had time to draw, the parts a newer deploy brought are kept too (sw/parts.js).
  if (event.request.mode === "navigate" && cacheFirst(event.request)) event.waitUntil(keepParts(CACHE));
  // A page it serves waits for the host before its first paint (sw/render-blocking.js).
  // It goes without its preload hints, and the worker asks for the files they named itself (`ahead`, below).
  event.respondWith(event.request.mode === "navigate" ? answer(event, url).then((response) => renderBlocking(response, (files) => ahead(files, url, event))) : answer(event, url).then((response) => leftBehind(event, url, response)));
});

/** A built platform script: its content's hash is in its name, so each deploy has its own (public/_headers). */
const BUILT = "/assets/";
/** Where the time of the last reload this worker asked for is kept, for each page's address, so a page is never reloaded in a loop. */
const RELOADED = "/__reloaded-for-a-newer-version";

/**
 * A built script the server doesn't have. Only one thing asks for a name the server never made: a page (or its
 * kernel) from before the last deploy, wanting a part of its own older version that has since gone (the server
 * keeps old ones for a long while, scripts/keep-assets.mjs, so this is a page older than that). Nothing can
 * bring the file back, so the worker makes sure the way out works and says so:
 *
 *   - it forgets every page and script it kept, so the next load is the site as it is now, all of one version;
 *   - it tells each open tab, whose host tells the person to reload (or reloads, if it hadn't started yet);
 *   - a tab that asked for the file itself and has no host to hear (the page's own script is what failed to
 *     load, so nothing on it works) is loaded again by the worker, once.
 *
 * @param {FetchEvent} event @param {URL} url @param {Response} response
 */
function leftBehind(event, url, response) {
  // Not there: a 404, or a host that answers any address it has no file for with a page (a built script is never HTML).
  const missing = response.status === 404 || /^text\/html\b/.test(response.headers.get("Content-Type") ?? "");
  if (missing && url.pathname.startsWith(BUILT)) event.waitUntil(outOfDate(event.clientId, url.pathname).catch(() => {}));
  return response;
}

/** @param {string} clientId @param {string} path */
async function outOfDate(clientId, path) {
  const cache = await caches.open(CACHE);
  const kept = await cache.keys();
  await Promise.all(kept.map((request) => [request, new URL(request.url).pathname]).filter(([, at]) => !at.startsWith(BUILT) && at !== RELOADED).map(([request]) => cache.delete(request)));
  const tabs = await self.clients.matchAll({ type: "window" });
  await Promise.all(
    tabs.map(async (tab) => {
      const heard = await new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(false), 1500);
        channel.port1.onmessage = () => (clearTimeout(timer), resolve(true));
        tab.postMessage({ t: "sw:out-of-date", path }, [channel.port2]);
      });
      if (heard || tab.id !== clientId) return;
      // Once a minute for each address: a navigation gives the tab a new id, so its address is what is remembered,
      // and one tab's reload never keeps another's from happening.
      const mark = `${RELOADED}?${encodeURIComponent(tab.url)}`;
      const last = Number(await (await cache.match(mark))?.text()) || 0;
      if (Date.now() - last < 60_000) return;
      await cache.put(mark, new Response(String(Date.now())));
      await tab.navigate(tab.url).catch(() => {});
    }),
  );
}

/** @param {FetchEvent} event @param {URL} url */
async function answer(event, url) {
  // `wait` holds the worker open for work a route starts and doesn't wait for (sw/routes/made.js warms an app's files).
  const env = { fetch: (request) => cached(request, event), kernel: (name, arg, space = "") => kernel(event.clientId, name, arg, space), wait: (work) => event.waitUntil(work) };
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

/** How long after a kept file is answered it is fetched again, for the next visit. */
const REFRESH_MS = 2500;
/** The visits answered with a page that was kept. */
const keptPages = new WeakSet();

/** Files this worker is fetching ahead of a page that will ask for them, by address: the page's request is answered with the same fetch. */
const coming = new Map();
/** How long a file fetched ahead stays ready for the page to ask for. */
const AHEAD_MS = 5000;

/**
 * Asks for the files a page's preload hints named (sw/preload-hints.js), as the page is answered: the page comes
 * from here without the hints, and its own requests for those files, which begin once its script runs, are
 * answered with these. Not when the page came from what was kept: its files are kept too, and are answered at once.
 * @param {string[]} files as the page named them @param {URL} page @param {FetchEvent} event
 */
function ahead(files, page, event) {
  if (keptPages.has(event)) return;
  for (const file of files) {
    const url = new URL(file, page);
    if (url.origin !== location.origin) continue;
    // (A file still held from the visit before is asked for again: while developing, it may have changed.)
    coming.delete(url.href);
    const asked = cached(new Request(url.href), event);
    coming.set(url.href, asked);
    const done = () => setTimeout(() => coming.get(url.href) === asked && coming.delete(url.href), AHEAD_MS);
    event.waitUntil(asked.then(done, () => void (coming.get(url.href) === asked && coming.delete(url.href))));
  }
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
  // Already being fetched for the page that is now asking (`ahead`): the one fetch answers both.
  const early = request.method === "GET" && request.mode !== "navigate" ? coming.get(request.url) : undefined;
  if (early) {
    const response = await early.then((r) => r.clone(), () => undefined);
    if (response) return response;
  }
  const cache = await caches.open(CACHE);
  /** @type {Promise<Response> | undefined} */
  let asked;
  const fresh = () =>
    (asked ??= fetch(request).then((response) => {
      if (request.method === "GET" && response.ok && response.type === "basic" && !/no-store/.test(response.headers.get("Cache-Control") ?? "")) {
        const copy = response.clone();
        event.waitUntil(cache.put(request, copy).catch(() => {}));
      }
      return response;
    }));
  const path = new URL(request.url).pathname;
  const first = cacheFirst(request) && path !== RELOADED;
  // Asked for at once where the network answers first, as before; a kept file is looked for first.
  if (!first) void fresh().catch(() => {});
  else {
    const kept = await cache.match(request, KEPT);
    // A navigation can't be answered with a redirected response.
    if (kept && !(request.mode === "navigate" && kept.redirected)) {
      const page = request.mode === "navigate";
      // The page this visit is answered with came from what was kept (an app's folder is answered with its app.html).
      if (page || path.endsWith("/app.html")) keptPages.add(event);
      // A built file never changes at its address, so there is no newer copy to fetch. The rest are fetched again
      // once the page has had time to draw: a visit answered from what was kept is bound by this device's
      // processor, not its network, and thirty fetches and thirty files stored again were competing with the
      // page's own start. The page itself is asked for at once, so a deploy is seen as early as it was.
      if (!path.startsWith(BUILT)) event.waitUntil((page ? fresh() : new Promise((resolve) => setTimeout(resolve, REFRESH_MS)).then(fresh)).catch(() => {}));
      return kept;
    }
  }
  try {
    return await fresh();
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
