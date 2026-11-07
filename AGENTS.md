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
npm run dev          # open http://localhost:5173/demos/<app>/app.html; the workbench at / has the trace
npm test             # builds, then opens every app in demos/ and checks each linked plugin draws
npm run typecheck
npm run reference    # after changing the kernel's API: rewrites docs/api.md (the tests check it)
```

A new app in `demos/` is picked up by the tests automatically. Add a check for what it does to [`tests/platform.test.mjs`](tests/platform.test.mjs), next to the other demo checks.

## Where to look

| For | Read |
| --- | --- |
| How it all fits | [docs/guide/how-an-app-works.md](docs/guide/how-an-app-works.md) |
| Every `ctx` call, service, hook, permission and manifest field | [docs/api.md](docs/api.md), or `ctx.call("kernel", "reference")` at run time |
| Working examples | [demos/](demos/), each file commented |
| The elements | [elements/README.md](elements/README.md) |
| The kernel's internals | [docs/kernel.md](docs/kernel.md) |
