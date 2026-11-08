// Runs on the space's server only, and answers two public routes there:
// a form anyone can post to (POST /s/<space>/server-app/entry), and a count
// of what has come in (GET /s/<space>/server-app/count). Neither needs a
// browser open, or the sender to be a member.
export const manifest = {
  id: "inbox",
  name: "Inbox",
  runs: "server",
  permissions: ["routes"],
  collections: { entries: { title: "Entries", schema: { properties: { text: { type: "string" } }, required: ["text"] } } },
};

export default function (ctx) {
  ctx.routes.add("POST", "entry", async ({ form }) => {
    const text = String(form?.text ?? "").slice(0, 200);
    if (!text) return { status: 400, text: "Say something" };
    await ctx.call("data", "put", "entries", { id: `entry-${Date.now()}`, text });
    return { redirect: "thanks" };
  });
  ctx.routes.add("GET", "count", async () => ({ json: { count: (await ctx.call("data", "list", "entries")).length } }));
}
