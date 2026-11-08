# Developer guide

How to build apps on this platform, from the first page to sharing data between apps. Read it in order the first time; each page stands on the ones before it.

1. [How an app works](how-an-app-works.md): the page, the kernel and the plugins, and what moves between them.
2. [Writing a plugin](writing-a-plugin.md): build the Habits app, one step at a time.
3. [Views and templates](views-and-templates.md): HTML views, template files, holes, loops, actions, components, and live views.
4. [Data and permissions](data-and-permissions.md): collections, schemas, forms and tables, what a plugin may do, and reviews.
5. [Styling](styling.md): design tokens, a plugin's own stylesheet, and how the page has the last word.
6. [Sharing data between apps](sharing-data-between-apps.md): one app reading another's collection, even before it exists.
7. [Routes and the service worker](routes.md): a plugin answering links, forms and fetches, and what the service worker does.
8. [Places](places.md): adding to, replacing or hiding part of an app that left no slot; the author's open, review and locked marks; and a person's own plugins.
9. [Tools for language models](tools.md): each service method a plugin may call, offered to a model as a tool and called through the gate.
10. [Agents](agents.md): a Markdown file an app links with `rel="agent"`, run as a plugin that wakes on hooks or commands, asks a model and calls its tools.

Look things up in the [API reference](../api.md), which the kernel prints about itself, so it always matches the code. Every app in [`demos/`](../../demos/) is written to be read; each file starts with a comment saying what it shows.

If you are an AI agent building an app, start with [`AGENTS.md`](../../AGENTS.md); [`/llms.txt`](../../public/llms.txt) lists these pages for tools that read it.
