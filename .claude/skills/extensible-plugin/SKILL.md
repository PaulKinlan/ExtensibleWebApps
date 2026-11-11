---
name: extensible-plugin
description: Write or change a plugin (or a small app of plugins) for an Extensible Web Apps project, the platform at extensibleweb.app. Use when the project has an app.html with <link rel="plugin"> lines, depends on the extensible-web-apps package, or is the ExtensibleWebApps repo itself; or when someone asks for a plugin to add to such an app from its Customize button. Covers the manifest and its permissions, HTML template views with ui-* elements and design tokens, collections, places, commands, and checking the result.
---

# Writing a plugin for Extensible Web Apps

A plugin is plain files that the browser runs as written: one JavaScript module, and usually one HTML file of templates beside it. There is no build step, no framework and no npm dependency in a plugin. The kernel reads the plugin's manifest before it runs any of its code, runs the code in a worker of its own, and refuses everything the manifest didn't ask for.

The person asking may not write code. Ask them what the plugin should do in their own words, never which permission or slot they want: working that out is this skill's job. Tell them at the end what it does, what it is allowed to do, and how to see it.

## 1. Find the platform

The guide, the API reference and the checker come with the platform, so they always match the version in use. Find `PLATFORM`, the folder that holds them:

| The project | `PLATFORM` | The app's files | Check with |
| --- | --- | --- | --- |
| Has `node_modules/extensible-web-apps/` (made by `npm create extensible-app`) | `node_modules/extensible-web-apps` | The top of the project: `app.html`, plugins beside it or in a folder such as `plugins/` | `npm run check` |
| Is the platform's own repo (has `std/maker/checks.js` and `demos/`) | `.` | `demos/<app>/` | `npm run check demos/<app>` |
| Neither: the person wants a plugin to paste into an app they use | none here | A single `.js` file you hand them | [No project](#5-no-project-a-plugin-to-paste-into-an-app) |

If `package.json` names `extensible-web-apps` but `node_modules` is missing, run `npm install` first.

Read before writing, in this order, and stop when you have what the plugin needs:

1. [example/](example/) in this skill: a working app of two plugins that is checked against every change to the platform. Start from its shapes.
2. `PLATFORM/docs/guide/writing-a-plugin.md`, then the guide page for what the plugin does (the table in step 3 says which).
3. `PLATFORM/docs/api.md` for exact names. It is long and printed by the kernel itself: search it (`## Capabilities`, `## Manifest`, `## Collections`, `## HTML views`, `### <service>`), don't read it whole. Trust it over this file.
4. The app's own `app.html` and the plugins it links: its slots, its collections and their fields.

## 2. Write it

Three files at most, named after the plugin's id:

- **`<id>.js`**: the manifest, then the default export.
- **`<id>.html`**: its `<template id>` views and one `<style>`, when it draws more than a line or two.
- A line in the app's `app.html`: `<link rel="plugin" href="<id>.js">`, and a `<slot name="…">` where its view goes if the page has none that fits.

Start every file with a comment saying what it shows. The code is read as documentation, by the person and by the next agent.

### The manifest

```js
export const manifest = {
  id: "reading-count",            // lowercase letters, digits and dashes; unique in the app
  name: "Reading count",          // what the person sees
  description: "Shows how many books you have finished.",
  version: "1.0.0",
  permissions: ["ui", "data:read:reading-books"],
};
```

- `export const manifest = { … }` is the module's **first statement**: nothing before it but comments, not even an `import`.
- It is a **plain literal**: strings, numbers, booleans, arrays and objects written out. No spreads, calls, template strings, variables or computed keys.
- `permissions` lists **everything the code uses and nothing more**. The person reads this list before they accept a plugin, so each extra line costs trust. The check names any that are missing.

| The code does | It needs |
| --- | --- |
| Draws anything | `ui` |
| Reads or writes a collection its own manifest declares | nothing |
| Reads another plugin's collection, or hears it change | `data:read:<collection>` |
| Writes another plugin's collection (the person reviews each write, so pass a reason as the last argument) | `data:write:<collection>` |
| Listens to a hook, or takes part in one that can stop an action | `hook:listen:<hook>`, `hook:intercept:<hook>` |
| Calls a web API | `network:<host>`, through `ctx.call("net", "fetch", …)`; a key through `secrets.request`, never in the code |
| Adds a command (`ctx.commands.add`) | nothing |
| Asks a language model | `llm`, and `services: ["llm"]` |

The rest are in `PLATFORM/docs/permissions.md`. A service that not every site runs (`llm`, `router`, `schedule` and others) also goes in `services`, so the plugin says so at once on a site without it.

### Data

- A plugin **owns** the collections its manifest declares, each with a JSON Schema subset (see the example, and `## Collections` in the API reference). Every write is checked against the schema; the kernel adds `id`, `createdAt` and `updatedAt`, so don't declare them.
- Collections belong to the whole site, not one app. **Name a new collection after the app** (`reading-books`, not `books`).
- `ctx.call("data", "list" | "get" | "put" | "delete", collection, …)`. `put` replaces the whole record: spread the old one in to change a field. A write the schema rejects returns `{ ok: false, errors }` and writes nothing.
- Small state that isn't a record: `ctx.storage.get/set`. Something the person should be able to change: `settings` in the manifest and `ctx.settings.get()`.

### Views

A plugin never touches the page. There is no `document` or `window` in its worker. It sends a view and the host draws it.

- Put the HTML in the template file and send data: `ctx.ui.views("<id>.html")`, then `.live(slot, templateId, async (ctx) => data)` for anything that shows data. A live view is drawn again whenever what it read **through the `ctx` it was given** changes, so there is no redraw code after a write.
- Templates have only `{{path}}`, `<template for="x of path">` and `<template if="path">` (or `if="!path"`). No expressions: work each value out in the script and send it ready to show.
- An attribute that is one whole `{{hole}}` comes and goes with the value: `checked="{{done}}"`, `data-done="{{done}}"`.
- The person's actions: `data-action="name"` on a button, input or form, handled in `ctx.ui.onEvent((action, value) => …)`. For repeated controls put the id in the action (`data-action="tick:{{b.id}}"`) and a `key="{{b.id}}"` on the repeated element.
- Use the platform's elements before writing your own markup: `ui-form` and `ui-table` bound to a collection (they read and save by themselves), `ui-card`, `ui-stat`, `ui-badge`, `ui-empty`, `ui-toolbar`, `ui-stack`, `ui-grid`. Attributes are under `## HTML views` in the API reference.
- For a line or two, build it in code: ``ctx.ui.live(slot, key, async (ctx) => ctx.ui.html`<p>${count} done</p>`)``. `ctx.ui.html` escapes every value. Never add strings together to make HTML.
- The host keeps only allowed HTML and silently drops the rest: no `<script>`, no `style=""` (except custom properties set to numbers, `style="--pct: 40"`), no `onclick`, no `<iframe>`. An `id` you write is not the id on the page, so style and find things by `class` or `data-*`.

### Style

Plain HTML and the `ui-*` elements already look finished. Add CSS only for layout the defaults can't know, in one `<style>` in the template file, outside the templates. The host scopes it to this plugin's views.

- Every colour, gap, padding, font size and radius is a **design token**: `var(--space-1)` to `var(--space-6)`, `var(--text-sm)` to `var(--text-2xl)`, `var(--fg)`, `var(--fg-2)`, `var(--surface)`, `var(--border)`, `var(--accent)`, `var(--ok)`, `var(--warn)`, `var(--danger)`, `var(--radius)`. No hex colours and no hand-written `px` or `rem` there: the style lint counts each one. For a tint, `color-mix(in srgb, var(--accent) 16%, transparent)`.
- Rows wrap (`flex-wrap: wrap`) and nothing has a fixed width: it must work on a phone 390px wide. Text a person typed gets `overflow-wrap: anywhere`.
- Inside a view a `<form>` is already a column. Don't set heights on buttons or fields.
- Dropped by the host: `@import`, `@font-face`, `@keyframes`, `url()`, `!important`. Transitions work.
- The rules are `PLATFORM/DESIGN.md`; the how-to is `PLATFORM/docs/guide/styling.md`.

### What a plugin can't do

Each of these is refused or does nothing, so don't write it:

- `eval`, `new Function`, or a string given to `setTimeout`: the page's policy stops them, in workers too.
- `fetch` without a `network` permission, or to a host the manifest doesn't name.
- `import`, of an npm package, a CDN or another file. A plugin is one module.
- Reaching the page, another plugin's view or another plugin's code. Ask through `ctx`, or draw in a slot the other plugin offers.
- A companion folder with a plain name. Extra files that travel with a plugin sit beside it, or in a folder **with a dot in its name** (`reading.templates/card.html`), and are listed in the manifest's `files`.

## 3. More than the basics

Read the page before using the feature. Each is in `PLATFORM/docs/guide/`.

| The plugin should | Read |
| --- | --- |
| Show up in an app that has no slot for it | `places.md` |
| Add to, or change, another plugin's view | `slots-and-transforms.md` |
| Read another app's data | `sharing-data-between-apps.md` |
| Offer an action to the palette, a shortcut and agents | `commands.md` |
| Answer a link, a form post or a fetch | `routes.md` |
| Call a web API with a key | `keys-and-requests.md` |
| Tell other plugins something happened, or let them stop it | `plugin-hooks.md` |
| Ask a language model, or be an agent | `tools.md`, `agents.md` |
| Run with no tab open: a public form, a schedule, email | `spaces-and-servers.md` |
| Draw on a canvas, or play sound | `views-and-templates.md` (Drawing), `games-and-audio.md` |
| Find out why it isn't working | `debugging.md` |

## 4. Check it, then show it

1. Run the check from the table in step 1. It reads the files without a browser and names each mistake with its file: a manifest that isn't a plain literal, a call the permissions don't allow, a template the code draws that isn't in the file, HTML the host would drop, a slot the page doesn't have. **Fix every error and warning and run it again.** Don't hand over a plugin the check hasn't passed, and if you couldn't run it, say so.
2. Look for style notes in the files you wrote, and clear each one: `npm run check demos/<app> -- --style` in the platform's repo lists them, and in a project of your own they are the `style` list in `npm run check -- --json`.
3. Start it for the person: `npm run dev`, then `http://localhost:5173/` in a project of their own, or `http://localhost:5173/demos/<app>/app.html` in the platform's repo. If you can drive a browser, open it and use the plugin once; the check can't see a view that draws but is wrong.
4. When a view doesn't draw: `<link rel="plugin" href="/std/debug-console.js">` and `<slot name="debug" float></slot>` in `app.html` add a bug button that shows errors and every refused call (`denied`).

Then tell the person, in plain words: what the plugin does, each permission it asks for and why, which files you added or changed, and the address to open.

## 5. No project: a plugin to paste into an app

Every app has a **Customize** button (bottom left). A person adds their own plugin there, to an app they didn't write, with **Add a plugin**: paste its code or pick its files. They are shown the code and what it may do on a review card, and nothing runs until they accept. So:

- Write **one `.js` file** with its HTML built by `ctx.ui.html`, so there is nothing else to carry. If it needs a template file, list it in the manifest's `files: ["<id>.html"]` and tell the person to pick both files.
- The app has no slot for it, so name a **place**: `places: { note: { at: "main", put: "prepend" } }`, and render to `"note"`. Use a selector the author chose (`#id`, `[data-part=…]`, `main`, `header`, `aside`, `footer`), not a position. [example/reading-count.js](example/reading-count.js) is this shape.
- To read the app's data you need its collections' names and fields. Don't guess them: ask the person for the app's address or the code of the plugin that owns the data, and read the manifest's `collections`.
- You can't run the check without the platform. Say so, keep to the example's shapes exactly, and tell the person the app checks the plugin when they add it and says what is wrong.
- Tell them the steps: open the app, press Customize, then Add a plugin, paste the code, read the card and accept it. Pasted code is turned on once it is accepted; a plugin added from files starts off, with a switch beside it.

A plugin can also be written inside the app by the app's own Plugin maker ("Write it for me" in Customize's Make tab), with the person's own model key. Mention it when the person has no project and would rather not paste code.
