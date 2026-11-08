# Writing a plugin

This page builds the [Habits app](../../demos/habits/) from nothing: a list of habits, a box to tick each one off today, and a streak. It is one page and one plugin, in three files. Run `npm run dev` and open `http://localhost:5173/demos/habits/app.html` to see the finished one.

## 1. The page

Make a folder for the app and put an `app.html` in it:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Habits</title>
  <link rel="stylesheet" href="/platform/host.css">
  <script type="module" src="/platform/host.js"></script>
  <link rel="plugin" href="habits.js">
</head>
<body>
  <header><h1>Habits</h1></header>
  <main><slot name="main"><p>Loading your habits…</p></slot></main>
</body>
</html>
```

Open it now and you'll see "Loading your habits…": the slot's own content, shown until a plugin draws there. The plugin is next.

## 2. The manifest

A plugin is one ES module. Its first statement must be `export const manifest = { … }`, a plain literal. The kernel reads it as data before any of your code runs, and holds the plugin to it.

```js
export const manifest = {
  id: "habits",                 // lowercase letters, digits and dashes
  name: "Habits",               // what the person sees
  description: "Tick off today's habits, and keep a streak.",
  version: "1.0.0",
  permissions: ["ui"],          // draw views; nothing else
  collections: {
    habits: {                   // a collection this plugin owns
      title: "Habits",
      schema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", title: "Habit", maxLength: 80 },
          days: { type: "array", title: "Days done", items: { type: "string", format: "date" } },
        },
      },
    },
  },
};
```

- **`permissions`** are everything the plugin may do. `ui` lets it draw. A plugin always reads and writes the collections it owns; reading someone else's needs `data:read:<name>`, writing needs `data:write:<name>` and is reviewed by the person. The full list is in the [API reference](../api.md#capabilities).
- **`collections`** are typed records the plugin owns. Every write is checked against the schema, so a bad record never reaches disk. See [Data and permissions](data-and-permissions.md).
- Other fields: `order` (where your views go among others in the same slot), `scope` (`"tab"` for a worker per tab, for views with their own state, such as a canvas), `settings` (a form the plugins panel builds for you), `places`, `theme`, `hooks` (hooks of your own) and `runs` (`"server"` for a plugin that runs on a [space's server](spaces-and-servers.md)). See the [manifest reference](../api.md#manifest).

## 3. The view

Views are HTML templates in a file next to the plugin. Make `habits.html`:

```html
<template id="habits">
  <h2>Today</h2>
  <ul class="habits">
    <template for="h of habits">
      <li class="habit" key="{{h.id}}" data-done="{{h.today}}">
        <label><input type="checkbox" checked="{{h.today}}" data-action="tick:{{h.id}}"> {{h.name}}</label>
        <template if="h.streak"><ui-badge tone="ok">{{h.streak}}</ui-badge></template>
      </li>
    </template>
  </ul>
  <ui-card>
    <h3>Add a habit</h3>
    <ui-form collection="habits" fields="name" submit="Add habit"></ui-form>
  </ui-card>
</template>
```

- `{{h.name}}` is filled as text, never as HTML, so a habit called `<b>` shows those three characters.
- `checked="{{h.today}}"` is one whole hole, so the attribute is there when `h.today` is true and missing when it's false. That's how a template says "only sometimes".
- `<template for>` repeats; `<template if>` keeps or drops. There are no other expressions: logic stays in the script.
- `key="{{h.id}}"` lets an update move a row instead of redrawing it.
- `data-action="tick:{{h.id}}"` sends the action `tick:<id>` to your plugin when the box changes, with `true` or `false`.
- `<ui-form collection="habits">` is a form built from the collection's schema. It saves new habits by itself, with the schema's checks and error messages.

More in [Views and templates](views-and-templates.md).

## 4. The code

The module's default export gets a `ctx`. Every call on it is a message the kernel checks against the manifest.

```js
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default async function (ctx) {
  const views = ctx.ui.views("habits.html");

  // Draw the template with what this function returns, and draw it again
  // whenever what it read changes: here, any write to `habits`.
  views.live("main", "habits", async (ctx) => {
    const today = iso(new Date());
    const habits = await ctx.call("data", "list", "habits");
    return {
      habits: habits.map((h) => ({ id: h.id, name: h.name, today: (h.days ?? []).includes(today), streak: streak(h.days ?? []) })),
    };
  });

  // The person ticked a box: "tick:<id>", with true or false.
  ctx.ui.onEvent(async (action, value) => {
    if (!action.startsWith("tick:")) return;
    const habit = await ctx.call("data", "get", "habits", action.slice(5));
    const today = iso(new Date());
    const days = (habit.days ?? []).filter((d) => d !== today);
    await ctx.call("data", "put", "habits", { ...habit, days: value === true ? [...days, today] : days });
  });
}
```

Notice what isn't there: no redraw after the write. The write changes `habits`, the kernel tells every plugin that reads it, and the live view runs its function again. Any other plugin reading `habits`, in any tab, would redraw the same way.

The view also depends on something no collection reports: the date. `views.live` returns a handle, and the real `habits.js` calls its `refresh()` at each local midnight, so a tab left open overnight shows the new day. Use `refresh()` for anything a live view reads that isn't a collection or a setting.

(`streak()` is plain JavaScript; see [`habits.js`](../../demos/habits/habits.js).)

## 5. Style it

The template file can carry its own `<style>`, outside the templates. It reaches only this plugin's views, so `.habit` can't clash with anyone else's:

```html
<style>
  .habits { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
  .habit { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3);
           border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
  .habit[data-done] { border-color: var(--ok); }
</style>
```

Use the design tokens (`--space-2`, `--border`, `--ok`) so the plugin matches whatever app it's in, in light and dark. See [Styling](styling.md).

## 6. Check it

- **`npm run check`** reads your app without opening it, and says what to fix: a manifest that isn't a plain literal, a call your `permissions` don't allow, a template the code draws that isn't in the file, HTML the sanitiser would drop, a slot the page doesn't have. `npm run check demos/habits` checks one app.
- **The trace** on the workbench (`/workbench/`) shows every message from your plugin, every refusal, and anything you `ctx.log()`. A missing permission shows up there as `denied`. The [debugger](debugging.md#the-debugger), opened in another tab, shows the same for any app, with each plugin's permissions asked for, granted and refused.
- **The API reference** button on the workbench lists every call and what it needs; [`docs/api.md`](../api.md) is the same thing.
- **The tests**: `npm test` opens every app in `demos/` and checks that each plugin it links draws. Add checks of your own in a new file, `tests/demos/<app>.mjs`; [the Habits one](../../tests/demos/habits.mjs) adds a habit, ticks it and waits for the streak.

## Mistakes the kernel will catch

| You see | Because |
| --- | --- |
| `The module has no manifest`, or a manifest error with a line number | `export const manifest` isn't the first statement, or isn't a plain literal (no spreads, calls or template strings). |
| `denied` in the trace | The manifest doesn't ask for that permission. |
| An attribute or element missing from your view | The sanitiser removed it: no `style` attributes, scripts, iframes or event handlers. See the [allowed HTML](../api.md#html-views). |
| `Couldn't load habits.html` | The path, read relative to the plugin file, doesn't lead to that file, or the plugin isn't linked from an `app.html`. |
| A view that doesn't update | It was drawn with `render`, not `live`, and nothing draws it again. Use `live`, or call `render` again when your state changes. |

Next: [Views and templates](views-and-templates.md).
