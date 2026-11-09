// Your email address, for apps in your spaces to email you at (std/email/module.ts),
// such as a survey's daily digest. Saving one mails it a link that confirms it
// (account.js opens that link); until then apps can't email it. Saving it
// empty takes it away. Shown only to someone signed in.

export const manifest = {
  id: "account-email",
  name: "Your email",
  description: "The address apps in your spaces may email you at, once you confirm it.",
  version: "1.0.0",
  scope: "tab",
  permissions: ["ui", "account", "hook:listen:account:changed"],
  services: ["account"],
};

export default async function (ctx) {
  const views = ctx.ui.views("email.html");
  let status = "";
  /** Changes when the form should start again from what the server has. */
  let revision = 0;

  const draw = async () => {
    const { user } = await ctx.call("account", "get", "/auth/me");
    const state = !user?.email ? "" : user.emailConfirmed ? "Confirmed: apps in your spaces can email you here." : "Not confirmed yet: open the link we mailed to it, or press Save to send a new one. Until then, apps can't email it.";
    views.render("email", "email", { user: user ? { email: user.email ?? "", confirmed: !!user.emailConfirmed } : null, state, status, revision });
  };

  const run = async (task, done) => {
    status = "";
    try {
      const said = await task();
      status = typeof said === "string" ? said : done;
    } catch (error) {
      status = error.message;
    }
    revision++;
    await draw();
  };

  ctx.on("account:changed", () => draw());
  ctx.ui.onEvent((action, value) => {
    if (action === "save")
      return run(async () => {
        const answer = await ctx.call("account", "post", "/auth/me/email", { email: String(value?.email ?? "").trim() });
        if (answer.status === 401) throw new Error("You're signed out: sign in again, then save it");
        if (answer.sent) return "Look in your inbox (and spam) for a link to confirm your address.";
        if (answer.user?.emailConfirmed) return "That address is already confirmed.";
      }, "Your email is removed.");
    if (action === "test")
      return run(async () => {
        const answer = await ctx.call("account", "post", "/auth/me/email/test", {});
        if (answer.status !== 200) throw new Error(answer.error ?? "The test message couldn't be sent");
      }, "A test message is on its way: look in your inbox (and spam).");
  });
  await draw();
}
