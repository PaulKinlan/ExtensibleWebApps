// Book page: a screen for one book, with an address of its own. The router
// service turns the address's hash into a screen: this app at
// #/book/<id> shows that book here, so a person can bookmark it or send the
// link, and back goes to where they were. Links to it are plain
// <a href="#/book/<id>">, as in due-soon.html.
//
// A screen belongs to one tab, so this plugin is `scope: "tab"`: each tab's
// copy draws what its own tab's address says.

export const manifest = {
  id: "book-page",
  name: "Book page",
  description: "Shows one book on its own screen, at #/book/<id>, so a book can be linked to.",
  version: "1.0.0",
  permissions: ["ui", "router", "data:read:library"],
  scope: "tab",
  order: 5,
};

export default async function (ctx) {
  const views = ctx.ui.views("book-page.html");

  // Draws the book the address names, or nothing on any other screen. ui.live draws it again
  // when the library changes; the router:changed listener below, when the address does.
  const page = views.live("main", "book", async (ctx) => {
    const { path } = await ctx.call("router", "current");
    const [, screen, id] = path.split("/");
    if (screen !== "book" || !id) return { book: null, shown: false };
    const book = await ctx.call("data", "get", "library", decodeURIComponent(id));
    return { book, shown: true, missing: !book };
  });
  ctx.on("router:changed", () => page.refresh());
}
