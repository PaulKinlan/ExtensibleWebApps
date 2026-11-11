// Who is signed in, on this site's server: sign in with a passkey, make an
// account, add a passkey on another device, sign out. Also what a link to
// this page asks for: /account/?invite=… (join a space once signed in),
// ?confirm=… (the link mailed to an email address) and ?error=… (another
// site's sign-in went wrong). The other sections of the page are plugins of
// their own, and hear account:changed when the person signs in or out.

export const manifest = {
  id: "account-signin",
  name: "Your account",
  description: "Sign in with a passkey, make an account, and sign out.",
  version: "1.0.0",
  scope: "tab",
  permissions: ["ui", "account", "hook:listen:account:changed", "hook:listen:router:changed", "router"],
  services: ["account", "router"],
};

export default async function (ctx) {
  const views = ctx.ui.views("account.html");
  /** What the last thing done said. */
  let status = "";
  /** An invite in the address, joined once the person is signed in. */
  let invite;
  /** Set while this plugin does something: it draws when that's done, so account:changed needn't. */
  let busy = false;
  /** What links here have asked for (and invites joined), so each is done once. */
  const seen = new Set();

  const draw = async () => {
    const me = await ctx.call("account", "get", "/auth/me");
    const user = me.unavailable ? null : (me.user ?? null);
    if (user && invite) {
      const token = invite;
      invite = undefined;
      seen.add(`joined=${token}`);
      const joined = await ctx.call("account", "post", "/auth/invites/accept", { token }).catch((error) => ({ error: error.message }));
      status = joined.space ? `You've joined ${joined.space.name}.` : joined.error;
      await ctx.call("router", "go", "/", { replace: true });
    }
    views.render("main", "account", { unavailable: !!me.unavailable, out: !me.unavailable && !user, user, status });
  };

  /** Does something, then says how it went. */
  const run = async (task, done) => {
    status = "";
    busy = true;
    try {
      const said = await task();
      status = typeof said === "string" ? said : done;
    } catch (error) {
      status = error.message;
    }
    busy = false;
    await draw();
  };

  ctx.on("account:changed", () => (busy ? undefined : draw()));
  ctx.ui.onEvent((action, value) => {
    if (action === "signin")
      return run(async () => {
        const answer = await ctx.call("account", "signin");
        if (answer.status === 401) throw new Error(answer.error);
      }, "You're signed in.");
    if (action === "register") return run(() => ctx.call("account", "register", String(value?.name ?? "").trim()), "Your account is made, and you're signed in.");
    if (action === "add") return run(() => ctx.call("account", "register"), "Another passkey is added to your account.");
    if (action === "signout") return run(async () => {
        // This browser's notifications are the person's who is leaving: they stop here, so the next person to sign in doesn't see them.
        await ctx.call("account", "notifications", "off").catch(() => {});
        return ctx.call("account", "post", "/auth/signout", {});
      }, "You're signed out.");
  });

  // What the link here asked for, once: then the address is the account page's own again. An invite
  // stays in it until it is joined, so signing in with another site (providers.js) can carry it there and back.
  // The tab tells the kernel its address as it opens, which may be after this plugin starts: so both.
  const arrived = async (query) => {
    const asked = ["invite", "error", "confirm"].filter((k) => query[k]).map((k) => `${k}=${query[k]}`).join("&");
    if (!asked || seen.has(asked)) return false;
    seen.add(asked);
    if (query.invite && !seen.has(`joined=${query.invite}`)) invite = query.invite;
    if (query.error) status = query.error;
    if (query.error || query.confirm) await ctx.call("router", "go", query.invite ? `/?invite=${encodeURIComponent(query.invite)}` : "/", { replace: true });
    // The link mailed to an address confirms it. It needs no sign-in: having the link is the proof.
    if (query.confirm) await run(() => ctx.call("account", "post", "/auth/me/email/confirm", { token: query.confirm }), "Your email is confirmed.");
    else await draw();
    return true;
  };
  const here = ctx.call("router", "current");
  ctx.on("router:changed", async (change) => (change.tab === (await here).tab ? arrived(change.query ?? {}) : undefined));
  if (!(await arrived((await here).query))) await draw();
}
