# Plugin registry

Plugins this site offers that no app links. A person adds any of them to any app from Customize, along with the plugins that provide the services it needs. Each folder is one package: `<id>/<id>.js` and the files its manifest lists. [`index.json`](index.json) is the list Customize shows; `npm run packages` rewrites it.

| Package | What it shows |
| --- | --- |
| [`clock/`](clock/) | A plugin that provides a service (`clock`), which no site builds in |
| [`world-clock/`](world-clock/) | A plugin that needs that service, and draws in a place on any app |

See [the plugin registry](../docs/guide/plugin-registry.md).
