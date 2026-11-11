// The model a space holds a key for, behind the platform's `llm` service: a
// language model for the members of a space who have no key of their own.
//
//   <link rel="plugin" href="/std/llm/space.js">
//
// A space's owner can give the space one model key on their account page.
// It stays on the space's server, encrypted, and is never sent to a browser
// (std/spaces/model-key.ts). With this plugin, a member's question goes to
// the space's server, which asks the vendor with that key and sends back the
// answer. The owner pays, so the first time, the person is shown whose key
// it is before anything is asked, and each member has a number of questions
// a day.
//
// It is a model only in a space that has a key: anywhere else this plugin
// lists no model, and the site doesn't offer it (llm.choices).
//
// This file only passes requests on: the translation to the vendor's API is
// the vendor's own plugin (anthropic.js, openai.js, gemini.js), which the
// space's server runs.

export const manifest = {
  id: "llm-space",
  name: "The space's model",
  description: "A language model for this app that the space pays for: its owner gave the space a key, which stays on the space's server. You need no key. You are shown whose key it is before your first question, and each member has a number of questions a day. Only in a space whose owner has given it a key.",
  version: "1.0.0",
  permissions: ["provide:llm", "space-model"],
  services: ["llm", "sync"],
};

export default function (ctx) {
  /** Whether this page's space has a key, and whose. Asked each time: an owner gives a key, or takes it away. */
  const state = () => ctx.call("sync", "model").catch(() => ({ space: null }));

  ctx.on("llm:providers", async (value) => {
    const has = await state();
    if (!has.set) return value;
    // Ready without a key of the person's own; not when the vendor refused the space's.
    return { providers: [...value.providers, { id: manifest.id, name: `${has.model}, on ${has.yours ? "the key you gave this space" : `${has.byName}'s key`}`, model: has.model, ready: !has.refused }] };
  });

  ctx.on("llm:models", async ({ provider }) => {
    if (provider !== manifest.id) return undefined;
    try {
      return await ctx.call("sync", "ask", { models: true });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  ctx.on("llm:complete", async (request) => {
    if (request.provider !== manifest.id) return undefined;
    try {
      const { provider: _provider, ...rest } = request;
      return await ctx.call("sync", "ask", rest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The person said no to asking on someone's key: not a failure to show as one.
      return /declined/.test(message) ? { error: "You chose not to ask on the space's key", declined: true } : { error: message };
    }
  });
}
