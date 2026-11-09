// notify: the operating system's notifications (std/notify/module.ts). The
// Notification API lives in pages, and asking for permission needs a recent
// click, so the kernel asks the tab the person is using.

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
   * Shows a notification; a click on it brings this tab forward. False if notifications aren't allowed.
   * Where the page can't make one itself (Chrome on Android refuses `new Notification`), the service
   * worker shows it instead, without the click.
   */
  async show(note: { title: string; body?: string; tag?: string }) {
    if (!supported() || Notification.permission !== "granted") return false;
    const options = { body: note.body, tag: note.tag, icon: (document.querySelector('link[rel="icon"]') as HTMLLinkElement | null)?.href };
    try {
      const shown = new Notification(note.title, options);
      shown.onclick = () => {
        window.focus();
        shown.close();
      };
      return true;
    } catch {
      const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
      if (!registration) return false;
      await registration.showNotification(note.title, options);
      return true;
    }
  },
});
