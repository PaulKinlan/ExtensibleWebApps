# An app of your own

A project of your own is one app, in a folder of its own, with the platform as a dependency. Its files are at the top of the folder and it is served at `/`, on your machine and when it's deployed. You don't need a checkout of this repo, and you don't copy the platform.

## Make one

You need [Node.js](https://nodejs.org/) 22.18 or later.

```sh
npm create extensible-app packing-list
cd packing-list
npm run dev        # http://localhost:5173/
```

The first line makes `packing-list/` and installs the platform into it. (`npx github:PaulKinlan/ExtensibleWebApps packing-list` does the same without the small `create-extensible-app` package.) `--name "Packing list"` sets the app's title, and `--no-install` writes the files and installs nothing.

```
packing-list/
  package.json   depends on the platform; npm run dev, check and deploy
  app.html       the app's page: loads the platform, lays out slots, lists its plugins
  main.js        its first plugin, a list you can add to and tick off
  main.html      that plugin's template
  README.md
  .gitignore     node_modules/ and .extensible/
```

That is the whole project. Add plugins beside `main.js` (or in a folder, such as `plugins/`) and link each from `app.html` with a `<link rel="plugin">`. [How an app works](how-an-app-works.md) and [Writing a plugin](writing-a-plugin.md) take it from there; every page of this guide applies to a project as it does to the demos here.

## Its commands

Each runs the platform's `extensible-app` command ([`scripts/extensible-app.mjs`](../../scripts/extensible-app.mjs)) in the project's folder.

| Command | What it does |
| --- | --- |
| `npm run dev` | Serves the app at http://localhost:5173/, with the spaces server (sign-in, spaces, server plugins). `-- --port 8080` picks another port. Change a file and reload. |
| `npm run check` | Finds the app's mistakes without a browser: permissions, manifests, templates, slots. The same checks as `npm run check` in this repo. `-- --json` for tools. |
| `npm run deploy` | Puts the app on a Cloudflare Worker of its own, at `https://<name>.<your subdomain>.workers.dev/`. Run `npx wrangler login` once first. `-- --name other-name` picks the Worker's name (the project's name otherwise), `-- --dev` runs the same Worker on this machine, and `-- --no-deploy` only writes it. |

## What gets served

One site: the platform's built files at their usual addresses (`/platform/`, `/std/`, `/elements/`, `/sw.js`, `/account/` and the rest), and the project's files at the root beside them. `app.html` is also the front page, so `/` is the app. A screen of the app, such as `/book/42`, opens the app too (the service worker answers it with `app.html`, as for an app in a folder: [Routes and the service worker](routes.md)).

None of this repo's own pages come with it: no homepage, demos, docs or workbench. The standard plugins do, so `app.html` can link `/std/debug-console.js` or any other.

A file or folder at the top of the project can't have the name of one of the platform's (`platform`, `std`, `elements`, `sw`, `account` and the others): the command stops and says which. `package.json`, `package-lock.json`, `node_modules/` and anything starting with a dot are never served.

`npm run dev` and `npm run deploy` lay the site out in `.extensible/`, which is never committed: `dev` links to the files, so a change shows at once, and `deploy` copies them. Spaces and accounts made on your machine are kept in `.extensible/spaces/`.

## The platform, as a dependency

`package.json` names the platform as `"extensible-web-apps": "github:PaulKinlan/ExtensibleWebApps"`. Installing it from GitHub builds it (its `prepare` script, which also runs on `npm install` in a checkout of the repo and takes a few seconds), so the first `npm install` takes a minute; running `npm install github:PaulKinlan/ExtensibleWebApps` again brings the newer `main`. Once the platform is published to npm, the dependency becomes a version, installs without building, and `npm update` brings new ones. To try a project against a checkout of the platform, install that instead: `npm install ../ExtensibleWebApps` (built there first with `npm run build && npm run build:server`), or make the project with `--platform file:../ExtensibleWebApps`.

The site's own choices that are built into the platform, such as which kernel modules it runs ([The layers](../layers.md)), are the platform's defaults in a project.

## The repo's own demos

Inside this repo, apps still live in [`demos/`](../../demos/), served at `/demos/<name>/`, and `npm run new-app -- my-app` still makes one there. That is for working on the platform itself and its demos; [Deploying one app on its own](deploying-an-app.md) puts one of those on a Worker of its own.
