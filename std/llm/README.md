# Language models

Each file here is a plugin that answers the platform's `llm` service with one
vendor's models. Link one or more from an app's `app.html`:

```html
<link rel="plugin" href="/std/llm/anthropic.js">
```

| Plugin | Models | Key |
| --- | --- | --- |
| [`anthropic.js`](anthropic.js) | Claude: best is Opus, balanced Sonnet, fast Haiku | An Anthropic API key, sent only to api.anthropic.com |
| [`openai.js`](openai.js) | OpenAI, through the Responses API: best is Astra, balanced Sol, fast Luna | An OpenAI API key, sent only to api.openai.com |
| [`gemini.js`](gemini.js) | Gemini: best is Argon (or Pro), balanced Flash, fast Flash-Lite | A Gemini API key, sent only to generativelanguage.googleapis.com |
| [`openai-compatible.js`](openai-compatible.js) | Ollama on this computer as written; copy it for any other OpenAI-style API | None for Ollama |

## Which model

Each provider's `model` setting, and a request's `model`, is a model's id or a tier: `best` (the
default), `balanced` or `fast`. A tier is the newest model of that kind in the vendor's live model
list, looked up when it's needed and kept for an hour, so an app moves to a new model when the
vendor ships it, without a change to its code. If the list can't be read, each tier has a model to
fall back to. `ctx.call("llm", "models", provider)` lists the vendor's models and what each tier
stands for now.

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

- **`messages`**: `{ role: "user" | "assistant", content }`. The first is the person's. To go on
  from an answer, add its `message`: the model's turn, with its `state`, the vendor's own record of
  the turn (the model's reasoning, signatures), which some vendors need back.
- **`tools`**: `[{ name, description, parameters }]`, with `parameters` as JSON Schema. When the
  model wants one, the answer has `stop: "tool"` and `toolCalls: [{ id, name, args }]`. Run it, then
  ask again with the answer's `message` and each result as `{ role: "tool", id, name, content }`.
- **`schema`**: a JSON Schema, in the platform's subset that collections use. The answer's `json`
  is then a value of that shape: the kernel checks it, and an answer of another shape is an error.
- **`model`**, **`maxTokens`**, **`provider`**: optional. Without `provider`, the first provider
  that has its key answers. `ctx.call("llm", "providers")` lists them. A plugin only sees the
  providers its own app links, not those of other apps open in other tabs.

The answer is `{ text, json?, toolCalls, stop, usage: { input, output }, provider, model, message }`, where
`stop` is `end`, `tool`, `length` or `refused`. A vendor's error arrives as the call's error, named
for the provider.

## Keys

The first time a provider is asked, the kernel shows the person a card to paste its API key. The key
is kept with the app's data. No plugin can read it, the provider included: the provider names it in
a request header as `{ secret: "anthropic" }`, and the kernel fills it in, only for that vendor's
host (`secrets` and `net.fetch` in [docs/api.md](../../docs/api.md)).

## Writing a provider

A provider needs `provide:llm`, the `network:<host>` of its API and the `secret:<name>` of its key.
It listens to three hooks:

- `llm:providers` (waterfall): return `{ providers: [...value.providers, { id, name, model, ready }] }`.
- `llm:complete`: answer only when `request.provider` is its own id, with the answer above (the
  kernel fills in `provider` and `message`; return the vendor's turn as `state` if it needs it back),
  or `{ error }`. Return nothing otherwise.
- `llm:models`: when `provider` is its own id, return `{ models: [{ id, name? }], tiers: { best, balanced, fast } }`.

For another service that speaks OpenAI's Chat Completions API, copy `openai-compatible.js`, give it
its own id, and change its address and network permission. Ollama in a browser needs
`OLLAMA_ORIGINS` set to this site's address so the page may reach it.
