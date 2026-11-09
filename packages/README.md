# Plugin registry

Plugins this site offers that no app links. A person adds any of them to any app from Customize, along with the plugins that provide the services it needs. Each folder is one package: `<id>/<id>.js` and the files its manifest lists. [`index.json`](index.json) is the list Customize shows, and [`index.html`](index.html) is the page at `/packages/`; `npm run packages` rewrites both. [`std.json`](std.json) names the standard plugins (in `std/`) the registry offers too.

| Package | What it shows |
| --- | --- |
| [`clock/`](clock/) | A plugin that provides a service (`clock`), which no site builds in |
| [`world-clock/`](world-clock/) | A plugin that needs that service, and draws in a place on any app |

See [the plugin registry](../docs/guide/plugin-registry.md).
