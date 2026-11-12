# AGENTS.md

Instructions for AI agents (and people) building apps and plugins on this platform. The [developer guide](docs/guide/README.md) explains everything here at length; the [API reference](docs/api.md) is generated from the kernel, so trust it over anything else.

## What you are building

- An **app** is a folder in `demos/` (or anywhere served) with an `app.html`: a plain page that loads the platform with two lines, lays out `<slot name="…">` elements, and lists plugins with `<link rel="plugin" href="x.js">`.
- A plugin for a page with **no slot** for it names a place in its manifest instead, `places: { name: { at: "<css selector>", put: "after" } }`, and renders to that name. Pick selectors the author chose (`#id`, `[data-part=…]`, landmarks), not positions, and respect `data-extend="review"` and `"locked"`: [places](docs/guide/places.md).
- To add to **another plugin's view**, fill a slot it declares (`<slot name="cookbook.recipe.actions">`: render to that name, `page.slots` says what each is for), or transform it with a place that has `in: "<plugin>"` and the permission `ui:transform:<plugin>`: [slots and transforms](docs/guide/slots-and-transforms.md).
- A **plugin** is one ES module, run in its own worker. It has a manifest and a default export that gets `ctx`. Its views are `<template id>` elements in an `.html` file next to it.
- An **agent** is a Markdown file linked with `<link rel="agent" href="x.agent.md">`: frontmatter for its id, permissions and what wakes it, then its instructions. The kernel runs it as a plugin that asks a model and calls tools: [agents](docs/guide/agents.md).
- A plugin that should keep working with no app open (a public form, a scheduled job, a check on every change people send) says `runs: "server"` in its manifest. It runs on the server of a space the app is opened in (`/s/<space>/…`), with `routes`, `schedule` and `email`: [spaces and server plugins](docs/guide/spaces-and-servers.md).
- To let **agents outside the app** use it (the browser's own assistant through WebMCP, or Claude Code and other MCP clients through a space's server), link a plugin that calls `ctx.call("outside", "open")`, or an agent file with `outside: true`: they act as that plugin, with its permissions and the person's reviews: [outside agents](docs/guide/outside-agents.md).
- To let **an editor talk to an app's agent** (Zed or any ACP client), nothing is added: an agent file with `- message: true` on the standard loop is reachable at `/s/<space>/acp/<agent id>` once its app was opened in a space, through `extensible-app acp <address>`: [editors and agents](docs/guide/editors-and-agents.md).
- A plugin can define **hooks of its own** in its manifest (`hooks: { open: { mode: "emit" } }`, heard by others as `<id>:open`) and run them with `ctx.hooks.emit` or `ctx.hooks.call`: [hooks of your own](docs/guide/plugin-hooks.md).
- **No build step.** Write plain JavaScript (JSDoc and `// @ts-check` are welcome), HTML and CSS. The browser runs the files as written. Don't add bundlers, frameworks or npm dependencies to apps or plugins.

Start with `npm run new-app -- my-app`: it copies [`starter/`](starter/), a list you can add to and tick off, to `demos/my-app/`. With no checkout, `npm create extensible-app my-app` makes a project of your own instead: the same starter at the top of `my-app/`, the platform as a dependency, and `npm run dev`, `check` and `deploy` serving it at `/` ([An app of your own](docs/guide/your-own-app.md)). [`demos/habits/`](demos/habits/) is the smallest complete demo, and [the guide](docs/guide/writing-a-plugin.md) walks through it.

To write one plugin for an app, the short version of this file is the skill in [`.claude/skills/extensible-plugin/`](.claude/skills/extensible-plugin/SKILL.md), which Claude Code loads by itself here and in every project made with `npm create extensible-app`: [Asking an agent to write a plugin](docs/guide/asking-an-agent.md). When you change how plugins are written, change the skill in the same pull request.

## Rules the kernel enforces

1. `export const manifest = { … }` is the module's **first statement** and a **plain literal**: no spreads, calls, template strings or computed values.
2. `id` is lowercase letters, digits and dashes. `permissions` lists every capability the plugin uses; everything else is refused and traced as `denied`.
3. A plugin owns the collections in its manifest and reads and writes them freely. Reading another's needs `data:read:<name>`; writing needs `data:write:<name>` and the person reviews each write, so pass a reason: `ctx.call("data", "put", name, record, "why")`.
4. Views are HTML from an allowlist ([`src/shared/html.ts`](src/shared/html.ts)): no scripts, `style` attributes, iframes, SVG or event handlers. Use `class` with a `<style>` in the template file.
5. A plugin can't touch the DOM, the network (without `network`), or other plugins. It sends messages through `ctx`.
6. Pages run no inline script and take no markup from a plain string (Trusted Types): put a page's script in a file next to it, and build elements rather than setting `innerHTML`. Every app installs and works offline already: [installing, offline and files](docs/guide/installing-and-files.md).

## How to write it

- Put views in a template file and send data: `ctx.ui.views("x.html").render(slot, id, data)`. Keep logic in the script; templates only have `{{path}}`, `<template for="x of path">` and `<template if="path">`.
- Draw views that show data with `live`, so they follow changes: `views.live(slot, id, async (ctx) => data)`. Read through the `ctx` the function is given.
- An attribute that is a single `{{hole}}` is left out when the value is false or missing: `checked="{{done}}"`.
- Use `ui-form` and `ui-table` bound to a collection instead of hand-writing forms and tables, unless you need something they can't do. Schemas drive the form, including lists (`type: "array"`) and groups (`type: "object"`).
- Get the person's actions with `data-action` on buttons, inputs and forms, and `ctx.ui.onEvent((action, value) => …)`. Put an id in the action (`tick:{{i.id}}`) for repeated controls, and a `key="{{i.id}}"` on repeated elements.
- Name what the plugin does as commands: `ctx.commands.add({ id, title, keys? }, handler)`. The command palette lists them, their keys run them, and agents run them as tools. See [Commands](docs/guide/commands.md).
- To let a link, a form or a fetch reach the plugin, add a route: `ctx.routes.add("POST", "add-book", handler)` with the `routes` permission. See [Routes](docs/guide/routes.md).
- Style with the design tokens (`var(--space-2)`, `var(--fg-2)`, `var(--accent)`…). The page's own CSS overrides any plugin's. Follow [DESIGN.md](DESIGN.md) for anything a person sees: its layout rules are checked on every page at desktop and phone width by `npm test`.
- Give every file a comment at the top saying what it shows. The code is read as documentation.
- To call a web API, name its host (`network:api.example.com`) and use `ctx.call("net", "fetch", …)`. For its key, ask with `secrets.request` and put `{ secret: name }` in a header: the plugin never sees the key. See [API keys and web requests](docs/guide/keys-and-requests.md).

## How to check it

```sh
npm install
npm run check        # finds mistakes in the apps without a browser: permissions, manifests, templates, slots (--json for tools; --style lists raw colours and hand-written sizes, see DESIGN.md)
npm run dev          # open http://localhost:5173/demos/<app>/app.html; the workbench at /workbench/ has the trace
npm test             # builds, then opens every app in demos/ and checks each linked plugin draws
npm run test:server  # after changing anything a space's server runs: the server checks on Node and wrangler dev
npm run typecheck
npm run packages     # optional: says what the plugin registry (/packages/) will list, or fails on a plugin it can't list
```

A new app in `demos/` is picked up by the tests automatically. Put checks for what it does in a new file, `tests/demos/<app>.mjs` (copy [`tests/demos/habits.mjs`](tests/demos/habits.mjs)), and checks for a platform feature in `tests/checks/<feature>.mjs`. The runner finds both, so you never edit [`tests/platform.test.mjs`](tests/platform.test.mjs) to add a check.

## Changing the platform without getting in anyone's way

Many people and agents work on this repo, and on the sites built with it, at once. Every change should leave everyone else's work merging cleanly and every demo working.

- **Add, don't edit.** A new element, plugin, service, hook, doc page or test is a new file wherever the core can find it. Elements already work this way: `ui-table` is `elements/ui-table.html`, and no list names it. A kernel service an app may not need is a kernel module, `std/<name>/module.ts` with its manifest `std/<name>/module.json`, listed in `kernel.json`; one every app needs is a file in `src/kernel/services/` (and every new file in `src/kernel/` goes on the core or services list in `tests/checks/kernel-layers.mjs` and [docs/layers.md](docs/layers.md), or the tests fail), a kind of view the host draws is a file in `src/host/views/`, and a page-only API the host bridges is a file in `src/host/bridges/`; each is named after its file. A new top-level folder is served as written without touching `vite.config.ts` (unless it is build-only: then add it to `NOT_SERVED` there). A page that belongs to this website rather than the platform (like the front page or the workbench) goes in `site/`, which is served at the site's root.
- **The kernel stays small.** The kernel never becomes one big file: what a browser downloads to start an app is Cordis and the core, and everything an app may not use is fetched when it is first used ([docs/layers.md](docs/layers.md#the-kernel-stays-small)). A new capability is a plugin if it can be, else a kernel module with a `module.json` beside it saying what it adds; a part of the core only some apps use is fetched with `import()`. Never raise the kernel's size in `tests/perf-budget.json` to fit a feature. If keeping the kernel small needs a change to the architecture, make it.
- **Keep shared lists merge-friendly.** When a change has to add to a list (a JS array or object, `<link>` lines in HTML, imports, a docs table), put one entry per line with a trailing comma, and sorted where order doesn't matter. Then two changes that each add an entry touch different lines.
- **No running totals in prose.** Don't write counts that every change bumps, like the number of checks; the test run prints it.
- **Keep old APIs working.** Add a new call beside the old one, so a demo only has to change when the change is about that demo. When a demo does need to change for the tests to pass, change it in the same PR.
- **Never commit generated files.** There is nothing to run before pushing. The plugin registry (`packages/index.json`, `packages/catalog.json`, `packages/index.html`) and the demo gallery's lists in `demos/index.html` are made by the build from the plugins' manifests and the apps' `<meta>` tags ([scripts/generated.mjs](scripts/generated.mjs)), so they aren't in the repo (the gallery page is committed with its lists empty). `docs/api.md` is in the repo so it reads on GitHub, but only main writes it: the [Regenerate API reference](.github/workflows/regenerate-reference.yml) workflow rewrites it after each merge. A pull request that changes any of these fails a check that says how to put them back. A new generated file follows the same pattern: add it to `scripts/generated.mjs`, not to the repo.
- **Base each PR on `main`.** If a PR has to stack on another, merge the parent with a merge commit, not a squash, so the child still merges cleanly.

## Where to look

| For | Read |
| --- | --- |
| How it all fits | [docs/guide/how-an-app-works.md](docs/guide/how-an-app-works.md) |
| Every `ctx` call, service, hook, permission and manifest field | [docs/api.md](docs/api.md), or `ctx.call("kernel", "reference")` at run time |
| Working examples | [demos/](demos/), each file commented |
| The elements | [elements/README.md](elements/README.md) |
| The kernel's internals | [docs/kernel.md](docs/kernel.md) |
| Which layer code belongs in, from Cordis up to apps | [docs/layers.md](docs/layers.md) |
