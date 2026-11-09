# Hooks of your own

The kernel's hooks say what happened in the kernel: a record was written, a command ran, an agent woke. A plugin can define hooks too, for what happens in its own app: a note was opened, an order was placed, a song is about to play. Other plugins listen to them exactly as they listen to the kernel's, through the gate, with the same capabilities.

The notes app on the workbench ([`site/workbench/plugins/notes.js`](../../site/workbench/plugins/notes.js)) is a plugin like any other, and this is how the word count, Tidy and the Markdown editor's extensions hear what the person does in it.

## Defining hooks

List them in the manifest's `hooks`, by key:

```js
export const manifest = {
  id: "notes",
  name: "Notes",
  permissions: ["ui"],
  hooks: {
    open: { mode: "emit", args: "{ id, title, text }", description: "The person opened a note." },
    publish: { mode: "serial", timeoutMs: 2000, agentTimeoutMs: 20000, description: "Before a note is published. Return { block: reason } to stop it." },
  },
};
```

Each key becomes a hook named `<id>:<key>`, so these are `notes:open` and `notes:publish`. Keys are lowercase letters, digits and dashes.

- **`mode`** is one of the kernel's dispatch modes. `emit` and `parallel` only tell; `serial`, `bail` and `waterfall` wait for answers (see [the API reference](../api.md#dispatch-modes)).
- **`args`** and **`description`** are for readers: the reference and the plugin editor show them.
- **`timeoutMs`** is how long each listener has to answer a hook that waits, 1 s if you leave it out, at most 5 s.
- **`agentTimeoutMs`** lets an [agent](agents.md) check the hook (`- check: notes:publish`), with that long to answer, at most 30 s. Without it, agents can't check the hook, which keeps it fast.
- **`onFailure`**: `"open"` (the default) skips a listener that fails or runs out of time; `"closed"` treats it as a block.

These limits (20 hooks, 1 s, 5 s, 30 s, and 1 MB of JSON for a value sent with `ctx.hooks`) are the platform's defaults. A site that needs others sets them in its [`kernel.json`](../../kernel.json), beside its modules, and the build refuses a name it doesn't know or a value that isn't a whole number above 0:

```json
{
  "modules": ["…"],
  "hooks": { "max": 20, "defaultTimeoutMs": 1000, "timeoutMs": 10000, "agentTimeoutMs": 60000, "maxValue": 1000000 }
}
```

A plugin can define up to 20 hooks. They last while the plugin is installed: removing it removes them, and a new version of it with different hooks replaces them. A plugin whose id starts one of the kernel's own hooks (`data`, `agent`, `commands`, …) can't define any, so no plugin can pass for the kernel.

## Running them

Only the plugin that defines a hook can run it, so no other plugin can say a note was opened when it wasn't:

```js
// Tells every listener; nothing comes back.
await ctx.hooks.emit("open", { id: note.id, title: note.title, text: note.text });

// Asks each listener in turn; one can stop the action.
const verdict = await ctx.hooks.call("publish", { id: note.id });
if (verdict?.block) status = `Not published: ${verdict.block}`;
```

`emit` is for `emit` and `parallel` hooks, `call` for the rest. A `bail` hook gives back the first answer, and a `waterfall` gives back the value as its listeners changed it. Every run carries the trace of the action that caused it, so the trace and the hook tracer show it with everything else that action did.

## Listening to them

Another plugin listens with `ctx.on`, and asks for the capability in its manifest, as for any hook:

```js
export const manifest = {
  id: "word-count",
  name: "Word count",
  permissions: ["ui", "hook:listen:notes:open", "hook:listen:notes:save"],
};

export default function (ctx) {
  ctx.on("notes:open", (note) => draw(note));
  ctx.on("notes:save", (note) => draw(note));
}
```

`hook:listen:<hook>` covers `emit` and `parallel` hooks, and `hook:intercept:<hook>` the ones that can change or stop an action. `hook:listen:notes:*` covers every hook the notes plugin tells.

A plugin may listen before the plugin that defines the hook is installed: its listener waits, and starts hearing the hook once that plugin arrives. Apps can load their plugins in any order. Listening to a hook nobody will define is never an error, so check the name.

The workbench's [`word-count.js`](../../site/workbench/plugins/word-count.js) and [`edit-times.js`](../../site/workbench/plugins/edit-times.js) listen to `notes:open`, `notes:change`, `notes:save` and `notes:close`, with `hook:listen:notes:*` in their permissions. The [Markdown editor](../../demos/markdown-editor/) does the same with its own `posts:*` hooks.

## Data and hooks

A plugin's collections have hooks already: every write to `notes` runs `data:beforeWrite:notes`, which can stop it, and then `data:changed:notes`. Use those for what happens to records, and hooks of your own for what the person does that isn't a write: opening, typing, publishing. [No shouting](../../site/workbench/plugins/no-shouting.js) stops a note written in capitals with `data:beforeWrite:notes`; [Tidy](../../site/workbench/plugins/tidy.js) follows the open note with `notes:open` and `notes:save`.
