# Glossary

The words these docs use, in alphabetical order, each with where to read more.

**Action.** What a view sends back when the person clicks a control with `data-action`, or submits a form that has one. It goes only to the plugin that drew the view, through `ctx.ui.onEvent`. See [Views and templates](guide/views-and-templates.md#actions).

**Agent.** A Markdown file an app links with `<link rel="agent">`, run as a plugin. It wakes on hooks, commands, messages or topics, asks a language model, and calls the tools its permissions allow. See [Agents](guide/agents.md).

**App.** A folder with an `app.html` that loads the platform and links its plugins. Its address is the folder (`/demos/habits/`), and every screen inside it is served the same page. See [How an app works](guide/how-an-app-works.md).

**Bus.** Where agents, plugins and the person send each other messages: to one recipient, to a topic, or as a question on the board. See [Agents](guide/agents.md#messages-topics-and-the-board).

**Capability.** One thing a plugin may do, such as `data:read:library`. A manifest's `permissions` list them, and the gate checks each message against them. See [Permissions](permissions.md).

**Change review.** The card the kernel shows the person before a plugin changes something it doesn't own. They accept it once, always allow it, or decline. See [The security model](security.md#4-the-person-decides-about-changes-to-what-isnt-the-plugins).

**Collection.** A set of records with a schema, declared and owned by one plugin. Every write is checked against the schema. See [Data and permissions](guide/data-and-permissions.md).

**Command.** Something a plugin can do, named once with `ctx.commands.add`, and run from the command palette, a keyboard shortcut or an agent. See [Commands](guide/commands.md).

**Component.** One of the host's own elements that views may use, such as `<ui-card>`, `<ui-table>` or `<ui-markdown>`. Each is a file in [`elements/`](../elements/). See [Views and templates](guide/views-and-templates.md#components).

**Customize.** The button on every app page where a person adds their own plugins, and sees what each asks for and where it draws. See [Places](guide/places.md#a-persons-own-plugins).

**Gate.** The part of the kernel that checks every message from a plugin against its manifest before it goes any further. See [The security model](security.md#3-the-gate-checks-every-message).

**Hook.** A named event that plugins can listen to. Its mode says what listeners can do: `emit` and `parallel` hooks only tell them, while `serial`, `bail` and `waterfall` hooks let them change or stop the action. See [the API reference](api.md#hooks).

**Host.** The platform's code on the page (`/platform/host.js`). It draws views, sends the person's actions, and creates plugin workers in the spawner tab. It runs no plugin code. See [Architecture](architecture.md).

**Kernel.** The platform's core, in a shared worker for every tab of the site. It runs the plugins, checks their messages, keeps the data and shows reviews. See [The kernel](kernel.md).

**Live view.** A view drawn from a function that the kernel runs again whenever a collection it read changes (`views.live`). See [Views and templates](guide/views-and-templates.md#live-views).

**Manifest.** The literal object a plugin exports first, saying its id, name and permissions, and what it owns. The kernel reads it before any of the plugin's code runs. See [the API reference](api.md#manifest).

**Place.** Somewhere in an app's page that a plugin draws without a slot: a CSS selector, and whether to add before or after it, replace it or hide it. See [Places](guide/places.md).

**Plugin.** One JavaScript file with a manifest and a default export, run in its own worker. Every feature of an app is one, including the platform's standard ones. See [Writing a plugin](guide/writing-a-plugin.md).

**Provider.** A plugin that answers the `llm` service for one vendor's language models, such as [`/std/llm/anthropic.js`](../std/llm/anthropic.js). See [Standard plugins](plugins.md#language-models-and-agents).

**Route.** A path in a plugin's folder that the plugin answers, through the service worker. See [Routes and the service worker](guide/routes.md).

**Scope.** Whether one copy of a plugin runs for every tab (`shared`, the default), or one in each open tab (`tab`).

**Screen.** An address inside an app's folder, such as `/demos/reading-list/book/42`. The router service tells the app's plugins which one the tab shows. See [Routes and the service worker](guide/routes.md).

**Secret.** A key the person gave the kernel under a name. A plugin with `secret:<name>` can have it put into a request to the hosts the person agreed to, but can never read it. See [API keys and web requests](guide/keys-and-requests.md).

**Service.** A set of methods the kernel offers plugins through `ctx.call(service, method, …)`, such as `data`, `router` or `llm`. See [the API reference](api.md#services).

**Slot.** A `<slot name>` element in an app's page, where plugins draw views by name. What's inside it shows until a plugin draws there.

**Spawner.** The tab that creates the plugin workers, since a shared worker can't. If it closes, another tab takes over. See [Architecture](architecture.md#opening-a-page).

**Standard plugin.** A plugin in [`/std/`](../std/README.md) that any app can link. See [Standard plugins](plugins.md).

**Template file.** An `.html` file next to a plugin, holding its views as `<template id>` elements with `{{holes}}`, so the plugin sends only data. See [Views and templates](guide/views-and-templates.md#template-files).

**Tool.** A service method offered to a language model, called through the gate with the plugin's own rights. See [Tools for language models](guide/tools.md).

**Trace.** The kernel's record of every message, check and refusal, grouped by the action that started it. The workbench, the debug console and the hook tracer show it.

**View.** What a plugin draws: HTML, sanitised by the host and morphed into a slot or place, so focus and typing survive a redraw. See [Views and templates](guide/views-and-templates.md).

**Workbench.** The platform's own page at [`/workbench/`](/workbench/), with every plugin's views, the plugins panel and the trace.
