// Security check: looks at every plugin of your own before you see its
// review card, and stops the ones that look like trouble. It listens on
// plugins:beforeAdd, which the kernel runs with the plugin's code and what
// it asks for whenever one is added or changed (by the plugin editor, the
// builder agent, Customize), and answers { block: reason } to stop it.
//
// Its rules are plain code, so it needs no model and no key:
//   - a plugin that may read your data and also reach the internet could
//     send your data away;
//   - code that builds code from text (eval, new Function, import()) can
//     do something other than what you read on the card.
// Anything else goes on to the review card, where you decide. Each verdict
// is kept in its own collection, which chapter 12 shows. The security agent
// (security.agent.md) does the same job with a model, reading the code.

export const manifest = {
  id: "security-check",
  name: "Security check",
  description: "Stops a plugin of your own that could send your data away, or runs code you can't read, before its review card.",
  version: "1.0.0",
  permissions: ["hook:intercept:plugins:beforeAdd"],
  collections: {
    "security-reviews": {
      title: "Security reviews",
      schema: {
        type: "object",
        required: ["name", "verdict"],
        properties: {
          name: { type: "string", title: "Plugin" },
          verdict: { type: "string", enum: ["allowed", "blocked"], title: "Verdict" },
          reason: { type: "string", title: "Why" },
          at: { type: "string", title: "When" },
        },
      },
    },
  },
};

/** Code that makes code from text: what runs isn't what the card shows. */
const BUILDS_CODE = /\beval\s*\(|\bnew\s+Function\s*\(|\bimport\s*\(/;

export default function (ctx) {
  ctx.on("plugins:beforeAdd", async ({ name, permissions, code }) => {
    const reads = permissions.filter((p) => p.startsWith("data:read:")).map((p) => p.slice(10));
    const online = permissions.some((p) => p === "network" || p.startsWith("network:"));
    let reason = "";
    if (reads.length && online) reason = `${name} may read your ${reads.join(" and ")} records and also reach the internet, so it could send them away`;
    else if (BUILDS_CODE.test(code.replace(/\/\/.*$/gm, ""))) reason = `${name} builds code from text (eval, new Function or import()), so what runs may not be what you read`;
    await ctx.call("data", "put", "security-reviews", { name, verdict: reason ? "blocked" : "allowed", ...(reason ? { reason } : {}), at: new Date().toISOString() });
    return reason ? { block: reason } : undefined;
  });
}
