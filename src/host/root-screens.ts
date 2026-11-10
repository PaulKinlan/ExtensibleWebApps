// Links in an app at the site's root (a project's one app: scripts/extensible-app.mjs).
//
// In a folder, an app's screens are the addresses inside the folder. At the
// root they share it with the site's own pages and apps (/account/, a space's
// /s/…, sign-in's /auth/…), and only the service worker knows which an
// address is: it is what answers a visit to one (sw/routes/apps.js). So a link
// there is asked about first. An address the worker would answer with this
// app's page is a screen, moved to with the History API, without loading the
// page again; any other is loaded as the page it is.
//
// Fetched the first time such a link is followed (src/host/router.ts), so no
// other page pays for it.

/** What the service worker said of each address asked about, so a link followed twice asks once. */
const screens = new Map<string, Promise<boolean>>();

/** Whether an address is a screen of the app at the root. With no service worker running the page yet, or no answer in time, it isn't taken as one: the link loads. */
function isScreen(url: URL): Promise<boolean> {
  const address = url.pathname + url.search;
  let asked = screens.get(address);
  if (asked) return asked;
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return Promise.resolve(false);
  asked = new Promise<boolean>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    const late = setTimeout(() => {
      screens.delete(address);
      resolve(false);
    }, 5000);
    port1.onmessage = (event) => {
      clearTimeout(late);
      resolve(event.data === true);
    };
    worker.postMessage({ t: "sw:screen", url: url.href }, [port2]);
  });
  screens.set(address, asked);
  return asked;
}

/** Follows a link to an address at the root: moves to it as a screen with `go`, or else loads it. */
export async function follow(url: URL, go: (path: string) => void): Promise<void> {
  if (await isScreen(url)) go(url.pathname.slice(1) + url.search + url.hash);
  else location.assign(url);
}
