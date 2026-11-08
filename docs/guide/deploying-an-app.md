# Deploying one app on its own

The main site serves every demo from one Worker. Any single app can also go out as a Worker of its own, on its own address, carrying the whole platform with it: the host, the kernel, the standard plugins, the service worker, and the server side (spaces, accounts, server plugins).

## The steps

From a checkout of this repo, with `npm ci` done:

```sh
npx wrangler login                          # once per machine: opens Cloudflare in a browser
npm run new-app -- packing-list             # make the app (skip this to deploy a demo that exists)
npm run deploy:app -- demos/packing-list    # build, lay out, deploy
```

That is two commands for each new app, and one more the first time on a machine. The last one prints the address, `https://packing-list.<your subdomain>.workers.dev/`, which goes straight to the app.

To try it on this machine first, with no account, add `--dev`: it runs `wrangler dev` on the same files. `--name` picks a different Worker name (and so address), and `--no-deploy` only writes the files.

## What it does

[`scripts/deploy-app.mjs`](../../scripts/deploy-app.mjs) builds the site (`npm run build`), then writes `.build/apps/<name>/`:

- `site/`, what the Worker serves: the built site without the site's own pages (`demos/`, `docs/`, `home/`, `workbench/`, `starter/`, the front page), the app's folder at the same path it has here, any folder its `app.html` links with `../` (the security demo uses the reading list's `library.js`), and an `index.html` that sends `/` to the app.
- `wrangler.jsonc`, the root [`wrangler.jsonc`](../../wrangler.jsonc) with the app's name and `site/` as its assets. It runs the same Worker code, with the same Durable Objects and Dynamic Workers, so an app's spaces and server plugins work as they do on the main site.

Then it runs `npx wrangler deploy -c .build/apps/<name>/wrangler.jsonc`.

The app keeps its path, so the packing list lives at `/demos/packing-list/`, and nothing in it is rewritten. It warns when `app.html` links to a page the Worker won't have, such as a demo's header links to `/docs/`.

## Deploying on every push instead

The main site deploys through Cloudflare's Git integration. An app's Worker can too, if the app is committed to the repo. In the Cloudflare dashboard, create a Worker from this repository, name it after the app, and set:

| Setting | Value |
| --- | --- |
| Build command | `npm run deploy:app -- demos/packing-list --no-deploy` |
| Deploy command | `npx wrangler deploy -c .build/apps/packing-list/wrangler.jsonc` |
| Non-production branch deploy command | `npx wrangler preview -c .build/apps/packing-list/wrangler.jsonc` |

The Worker's name in the dashboard must match the name in the config: the app's folder name, or `--name` in the build command.

## One origin, one world

Each Worker is its own origin, and the browser and the platform keep origins apart:

- **Data on the device.** The service worker, the kernel in its shared worker, and the browser's storage belong to the origin. Nothing someone saved in the reading list on the main site appears in its own Worker.
- **Accounts and passkeys.** A passkey is bound to the host name, and each Worker has its own `Accounts` Durable Object, so people sign up again on each app's address.
- **Spaces.** Each Worker has its own `Space` Durable Objects, so a space named `home` on one is a different space on another. A space's WebSocket only takes clients from its own origin (`src/server/cloudflare/worker.ts`), so an app on one address can't join a space on another.
- **Server plugins.** A space starts only the plugins of apps its own Worker serves, so only this app's.
- **Sign in with GitHub, or another provider.** The callback URL is on the app's host, so each Worker needs its own OAuth app and its own `AUTH_PROVIDERS` var and secret ([Servers](../server.md)).
- **A person's own plugins** can only be added from the app's own origin. The standard plugins are copied into every Worker, so they're there.
