# Demos

Each folder here is an app. An app is an `app.html` page plus its plugins: one `.js` file each, and usually a `.html` file of view templates next to it. The files are written to be read: each starts with a comment saying what it shows. Nothing is built; the browser runs them as they are.

| App | Plugins | Open it |
| --- | --- | --- |
| [`reading-list/`](reading-list/) | `library` owns the books; `due-soon` reads them; `book-import` adds to them, with review | [hosted](https://extensible-web-apps.kinlan-test.workers.dev/demos/reading-list/app.html) |
| [`board/`](board/) | `board` owns the cards and leaves a room on each; `due` and `checklist` fill it, `wip` transforms the column headers, `pulse` reads the cards. A showcase of how far the UI goes | [hosted](https://extensible-web-apps.kinlan-test.workers.dev/demos/board/app.html) |
| [`survey/`](survey/) | `surveys` builds the surveys and shows the answers; `collect` runs on the space's server only, serving each survey as a public form, keeping the answers and emailing a daily digest. Open it in a space to collect answers | [hosted](https://extensible-web-apps.kinlan-test.workers.dev/demos/survey/app.html) |
| [`spending/`](spending/) | `expenses` owns the expenses; `budget` and `categories` read them | [hosted](https://extensible-web-apps.kinlan-test.workers.dev/demos/spending/app.html) |
| [`recipes/`](recipes/) | `cookbook` owns the recipes and scales the open one; `shopping` owns a list it fills from them; `quick` reads them, drawn in code | [hosted](https://extensible-web-apps.kinlan-test.workers.dev/demos/recipes/app.html) |
| [`contacts/`](contacts/) | `people` owns the contacts, with a live search; `birthdays` reads them; `vcard-import` adds to them, with review | [hosted](https://extensible-web-apps.kinlan-test.workers.dev/demos/contacts/app.html) |
| [`habits/`](habits/) | `habits` owns the habits and draws them live; the app the [developer guide](../docs/guide/writing-a-plugin.md) builds | [hosted](https://extensible-web-apps.kinlan-test.workers.dev/demos/habits/app.html) |
| [`trip/`](trip/) | No slots and no plugins: a plain itinerary. Customize adds `countdown` after the heading (with an image) and `packing`, a list it owns, to the footer | [hosted](https://extensible-web-apps.kinlan-test.workers.dev/demos/trip/app.html) |
| [`menu/`](menu/) | No slots: a café menu. Customize adds `currency`, which replaces every price, and `quiet`, which hides the newsletter box | [hosted](https://extensible-web-apps.kinlan-test.workers.dev/demos/menu/app.html) |
| [`invoice/`](invoice/) | No slots, with parts marked `review` and `locked`: `memo` is drawn, `tip` asks first, `pay-later` is refused until the person unlocks it | [hosted](https://extensible-web-apps.kinlan-test.workers.dev/demos/invoice/app.html) |
| [`librarian/`](librarian/) | The reading list's `library`, with two agents: `librarian.agent.md` fills in each new book's author and year, through review, and asks `bibliographer.agent.md` when it isn't sure, which asks you on the board; `activity` lists what they did | [hosted](https://extensible-web-apps.kinlan-test.workers.dev/demos/librarian/app.html) |
| [`security/`](security/) | The librarian's agents, with `security.agent.md`, which is asked before a book is saved and before another agent calls a tool: it blocks a book holding what looks like a card number, and a delete; the board shows what waits while it checks | [hosted](https://extensible-web-apps.kinlan-test.workers.dev/demos/security/app.html) |
| [`assistant/`](assistant/) | The reading list's `library`, with the standard agents from [`std/agents/`](../std/agents/): the assistant does what you ask with the library's commands, and the builder writes a plugin from what you describe, acting for you once you let it, after a review card; `chat` is where you write to them | [hosted](https://extensible-web-apps.kinlan-test.workers.dev/demos/assistant/app.html) |
| [`calendar/`](calendar/) | `events` owns the events; `month` draws a month grid from nested template loops; `agenda` reads the events and the contacts app's birthdays | [hosted](https://extensible-web-apps.kinlan-test.workers.dev/demos/calendar/app.html) |

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
- **No slot? A place.** A plugin can name a CSS selector in the page and put its view before, after, inside or instead of what matches, or hide it. That is how a person's own plugins, added with **Customize**, reach an app that never planned for them. The trip, menu and invoice apps have no slots at all. See [places](../docs/guide/places.md).
- The page shows only its own plugins' views. Review cards, where the person allows or declines a change, always show.

## A plugin is a script and its templates

A plugin's views are HTML templates in a file next to it. The plugin sends data; the host fills the template:

```html
<!-- library.html -->
<template id="books">
  <h2>Books</h2>
  <template if="open">
    <ui-form collection="library" record="{{open}}" submit="Save changes"></ui-form>
  </template>
  <ul>
    <template for="book of books"><li>{{book.title}}</li></template>
  </ul>
</template>
```

`{{path}}` holes go in text and attribute values and are filled as text, never as HTML. An attribute that is one whole hole comes and goes with its value: `checked="{{done}}"` is there when `done` is true and left out when it is false or missing. `<template for="x of path">` repeats and `<template if="path">` keeps or drops its content; a path is names joined by dots, optionally starting with `!`. There are no other expressions, so the logic stays in the script. The filled HTML is checked like any other view.

A template file can bring its own `<style>`, as [`calendar/month.html`](calendar/month.html) does. The host scopes it to that plugin's views, so `.month td` can't reach another plugin's table, and puts it under the page's own styles, so the app can still restyle any plugin.

The script is one ES module with two exports:

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
  const views = ctx.ui.views("library.html");  // the templates next to this file
  views.render("main", "books", { open: null }); // slot, template id, data

  // Or build HTML in code, for views computed from data (categories.js does this):
  // ctx.ui.render("side", "chart", ctx.ui.html`<meter value="${n}"></meter>`);

  // Or draw it live: the function runs again whenever what it read changes.
  // views.live("side", "list", async (ctx) => ({ books: await ctx.call("data", "list", "library") }));

  ctx.ui.onEvent((action, value) => { /* data-action clicks and form submits */ });
  ctx.on("data:changed:library", () => { /* any write to the collection */ });
  await ctx.call("data", "put", "library", { title: "Dune" }); // services
}
```

## How plugins plug together

The plugins in an app never call each other. They meet in shared data:

- **One plugin owns a collection.** `library.js` declares `library` in its manifest; the kernel checks every write against its schema.
- **Others ask to read it.** `due-soon.js` lists `data:read:library` in its permissions, which lets it list the books and hear whenever any plugin changes one. It draws with `views.live`, so its list follows the library on its own.
- **Writing someone else's data is reviewed.** `book-import.js` has `data:write:library`, but the library isn't its own, so the person sees each change as a card with Accept and Decline before anything is written.

A few more ideas carry the rest:

- **Views are plain HTML.** The host keeps only safe elements and attributes (the list is in [`src/shared/html.ts`](../src/shared/html.ts)), styles them to the app's design tokens, and updates the page in place when you render again, so you redraw whenever your state changes and focus and typing survive. `data-action` on a button or form is how the person's actions come back to you.
- **The `ui-*` elements** are in [`../elements/`](../elements/), one file each. `<ui-form>` and `<ui-table>` read a collection's schema and draw themselves, with the rights of the plugin whose view they sit in.
- **Settings** in a manifest become a form in the plugins panel; `budget.js` reads its budget with `ctx.settings.get()`.

The full API, generated from the running kernel, is in [docs/api.md](../docs/api.md).

## Which to read first

1. **`reading-list/app.html`**, then **`library.js`** and **`library.html`**: almost no code. A schema in the manifest, and a template with two bound elements.
2. **`due-soon.js`** and **`book-import.js`**: two more plugins that use the library without owning it, one reading and one writing with review.
3. **`spending/expenses.js`** and **`expenses.html`**: the same data model with a view written by hand, a table and a form that saves through the `data` service.
4. **`spending/budget.js`**: a setting, and a dashboard computed from another plugin's data.
5. **`spending/categories.js`**: a view built in code with `ctx.ui.html` instead of a template.
6. **`../plugins/tone.js`** and **`../plugins/bars.js`**: audio in an AudioWorklet and drawing on an OffscreenCanvas, without plugin code on the main thread.

The files in `plugins/` are the platform's own test plugins and run on the workbench (`/`), not in apps.
