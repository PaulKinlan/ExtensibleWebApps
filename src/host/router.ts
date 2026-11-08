// The app's screens, for the router service (src/kernel/services/router.ts).
// A screen is an address inside the app's folder: /demos/reading-list/book/42
// is the reading list's screen /book/42. The service worker serves the app's
// page there, with a <base> naming the folder (sw/routes/apps.js).
//
// Moving between screens doesn't load the page again: a link to a screen,
// back and forward, and router.go change the address with the History API,
// and the page tells the kernel its new screen.

/** The app's folder, as the page loaded: its <base> when it was opened at a screen, or the page's own folder. */
export const folder = new URL(".", document.baseURI).pathname;

/** Whether an address on this site is a screen of this app: inside its folder, and not a file (a last part with a dot). */
function isScreen(url: URL): boolean {
  // The site's front page (/) has no screens: the service worker never serves it at another address
  // (sw/routes/apps.js), so /docs/ or /workbench/ from there is another page, to load.
  if (folder === "/") return url.origin === location.origin && url.pathname === "/";
  const inside = url.pathname.startsWith(folder) || `${url.pathname}/` === folder;
  return url.origin === location.origin && inside && !url.pathname.split("/").pop()!.includes(".");
}

/** The screen the address shows: `/demos/reading-list/book/42?tab=notes` is `/book/42` with `{ tab: "notes" }`. */
export function screen(): { path: string; query: Record<string, string> } {
  const rest = location.pathname.startsWith(folder) ? location.pathname.slice(folder.length) : "";
  return { path: `/${rest === "app.html" ? "" : rest}`, query: Object.fromEntries(new URLSearchParams(location.search)) };
}

/** Moves to a screen (`/book/42?tab=notes`) without loading the page, and says so as back and forward do. */
export function go(path: string, replace = false): void {
  const url = new URL(folder + path.replace(/^\/+/, ""), location.origin);
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  dispatchEvent(new PopStateEvent("popstate"));
}

/** Follows clicks on links to this app's screens without loading the page. Links elsewhere, to files, or opened in a new tab are left to the browser. */
export function followLinks(): void {
  addEventListener("click", (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // Plugins' views can be inside custom elements' shadow roots: the path finds the link there too.
    const link = event.composedPath().find((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement && el.hasAttribute("href"));
    if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
    const url = new URL(link.href);
    // A link to a place on this page (#notes) stays the browser's.
    if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
    if (!isScreen(url)) return;
    event.preventDefault();
    // The hash goes along, so a link to a heading on another screen (guide/agents#hooks) can scroll to it.
    go(url.pathname.slice(folder.length) + url.search + url.hash);
  });
}
