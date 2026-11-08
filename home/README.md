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
| [`chapter-5-inspect.js`](chapter-5-inspect.js) | Look inside: how to read any plugin and follow its hooks, above view source ([`/std/view-source.js`](../std/view-source.js)) and the hook tracer ([`/std/hook-tracer.js`](../std/hook-tracer.js)). |
| [`chapter-6-models.js`](chapter-6-models.js) | Ask a model: how a plugin asks a language model without a key, above Ask the page ([`/std/ask-the-page.js`](../std/ask-the-page.js)). The page links Claude, OpenAI and Gemini from [`/std/llm/`](../std/llm/). |
| [`chapter-7-permissions.js`](chapter-7-permissions.js) | What a plugin may do: permissions and the gate. Its own manifest asks only for `ui`, and its buttons ask for more, so you watch the kernel refuse. |
| [`chapter-8-data.js`](chapter-8-data.js) | Your data, and your say: collections, schemas and review. It has `data:write:learning`, so adding a note shows you a review card, and a note that isn't text is refused by the schema. |
| [`chapter-9-views.js`](chapter-9-views.js) | Views are HTML: how plugins draw, and a box whose HTML it draws as written, so you see what the page's allowlist keeps. |
| [`chapter-10-your-app.js`](chapter-10-your-app.js) | An app of your own: what an `app.html` is, the one command that makes a project of your own (`npx github:PaulKinlan/ExtensibleWebApps my-app`, [`/scripts/create-app.mjs`](../scripts/create-app.mjs)), and how to put the app online by itself with `npm run deploy:app`. |

Each chapter's words are in the `.html` file next to it, so a chapter is
edited like any view. The page also links standard plugins from
[`std/`](../std/): the switchboard, reset, the debug console, the plugin
editor, view source, the hook tracer, Ask the page, and three language
models.

**The way back.** A visitor can switch off anything, the switchboard and
reset included. Opening the page with `?reset` turns all of its plugins back
on: the host asks for that when it opens the app, before any plugin runs.
Notes are never touched by a reset.

**What comes next** (in the [design doc](https://claude.ai/artifact/Ujb82vpEx14nh8XQof1gBj)):
x-ray; chapters on permissions, data and UI;
a scrolling story view; the docs inside the page; and the Agent chapter,
where an agent writes new plugins for the page.
