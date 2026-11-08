# Slots in views, and view transforms

An app's page has `<slot name>` elements that plugins draw into ([How an app works](how-an-app-works.md)), and [places](places.md) let a plugin add to a page that left no slot. This page is about the next level in: one plugin's **view**.

- A plugin can **declare a slot** in its own view: a room it leaves for other plugins, with data saying what each one is for.
- A plugin can **transform** another plugin's view: add to it, replace part of it or hide part of it, with a place that runs inside that view. It needs a permission naming the plugin it changes.

Both are tried in the demos: the [recipes](../../demos/recipes/app.html) cookbook leaves a room on the open recipe that [`timer.js`](../../demos/recipes/timer.js) fills, and in [contacts](../../demos/contacts/app.html), [`next-meeting.js`](../../demos/contacts/next-meeting.js) adds each person's next calendar event to the birthdays list.

## Declaring a slot

Put a `<slot>` in the view, named with your plugin's id, a dot, and a name of your choosing. `data-*` attributes say what it is for:

```html
<!-- cookbook.html, in the cookbook plugin -->
<slot name="cookbook.recipe.actions" data-id="{{open}}" data-title="{{recipe.title}}" data-minutes="{{recipe.minutes}}"></slot>
```

- **The name must start with your plugin's id.** A slot named for another plugin is dropped (its content stays, as plain content), so nobody can open a room in your name, and a filler always knows whose room it is in.
- **What it holds is its fallback**, shown until a plugin draws there.
- **Repeat it** as often as you like: one per row of a list, say. Each gets its own data.
- **Your updates leave it alone.** When your view draws again, the slot's attributes change to match, but what other plugins drew inside stays put.

## Filling a slot

Render to the slot's name, as to any slot. That draws in every slot of that name. To draw something different in each, ask what each one is for with `page.slots`, then render to `<name>#<index>`:

```js
const slots = await ctx.call("page", "slots", "cookbook.recipe.actions");
slots.forEach(({ data }, i) => {
  ctx.ui.render(`cookbook.recipe.actions#${i}`, "timer", html`<button data-action="start" data-value="${data.minutes}">Start a ${data.minutes} minute timer</button>`);
});
```

When the slots of that name come, go or change (a recipe opens, the list grows), your plugin hears the event `slot:changed` with `{ slot }`, so it can ask again and draw again:

```js
ctx.ui.onEvent((action) => {
  if (action === "slot:changed") fill();
});
```

Filling a slot needs only the `ui` permission: the plugin that declared it offered it. The person's actions in your view come to you, not to the plugin whose view it is in.

## Transforming another plugin's view

A transform is a [place](places.md) with `in`, naming the plugin whose views it runs in. The selector runs only inside that plugin's views, never the page or any other plugin's view, and it needs the permission `ui:transform:<plugin>`, which the person sees when they install it:

```js
export const manifest = {
  id: "next-meeting",
  name: "Next meeting",
  permissions: ["ui", "ui:transform:birthdays", "data:read:events"],
  places: {
    meeting: { in: "birthdays", at: "li[data-name]", put: "append", each: true },
  },
};
```

Everything a place can do works here: `before`, `after`, `prepend`, `append`, `replace` and `hide`, with `each` for every match. `page.matches` says what each match is (its text and `data-*` attributes), and you render to `meeting#<index>`:

```js
const rows = await ctx.call("page", "matches", "meeting");
rows.forEach(({ data }, i) => ctx.ui.render(`meeting#${i}`, "next", html`<small>Next: …</small>`));
```

The plugin whose view it is keeps drawing as it always did. Each time it draws, the platform takes the transforms off, lets the update happen, and puts them back. If what a transform matches changed (a new row, a row gone), the transforming plugin hears `place:changed` with `{ place }`, so it can draw for each match again:

```js
ctx.ui.onEvent((action) => {
  if (action === "place:changed") draw();
});
```

- **Marks still count, but only the view's own.** A plugin can mark parts of its view `data-extend="review"` or `"locked"`, as an app's author marks the page ([Open, review and locked](places.md#open-review-and-locked)). The page's marks around the view don't apply inside it.
- **Turning the transform off** gives the view back exactly as its plugin drew it.
- **Components keep their insides.** A transform reaches the HTML a plugin drew, not the inside of a component such as `ui-table`, which draws its own rows.

## Helping others extend your views

Name the parts people might care about. A `data-*` attribute on each row (`<li data-name="{{b.name}}">`) gives a transform a selector that lasts and tells it which thing each row is about, without asking anything else of you. Where you know others will want to add something, declare a slot: it is a promise of room, with the data to fill it well.
