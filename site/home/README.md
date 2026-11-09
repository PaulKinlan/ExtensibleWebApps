# The homepage

The site's front page ([`/index.html`](../index.html)) explains the platform
by being built on it. It is an app like the ones in [`demos/`](../../demos/):
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
| [`chapter-4-make.js`](chapter-4-make.js) | Make your own: how to write a plugin, above the plugin editor ([`/std/plugin-editor.js`](../../std/plugin-editor.js)). |
| [`chapter-5-inspect.js`](chapter-5-inspect.js) | Look inside: how to read any plugin and follow its hooks, above view source ([`/std/view-source.js`](../../std/view-source.js)) and the hook tracer ([`/std/hook-tracer.js`](../../std/hook-tracer.js)). |
| [`chapter-6-models.js`](chapter-6-models.js) | Ask a model: how a plugin asks a language model without a key, above Ask the page ([`/std/ask-the-page.js`](../../std/ask-the-page.js)). The page links Claude, OpenAI and Gemini from [`/std/llm/`](../../std/llm/). |
| [`chapter-7-permissions.js`](chapter-7-permissions.js) | What a plugin may do: permissions and the gate. Its own manifest asks only for `ui`, and its buttons ask for more, so you watch the kernel refuse. |
| [`chapter-8-data.js`](chapter-8-data.js) | Your data, and your say: collections, schemas and review. It has `data:write:learning`, so adding a note shows you a review card, and a note that isn't text is refused by the schema. |
| [`chapter-9-views.js`](chapter-9-views.js) | Views are HTML: how plugins draw, and a box whose HTML it draws as written, so you see what the page's allowlist keeps. |
| [`chapter-10-your-app.js`](chapter-10-your-app.js) | An app of your own: what an `app.html` is, the one command that makes a project of your own (`npm create extensible-app my-app`, which runs [`/scripts/create-app.mjs`](../scripts/create-app.mjs) from GitHub through the small npm package in [`/scripts/create-extensible-app/`](../scripts/create-extensible-app/)), and how to put the app online by itself with `npm run deploy:app`. |
| [`chapter-11-agent.js`](chapter-11-agent.js) | Let an agent change it: the builder agent ([`/std/agents/builder.agent.md`](../../std/agents/builder.agent.md)) writes plugins for you through the chat box ([`/std/agents/chat.js`](../../std/agents/chat.js)) below it, with your key. Without one, it replays a recorded run of the builder; its last step is real, so the code goes through the same review card. |
| [`chapter-12-security.js`](chapter-12-security.js) | A second pair of eyes: before a plugin of yours reaches its review card, the kernel runs `plugins:beforeAdd` with its code, and a checker may stop it. It lists what the check decided, and tries to save a plugin that would send your notes to a server: a real save, which the check stops. |
| [`security-check.js`](security-check.js) | The checker: plain rules on `plugins:beforeAdd`, no model. It stops a plugin that may read your data and reach the internet, and code that builds code from text, and keeps each verdict in its `security-reviews` collection. |
| [`security.agent.md`](security.agent.md) | The same job as an agent: a `check: plugins:beforeAdd` that reads the code with a model, woken only for plugins that ask to reach the internet. Not linked here, since it needs a key; link it beside a model to use it. |
| [`x-ray.js`](x-ray.js) | X-ray: a switch in the header. While it's pressed, the page's own CSS outlines every view and labels it with the plugin that drew it (the host marks each one with `data-plugin`). The plugin only draws its switch, so it needs nothing but `ui`. |
| [`story-view.js`](story-view.js) | Story view: a switch in the header between the guided view and one scrolling story, like an article. The page's CSS reads the switch with `body:has(…)` and lays out the same chapters differently; the choice is kept. |

Each chapter's words are in the `.html` file next to it, so a chapter is
edited like any view. The page also links standard plugins from
[`std/`](../../std/): the switchboard, reset, the debug console, the plugin
editor, view source, the hook tracer, Ask the page, and three language
models.

**The way back.** A visitor can switch off anything, the switchboard and
reset included. Opening the page with `?reset` turns all of its plugins back
on: the host asks for that when it opens the app, before any plugin runs.
Notes are never touched by a reset.

**The docs, in the page.** [`/docs/panel.js`](../../docs/panel.js) puts a
Docs switch in the header that opens the docs in a panel docked beside the
page, drawn from the same Markdown files as [/docs/](../../docs/). It lives
in `docs/` because a view only fetches Markdown from its own folder, so any
app on the site can link it the same way.
