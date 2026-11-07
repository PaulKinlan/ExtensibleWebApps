# AGENTS.md

Instructions for AI agents (and people) building apps and plugins on this platform. The [developer guide](docs/guide/README.md) explains everything here at length; the [API reference](docs/api.md) is generated from the kernel, so trust it over anything else.

## What you are building

- An **app** is a folder in `demos/` (or anywhere served) with an `app.html`: a plain page that loads the platform with two lines, lays out `<slot name="…">` elements, and lists plugins with `<link rel="plugin" href="x.js">`.
- A **plugin** is one ES module, run in its own worker. It has a manifest and a default export that gets `ctx`. Its views are `<template id>` elements in an `.html` file next to it.
- **No build step.** Write plain JavaScript (JSDoc and `// @ts-check` are welcome), HTML and CSS. The browser runs the files as written. Don't add bundlers, frameworks or npm dependencies to apps or plugins.

Copy [`demos/habits/`](demos/habits/) to start: it is the smallest complete app, and [the guide](docs/guide/writing-a-plugin.md) walks through it.

## Rules the kernel enforces

1. `export const manifest = { … }` is the module's **first statement** and a **plain literal**: no spreads, calls, template strings or computed values.
2. `id` is lowercase letters, digits and dashes. `permissions` lists every capability the plugin uses; everything else is refused and traced as `denied`.
3. A plugin owns the collections in its manifest and reads and writes them freely. Reading another's needs `data:read:<name>`; writing needs `data:write:<name>` and the person reviews each write, so pass a reason: `ctx.call("data", "put", name, record, "why")`.
4. Views are HTML from an allowlist ([`src/shared/html.ts`](src/shared/html.ts)): no scripts, `style` attributes, iframes, SVG or event handlers. Use `class` with a `<style>` in the template file.
5. A plugin can't touch the DOM, the network (without `network`), or other plugins. It sends messages through `ctx`.

## How to write it

- Put views in a template file and send data: `ctx.ui.views("x.html").render(slot, id, data)`. Keep logic in the script; templates only have `{{path}}`, `<template for="x of path">` and `<template if="path">`.
- Draw views that show data with `live`, so they follow changes: `views.live(slot, id, async (ctx) => data)`. Read through the `ctx` the function is given.
- An attribute that is a single `{{hole}}` is left out when the value is false or missing: `checked="{{done}}"`.
- Use `ui-form` and `ui-table` bound to a collection instead of hand-writing forms and tables, unless you need something they can't do. Schemas drive the form, including lists (`type: "array"`) and groups (`type: "object"`).
- Get the person's actions with `data-action` on buttons, inputs and forms, and `ctx.ui.onEvent((action, value) => …)`. Put an id in the action (`tick:{{i.id}}`) for repeated controls, and a `key="{{i.id}}"` on repeated elements.
- Style with the design tokens (`var(--space-2)`, `var(--fg-2)`, `var(--accent)`…). The page's own CSS overrides any plugin's.
- Give every file a comment at the top saying what it shows. The code is read as documentation.

## How to check it

```sh
npm install
npm run dev          # open http://localhost:5173/demos/<app>/app.html; the workbench at /workbench/ has the trace
npm test             # builds, then opens every app in demos/ and checks each linked plugin draws
npm run typecheck
npm run reference    # after changing the kernel's API: rewrites docs/api.md (the tests check it)
```

A new app in `demos/` is picked up by the tests automatically. Put checks for what it does in a new file, `tests/demos/<app>.mjs` (copy [`tests/demos/habits.mjs`](tests/demos/habits.mjs)), and checks for a platform feature in `tests/checks/<feature>.mjs`. The runner finds both, so you never edit [`tests/platform.test.mjs`](tests/platform.test.mjs) to add a check.

## Changing the platform without getting in anyone's way

Many people and agents work on this repo, and on the sites built with it, at once. Every change should leave everyone else's work merging cleanly and every demo working.

- **Add, don't edit.** A new element, plugin, service, hook, doc page or test is a new file wherever the core can find it. Elements already work this way: `ui-table` is `elements/ui-table.html`, and no list names it.
- **Keep shared lists merge-friendly.** When a change has to add to a list (a JS array or object, `<link>` lines in HTML, imports, a docs table), put one entry per line with a trailing comma, and sorted where order doesn't matter. Then two changes that each add an entry touch different lines.
- **No running totals in prose.** Don't write counts that every change bumps, like the number of checks; the test run prints it.
- **Keep old APIs working.** Add a new call beside the old one, so a demo only has to change when the change is about that demo. When a demo does need to change for the tests to pass, change it in the same PR.
- **Generated files are regenerated, not hand-merged.** If `docs/api.md` conflicts, take either side and run `npm run reference`.
- **Base each PR on `main`.** If a PR has to stack on another, merge the parent with a merge commit, not a squash, so the child still merges cleanly.

## Where to look

| For | Read |
| --- | --- |
| How it all fits | [docs/guide/how-an-app-works.md](docs/guide/how-an-app-works.md) |
| Every `ctx` call, service, hook, permission and manifest field | [docs/api.md](docs/api.md), or `ctx.call("kernel", "reference")` at run time |
| Working examples | [demos/](demos/), each file commented |
| The elements | [elements/README.md](elements/README.md) |
| The kernel's internals | [docs/kernel.md](docs/kernel.md) |
