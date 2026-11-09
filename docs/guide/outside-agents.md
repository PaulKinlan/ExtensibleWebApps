# Outside agents: WebMCP and MCP

The [agents](agents.md) an app links live inside it. Many agents don't: the assistant built into a browser, Claude Code on someone's laptop, or any other MCP client. This page shows how an app lets them in. They get the same tools an agent inside the app gets ([tools for language models](tools.md)), and the same permission checks and reviews.

## Opening the door

An app opts in by linking a plugin that opens the door. The plugin does nothing else. An outside agent then acts *as that plugin*, so its manifest decides what outside agents may reach. This is the reading list's [`outside-agents.js`](../../demos/reading-list/outside-agents.js):

```js
export const manifest = {
  id: "reading-list-agents",
  name: "Outside agent",
  runs: "both",
  permissions: ["outside", "data:read:library", "data:write:library"],
  services: ["outside", "tools"],
};

export default async function (ctx) {
  await ctx.call("outside", "open", { instructions: "This is a reading list. …" });
}
```

- **`outside`** lets it open the door. **`services: ["outside", "tools"]`** says it needs the [kernel modules](../layers.md) that do the work, so it fails to start on a site that doesn't run them.
- **The rest of `permissions`** is everything outside agents may do. Here that's reading the library and asking to change it. The library belongs to `library.js`, so the person reviews every change, the same way they review any plugin's change to data it doesn't own.
- **`runs: "both"`** opens the door in the browser and on a space's server.
- **`instructions`** tells the agents what the app is for. WebMCP has no place for them of its own, so each tool's description ends with them. MCP sends them as the server's `instructions` when an agent connects.

### Or with an agent file

The plugin above has no code of its own beyond opening the door, so an app can link an [agent file](agents.md) instead, with `outside: true`. Its frontmatter says what outside agents may do, and the Markdown after it is their instructions:

```markdown
---
id: reading-list-agents
name: Outside agent
outside: true
permissions: [data:read:library, data:write:library]
---
This is a reading list. Each book in the library has a title, an author, ...
```

```html
<link rel="agent" href="outside.agent.md">
```

The kernel makes it the same door plugin: `runs: "both"`, `outside` added to its permissions, and the two kernel modules in `services`. The agent lives elsewhere and brings its own model, so the file has no `model`, `on`, `limits` or `runner`, and one that names any of them is refused. A space's server opens the door for an outside agent file as it does for a plugin. An app's other agent files still run only in the browser.

The tools are exactly what [`tools.list`](tools.md) gives the plugin: `data_list_library`, `data_put_library` with the library's own fields, and so on. A method the manifest doesn't grant isn't there. `llm` and `tools` are never offered.

## In the page: WebMCP

In a tab, the host registers each tool with the page's [WebMCP](https://webmachinelearning.github.io/webmcp/) context. That's `document.modelContext.registerTool`, or `navigator.modelContext` in browsers that put it there. An agent in the browser then finds the tools with `getTools()` and calls them with `executeTool()`. Each call goes back to the kernel and runs as the plugin, and a review shows its card on that page. A browser without WebMCP just doesn't get them.

```mermaid
sequenceDiagram
    participant Agent as The browser's agent
    participant Page as The page (host)
    participant Kernel
    participant Person
    Kernel->>Page: the door's tools (bridges/webmcp.ts)
    Page->>Page: document.modelContext.registerTool(…)
    Agent->>Page: executeTool(data_put_library, { record, reason })
    Page->>Kernel: outside:call, with this tab's key
    Kernel->>Kernel: tools.call as reading-list-agents, through the gate
    Kernel->>Person: the review card
    Person->>Kernel: Accept
    Kernel->>Page: { ok: true }
    Page->>Agent: the result
```

## On a space's server: MCP

Opened in a [space](spaces-and-servers.md), the plugin also runs on the space's server. The server offers the same tools at

```
https://<site>/s/<space>/mcp/<plugin id>
```

as an MCP server. It uses the Streamable HTTP transport without streaming: every POST gets a JSON answer. Only a member's agent gets in. A member makes an **agent key** for the space on [`/account/`](../../account/), names it after the agent and, if they like, the app's agent plugin (its id, like `reading-list-agents`), and pastes what the page shows into the agent. The page fills in that app's address in the command, or leaves `<plugin>` for the member to fill in. The agent sends it as `Authorization: Bearer <key>`. For Claude Code:

```sh
claude mcp add --transport http reading-list https://<site>/s/<space>/mcp/reading-list-agents \
  --header "Authorization: Bearer <key>"
```

The agent acts as that member, and only in that space. Revoking the key or leaving the space shuts it out at once. The server keeps only a hash of each key.

### Signing in instead of pasting a key

An MCP client that can sign in with OAuth, as MCP's [authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) has it, needs only the address:

```sh
claude mcp add --transport http reading-list https://<site>/s/<space>/mcp/reading-list-agents
```

1. Without a key, the server answers 401, pointing at the address's metadata, `/.well-known/oauth-protected-resource/s/<space>/mcp/<plugin>`, which names the site as the server that signs agents in.
2. The client registers itself at `/auth/mcp/register`, sends the member to `/auth/mcp/authorize` in their browser, and uses PKCE.
3. Signed in on the site, the member sees which agent wants which space, as them, and answers. Someone who isn't in the space can't say yes.
4. The client trades the code for an agent key at `/auth/mcp/token`, and sends it as above.

The key is an agent key named after the client: `/account/` lists it, and revoking it there shuts the agent out. Unlike a key made on `/account/`, it reaches only the one MCP address the member said yes to. Connecting the same client to the same address again replaces its key. The sign-in is [`src/server/auth/mcp-oauth.ts`](../../src/server/auth/mcp-oauth.ts). A client registers without a secret, and nothing is stored for it: its id carries its name and the addresses it may be sent back to.

### When the tools change

A plugin starting or stopping can change the door's tools: a collection the door may read comes or goes. An MCP client gets a session (`Mcp-Session-Id`) when it connects, and the server's `initialize` answer says `tools.listChanged`. The server keeps no stream open between requests, so when the tools have changed since a session last listed them, the answer to its next request is a short event stream: `notifications/tools/list_changed`, then the answer. The client lists the tools again. A client that takes only JSON gets plain JSON, and finds new tools when it next lists them. A client ends its session with `DELETE`. In a tab, WebMCP needs none of this: the page registers the new tools as they change.

The space's server has no screen of its own, so a review goes to the members whose devices have the space open. They see the usual card, marked "on the space's server", and the first answer settles it. "Always allow" is kept by the space. An MCP tool call waits up to 100 seconds for an answer. If nobody answers in time, the tool's result says the change is still waiting. If nobody ever answers, the review is cancelled after five minutes, as any review is.

```mermaid
sequenceDiagram
    participant Agent as Claude Code
    participant Host as The server's host
    participant Space as The space's kernel
    participant Device as A member's open app
    Agent->>Host: POST /s/home/mcp/reading-list-agents (Bearer key)
    Host->>Host: the key is a member's, for this space
    Host->>Space: the JSON-RPC request, at the door "mcp"
    Space->>Space: tools.call as reading-list-agents
    Space->>Device: review (over sync)
    Device->>Space: accepted
    Space->>Device: the change, as any change
    Space->>Host: the tool's result
    Host->>Agent: JSON-RPC answer
```

The space starts the plugin when a member first opens the app there, as it does any server plugin. Until then, the address answers that no such door is open.

## What's checked

- An outside agent can never do more than the door's plugin. Every call goes through the same gate as the plugin's own `ctx.call`, and the same reviews.
- In a page, a tool call has to carry the key the kernel gave that tab, so a tool from one door can't run as another.
- On a server, the host lets in only a member's key for that space, and refuses a call a browser makes from another site's page.
- A door takes 600 tool calls an hour from all its agents together.
- An agent that signs in gets a key only after a member of the space says yes on the site's own page, and only with PKCE. The page refuses to be framed, and only a form from the site itself can answer it.
- The `outside:called` hook says each time an outside agent called a tool: which tool, whether through WebMCP or MCP, the member on a server, and whether it worked. It never carries the arguments or the answer.

The checks are [`tests/checks/outside-agents.mjs`](../../tests/checks/outside-agents.mjs) and [`tests/checks/outside-file.mjs`](../../tests/checks/outside-file.mjs) for WebMCP, and [`tests/server/mcp.mjs`](../../tests/server/mcp.mjs) and [`tests/server/mcp-more.mjs`](../../tests/server/mcp-more.mjs) for MCP, signing in and tool changes on both hosts.
