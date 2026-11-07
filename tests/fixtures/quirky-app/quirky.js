// Comment markers and calls inside strings aren't code; a view file can come from the site's root.
export const manifest = {
  id: "quirky",
  name: "Quirky",
  description: "Never calls fetch() or ctx.routes.add(); this is a description.",
  permissions: ["ui"],
  collections: { "quirky-notes": { schema: { type: "object", properties: { text: { type: "string" } } } } },
};

export default async function (ctx) {
  const marker = "//";
  const notes = await ctx.call("data", "list", "quirky-notes");
  const views = ctx.ui.views("/tests/fixtures/quirky-app/quirky.html");
  views.render("main", "notes", { marker, notes, hint: 'ctx.call("data", "list", "library")' });
}
