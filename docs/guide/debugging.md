# Debugging an app

Everything an app does goes through the kernel, so the kernel can tell you about all of it: which plugins are running, what each one asked for and was given, which hooks exist and who listens to them, what happens as it happens, and which worker runs where. The platform gives you five ways to look, from inside an app to outside all of them.

| Tool | Where | What it shows |
| --- | --- | --- |
| Debug console, [`std/debug-console.js`](../../std/debug-console.js) | A bug button inside one app | That app's errors, refused permissions and trace, ready to copy into a bug report. |
| Hook tracer, [`std/hook-tracer.js`](../../std/hook-tracer.js) | Inside one app | Each action as a list of steps: the hooks it ran, in order, and what every listener said. |
| View source, [`std/view-source.js`](../../std/view-source.js) | Inside one app | Each plugin's code, and what its permissions mean in words. |
| Inspect mode | Any app, from Customize | Which plugin drew the part of the page you point at; hide it or add to it. |
| [The debugger](../../demos/debugger/app.html) | An app of its own | Every tab and app open on the site, and for each: plugins, manifests, permissions asked for, granted and refused, hooks and listeners, events, workers. |

## The debugger

Open [`/demos/debugger/`](../../demos/debugger/app.html) in one tab and the app you are working on in another. Every tab on a site talks to the same kernel, so the debugger sees the other app's plugins as they run. Pick the app's tab and every panel follows it:

- **Plugins**: each plugin's manifest; the permissions it **asks for**; what the gate **also grants** (an editor permission's mapping, or one implied by another, such as `data:read:books` letting it hear `data:changed:books`); what it tried and was **refused**, because its manifest doesn't ask for it; the places the person said it may **always** change; which secrets it may use and whether they are set; the hooks it defines and listens to; its routes, commands and workers; and its code.
- **Hooks**: every hook, from the kernel, from a plugin's manifest `hooks` (named `<plugin>:<key>`), or from a collection (`data:changed:<c>`, `data:beforeWrite:<c>`). For each: its mode and time limit, the capability listening needs, who listens now, and how often it fired. A plugin can listen to a hook before the plugin that defines it is installed: such a hook shows as **waiting**.
- **Events**: the trace, as it happens. Filter it by kind or text, pause it, or pick an event's trace id to follow one action through every worker it touched.
- **Workers**: every plugin worker, by the tab that started it. Shared plugins run once, in the spawner tab; tab plugins run once per tab whose app links them.

It sees the kernel of the address it is opened at: open it at `/s/<space>/demos/debugger/` to look at a space's kernel in this browser. It can't yet see a space's kernel on the server, where server plugins run; their routes, jobs and errors aren't in its panels.

The debugger is five plugins in [`demos/debugger/`](../../demos/debugger/), one per panel. The panels agree on which tab to look at through the bus topic `debugger-focus`. Take one out, or add your own panel, as with any app.

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
