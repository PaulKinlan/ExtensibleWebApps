# Editors talking to an app's agents: ACP

[Outside agents](outside-agents.md) is about an agent that isn't part of an app using the app's tools. This page is the other way round: a program that isn't part of the app, a code editor, talking to an agent that is. The agent is one of the app's own [agent files](agents.md), with the permissions its file asks for, the limits it sets, and the person's reviews. The editor is only where the person types to it and reads what it does.

The editor speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), which Zed and other editors use to talk to coding agents. Nothing is added to an app for it: an agent that takes messages can be talked to from an editor once its app has been opened in a [space](spaces-and-servers.md).

## Which agents

An agent can be reached from an editor when:

- **its app has been opened in the space**, in a browser, at least once. That is how a space learns which apps it has, the same as for [plugins on a space's server](spaces-and-servers.md);
- **it takes messages**: `- message: true` under `on` in its file, as the app's own chat needs;
- **it runs the standard loop**: no `runner:` of its own. The server runs the loop itself so each step can be told to the editor as it happens, and it can't follow a loop it didn't write.

This one, from the tests ([`shelf-keeper.agent.md`](../../tests/fixtures/server-app/editor/shelf-keeper.agent.md)), is all there is to it:

```md
---
id: shelf-keeper
name: Shelf keeper
description: Looks after the reading list when you ask it to.
model: fast
permissions: [data:read:library, data:write:library]
on:
  - message: true
limits: { runs-per-hour: 30, tokens-per-day: 200000, steps: 6 }
---
You look after a reading list, kept in the `library` collection. …
```

Its address is the space, then `acp`, then the agent's id:

```
https://<site>/s/<space>/acp/shelf-keeper
```

Asked for an agent that isn't there, the server says which agents the space has, or why the one named can't be talked to (it takes no messages, or runs a loop of its own).

## Where the agent runs, and with which model

The agent runs on the space's server, not in anyone's browser, so it answers with no tab open. It is the same plugin a browser would make from the file, so its tools are the ones its permissions give it ([tools for language models](tools.md)), each call passes the gate, and its runs and tokens are counted against the limits in its file. What would wake it in a browser (a hook, a command, a topic) doesn't wake it on the server: there it only answers an editor.

It asks **the space's model**: the key the space's owner gave on `/account/` ([A model key a space holds for its members](../server.md#a-model-key-a-space-holds-for-its-members)). Each request counts as one of the member's questions for the day. A space with no model key answers a prompt with an error that says so and where the owner gives one.

## Setting up an editor

ACP's finished transport is a program the editor starts and writes lines to. That program is `extensible-app acp <address>` ([`scripts/acp-bridge.mjs`](../../scripts/acp-bridge.mjs)): it passes each line to the agent's address and writes out what the agent says.

1. On [`/account/`](../../account/), under **Agent keys**, use **A key for an editor**: pick the space, name the editor, and give the agent's id. The page shows the key once, with the agent's address and the settings to paste.
2. Give the editor the command, with the key in its environment as `EXTENSIBLE_APP_KEY`. The key is never put on the command line, where other programs on the machine could read it.

For Zed, open Agent Settings, go to External Agents, choose Add Custom Agent, and add:

```json
{
  "agent_servers": {
    "shelf-keeper": {
      "type": "custom",
      "command": "npx",
      "args": ["extensible-app", "acp", "https://<site>/s/<space>/acp/shelf-keeper"],
      "env": { "EXTENSIBLE_APP_KEY": "<key>" }
    }
  }
}
```

`npx extensible-app` finds the command in a project that depends on the platform ([An app of your own](your-own-app.md)). From a copy of this repo it is `node scripts/extensible-app.mjs acp <address>`. Any other ACP client is set up the same way: a command, its arguments, and one environment variable.

The address must be `https://`, since the key is sent to it (`http://localhost` is allowed while developing). When something is wrong, the editor is told what to do in the error it shows: no key, a key for another agent, no such agent, a site that can't be reached.

## Reviews

A change the agent may not make by itself, such as writing to a collection it doesn't own, waits for a person, as it does everywhere ([Data and permissions](data-and-permissions.md)). The review card shows in the members' open apps. Who else may answer depends on the key:

- **A key made for an editor** (step 1 above) opens only that agent, and the editor is asked too, as ACP's `session/request_permission`: Accept, Always allow, or Decline. The first answer settles it, wherever it was given, and the other card goes away.
- **Any other agent key** for the space still lets the editor talk to the agent, but the editor can't answer: it shows that the change is waiting in the app, and a member answers there.

Either way a declined change is told to the agent, which carries on without it. Cancelling the turn in the editor withdraws a card that is still waiting.

## What is kept

A conversation is kept in the space's folder (`acp/sessions/`), with the member it belongs to, for 30 days after it was last used, and at most 200 for a space. So an editor can take one up again (`session/load`) after the space's server slept or was restarted, and only the member who started it can. Conversations are part of the space, so they are in a copy of it that its owner downloads.

## What of ACP is here

This follows ACP **protocol version 1**, read from [agentclientprotocol.com](https://agentclientprotocol.com) on 2026-11-11.

Implemented:

| | |
| --- | --- |
| `initialize` | Version 1 is answered whatever version is asked for. Says it can load sessions and takes text and embedded text resources |
| `authenticate` | Accepted and does nothing: the key is the sign-in |
| `session/new`, `session/load` | A conversation, and taking one up again with what was said replayed |
| `session/prompt` | One turn. Text, embedded text resources and resource links are read. Ends `end_turn`, `max_turn_requests` (the agent's `steps`), `max_tokens`, `refusal` or `cancelled` |
| `session/cancel` | Stops the turn under way and withdraws its waiting review |
| `session/update` | `agent_message_chunk`, `user_message_chunk` (on load), `tool_call` and `tool_call_update` for each tool the agent calls, with what it was given and what came back |
| `session/request_permission` | A review, for an editor whose key was made for it |

Left out:

- **The editor's files and terminals** (`fs/*`, `terminal/*`). The agent works on the app's data with the app's tools. It does not read or write the project open in the editor.
- **MCP servers the editor offers** to a session. They are ignored: the agent's tools are the ones its file's permissions give.
- **Modes, plans, slash commands, and listing, resuming or closing sessions.**
- **Images and audio** in a prompt.
- **The model's text as it is written.** The agent's answer arrives whole at the end of each step, and each tool call as it happens.
- **Signing in from the editor.** An editor needs a key from `/account/`. The OAuth sign-in MCP clients can use doesn't open this door.

Between the command and the server, messages travel in the shape of ACP's draft for a remote transport (each message a POST, `initialize` answered with an `Acp-Connection-Id`, the rest on an event stream). That draft is still changing and this isn't it exactly: there is one stream for a connection, numbered so one that drops loses nothing, and a prompt's POST is held open until the turn ends. An editor that speaks a finished remote transport one day will need this side brought up to it. Until then, use the command.

**Not tried with a real editor.** The tests drive the server and the command with a scripted ACP client, on Node and on Cloudflare ([`tests/server/acp.mjs`](../../tests/server/acp.mjs)): a conversation, a prompt, the updates, a review accepted in the editor and one in the app, a decline, a cancel, a stream that drops, a server restart. Nobody has yet pointed Zed, or any other editor, at it.

## Limits

- One turn at a time for an agent in a space. A prompt in another conversation waits for the turn under way; a second prompt in the same conversation is answered with an error that says to wait or cancel.
- A prompt is at most 200,000 characters, and a POST 1 MB.
- A turn may last 30 minutes, reviews included.
- A conversation keeps its latest 300,000 characters. Older turns are dropped from what the model sees.
