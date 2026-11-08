// Linked only in a comment in app.html, so it must never start: if it did,
// it would write a memo called "ghost" that the checks look for.
export const manifest = { id: "ghost", name: "Ghost", runs: "server", permissions: [], collections: { ghosts: { title: "Ghosts", schema: { properties: {} } } } };

export default async function (ctx) {
  await ctx.call("data", "put", "ghosts", { id: "ghost" });
}
