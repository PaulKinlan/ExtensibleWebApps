# Editors, and a folder of files

A writing app is mostly one big text box that other plugins want to hear and
change: a word count wants every edit, a spell checker wants to underline, an
image plugin wants pastes and drops. This page shows the pieces the platform
gives you for that, as the [Markdown editor](../../demos/markdown-editor/) uses
them: editor events from a text box, the `<ui-editor>` element, and the
`folder` service for the files being edited.

## Editor events: selection, paste and drop

A `textarea` view sends what the person types as its `action`, after a pause.
It can send three more things, each to an action you name:

```js
ctx.ui.render("main", "editor", {
  type: "textarea", name: "text", value: draft, action: "edit",
  selectionAction: "select",   // { from, to, text } when the selection settles
  pasteAction: "paste",        // a paste, instead of going in
  dropAction: "drop",          // a drop from outside, instead of going in
});
```

A paste or a drop comes to your plugin as `{ from, to, text, html, files }`,
and the browser doesn't put it in: your plugin decides what goes in, and puts
it in its own text, which the next redraw shows. `files` are what was pasted
or dropped, each `{ name, type, size }` with `text` (for a text file) or
`dataUrl` (for an image), up to 2 MB each. Offsets count characters in the
whole text. The host side is [`src/host/editing.ts`](../../src/host/editing.ts).

The plugin that owns the text usually runs each event through a hook of its
own ([Hooks of your own](plugin-hooks.md)), so other plugins can change what
goes in. The workbench's notes plugin
([`site/workbench/plugins/notes.js`](../../site/workbench/plugins/notes.js))
does: `notes:selection` is told of each selection, and `notes:paste` and
`notes:drop` are waterfalls whose listeners can change the text or block it.

```js
export const manifest = { id: "shouty", name: "Shouty paste", permissions: ["hook:intercept:notes:paste"] };
export default (ctx) => ctx.on("notes:paste", (paste) => ({ text: paste.text.toUpperCase() }));
```

## `<ui-editor>`: a Markdown editor element

[`<ui-editor>`](../../elements/ui-editor.html) is CodeMirror in an element,
for a template view. It is a form field like `<ui-code>`, and sends the same
editor events:

```html
<ui-editor name="text" label="{{title}}" action="edit" selection-action="select"
  paste-action="paste" drop-action="drop" revision="{{revision}}"
  select="{{select}}" annotations="{{annotations}}">{{text}}</ui-editor>
```

- Its text content is the text to start with. A redraw keeps what the person
  typed until `revision` changes; then the new text goes in as an edit, so
  undo, the selection and the scroll position survive a plugin's change.
- `select="from,to"` selects that range and scrolls to it each time it changes
  (add a counter, `from,to,n`, to select the same range again).
- `annotations` is a JSON list of `{ from, to, severity, message }` to
  underline, with the message on hover: a long sentence, a broken link.

CodeMirror itself is in [`vendor/codemirror/`](../../vendor/codemirror/),
loaded the first time a page draws an editor.

## The `folder` service: files on the person's disk

The `folder` kernel module ([`std/folder/module.ts`](../../std/folder/module.ts))
is one folder of files a person works on, such as a Hugo site. Until they
pick one of their own, it is a private folder in this browser. When they pick
one (`folder.choose`, right after a click), the files stay where they are and
are read and written in place. After a reload the browser asks again before
the folder can be used: `folder.about()` says `allowed: false`, and
`folder.allow()`, after a click, asks.

| Method | Needs |
| --- | --- |
| `about()`, `list(prefix?)`, `entries(path?)`, `read(path)` | `folder:read` |
| `write(path, text)` | `folder:write` |
| `propose(path, text, reason)`: the person sees a diff and allows it | `folder:propose` |
| `choose()`, `allow()`, `forget()` | `folder:choose` |

A path is relative to the folder. It can't climb out of it (`..`), and can't
reach `.git` or `.env` files. Listings leave out hidden files and the build
folders a site keeps (`node_modules`, `public`, `resources`, `dist`). The
[API reference](../api.md#folder) has each method.

Give `folder:write` only to the plugin that keeps the files, the way the
editor's `posts` plugin does, and have the others change the text through a
service it provides. In the editor that is `document`: `read`, `annotate`,
`select`, `applyEdits`, `insert`, `setFrontMatter` and `save`
([`posts.js`](../../demos/markdown-editor/posts.js)). A plugin that must
write a file of its own asks with `folder.propose`.

## The Markdown editor, as an example

[How the Markdown editor is built](markdown-editor.md) takes it apart in full, with diagrams.

[`demos/markdown-editor/`](../../demos/markdown-editor/) is the editor from
[MarkdownEdiitor](https://github.com/PaulKinlan/MarkdownEdiitor), with each
of its extensions written again as a plugin. `posts` opens a post in a
`<ui-editor>`, and runs `posts:open`, `posts:change`, `posts:save`,
`posts:selection`, `posts:paste`, `posts:drop` and `posts:before-save`. Every
other feature is a file that listens to those and calls `document`: the
status bar items, the underlines, the outline and the pickers. Each feature's
report is a command with arguments, so the `writer` agent can run it as a
tool, and each quick edit is a command that asks `writer` over the bus.
