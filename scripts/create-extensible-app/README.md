# create-extensible-app

Make a customizable web app of your own on [Extensible Web Apps](https://extensibleweb.app/):

```sh
npm create extensible-app packing-list
cd packing-list
npm run dev        # then open http://localhost:5173/demos/packing-list/
```

That makes `packing-list/`, a copy of the whole platform, installs it, and makes your app in `demos/packing-list/` from the starter. `--name "Packing list"` sets its title, and `--no-install` only copies. To put the app online by itself, see [Deploying one app on its own](https://extensibleweb.app/docs/guide/deploying-an-app).

This package is a small wrapper. It runs the repo's own [`scripts/create-app.mjs`](https://github.com/PaulKinlan/ExtensibleWebApps/blob/main/scripts/create-app.mjs) from GitHub, the same as `npx github:PaulKinlan/ExtensibleWebApps packing-list`, so every project starts from the platform as it is on `main`, and the package doesn't need a new version when the platform changes.

## Publishing

From this folder: `npm publish`. Bump `version` only when `index.mjs` changes.
