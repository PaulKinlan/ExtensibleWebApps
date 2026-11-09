// A loop that isn't the standard one: it only says what woke it. The kernel
// puts it after the manifest and the AGENT constant it makes from the agent file.
export default async function (ctx) {
  ctx.log(`${AGENT.name} plans first, then acts`);
}
