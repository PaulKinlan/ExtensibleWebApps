// A model for a space. The owner of a space can give it one API key for a
// language model (Claude, Gemini or OpenAI). The space's server keeps the
// key encrypted and asks the model for the space's members, so they need no
// key of their own: they add "The space's model" in an app opened in the
// space (std/llm/space.js), and are shown whose key pays before they ask.
//
// The key is typed into a card the kernel draws and goes straight to the
// server (account.space-key), so this plugin never sees it, and the server
// never sends it back to any browser (src/server/space-model.ts). What this
// shows is whether a space has a key, who gave it, and what each member
// asked today, since the owner pays. Shown only to someone who owns a space.

export const manifest = {
  id: "account-space-model",
  name: "A model for a space",
  description: "Give a space of yours a model key that its server keeps, so its members can ask a model without a key of their own.",
  version: "1.0.0",
  scope: "tab",
  permissions: ["ui", "account", "hook:listen:account:changed"],
  services: ["account"],
};

export default async function (ctx) {
  const views = ctx.ui.views("space-model.html");
  let status = "";
  let failed = false;
  /** The space whose key "Take it away" is waiting for a second click on. */
  let confirming = "";
  /** Each vendor's name, by id, as the server last listed them. */
  const names = new Map();

  const draw = async () => {
    const { user } = await ctx.call("account", "get", "/auth/me");
    const { spaces = [] } = user ? await ctx.call("account", "get", "/auth/spaces") : {};
    const mine = spaces.filter((s) => s.role === "owner");
    if (!mine.length) return views.render("space-model", "space-model", { shown: false });
    const rows = await Promise.all(
      mine.map(async ({ name }) => {
        const has = await ctx.call("account", "get", `/auth/spaces/${name}/model`).catch((error) => ({ error: error.message }));
        for (const v of has.vendors ?? []) names.set(v.id, v.name);
        const used = (has.today ?? []).filter((m) => m.asked);
        return {
          name,
          error: has.error ?? "",
          set: !!has.set,
          none: !has.set && !has.error,
          model: has.model ?? "",
          since: has.at ? new Date(has.at).toLocaleDateString() : "",
          refused: !!has.refused,
          daily: has.daily ?? 0,
          vendors: has.vendors ?? [],
          used: used.map((m) => ({ name: m.name, text: `${m.asked} ${m.asked === 1 ? "question" : "questions"}, ${(m.input + m.output).toLocaleString()} tokens` })),
          unused: !!has.set && !used.length,
          confirming: confirming === name,
          canRemove: !!has.set && confirming !== name,
        };
      }),
    );
    views.render("space-model", "space-model", { shown: true, spaces: rows, status, failed, said: !failed && !!status });
  };

  const run = async (task) => {
    status = "";
    failed = false;
    confirming = "";
    try {
      status = (await task()) ?? "";
    } catch (error) {
      status = error.message;
      failed = true;
    }
    await draw();
  };

  ctx.on("account:changed", () => draw());
  ctx.ui.onEvent((action, value) => {
    const [verb, name] = action.split(":");
    if (verb === "give")
      return run(async () => {
        const vendor = String(value?.vendor ?? "");
        const label = names.get(vendor) ?? vendor;
        const given = await ctx.call("account", "space-key", name, vendor, label);
        // null means the person closed the card: nothing to say.
        return given ? `${name} has its ${given.model} key. Its members can now add "The space's model" in any app they open in ${name}.` : "";
      });
    if (verb === "remove") {
      confirming = name;
      status = "";
      return draw();
    }
    if (verb === "cancel") {
      confirming = "";
      return draw();
    }
    if (verb === "remove-yes")
      return run(async () => {
        await ctx.call("account", "post", `/auth/spaces/${name}/model/key`, { remove: true });
        return `${name} has no model key now. Its members are told to add a model of their own.`;
      });
  });
  await draw();
}
