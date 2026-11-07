# Demos

Each file here is a complete plugin: an app you can install into the platform. They are written to be read, so each one starts with a comment saying what it shows. Try them on the hosted site with the **Demo** menu at the top right of the page, or with a link:

- [Reading list](https://extensible-web-apps.paulkinlan.workers.dev/?demo=reading-list) (`reading-list.js`)
- [Spending](https://extensible-web-apps.paulkinlan.workers.dev/?demo=spending) (`spending.js`)

Locally, run `npm run dev` and open `http://localhost:5173/?demo=reading-list`.

## The programming model in one plugin

A plugin is one ES module with two exports.

```js
// 1. A manifest, which must be the first statement. The kernel reads it as
//    data before any code runs: who you are, what you may do, what you keep.
export const manifest = {
  id: "reading-list",
  name: "Reading list",
  permissions: ["ui"],                 // capabilities; everything else is refused
  collections: { library: { schema } },  // typed records this plugin owns
  settings: { budget: { type: "number", default: 2000 } }, // a form the platform draws
};

// 2. A function that gets a `ctx`. It runs in its own worker; every call on
//    ctx is a message the kernel checks against the manifest.
export default async function (ctx) {
  const html = ctx.ui.html; // a tagged template that escapes every value

  ctx.ui.render("app.main", "reading-list", html`
    <h2>Reading list</h2>
    <ui-form collection="library"></ui-form>
    <ui-table collection="library" row-action="open"></ui-table>`);

  ctx.ui.onEvent((action, value) => { /* data-action clicks and form submits */ });
  ctx.on("data:changed:library", () => { /* any write to the collection */ });
  await ctx.call("data", "put", "library", { title: "Dune" }); // services
}
```

A few ideas carry the rest:

- **Views are plain HTML.** The host keeps only safe elements and attributes (the list is in [`src/shared/html.ts`](../src/shared/html.ts)), styles them to the app's design tokens, and updates the page in place when you render again, so you redraw whenever your state changes and focus and typing survive. `data-action` on a button or form is how the person's actions come back to you.
- **Data has a schema.** A collection declared in the manifest is checked by the kernel on every write. `<ui-form>` and `<ui-table>` read the schema and draw themselves, with the rights of the plugin whose view they sit in.
- **Everything goes through the gate.** A plugin can only do what its manifest asks for. Writing to something another plugin owns shows the person a diff first.

The full API, generated from the running kernel, is in [docs/api.md](../docs/api.md).

## Which to read first

1. **`reading-list.js`**: almost no code. A schema in the manifest, and two bound components in one line of HTML. The only logic is which book is open.
2. **`spending.js`**: the same data model, with a view written by hand: stats computed from the records, a table, and a form that saves through the `data` service. It also has a setting (the monthly budget) that the plugins panel draws a field for.
3. **`../plugins/tidy.js`**: a plugin that works on *another* app's data (the notes), so its writes go through change review.
4. **`../plugins/tone.js`** and **`../plugins/bars.js`**: audio in an AudioWorklet and drawing on an OffscreenCanvas, without plugin code on the main thread.

The other files in `plugins/` are the platform's own test plugins: `sneaky.js` asks for more than it may have, `fetcher.js` and `offline.js` check the network rules, and `pinger.js` is for the benchmark.
