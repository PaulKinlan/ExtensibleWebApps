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

const CACHE = "platform-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The first visit loads before this worker starts, so nothing it loaded was kept. The page then
// sends what it loaded (src/host/service-worker.ts), and it is fetched again and kept, so the
// app opens offline after one visit.
self.addEventListener("message", (event) => {
  if (event.data?.t !== "sw:warm" || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.filter((u) => typeof u === "string" && new URL(u, location.href).origin === location.origin).slice(0, 200);
  event.waitUntil(Promise.all(urls.map((u) => cached(new Request(u), event).catch(() => {}))));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  event.respondWith(answer(event, url));
});

/** @param {FetchEvent} event @param {URL} url */
async function answer(event, url) {
  const env = { fetch: (request) => cached(request, event), kernel: (name, arg) => kernel(event.clientId, name, arg) };
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

/**
 * The network first, so a change shows at once; what came back is kept, and
 * used when the network can't be reached. Keeping it is held open with
 * waitUntil, so the browser doesn't stop the worker before it is stored.
 * @param {Request} request @param {ExtendableEvent} event
 */
async function cached(request, event) {
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const kept = await (await caches.open(CACHE)).match(request);
    if (kept) return kept;
    throw error;
  }
  if (request.method === "GET" && response.ok && response.type === "basic" && !/no-store/.test(response.headers.get("Cache-Control") ?? "")) {
    const copy = response.clone();
    event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {}));
  }
  return response;
}

/**
 * Asks the kernel, through a tab: the tab that made the request if it has
 * the platform loaded, or else any open tab. A tab answers in its host
 * (src/host/service-worker.ts): at once with { taken }, and later with the
 * answer. Only a tab that hasn't taken the question within a second is
 * passed over, so the kernel never runs one request twice. Rejects when no
 * tab takes it.
 * @param {string} clientId @param {string} name @param {unknown} arg
 */
async function kernel(clientId, name, arg) {
  const own = clientId ? await self.clients.get(clientId) : undefined;
  const windows = await self.clients.matchAll({ type: "window" });
  const tabs = [own, ...windows.filter((w) => w.id !== clientId)].filter(Boolean);
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
