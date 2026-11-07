# The homepage

The site's front page ([`/index.html`](../index.html)) explains the platform
by being built on it. It is an app like the ones in [`demos/`](../demos/):
a plain page with `<slot>` elements, and plugins listed with
`<link rel="plugin">`. Every part of it is a plugin, including the chapters
you read, so switching a plugin off takes that part away. With everything
off, what's left is the page's own HTML and the kernel.

| File | What it is |
| --- | --- |
| [`learning-notes.js`](learning-notes.js) | Owns the `learning` collection: notes the visitor keeps as they go, kept in their browser. The playground the chapters act on. |
| [`note-stats.js`](note-stats.js) | Reads the notes (`data:read:learning`) and counts them. It doesn't own them, and the two plugins never call each other. |
| [`quiet-please.js`](quiet-please.js) | Listens on `data:beforeWrite:learning` and stops a note written all in capitals. |
| [`chapter-1-core.js`](chapter-1-core.js) | A tiny core. Can turn every plugin on the page off. |
| [`chapter-2-plugins.js`](chapter-2-plugins.js) | Everything is a plugin, with a switch for Note stats. |
| [`chapter-3-hooks.js`](chapter-3-hooks.js) | Hooks, with a switch for Quiet please. |
| [`chapter-4-make.js`](chapter-4-make.js) | Make your own: how to write a plugin, above the plugin editor ([`/std/plugin-editor.js`](../std/plugin-editor.js)). |

Each chapter's words are in the `.html` file next to it, so a chapter is
edited like any view. The page also links four standard plugins from
[`std/`](../std/): the switchboard, reset, the debug console and the plugin editor.

**The way back.** A visitor can switch off anything, the switchboard and
reset included. Opening the page with `?reset` turns all of its plugins back
on: the host asks for that when it opens the app, before any plugin runs.
Notes are never touched by a reset.

**What comes next** (in the [design doc](https://claude.ai/artifact/Ujb82vpEx14nh8XQof1gBj)):
view source, x-ray and a hook tracer; chapters on permissions, data and UI;
a scrolling story view; the docs inside the page; and the LLM and Agent
chapters, where a visitor's own key lets an agent answer questions about the
page and write new plugins for it.
