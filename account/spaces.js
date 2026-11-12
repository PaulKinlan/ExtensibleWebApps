// Your spaces. A space holds people and their data, and any app can open in
// it (/s/<space>/<app>/). Make one, invite someone with a link that works
// once for a week, as an editor (who can change what the space keeps) or a
// reader (who can only see it), say later which of the two each member is,
// leave one you were invited to, and move one to another
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

/** A role, as the list names it, and what it lets someone do. */
const ROLES = { owner: "Owner", editor: "Editor", reader: "Reader" };
const CAN = { owner: "", editor: "You can change what this space keeps.", reader: "You can see what this space keeps, but not change it. Its owner can make you an editor." };

export default async function (ctx) {
  const views = ctx.ui.views("spaces.html");
  let status = "";
  /** The last invite made, while the same person is signed in. */
  let invite = "";
  let inviteAs = "";
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
    // Who is in each space, and as what. A space that can't say just now is shown without its people.
    const people = await Promise.all(spaces.map(({ name }) => ctx.call("account", "get", `/auth/spaces/${name}`).then((found) => found?.members ?? [], () => [])));
    views.render("spaces", "spaces", {
      user: true,
      app,
      site,
      spaces: spaces.map(({ name, role }, i) => ({
        name,
        owner: role === "owner",
        role: role === "owner" ? "yours" : role,
        can: CAN[role] ?? "",
        open: app ? `/s/${name}${app.path}` : "",
        members: people[i]
          .map((m) => ({ id: m.id, name: m.name, role: ROLES[m.role] ?? m.role, tone: m.role === "owner" ? "accent" : "neutral", you: m.id === user.id, change: role === "owner" && m.role !== "owner", to: m.role === "reader" ? "editor" : "reader", toLabel: m.role === "reader" ? "Make an editor" : "Make a reader" }))
          .sort((a, b) => Number(b.tone === "accent") - Number(a.tone === "accent") || a.name.localeCompare(b.name)),
      })),
      invite,
      inviteAs,
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
    const [verb, name, who, to] = action.split(":");
    if (verb === "invite" || verb === "invite-reader")
      return run(async () => {
        const answer = await ctx.call("account", "post", `/auth/spaces/${name}/invite`, { role: verb === "invite" ? "editor" : "reader" });
        if (!answer?.token) throw new Error(answer?.error ?? "The server didn't make an invite. Try again.");
        invite = `${answer.site}/account/?invite=${answer.token}`;
        inviteAs = verb === "invite" ? "They'll be able to change what the space keeps." : "They'll be able to see what the space keeps, but not change it.";
      }, `Here's an invite to ${name}.`);
    if (verb === "role")
      return run(async () => {
        const answer = await ctx.call("account", "post", `/auth/spaces/${name}/role`, { user: who, role: to });
        if (!answer?.ok) throw new Error(answer?.error ?? "The server didn't change it. Try again.");
        return to === "reader" ? `They can now only see what ${name} keeps. Any agent keys they made for it have stopped working.` : `They can now change what ${name} keeps.`;
      });
    if (verb === "remove")
      return run(async () => {
        const answer = await ctx.call("account", "post", `/auth/spaces/${name}/leave`, { user: who });
        if (!answer?.ok) throw new Error(answer?.error ?? "The server didn't remove them. Try again.");
      }, `They're no longer in ${name}.`);
    if (verb === "leave") return run(() => ctx.call("account", "post", `/auth/spaces/${name}/leave`, {}), `You've left ${name}.`);
    if (verb === "load")
      return run(async () => {
        const loaded = await ctx.call("account", "load", name);
        if (loaded === null) return "";
      }, `The copy is in ${name}. Invite the others again: they have accounts on the old server, not this one.`);
  });
  await draw();
}
