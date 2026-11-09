// The other sites this server lets people sign in with (src/server/auth/providers/,
// set by the site's AUTH_PROVIDERS): a button each, in the slot the account
// view leaves for them (account-signin.providers). Signed out, it signs in with that
// site; signed in, it links that site's account to yours. A provider that
// needs something typed first (Bluesky: your handle) gets a small form.
// An invite in the address goes along, so it is joined on the way back.

export const manifest = {
  id: "account-providers",
  name: "Sign in with another site",
  description: "Buttons to sign in with the other sites this server allows.",
  version: "1.0.0",
  scope: "tab",
  permissions: ["ui", "account", "hook:listen:account:changed", "router"],
  services: ["account", "router"],
};

export default async function (ctx) {
  const views = ctx.ui.views("providers.html");
  let providers = [];
  try {
    ({ providers = [] } = await ctx.call("account", "get", "/auth/providers"));
  } catch {
    // A site with no server has none.
  }

  const draw = async () => {
    const me = await ctx.call("account", "get", "/auth/me");
    const signedIn = !!me.user;
    views.render("account-signin.providers", "providers", {
      providers: providers.map(({ id, name, ask }) => ({ id, ask, text: signedIn ? `Link your ${name} account` : `Sign in with ${name}` })),
    });
  };

  ctx.on("account:changed", () => draw());
  // "start:<id>", from a button, or from a provider's form with what it asks for.
  ctx.ui.onEvent(async (action, value) => {
    if (!action.startsWith("start:")) return;
    const { query } = await ctx.call("router", "current");
    const fields = { ...(value && typeof value === "object" ? value : {}), ...(query.invite ? { invite: query.invite } : {}) };
    await ctx.call("account", "start", action.slice(6), fields);
  });
  await draw();
}
