# Mermaid

[Mermaid](https://mermaid.js.org/) 11.17.2, as published on npm
(`mermaid/dist/mermaid.min.js`), unchanged. MIT licensed: see [LICENSE](LICENSE).

It draws the diagrams in the docs. Nothing loads it until a page shows one:
[`elements/mermaid.js`](../../elements/mermaid.js) adds it to the page the
first time a `<ui-diagram>`, or a ```` ```mermaid ```` block in a
`<ui-markdown>`, needs it.

It is kept here, not fetched from a CDN, so the docs work offline and from
this site alone. To update it:

```sh
npm pack mermaid@<version>
tar xzf mermaid-<version>.tgz
cp package/dist/mermaid.min.js package/LICENSE vendor/mermaid/
```

and change the version above.
