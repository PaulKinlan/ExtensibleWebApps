# Standard plugins

Plugins any app can link from its `app.html`. Each is one file, run as
written, and asks only for the permissions in its manifest.

| Plugin | What it does | Add it with |
| --- | --- | --- |
| [`llm/`](llm/) | Language models behind the `llm` service: [`anthropic.js`](llm/anthropic.js) (Claude), [`openai.js`](llm/openai.js), [`gemini.js`](llm/gemini.js), and [`openai-compatible.js`](llm/openai-compatible.js) for Ollama on this computer or any OpenAI-style API. Each picks the vendor's newest model by tier. Any plugin with the `llm` permission can then ask a model, without holding a key. | `<link rel="plugin" href="/std/llm/anthropic.js">` in the head |
| [`board.js`](board.js) | Where the app's agents reach the person: one panel, folded to a button with a badge until something waits, with the questions agents asked (`bus.ask`), each with its choices or a box to answer in, what waits while an agent checks it, and what the agents did lately. See [agents](../docs/guide/agents.md#messages-topics-and-the-board). | `<link rel="plugin" href="/std/board.js">` in the head, and `<slot name="board"></slot>` in the body |
| [`agents/`](agents/) | Two standard agents and a chat to write to them. [`assistant.agent.md`](agents/assistant.agent.md) does what you ask with the app's own commands; [`builder.agent.md`](agents/builder.agent.md) writes a plugin from what you describe, acting for you once you let it, and saves it only after a review card that shows its code; [`chat.js`](agents/chat.js) lists the app's agents that have an inbox and sends what you write to the one you pick. Needs a model from [`llm/`](llm/). See [agents](../docs/guide/agents.md#the-standard-agents). | `<link rel="agent" href="/std/agents/assistant.agent.md">`, `<link rel="agent" href="/std/agents/builder.agent.md">` and `<link rel="plugin" href="/std/agents/chat.js">` in the head, and `<slot name="chat"></slot>` in the body |
| [`ask-the-page.js`](ask-the-page.js) | A question box that a language model answers from what the page is made of: each plugin's name, description, permissions and hooks, and the code of any plugin the question names. It shows which model answered, the tokens, and exactly what was sent. Needs a model from [`llm/`](llm/) linked beside it. | `<link rel="plugin" href="/std/ask-the-page.js">` in the head, and `<slot name="ask"></slot>` in the body |
| [`commands/palette.js`](commands/palette.js) | A command palette: Cmd K (Ctrl K) or its button opens a search of everything the app's plugins can do, and each command's own shortcut runs it from anywhere on the page. Plugins add commands with `ctx.commands.add`. | `<link rel="plugin" href="/std/commands/palette.js">` in the head, and `<slot name="commands"></slot>` in the body |
| [`debug-console.js`](debug-console.js) | A bug button in a corner of the page. It counts problems (errors, refused permissions, failed calls) and opens a log of them, or of everything the kernel traced, with a Copy button that puts the log on the clipboard, headed with the page's address, browser and time, ready for a bug report. | `<link rel="plugin" href="/std/debug-console.js">` in the head, and `<slot name="debug" float></slot>` anywhere in the body (`float` keeps it in a corner of the screen) |
| [`hook-tracer.js`](hook-tracer.js) | Follows each thing a person does: who started it, each hook it ran in order, and what every plugin listening said (let it through, stopped it, or only heard it). Pause and Clear sit beside it. | `<link rel="plugin" href="/std/hook-tracer.js">` in the head, and `<slot name="inspect"></slot>` in the body |
| [`plugin-editor.js`](plugin-editor.js) | An editor for the person's own plugins: start from a template in [`plugin-editor/templates/`](plugin-editor/templates/) or a copy of a plugin on the page, see what it asks for in plain words, then save and run it after a review card that shows its code. Its logs and errors show beside it. | `<link rel="plugin" href="/std/plugin-editor.js">` in the head, and `<slot name="editor"></slot>` in the body |
| [`reset.js`](reset.js) | When any of the app's plugins is off, a card that names them and turns them all back on. If it is switched off itself, opening the page with `?reset` does the same. | `<link rel="plugin" href="/std/reset.js">` in the head, and `<slot name="switchboard"></slot>` in the body |
| [`switchboard.js`](switchboard.js) | A switch for each plugin the app links, with its name and description, so people can see what the page is made of and turn parts of it off. | `<link rel="plugin" href="/std/switchboard.js">` in the head, and `<slot name="switchboard"></slot>` in the body |
| [`undo.js`](undo.js) | Undo and Redo buttons for the whole app. They take back the most recent change to the app's data, whichever plugin made it (a row deleted, a form saved, a list imported), and put it back again. Each button's title says what it would do. | `<link rel="plugin" href="/std/undo.js">` in the head, and `<slot name="history"></slot>` in the body |
| [`sync.js`](sync.js) | For an app opened in a space (`/s/<space>/…`): whether this page reaches the space and what it has still to send, and the versions of records it kept as drafts when someone else changed them first, each with Use mine and Keep theirs. Draws nothing outside a space. | `<link rel="plugin" href="/std/sync.js">` in the head, and `<slot name="sync"></slot>` in the body |
| [`import-export.js`](import-export.js) | Import and Export for each of the app's collections. Export saves one to a CSV file for a spreadsheet, or JSON. Import brings a CSV or JSON file's rows in (a bank statement, a spreadsheet, an earlier export): columns fill the fields with the same name or title, rows that don't fit are skipped and listed, and the person reviews the import once, as a whole. Undo takes it back. | `<link rel="plugin" href="/std/import-export.js">` in the head, and `<slot name="import-export"></slot>` in the body |
| [`view-source.js`](view-source.js) | Every plugin the app links, and for the one picked, its code and what its manifest lets it do, in plain words. It can't change anything. | `<link rel="plugin" href="/std/view-source.js">` in the head, and `<slot name="inspect"></slot>` in the body |

## Kernel modules

Some folders here also hold a `module.ts`: a **kernel module**, trusted code that runs inside the kernel and gives plugins a service. An app doesn't link a module; the site lists the ones it runs in [`kernel.json`](../kernel.json), and only those are built into its kernel. [The layers](../docs/layers.md) says where modules sit between the kernel core and the plugins above.

| Module | What it adds |
| --- | --- |
| [`agents/module.ts`](agents/module.ts) | The `agents` service: agents' runs and tokens counted by the kernel, and the `agent:*` hooks that say what they did. Needs `tools` |
| [`bus/module.ts`](bus/module.ts) | The `bus` service: inboxes between agents, plugins and the person |
| [`debug/module.ts`](debug/module.ts) | The `debug` service, which the debug console and other developer tools read the trace from, and the `bench` and `reload-test` commands the tests run |
| [`tools/module.ts`](tools/module.ts) | The `tools` service: the service methods a plugin may call, offered to a model as tools |

## The command palette

- **What it uses.** The `commands` service: `commands.list()` and
  `commands.run(name)`, both needing `commands`. It hears `commands:changed`
  to stay current. Each command runs with its own plugin's rights.
- **What it shows.** Every command of the app that needs no arguments,
  grouped, with its shortcuts. Commands that take arguments are for agents.
- **Settings.** `openKeys` (the shortcut that opens it, `Mod+K`) and
  `button` (show a button to open it, on by default; phones need it).
- **The element.** The list, the search and the keys are
  [`<ui-commands>`](../elements/ui-commands.html); the plugin only decides
  which commands go in it. See [the guide](../docs/guide/commands.md).

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
  app put `<slot name="debug" float>` (with `float`, the platform keeps it in
  that corner of the screen).
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

## View source and the hook tracer

[`view-source.js`](view-source.js) reads a plugin's code with the
`authoring` service's `source`, and what its permissions mean with `check`.
Both need only `plugins:read`: reading is not writing, so view source asks
for nothing that could change the page.

[`hook-tracer.js`](hook-tracer.js) reads the kernel's trace (`debug:read`).
Every event of one action carries the same trace id, so it groups them: the
service call that started it, each hook dispatched, and each answer from a
plugin that can change or stop it. Plugins that only hear a hook (`emit`)
send no answer, so it names them from `kernel.reference()`, which lists the
hooks each plugin listens to. It keeps the last few actions that touch the
app's own plugins.

## Ask the page

[`ask-the-page.js`](ask-the-page.js) asks through the `llm` service, so it
holds the `llm` permission and never a key: the model's plugin asks the
person for one the first time. It describes the app's plugins from
`plugins.app()` and `kernel.reference()`, and adds the code (`authoring.source`,
which needs only `plugins:read`) of each plugin whose name or id the question
contains, up to about 40 KB. The person can pick a model, or leave it to the
first one that has its key.

Don't link [`llm/openai-compatible.js`](llm/openai-compatible.js) on a public
page unless you mean it: it needs no key, so it counts as ready and answers
first, and most visitors don't run Ollama.
