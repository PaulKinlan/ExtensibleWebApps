// The library: the plugin that owns the books. Its manifest declares a
// collection with a schema, and its view is one string of HTML: <ui-form>
// builds its fields, labels and errors from the schema, <ui-table> lists the
// records and stays up to date, and the kernel checks every write against the
// schema. The plugin only handles what is specific to it: which book is open.

export const manifest = {
  id: "library",
  name: "Library",
  description: "The books, with a form to add or edit one and a table of them all.",
  version: "1.0.0",
  permissions: ["ui"],
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
  const html = ctx.ui.html;
  // The plugin owns `library`, so it reads and writes it without asking. The
  // samples go in once; a flag in the plugin's own storage keeps deleted books deleted.
  if (!(await ctx.storage.get("seeded"))) {
    for (const book of SAMPLE) await ctx.call("data", "put", "library", book);
    await ctx.storage.set("seeded", true);
  }

  let open = null; // the id of the book being edited, if any

  const draw = () =>
    ctx.ui.render(
      "main",
      "library",
      html`
        <ui-toolbar><h2>Books</h2><ui-spacer></ui-spacer>${open ? html`<button data-action="close">Add a book instead</button>` : ""}</ui-toolbar>
        <ui-card>
          <h3>${open ? "Edit book" : "Add a book"}</h3>
          ${open
            ? html`<ui-form collection="library" record="${open}" submit="Save changes" action="saved"></ui-form>`
            : html`<ui-form collection="library" fields="title,author,year,shelf,due" submit="Add book"></ui-form>`}
        </ui-card>
        <ui-table collection="library" columns="title,author,year,shelf,due" sort="title" row-action="open" deletable empty="No books yet."></ui-table>`,
    );

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
  draw();
}
