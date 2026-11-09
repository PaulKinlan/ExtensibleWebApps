// Story view: a switch in the page's header between the two ways of reading
// this page. Guided (the default) puts the chapters beside the playground;
// Story is one scrolling column, like an article, with the playground
// docked to the side. The chapters don't know which one is showing: they
// draw the same views into the same slots either way.
//
// Like X-ray, it draws only its switch. The page's own CSS (in /index.html)
// lays the page out as a story while the switch says data-layout="story",
// with body:has(…), so the layout belongs to the page's author, and a
// plugin that only asks for ui can still offer it. The choice is kept, so
// the page opens the way the visitor left it; switched off, the page is
// guided again.

export const manifest = {
  id: "story-view",
  name: "Story view",
  description: "Switches the page between the guided view and one scrolling story.",
  version: "1.0.0",
  permissions: ["ui"],
  scope: "tab",
};

const LAYOUTS = ["guided", "story"];

export default async function (ctx) {
  const views = ctx.ui.views("story-view.html");
  let layout = (await ctx.storage.get("layout").catch(() => null)) ?? "guided";
  if (!LAYOUTS.includes(layout)) layout = "guided";
  const draw = () => views.render("page-tools", "switch", { layout, guided: String(layout === "guided"), story: String(layout === "story") }, { order: 2 });
  draw();
  ctx.ui.onEvent(async (action, value) => {
    if (action !== "layout" || !LAYOUTS.includes(String(value))) return;
    layout = String(value);
    draw();
    await ctx.storage.set("layout", layout);
  });
}
