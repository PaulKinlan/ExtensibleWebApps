// Notifications that arrive with every tab closed: Web Push. A space's
// server plugin shows a notification (std/notify/module.ts), the server sends
// it to the push service of each device its members turned notifications on
// for (src/server/auth/push.ts), and the push service wakes this worker,
// which shows it. A click is the same as for any notification the worker
// shows (sw/notifications.js): it brings forward a tab with the app open, or
// opens the app in its space.
//
// Only this site's server can send here: a push service takes a message for a
// subscription only from the holder of the key the subscription was made for,
// and the message is encrypted for this browser alone.

/** What a push says: { title, body?, tag?, url, app?, always? }. A message that can't be read still shows something, as a browser expects of every push. */
function noteOf(event) {
  try {
    const note = event.data?.json();
    if (note && typeof note.title === "string" && note.title) return note;
  } catch {}
  return { title: `Something new on ${self.location.host}`, url: "/" };
}

/** Whether the person is looking at the app a note is from, in a tab of this browser: then its own view tells them. */
async function looking(app) {
  if (typeof app !== "string" || !app.startsWith("/") || app === "/") return false;
  const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return tabs.some((tab) => tab.focused && tab.visibilityState === "visible" && `${new URL(tab.url).pathname}/`.replace(/\/+$/, "/").startsWith(app));
}

export function onPush(event) {
  const note = noteOf(event);
  event.waitUntil(
    (async () => {
      if (!note.always && (await looking(note.app))) return;
      await self.registration.showNotification(String(note.title).slice(0, 120), {
        body: typeof note.body === "string" ? note.body.slice(0, 400) : undefined,
        tag: typeof note.tag === "string" ? note.tag : undefined,
        icon: "/app-icon.svg",
        data: { url: String(note.url ?? "/"), app: String(note.app ?? "/") },
      });
    })(),
  );
}

/**
 * The browser replaced this device's subscription (push services do, now and then): the account is given the new
 * one, as the person who is signed in here, so notifications keep arriving without their doing anything.
 */
export function onSubscriptionChange(event) {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const fresh = event.newSubscription ?? (old?.options ? await self.registration.pushManager.subscribe(old.options).catch(() => null) : null);
      const post = (path, body) => fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
      if (fresh) await post("/auth/push", { subscription: fresh.toJSON(), label: "A browser (renewed)" });
      if (old && old.endpoint !== fresh?.endpoint) await post("/auth/push/remove", { endpoint: old.endpoint });
    })(),
  );
}
