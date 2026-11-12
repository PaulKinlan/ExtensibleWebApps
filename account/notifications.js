// Notifications on this device, with every tab closed (Web Push). Apps in a
// person's spaces can tell them something when nobody has the app open: a
// reminder that came due, a chore that's overdue. A plugin on the space's
// server sends it (notify.show, std/notify/module.ts) to the devices each
// member turned on here; the site's service worker shows it (sw/push.js).
// This turns it on for the browser the person is using, lists their devices,
// takes one away, and sends a test. Shown only to someone signed in.

export const manifest = {
  id: "account-notifications",
  name: "Notifications on this device",
  description: "Turn on notifications from apps in your spaces, which arrive with the site closed.",
  version: "1.0.0",
  scope: "tab",
  permissions: ["ui", "account", "hook:listen:account:changed"],
  services: ["account"],
};

const when = (at) => new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });

export default async function (ctx) {
  const views = ctx.ui.views("notifications.html");
  let status = "";

  const draw = async () => {
    const { user } = await ctx.call("account", "get", "/auth/me");
    if (!user) return views.render("notifications", "notifications", { user: null });
    let s;
    try {
      s = await ctx.call("account", "notifications");
    } catch (error) {
      // The tab is still opening, or the server has no accounts for it: say so rather than draw nothing.
      return views.render("notifications", "notifications", { user: true, unsupported: false, blocked: false, here: false, canTurnOn: false, devices: [], status: status || error.message });
    }
    views.render("notifications", "notifications", {
      user: true,
      unsupported: !s.supported,
      blocked: s.supported && s.permission === "denied",
      here: s.here,
      canTurnOn: s.supported && s.permission !== "denied" && !s.here,
      devices: s.devices.map((d) => ({ id: d.id, label: d.here ? `${d.label} (this one)` : d.label, since: `since ${when(d.created)}`, here: d.here })),
      status,
    });
  };

  const run = async (task, done) => {
    status = "";
    try {
      await task();
      status = done;
    } catch (error) {
      status = error.message;
    }
    await draw();
  };

  ctx.on("account:changed", () => draw());
  ctx.ui.onEvent((action) => {
    if (action === "on") return run(() => ctx.call("account", "notifications", "on"), "Notifications are on for this device. Send a test to see one arrive.");
    if (action === "off") return run(() => ctx.call("account", "notifications", "off"), "Notifications are off for this device.");
    if (action === "test") return run(() => ctx.call("account", "notifications", "test"), "A test notification is on its way to your devices.");
    const [verb, id] = action.split(":");
    if (verb === "remove")
      return run(async () => {
        await ctx.call("account", "post", "/auth/push/remove", { id });
      }, "That device won't get notifications any more.");
  });
  await draw();
}
