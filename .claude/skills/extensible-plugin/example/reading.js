// Reading: the books a person means to read. It owns the `reading-books`
// collection, draws it as a live view from reading.html, ticks a book off or
// removes it when the person says so, and adds one command.

export const manifest = {
  id: "reading",
  name: "Reading",
  description: "Books to read, ticked off as you finish them.",
  version: "1.0.0",
  permissions: ["ui"],
  collections: {
    // Collections belong to the whole site, so the name starts with the app's.
    "reading-books": {
      title: "Books",
      schema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", title: "Title", maxLength: 120 },
          author: { type: "string", title: "Author", maxLength: 80 },
          done: { type: "boolean", title: "Finished" },
        },
      },
    },
  },
};

export default async function (ctx) {
  const views = ctx.ui.views("reading.html");

  // A live view: the function reads through the ctx it is given, so the view
  // is drawn again whenever `reading-books` changes, in this tab or another.
  views.live("main", "books", async (ctx) => {
    const books = await ctx.call("data", "list", "reading-books");
    books.sort((a, b) => Number(a.done ?? false) - Number(b.done ?? false) || a.title.localeCompare(b.title));
    // Work values out here: a template has no expressions.
    return { books: books.map((b) => ({ id: b.id, title: b.title, by: b.author ? `by ${b.author}` : "", done: b.done === true })) };
  });

  // "done:<id>" comes from a book's checkbox, with true or false; "remove:<id>" from its button.
  ctx.ui.onEvent(async (action, value) => {
    const [verb, id] = action.split(":");
    if (verb === "done") {
      const book = await ctx.call("data", "get", "reading-books", id);
      // put replaces the whole record, so the old one is spread in.
      if (book) await ctx.call("data", "put", "reading-books", { ...book, done: value === true });
    }
    if (verb === "remove") await ctx.call("data", "delete", "reading-books", id);
  });

  // A command: the palette lists it, and an agent can run it as a tool.
  ctx.commands.add({ id: "clear-finished", title: "Remove the books I've finished", group: "Reading" }, async () => {
    const finished = (await ctx.call("data", "list", "reading-books")).filter((b) => b.done);
    for (const book of finished) await ctx.call("data", "delete", "reading-books", book.id);
    return finished.length ? `Removed ${finished.length}` : "Nothing finished yet";
  });
}
