// Notifications: tells you, with your computer's own notifications, when the
// writer agent finishes or stops while you are in another tab or app, so you
// can leave it working. (Assistant alerts, alerts.js, tells you in the page;
// this is for when you aren't looking at it.) The toolbar button turns it on,
// which the first time asks the browser to let the site notify you. It uses
// the notify service, which shows nothing while you are looking at the app.
// The service worker shows the notification, so it stays in the notification
// centre after you close the editor, and a click on it opens the editor again.

export const manifest = {
  id: "notifications",
  name: "Notifications",
  description: "Your computer's notifications when the writer finishes, while you're away from the editor.",
  version: "1.0.0",
  order: 171,
  permissions: ["ui", "notify", "hook:listen:agent:done"],
  services: ["notify"],
};

export default async function (ctx) {
  let on = (await ctx.storage.get("on")) ?? false;
  let state = await ctx.call("notify", "state").catch(() => "unsupported");

  const button = () => {
    if (state === "unsupported") return ctx.ui.render("toolbar", "toggle", { type: "text", text: "" });
    const label = state === "denied" ? "Notifications blocked" : on && state === "granted" ? "Notify me: on" : "Notify me: off";
    ctx.ui.render("toolbar", "toggle", { type: "button", label, action: "toggle", title: state === "denied" ? "The browser was told not to show this site's notifications: allow them in the site's settings" : "Your computer's notifications when the writer finishes, while you're in another tab" });
  };

  ctx.ui.onEvent(async (action) => {
    if (action !== "toggle") return;
    // Asked right after the click, which the browser needs before it will ask the person.
    // Pinned to the click's trace, so the request is made in the tab that was clicked.
    if (!on && state !== "granted") state = await ctx.traced().call("notify", "request");
    on = !on && state === "granted";
    await ctx.storage.set("on", on);
    button();
  });

  ctx.on("agent:done", async (run) => {
    if (!on) return;
    const failed = run?.stopReason && run.stopReason !== "completed";
    const who = run?.agent ?? "The assistant";
    await ctx.call("notify", "show", { title: failed ? `${who} stopped` : `${who} is done`, body: failed ? `It stopped: ${run.stopReason}.` : "Its edits are in the post, for you to keep or undo. Click to open the editor.", tag: "agent" });
  });
  button();
}
