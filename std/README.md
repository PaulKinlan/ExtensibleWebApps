# Standard plugins

Plugins any app can link from its `app.html`. Each is one file, run as
written, and asks only for the permissions in its manifest.

| Plugin | What it does | Add it with |
| --- | --- | --- |
| [`debug-console.js`](debug-console.js) | A bug button in a corner of the page. It counts problems (errors, refused permissions, failed calls) and opens a log of them, or of everything the kernel traced, with a Copy button that puts the log on the clipboard, headed with the page's address, browser and time, ready for a bug report. | `<link rel="plugin" href="/std/debug-console.js">` in the head, and `<slot name="debug"></slot>` anywhere in the body |

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
