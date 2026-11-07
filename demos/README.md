# Demos

Each folder here is an app. An app is an `app.html` page plus its plugins, one file each. The files are written to be read: each starts with a comment saying what it shows. Nothing is built; the browser runs them as they are.

| App | Plugins | Open it |
| --- | --- | --- |
| [`reading-list/`](reading-list/) | `library.js` owns the books; `due-soon.js` reads them; `book-import.js` adds to them, with review | [hosted](https://extensible-web-apps.paulkinlan.workers.dev/demos/reading-list/app.html) |
| [`spending/`](spending/) | `expenses.js` owns the expenses; `budget.js` and `categories.js` read them | [hosted](https://extensible-web-apps.paulkinlan.workers.dev/demos/spending/app.html) |

Locally, run `npm run dev` and open `http://localhost:5173/demos/reading-list/app.html`.

## An app is an HTML page

```html
<!doctype html>
<html lang="en">
<head>
  <title>Reading list</title>
  <link rel="stylesheet" href="/platform/host.css">   <!-- the platform: the same two lines in every app -->
  <script type="module" src="/platform/host.js"></script>
  <link rel="plugin" href="library.js">               <!-- the app's plugins, one file each -->
  <link rel="plugin" href="due-soon.js">
</head>
<body>
  <header><h1>Reading list</h1></header>
  <main><slot name="main"><p>Loading your books…</p></slot></main>  <!-- plugins draw in named slots -->
  <aside><slot name="side"></slot></aside>
</body>
</html>
```

- **`link rel="plugin"`** names a plugin. The host fetches it, the kernel reads its manifest and runs it in its own worker for as long as a tab has the app open.
- **`slot name`** is where plugins draw. What's inside a slot shows until a plugin draws there. The page's layout is yours: plain HTML and CSS.
- The page shows only its own plugins' views. Review cards, where the person allows or declines a change, always show.

## A plugin is one file

```js
// 1. A manifest, which must be the first statement. The kernel reads it as
//    data before any code runs: who you are, what you may do, what you keep.
export const manifest = {
  id: "library",
  name: "Library",
  permissions: ["ui"],                   // capabilities; everything else is refused
  collections: { library: { schema } },  // typed records this plugin owns
};

// 2. A function that gets a `ctx`. It runs in its own worker; every call on
//    ctx is a message the kernel checks against the manifest.
export default async function (ctx) {
  const html = ctx.ui.html; // a tagged template that escapes every value

  ctx.ui.render("main", "library", html`
    <h2>Books</h2>
    <ui-form collection="library"></ui-form>
    <ui-table collection="library" row-action="open"></ui-table>`);

  ctx.ui.onEvent((action, value) => { /* data-action clicks and form submits */ });
  ctx.on("data:changed:library", () => { /* any write to the collection */ });
  await ctx.call("data", "put", "library", { title: "Dune" }); // services
}
```

## How plugins plug together

The plugins in an app never call each other. They meet in shared data:

- **One plugin owns a collection.** `library.js` declares `library` in its manifest; the kernel checks every write against its schema.
- **Others ask to read it.** `due-soon.js` lists `data:read:library` in its permissions, to list the books, and `hook:listen:data:changed:library`, to hear whenever any plugin changes one.
- **Writing someone else's data is reviewed.** `book-import.js` has `data:write:library`, but the library isn't its own, so the person sees each change as a card with Accept and Decline before anything is written.

A few more ideas carry the rest:

- **Views are plain HTML.** The host keeps only safe elements and attributes (the list is in [`src/shared/html.ts`](../src/shared/html.ts)), styles them to the app's design tokens, and updates the page in place when you render again, so you redraw whenever your state changes and focus and typing survive. `data-action` on a button or form is how the person's actions come back to you.
- **The `ui-*` elements** are in [`../elements/`](../elements/), one file each. `<ui-form>` and `<ui-table>` read a collection's schema and draw themselves, with the rights of the plugin whose view they sit in.
- **Settings** in a manifest become a form in the plugins panel; `budget.js` reads its budget with `ctx.settings.get()`.

The full API, generated from the running kernel, is in [docs/api.md](../docs/api.md).

## Which to read first

1. **`reading-list/app.html`**, then **`library.js`**: almost no code. A schema in the manifest, and two bound elements in one line of HTML.
2. **`due-soon.js`** and **`book-import.js`**: two more plugins that use the library without owning it, one reading and one writing with review.
3. **`spending/expenses.js`**: the same data model with a view written by hand, a table and a form that saves through the `data` service.
4. **`spending/budget.js`**: a setting, and a dashboard computed from another plugin's data.
5. **`../plugins/tone.js`** and **`../plugins/bars.js`**: audio in an AudioWorklet and drawing on an OffscreenCanvas, without plugin code on the main thread.

The files in `plugins/` are the platform's own test plugins and run on the workbench (`/`), not in apps.
