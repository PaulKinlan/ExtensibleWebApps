// Makes the platform's host script render-blocking on the pages the service
// worker serves: the browser waits for it to run before it first paints.
// The host is small and kept by the browser by then, so the wait is short,
// and in it the host holds each slot open at the size it had last time
// (src/host/reserve.ts). Painted first, the page would show without that
// room and then jump down to make it.
//
// Only a visit the service worker serves gets this: on a first visit there
// is nothing remembered to hold, and the page is exactly as its file says.

const HOST = /<script\b(?![^>]*\bblocking=)([^>]*\bsrc=["']?\/platform\/host\.js["']?[^>]*)>/i;

/** @param {Response} response */
export async function renderBlocking(response) {
  if (!response.ok || !(response.headers.get("Content-Type") ?? "").includes("text/html")) return response;
  const html = await response.clone().text();
  if (!HOST.test(html)) return response;
  const headers = new Headers(response.headers);
  // The body is decoded here.
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  return new Response(html.replace(HOST, '<script blocking="render"$1>'), { status: response.status, statusText: response.statusText, headers });
}
