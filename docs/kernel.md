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

- **The manifest is read before any code runs** (`src/kernel/manifest.ts`). It must be a plain literal: strings, numbers, booleans, null, arrays and objects. Anything else, such as a spread, a call or a template string, is refused with the line it failed on. When the plugin starts, the manifest it reports must match; one that changes itself is uninstalled.
- **Scope.** A `shared` plugin runs once, in the spawner tab, for every tab. A `tab` plugin runs once in every open tab; its views go only to that tab, and it is the only kind that can draw on a canvas (a canvas cannot be handed to another tab's worker).
- **Workers and network.** Each plugin instance gets its own dedicated worker. The worker's content security policy allows only its own module (`script-src 'self' blob:`) and no network (`connect-src 'none'`). Plugins with the `network` permission get a second copy of the runtime served with `connect-src 'self' https: wss:`. The policies are set in `vite.config.ts` for development and in `public/_headers` for Cloudflare.

## The `ctx` a plugin gets

| Call | Needs |
| --- | --- |
| `ctx.on(hook, handler)` | `hook:listen:<hook>` for `emit` and `parallel` hooks; `hook:intercept:<hook>` for hooks that can change or stop an action (`serial`, `bail`, `waterfall`) |
| `ctx.call(service, method, ...args)` | Whatever the service asks for: `audio` for `audio.*`, `data:read:notes` for `store.list` |
| `ctx.ui.render(slot, key, view)` | `ui` |
| `ctx.ui.onEvent(handler)`, `ctx.ui.onCanvas(id, handler)` | Nothing extra |
| `ctx.log(text)` | Nothing |

Editor-style permissions map onto capabilities: `post:read` is `hook:listen:note:*`, `post:write` is `hook:intercept:data:beforeWrite`.

## Hooks

Every hook is defined with `defineHook(name, { mode, timeoutMs, onFailure })` in `src/kernel/hooks.ts`. Listeners in other workers are held to the spec: `emit` and `parallel` hooks are posted and forgotten; the others wait for the answer for `timeoutMs`, then either skip the listener (`onFailure: "open"`) or treat the silence as a block (`"closed"`).

## Trace ids

Every action from a tab gets a trace id. The kernel passes `{ trace }` as Cordis's `thisArg` on every dispatch, which Cordis hands both to listeners and to the `internal/dispatch` tap, so the id survives awaits inside the kernel. It travels to plugin workers on every hook message, and calls or renders a plugin makes while handling it carry it back. The trace panel at the bottom of the page shows the events; `window.__host.traces` has them in the console.
