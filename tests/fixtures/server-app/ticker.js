// Runs on the space's server only, and counts: every second it adds one to
// the "count" tick, with the time. The checks see it keep counting with no
// device connected, and after the space restarts.
export const manifest = {
  id: "ticker",
  name: "Ticker",
  runs: "server",
  permissions: ["schedule"],
  collections: { ticks: { title: "Ticks", schema: { properties: { n: { type: "number" }, at: { type: "number" } } } } },
};

export default function (ctx) {
  ctx.schedule.every("tick", 1000, async () => {
    const [count] = (await ctx.call("data", "list", "ticks")).filter((t) => t.id === "count");
    await ctx.call("data", "put", "ticks", { id: "count", n: (count?.n ?? 0) + 1, at: Date.now() });
  });
}
