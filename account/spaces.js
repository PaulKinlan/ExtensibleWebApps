// Your spaces. A space holds people and their data, and any app can open in
// it (/s/<space>/<app>/). Make one, invite someone as a member or a read-only
// viewer with a link that works once for a week, switch members between
// member and viewer, leave one you were invited to, and move one to another
// server: Download a copy of everything in it, and Load a copy into an empty
// one (src/server/transfer.ts). If you came here from an app, each space
// offers to open that app in it. Shown only to someone signed in.

export const manifest = {
  id: "account-spaces",
  name: "Your spaces",
  description: "Make spaces, invite people to them, and open apps in them.",
  version: "1.0.0",
  scope: "tab",
  permissions: ["ui", "account", "hook:listen:account:changed", "hook:listen:router:changed", "router"],
  services: ["account", "router"],
};

export default async function (ctx) {
  const views = ctx.ui.views("spaces.html");
  let status = "";
  /** The last invite made, while the same person is signed in. */
  let invite = "";
  let revision = 0;
  /** The app the person came here from, to open in a space ({ path, title }), if any: asked until the tab can say. */
  let app = null;
  let known = false;
  const cameFrom = async () => {
    if (known) return app;
    try {
      const came = await ctx.call("account", "came");
      known = true;
      if (came?.error) status = came.error;
      app = came?.path ? came : null;
    } catch {
      // The tab is still opening: the next draw asks again.
    }
    return app;
  };

  const draw = async () => {
    const { user, site } = await ctx.call("account", "get", "/auth/me");
    // Asked signed out too, so the app is kept for the tab before the person leaves to sign in with another site.
    const app = await cameFrom();
    if (!user) {
      invite = "";
      return views.render("spaces", "spaces", { user: null });
    }
    const { spaces = [] } = await ctx.call("account", "get", "/auth/spaces");
    const details = await Promise.all(
      spaces.map(({ name }) => ctx.call("account", "get", `/auth/spaces/${name}`).catch(() => ({ members: [] }))),
    );
    views.render("spaces", "spaces", {
      user: true,
      app,
      site,
      spaces: spaces.map(({ name, role }, i) => {
        const owner = role === "owner";
        const members = (details[i]?.members ?? []).map((m) => ({
          id: m.id,
          name: m.name,
          role: m.role,
          editable: owner && m.role !== "owner",
          isMember: m.role === "member",
          isViewer: m.role === "viewer",
        }));
        return {
          name,
          owner,
          role: owner ? "yours" : role === "viewer" ? "viewer" : "member",
          open: app ? `/s/${name}${app.path}` : "",
          hasMembers: members.length > 1,
          members,
        };
      }),
      invite,
      status,
      revision,
    });
  };

  const run = async (task, done) => {
    status = "";
    try {
      const said = await task();
      status = typeof said === "string" ? said : done;
    } catch (error) {
      status = error.message;
    }
    await draw();
  };

  ctx.on("account:changed", () => draw());
  // The tab says its address (and so ?app=) as it opens, which may be after the first draw.
  ctx.on("router:changed", () => (known ? undefined : draw()));
  ctx.ui.onEvent((action, value) => {
    if (action === "make")
      return run(async () => {
        await ctx.call("account", "post", "/auth/spaces", { name: String(value?.name ?? "").trim() });
        revision++;
      }, "Your space is made.");
    const [verb, name, who] = action.split(":");
    if (verb === "invite")
      return run(async () => {
        const role = value?.role === "viewer" ? "viewer" : "member";
        const { token, site } = await ctx.call("account", "post", `/auth/spaces/${name}/invite`, { role });
        invite = `${site}/account/?invite=${token}`;
        return role === "viewer" ? `Here's a viewer invite to ${name}.` : `Here's an invite to ${name}.`;
      }, `Here's an invite to ${name}.`);
    if (verb === "role" && name && who)
      return run(async () => {
        const role = value === "viewer" ? "viewer" : "member";
        await ctx.call("account", "post", `/auth/spaces/${name}/role`, { user: who, role });
        return `Changed role in ${name} to ${role}.`;
      }, `Role updated.`);
    if (verb === "leave") return run(() => ctx.call("account", "post", `/auth/spaces/${name}/leave`, {}), `You've left ${name}.`);
    if (verb === "load")
      return run(async () => {
        const loaded = await ctx.call("account", "load", name);
        if (loaded === null) return "";
      }, `The copy is in ${name}. Invite the others again: they have accounts on the old server, not this one.`);
  });
  await draw();
}
