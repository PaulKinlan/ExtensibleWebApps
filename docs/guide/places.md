# Places: adding to an app that left no slot

An app's author lays out slots for the plugins they planned for. Everyone else, including a person adding their own plugin or an agent writing one for them, needs a way in that asks nothing of the author. That way is a **place**: a plugin points at the page's own HTML with a CSS selector and says what to put there.

```js
export const manifest = {
  id: "countdown",
  name: "Countdown",
  permissions: ["ui"],
  places: {
    days: { at: "h1[data-start]", put: "after" },
  },
};

export default async function (ctx) {
  ctx.ui.views("countdown.html").render("days", "days-left", { words: "12 days to go" });
}
```

A plugin renders to a place's name exactly as it renders to a slot. If the page has a `<slot name="days">`, the slot wins; otherwise the view goes to the place.

Try it in the [trip](../../demos/trip/app.html), [menu](../../demos/menu/app.html) and [invoice](../../demos/invoice/app.html) demos: each has no slots, and **Customize** (bottom left) adds the samples next to it.

## What a place can do

| `put` | What happens | When the plugin stops |
| --- | --- | --- |
| `before`, `after` | The view sits next to the matched element | The view goes |
| `prepend`, `append` | The view goes inside it, first or last | The view goes |
| `replace` | The view takes its place; the element is hidden while the view is there | The element shows again |
| `hide` | The element is hidden; no view | The element shows again |

- **`at`** is a CSS selector. It runs against the app's own page, never inside another plugin's view or the platform's panels.
- **The first match** is used. With **`each: true`**, every match is, up to 200, and each gets its own container. Render to `prices` to draw the same view in every one, or to `prices#2` for the third.
- **`page.matches`** tells the plugin what its place matched: each element's text and `data-*` attributes. The menu's currency plugin reads every price's `data-eur` this way, then draws a converted price in each:

  ```js
  const prices = await ctx.call("page", "matches", "prices");
  prices.forEach((price, i) => views.render(`prices#${i}`, "price", { converted: convert(price.data.eur) }));
  ```

- A view in a place is wrapped like any slot's view, with `data-plugin`, so the plugin's own `<style>` reaches it ([Styling](styling.md)).
- Turning a plugin off undoes everything its places did, so the page is back as the author wrote it.
- The platform's default app layout puts `<body>`'s own children (`header`, `main`, `aside`, `footer`) in a grid. A view placed right in `<body>`, before or after one of those, spans the page below them, so place inside `main` or `header` when the spot matters.

## Choosing a selector that lasts

A place is only as good as its selector. When the author edits the page, a selector that names something they chose keeps working; one that describes the layout breaks. Best first:

1. **An `id` or a slot name:** `#newsletter`.
2. **A `data-*` attribute** the author put there to be found: `[data-part=price]`, `h1[data-start]`.
3. **A landmark or role:** `header`, `nav`, `main`, `aside`, `footer`, `[role=search]`.
4. **A heading or a well-known element inside a landmark:** `main > h1`, `body > header`.
5. **Avoid** positions such as `div > div:nth-child(3)`. Customize flags them.

If you write apps, the kindest thing you can do for the people who will extend them is to give the parts they might care about an `id` or a `data-part`. That's a slot without the commitment.

A place that matches nothing draws nothing, and says so in Customize and the trace, so a broken place is visible rather than silent.

## Open, review and locked

The page is open by default. An author can mark an area with `data-extend` on any element. It covers the element and everything in it, and the nearest mark wins, so a locked section can hold an open part.

```html
<main>                                             <!-- no mark: open -->
  <section id="lines" data-extend="review">…</section>
  <section id="pay" data-extend="locked">…</section>
</main>
```

| Mark | Any place there |
| --- | --- |
| none, or `open` | is drawn |
| `review` | waits for the person, on a card that says what the plugin wants to change; they allow it once, always, or decline |
| `locked` | is refused, and Customize says so |

- **Which element's mark counts.** `before` and `after` change the matched element's parent, so the parent's mark applies. `prepend`, `append`, `replace` and `hide` change the element itself, so its own mark applies. A note after a locked paragraph is fine; changing the paragraph is not.
- **Lock very little.** Lock what a change could make misleading or unsafe: a payment button, legal text. Mark `review` where a plugin could get in the way, like a form that saves. Leave everything else open.
- **The person has the last word.** In Customize they can unlock a locked area for one plugin, after a warning that names what the author locked. That is the point of malleable software: the author's marks are advice the platform enforces, not a wall.
- **Slots aren't affected.** A slot inside a locked area still takes the views of plugins the author linked, because the author offered it.

## A person's own plugins

The author lists their plugins in `app.html` with `<link rel="plugin">`. A person adds theirs without touching the app's files:

1. **Customize** (bottom left of every app) adds a plugin by picking its files, pasting its code, or from a URL on the site. An author can suggest some with `<link rel="plugin-sample" href="…" title="…">`; they show as buttons there.
2. The files go into the person's data folder on this device, at `user/<app folder>/`: `user/demos/trip/countdown.js`. A plugin added from a URL brings the files its manifest lists in **`files`**, such as its templates and images:

   ```js
   files: ["countdown.html", "tram.svg"],
   ```

3. A plugin that is added **starts off**. Customize shows what it asks for and where it draws, and the person turns it on.
4. The service worker serves the folder at `/user/<app folder>/`, so the plugin's templates and images load like any other file. An image next to a template (`<img src="tram.svg">`) is the plugin's own, so it needs no network permission.

Customize is on in every app. An author who doesn't want the button (a kiosk, say) adds `<meta name="customize" content="off">` to `app.html`, which also leaves out inspect mode. The person still has the last word: opening the app with `?customize` brings the button back.

Customize is itself a standard plugin, [`std/customize.js`](../../std/customize.js), which the host adds to every app with a `customize` slot pinned to a corner. It runs sandboxed like any other and does everything through the kernel's `authoring` service ([`src/kernel/authoring.ts`](../../src/kernel/authoring.ts)), so adding, removing or sharing a plugin waits for the person to accept a review card that shows its code; turning one on or off doesn't. Code pasted into it is turned on once its review is accepted. An agent, or a Customize of your own, can do the same with `plugins:author` and `plugins:manage`.

**In a space, a person can share one with its members.** A plugin someone adds to an app they opened in a space (at `/s/<space>/…`) is theirs alone, until they press **Share with the space** in Customize. Then it is a space plugin: it goes to every member's browser, for that app in that space, turned off. Each person sees what it asks for and decides for themselves. When someone changes it, it arrives off again; when anyone removes it, it goes from everyone's device; and **Stop sharing** makes it its owner's own again. It never runs on the space's server. So an app has developer plugins (`app.html`), space plugins and user plugins; [Servers: space plugins](../server.md#space-plugins) has how it works.

User plugins run with the same rules as any other: their own worker, only what their manifest asks for, and a review card before they change data they don't own. No plugin can add another by writing files: `user/` belongs to the platform.

## What places aren't for

- **Changing another plugin's view**, on its own. A place reaches the author's page unless it names a plugin with `in`, which needs `ui:transform:<plugin>`: see [Slots in views, and view transforms](slots-and-transforms.md).
- **Picking a place by pointing.** Writing a selector is a developer's job. A person who isn't one uses **inspect mode**, from Customize: they point at a part of the page, see which plugin drew it, and hide it or add a note beside it. Inspect mode writes the place for them, as a plugin of their own that Customize lists.
