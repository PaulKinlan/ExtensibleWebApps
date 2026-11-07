# API reference

Printed by the kernel from its own registries (`npm run reference` writes this file; the tests fail if it falls behind). Plugins can read the same thing as data with `ctx.call("kernel", "reference")`.

## The plugin's `ctx`

### ctx.call

`ctx.call(service, method, ...args) → Promise`

Needs: What the method needs (see Services).

Calls a kernel service. Rejects if the capability is missing, the method doesn't exist, or the service refuses.

### ctx.log

`ctx.log(text, level?)`

Needs: nothing.

Writes to the trace, as info or error.

### ctx.on

`ctx.on(hook, handler) → off()`

Needs: `hook:listen:<hook>` (emit, parallel) or `hook:intercept:<hook>` (serial, bail, waterfall).

Listens to a hook. In a `function` handler, `this` is a copy of ctx pinned to the action's trace. What it returns matters only for hooks that can change or stop an action.

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

### settings

The plugin's own settings, from the form the plugins panel builds out of its manifest.

#### settings.get

`settings.get()` → { [key]: value }

Needs: nothing.

The plugin's settings: saved values over the manifest's defaults.

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

## Hooks

### `bench:ping`

Used by the round-trip benchmark; answer with anything.

Mode: `serial`, 1000 ms per listener, fails open. Listening needs `hook:intercept:bench:ping`.

Listeners get `n`.

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
| `network` | Run in a worker whose policy allows fetch and WebSockets to https: hosts. Without it, a plugin can't connect anywhere. |
| `hook:listen:<hook>` | Listen to an emit or parallel hook. |
| `hook:intercept:<hook>` | Listen to a hook that can change or stop an action (serial, bail, waterfall). |
| `audio` | Call audio.registerProcessor, audio.play. |
| `data:read:notes` | Call store.list. |
| `data:write:notes` | Call store.put. |
| `files:<folder>` | Call files.read, files.write. |
| `debug:read` | Call debug.recent, debug.app. |
| `data:read:<collection>` | Call data.list, data.get. |
| `data:write:<collection>` | Call data.put, data.delete. |

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

Reserved ids: `kernel`, `host`, `notes`, `plugins`, `review`, `store`, `settings`, `storage`, `files`, `audio`, `data`, `debug`.

Paths that belong to the platform, which no plugin can read or write through `files`: `plugins`, `plugin-data`, `plugins.json`, `grants.json`, `changes.json`, `notes.json`, `collections`.

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
| `<ui-debug>` | corner="bottom-left\|bottom-right\|top-left\|top-right\|inline", problems, label, toggle | A bug button that stays on screen and opens a panel holding the element's content. `problems` is a count shown on the bug; `toggle` is sent with true or false as the panel opens and closes. A button inside with `data-copy="name"` copies the text of the element with `data-copy-source="name"`, headed with the page's address, browser and time. |

### Actions

- A click on an element with `data-action` sends that action, with `data-value` as the value if it has one.
- An `input`, `select` or `textarea` with `data-action` sends it when the change is committed, with the new value (a boolean for a checkbox, a number for a number). Add `data-live` to send it as the person types, after a 300 ms pause.
- A `form` with `data-action` sends it on submit, with `{ name: value }` for every named field.
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
| `<a>` | `href` | A link; opens in a new tab. href must be https:, http:, mailto: or # |
| `<img>` | `src`, `alt`, `width`, `height`, `loading` | An image; src must be https: or a data: image |
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
