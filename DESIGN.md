# DESIGN.md

How things look here, and how to keep them looking right. Read this before you write or change anything a person sees: a plugin's view, a `ui-*` element, a demo, a page of the site. [Styling](docs/guide/styling.md) is the how-to for plugin authors; this file is the rules, and `npm test` holds every page to the ones it can measure.

## The idea

One look, set in one place. The platform's stylesheet ([src/host/styles.css](src/host/styles.css), served as `/platform/host.css`) holds the design tokens and styles plain HTML to them. A view written as plain HTML with no CSS of its own should already look finished. CSS in a plugin is for layout the defaults can't know (a calendar grid, a board's columns), not for restating how a button looks.

Warm paper neutrals, ink for the main action, the accent kept for links and focus, cards for sections, and no shadow on anything that doesn't float: that is the look. It is quiet, dense enough to work in, and legible to someone who has never seen the app. Developers and people who don't code both use these apps, so nothing relies on knowing what a control is called.

## Tokens

Use a token wherever one fits. A fixed value is a decision the next app, theme or dark mode can't change.

| Kind | Tokens | Use |
| --- | --- | --- |
| Space | `--space-1` 4px, `-2` 8px, `-3` 12px, `-4` 16px, `-5` 24px, `-6` 32px | Every gap, padding and margin. `-2` between controls in a row, `-3` between things in a section, `-6` between sections. |
| Type | `--text-sm` 13px, `-md` 15px, `-lg` 17px, `-xl` 21px, `-2xl` 30px | `-md` is body. One `h1` per page at `-2xl`, section headings (`h2`) at `-xl`. |
| Colour | `--bg`, `--bg-2`, `--surface`, `--fg`, `--fg-2`, `--border`, `--accent`, `--accent-fg`, `--action`, `--action-fg`, `--ok`, `--warn`, `--danger` | Page, sunken areas, raised areas, text, quieter text, lines, the accent (links, focus and selection only), the main button (ink by default), and meaning. Never a raw hex value outside a theme. |
| Size | `--control` 38px, `--control-sm` 30px | The height of every one-line control: buttons, fields, selects. The small one is for a button inside a table row or a list row. |
| Shape | `--radius-sm`, `--radius`, `--radius-lg`, `--shadow-1`, `--shadow-2`, `--ring` | Controls and cards use `--radius`; only things that float use `--shadow-2`. |
| Motion | `--duration`, `--ease` | Transitions only. |

A new token is added to `styles.css` and to the table in [Styling](docs/guide/styling.md), in the same change.

## Layout rules

1. **Say the direction.** Inside a view, a `<form>` or `<fieldset>` is already a column (`display: flex; flex-direction: column`). For a row of fields write `display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; gap: var(--space-2)`. `display: flex` on its own keeps the column, and a `flex: 1 1 12rem` meant as a width becomes a height.
2. **One-line controls are one line tall.** Buttons, fields and selects are all `--control` tall, so they line up side by side. Don't set a height on them; don't let a layout stretch them. Anything bigger on purpose (a game's touch pad) is listed with its reason in the layout check.
3. **A primary action is as wide as its words.** Only one main button (`type="submit"`, `data-primary` or `class="primary"`, drawn in `--action`) per form. Buttons sit in a row beside or under the field they act on, not stretched across the page.
4. **Space says what belongs together.** `--space-6` between sections, `--space-3` inside one, `--space-2` between controls. A heading is closer to what it heads than to what came before it.
5. **Links in a row need a gap.** Two links side by side go in a flex row with a gap, or a list. Words running into each other read as one link.
6. **Lists of things with actions are cards or rows.** Name first, then what you can do with it, on their own lines; not a bullet with buttons trailing after the text.
7. **Phones first.** Everything works at 390px wide with no sideways scroll. Rows wrap (`flex-wrap: wrap`); fixed widths are `min()` or `max-width`.
8. **Columns can shrink.** A page or view grid writes its columns as `minmax(0, 1fr)` (or gives the item `min-width: 0`), and anything that shows text a person or a file supplied sets `overflow-wrap: anywhere`. A bare grid column is as wide as its longest word, so one long address pushes the page off the screen.
9. **A panel over the page scrolls by itself.** Give the part that holds the content `overflow: auto; min-height: 0; overscroll-behavior: contain`, and give every box between it and the panel's edge `flex: 1; min-height: 0` (or a fixed height), so the content scrolls instead of being cut off and the page behind stays still.
10. **Text stays readable.** Body copy no wider than about 40rem. Nothing below `--text-sm`.

## Who styles what

Three levels, lowest first: the platform (`@layer platform`), each plugin's own `<style>` (`@layer plugins`, scoped by the host to that plugin's views), then the page's own CSS in no layer.

- **A plugin** styles only its own views, with classes, and can't reach the page or another plugin. The host scopes and cleans its CSS ([Styling](docs/guide/styling.md#a-plugins-own-stylesheet)).
- **A page** may set tokens and lay out its slots (`main`, `aside`, where each slot goes). It should not restyle what is inside a plugin's view with broad selectors such as `main input` or `main form`: that is how a page breaks a plugin it has never seen. To change one plugin, name it: `[data-plugin="month"] td`.
- **The platform's defaults** are written with `:where()` where a plugin must be able to override them easily, and must never assume which way a plugin's container flows.
- **A `ui-*` element** keeps its style in its shadow root and reads the tokens; its size comes from its container.

## What the layout check holds every page to

[tests/checks/layout-sanity.mjs](tests/checks/layout-sanity.mjs) opens the site's pages, every app in `demos/` and the signed-in account page, at 1280px, 1680px and 390px wide, and fails when:

- a one-line field, select or button is taller than 64px;
- the page scrolls sideways, as it is or once a long unbroken word is put in each view;
- two controls in the same view are drawn over each other;
- a control is drawn but squeezed to almost nothing.
- the page is scrolled to its end and a floating button (Customize, the debug button) still covers something to read or press;
- a panel that opens over the page (the homepage's docs, Customize) holds more than fits and can't be scrolled.

A new app in `demos/` is checked without being listed. A page that needs something signed in or filled in before most of it draws should be opened in that state there, as the account page is. If a page must break a rule, add it to `ALLOWED` in that file with the reason.

## What the style lint counts

[scripts/style-lint.mjs](scripts/style-lint.mjs) reads the CSS in every app, std plugin and element and notes each place a value is written by hand where a token exists: a raw colour (`#hex`, `rgb()`, `hsl()`, `oklch()`), and a `px` or `rem` size in `font-size`, `gap`, `padding`, `margin` or `border-radius`. `npm run check` prints the count for each app, and `npm run check -- --style` lists every one with its file and line.

- A note never fails `npm run check`. `npm test` fails when a folder has **more** than its number in [tests/style-baseline.json](tests/style-baseline.json), and a folder that isn't listed there, such as a new app, is held to none. Lower a folder's number when you clean it; never raise one.
- It leaves alone the fallback in `var(--token, fallback)`, anything under 4px, a `999px` pill, and a custom property that an `app.html` sets (a page is where a theme is written).
- When a value is what it is on purpose, say why on the same line: `/* design-ok: the game's own gold */`. A file that is all its own look starts its `<style>` with `/* design-ok-file: reason */`.
- For a tint, mix tokens instead of writing a colour: `color-mix(in srgb, var(--accent) 16%, transparent)`.

## Before you open a pull request that changes what a person sees

- Look at it at desktop and phone width, in light and dark. Take the screenshots and put them in the PR.
- Open the page in the state people use it in: signed in, with data, with an error showing.
- Search for the same pattern elsewhere when you fix one: a fault in one plugin's CSS is usually copied in its neighbours.
- `npm test` passes, including the layout check and the style baseline.
