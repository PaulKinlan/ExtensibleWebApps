# Permissions

A plugin lists what it needs in its manifest's `permissions`. The kernel refuses everything else and records each refusal in the trace. This page explains each permission in plain words, grouped by how much it lets a plugin do. The [API reference](api.md#capabilities) has the exact list, printed by the kernel from the same table it enforces.

```js
export const manifest = {
  id: "due-soon",
  name: "Due soon",
  permissions: ["ui", "data:read:library"],
};
```

Ask for exactly what you use. The person sees the list in Customize, view source and the plugin editor, and a short list is easier to trust. A trailing `*` grants everything starting with what comes before it (`hook:listen:notes:*`), but use it sparingly.

```mermaid
flowchart LR
    A["Shows things<br/>ui, router, commands, ui:theme"] --> B["Reads<br/>data:read, plugins:read, debug:read, sync, members"]
    B --> C["Takes part<br/>hook:intercept, bus"]
    C --> D["Changes things<br/>data:write, files, plugins:manage,<br/>plugins:author, history, transfer, schedule"]
    D --> E["Leaves the browser<br/>network, network:host, secret, llm, share, email"]
```

## Showing things

| Permission | Lets a plugin | Notes |
| --- | --- | --- |
| `ui` | Draw views in the page's slots and places, and ask whether a selector matches the page (`page.matches`). | Views are sanitised; see [Views and templates](guide/views-and-templates.md). |
| `router` | Know which screen of the app the tab shows, hear when it changes, and move to another. | Usually with `scope: "tab"`. See [Routes](guide/routes.md). |
| `commands` | List the app's commands and run them. | Each command runs with its own plugin's rights, not the caller's. See [Commands](guide/commands.md). |
| `audio` | Register an AudioWorklet processor and play it, in the tab that runs the plugins; play, render and save clips, and open a sound file the person picks. | See [Games and audio](guide/games-and-audio.md). |
| `game` | Start, pause and stop a game loop, send it what the person pressed, and read its state. | A system that changes the game listens with `hook:intercept:game:update` or `hook:intercept:game:rules`; one that draws it with `hook:listen:game:frame`. See [Games and audio](guide/games-and-audio.md). |
| `routes` | Answer requests for paths in its own folder (`ctx.routes.add`). | See [Routes and the service worker](guide/routes.md). On a space's server the routes are public: see [Spaces, and plugins on a server](guide/spaces-and-servers.md). |
| `ui:theme` | Set design tokens for the whole app, with the manifest's `theme`. | Colours, corners, shadows and typefaces only, as plain values. See [Styling](guide/styling.md#themes-a-plugin-that-sets-the-tokens). |
| `ui:transform:<plugin>` | Change that plugin's views with a place whose `in` names it: add to them, replace or hide parts. | See [Slots in views, and view transforms](guide/slots-and-transforms.md). |

No permission is needed for a plugin's own storage and settings (`ctx.storage`, `ctx.settings`), or for adding commands of its own.

## Reading

| Permission | Lets a plugin | Notes |
| --- | --- | --- |
| `data:read:<collection>` | List and get another plugin's records, and hear when they change. | Works before the collection exists: it reads as empty. See [Sharing data between apps](guide/sharing-data-between-apps.md). |
| `plugins:read` | List the plugins the app links, and read their code. | What view source and Ask the page use. |
| `debug:read` | Read the kernel's trace for the app. | The trace names every plugin and what it did. |
| `reflect:read` | Read what runs in the kernel: every plugin's manifest and permissions, every hook and its listeners, every worker and tab, and plugins' code. | It sees every app open on this site, not just the caller's: give it only to developer tools such as the [debugger](../demos/debugger/app.html). |
| `bus:read:<topic>` | Read the messages posted to a topic. | See [Agents](guide/agents.md). |
| `sync` | Know whether the tab's copy of a space is in step, and keep or let go of the drafts kept from a conflict. | What [`std/sync.js`](../std/sync.js) uses. Only means something in a space. |
| `members` | Read the space's members, each with the name on their account, and which of them this page is signed in as (`sync.members()`), and hear `members:changed`. | Lets a plugin show who changed what: `by` on a change is a member's id. What [`demos/household`](../demos/household/) uses. Only means something in a space. |
| `hook:listen:<hook>` | Hear an `emit` or `parallel` hook: something happened. | It can't change what happened. |

## Taking part

| Permission | Lets a plugin | Notes |
| --- | --- | --- |
| `hook:intercept:<hook>` | Answer a `serial`, `bail` or `waterfall` hook: change a value, or stop the action. | For example `hook:intercept:data:beforeWrite:learning` can stop a note being saved. A listener that doesn't answer in time is skipped or counted as a block, as the hook says. |
| `bus:send:<to>`, `bus:post:<topic>` | Send a message to one agent or plugin, or post to a topic. | |
| `bus:ask`, `bus:board`, `bus:inbox` | Ask the person a question, answer questions, or receive and reply to messages. | |
| `agents:run:<agent>` | Start one of the app's agents. | |

## Changing things

| Permission | Lets a plugin | Notes |
| --- | --- | --- |
| `data:write:<collection>` | Put and delete another plugin's records. | **Each change waits for the person** to accept a review card, unless they chose to always allow it. |
| `files:<folder>` | Read and write text files in one folder of the app's data. | Writes are reviewed. Paths are checked, and the platform's own files are off limits whatever the folder. |
| `history` | Undo and redo the app's most recent data changes. | |
| `schedule` | Run work later, once or every so often (`ctx.schedule.at`, `ctx.schedule.every`). | A repeating job runs at most once a second. On a space's server a job wakes the space, even after a restart; in a browser it runs only while the kernel does. |
| `transfer` | Export the app's collections, and import into them. | An import is reviewed as a whole. |
| `plugins:manage` | Switch the app's plugins on and off. | What the switchboard and reset use. Switching is saved and applies in every tab. |
| `plugins:author` | Write and remove the person's own plugins for the app. Includes `plugins:read`. | **Every save and removal waits for the person**, on a card showing the code. |

## Leaving the browser

| Permission | Lets a plugin | Notes |
| --- | --- | --- |
| `network` | Use `fetch` and WebSockets to any `https:` host, and show `https:` images. | Its worker runs under a policy that allows the network. Without it, the worker can't connect anywhere. |
| `network:<host>` | Send requests to one host through the kernel (`net.fetch`). | Narrower than `network`, and traced. |
| `secret:<name>` | Use the key the person gave under that name, in requests to the hosts they agreed to. | The plugin never reads the key. See [API keys and web requests](guide/keys-and-requests.md). |
| `llm` | Ask the app's language models, and list them. | The plugin never sees a key or a vendor's address. |
| `provide:<service>` | Provide a service other plugins call, such as `provide:mail`: answer every call any app's plugins make to it. The manifest's `provides` describes it. | A plugin that adds a capability the site doesn't build in. See [the layers](layers.md#plugins-that-provide-services). |
| `provide:llm` | Be a language model: answer the `llm` service's requests for one vendor. | What the plugins in [`/std/llm/`](../std/llm/README.md) ask for, beside their vendor's host and key. |
| `share` | Hand something to the system's share sheet, or take what was shared to the app. | |
| `outside` | Open the door to agents outside the app: they call this plugin's tools, as this plugin, through WebMCP in the page and MCP on a space's server. | They get exactly the plugin's other permissions, and its reviews. See [Outside agents](guide/outside-agents.md). |
| `email` | Send an email (`email.send`), to up to 10 addresses. | Only on a space's server, and only to the space's members, at an address they confirmed; refused in a browser. At most 50 a day. Written to the space's outbox, and delivered when the site sends mail. |

## Editor permissions

A permission is always a capability by its own name: there are no older aliases (the Markdown editor's `post:read` and `post:write` went with its shim; its features are now plugins of their own, in [`demos/markdown-editor/`](../demos/markdown-editor/)).
