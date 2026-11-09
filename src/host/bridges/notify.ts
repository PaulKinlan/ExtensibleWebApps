// notify: the operating system's notifications (std/notify/module.ts). The
// Notification API lives in pages, and asking for permission needs a recent
// click, so the kernel asks the tab the person is using. The notification
// itself is the service worker's where it can be, so it outlives the tab.

import type { BridgeHost } from "./index";

const supported = () => typeof Notification === "function";

export default (_host: BridgeHost) => ({
  /** "granted", "denied", "default" (not asked yet) or "unsupported". */
  state: () => (supported() ? Notification.permission : "unsupported"),
  /** Asks the person to allow notifications (right after a click); the answer. */
  async request() {
    if (!supported()) return "unsupported";
    if (Notification.permission !== "default") return Notification.permission;
    return Notification.requestPermission();
  },
  /** Whether the person can see this tab now. */
  visible: () => document.visibilityState === "visible" && document.hasFocus(),
  /**
   * Shows a notification; a click on it brings this app forward. False if notifications aren't allowed.
   * The service worker shows it (sw/notifications.js, which this page hands it to), so it stays in the
   * system's notification centre after every tab closes, and a click then opens the app again. A page
   * the worker doesn't control yet (the first visit) shows it itself, with no click to come back to; that
   * throws where a page can't (Chrome on Android), which the kernel takes as not shown.
   */
  show(note: { title: string; body?: string; tag?: string }) {
    if (!supported() || Notification.permission !== "granted") return false;
    const options = { body: note.body, tag: note.tag, icon: (document.querySelector('link[rel="icon"]') as HTMLLinkElement | null)?.href, data: { url: location.href, app: document.baseURI } };
    const worker = navigator.serviceWorker?.controller;
    if (worker) worker.postMessage({ t: "sw:notify", title: note.title, options });
    else new Notification(note.title, options);
    return true;
  },
});
