# The layers

Extensible Web Apps is built in layers, and each layer uses only the ones below it. This page says what each layer is, what lives in it today, who chooses what goes in it, and where the line between trusted and sandboxed code runs. It is the map to read before adding anything to the platform: a new piece of code belongs in exactly one layer.

```mermaid
flowchart TB
    Apps["<b>Apps</b><br/>app.html links plugins and agents"]
    Std["<b>std plugins</b><br/>sandboxed, a worker each, and the person's own"]
    Services["<b>Kernel services</b><br/>trusted: agents, llm, bus, email, sync and more"]
    Core["<b>Kernel core</b><br/>trusted: sandbox, gate, hooks, data, review"]
    Cordis["<b>Cordis</b><br/>contexts, fibers, events, services"]
    Apps --> Std
    Std -->|"messages checked by the gate: the sandbox boundary"| Services
    Services --> Core
    Core --> Cordis
```

| Layer | Where it lives | Runs | Chosen by |
| --- | --- | --- | --- |
| Apps | `demos/`, `site/`, your own folder | The page, plus its plugins' workers | The app's author (`app.html`), and the person (Customize) |
| std plugins | [`std/`](../std/) | A sandboxed worker each | Each app, with `<link rel="plugin">` |
| Kernel services | [`src/kernel/services/`](../src/kernel/services/) and beside it, and kernel modules in `std/<name>/module.ts` | Inside the kernel, trusted | Modules: the site, in [`kernel.json`](../kernel.json). The rest: nobody yet, every one is built into every kernel ([being changed](#where-this-is-going)) |
| Kernel core | [`src/kernel/`](../src/kernel/) | Inside the kernel, trusted | Always there |
| Cordis | `node_modules/cordis` ([cordiverse/cordis](https://github.com/cordiverse/cordis)) | Inside the kernel | Pinned in `package.json` |

The shape is close to [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)'s: a small framework (Cordis), a harness on top of it with the services every extension can count on, and extensions that are everything else. Our harness is bigger than Cordis on purpose, because it also runs untrusted code safely, and the rest of this page says exactly what that adds.

## Cordis

[Cordis](https://github.com/cordiverse/cordis) is a small plugin framework. The kernel uses it for:

- **Contexts and fibers.** Every plugin instance is a Cordis fiber, so stopping it disposes every listener it added, all at once ([`remote.ts`](../src/kernel/remote.ts)).
- **Events.** Hooks are Cordis events, dispatched in Cordis's modes: `emit`, `serial`, `bail`, `parallel`, `waterfall`.
- **The dispatch tap.** Cordis reports every dispatch, which is how the trace sees everything ([`trace.ts`](../src/kernel/trace.ts)).

What the kernel does not use yet is Cordis's own way of making services: in Cordis, a service is a plugin that `provide`s a name and other plugins `inject` it. Our services are plain objects the kernel builds, which is why they can't be left out today. Making each kernel service a real Cordis plugin is the first step of the split below.

## The kernel core

The core is what every app and every space server needs to run any plugin at all. Take one piece away and no app works, or a plugin could do something it didn't ask for.

| Piece | Files | What it does |
| --- | --- | --- |
| Where it runs | [`env.ts`](../src/kernel/env.ts), [`browser.ts`](../src/kernel/browser.ts), [`browser-env.ts`](../src/kernel/browser-env.ts) | The same kernel in a shared worker, a dedicated worker or a server ([The kernel](kernel.md#where-it-runs)) |
| Tabs and isolates | [`hosts.ts`](../src/kernel/hosts.ts), [`isolate-host.ts`](../src/kernel/isolate-host.ts) | The open tabs, the spawner tab that starts plugin workers, and its stand-in on a server |
| The sandbox | [`remote.ts`](../src/kernel/remote.ts), [`manifest.ts`](../src/kernel/manifest.ts), [`gate.ts`](../src/kernel/gate.ts), [`hooks.ts`](../src/kernel/hooks.ts) | Plugins in workers, their manifests read before they run, every message checked, hook contracts held |
| Seeing what happened | [`trace.ts`](../src/kernel/trace.ts), [`changes.ts`](../src/kernel/changes.ts) | The trace of every dispatch, and the change log |
| The data | [`store.ts`](../src/kernel/store.ts), [`paths.ts`](../src/kernel/paths.ts), [`records.ts`](../src/kernel/records.ts), [`schema.ts`](../src/kernel/schema.ts) | The data folder, path checks, collections and their schemas |
| Asking the person | [`review.ts`](../src/kernel/review.ts), [`diff.ts`](../src/kernel/diff.ts) | Review cards for writes outside a plugin's own data, with a line diff |
| Keys and the network | [`secrets.ts`](../src/kernel/secrets.ts), [`net.ts`](../src/kernel/net.ts) | Secrets a plugin can use but never read, and the requests made with them |
| Which plugins run | [`apps.ts`](../src/kernel/apps.ts), [`catalog.ts`](../src/kernel/catalog.ts), [`switches.ts`](../src/kernel/switches.ts) | An app's linked plugins, installed plugins, and their on/off switches |
| The person's own plugins | [`user-plugins.ts`](../src/kernel/user-plugins.ts), [`authoring.ts`](../src/kernel/authoring.ts) | Plugins a person (or their agent) adds to an app, and the help to write them |
| Describing itself | [`reference.ts`](../src/kernel/reference.ts) | The [API reference](api.md), built from the tables the kernel enforces |
| Wiring | [`kernel.ts`](../src/kernel/kernel.ts) | Puts the pieces together |
| Kernel modules | [`modules.ts`](../src/kernel/modules.ts), [`kernel-modules.d.ts`](../src/kernel/kernel-modules.d.ts) | Runs the modules the site lists in `kernel.json` (below) |
| Services plugins provide | [`provided.ts`](../src/kernel/provided.ts) | Passes calls to a service a sandboxed plugin provides on to that plugin (below) |

And the services every plugin relies on: `kernel`, `settings`, `plugins`, `storage`, `files`, `data`, `secrets`, `net` and `hooks`. Most are made beside the module they belong to; four are a file each, which [`services/index.ts`](../src/kernel/services/index.ts) finds by name: [`services/files.ts`](../src/kernel/services/files.ts), [`services/hooks.ts`](../src/kernel/services/hooks.ts), [`services/kernel.ts`](../src/kernel/services/kernel.ts) and [`services/storage.ts`](../src/kernel/services/storage.ts).

## Kernel services

These are capabilities with trusted code in the kernel: an app may use them, but not every app does. Most are still a file in [`src/kernel/services/`](../src/kernel/services/) (some with helpers beside it), and **each of those is built into every kernel**, in the browser and on a server, whether an app uses it or not, and nobody can leave one out. Each is also made when the kernel starts, not when first called: most only define their hooks then, but some start work of their own. `schedule` reads its saved jobs and sets their timers, and `sync` listens for this device's changes. A site that leaves a service out will skip that start-up work as well.

| Service | Files | Why it is trusted code |
| --- | --- | --- |
| `agents` | [`services/agents.ts`](../src/kernel/services/agents.ts), [`agents/file.ts`](../src/kernel/agents/file.ts), [`agents/runner.js`](../src/kernel/agents/runner.js) | Counts each agent's runs and tokens, so an agent can't misreport its own use |
| `tools` | [`services/tools.ts`](../src/kernel/services/tools.ts) | Reads the whole API reference to offer tools to a model |
| `bus` | [`services/bus.ts`](../src/kernel/services/bus.ts) | Inboxes between agents, plugins and the person |
| `llm` | [`services/llm.ts`](../src/kernel/services/llm.ts) | The one interface to every model; the vendors are std plugins ([`std/llm/`](../std/llm/)) |
| `transfer` | [`services/transfer.ts`](../src/kernel/services/transfer.ts), [`csv.ts`](../src/kernel/csv.ts) | Import and export, reviewed once for the whole file |
| `email` | [`services/email.ts`](../src/kernel/services/email.ts), [`address.ts`](../src/kernel/address.ts) | Mail from a space's server to its members, with daily limits |
| `schedule` | [`services/schedule.ts`](../src/kernel/services/schedule.ts) | Wakes plugins that aren't running |
| `history` | [`services/history.ts`](../src/kernel/services/history.ts) | Undo across every plugin's writes |
| `commands` | [`services/commands.ts`](../src/kernel/services/commands.ts) | Commands from any plugin, run from a palette or a key |
| `router`, `share`, `audio`, `page` | [`services/router.ts`](../src/kernel/services/router.ts), [`services/share.ts`](../src/kernel/services/share.ts), [`services/audio.ts`](../src/kernel/services/audio.ts), [`services/page.ts`](../src/kernel/services/page.ts) | Bridges to what only a page can do |
| `reflect` | [`services/reflect.ts`](../src/kernel/services/reflect.ts) | A read-only view of the whole kernel, for debuggers |
| spaces | [`sync.ts`](../src/kernel/sync.ts), [`sync-device.ts`](../src/kernel/sync-device.ts), [`server-apps.ts`](../src/kernel/server-apps.ts), [`routes.ts`](../src/kernel/routes.ts), [`services/sync.ts`](../src/kernel/services/sync.ts) | Sync with a space, plugins on its server, public routes |

### Kernel modules

The first services have moved out of the core into **kernel modules**. A module is a Cordis plugin in `std/<name>/module.ts`, and the site lists the ones it runs in [`kernel.json`](../kernel.json), one per line:

```json
{
  "modules": [
    "debug"
  ]
}
```

Only the listed modules are built into the kernel, in the browser and on the site's servers ([`vite.kernel-modules.ts`](../vite.kernel-modules.ts)). A name with no `module.ts` stops the build, and a module that `uses` another the site doesn't list stops the kernel: neither quietly goes without. [`src/kernel/modules.ts`](../src/kernel/modules.ts) says how to write one.

| Module | File | What it adds |
| --- | --- | --- |
| `debug` | [`std/debug/module.ts`](../std/debug/module.ts) | The `debug` service (the trace, for developer tools such as the debug console), and the `bench` and `reload-test` commands the tests run |

### Saying which services a plugin needs

A plugin's manifest lists the services it calls that not every site runs, so the plugin fails when it starts, with a message naming what is missing, rather than on its first call:

```js
export const manifest = {
  id: "palette",
  name: "Command palette",
  permissions: ["ui", "commands"],
  services: ["commands"],
};
```

The kernel's own services (`data`, `storage`, `settings` and the rest above) are always there and needn't be listed. The standard plugins list theirs, and so does every agent, which needs `agents`, `bus` and `tools`.

### Where this is going

The plan, being reviewed now, splits this layer out of the core:

1. Each of the services above becomes a kernel module, as `debug` has, naming the modules it `uses` (agents uses `llm`, `tools` and `bus`). This repo's `kernel.json` lists them all, so no demo changes.
2. A smaller site lists fewer, and has less built in.
3. Services that don't need trusted code become std plugins that provide them (below), such as email delivery.

[`tests/checks/kernel-layers.mjs`](../tests/checks/kernel-layers.mjs) keeps the lists on this page honest: it fails when a file in `src/kernel/` is on neither the core list nor the services list, so a new file has to say which layer it is in.

## Plugins that provide services

A sandboxed plugin can provide a service, as a Cordis plugin can. A std plugin, a person's own plugin, or one their agent wrote can add a service the site didn't build in, and other plugins call it like any other:

```js
export const manifest = {
  id: "mailer",
  name: "Mailer",
  permissions: ["provide:mail", "network:api.example.com"],
  provides: {
    mail: {
      description: "Sends mail.",
      methods: {
        send: {
          args: "({ to, subject, text })",
          returns: "{ id }",
          description: "Sends one message.",
          // Optional: the arguments, in the collections' schema subset, so the tools service offers the method to agents.
          params: [{ name: "message", schema: { type: "object", required: ["to"], properties: { to: { type: "string" }, subject: { type: "string" }, text: { type: "string" } } } }],
        },
      },
    },
  },
};

export default (ctx) =>
  ctx.provide("mail", {
    send: async ({ to, subject, text }, { caller }) => ({ id: "…" }),
  });
```

- A plugin with the permission `mail` calls it: `await ctx.call("mail", "send", { to, subject, text })`. A method's `needs` can ask for a different permission.
- Each call goes to the provider through a hook named after it, so no other plugin can answer in its place. The provider hears which plugin called, and what it throws fails the call ([`provided.ts`](../src/kernel/provided.ts)).
- Its methods go into the [API reference](api.md). A method whose manifest entry has `params` is also offered by the `tools` service, so an agent can call it.
- A name the kernel, a kernel module or another plugin already has is refused, never shadowed. Plugins that list the service in `services` and open in the same app as its provider (or start from the same data folder, or on the same space server) wait for it to start. If the provider is then refused, they are stopped too, saying which service is missing.
- It runs in its own worker like any plugin, so providing a service gives it no rights beyond its own manifest.

The site's [plugin registry](guide/plugin-registry.md) (`/packages/`) is where such plugins are offered: a person adds one to any app from Customize, with whatever provides the services it needs.

## std plugins

[Standard plugins](plugins.md) are ordinary sandboxed plugins: a JavaScript file each, in its own worker, held to its manifest, linked by an app that wants it. They can only do what the layers below let them. Anything a person or their agent writes is in this layer too, and has exactly the same powers as a std plugin.

## Apps

An app is a folder with an `app.html` that links its plugins (`<link rel="plugin">`) and agents (`<link rel="agent">`). The person using it can add their own plugins to it through Customize, and switch any of its plugins off. [How an app works](guide/how-an-app-works.md) starts there.

## The trust line

The one boundary that matters for safety runs between std plugins and the kernel. Below it, code runs unsandboxed inside the kernel, so whoever deploys the site chooses it. Above it, code runs in a worker that can reach nothing its manifest didn't ask for: no network unless it asks for `network` (and then only through a separate runtime, which [the security model](security.md) describes), no data but its own unless it is granted more, and no other plugin's worker. So anyone can add it: the app's author, the person, or an agent working for them. [The security model](security.md) has the details.

## Outside the kernel

Some of the platform isn't in any of these layers, because it never runs in the kernel:

- **The host** ([`src/host/`](../src/host/)): the code in each page that draws views and passes the person's actions on.
- **The service worker** ([`sw/`](../sw/)): serves app folders and screens, and plugin routes.
- **The `ui-*` elements** ([`elements/`](../elements/)): custom elements a page loads only if it uses them.
- **The servers** ([`src/server/`](../src/server/)): the front door for spaces, including sign-in ([`src/server/auth/`](../src/server/auth/)), which decides who may reach a space's plugins at all, so it can't be a plugin. Which sign-in providers a server offers is configuration ([Servers and spaces](server.md)).
