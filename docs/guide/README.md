# Developer guide

How to build apps on this platform, from the first page to sharing data between apps. Read it in order the first time; each page stands on the ones before it. To start a project of your own, outside this repo, see [An app of your own](your-own-app.md).

1. [How an app works](how-an-app-works.md): the page, the kernel and the plugins, and what moves between them.
2. [Writing a plugin](writing-a-plugin.md): build the Habits app, one step at a time.
3. [Views and templates](views-and-templates.md): HTML views, template files, holes, loops, actions, components, and live views.
4. [Data and permissions](data-and-permissions.md): collections, schemas, forms and tables, what a plugin may do, and reviews.
5. [Styling](styling.md): design tokens, a plugin's own stylesheet, and how the page has the last word.
6. [Sharing data between apps](sharing-data-between-apps.md): one app reading another's collection, even before it exists.
7. [Routes and the service worker](routes.md): a plugin answering links, forms and fetches, and what the service worker does.
8. [Places](places.md): adding to, replacing or hiding part of an app that left no slot; the author's open, review and locked marks; and a person's own plugins.
9. [Tools for language models](tools.md): each service method a plugin may call, offered to a model as a tool and called through the gate.
10. [Agents](agents.md): a Markdown file an app links with `rel="agent"`, run as a plugin that wakes on hooks, commands, messages or topics, asks a model and calls its tools, or checks an action before it happens; the bus, where agents, plugins and the person send each other messages; agents that act for the person; and the standard assistant and builder.
11. [Commands and the command palette](commands.md): something a plugin can do, named once, and run from a palette, a shortcut or an agent.
12. [Slots in views, and view transforms](slots-and-transforms.md): a plugin leaving a room in its view for others, and a plugin changing another plugin's view.
13. [Hooks of your own](plugin-hooks.md): a plugin defining hooks in its manifest, which only it runs and others listen to, even before it is installed.
14. [Spaces, and plugins on a server](spaces-and-servers.md): an app shared by a group of people, each device with a copy that syncs; and plugins that run on the space's server, with public routes, schedules and email.
15. [Deploying one app on its own](deploying-an-app.md): one app as a Worker of its own, on its own address, in two commands.
16. [Loading fast, without jumping](loading-fast.md): what the host does so an app draws early and its page doesn't move while it fills in.
17. [The plugin registry](plugin-registry.md): plugins the site offers that no app links, which a person adds from Customize, with the plugins that provide the services they need.
18. [Making an app by describing it](making-apps.md): the app maker writes a whole app, page and plugins, from what a person describes, through review cards; checks it as it runs and fixes it; and keeps every version of every file.
19. [Outside agents: WebMCP and MCP](outside-agents.md): letting agents that aren't part of the app (the browser's own, Claude Code) use it, as WebMCP tools in the page and an MCP server on a space's server, with a plugin's permissions and the person's reviews.
20. [Editors, and a folder of files](editors.md): a text box's selection, pastes and drops sent to its plugin, the `<ui-editor>` Markdown element, and the `folder` service for files on the person's disk.
21. [How the Markdown editor is built](markdown-editor.md): a whole writing app taken apart: one plugin owns the post, the others hear it through hooks and change it through a service, and an agent uses their reports as tools; with diagrams of typing, pasting, saving and quick edits.
22. [Installing, offline, and opening files](installing-and-files.md): every app installs and opens offline with no work; an app installed from the browser as where a kind of file opens; and the policy every page is sent with (Trusted Types, no inline scripts, Permissions-Policy).
23. [Games and sound](games-and-audio.md): a game loop whose rules are plugins (systems on `game:update` and `game:rules`, drawn smoothly on a canvas in a worker), clips rendered through effects that are plugins, the `<ui-waveform>` element, and the app maker building on both.
24. [An app of your own](your-own-app.md): a project that is one app, its files at the top and the platform as a dependency, made with `npm create extensible-app`; served at `/` by `npm run dev`, and deployed at `/` by `npm run deploy`.
25. [Asking an agent to write a plugin](asking-an-agent.md): the skill that comes with the platform and with every new project, which tells Claude Code how to write a plugin here and check it; installing it anywhere; and the checks that keep it true to the platform.

Look things up in the [API reference](../api.md), which the kernel prints about itself, so it always matches the code. Every app in [`demos/`](../../demos/) is written to be read; each file starts with a comment saying what it shows.

If you are an AI agent building an app, start with [`AGENTS.md`](../../AGENTS.md); [`/llms.txt`](../../public/llms.txt) lists these pages for tools that read it.
