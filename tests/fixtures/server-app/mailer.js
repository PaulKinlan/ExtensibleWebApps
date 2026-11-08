// Runs on the space's server only, and sends email for a public route
// (POST /s/<space>/server-app/notify), answering with what the email service
// said. The checks send good mail, bad mail, and more than a day's worth.
export const manifest = {
  id: "mailer",
  name: "Mailer",
  runs: "server",
  permissions: ["routes", "email"],
};

export default function (ctx) {
  ctx.routes.add("POST", "notify", async ({ form }) => {
    try {
      return { json: await ctx.call("email", "send", form) };
    } catch (error) {
      return { status: 400, json: { ok: false, error: String(error?.message ?? error) } };
    }
  });
}
