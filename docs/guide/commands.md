# Commands and the command palette

A command is something a plugin can do, named once: "Start the next book", "Mark what I'm reading as done". The plugin that does it adds it, and then anything can run it: the [command palette](../../std/commands/palette.js), a keyboard shortcut, another plugin, or an agent through its tools. Nobody writes a separate button, shortcut handler and tool for the same action.

## Adding a command

```js
ctx.commands.add(
  { id: "start-next", title: "Start the next book", group: "Books", keys: ["Alt+N"] },
  async () => {
    // … move the book …
    return "Started Dune";
  },
);
```

- **`id`**: lowercase letters, digits and dashes. Others see it as `<plugin>/<id>`, such as `library/start-next`.
- **`title`**, and optionally **`description`** and **`group`**: what the palette shows, and what a model reads.
- **`keys`**: up to three shortcuts. Write modifiers and a key: `"Mod+K"` (Cmd on a Mac, Ctrl elsewhere), `"Alt+N"`, `"Shift+D"`, `"?"`. A shortcut without Ctrl, Cmd or Alt does nothing while the person types in a field.
- **`args`**: what the handler takes, as an object schema in the [collections' subset](../api.md). The kernel checks a run's arguments against it before the handler sees them. A palette leaves out commands with required arguments, since it can't fill them in. An agent can.
- **The handler** gets the arguments and `{ by }`, the plugin that ran it. What it returns goes back to whoever ran it; the palette shows a returned sentence to the person for a few seconds. Throwing fails the run with that error.

`add` returns `off()`, which removes the command. A command also goes when its plugin stops or is switched off. Adding one needs no permission: it only offers something the plugin can already do.

[`demos/reading-list/library.js`](../../demos/reading-list/library.js) adds three commands: two the palette shows, with shortcuts, and `library/add`, which takes a title, for agents.

## Running commands

A plugin with the `commands` permission lists the commands of its app and runs them:

```js
const commands = await ctx.call("commands", "list"); // [{ name, plugin, id, title, description?, keys?, group?, args? }]
const answer = await ctx.call("commands", "run", "library/add", { title: "Piranesi" });
```

`commands:changed` says when to list again. A command runs **with its own plugin's rights**, not the caller's. Running `library/finish` lets the library move its own books, just as the button would if the library drew one, so a plugin needs only `commands` to use the whole app through its commands. That is the point, and it is also why the next section exists.

## Stopping a run

Before each run the kernel raises `commands:before` with `{ name, plugin, id, args, by }`. A plugin with `hook:intercept:commands:before` may return `{ block: reason }` to stop it: a security agent could refuse anything an agent runs between midnight and six, or ask the person first. Afterwards `commands:ran` says what ran, who ran it and whether it worked, without the arguments.

## Commands as an agent's tools

The `commands` service describes its methods' arguments, so the [tools service](tools.md) offers `commands_list` and `commands_run` to any plugin with the `commands` permission. An agent with it can find what the app does and do it, with no tool written for that app:

```js
export const manifest = { id: "helper", name: "Helper", permissions: ["llm", "commands"] };
// tools.list() now includes commands_list and commands_run.
```

## The palette

[`std/commands/palette.js`](../../std/commands/palette.js) is a standard plugin. Add it to an app with two lines in its `app.html`:

```html
<link rel="plugin" href="/std/commands/palette.js">
<slot name="commands"></slot>
```

It draws a button in the slot, opens with Cmd K on a Mac or Ctrl K elsewhere (its settings change the shortcut, or hide the button), and runs each command's keys from anywhere on the page. On a phone the button is how it opens. The list, the search and the keys are the [`<ui-commands>`](../../elements/ui-commands.html) element, so another palette plugin can draw the same element with commands of its own choosing.

## How it works

`ctx.commands.add` sends two messages. `commands.add` gives the kernel the title, keys and arguments ([`src/kernel/services/commands.ts`](../../src/kernel/services/commands.ts)). A listener on `command:<id>` is where runs arrive; the kernel names that hook after the plugin's own instance ([`src/kernel/remote.ts`](../../src/kernel/remote.ts)), so no other plugin can listen for it, and a command is only listed while its plugin is listening. A plugin with one instance per tab answers runs from its own tab.
