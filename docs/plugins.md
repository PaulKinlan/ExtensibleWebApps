# Standard plugins

Plugins in [`/std/`](../std/README.md) that any app can link from its `app.html`, with one line in the head and, for most, a slot in the body. Each is one file, run as written, and asks only for the permissions in its manifest. Every one is used on the [homepage](/), so you can try it there before adding it.

```html
<link rel="plugin" href="/std/switchboard.js">
…
<slot name="switchboard"></slot>
```

## Seeing what an app is made of

| Plugin | What it does | Permissions | Slot |
| --- | --- | --- | --- |
| [Switchboard](../std/switchboard.js) | A switch for each plugin the app links, with its name and description, to turn parts of the page off. | `ui`, `plugins:read`, `plugins:manage` | `switchboard` |
| [Reset](../std/reset.js) | When any plugin is off, a card that names them and turns them all back on. `?reset` in the address does the same. | `ui`, `plugins:read`, `plugins:manage` | `switchboard` |
| [View source](../std/view-source.js) | Each plugin's code, and what its manifest lets it do, in plain words. It can't change anything. | `ui`, `plugins:read` | `inspect` |
| [Hook tracer](../std/hook-tracer.js) | Follows each thing a person does: who started it, each hook in order, and what every plugin said. | `ui`, `plugins:read`, `debug:read` | `inspect` |
| [Debug console](../std/debug-console.js) | A bug button that counts problems and opens a log to copy into a bug report. | `ui`, `debug:read` | `debug` |

## Changing an app

| Plugin | What it does | Permissions | Slot |
| --- | --- | --- | --- |
| [Plugin editor](../std/plugin-editor.js) | Write a plugin of your own, from a template or a copy of one on the page, and run it after a review. | `ui`, `plugins:read`, `plugins:author`, `debug:read` | `editor` |
| [Command palette](../std/commands/palette.js) | Cmd K (Ctrl K) searches everything the app's plugins can do, and runs it. | `ui`, `commands` | `commands` |

## Data

| Plugin | What it does | Permissions | Slot |
| --- | --- | --- | --- |
| [Undo](../std/undo.js) | Undo and Redo for the app's data, whichever plugin made the change. | `ui`, `history` | `history` |
| [Import and export](../std/import-export.js) | Each collection to CSV or JSON, and back in, reviewed as a whole. | `ui`, `transfer` | `import-export` |

## Language models and agents

| Plugin | What it does | Permissions | Slot |
| --- | --- | --- | --- |
| [Claude, OpenAI, Gemini, and any OpenAI-style API](../std/llm/README.md) | Language models behind the `llm` service, so other plugins can ask one without holding a key. The person gives their key the first time. | `provide:llm`, `network:<vendor host>`, `secret:<vendor>` | none |
| [Ask the page](../std/ask-the-page.js) | A question box a model answers from what the page is made of, showing exactly what it sent. | `ui`, `llm`, `plugins:read` | `ask` |
| [Board](../std/board.js) | Where the app's agents reach the person: their questions, and what they did lately. | `ui`, `bus:board`, and listening to questions, answers and agents | `board` |

The [std README](../std/README.md) says more about each, and the plugins' own files start with a comment saying how they work. The permissions above are a guide: each file's manifest is the truth, and view source, on the [homepage](/), shows it in plain words.
