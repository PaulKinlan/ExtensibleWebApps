// Reading count: how many books are finished, at the top of the page. It
// shows the shape of a plugin written for an app that left no slot for it,
// such as one a person adds to an app from Customize: it names a place in
// the page, and asks to read a collection another plugin owns.

export const manifest = {
  id: "reading-count",
  name: "Reading count",
  description: "Shows how many books you have finished.",
  version: "1.0.0",
  // Only what it uses: it draws, and reads (never writes) the books.
  permissions: ["ui", "data:read:reading-books"],
  // A CSS selector in the app's own page, and where to put the view.
  places: { count: { at: "main", put: "prepend" } },
};

export default async function (ctx) {
  // HTML built in code: ctx.ui.html escapes every value. Followed like any live view.
  ctx.ui.live("count", "count", async (ctx) => {
    const books = await ctx.call("data", "list", "reading-books");
    const done = books.filter((b) => b.done).length;
    return ctx.ui.html`<ui-stat label="Finished" value="${done} of ${books.length}"></ui-stat>`;
  });
}
