// Runs on the space's server only: it owns the memos, refuses one that says
// "forbidden" (saying whose it was), and writes a memo saying what its sandbox lets it reach, which
// every device hears.
export const manifest = {
  id: "guard",
  name: "Guard",
  runs: "server",
  permissions: ["hook:intercept:data:beforeWrite:memos"],
  collections: { memos: { title: "Memos", schema: { properties: { title: { type: "string" } }, required: ["title"] } } },
};

export default async function (ctx) {
  const reach = {};
  for (const name of ["node:fs", "node:child_process", "node:net"]) reach[name] = await import(name).then(() => "imported", () => "refused");
  reach.process = typeof process;
  reach.fetch = typeof fetch;
  ctx.on("data:beforeWrite:memos", (change) => (change.after && /forbidden/i.test(change.after.title ?? "") ? { block: `Guard: that word isn't allowed (from ${change.by})` } : undefined));
  await ctx.call("data", "put", "memos", { id: "reach", title: JSON.stringify(reach) });
}
