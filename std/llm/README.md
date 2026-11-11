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
| [`chrome.js`](chrome.js) | Chrome's built-in model, on the person's own computer: one small model, whatever tier is asked for | None. Only where the browser has the model; elsewhere it lists nothing and isn't offered |
| [`openai-compatible.js`](openai-compatible.js) | Ollama on this computer as written; copy it for any other OpenAI-style API | None for Ollama |

## A person adding one

A person can add a model to any app, without its developer linking one. The site's plugin registry
(`/packages/`) offers these, so they're in Customize's Add a plugin. And a plugin that needs a
model can offer them itself: `llm.choices()` lists the registry's packages that ask for
`provide:llm`, and `llm.add(id)` adds the one the person picks as their own plugin, once they
accept its review card, and turns it on. It is added for every app they open on this device, not
only the one they were in, so a model is added once. [Ask the page](../ask-the-page.js) and the
[plugin maker](../plugin-maker.js) do this when the page has no model.

```js
if (!(await ctx.call("llm", "providers")).length) {
  const choices = await ctx.call("llm", "choices"); // [{ id, name, description, added, linked }]
  // ...show them; when the person picks one:
  const { ok, error } = await ctx.call("llm", "add", choices[0].id);
}
```

Either way, the key is the person's own: the model asks for it the first time it's asked something,
and it is kept once for the device, so the next app doesn't ask again. A model added in Customize
is for that app until the person presses **Use in every app** on its row.

## Which provider answers

A request that names a `provider` gets that one. Without one, the person's pick answers, else the
first that has its key. When none has a key, each asks for it in turn: **Not now** on one model's
key card moves to the next, so nobody has to give a key to the first model listed to reach the one
they have a key for.

The pick is `llm.prefer(id)`, kept for the person on this device for every app, and
`llm.providers()` marks it `preferred`. A plugin where a person writes to a model can offer it as
a picker; the [chat](../agents/chat.js) and the [app maker](../maker/your-apps.js) do when the app
has more than one model.

```js
const providers = await ctx.call("llm", "providers"); // [{ id, name, model?, ready, preferred? }]
await ctx.call("llm", "prefer", providers[1].id);     // it answers from now on, in every app
await ctx.call("llm", "prefer");                      // back to the first that has its key
```

A provider plugin that the person gives no key answers `{ error, declined: true }` to
`llm:complete`, which is what lets the next one ask.

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

## A model with no key

[`chrome.js`](chrome.js) is the model Chrome carries itself (its Prompt API). It runs on the person's
computer, so there is no key card, nothing to pay, and nothing they ask leaves the device. It is a
model only where the browser has one (a recent Chrome on a computer with enough memory and disk
space): elsewhere it adds nothing to `llm.providers()`, and `llm.choices()` leaves it out. Where the
browser can have the model but hasn't fetched it yet, the first question starts the download and the
answer says how far it has got.

It is a small model: it reads a few thousand words at once, and has no tool calls of its own, so
`chrome.js` asks for an answer of a fixed shape and reads a tool call out of it. The browser's API is
in pages, not workers, so the plugin asks through the `browser-model` service
([`std/browser-model/module.ts`](../browser-model/module.ts)), which asks a tab.
