// Packing list: a plugin that owns its own data, added to a page that knew
// nothing about it. It puts a bound form and table at the start of the
// page's <footer>; the kernel checks every item against the schema, as in
// any app.

export const manifest = {
  id: "packing",
  name: "Packing list",
  description: "What to pack, at the bottom of the page.",
  version: "1.0.0",
  permissions: ["ui"],
  places: {
    list: { at: "footer", put: "prepend" },
  },
  collections: {
    packing: {
      title: "Things to pack",
      schema: {
        type: "object",
        required: ["item"],
        properties: {
          item: { type: "string", title: "Item", maxLength: 80 },
          packed: { type: "boolean", title: "Packed" },
        },
      },
    },
  },
  files: ["packing.html"],
};

export default function (ctx) {
  ctx.ui.views("packing.html").render("list", "packing");
}
