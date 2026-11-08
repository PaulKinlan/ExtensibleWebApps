# Language models

Each file here is a plugin that answers the platform's `llm` service with one
vendor's models. Link one or more from an app's `app.html`:

```html
<link rel="plugin" href="/std/llm/anthropic.js">
```

| Plugin | Models | Key |
| --- | --- | --- |
| [`anthropic.js`](anthropic.js) | Claude: `model` setting, default `claude-opus-5-5` | An Anthropic API key, sent only to api.anthropic.com |
| [`openai.js`](openai.js) | OpenAI (`model` setting, default `gpt-5`), or Ollama on this computer (`address` setting) | An OpenAI API key, sent only to api.openai.com; none for Ollama |
| [`gemini.js`](gemini.js) | Gemini: `model` setting, default `gemini-2.5-flash` | A Gemini API key, sent only to generativelanguage.googleapis.com |

## Asking a model

A plugin needs only the `llm` permission:

```js
export const manifest = { id: "summary", name: "Summary", permissions: ["llm"] };

export default async (ctx) => {
  const answer = await ctx.call("llm", "complete", {
    system: "Answer in one sentence.",
    messages: [{ role: "user", content: "What is a kernel?" }],
  });
  ctx.log(answer.text);
};
```

The request and the answer are the same whichever vendor answers:

- **`messages`**: `{ role: "user" | "assistant", content }`. The first is the person's.
- **`tools`**: `[{ name, description, parameters }]`, with `parameters` as JSON Schema. When the
  model wants one, the answer has `stop: "tool"` and `toolCalls: [{ id, name, args }]`. Run it, then
  ask again with the model's turn `{ role: "assistant", content, toolCalls }` and each result as
  `{ role: "tool", id, name, content }`.
- **`schema`**: a JSON Schema. The answer's `json` is then a value of that shape.
- **`model`**, **`maxTokens`**, **`provider`**: optional. Without `provider`, the first provider
  that has its key answers. `ctx.call("llm", "providers")` lists them.

The answer is `{ text, json?, toolCalls, stop, usage: { input, output }, provider, model }`, where
`stop` is `end`, `tool`, `length` or `refused`. A vendor's error arrives as the call's error, named
for the provider.

## Keys

The first time a provider is asked, the kernel shows the person a card to paste its API key. The key
is kept with the app's data. No plugin can read it, the provider included: the provider names it in
a request header as `{ secret: "anthropic" }`, and the kernel fills it in, only for that vendor's
host (`secrets` and `net.fetch` in [docs/api.md](../../docs/api.md)).

## Writing a provider

A provider needs `provide:llm`, the `network:<host>` of its API and the `secret:<name>` of its key.
It listens to two hooks:

- `llm:providers` (waterfall): return `{ providers: [...value.providers, { id, name, model, ready }] }`.
- `llm:complete`: answer only when `request.provider` is its own id, with the answer above (the
  kernel fills in `provider`), or `{ error }`. Return nothing otherwise.

For another service that speaks OpenAI's API, copy `openai.js`, give it its own id, and change its
addresses and network permission. Ollama in a browser needs `OLLAMA_ORIGINS` set to this site's
address so the page may reach it.
