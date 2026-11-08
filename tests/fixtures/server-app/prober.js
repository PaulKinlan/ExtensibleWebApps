// Runs on the space's server only, with `network`: a public route that
// fetches the address it's given and says what happened, so the checks can
// see what a server plugin may reach (src/server/network-guard.ts).
export const manifest = {
  id: "prober",
  name: "Prober",
  runs: "server",
  permissions: ["routes", "network"],
};

export default function (ctx) {
  // `how`: fetch (the default), or around it: through the dispatcher fetch uses, or an Agent of the plugin's own.
  ctx.routes.add("POST", "probe", async ({ form }) => {
    try {
      const url = new URL(String(form?.url));
      if (form?.how === "dispatcher" || form?.how === "agent") {
        const dispatcher = globalThis[Symbol.for("undici.globalDispatcher.1")];
        const via = form.how === "agent" ? new dispatcher.constructor() : dispatcher;
        const answer = await via.request({ origin: url.origin, path: url.pathname, method: "GET" });
        return { json: { ok: true, status: answer.statusCode, text: (await answer.body.text()).slice(0, 100) } };
      }
      const answer = await fetch(url);
      return { json: { ok: true, status: answer.status, text: (await answer.text()).slice(0, 100) } };
    } catch (error) {
      return { json: { ok: false, code: error?.cause?.code ?? error?.code, error: String(error?.cause?.message ?? error?.message ?? error) } };
    }
  });
}
