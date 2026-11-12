# Asking an agent to write a plugin

Writing a plugin by hand takes knowing the manifest, the permissions and the template language. An agent that writes code already can, if it is told how this platform works. So the platform comes with a **skill**: a short set of instructions, with a worked example, that Claude Code reads when you ask it for a plugin. You say what you want; it writes the files, runs the check, and tells you what the plugin does and what it is allowed to do.

The skill is [`.claude/skills/extensible-plugin/`](../../.claude/skills/extensible-plugin/SKILL.md): `SKILL.md`, and [`example/`](../../.claude/skills/extensible-plugin/example/), a small app of two plugins. It is short on purpose. It says where to start, the rules an agent gets wrong without help, and how to check the result; for everything else it sends the agent to this guide and the [API reference](../api.md), which come with the platform and so always match the version in use.

## Three ways to have it

| You are | You get the skill by |
| --- | --- |
| In a project made with `npm create extensible-app` | Nothing: the project has it, in its own `.claude/skills/`. Start Claude Code in the project. |
| In a checkout of this repo | Nothing: it is in the repo. |
| Anywhere else, such as writing a plugin to paste into an app you use | Installing it once, below. |

To install it in Claude Code for every folder you work in:

```sh
claude plugin marketplace add PaulKinlan/ExtensibleWebApps
claude plugin install extensible-web-apps@extensible-web-apps
```

It has no version number, so it follows this repo's `main`: `claude plugin update extensible-web-apps@extensible-web-apps` brings the newer one. A project's own copy is the one that came with the platform it was made from; copy the folder again from `node_modules/extensible-web-apps/.claude/skills/extensible-plugin/` after updating the platform.

## Asking

Say what the plugin should do, in your own words:

> Add a plugin that shows how many items I've ticked off this week, at the top of the page.

> Add a page of notes to this app. Each note has a title and some text, and I want to search them.

Claude finds the platform, reads the example and the pages of this guide the plugin needs, writes the plugin beside `app.html` (or in `demos/<app>/` here), links it, and runs `npm run check` until it passes. Then `npm run dev` shows it.

With no project at all, it writes one file to paste into an app's **Customize**, then **Add a plugin** ([a person's own plugins](places.md#a-persons-own-plugins)). The app shows you the code and what it may do on a review card, and nothing runs until you accept.

## Other agents

The skill is plain Markdown. An agent that doesn't load skills by itself can be pointed at `SKILL.md` and told to follow it; [`AGENTS.md`](../../AGENTS.md) at the top of the platform says the same things at more length for an agent working on the platform itself.

An app can also write its own plugins, with no agent outside it: the [plugin maker](places.md#making-one-from-customize) ("Write it for me" in Customize) asks a language model with the person's own key.

## What keeps it right

A skill that describes last month's platform is worse than none. [`tests/checks/plugin-skill.mjs`](../../tests/checks/plugin-skill.mjs) runs with the other checks and fails when the skill's example stops passing `npm run check`, when a doc, design token or element the skill names is no longer in the platform, or when a new project would be made without it. [`tests/project/run.mjs`](../../tests/project/run.mjs) checks that the package npm serves has the skill and every doc it names.

When you change how plugins are written, change the skill in the same pull request: the rule in `SKILL.md`, and the example if the shape changed.
