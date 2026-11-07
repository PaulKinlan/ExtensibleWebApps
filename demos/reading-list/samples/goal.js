// Reading goal: a person's own plugin for the reading list. The app has
// slots, but none for this, so it names a place: the start of <main>. It
// reads the library, which another plugin owns, so it asks for
// data:read:library, and its view is live: it redraws whenever a book
// changes shelf.

export const manifest = {
  id: "goal",
  name: "Reading goal",
  description: "How far you are towards reading 12 books this year.",
  version: "1.0.0",
  permissions: ["ui", "data:read:library"],
  places: {
    goal: { at: "main", put: "prepend" },
  },
  settings: {
    target: { type: "number", title: "Books this year", default: 12 },
  },
};

export default function (ctx) {
  ctx.ui.live("goal", "progress", async (ctx) => {
    const books = await ctx.call("data", "list", "library");
    const { target = 12 } = await ctx.settings.get();
    const done = books.filter((b) => b.shelf === "done").length;
    return ctx.ui.html`<p class="goal"><strong>${done} of ${target}</strong> books read this year <meter min="0" max="${target}" value="${done}"></meter></p>`;
  });
}
