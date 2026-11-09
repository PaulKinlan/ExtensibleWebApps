# Debugging an app

Everything an app does goes through the kernel, so the kernel can tell you about all of it: which plugins are running, what each one asked for and was given, which hooks exist and who listens to them, what happens as it happens, and which worker runs where. The platform gives you five ways to look, from inside an app to outside all of them.

| Tool | Where | What it shows |
| --- | --- | --- |
| Debug console, [`std/debug-console.js`](../../std/debug-console.js) | A bug button inside one app | That app's errors, refused permissions and trace, ready to copy into a bug report. |
| Hook tracer, [`std/hook-tracer.js`](../../std/hook-tracer.js) | Inside one app | Each action as a list of steps: the hooks it ran, in order, and what every listener said. |
| View source, [`std/view-source.js`](../../std/view-source.js) | Inside one app | Each plugin's code, and what its permissions mean in words. |
| Inspect mode | Any app, from Customize | Which plugin drew the part of the page you point at; hide it or add to it. |
| [The debugger](../../demos/debugger/app.html) | An app of its own | Every tab and app open on the site, and for each: plugins, manifests, permissions asked for, granted and refused, hooks and listeners, events, workers. In a space, the kernel on the space's server too. |

## The debugger

Open [`/demos/debugger/`](../../demos/debugger/app.html) in one tab and the app you are working on in another. Every tab on a site talks to the same kernel, so the debugger sees the other app's plugins as they run. Pick the app's tab and every panel follows it:

- **Plugins**: each plugin's manifest; the permissions it **asks for**; what the gate **also grants** (an editor permission's mapping, or one implied by another, such as `data:read:books` letting it hear `data:changed:books`); what it tried and was **refused**, because its manifest doesn't ask for it; the places the person said it may **always** change; which secrets it may use and whether they are set; the hooks it defines and listens to; its routes, commands and workers; and its code.
- **Hooks**: every hook, from the kernel, from a plugin's manifest `hooks` (named `<plugin>:<key>`), or from a collection (`data:changed:<c>`, `data:beforeWrite:<c>`). For each: its mode and time limit, the capability listening needs, who listens now, and how often it fired. A plugin can listen to a hook before the plugin that defines it is installed: such a hook shows as **waiting**.
- **Events**: the trace, as it happens. Filter it by kind or text, pause it, or pick an event's trace id to follow one action through every worker it touched.
- **Workers**: every plugin worker, by the tab that started it. Shared plugins run once, in the spawner tab; tab plugins run once per tab whose app links them.

- **Space server**: in a space, the kernel on the space's server, where plugins with `runs: "server"` run. It lists the plugins there (running, or kept for members without running), what each was granted, the routes it answers and the hooks it listens to, its secrets (set or not), its code, and which members' devices are connected now.

- **Space server events**: in a space, the trace of the kernel on the space's server, as it happens: the hooks its server plugins hear, their answers and calls, refusals, errors, workers, and members' devices coming and going.

It sees the kernel of the address it is opened at: open it at `/s/<space>/demos/debugger/app.html`, signed in as a member of that space, to look at the space in this browser, and at the kernel on its server in the two Space server panels. The other panels show this browser's kernel.

### Looking inside a space's server

A page in a space already keeps a socket open to the space's kernel, and only a member of the space can open one. The Space server panel asks over that socket with `ctx.call("sync", "reflect", method, id?)`, which needs `reflect:read`, the same permission as `reflect` itself. The space's kernel answers from its own `reflect` service, with the same read-only methods (`snapshot`, `plugins`, `hooks`, `workers`, `tabs`, `source`), so any panel that reads `reflect` can read the server too ([`std/spaces/reflect.ts`](../../std/spaces/reflect.ts)). Outside a space, or while the page can't reach it, the call fails and says why.

The events panel asks to hear the server's trace with `ctx.call("sync", "trace", true)`, which needs `reflect:read` too. The space sends the few hundred events from just before, then each new batch as it happens, and the page's kernel hands them to plugins as the `sync:trace` hook ([`std/spaces/trace.ts`](../../std/spaces/trace.ts)). The space sends its trace to no one else: a member's device that never asked gets none of it.

The debugger is a plugin per panel in [`demos/debugger/`](../../demos/debugger/). The panels agree on which tab to look at through the bus topic `debugger-focus`. Take one out, or add your own panel, as with any app.

## The `reflect` service

The debugger reads the kernel through `ctx.call("reflect", …)`: `snapshot`, `plugins`, `hooks`, `workers`, `tabs` and `source` (see the [API reference](../api.md#reflect)). It only reads, and it never returns a secret, only whether one is set. Because it sees every app open on the site, not only the caller's, it needs its own permission, `reflect:read`. Give that to developer tools, not to an app's ordinary plugins. Pair it with `debug:read` and the `debug:trace` hook to hear events as they fire.

```js
export const manifest = {
  id: "who-listens",
  name: "Who listens",
  permissions: ["reflect:read"],
};

export default async function (ctx) {
  for (const hook of await ctx.call("reflect", "hooks")) {
    if (hook.listeners.length) ctx.log(`${hook.name}: ${hook.listeners.join(", ")}`);
  }
}
```
