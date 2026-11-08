# site/

This website's own pages, at https://extensibleweb.app/. None of it is part of the platform: an app never loads anything from here, and an app deployed on its own (`npm run deploy:app`) leaves all of it out.

Everything in this folder is served at the site's root, as if it were at the top of the repo: `site/home/` is `/home/`, and `site/index.html` is `/`.

| Here | At | What it is |
| --- | --- | --- |
| [`index.html`](index.html) | `/` | The front page: an app that explains the platform, built from the chapters in `home/` |
| [`home/`](home/README.md) | `/home/` | The front page's chapters, one plugin each, and its learning notes |
| [`workbench/`](workbench/index.html) | `/workbench/` | The workbench: every plugin's views, the plugins panel, the trace and the benchmarks, for working on the platform itself |
| [`workbench/plugins/`](workbench/plugins/) | `/workbench/plugins/` | The demo and test plugins the workbench links: the Markdown editor's `word-count.js` and `edit-times.js` copied unchanged, the notes app, change review (`tidy.js`), audio (`tone.js`), canvas (`bars.js`), and plugins that try to break the security rules |

The other parts of the site live where people look for them: the demo apps in [`demos/`](../demos/README.md), and the docs in [`docs/`](../docs/README.md), which `/docs/` draws.
