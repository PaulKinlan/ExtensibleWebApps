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
   * The service worker shows it where there is one (sw/notifications.js), so it stays in the system's
   * notification centre after every tab closes, and a click then opens the app again at this address.
   * Without one running yet (the first visit) the page shows it itself.
   */
  async show(note: { title: string; body?: string; tag?: string }) {
    if (!supported() || Notification.permission !== "granted") return false;
    const options = { body: note.body, tag: note.tag, icon: (document.querySelector('link[rel="icon"]') as HTMLLinkElement | null)?.href, data: { url: location.href } };
    const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
    if (registration?.active) return registration.showNotification(note.title, options).then(() => true, () => false);
    // Throws where the page can't make one (the kernel takes that as not shown).
    new Notification(note.title, options).onclick = function () {
      window.focus();
      this.close();
    };
    return true;
  },
});
