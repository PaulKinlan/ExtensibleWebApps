# API reference

Printed by the kernel from its own registries (`npm run reference` writes this file; the tests fail if it falls behind). Plugins can read the same thing as data with `ctx.call("kernel", "reference")`.

## The plugin's `ctx`

### ctx.call

`ctx.call(service, method, ...args) → Promise`

Needs: What the method needs (see Services).

Calls a kernel service. Rejects if the capability is missing, the method doesn't exist, or the service refuses.

### ctx.commands.add

`ctx.commands.add({ id, title, description?, keys?, group?, args? }, (args, { by }) => result) → off()`

Needs: nothing.

Adds a command the plugin answers: a palette lists it, its `keys` run it, and plugins with `commands` (an agent, through its tools) run it with `commands.run("<plugin>/<id>")`. The handler runs with this plugin's own rights; `by` says which plugin ran it, and what it returns goes back to the caller. Throwing fails the run. See the commands service.

### ctx.log

`ctx.log(text, level?)`

Needs: nothing.

Writes to the trace, as info or error.

### ctx.on

`ctx.on(hook, handler) → off()`

Needs: `hook:listen:<hook>` (emit, parallel) or `hook:intercept:<hook>` (serial, bail, waterfall).

Listens to a hook. In a `function` handler, `this` is a copy of ctx pinned to the action's trace. What it returns matters only for hooks that can change or stop an action.

### ctx.routes.add

`ctx.routes.add(method, path, (request) => response) → off()`

Needs: `routes`.

Answers requests for a path inside the plugin's own folder (only for plugins an app links), so a link or a form can reach the plugin. The platform's service worker sends a matching request to the kernel through an open tab. `request` is `{ method, path, query, form }`; the handler returns `{ redirect }` (a 303 to a page on this site), `{ html }` (a page in which no script runs), `{ json }` or `{ text }`, each with an optional `status`. Returning nothing lets another plugin answer, and then 404.

### ctx.settings.get

`ctx.settings.get() → Promise<values>`

Needs: nothing.

The plugin's own settings: saved values over the manifest's defaults.

### ctx.settings.onChange

`ctx.settings.onChange((values) => …) → off()`

Needs: nothing.

Hears the person change the plugin's settings.

### ctx.storage.get

`ctx.storage.get(key) → Promise<value | null>`

Needs: nothing.

Reads the plugin's own data.

### ctx.storage.set

`ctx.storage.set(key, value) → Promise`

Needs: nothing.

Saves a JSON value in the plugin's own data (null removes it), up to 1 MB in all. Never reviewed.

### ctx.traced

`ctx.traced() → ctx`

Needs: nothing.

A copy of ctx whose calls keep the current trace id after an `await`.

### ctx.ui.html

`ctx.ui.html`…${value}…` → view`

Needs: nothing.

Builds an HTML view from a template, escaping every value (arrays are joined, nested html results go in as they are). Use it whenever text comes from data.

### ctx.ui.live

`ctx.ui.live(slot, key, (ctx) => view, order?) → { refresh(), stop() }`

Needs: `ui`.

Draws what the function returns, like `ui.render`, and draws it again whenever a collection it read (with `data.list` or `data.get` on the ctx it is given) or the plugin's settings change. Call `refresh()` after the plugin's own state changes. A collection that doesn't exist yet is followed too, so the view fills in when it appears.

### ctx.ui.onCanvas

`ctx.ui.onCanvas(id, (canvas) => …)`

Needs: nothing.

Receives the OffscreenCanvas for a canvas view the plugin rendered. Use scope "tab" for plugins that draw.

### ctx.ui.onEvent

`ctx.ui.onEvent((action, value) => …) → off()`

Needs: nothing.

Hears the person use the plugin's views: a button's or field's `action`, with a field's new value.

### ctx.ui.render

`ctx.ui.render(slot, key, view, order?)`

Needs: `ui`.

Draws a view in a slot, under a key of the plugin's own: an HTML string (see HTML views), a JSON view, or null to remove it. Drawing again updates it in place. Plugins never touch the DOM.

### ctx.ui.views

`ctx.ui.views(file) → { render(slot, id, data?, { key?, order? }?), live(slot, id, (ctx) => data, { key?, order? }?) }`

Needs: `ui` (to render).

The `<template id>` elements in an .html file next to the plugin (only for plugins an app links). `render` draws one, filled with `data`: `{{path}}` holes in text and attribute values (an attribute that is one whole hole is left out when its value is false or missing, and bare when true), `<template for="x of path">` and `<template if="path">`. Values go in as text, and the result is checked like any HTML view. A `<style>` in the file styles only this plugin's views, below the page's own styles. `live` fills it with what the function returns, again whenever what it read changes (see `ui.live`).

## Services

Called with `ctx.call(service, method, ...args)`. A method not listed here doesn't exist. Reviewed methods show the person a diff with the plugin's reason first; they accept once, allow that plugin in that place from then on, or decline.

### agents

Agents: Markdown files an app links with rel="agent", each run by the kernel as a plugin that asks a model and calls tools. Lists them, starts their commands, and is how an agent reaches its model and tools, so its limits hold and the app hears the agent:* events.

#### agents.begin

`agents.begin(trigger)` → { ok: true, run } or { ok: false, reason }

Needs: nothing.

For agents: starts a run, if the agent is within its limits. The agent loop calls it.

#### agents.complete

`agents.complete(run, request)` → llm.complete's answer with ok: true, or { ok: false, reason }

Needs: nothing.

For agents: llm.complete, counted against the agent's tokens a day.

#### agents.end

`agents.end(run, { stopReason, text, steps })` → true

Needs: nothing.

For agents: ends a run, told to the app as agent:done.

#### agents.list

`agents.list()` → [{ id, name, hooks, commands, inbox, topics, limits, used: { runs, tokens } }]

Needs: nothing.

The agents running now, what wakes them, their limits, and what they have used this hour (runs) and today (tokens).

#### agents.next

`agents.next()` → [{ command, input, from }]

Needs: nothing.

For agents: the commands waiting for this agent, which it runs in order.

#### agents.run

`agents.run(agent, command, input?)` → { ok: true }

Needs: `agents:run:<agent>`.

Starts one of an agent's commands, the ones its file lists under `on`. It runs after any run under way; listen to agent:done for the outcome.

#### agents.tool

`agents.tool(run, name, args)` → { ok, value?, error? }

Needs: nothing.

For agents: tools.call, as the agent, told to the app as agent:toolResult.

### audio

Sound, played by the tab that runs the plugin workers. Audio runs in an AudioWorklet, never through hooks.

#### audio.play

`audio.play({ processor, ms?, options? })` → { played, state }

Needs: `audio`.

Plays a registered processor for `ms` milliseconds (300 by default), passing `options` as its processorOptions.

#### audio.registerProcessor

`audio.registerProcessor(name, source)` → true

Needs: `audio`.

Registers an AudioWorklet processor, from its source, under a name.

### authoring

Helps a plugin editor: reads the code of the plugins in the caller's app and files next to the caller, checks a draft's manifest, and saves the person's own plugins, after they review each one. The caller must be tab-scoped.

#### authoring.check

`authoring.check(code)` → { ok: true, manifest: { id, name, description, scope }, permissions: [{ name, about }] } or { ok: false, error }

Needs: `plugins:read`.

Reads a draft's manifest the way the kernel will, without running it, and says what each permission would let it do.

#### authoring.copy

`authoring.copy(id)` → { id, name, code }

Needs: `plugins:author`.

A copy of a plugin the caller's app links, with an id and name of its own so it can run beside the original, and its templates read from where the original lives.

#### authoring.file

`authoring.file(path)` → the file's text

Needs: `plugins:author`.

A .js file in the caller's own folder or below it, such as the starting templates beside std/plugin-editor.js.

#### authoring.mine

`authoring.mine()` → [{ id, name, on, error? }]

Needs: `plugins:author`.

The person's own plugins for the caller's app.

#### authoring.remove

`authoring.remove(id)` → { ok: true } or { ok: false, error }

Needs: `plugins:author`.

Removes one of the person's own plugins for the caller's app, once they accept a review.

#### authoring.save

`authoring.save(code)` → { ok: true, id } or { ok: false, error }

Needs: `plugins:author`.

Saves a plugin as one of the person's own for the caller's app, and turns it on, once they accept a review that shows its code and what it asks for. Its id can't be one of the app's own plugins.

#### authoring.source

`authoring.source(id)` → { id, name, code }

Needs: `plugins:read`.

The code of a plugin the caller's app links, or of one of the person's own for it, on or off.

### bus

Messages between agents, plugins and the person: inboxes with replies, topics, and questions on the board. A message is information, never permission.

#### bus.answer

`bus.answer(id, answer)` → true

Needs: `bus:board`.

Gives the person's answer to a question. Only a board should call it, with what the person chose or wrote.

#### bus.ask

`bus.ask(question, choices?)` → { answered: true, answer } or { answered: false }

Needs: `bus:ask`.

Asks the person a question on the board and waits for the answer, up to a day. With choices, the person picks one; otherwise they write an answer.

#### bus.post

`bus.post(topic, message)` → { ok: true, id }

Needs: `bus:post:<topic>`.

Posts to a topic. Agents that wake on the topic run, and readers hear bus:posted.

#### bus.questions

`bus.questions()` → [{ id, from, name, question, choices?, at }]

Needs: `bus:board`.

The questions waiting for the person from the plugins of the caller's app: its tab's app, for a tab-scoped board (from anyone, for a plugin no app links).

#### bus.read

`bus.read(topic, since?)` → [{ id, from, text, at }]

Needs: `bus:read:<topic>`.

The topic's recent posts (the last 50), oldest first, or only those after the post `since`.

#### bus.receive

`bus.receive()` → [{ id, from, text, data?, reply }]

Needs: `bus:inbox`.

Takes the messages waiting in the caller's inbox, oldest first. Answer each one that wants a reply with bus.reply.

#### bus.reply

`bus.reply(id, { stopReason?, text, value? })` → true

Needs: `bus:inbox`.

Answers a message the caller received. stopReason is completed (the default), steps (an agent ran out of steps), blocked, error, budget or cancelled.

#### bus.send

`bus.send(to, message, { reply? }?)` → { ok: true, id }, or with reply, the answer: { stopReason, text, value? }

Needs: `bus:send:<to>`.

Puts a message (text, or { text, data }) in an agent's or plugin's inbox. With reply: true it waits, up to 30 minutes, for the answer; an agent answers with what it says at the end of the run the message woke. Four may take part in a chain of messages, and a reply that would wait on itself (A waits on B, who would wait on A) is refused.

### commands

Commands: things to do in an app, added by the plugin that does them, and run from a palette, a shortcut or an agent's tool call.

#### commands.add

`commands.add({ id, title, description?, keys?, group?, args? })` → true

Needs: nothing.

Adds (or replaces) one of the caller's commands. Use `ctx.commands.add(command, handler)`, which also listens for it. `keys` are up to 3 shortcuts such as "Mod+K" (Cmd on a Mac, Ctrl elsewhere); `args` is an object schema for what the handler takes.

#### commands.list

`commands.list()` → [{ name, plugin, id, title, description?, keys?, group?, args? }]

Needs: `commands`.

The commands of the caller's app, sorted by group and title. Run one with `commands.run(name)`; `name` is `<plugin>/<id>`.

#### commands.remove

`commands.remove(id)` → true

Needs: nothing.

Removes one of the caller's commands. The `off()` that `ctx.commands.add` returns does this.

#### commands.run

`commands.run(name, args?)` → what the command's handler returns

Needs: `commands`.

Runs a command of the caller's app, with its own plugin's rights. `commands:before` can stop it first. Fails if the handler throws or takes longer than two minutes.

### data

Collections: typed records plugins share. A plugin declares its own in its manifest; reading or writing another's needs a capability, and writes to another's are reviewed.

#### data.collections

`data.collections()` → [{ name, owner, title, schema }]

Needs: nothing.

Every collection, with its schema.

#### data.delete

`data.delete(collection, id, reason?)` → { ok, id }

Needs: `data:write:<collection>`, and the person's review.

Deletes a record. Reviewed unless the plugin owns the collection.

#### data.get

`data.get(collection, id)` → record or null

Needs: `data:read:<collection>`.

One record.

#### data.list

`data.list(collection)` → [record], most recently changed first

Needs: `data:read:<collection>`.

Every record in a collection. Each record has its fields plus id, createdAt and updatedAt. A collection no plugin has made yet reads as empty.

#### data.put

`data.put(collection, { id?, ...fields }, reason?)` → { ok, id, outcome? } or { ok: false, errors }

Needs: `data:write:<collection>`, and the person's review.

Creates or replaces a record, checked against the collection's schema. Reviewed unless the plugin owns the collection.

### debug

The trace: everything the kernel, the pages and plugins did, and every error. For developer tools such as std/debug-console.js; hear new events with the `debug:trace` hook.

#### debug.app

`debug.app()` → { tab?, app? }

Needs: `debug:read`.

For a tab-scoped caller: its `tab`, and the ids of the plugins the app open there links, or no `app` if the tab hasn't opened one yet. The trace's `app:open` event says when to ask again.

#### debug.recent

`debug.recent()` → { startedAt, events: [{ seq, at, kind, name, plugin?, trace?, ms?, detail? }], tab?, app? }

Needs: `debug:read`.

The last 500 trace events, oldest first; `seq` counts up with each event, and `at` is milliseconds after `startedAt` (wall-clock ms). A tab-scoped caller also gets its `tab`, and `app`: the ids of the plugins the app open in that tab links, once it has opened one.

### files

Text files in the data folder. A path is checked first: no `..`, no hidden names, nothing in the platform's own folders.

#### files.read

`files.read(path)` → text or null

Needs: `files:<folder>`.

Reads a file. `<folder>` is the path's first folder.

#### files.write

`files.write(path, text, reason)` → { ok, path, outcome } or { ok, unchanged }

Needs: `files:<folder>`, and the person's review.

Writes a file, up to 5 MB. Fails if the person declines, nobody answers, or the file changed while the review was open.

### history

Undo and redo for the person, across every write to the app's collections, whichever plugin made it.

#### history.redo

`history.redo()` → { ok, step } or { ok: false, step?, error }

Needs: `history`.

Makes the most recent undone write again. A new write to that record ends its redo.

#### history.state

`history.state()` → { undo: step or null, redo: step or null }

Needs: `history`.

What Undo and Redo would do now in the caller's app. A step is `{ kind, collection, title, id, label?, by, at, text }`, with kind add, edit or delete and text such as `delete “Coffee” in Expenses`.

#### history.undo

`history.undo()` → { ok, step } or { ok: false, step?, error }

Needs: `history`.

Takes back the app's most recent write: the record goes back to how it was, with no review. If the record changed since, that step is dropped and the answer says so; the next undo takes the one before.

### kernel

The kernel itself.

#### kernel.hooks

`kernel.hooks()` → { [name]: { mode, timeoutMs?, onFailure?, args?, description? } }

Needs: nothing.

Every hook and its contract.

#### kernel.ping

`kernel.ping()` → "pong"

Needs: nothing.

Answers at once; for checking the connection.

#### kernel.reference

`kernel.reference()` → the reference, as data

Needs: nothing.

This API reference, as the kernel describes itself.

### llm

Ask a language model, through whichever provider plugin the app has (std/llm/anthropic.js, std/llm/openai.js, std/llm/gemini.js). The caller never holds a key.

#### llm.complete

`llm.complete({ messages, system?, tools?, schema?, model?, maxTokens?, provider? })` → { text, json?, toolCalls, stop, usage: { input, output }, provider, model, message }

Needs: `llm`.

Asks a model. messages are { role: "user" | "assistant", content }, an assistant's { toolCalls: [{ id, name, args }], state }, or a tool's answer { role: "tool", id, name, content }; add each answer's message to messages to go on. tools are [{ name, description, parameters }]; schema (the platform's JSON Schema subset, as collections use) asks for an answer of that shape, in json, checked before it's returned. model is an id or a tier: best, balanced or fast (the default is the provider's setting). Without provider, the first ready one answers.

#### llm.models

`llm.models(provider?)` → { models: [{ id, name? }], tiers: { best, balanced, fast }, provider }

Needs: `llm`.

The models a provider's vendor serves now (the first ready provider's, without one), and the model each tier stands for.

#### llm.providers

`llm.providers()` → [{ id, name, model?, ready }]

Needs: `llm`.

The providers the caller's app links; ready means it has its key.

### net

Web requests the kernel makes for a plugin, to the hosts its manifest names. A header can hold a secret the plugin never sees.

#### net.fetch

`net.fetch({ url, method?, headers?, body? })` → { ok, status, headers, text }

Needs: `network:<host>`.

Fetches `url` (https:, or http: on localhost) and returns the answer as text, up to 4 MB, within two minutes. A header given as `{ secret: name }` is filled with that secret, if the plugin has `secret:<name>` and the host is one the secret is for.

### page

The app's own page, as far as a plugin's places reach into it.

#### page.matches

`page.matches(place)` → [{ text, data }]

Needs: `ui`.

What one of the plugin's places matches in the page: each element's text (up to 500 characters) and its data-* attributes, in page order. A plugin with `each: true` draws a view per match by rendering to `<place>#<index>`.

### plugins

The plugins in the caller's app, and a switch for each. The caller must be tab-scoped; hear changes with the `plugins:changed` hook.

#### plugins.app

`plugins.app()` → [{ id, name, description, enabled }]

Needs: `plugins:read`.

Every plugin the caller's app links, in the order its app.html lists them. Empty until the tab has opened its app.

#### plugins.setEnabled

`plugins.setEnabled(id, enabled)` → true if it changed

Needs: `plugins:manage`.

Turns one of the app's plugins on or off. Saved, and applies in every tab, as the plugins panel's switch does.

### router

The screen an app's tab shows, from its address (app/book/42), so screens can be bookmarked and shared, and back and forward work.

#### router.current

`router.current()` → { tab, path, query }

Needs: `router`.

The screen the plugin's tab shows: the reading list at `/demos/reading-list/book/42?tab=notes` is `{ path: "/book/42", query: { tab: "notes" } }`. The app's own address is `/`.

#### router.go

`router.go(path, { replace? }?)` → true

Needs: `router`.

Moves the plugin's tab to another screen without loading the page, as a link to it would. With `replace`, back skips the screen it leaves.

### secrets

API keys and tokens. A plugin never reads one: it asks the person for it by name, then uses it in requests it makes with net.fetch, which the kernel sends only to the hosts the secret was given for.

#### secrets.forget

`secrets.forget(name)` → true

Needs: `secret:<name>`.

Removes the secret.

#### secrets.has

`secrets.has(name)` → { set, hosts }

Needs: `secret:<name>`.

Whether the person has given this secret, and the hosts it may be sent to.

#### secrets.request

`secrets.request(name, { hosts, label? })` → { set }

Needs: `secret:<name>`.

Asks the person to paste the secret, in a card the kernel draws; resolves when they save it or say not now (or after ten minutes). `hosts` are the only hosts it will ever be sent to.

### settings

The plugin's own settings, from the form the plugins panel builds out of its manifest.

#### settings.get

`settings.get()` → { [key]: value }

Needs: nothing.

The plugin's settings: saved values over the manifest's defaults.

### share

Sharing a link or text out through the system's share sheet, and having what is shared to the app when it is installed as a share target.

#### share.send

`share.send({ title?, text?, url? })` → { ok, via: "share" | "clipboard" } or { ok: false, cancelled?, error? }

Needs: `share`.

Opens the system's share sheet with a link or some text, or copies it where there is none. Only right after the person clicks, as the browser asks.

#### share.take

`share.take()` → { title?, text?, url? } or null

Needs: `share`.

What was shared to the plugin's tab, once: it is gone after, and the tab moves back to the app's own address. null when nothing is waiting.

### storage

The plugin's own data, kept in `plugin-data/<id>.json` with the app's data. Never reviewed, since it is the plugin's own.

#### storage.get

`storage.get(key)` → the value, or null

Needs: nothing.

Reads a value.

#### storage.set

`storage.set(key, value)` → true

Needs: nothing.

Saves a JSON value; null removes it. Up to 1 MB in all.

### store

The notes. They belong to the notes app, so a plugin's change to one is reviewed first.

#### store.list

`store.list()` → [{ id, title, text, updated }]

Needs: `data:read:notes`.

Every note, most recently changed first.

#### store.put

`store.put({ id?, text }, reason)` → { ok, id, outcome }

Needs: `data:write:notes`, and the person's review.

Creates or replaces a note. Fails if the person declines, nobody answers in five minutes, or the note changed while the review was open.

### tools

The service methods the caller may call, described as tools a language model can call, and a way to call one. The first piece of the agent plugin.

#### tools.call

`tools.call(name, args)` → what the method returns

Needs: nothing.

Calls a tool from `list` with the arguments a model gave, as an object. The arguments are checked against the tool's schema, then the method is called through the gate, needing what it needs and with the same reviews as `ctx.call`.

#### tools.list

`tools.list()` → [{ name, description, parameters, service, method, reviewed }]

Needs: nothing.

The caller's tools: each service method that describes its arguments and that the caller's manifest lets it call. Pass them to `llm.complete` as `tools`. A method that takes a collection is one tool per collection the caller may use, such as `data_put_books` with that collection's fields (one tool listing them, past five).

### transfer

Import and export for the person: a collection of the app's to a CSV or JSON file, and a file they choose into a collection.

#### transfer.collections

`transfer.collections()` → [{ name, title, count, fields }]

Needs: `transfer`.

The collections the caller's app's plugins own, which it can import into and export, with how many records each has and its fields.

#### transfer.export

`transfer.export(collection, format?)` → { ok, file, count }

Needs: `transfer`.

Saves every record in the collection to a file the person downloads, such as expenses-2026-11-08.csv: a column for the id, each field, and when it was made and changed.

#### transfer.import

`transfer.import(collection, reason?)` → { ok, file, added, replaced, skipped: [{ row, error }], ignored: [column] } or { ok: false, cancelled?, error }

Needs: `transfer`, and the person's review.

Asks the person for a CSV or JSON file and adds its rows to the collection, after one review of them all. Columns match fields by name or title; rows that don't fit the schema are skipped and listed; a row whose id is in the collection replaces that record. Only right after the person clicks, as the browser opens a file chooser only then.

## Hooks

### `agent:budget`

An agent reached one of its limits, so a run didn't start or was stopped.

Mode: `emit`. Listening needs `hook:listen:agent:budget`.

Listeners get `{ agent, limit: "runs-per-hour" | "tokens-per-day", used, max }`.

### `agent:done`

An agent's run ended. stopReason is completed, steps (it reached its step limit), budget or error.

Mode: `emit`. Listening needs `hook:listen:agent:done`.

Listeners get `{ agent, run, stopReason, steps, tools, usage: { input, output } }`.

### `agent:run`

Someone ran one of an agent's commands (agents.run). The named agent fetches it with agents.next, which only that agent may call.

Mode: `emit`. Listening needs `agent`.

Listeners get `{ agent }`.

### `agent:toolResult`

An agent called one of its tools; ok is false if the call failed.

Mode: `emit`. Listening needs `hook:listen:agent:toolResult`.

Listeners get `{ agent, run, tool, ok }`.

### `agent:wake`

An agent began a run, woken by a hook or a command.

Mode: `emit`. Listening needs `hook:listen:agent:wake`.

Listeners get `{ agent, run, trigger: { kind, name } }`.

### `bench:ping`

Used by the round-trip benchmark; answer with anything.

Mode: `serial`, 1000 ms per listener, fails open. Listening needs `hook:intercept:bench:ping`.

Listeners get `n`.

### `bus:answered`

A question was answered, or gave up waiting (answered is false).

Mode: `emit`. Listening needs `hook:listen:bus:answered`.

Listeners get `{ id, from, answered }`.

### `bus:asked`

An agent or plugin asked the person a question (bus.ask). The board lists it with bus.questions.

Mode: `emit`. Listening needs `hook:listen:bus:asked`.

Listeners get `{ id, from }`.

### `bus:message`

A message is waiting in to's inbox. Only plugins with an inbox hear it; the one named fetches it with bus.receive.

Mode: `emit`. Listening needs `bus:inbox`.

Listeners get `{ to }`.

### `bus:posted`

Someone posted to a topic. Read it with bus.read, which needs bus:read:<topic>.

Mode: `emit`. Listening needs `hook:listen:bus:posted`.

Listeners get `{ topic, id, from }`.

### `commands:before`

Before a command runs; `by` is the plugin that ran it (the palette, an agent). Return { block: reason } to stop it.

Mode: `serial`, 15000 ms per listener, fails open. Listening needs `hook:intercept:commands:before`.

Listeners get `{ name, plugin, id, args, by }`.

### `commands:changed`

A command was added or removed, or the plugin that added it stopped. Call commands.list() again.

Mode: `emit`. Listening needs `commands`.

Listeners get `{}`.

### `commands:ran`

A command ran, or failed (ok false, with the error). Its arguments aren't included: listen to commands:before for those.

Mode: `emit`. Listening needs `commands`.

Listeners get `{ name, plugin, id, by, ok, error? }`.

### `data:beforeWrite`

Before a record is written. Return { block: reason } to stop the write.

Mode: `serial`, 1000 ms per listener, fails open. Listening needs `hook:intercept:data:beforeWrite`.

Listeners get `{ collection, id, before?, after }`.

### `data:changed`

A record was written.

Mode: `emit`. Listening needs `hook:listen:data:changed`.

Listeners get `{ collection, id, before?, after }`.

### `debug:trace`

New trace events, in batches at most ten times a second. They name every plugin and what it did, so listening needs debug:read.

Mode: `emit`. Listening needs `debug:read`.

Listeners get `[{ seq, at, kind, name, plugin?, trace?, ms?, detail? }]`.

### `history:changed`

Something was written, undone or redone, so what Undo and Redo would do may have changed: read history.state().

Mode: `emit`. Listening needs `history`.

Listeners get `{}`.

### `llm:complete`

Asks the provider named in request.provider for an answer. Others return nothing. Answer { text, json?, toolCalls?, stop?, usage?, model? }, or { error }. Listening needs provide:llm.

Mode: `bail`, 660000 ms per listener, fails open. Listening needs `provide:llm`.

Listeners get `request, with provider set to the id of the provider that should answer`.

### `llm:models`

Asks the provider named in provider which models its vendor serves. Answer { models: [{ id, name? }], tiers: { best, balanced, fast } }, or { error }. Listening needs provide:llm.

Mode: `bail`, 30000 ms per listener, fails open. Listening needs `provide:llm`.

Listeners get `{ provider }`.

### `llm:providers`

Asks which language models are available. A provider returns { providers: [...providers, itself] }. Listening needs provide:llm.

Mode: `waterfall`, 2000 ms per listener, fails open. Listening needs `provide:llm`.

Listeners get `{ providers: [{ id, name, model?, ready }] }`.

### `note:change`

The person typed in the open note (unsaved is true).

Mode: `emit`. Listening needs `hook:listen:note:change`.

Listeners get `{ path, url, title, siteName, text, bodyStart, selection, unsaved }`.

### `note:close`

The open note was closed.

Mode: `emit`. Listening needs `hook:listen:note:close`.

Listeners get `null`.

### `note:open`

The person opened a note.

Mode: `emit`. Listening needs `hook:listen:note:open`.

Listeners get `{ path, url, title, siteName, text, bodyStart, selection, unsaved }`.

### `note:save`

The open note was saved, by the person or by a reviewed write.

Mode: `emit`. Listening needs `hook:listen:note:save`.

Listeners get `{ path, url, title, siteName, text, bodyStart, selection, unsaved }`.

### `plugins:changed`

A plugin was installed, removed, or turned on or off (`change` is install, uninstall, enable or disable, and `id` is the plugin), or a tab opened its app (`change` is open, and `id` is the tab), so plugins.app() may answer differently.

Mode: `emit`. Listening needs `plugins:read`.

Listeners get `{ change, id }`.

### `router:changed`

A tab moved to another screen of its app: a link to one, back or forward, or router.go. Read router.current() for the screen your instance shows.

Mode: `emit`. Listening needs `router`.

Listeners get `{ app, tab, path, query }`.

### `share:received`

Something was shared to an app from elsewhere (it is installed as a share target). Call share.take() to have it, if it was shared to your app. It carries nothing itself, as every plugin with `share` hears it.

Mode: `emit`. Listening needs `share`.

Listeners get `{}`.

### `transfer:changed`

A record in a collection transfer.collections listed was written or deleted, so the counts may have changed: call transfer.collections() again.

Mode: `emit`. Listening needs `transfer`.

Listeners get `{}`.

### Dispatch modes

| Mode | What happens |
| --- | --- |
| `emit` | Every listener is told; nothing comes back. Listening needs hook:listen. |
| `parallel` | Every listener is told at once; nothing comes back. Listening needs hook:listen. |
| `serial` | Listeners answer one after another; returning { block } stops the action. Listening needs hook:intercept. |
| `bail` | Listeners answer one after another; the first answer wins. Listening needs hook:intercept. |
| `waterfall` | Each listener can change the value before the next sees it, or return { block }. Listening needs hook:intercept. |

## Capabilities

A plugin lists what it needs in its manifest's `permissions`; the gate checks every message against them. A trailing `*` grants everything that starts with what comes before it.

| Capability | Lets a plugin |
| --- | --- |
| `ui` | Draw views with ctx.ui.render. |
| `routes` | Answer requests for paths in the plugin's own folder with ctx.routes.add. |
| `network` | Run in a worker whose policy allows fetch and WebSockets to https: hosts. Without it, a plugin can't connect anywhere. |
| `hook:listen:<hook>` | Listen to an emit or parallel hook. |
| `hook:intercept:<hook>` | Listen to a hook that can change or stop an action (serial, bail, waterfall). |
| `agents:run:<agent>` | Call agents.run. |
| `audio` | Call audio.registerProcessor, audio.play. |
| `bus:ask` | Call bus.ask. |
| `bus:board` | Call bus.questions, bus.answer. |
| `bus:inbox` | Call bus.receive, bus.reply. |
| `bus:post:<topic>` | Call bus.post. |
| `bus:read:<topic>` | Call bus.read. |
| `bus:send:<to>` | Call bus.send. |
| `commands` | Call commands.list, commands.run. |
| `data:read:<collection>` | Call data.list, data.get. |
| `data:read:notes` | Call store.list. |
| `data:write:<collection>` | Call data.put, data.delete. |
| `data:write:notes` | Call store.put. |
| `debug:read` | Call debug.recent, debug.app. |
| `files:<folder>` | Call files.read, files.write. |
| `history` | Call history.state, history.undo, history.redo. |
| `llm` | Call llm.providers, llm.models, llm.complete. |
| `network:<host>` | Call net.fetch. |
| `plugins:author` | Call authoring.copy, authoring.mine, authoring.save, authoring.remove, authoring.file. |
| `plugins:manage` | Call plugins.setEnabled. |
| `plugins:read` | Call authoring.source, authoring.check, plugins.app. |
| `router` | Call router.current, router.go. |
| `secret:<name>` | Call secrets.has, secrets.request, secrets.forget. |
| `share` | Call share.send, share.take. |
| `transfer` | Call transfer.collections, transfer.export, transfer.import. |
| `ui` | Call page.matches. |

Plugins written for the Markdown editor can use its permissions, which stand for these capabilities:

| Editor permission | Capabilities |
| --- | --- |
| `post:read` | `hook:listen:note:*` |
| `post:write` | `hook:intercept:data:beforeWrite` |
| `ui` | `ui` |

## Manifest

`export const manifest = { ... }` must be the module's first statement, a plain literal, read before any of the plugin's code runs.

| Field | Meaning |
| --- | --- |
| `id` | Required. Lowercase letters, digits and dashes, starting with a letter; at most 64 characters. A plugin with the same id replaces the one installed. |
| `name` | Required. The name the person sees. |
| `version` | Optional. Shown nowhere yet. |
| `description` | Optional. Shown as the name's tooltip in the plugins panel. |
| `permissions` | Required, may be empty. Capabilities, or editor-style permissions that stand for them (see Capabilities). |
| `order` | Optional. Where the plugin's views go among others in the same slot; lower comes first. |
| `scope` | "shared" (the default): one worker for every tab. "tab": one worker per open tab, for plugins that draw or keep view state. |
| `collections` | Optional. Up to 10 collections the plugin owns: { name: { title?, schema } }, each schema a JSON Schema subset (see Collections). The owner reads and writes its own without asking. |
| `settings` | Optional. Up to 30 settings, each { type, title?, description?, default?, enum? }; type is string, number or boolean, and enum (a list of choices) is for strings. The plugins panel builds the form. |
| `places` | Optional. Up to 20 places in the app's page, for pages with no slot to draw in: { name: { at, put, each? } }. `at` is a CSS selector run against the page (never inside another plugin's view); `put` is "before", "after", "prepend", "append", "replace" or "hide"; `each` uses every match, up to 200, instead of the first. Render to the name as to a slot. Needs the ui permission. See docs/guide/places.md. |
| `files` | Optional. Up to 20 other files next to the plugin that it needs, such as its templates and images: names like countdown.html, no folders. They are copied with it when a person adds it to an app. |

Reserved ids, which no plugin can take:

- `agents`
- `audio`
- `authoring`
- `bus`
- `commands`
- `data`
- `debug`
- `files`
- `history`
- `host`
- `kernel`
- `llm`
- `net`
- `notes`
- `page`
- `plugins`
- `review`
- `router`
- `secrets`
- `settings`
- `share`
- `storage`
- `store`
- `tools`
- `transfer`

Paths that belong to the platform, which no plugin can read or write through `files`: `plugins`, `plugin-data`, `plugins.json`, `grants.json`, `changes.json`, `notes.json`, `collections`, `user`, `user-plugins.json`, `secrets.json`.

## Collections

A plugin declares the collections it owns in its manifest, each with a schema, and reads and writes them through the `data` service without asking. Another plugin needs `data:read:<collection>` or `data:write:<collection>`, and its writes are reviewed. Every write runs `data:beforeWrite:<collection>` (a listener can block it) and then `data:changed:<collection>`; listening to either also needs `data:read:<collection>`. The kernel keeps `id`, `createdAt`, `updatedAt` on every record. Records are kept with the app's data in `collections/<name>.json`.

Schemas are a JSON Schema subset:

| Keyword | Notes |
| --- | --- |
| `type` | string, number, integer, boolean, array or object |
| `title` | The label forms and tables show |
| `description` |  |
| `default` | What a new record's form starts with |
| `enum` | A fixed set of choices; forms show a menu |
| `properties` | The fields of an object |
| `required` | Fields that must be filled in |
| `items` | The schema of each item in an array |
| `minimum` | Numbers |
| `maximum` |  |
| `minLength` | Strings |
| `maxLength` | Over 200 makes a form show a text area |
| `format` | date, date-time, email or uri; forms use the matching input |
| `x-multiline` | true makes a form show a text area |

Views bind to a collection with `<ui-table collection="…">` and `<ui-form collection="…">` (see Components), acting with the rights of the plugin that drew them.

## HTML views

Plugins describe UI as plain HTML, up to 200,000 characters. The host parses it inertly and keeps only what is listed here: no script, no style attributes, no frames, no event attributes. Unknown elements are unwrapped, so their text stays. Styling comes from the app's design tokens, so plain HTML already looks like the rest of the app; `class` is for a template file's own `<style>`, which reaches only that plugin's views. Images load from https: only for plugins with the `network` capability; others can use data: images.

### Components

| Element | Attributes | What it does |
| --- | --- | --- |
| `<ui-stack>` | direction="row", gap="1"…"6", align="start\|center\|end\|stretch", justify="start\|center\|end\|between", wrap | Lays its children out in a column (or a row) with even spacing. |
| `<ui-grid>` | min="12rem", gap="1"…"6" | As many columns as fit, each at least `min` wide. |
| `<ui-card>` | tone="accent\|ok\|warn\|danger" | A bordered surface for one thing. |
| `<ui-badge>` | tone="neutral\|accent\|ok\|warn\|danger" | A short status word. |
| `<ui-stat>` | label, value, delta, tone | A number with its label, and an optional change. |
| `<ui-empty>` | heading | What to show when there is nothing yet; put a sentence and a button inside. |
| `<ui-table>` | collection, columns="title,author", sort="title\|-title", empty, row-action, deletable | A sortable table of a collection's records, kept up to date. The first column becomes a button that sends `row-action` with the record's id; `deletable` adds a Delete button. Acts with the rights of the plugin that drew it. |
| `<ui-form>` | collection, fields="title,author", record, submit, action | A form built from the collection's schema: labels, input types, required fields and errors from the kernel's checks, beside the control they are about. A list field gets a row per item with Add and Remove buttons, and a group gets a fieldset, two levels deep. Saves a new record, or edits `record`; sends `action` with the saved record's id. |
| `<ui-toolbar>` |  | A row of controls that wraps, with the last group pushed to the end by a ui-spacer. |
| `<ui-spacer>` |  | Takes up the free space in a row. |
| `<ui-code>` | name, label, rows="20", readonly, revision | A plain code editor: a textarea with line numbers, where Tab indents (Escape, then Tab, leaves it). Its text content is the starting code; edits survive redraws until `revision` changes. In a `form` it is sent under its `name`. |
| `<ui-commands>` | label, open-keys="Mod+K", run, no-button, message, message-at | A command palette: a button (and the `open-keys` shortcut) opens a searchable list of the commands inside it, each a `<button data-command="name" data-keys='["Mod+B","Shift+N"]' data-group data-description>Title</button>`. Picking one, or pressing one of its keys anywhere on the page, sends `run` with its name. `message` is announced briefly whenever `message-at` changes. |
| `<ui-debug>` | corner="bottom-left\|bottom-right\|top-left\|top-right\|inline", problems, label, toggle | A bug button that stays on screen and opens a panel holding the element's content. `problems` is a count shown on the bug; `toggle` is sent with true or false as the panel opens and closes. A button inside with `data-copy="name"` copies the text of the element with `data-copy-source="name"`, headed with the page's address, browser and time. |

### Actions

- A click on an element with `data-action` sends that action, with `data-value` as the value if it has one.
- An `input`, `select` or `textarea` with `data-action` sends it when the change is committed, with the new value (a boolean for a checkbox, a number for a number). Add `data-live` to send it as the person types, after a 300 ms pause.
- A `form` with `data-action` sends it on submit, with `{ name: value }` for every named field.
- A submit button with `data-action` of its own, in such a form, sends its action instead, with the same fields.
- Give repeated elements a `key` attribute so an update moves them instead of redrawing them; focus, typing and scroll survive updates either way.

### Plain elements

Allowed on every element: `title`, `role`, `hidden`, `lang`, `dir`, `tabindex`, `key`, `class`, `aria-*` and `data-*`. Input types: `text`, `search`, `email`, `url`, `tel`, `number`, `range`, `date`, `time`, `datetime-local`, `month`, `week`, `color`, `checkbox`, `radio`, `hidden`.

| Element | Its own attributes | Notes |
| --- | --- | --- |
| `<div>` |  | A block |
| `<span>` |  | An inline run |
| `<p>` |  | A paragraph |
| `<h1>` |  | Headings; the host styles them to the app's scale |
| `<h2>` |  |  |
| `<h3>` |  |  |
| `<h4>` |  |  |
| `<strong>` |  | Text styles |
| `<em>` |  |  |
| `<small>` |  |  |
| `<code>` |  |  |
| `<pre>` |  |  |
| `<kbd>` |  |  |
| `<mark>` |  |  |
| `<s>` |  |  |
| `<sub>` |  |  |
| `<sup>` |  |  |
| `<br>` |  |  |
| `<hr>` |  |  |
| `<blockquote>` |  |  |
| `<a>` | `href` | A link; opens in a new tab. href must be https:, http:, mailto:, # or relative. A relative one (book/42, ./) stays on this site and opens in the same tab: a link to a screen of the app moves to it without loading the page (see the router service) |
| `<img>` | `src`, `alt`, `width`, `height`, `loading` | An image; src must be https: (with the network permission), a data: image, or a file next to the plugin's template file |
| `<figure>` |  |  |
| `<figcaption>` |  |  |
| `<ul>` |  | Lists |
| `<ol>` | `start`, `reversed` |  |
| `<li>` |  |  |
| `<dl>` |  |  |
| `<dt>` |  |  |
| `<dd>` |  |  |
| `<table>` |  | Tables; styled to the app's tokens |
| `<caption>` |  |  |
| `<thead>` |  |  |
| `<tbody>` |  |  |
| `<tfoot>` |  |  |
| `<tr>` |  |  |
| `<th>` | `colspan`, `rowspan`, `scope` |  |
| `<td>` | `colspan`, `rowspan` |  |
| `<section>` |  | Grouping |
| `<header>` |  |  |
| `<footer>` |  |  |
| `<article>` |  |  |
| `<aside>` |  |  |
| `<nav>` |  |  |
| `<details>` | `open` | A disclosure, with summary |
| `<summary>` |  |  |
| `<form>` | `novalidate` | A form; with data-action, submitting it sends the action with every named field's value |
| `<label>` | `for` | Form controls; with data-action, a change sends the action with the new value |
| `<input>` | `type`, `name`, `value`, `placeholder`, `checked`, `disabled`, `readonly`, `required`, `min`, `max`, `step`, `minlength`, `maxlength`, `pattern`, `autocomplete`, `id` |  |
| `<select>` | `name`, `disabled`, `required`, `multiple`, `id` |  |
| `<option>` | `value`, `selected`, `disabled` |  |
| `<textarea>` | `name`, `placeholder`, `disabled`, `readonly`, `required`, `rows`, `minlength`, `maxlength`, `id` |  |
| `<button>` | `type`, `disabled`, `name`, `value` | A button; with data-action, a click sends the action (and data-value, if set) |
| `<fieldset>` | `disabled` |  |
| `<legend>` |  |  |
| `<progress>` | `value`, `max` |  |
| `<meter>` | `value`, `min`, `max`, `low`, `high`, `optimum` |  |
| `<time>` | `datetime` |  |
| `<abbr>` |  |  |

## Views and slots

| View | Shape |
| --- | --- |
| `html` | { html }: plain HTML (see HTML views). The usual way to build UI; a string passed to ctx.ui.render becomes one. |
| `template` | { src, id, data? }: a template from an .html file next to the plugin, filled with data. Made by ctx.ui.views(file).render(). |
| `stack` | { children, direction? }: views in a column, or a row. |
| `heading` | { text } |
| `text` | { text, title?, tone? }: tone is muted, error or ok. |
| `button` | { label, action, primary? }: sends `action` when pressed. |
| `list` | { items: [{ label, action, selected? }] } |
| `textarea` | { name, value, action, placeholder? }: sends `action` with the text as the person types. |
| `canvas` | { id, width, height }: the plugin receives an OffscreenCanvas through ctx.ui.onCanvas. |
| `diff` | { lines: [{ op, text }] }: a line diff; op is same, add or del. |
| `field` | { name, label, kind, value, action, options?, description? }: kind is text, number, checkbox or select; sends `action` with the new value. |

| Slot | Where |
| --- | --- |
| `nav` | The column on the left. |
| `main` | The middle of the page. Review cards appear here too. |
| `side` | The column on the right, where the plugins panel is. |
| `status` | The bar at the bottom. |
| `devtools` | Inside the trace panel, under its buttons. |

## Commands

For devtools and tests, from the page: `window.__host.command(name, arg)`.

| Command | What it does |
| --- | --- |
| `bench` | (n) Times a hook round trip to a plugin worker against one answered in the kernel. |
| `reload-test` | (n) Reloads word-count n times and counts listeners and workers before and after. |
| `reload` | (id) Restarts a plugin's workers. |
| `install` | (source) Installs a plugin and keeps it with the data. |
| `uninstall` | (id) Removes a plugin kept with the data. |
| `trace` | () The most recent trace events. |
| `changes` | () The change log. |
| `reference` | () This reference, as { data, markdown }. |
| `user:list` | ({ app }) The person's own plugins for an app: each file, its manifest's id, name, permissions and places, and whether it is on. |
| `user:add` | ({ app, files: [{ name, data }] } or { app, url }) Adds plugins (.js) and the files they bring to an app's user folder; from a URL on this site, the files its manifest lists come too. They start off. |
| `user:on` | ({ app, id }) Turns a user plugin on, and opens the app again in every tab that has it open. |
| `user:off` | ({ app, id }) Turns a user plugin off, and opens the app again in every tab that has it open. |
| `user:remove` | ({ app, id }) Removes a user plugin and the files it lists. |
| `place:ask` | ({ app, plugin, place, target, what }) Asks the person, on a review card, to let a plugin change a place the author marked review. |
| `place:unlock` | ({ app, plugin, place }) Lets a plugin into a place the author locked, because the person said so. |
| `place:lock` | ({ app, plugin, place }) Takes that back. |
| `route` | ({ method, path, query, form }) Answers a request with the plugin route for it, or null. The service worker sends these through a tab. |
