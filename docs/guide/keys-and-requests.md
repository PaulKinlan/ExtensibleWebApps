# API keys and web requests

A plugin that talks to a web API, such as a model vendor's, needs two things: a way to reach that one host, and the person's key for it. The kernel gives it both without the plugin ever holding the key.

## Reach one host: `network:<host>`

Name the host in the manifest, and make the request through the kernel:

```js
export const manifest = {
  id: "weather",
  name: "Weather",
  permissions: ["network:api.example.com"],
};

export default async function (ctx) {
  const answer = await ctx.call("net", "fetch", { url: "https://api.example.com/today?city=London" });
  if (answer.ok) ctx.log(JSON.parse(answer.text).summary);
}
```

`net.fetch` takes `{ url, method?, headers?, body? }` and returns `{ ok, status, headers, text }`. It only reaches `https:` addresses, or `http:` on this computer (`network:localhost:11434` for a model served by Ollama). A host with a port is named with it.

This is narrower than the `network` permission, which lets the plugin's own worker `fetch` any `https:` host. Prefer `network:<host>`: the person can see exactly where the plugin's requests go.

## Use a key: `secret:<name>`

A plugin never reads a key. It asks the person for it by name, and the kernel draws a card with a password field, saying which hosts the key will be sent to. From then on, a header written as `{ secret: name }` is filled in by the kernel, and only for those hosts:

```js
export const manifest = {
  id: "llm-example",
  name: "Example models",
  permissions: ["network:api.example.com", "secret:example"],
};

export default async function (ctx) {
  const { set } = await ctx.call("secrets", "has", "example");
  if (!set) await ctx.call("secrets", "request", "example", { hosts: ["api.example.com"], label: "Your Example API key" });
  const answer = await ctx.call("net", "fetch", {
    url: "https://api.example.com/v1/complete",
    method: "POST",
    headers: { authorization: { secret: "example", prefix: "Bearer " }, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Hello" }),
  });
}
```

- `secrets.has(name)` says whether the person has given it, and for which hosts.
- `secrets.request(name, { hosts, label? })` shows the card and resolves `{ set }` when they save it or say not now.
- `secrets.forget(name)` removes it.

The key is kept with the app's data, in a file no plugin can read. The trace shows each request and which secret it used, never the secret. A plugin without `secret:<name>` can't use the key, and a plugin that has it can't send it anywhere else: a request to another host is refused.

Keys the deployment provides, so the person needn't bring their own, come with the servers in phase 2b, behind the same calls.
