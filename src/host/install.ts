// Makes the page installable: links it to manifest.webmanifest in its app's
// folder, if it doesn't link a manifest of its own. An app with no
// manifest.webmanifest file gets one made from its page by the service worker
// (sw/routes/manifest.js), so the link waits until the service worker
// controls the page: on a first visit, before it has started, there is
// nothing at that address yet.

import { folder } from "./router";

export function installable(): void {
  if (document.querySelector('link[rel~="manifest"]') || !("serviceWorker" in navigator)) return;
  const link = () => {
    if (document.querySelector('link[rel~="manifest"]')) return;
    const manifest = document.createElement("link");
    manifest.rel = "manifest";
    manifest.href = new URL("manifest.webmanifest", new URL(folder, location.origin)).pathname;
    document.head.append(manifest);
  };
  if (navigator.serviceWorker.controller) link();
  else navigator.serviceWorker.addEventListener("controllerchange", link, { once: true });
}
