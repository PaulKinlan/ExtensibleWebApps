# create-extensible-app

Make a customizable web app of your own on [Extensible Web Apps](https://extensibleweb.app/):

```sh
npm create extensible-app packing-list
cd packing-list
npm run dev        # then open http://localhost:5173/
```

That makes `packing-list/`, a project that is just your app: `app.html`, `main.js` and its template from the starter at the top, and a `package.json` with the platform as a dependency, which it installs. `npm run dev` serves the app at `/`, `npm run check` finds its mistakes, and `npm run deploy` puts it on a Cloudflare Worker of its own, at `/` too. `--name "Packing list"` sets its title, and `--no-install` only writes the files. See [An app of your own](https://extensibleweb.app/docs/guide/your-own-app).

This package is a small wrapper. It runs the platform's own [`scripts/create-app.mjs`](https://github.com/PaulKinlan/ExtensibleWebApps/blob/main/scripts/create-app.mjs) from the newest [`extensible-web-apps`](https://www.npmjs.com/package/extensible-web-apps) on npm, so every project starts from the newest starter, and this package doesn't need a new version when the platform changes. (In the repo, where it isn't published yet, it runs it from GitHub instead, the same as `npx github:PaulKinlan/ExtensibleWebApps packing-list`: `config.platform` in `package.json` says which.)

## Publishing

The repo's "Publish to npm" workflow ([`publish-npm.yml`](https://github.com/PaulKinlan/ExtensibleWebApps/blob/main/.github/workflows/publish-npm.yml)) publishes this package and the platform together, at one version, after checking a project made from the two packed packages. It needs one repository secret, `NPM_TOKEN`. Nothing here is published by hand.
