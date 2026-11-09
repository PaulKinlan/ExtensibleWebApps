# CodeMirror

[CodeMirror 6](https://codemirror.net/), bundled into one ES module,
`codemirror.js`, from these npm packages, unchanged: `@codemirror/state`
6.5.2, `@codemirror/view` 6.36.8, `@codemirror/commands` 6.8.1,
`@codemirror/language` 6.11.0, `@codemirror/lang-markdown` 6.3.2,
`@codemirror/search` 6.5.10 and `@lezer/highlight` 1.2.1. MIT licensed: see
[LICENSE](LICENSE).

It is the editor inside [`<ui-editor>`](../../elements/ui-editor.html).
Nothing loads it until a page draws one: [`elements/ui-editor.js`](../../elements/ui-editor.js)
imports it the first time.

It is kept here, not fetched from a CDN, so the editor works offline and
from this site alone, with no build step for apps. To update it, change the
versions in [`scripts/vendor-codemirror.mjs`](../../scripts/vendor-codemirror.mjs)
and here, then run:

```sh
node scripts/vendor-codemirror.mjs
```
