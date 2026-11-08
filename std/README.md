# Standard plugins

Plugins any app can link from its `app.html`. Each is one file, run as
written, and asks only for the permissions in its manifest.

| Plugin | What it does | Add it with |
| --- | --- | --- |
| [`debug-console.js`](debug-console.js) | A bug button in a corner of the page. It counts problems (errors, refused permissions, failed calls) and opens a log of them, or of everything the kernel traced, with a Copy button that puts the log on the clipboard, headed with the page's address, browser and time, ready for a bug report. | `<link rel="plugin" href="/std/debug-console.js">` in the head, and `<slot name="debug"></slot>` anywhere in the body |
| [`plugin-editor.js`](plugin-editor.js) | An editor for the person's own plugins: start from a template in [`plugin-editor/templates/`](plugin-editor/templates/) or a copy of a plugin on the page, see what it asks for in plain words, then save and run it after a review card that shows its code. Its logs and errors show beside it. | `<link rel="plugin" href="/std/plugin-editor.js">` in the head, and `<slot name="editor"></slot>` in the body |
| [`reset.js`](reset.js) | When any of the app's plugins is off, a card that names them and turns them all back on. If it is switched off itself, opening the page with `?reset` does the same. | `<link rel="plugin" href="/std/reset.js">` in the head, and `<slot name="switchboard"></slot>` in the body |
| [`switchboard.js`](switchboard.js) | A switch for each plugin the app links, with its name and description, so people can see what the page is made of and turn parts of it off. | `<link rel="plugin" href="/std/switchboard.js">` in the head, and `<slot name="switchboard"></slot>` in the body |

## The debug console

- **What it reads.** The kernel's trace, through the `debug` service and the
  `debug:trace` hook. Both need `debug:read`, since the trace names every
  plugin and what it did.
- **Where errors come from.** Plugins' own errors, refused permissions and
  failed calls are traced by the kernel. Errors in a plugin's worker that
  nothing caught are logged as that plugin's. Problems in the page, such as a
  plugin file or template that didn't load or an uncaught exception, are
  reported to the kernel by the host.
- **Only this app.** The kernel is shared by every open tab, so by default the
  console shows only the plugins this app links, this tab's page and the
  kernel itself. Untick "Only this app" to see everything.
- **Where the bug sits.** Its `corner` setting: `bottom-left` (the default),
  `bottom-right`, `top-left`, `top-right`, or `inline` to sit wherever the
  app put `<slot name="debug">`.
- **The element.** The bug and its panel are
  [`<ui-debug>`](../elements/ui-debug.html). The plugin only decides what goes
  in the panel, so another debug plugin can reuse it.

## The switchboard and reset

- **What they use.** The `plugins` service: `plugins.app()` lists the plugins
  the app links (`plugins:read`), and `plugins.setEnabled(id, on)` switches
  one (`plugins:manage`). Both reach only plugins in the caller's own app, so
  both plugins are tab-scoped. They hear `plugins:changed` to stay current.
- **Switching is saved.** It is the same switch as the workbench's plugins
  panel: it is kept with the data, and it applies in every tab.
- **The way back.** Both can be switched off like anything else. The host
  handles `?reset` in the page's address before any plugin runs, turning the
  app's plugins back on, so a page can always be recovered.

## The plugin editor

[`plugin-editor.js`](plugin-editor.js) uses the kernel's `authoring` service
([`src/kernel/authoring.ts`](../src/kernel/authoring.ts)), which needs
`plugins:author`. The service reads the code of the app's plugins and the
templates next to the editor, checks a draft's manifest without running it,
and saves the draft with the person's own plugins for the app (the same ones
the Customize panel lists). Every save and removal waits for the person to
accept a review card that shows the code and what it asks for.

Until a person's plugin can stand in for one of the app's own, a copy gets
an id of its own (`note-stats-copy`) and runs beside the original. Switch the
original off on the switchboard to try the copy instead.

The templates are plain plugins: [`card.js`](plugin-editor/templates/card.js)
draws, [`listen.js`](plugin-editor/templates/listen.js) shows the latest note by hearing a hook,
[`block.js`](plugin-editor/templates/block.js) stops a write, and
[`button.js`](plugin-editor/templates/button.js) writes data it doesn't own,
which the person reviews. They use the homepage's `learning` notes; on
another page, change the collection to one it has.
