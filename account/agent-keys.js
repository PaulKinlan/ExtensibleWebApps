// Agent keys: a key lets an agent outside the browser (Claude Code, any MCP
// client) use the apps in one of your spaces, as you, through the space's MCP
// server (src/server/auth/agent-keys.ts, docs/guide/outside-agents.md). Make
// one per agent, name it after the agent, and revoke it when you stop using it.
//
// Each app that lets outside agents in has its own address in the space,
// /s/<space>/mcp/<plugin>, named after the plugin that opens its door (the
// reading list's is reading-list-agents). So the form asks which one, and the
// key is shown once, as it is made, with that address and what to paste
// into the agent. Shown only to someone signed in.

export const manifest = {
  id: "account-keys",
  name: "Agent keys",
  description: "Keys that let agents outside the browser use a space's apps as you.",
  version: "1.0.0",
  scope: "tab",
  permissions: ["ui", "account", "hook:listen:account:changed"],
  services: ["account"],
};

const when = (at) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const DOOR = /^[a-z0-9][a-z0-9-]{0,63}$/;

export default async function (ctx) {
  const views = ctx.ui.views("agent-keys.html");
  let status = "";
  /** The key just made, shown once: { value, address, command }. */
  let made = null;
  let revision = 0;

  const draw = async () => {
    const { user } = await ctx.call("account", "get", "/auth/me");
    if (!user) {
      made = null;
      return views.render("keys", "keys", { user: null });
    }
    const [{ keys = [] }, { spaces = [] }] = await Promise.all([ctx.call("account", "get", "/auth/keys").catch(() => ({})), ctx.call("account", "get", "/auth/spaces").catch(() => ({}))]);
    views.render("keys", "keys", {
      user: true,
      spaces: spaces.map(({ name }) => name),
      keys: keys.map((k) => ({ id: k.id, name: k.name, about: ` for ${k.space}${k.plugin ? ` (${k.plugin})` : ""}, made ${when(k.created)}${k.used ? `, last used ${when(k.used)}` : ", not used yet"} ` })),
      made,
      status,
      revision,
    });
  };

  ctx.on("account:changed", () => draw());
  ctx.ui.onEvent(async (action, value) => {
    status = "";
    try {
      if (action === "make") {
        const space = String(value?.space ?? "");
        const door = String(value?.door ?? "").trim();
        if (door && !DOOR.test(door)) throw new Error("The app's agent plugin is its id: lowercase letters, digits and dashes, like reading-list-agents");
        const { key, site } = await ctx.call("account", "post", "/auth/keys", { space, name: String(value?.name ?? "").trim() });
        const address = `${site}/s/${space}/mcp/${door || "<plugin>"}`;
        made = { value: key, address, command: `claude mcp add --transport http ${door || "<name>"} ${address} --header "Authorization: Bearer ${key}"`, door: !!door };
        revision++;
      } else if (action.startsWith("revoke:")) {
        await ctx.call("account", "post", "/auth/keys/revoke", { id: action.slice(7) });
        made = null;
      } else return;
    } catch (error) {
      status = error.message;
    }
    await draw();
  });
  await draw();
}
