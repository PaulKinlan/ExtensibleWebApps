// Runs on the space's server only, and tells the space's members things with
// every tab closed (tests/server/push.mjs): POST nudge shows a notification
// to every member, or to the one named; POST later sets a job that shows one
// in a second, as a reminder would.
export const manifest = {
  id: "nudger",
  name: "Nudger",
  runs: "server",
  permissions: ["notify", "schedule", "routes"],
};

export default function (ctx) {
  ctx.routes.add("POST", "nudge", async ({ form }) => {
    const note = { title: String(form?.title ?? "A nudge"), body: "From the space's server", tag: "nudge", ...(form?.to ? { to: [String(form.to)] } : {}) };
    try {
      return { json: { state: await ctx.call("notify", "state"), shown: await ctx.call("notify", "show", note) } };
    } catch (error) {
      return { status: 500, json: { error: String(error?.message ?? error) } };
    }
  });
  ctx.routes.add("POST", "later", async () => {
    await ctx.schedule.at("reminder", Date.now() + 1000, () => ctx.call("notify", "show", { title: "The bins go out tonight", body: "Set a second ago", tag: "reminder" }));
    return { json: { set: true } };
  });
}
