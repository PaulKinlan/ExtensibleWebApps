// Assistant alerts: tells you when the writer agent has finished, in the
// panels, so you can carry on writing while it works. The toolbar button
// turns the alerts off and on.

export const manifest = {
  id: "alerts",
  name: "Assistant alerts",
  description: "Tells you when an agent finishes a reply or stops with an error.",
  version: "2.0.0",
  order: 170,
  permissions: ["ui", "hook:listen:agent:done"],
};

export default async function (ctx) {
  let on = (await ctx.storage.get("on")) ?? true;
  let shown = 0;
  const button = () => ctx.ui.render("toolbar", "toggle", { type: "button", label: on ? "Alerts on" : "Alerts off", action: "toggle" });

  ctx.ui.onEvent(async (action) => {
    if (action !== "toggle") return;
    on = !on;
    await ctx.storage.set("on", on);
    button();
  });
  ctx.on("agent:done", (run) => {
    if (!on) return;
    const failed = run?.stopReason && run.stopReason !== "completed";
    const id = `alert-${++shown}`;
    ctx.ui.render("notices", id, { type: "text", text: failed ? `${run.agent} stopped (${run.stopReason})` : `${run?.agent ?? "The assistant"} is done`, tone: failed ? "error" : "ok" });
    setTimeout(() => ctx.ui.render("notices", id, null), 8000);
  });
  button();
}
