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
  // "tampered" fetches after replacing the built-ins a guard might lean on, and puts them back after.
  ctx.routes.add("POST", "probe", async ({ form }) => {
    const undo = form?.how === "tampered" ? tamper() : () => {};
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
    } finally {
      undo();
    }
  });
}

/** Makes every Set say it holds everything, and every string start with anything. */
function tamper() {
  const was = [
    [Set.prototype, "has", () => true],
    [String.prototype, "startsWith", () => true],
  ].map(([target, name, value]) => {
    const old = target[name];
    target[name] = value;
    return () => (target[name] = old);
  });
  return () => was.forEach((put) => put());
}
