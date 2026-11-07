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

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  event.respondWith(answer(event, url));
});

/** @param {FetchEvent} event @param {URL} url */
async function answer(event, url) {
  const env = { fetch: cached, kernel: (name, arg) => kernel(event.clientId, name, arg) };
  for (const route of routes) {
    if (route.prefix && !url.pathname.startsWith(route.prefix)) continue;
    try {
      const response = await route.handle(event.request, url, env);
      if (response) return response;
    } catch (error) {
      return new Response(`The ${route.name ?? "route"} route failed: ${error instanceof Error ? error.message : error}`, { status: 500 });
    }
  }
  return event.request.method === "GET" ? cached(event.request) : fetch(event.request);
}

/**
 * The network first, so a change shows at once; what came back is kept, and
 * used when the network can't be reached.
 * @param {Request} request
 */
async function cached(request) {
  try {
    const response = await fetch(request);
    if (request.method === "GET" && response.ok && response.type === "basic" && !/no-store/.test(response.headers.get("Cache-Control") ?? "")) {
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  } catch (error) {
    const kept = await caches.match(request, { ignoreVary: true });
    if (kept) return kept;
    throw error;
  }
}

/**
 * Asks the kernel, through a tab: the tab that made the request if it has
 * the platform loaded, or else any open tab. A tab answers in its host
 * (src/host/service-worker.ts). Rejects when no tab answers.
 * @param {string} clientId @param {string} name @param {unknown} arg
 */
async function kernel(clientId, name, arg) {
  const own = clientId ? await self.clients.get(clientId) : undefined;
  const windows = await self.clients.matchAll({ type: "window" });
  const tabs = [own, ...windows.filter((w) => w.id !== clientId)].filter(Boolean);
  for (const tab of tabs) {
    const answer = await ask(tab, name, arg).catch(() => undefined);
    if (answer) return answer.ok ? answer.value : Promise.reject(new Error(answer.error));
  }
  throw new Error("No open tab can reach the kernel");
}

/** @param {Client} tab @param {string} name @param {unknown} arg */
function ask(tab, name, arg) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("timed out")), 5000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
    tab.postMessage({ t: "sw:kernel", name, arg }, [channel.port2]);
  });
}
