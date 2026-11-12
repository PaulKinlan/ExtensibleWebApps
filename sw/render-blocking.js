// Makes the platform's host script render-blocking on the pages the service
// worker serves: the browser waits for it to run before it first paints.
// The host is small and kept by the browser by then, so the wait is short,
// and in it the host holds each slot open at the size it had last time
// (src/host/reserve.ts). Painted first, the page would show without that
// room and then jump down to make it.
//
// Only a visit the service worker serves gets this: on a first visit there
// is nothing remembered to hold, and the page is exactly as its file says.

import { hintedFiles, withoutHints } from "./preload-hints.js";

const HOST = /<script\b(?![^>]*\bblocking=)([^>]*\bsrc=["']?\/platform\/host\.js["']?[^>]*)>/i;

/**
 * A page the worker serves also goes without its preload hints (sw/preload-hints.js). Those are for a visit no
 * worker answers. Here Chrome won't give a file preloaded through a service worker to the fetch() that asks for it
 * afterwards ("cross-world service worker resource mismatch"), so each hint would be a second request for the same
 * file; and on a visit answered from what was kept, thirty requests as the page arrives only get in the way of the
 * host's script and the kernel's (measured: a fifth slower on an app with five plugins).
 * @param {Response} response
 * @param {(files: string[], base?: string) => void} [hinted] told the addresses the hints named, as the page wrote
 * them, and the page's <base> if it has one, so the worker can ask for them itself (sw.js)
 */
export async function renderBlocking(response, hinted) {
  if (!response.ok || !(response.headers.get("Content-Type") ?? "").includes("text/html")) return response;
  const page = await response.clone().text();
  if (!HOST.test(page)) return response;
  const html = withoutHints(page);
  // (A page served at an address inside the app, /demos/reading-list/book/42, names its files from its <base>.)
  if (html !== page) hinted?.(hintedFiles(page), /<base\b[^>]*\bhref=["']?([^"'\s>]+)/i.exec(page)?.[1]);
  const headers = new Headers(response.headers);
  // The body is decoded here.
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  return new Response(html.replace(HOST, '<script blocking="render"$1>'), { status: response.status, statusText: response.statusText, headers });
}
