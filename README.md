# Extensible Web Apps

A platform for malleable web apps: a small kernel, and everything else is a plugin. That includes the UI shell, storage and, later, the AI app builder. Plugins run in their own workers, can only do what their manifest asks for, and draw their UI as plain HTML.

**Try it:** https://extensible-web-apps.kinlan-test.workers.dev/ is the workbench. The demo apps are in [`demos/`](demos/): a reading list, spending, recipes, contacts and a calendar.

![The reading list demo](docs/images/collections.png)

## Start here

| If you want to… | Read |
| --- | --- |
| See what writing an app looks like | [`demos/`](demos/), starting with [`demos/README.md`](demos/README.md) |
| Look up an API | [`docs/api.md`](docs/api.md), generated from the running kernel |
| Understand how the kernel works | [`docs/kernel.md`](docs/kernel.md) |
| Know why it is built this way | [`docs/spike.md`](docs/spike.md) and the [plan](https://claude.ai/artifact/S7NdMrp2PkNSqHZFNdqGrC) |

## How it fits together

An app is a folder with an `app.html`: an ordinary page that lays out `<slot name>` elements and lists its plugins with `<link rel="plugin" href="…">`. Each plugin is one file. The page loads the platform with two lines (`/platform/host.css` and `/platform/host.js`); the host fetches the linked plugins, the kernel runs each in its own worker, and their views appear in the slots they name.

### How a view and its data move

A plugin never touches the page. It sends messages, the kernel checks each one against the plugin's manifest, and the page draws what's left. Each arrow below is a message between workers.

```mermaid
sequenceDiagram
    participant P as Plugin (its own worker)
    participant K as Kernel (shared worker)
    participant H as Page (app.html)

    Note over P,H: Drawing
    P->>K: views.render(slot, template id, data)
    K->>K: checks the ui permission and that the template file sits next to the plugin
    K->>H: the view
    H->>H: fill holes as text, sanitise to the HTML allowlist, morph only what changed

    Note over P,H: Acting
    H->>K: a click on data-action, or a form submit
    K->>P: ctx.ui.onEvent(action, value), sent only to the plugin that drew the view

    Note over P,H: Data
    P->>K: ctx.call("data", "put", collection, record)
    K->>K: owner, or data:write plus a review card the person accepts, then schema check and save
    K-->>P: data:changed:collection, to every plugin listening
    K-->>H: new records, pushed to bound ui-table and ui-form
```

Bound elements update on their own. A plugin's own views update when it hears `data:changed` and draws again.

Three kinds of code, each in its own place:

- **The host** (`src/host/`) is the page. It draws what plugins render, turns clicks and typing into events, and runs no plugin code. Read [`main.ts`](src/host/main.ts) first, then:
  - [`sanitize.ts`](src/host/sanitize.ts) keeps only the HTML listed in [`src/shared/html.ts`](src/shared/html.ts)
  - [`morph.ts`](src/host/morph.ts) updates a view in place
  - [`templates.ts`](src/host/templates.ts) fills a plugin's view templates with its data
  - [`workbench.ts`](src/host/workbench.ts) is the trace and benchmarks on the platform's own page
  - [`elements.ts`](src/host/elements.ts) loads the `ui-*` elements from [`elements/`](elements/)
  - [`bindings.ts`](src/host/bindings.ts) connects `<ui-form>` and `<ui-table>` to collections
- **The elements** ([`elements/`](elements/)) are the `ui-*` custom elements views are built from, one `.html` file each, run as written with no build. See [`elements/README.md`](elements/README.md).
- **The kernel** (`src/kernel/`) is a shared worker that every tab talks to. [`kernel.ts`](src/kernel/kernel.ts) wires everything together and is the place to start. The other files, by job:
  - **Talking to plugins:**
    - [`remote.ts`](src/kernel/remote.ts) is the bridge to plugin workers
    - [`manifest.ts`](src/kernel/manifest.ts) reads a manifest without running the plugin
    - [`gate.ts`](src/kernel/gate.ts) checks every call against the manifest
    - [`hooks.ts`](src/kernel/hooks.ts) defines the events plugins can listen to
    - [`apps.ts`](src/kernel/apps.ts) runs the plugins an open app links, while a tab has it open
  - **Data:**
    - [`store.ts`](src/kernel/store.ts) is the data folder
    - [`records.ts`](src/kernel/records.ts) and [`schema.ts`](src/kernel/schema.ts) hold collections
    - [`paths.ts`](src/kernel/paths.ts) checks file paths
  - **Keeping the person in charge:**
    - [`review.ts`](src/kernel/review.ts) shows a diff before a plugin changes data it doesn't own
    - [`changes.ts`](src/kernel/changes.ts) is the log of what changed
    - [`catalog.ts`](src/kernel/catalog.ts) is the plugins panel
  - **Built in:**
    - [`notes.ts`](src/kernel/notes.ts) is the notes app
    - [`reference.ts`](src/kernel/reference.ts) is the API reference
    - [`trace.ts`](src/kernel/trace.ts) is the trace you see at the bottom of the page
- **The sandbox** ([`src/sandbox/runtime.ts`](src/sandbox/runtime.ts)) runs inside each plugin's worker. It builds the `ctx` a plugin is given, and every call on `ctx` becomes a message to the kernel.

[`src/shared/`](src/shared/) holds what both sides agree on:
- the message protocol
- the plugin API's types
- the HTML allowlist

Plugins live in two places:
- [`demos/`](demos/) holds apps written to show the programming model, one folder per app.
- [`plugins/`](plugins/) holds the plugins built into the app:
  - `word-count.js` and `edit-times.js`, copied unchanged from the [Markdown editor](https://github.com/PaulKinlan/MarkdownEdiitor)
  - `tidy.js` (change review), `tone.js` (audio) and `bars.js` (canvas)
  - test plugins that check the security rules

## Running it

```sh
npm install
npm run dev        # http://localhost:5173 is the workbench; /demos/reading-list/app.html is a demo app; ?kernel=dedicated runs the kernel in a dedicated worker
npm test           # build, then 94 checks in Chromium, and the measurements (needs Playwright: npm i -g playwright && npx playwright install chromium)
npm run reference  # rewrite docs/api.md from the running kernel
npm run typecheck
```

The trace panel at the bottom of the page shows every dispatch, remote call, denial and lifecycle event.

Every push to `main` is deployed to Cloudflare as static assets ([`wrangler.jsonc`](wrangler.jsonc)), through Cloudflare's Git integration. Cloudflare applies [`public/_headers`](public/_headers), so plugin workers there get the same content security policy as under `vite preview`: no network unless the plugin's manifest asks for it.

## Background

- Built on [Cordis](https://github.com/cordiverse/cordis), the plugin framework under [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness).
- It also learns from:
  - the [Markdown editor](https://github.com/PaulKinlan/MarkdownEdiitor)'s extension system
  - [Pi](https://github.com/badlogic/pi-mono)'s extensions
  - Ink & Switch's [Malleable software](https://www.inkandswitch.com/essay/malleable-software/) essay
