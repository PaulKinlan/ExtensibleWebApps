// The parts of the platform an app fetches only when it first uses them (a
// kernel module, the review card, the drawing code: every built file under
// /assets/, and the panel of a plugin that waits for its first use, as
// Customize does), kept ahead of time so that first use works
// offline too. Without this, the service worker keeps only what a visit
// fetched, and a person who goes offline and then does something new (asks
// for undo's module, gets their first review card) is told that part isn't
// on this device.
//
// The build writes the list, /platform/parts.json (vite.parts.ts). Some
// seconds after a visit begins, so nothing here competes with the page
// loading, the worker reads the list and fetches what it hasn't kept, one
// file at a time. It does so once for each deploy: the list it finished is
// kept beside the files, and the same list again means there is nothing to
// do. A browser asked to save data (Save-Data) is left alone: there, a part
// is kept when it is first used, as before.

const LIST = "/platform/parts.json";
/** Long enough for a first visit to have drawn, on a slow connection too. */
const WAIT_MS = 5000;
/** One look for each time the browser starts this worker. */
let looked = false;

/**
 * Keeps every listed part in the cache named. Never throws: a list or a file that can't be fetched is tried again
 * the next time the worker starts.
 * @param {string} cacheName @param {number} [wait]
 */
export async function keepParts(cacheName, wait = WAIT_MS) {
  if (looked || self.navigator.connection?.saveData) return;
  looked = true;
  try {
    await new Promise((resolve) => setTimeout(resolve, wait));
    const response = await fetch(LIST, { cache: "no-cache" });
    // No list: development, where nothing is built, or a build from before there was one.
    if (!response.ok) return;
    const text = await response.clone().text();
    const cache = await caches.open(cacheName);
    if ((await (await cache.match(LIST))?.text()) === text) return;
    const { files } = JSON.parse(text);
    if (!Array.isArray(files)) return;
    let all = true;
    for (const file of files) {
      // Only this site's own built files: the list is never a way to make the worker fetch anything else.
      if (typeof file !== "string" || !/^\/(assets|platform|std|elements)\/[\w.-]+$/.test(file)) continue;
      if (await cache.match(file, { ignoreVary: true })) continue;
      const part = await fetch(file).catch(() => undefined);
      if (part?.ok) await cache.put(file, part);
      else all = false;
    }
    // Kept only once every part is: a list half done is done again.
    if (all) await cache.put(LIST, response);
    else looked = false;
  } catch {
    looked = false;
  }
}
