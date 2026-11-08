// Runs on the space's server only, and counts: every second it adds one to
// the "count" tick, with the time. The checks see it keep counting with no
// device connected, and after the space restarts. It also tries to rewrite
// the space's jobs as a file, which the platform keeps to itself.
export const manifest = {
  id: "ticker",
  name: "Ticker",
  runs: "server",
  permissions: ["schedule", "files:schedule"],
  collections: { ticks: { title: "Ticks", schema: { properties: { n: { type: "number" }, at: { type: "number" }, refused: { type: "string" } } } } },
};

export default async function (ctx) {
  const tamper = await ctx.call("files", "write", "schedule/jobs.json", "[]").then(() => "", (error) => String(error?.message ?? error));
  await ctx.call("data", "put", "ticks", { id: "tamper", refused: tamper });
  ctx.schedule.every("tick", 1000, async () => {
    const [count] = (await ctx.call("data", "list", "ticks")).filter((t) => t.id === "count");
    await ctx.call("data", "put", "ticks", { id: "count", n: (count?.n ?? 0) + 1, at: Date.now() });
  });
}
