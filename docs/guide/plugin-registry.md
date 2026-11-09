# The plugin registry

The site's plugin registry is a folder of plugins no app links: [`packages/`](../../packages/), served at `/packages/`. A person adds any of them to any app from Customize, as they would a plugin of their own. Plugins in it can provide services, so a person can get a capability the site didn't build in without any trusted code loading at run time.

`/packages/` is also a page listing **every plugin this site ships**, not only the ones in the registry: the plugins anyone can add to any app, the services built into the site, the standard plugins and agents app authors link, and every demo's own plugins and samples, each with what it does, what it asks for (in words), where it draws, which apps link it, and its address and link tag to copy. It has a search and filters, so a person can find "a language model" or everything that reads `data:read:library`.

Plugins are sorted under three headings by what they do, read from their manifests, and Customize uses the same three:

| Heading | `kind` | A plugin goes here when |
| --- | --- | --- |
| **Services** | `service` | it provides a service other plugins use: a `provides` entry, or a `provide:<name>` permission (Clock, the language models) |
| **On the page** | `ui` | it draws: the `ui` permission, or a `ui:` one |
| **Behind the scenes** | `background` | neither |

Services **built into the site** (the kernel modules in `kernel.json`) are listed apart: every app has them, and a person can't add or remove them. Some, such as `llm`, are answered by a plugin a person adds (one of the language models), and a plugin that needs one says so in the index (`needsOneOf`).

The registry offers the general-purpose [standard plugins](../plugins.md) too: Undo, Import and export, Debug console, View source, Hook tracer, Switchboard, Reset, Ask the page, Board, Sync, the plugin editor, and the four language models in `std/llm/`. They stay in `std/`, where apps link them; [`packages/std.json`](../../packages/std.json) lists the ones offered (a path under `std/`, without `.js`, such as `llm/anthropic`), and [`packages/groups.json`](../../packages/groups.json) puts each offered plugin under a sub-heading ("Language models", "Looking inside"). Each that draws says in its manifest where it draws on a page with no slot for it (`places`, appending to `main`), and lists its template in `files` so it is copied with it. The plugin editor's starting templates sit in a folder beside it, and come with it, since `files` may name paths into folders beside a plugin (`plugin-editor.templates/card.js`). Customize itself isn't offered: the host adds it to every app. Plugins that only work with one app's hooks, such as the Markdown editor's, stay with that app, and the page lists them under it.

## What a person sees

Customize lists the registry under **Add a plugin**, at the top of its panel: each plugin's name, what it does and what it asks for. **Add** puts it with the person's own plugins for that app, switched off, as with any plugin they add. If it needs a service another plugin in the registry provides, that plugin is added too, and Customize says so before they click.

Try it: open any demo, open Customize, and add **World clock**. It needs the `clock` service, so **Clock** comes with it. Turn World clock on, and Clock comes on with it, since it provides what World clock needs: a strip of clocks appears at the foot of the page. Turn Clock off and World clock goes off too. Nothing here asks the app's author, or the site's `kernel.json`, for anything ([The layers](../layers.md#when-a-persons-plugin-needs-a-service)).

## A package

A package is a folder `packages/<id>/` holding `<id>.js`, a plugin whose manifest `id` is the folder's name, and the files its manifest lists:

```
packages/
  index.json              the list Customize shows, made by npm run packages
  catalog.json            every plugin, agent and built-in service the site ships, made with it
  index.html              the page at /packages/, made with it (registry.js and registry.css are its search and styles)
  std.json                the standard plugins the registry offers
  groups.json             the sub-heading each offered plugin sits under
  clock/clock.js          provides the clock service
  world-clock/
    world-clock.js        needs clock, draws in a place
    world-clock.html      its templates
```

[`clock.js`](../../packages/clock/clock.js) provides a service (`provides`, `ctx.provide`), and [`world-clock.js`](../../packages/world-clock/world-clock.js) says it needs it (`services: ["clock"]`). [The layers](../layers.md#plugins-that-provide-services) explains both fields.

## Adding a package

1. Make the folder, with the plugin and its files.
2. Put its id under a group in `packages/groups.json`.
3. Run `npm run packages`, which reads every manifest and rewrites `packages/index.json`, `packages/catalog.json` and the page `packages/index.html`. The tests fail if any is out of date, or an offered plugin has no group. To offer a standard plugin instead, add its path to `packages/std.json`; if it draws, its manifest needs `places`, and `files` for its templates.
4. Check it in Customize on any demo.

A registry plugin is an ordinary sandboxed plugin. It runs in its own worker, can do only what its manifest asks for, and the person sees what that is before they turn it on.

## Limits for now

- Customize adds a plugin only from the site it is on, so the registry is the site's own `/packages/`. An app deployed on its own address ([Deploying one app](deploying-an-app.md)) has its own copy, if it was deployed with one.
- There is no versioning yet. Adding a package again replaces the person's copy, and it starts switched off again.
