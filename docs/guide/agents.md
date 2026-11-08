# Agents

An agent is a Markdown file. Its frontmatter says who it is, what it may do and what wakes it; the Markdown after it tells it what to do. An app links it next to its plugins:

```html
<link rel="plugin" href="../reading-list/library.js">
<link rel="agent" href="librarian.agent.md">
<link rel="plugin" href="/std/llm/anthropic.js">
```

The kernel turns the file into a plugin before it runs: a manifest made from the frontmatter, and the agent loop. So an agent is held to its manifest by the same gate as any plugin, a change it makes to data it doesn't own is reviewed by the person, and the plugins panel lists it like any other. The [librarian demo](../../demos/librarian/) is the whole example. This is the second piece of the [agent plugin](https://claude.ai/artifact/LaqdvStAKyAoEifqNpq2Ba), after [tools](tools.md).

## The file

```markdown
---
id: librarian
name: Librarian
description: Fills in a book's author and first year of publication when they're missing.
model: fast
permissions: [data:read:library, data:write:library]
on:
  - hook: data:changed:library
  - command: fill-missing
limits: { runs-per-hour: 30, tokens-per-day: 200000, steps: 8 }
---
You look after a reading list, kept in the `library` collection.

When a book is added or changed and it has a title but no author or no year,
fill in what's missing ...
```

| Field | What it is |
| --- | --- |
| `id`, `name` | Required, as in a plugin's manifest. |
| `description`, `version` | Optional, as in a plugin's manifest. Without a description, the instructions' first line is used. |
| `model` | Optional: a model's id, or a tier (`best`, `balanced`, `fast`). `default`, or none, uses the provider's setting. |
| `permissions` | What the agent may do, as in a plugin's manifest. Its tools are exactly what these let it call. |
| `on` | What wakes it: `- hook: <name>` for any hook it may listen to, and `- command: <name>` for a command a plugin can start. |
| `limits` | Optional: `runs-per-hour` (30), `tokens-per-day` (200000) and `steps`, the model turns in one run (12). |
| `acts-as` | Optional, and only `self` for now: the agent acts under its own name. Acting for the person comes later. |

The frontmatter is a small part of YAML: `key: value`, lists as `[a, b]` or `- item` lines, maps as `{ a: 1 }` or indented lines, and `#` comments. The file's name ends in `.agent.md`. `npm run check` reads it the way the kernel does and says what is wrong.

The manifest the kernel makes adds three permissions to the ones the file lists: `llm`, to ask the model; `agent`, to hear its commands; and `hook:listen:<name>` for each hook in `on` (a `data:changed:<collection>` hook comes with `data:read:<collection>`).

## A run

Each wake is one run, and runs go one at a time in the order they woke the agent:

1. The agent is told what woke it: the hook's name and value, or the command and its input.
2. It asks the model, with its instructions as the system prompt and its [tools](tools.md): every service method its manifest lets it call, such as `data_put_library`.
3. It calls the tools the model picks, through the gate, and gives the model their answers, until the model stops calling tools or the run reaches its step limit.

A change the agent makes wakes other plugins as usual, but not the agent itself: a `data:changed` for a record it wrote in the last minute is skipped.

The loop reaches the model and its tools through the `agents` service, not `llm` and `tools` directly. So the kernel, not the agent, counts each run and token against its limits, and the kernel tells the app what happened.

## The agent:* events

Any plugin can listen to these with `hook:listen:agent:<name>`, or `hook:listen:agent:*` for all of them. The demo's [activity list](../../demos/librarian/activity.js) does.

| Event | Value |
| --- | --- |
| `agent:wake` | `{ agent, run, trigger: { kind, name, value } }`: a run began. |
| `agent:toolResult` | `{ agent, run, tool, args, ok, error? }`: the agent called a tool. |
| `agent:done` | `{ agent, run, stopReason, text, steps, tools, usage: { input, output } }`: a run ended. `stopReason` is `completed`, `steps` (it reached its step limit), `budget` or `error`. |
| `agent:budget` | `{ agent, limit, used, max }`: the agent reached `runs-per-hour` or `tokens-per-day`, so a run didn't start or was stopped. |

## Starting a command

A plugin whose manifest has `agents:run:<agent id>` may start one of the commands the agent's file lists:

```js
await ctx.call("agents", "run", "librarian", "fill-missing", { shelf: "to read" });
```

It answers at once; the run happens after any run under way, and `agent:done` says how it went. `agents.list()` says which agents are running, what wakes them, their limits, and what they have used this hour and today.

## Coming next

The [design](https://claude.ai/artifact/LaqdvStAKyAoEifqNpq2Ba) has more to come, each its own change: a message bus with an inbox for each agent and a board the person sees; agents that check another plugin's action before it happens, such as a security agent; and the assistant and builder agents, which can act for the person and write plugins.
