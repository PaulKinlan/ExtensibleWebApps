# Plugin registry

Plugins this site offers that no app links. A person adds any of them to any app from Customize, along with the plugins that provide the services it needs. Each folder is one package: `<id>/<id>.js` and the files its manifest lists. [`std.json`](std.json) names the standard plugins (in `std/`) the registry offers too, and [`groups.json`](groups.json) the sub-heading each sits under.

The site makes three files from the plugins' manifests as it serves and builds ([`scripts/generated.mjs`](../scripts/generated.mjs)): `index.json`, the list Customize shows; `catalog.json`, every plugin, agent and built-in service the site ships, with the apps that link each; and `index.html`, the page at `/packages/` that lists them all, with [`registry.js`](registry.js) for its search and [`registry.css`](registry.css). They aren't in the repo, so pull requests that each add a plugin never conflict over them: see them at `/packages/` with `npm run dev`, or in `dist/packages/` after `npm run build`.

| Package | What it shows |
| --- | --- |
| [`clock/`](clock/) | A plugin that provides a service (`clock`), which no site builds in |
| [`world-clock/`](world-clock/) | A plugin that needs that service, and draws in a place on any app |

See [the plugin registry](../docs/guide/plugin-registry.md).
