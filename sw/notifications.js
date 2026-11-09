// Notifications the service worker shows (src/host/bridges/notify.ts). A
// notification shown here belongs to the service worker, not to a tab, so it
// stays in the system's notification centre after every tab of the app has
// closed, and a click on it still works: it brings forward a tab that has the
// app open, or opens the app again at the address it was shown from.
//
// Only an address on this site is ever opened: `data.url` is set by the
// platform's own bridge, and anything else is ignored.

/** Where a click on a notification goes: its `data.url`, if it is on this site; the site's root otherwise. */
export function addressOf(notification) {
  try {
    const url = new URL(notification?.data?.url ?? "/", self.location.href);
    return url.origin === self.location.origin ? url : new URL("/", self.location.href);
  } catch {
    return new URL("/", self.location.href);
  }
}

/** A click on a notification: focus a tab already at its address (or in its app), or open one there. */
export function onNotificationClick(event) {
  event.notification.close();
  const url = addressOf(event.notification);
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const app = url.pathname.replace(/[^/]*$/, "");
      const same = tabs.find((tab) => tab.url === url.href) ?? tabs.find((tab) => new URL(tab.url).pathname.startsWith(app) && app !== "/");
      if (same) return same.focus();
      return self.clients.openWindow(url.href);
    })(),
  );
}
