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
  ctx.routes.add("POST", "probe", async ({ form }) => {
    try {
      const answer = await fetch(String(form?.url));
      return { json: { ok: true, status: answer.status, text: (await answer.text()).slice(0, 100) } };
    } catch (error) {
      return { json: { ok: false, error: String(error?.cause?.message ?? error?.message ?? error) } };
    }
  });
}
