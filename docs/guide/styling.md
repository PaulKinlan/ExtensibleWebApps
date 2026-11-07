# Styling

Plain HTML already looks right: the platform's stylesheet styles headings, lists, tables, forms and the `ui-*` elements to the app's design tokens, in light and dark. Most views need no CSS at all. When one does, three levels decide how it looks, lowest first:

| Level | Where | Who writes it |
| --- | --- | --- |
| 1. `@layer platform` | `/platform/host.css` | The platform: tokens and defaults |
| 2. `@layer plugins` | A `<style>` in a plugin's template file | The plugin, for its own views only |
| 3. No layer | The page's own `<style>` or stylesheet | The app's author, who always wins |

So a plugin can style itself, and an app can restyle any plugin without the plugin's help.

## Design tokens

Use the tokens rather than fixed values, so a plugin fits any app that sets them and follows light and dark mode:

| Kind | Tokens |
| --- | --- |
| Colour | `--bg`, `--bg-2`, `--surface`, `--fg`, `--fg-2`, `--border`, `--accent`, `--accent-fg`, `--ok`, `--warn`, `--danger` |
| Space | `--space-1` (4px) to `--space-6` (32px) |
| Type | `--text-sm`, `--text-md`, `--text-lg`, `--text-xl`, `--text-2xl`, `--font`, `--mono` |
| Shape | `--radius-sm`, `--radius`, `--radius-lg`, `--shadow-1` |
| Motion | `--duration`, `--ease` |

An app changes the look of every plugin at once by setting tokens in its own `<style>`: `:root { --accent: rebeccapurple; }`.

## A plugin's own stylesheet

Put a `<style>` in the template file, outside the templates, and use classes in the templates:

```html
<style>
  .month { table-layout: fixed; }
  .month td { height: 5.5rem; vertical-align: top; }
  .month td[data-other] { color: var(--fg-2); opacity: 0.6; }
  @media (max-width: 40rem) { .month td { height: 3.5rem; } }
</style>
<template id="grid">
  <table class="month">…</table>
</template>
```

The host installs it as:

```css
@layer plugins {
  @scope ([data-plugin="month"] > *) {
    .month { table-layout: fixed; }
    …
  }
}
```

- **Scoped.** It reaches only views this plugin drew, so `.month td` can't touch another plugin's table, and another plugin's `.month` can't touch yours. Every view entry carries `data-plugin`, which only the host can set.
- **Contained.** Each entry has `contain: layout paint`, so nothing a plugin styles is drawn outside its own box, even with `position: fixed`. The scope starts inside the entry, so a plugin's CSS can't undo that.
- **Cleaned.** The browser parses the CSS, then the host keeps style rules (nesting included) and the `@media`, `@supports`, `@container` and `@layer` blocks around them. It drops `@import`, `@font-face`, `@keyframes`, any declaration that loads something (`url()`, `src()`, `image-set()`), and `!important`.
- **Below the page.** It sits under the page's own styles, so the app can override it.

Target state with attributes the template already sets, rather than extra classes: `[data-other]`, `[aria-current="date"]`, `[aria-invalid="true"]`. A [whole-hole attribute](views-and-templates.md#template-files) such as `data-done="{{h.today}}"` is there only when the value is true, so `[data-done]` matches exactly those rows.

Views built in code (`ctx.ui.html`) can use `class` too. They're styled by the page, or by the plugin's stylesheet once the plugin has drawn a template from that file, since the stylesheet is installed then.

## Restyling a plugin from the page

The page's own CSS is in no layer, so it beats both the platform and every plugin. Target a plugin's views by the entry's key or by its plugin:

```html
<style>
  [data-plugin="month"] td { height: 7rem; }         /* every view the month plugin draws */
  [data-key="agenda:agenda"] h3 { color: var(--accent); }   /* one view, by "<plugin>:<key>" */
</style>
```

## What a plugin can't do

- Set `style` attributes: they're removed. Use a class.
- Load fonts, images or other files from CSS.
- Style anything outside its own views: the page, the slots, or other plugins.
- Animate with `@keyframes`. Transitions work: `transition: opacity var(--duration) var(--ease)`.

Next: [Sharing data between apps](sharing-data-between-apps.md).
