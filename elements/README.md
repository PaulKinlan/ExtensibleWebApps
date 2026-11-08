# Elements

The `ui-*` custom elements that views are built from. Each element is one
file, named after its tag, and the browser runs it as written: there is no
build step. The host loads an element the first time a view uses it
([`src/host/elements.ts`](../src/host/elements.ts)).

An element file holds a `<template>`, which becomes the element's shadow root
and carries its style, and, if the element needs behaviour, a module script
whose default export is the element's class. There are three kinds:

| Kind | Example | How it works |
| --- | --- | --- |
| Template only | [`ui-stat.html`](ui-stat.html), [`ui-card.html`](ui-card.html) | No script. Attributes style it through `:host([tone="ok"])` selectors, and each `{{name}}` in the template is filled, as text, from the attribute of that name. |
| Template and inline script | [`ui-grid.html`](ui-grid.html) | A short `<script type="module">` in the file exports the class. It runs from a `blob:` URL, so it can't import other files. |
| Template and linked script | [`ui-table.html`](ui-table.html) + [`ui-table.js`](ui-table.js) | `<script type="module" src="ui-table.js">`. Use this for anything longer than a few lines: the `.js` file gets editor support and `// @ts-check` type checking (`npm run typecheck`). |

A class with a script reads its template from `this.constructor.template`,
which the host sets from the file before defining the element.

## Bound elements

[`ui-table`](ui-table.html) and [`ui-form`](ui-form.html) show and change a
collection's records, with the rights of the plugin whose view they sit in.
They share [`bound-element.js`](bound-element.js), which asks the host for
data with three DOM events (`ui-owner`, `ui-bind`, `ui-save`). The host works
out the plugin from where the element sits, so the element files import
nothing from the host and can't act for another plugin.

## Form fields

[`ui-code`](ui-code.html) is a form-associated element: in a
`<form data-action>` it is sent with the other fields under its `name`, like
a textarea. Its text content is the starting value, and a redraw keeps what
the person typed until the view changes its `revision` attribute.

## Documents and diagrams

[`ui-markdown`](ui-markdown.html) draws a Markdown file, and
[`ui-diagram`](ui-diagram.html) a Mermaid diagram written as its text. Both
build their DOM from the text, so nothing in a file can run. The parsing is
in [`markdown.js`](markdown.js), and [`mermaid.js`](mermaid.js) loads Mermaid
from [`/vendor/mermaid/`](../vendor/mermaid/) the first time a page has a
diagram to draw. The docs at `/docs/` ([`docs/app.html`](../docs/app.html))
are drawn this way.

## Adding an element

1. Write `elements/ui-name.html` with a `<template>`.
2. Add a script only if attributes and `{{holes}}` aren't enough.
3. List the tag and its attributes in [`src/shared/html.ts`](../src/shared/html.ts), so the sanitiser lets views use it.
