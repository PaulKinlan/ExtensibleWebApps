// Notifications the service worker shows (src/host/bridges/notify.ts). A
// notification shown here belongs to the service worker, not to a tab, so it
// stays in the system's notification centre after every tab of the app has
// closed, and a click on it still works: it brings forward a tab that has the
// app open, or opens the app again at the address it was shown from.
//
// Only an address on this site is ever opened: `data.url` is set by the
// platform's own bridge, and anything else is ignored.

/**
 * A page asks for a notification (`sw:notify`, from src/host/bridges/notify.ts): shown here, so it
 * belongs to the worker and outlives the page. Only pages on this site can message the worker.
 */
export function onNotifyMessage(event) {
  const { title, options } = event.data ?? {};
  if (typeof title !== "string" || !title) return;
  const { body, tag, icon, data } = options ?? {};
  event.waitUntil(self.registration.showNotification(title.slice(0, 120), { body: typeof body === "string" ? body.slice(0, 400) : undefined, tag: typeof tag === "string" ? tag : undefined, icon: typeof icon === "string" ? icon : undefined, data: { url: String(data?.url ?? "/"), app: String(data?.app ?? "/") } }).catch(() => {}));
}

/** Where a click on a notification goes: its `data.url`, if it is on this site; the site's root otherwise. */
export function addressOf(notification) {
  try {
    const url = new URL(notification?.data?.url ?? "/", self.location.href);
    return url.origin === self.location.origin ? url : new URL("/", self.location.href);
  } catch {
    return new URL("/", self.location.href);
  }
}

/** The app a notification came from: the folder of the page's base address (`data.app`), if it is on this site. */
export function appOf(notification) {
  try {
    const url = new URL(notification?.data?.app ?? "", self.location.href);
    return url.origin === self.location.origin ? url.pathname.replace(/[^/]*$/, "") : "/";
  } catch {
    return "/";
  }
}

/** A click on a notification: focus a tab already at its address (or in its app), or open one there. */
export function onNotificationClick(event) {
  event.notification.close();
  const url = addressOf(event.notification);
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const app = appOf(event.notification);
      const inApp = (tab) => {
        const path = new URL(tab.url).pathname;
        return app !== "/" && (path.startsWith(app) || `${path}/` === app);
      };
      const same = tabs.find((tab) => tab.url === url.href) ?? tabs.find(inApp);
      if (same) return same.focus();
      return self.clients.openWindow(url.href);
    })(),
  );
}
