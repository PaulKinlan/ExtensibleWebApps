# Tools for language models

A model can do things in an app by calling tools. On this platform, nobody writes a tool by hand. Each service method that describes its arguments becomes a tool, and a plugin is offered only the ones its manifest lets it call. This is the first piece of the [agent plugin](https://claude.ai/artifact/LaqdvStAKyAoEifqNpq2Ba). Any plugin with the `llm` permission can use it now.

## The loop

```js
export const manifest = {
  id: "librarian",
  name: "Librarian",
  permissions: ["llm", "data:read:library", "data:write:library"],
};

export default async function (ctx) {
  const tools = await ctx.call("tools", "list");
  const messages = [{ role: "user", content: "Give every book without a shelf the shelf 'to read'." }];
  for (let turn = 0; turn < 10; turn++) {
    const answer = await ctx.call("llm", "complete", { messages, tools });
    messages.push(answer.message);
    if (answer.stop !== "tool") break;
    for (const call of answer.toolCalls) {
      const content = await ctx.call("tools", "call", call.name, call.args).then(JSON.stringify, (e) => `Error: ${e.message}`);
      messages.push({ role: "tool", id: call.id, name: call.name, content });
    }
  }
}
```

`tools.list` returns `{ name, description, parameters, service, method, reviewed }` for each tool. `llm.complete` reads the name, description and parameters and ignores the rest.

## What a plugin is offered

- **Named `service_method`:** `data_put` is `data.put`, and `files_read` is `files.read`.
- **Only what it could call anyway:** a method that needs nothing, or one whose capability the manifest grants. A plugin with `files:exports` gets `files_read` and `files_write`. One without it gets neither.
- **Only the collections it may use:** the ones the plugin owns, plus the ones its manifest names in `data:read:` or `data:write:`. The model can't ask for another.
- **One tool per collection, with its fields:** for up to five collections, a method that takes one becomes a tool each, such as `data_put_books`. Its `record` argument is the collection's own schema, with its fields, required fields and choices, plus `id`, so the model sees real fields rather than a bare object. Past five, it is one tool, `data_put`, whose `collection` argument lists them.
- **Never `llm` or `tools` themselves.**

## What a tool call does

`tools.call(name, args)` takes the arguments as an object, the way a model gives them. It refuses an unknown argument, a missing one, or a value outside the schema. Then it calls the method through the same gate as `ctx.call`. A tool can never do more than the plugin holding it, and a write to data the plugin doesn't own is still reviewed by the person. Pass a `reason` for reviewed tools; their descriptions tell the model to.

## Making a service method a tool

Give the method `params` beside its `args`, one entry per argument in order, each with a [schema](data-and-permissions.md) in the collections' JSON Schema subset:

```ts
put: {
  args: "(collection, { id?, ...fields }, reason?)",
  // …
  params: [
    { name: "collection", schema: { type: "string" }, names: "data:write:" },
    { name: "record", schema: { type: "object" }, recordOf: "collection" },
    { name: "reason", schema: { type: "string" }, optional: true },
  ],
},
```

`names` is a capability prefix: the value must be one of the names the caller holds after it. `recordOf: "collection"` on another argument gives it that collection's schema in the per-collection tools. A method without `params` isn't offered, so a service decides what a model may reach.
