# The kernel

The kernel is Cordis core plus a few pieces of our own, running in a shared worker (or a dedicated one where shared workers are missing). This page describes what it does today; [the plan](https://claude.ai/artifact/S7NdMrp2PkNSqHZFNdqGrC) says where it is going.

## Plugins

A sandboxed plugin is one JavaScript module with a literal manifest and a default export:

```js
export const manifest = {
  id: "bars",                 // lowercase letters, digits, dashes
  name: "Note lengths",
  permissions: ["ui", "hook:listen:data:changed", "data:read:notes"],
  scope: "tab",               // "shared" (default) or "tab"
  order: 30,                  // optional: place in lists
  settings: { ... },          // optional: { key: { type, title?, default?, enum? } }
};

export default function (ctx) { ... }
```

- **The manifest is read before any code runs** (`src/kernel/manifest.ts`). `export const manifest = { ... }` must be the module's first statement, with only comments before it, so a manifest in a comment or a string can't stand in for the real one. Its value must be a plain literal: strings, numbers, booleans, null, arrays and objects, and nothing may follow it but the end of the statement. Anything else, such as a spread, a call, a template string or `.valueOf()` on the end, is refused with the line it failed on. When the plugin starts, the manifest it reports must match; one that changes itself is uninstalled.
- **Scope.** A `shared` plugin runs once, in the spawner tab, for every tab. A `tab` plugin runs once in every open tab; its views go only to that tab, and it is the only kind that can draw on a canvas (a canvas cannot be handed to another tab's worker).
- **Workers and network.** Each plugin instance gets its own dedicated worker. The worker's content security policy allows only its own module (`script-src 'self' blob:`), no workers of its own (`worker-src 'none'`, or a plugin could start the network runtime as a child) and no network (`connect-src 'none'`). Plugins with the `network` permission get a second copy of the runtime served with `connect-src 'self' https: wss:`. The policies are set in `vite.config.ts` for development and in `public/_headers` for Cloudflare.

## Where plugins come from, and settings

Built-in plugins ship with the app. A plugin installed at run time is kept in the data folder as `plugins/<id>.js`, so it travels with the data, and the next kernel to open that folder loads it again. A plugin in the data folder replaces the built-in one with the same id. Ids the kernel uses for its own views and services (`kernel`, `host`, `notes`, `plugins`, `store`, `settings`, `audio`) are refused, so a plugin can't pass for the kernel's own panels.

The plugins panel (`src/kernel/catalog.ts`, in the side bar) lists every plugin and where it came from. Any plugin can be turned off, which stops its workers but keeps it installed. Plugins kept with the data can also be removed, which deletes their file. A plugin stopped for changing its manifest is removed the same way.

A manifest's `settings` become a form in the panel:

```js
settings: {
  frequency: { type: "number", title: "Pitch (Hz)", default: 440 },
  wave: { type: "string", title: "Wave", enum: ["sine", "square"], default: "sine" },
},
```

`boolean` becomes a checkbox, `number` a number field, and `string` a text field, or a menu when it has an `enum`. The kernel checks each value against its spec before keeping it. Which plugins are off, and every plugin's settings, are kept in `plugins.json` in the data folder. A plugin reads its own settings with `await ctx.settings.get()` and hears changes through `ctx.settings.onChange(handler)`. No capability is needed, because a plugin can only read its own. Editor extensions get the same values from `editor.settings.get()`.

## The `ctx` a plugin gets

| Call | Needs |
| --- | --- |
| `ctx.on(hook, handler)` | `hook:listen:<hook>` for `emit` and `parallel` hooks; `hook:intercept:<hook>` for hooks that can change or stop an action (`serial`, `bail`, `waterfall`) |
| `ctx.call(service, method, ...args)` | Whatever the service asks for: `audio` for `audio.*`, `data:read:notes` for `store.list` |
| `ctx.ui.render(slot, key, view)` | `ui` |
| `ctx.ui.onEvent(handler)`, `ctx.ui.onCanvas(id, handler)` | Nothing extra |
| `ctx.settings.get()`, `ctx.settings.onChange(handler)` | Nothing: a plugin sees only its own settings |
| `ctx.storage.get(key)`, `ctx.storage.set(key, value)` | Nothing: the plugin's own data, kept in `plugin-data/<id>.json`, up to 1 MB, never reviewed |
| `ctx.call("store", "put", { id?, text }, reason)` | `data:write:notes`, and the person's review |
| `ctx.call("files", "read" \| "write", path, text?, reason?)` | `files:<folder>` for the path's first folder, path checks, and (for a write) the person's review |
| `ctx.log(text)` | Nothing |
| `ctx.traced()` | Nothing: returns a copy of `ctx` whose calls keep the current trace id after an `await` |

Editor-style permissions map onto capabilities: `post:read` is `hook:listen:note:*`, `post:write` is `hook:intercept:data:beforeWrite`.

## Change review

A write outside a plugin's own data is shown to the person before it happens (`src/kernel/review.ts`). Notes belong to the notes app, and files are in the data folder, so a plugin's `store.put` or `files.write` opens a card above the editor. The card shows the plugin's name, its reason, and a line diff of the change, with three choices:

- **Accept:** this write only (`allowed-once`).
- **Always allow in …:** this write, and any later one by the same plugin to the same place (`notes`, or a folder such as `exports/`), without asking. The grant is kept with the data in `grants.json`, so it belongs to this app only. The plugins panel lists each grant with a Forget button.
- **Decline:** nothing is written, and the plugin's call fails with "The person declined the change" (`rejected`).

A card nobody answers within five minutes is `cancelled`. Turning a plugin off or removing it cancels its open cards. A write that changes nothing is not shown.

**Path checks** (`src/kernel/paths.ts`) run before any file is read or written, whatever capabilities the plugin has. Paths must be relative, use `/`, and sit inside a folder. They can't contain empty, `.` or `..` segments or hidden names, and they can't touch the platform's own files (`plugins/`, `plugin-data/`, `plugins.json`, `grants.json`, `changes.json`, `notes.json`). That last rule means a plugin can never install or approve plugins by writing files.

**The change log** (`src/kernel/changes.ts`) records every install, removal, on/off switch, settings change, grant, revoke and reviewed write, with its outcome and trace id. It keeps the most recent 500 in `changes.json` in the data folder. `window.__host.command("changes")` returns it.

## Hooks

Every hook is defined with `defineHook(name, { mode, timeoutMs, onFailure })` in `src/kernel/hooks.ts`. Listeners in other workers are held to the spec: `emit` and `parallel` hooks are posted and forgotten; the others wait for the answer for `timeoutMs`, then either skip the listener (`onFailure: "open"`) or treat the silence as a block (`"closed"`).

## Trace ids

Every action from a tab gets a trace id. The kernel passes `{ trace }` as Cordis's `thisArg` on every dispatch, which Cordis hands both to listeners and to the `internal/dispatch` tap, so the id survives awaits inside the kernel. It travels to plugin workers on every hook message, and calls or renders a plugin makes while handling it carry it back. In a plugin, `ctx` carries the id only during the synchronous part of a handler, because workers have no async context to carry it past an `await`. For work after an `await`, a handler takes a copy of the API pinned to its trace:

```js
ctx.ui.onEvent(async (action) => {
  const here = ctx.traced(); // pinned to this event's trace
  await here.call("audio", "play", { processor: "tone-sine" });
  here.log("played"); // still carries the click's trace
});
```

A handler written as a `function` also gets the pinned copy as `this`. Logs carry the trace too. The trace panel at the bottom of the page shows the events; `window.__host.traces` has them in the console.
