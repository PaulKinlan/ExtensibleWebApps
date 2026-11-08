// The library: the plugin that owns the books. Its manifest declares a
// collection with a schema, and its view is a template in library.html:
// <ui-form> builds its fields, labels and errors from the schema, <ui-table>
// lists the records and stays up to date, and the kernel checks every write
// against the schema. The plugin only handles what is specific to it: which
// book is open.
//
// It also answers two addresses next to it, through the platform's service
// worker: books.json is the whole list, for anything that wants it as data,
// and a form posted to add-book adds a book, as plain HTML would.
//
// And it names three things it does as commands. The command palette lists
// the first two, with their keys; the third takes a title, so it is for
// whatever can fill one in, such as an agent with the `commands` permission.

export const manifest = {
  id: "library",
  name: "Library",
  description: "The books, with a form to add or edit one and a table of them all.",
  version: "1.0.0",
  permissions: ["ui", "routes"],
  order: 10,
  collections: {
    library: {
      title: "Books",
      schema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", title: "Title" },
          author: { type: "string" },
          year: { type: "integer", minimum: 1450 },
          shelf: { type: "string", enum: ["to read", "reading", "done"], default: "to read" },
          due: { type: "string", format: "date", title: "Due back" },
          notes: { type: "string", "x-multiline": true },
        },
      },
    },
  },
};

const SAMPLE = [
  { title: "Dune", author: "Frank Herbert", year: 1965, shelf: "reading" },
  { title: "The Left Hand of Darkness", author: "Ursula K. Le Guin", year: 1969, shelf: "to read", due: "2026-11-21" },
  { title: "Piranesi", author: "Susanna Clarke", year: 2020, shelf: "done" },
];

export default async function (ctx) {
  // The templates in library.html, next to this file.
  const views = ctx.ui.views("library.html");
  // The plugin owns `library`, so it reads and writes it without asking. The
  // samples go in once; a flag in the plugin's own storage keeps deleted books deleted.
  if (!(await ctx.storage.get("seeded"))) {
    for (const book of SAMPLE) await ctx.call("data", "put", "library", book);
    await ctx.storage.set("seeded", true);
  }

  let open = null; // the id of the book being edited, if any

  // Draws <template id="books"> in the main slot, filled with the plugin's state.
  const draw = () => views.render("main", "books", { open });

  // Clicks in the view come back as actions; <ui-table>'s row-action sends the record id.
  ctx.ui.onEvent((action, value) => {
    if (action === "open") open = value;
    if (action === "close" || action === "saved") open = null;
    draw();
  });
  // If the open book is deleted (from the table, or by another plugin), go back to adding.
  ctx.on("data:changed:library", (change) => {
    if (change.id === open && !change.after) {
      open = null;
      draw();
    }
  });
  // /demos/reading-list/books.json: the books, as JSON.
  ctx.routes.add("GET", "books.json", async () => ({ json: await ctx.call("data", "list", "library") }));
  // <form method="post" action="add-book"><input name="title">…</form> adds a book, then goes back to the app.
  ctx.routes.add("POST", "add-book", async ({ form }) => {
    const result = await ctx.call("data", "put", "library", { title: String(form?.title ?? ""), ...(form?.author && { author: String(form.author) }) });
    return result.ok ? { redirect: "./" } : { status: 400, text: JSON.stringify(result.errors ?? result.error) };
  });

  // Commands: what the library can do, for the palette, a shortcut or an agent.
  const shelf = async (from) => (await ctx.call("data", "list", "library")).filter((b) => (b.shelf ?? "to read") === from);
  const move = async (book, to) => {
    // A write can be refused (a plugin intercepting it, or the book changing meanwhile): fail the command, don't claim it moved.
    const result = await ctx.call("data", "put", "library", { ...book, shelf: to });
    if (!result.ok) throw new Error(`Couldn't move ${book.title}: ${result.error ?? JSON.stringify(result.errors)}`);
  };
  ctx.commands.add({ id: "start-next", title: "Start the next book", group: "Books", description: "Moves the book due back soonest from “to read” to “reading”.", keys: ["Alt+N"] }, async () => {
    const [next] = (await shelf("to read")).sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.title.localeCompare(b.title));
    if (!next) return "Nothing left to read";
    await move(next, "reading");
    return `Started ${next.title}`;
  });
  ctx.commands.add({ id: "finish", title: "Mark what I'm reading as done", group: "Books", keys: ["Alt+D"] }, async () => {
    const reading = await shelf("reading");
    for (const book of reading) await move(book, "done");
    return reading.length ? `Finished ${reading.map((b) => b.title).join(", ")}` : "You aren't reading anything";
  });
  ctx.commands.add(
    { id: "add", title: "Add a book", group: "Books", args: { type: "object", required: ["title"], properties: { title: { type: "string" }, author: { type: "string" } } } },
    async ({ title, author }) => {
      const result = await ctx.call("data", "put", "library", { title, ...(author && { author }) });
      if (!result.ok) throw new Error(JSON.stringify(result.errors ?? result.error));
      return result.id;
    },
  );
  draw();
}
