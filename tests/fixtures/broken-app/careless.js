// Uses calls its manifest doesn't allow, and draws a view that doesn't exist.
export const manifest = {
  id: "careless",
  name: "Careless",
  permissions: [],
  collections: { jottings: { schema: { type: "object", properties: { text: { type: "string" } } } } },
};

export default async function (ctx) {
  const views = ctx.ui.views("careless.html");
  views.render("side", "nope", {});
  await ctx.call("data", "put", "jottings", { text: "mine" });
  await ctx.call("data", "list", "library");
  await ctx.call("data", "frobnicate");
  ctx.routes.add("GET", "x.json", () => ({ json: 1 }));
  await fetch("https://example.com/");
  ctx.on("debug:trace", () => {});
  ctx.ui.views("gone.html");
}
