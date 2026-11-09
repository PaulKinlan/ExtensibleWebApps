// The homepage's security agent (site/home/security.agent.md), linked for
// everyone. With no model that has its key, its check doesn't run: a plugin
// of the visitor's own goes on to its review card, and nobody is asked for a
// key on the way. Once a model is ready (a scripted one here, as a key would
// make Claude), the agent reads the plugin and can stop it before the card.
// Security check is switched off throughout, so the agent is the one judging.

/** A model with its key: it blocks any plugin it is asked about that sends notes to a server. */
const MODEL = `export const manifest = { id: "scripted-reader", name: "Scripted reader", permissions: ["provide:llm"] };
export default (ctx) => {
  ctx.on("llm:providers", (value) => ({ providers: [...value.providers, { id: "scripted-reader", name: "Scripted reader", ready: true }] }));
  ctx.on("llm:complete", (request) => {
    if (request.provider !== "scripted-reader") return;
    const last = request.messages.at(-1);
    if (last.role === "user" && /plugins:beforeAdd/.test(last.content) && /network/.test(last.content))
      return { text: "", toolCalls: [{ id: "v1", name: "block", args: { reason: "It sends your notes to a server its description doesn't name" } }], stop: "tool", usage: { input: 40, output: 8 } };
    return { text: "", toolCalls: [{ id: "v2", name: "allow", args: {} }], stop: "tool", usage: { input: 10, output: 2 } };
  });
};`;

export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext({ viewport: { width: 1280, height: 900 } });
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL);
  const seen = (selector, timeout = 8000) => page.waitForSelector(selector, { state: "attached", timeout }).then(() => true, () => false);
  const chapter = '[data-plugin="chapter-12-security"]';
  const review = '[data-key^="review:"]';

  try {
    await page.waitForSelector(`${chapter} button[data-action="try"]`, { timeout: 15000 });
    await page.click('slot[name="switchboard"] input[data-action="switch:security-check"]');
    await page.waitForTimeout(800);

    // No key: the agent doesn't run, and doesn't ask for one; the person's card decides.
    await page.click(`${chapter} button[data-action="try"]`);
    const card = await seen(`${review} >> text=Note backup`, 10000);
    check("homepage: with no key, the security agent's check doesn't run, and the plugin goes on to its review card", card);
    check("homepage: and nobody is asked for a key on the way", (await page.locator('input[type="password"]').count()) === 0);
    if (card) await page.click(`${review} >> button:text-is("Decline")`);
    await seen(`${chapter} .outcome >> text=Not saved`, 8000);

    // A model with its key: the agent reads the plugin and stops it before its card.
    await page.evaluate((data) => window.__host.command("user:add", { app: "root", files: [{ name: "scripted-reader.js", data }] }), MODEL);
    await page.evaluate(() => window.__host.command("user:on", { app: "root", id: "scripted-reader" }));
    await page.waitForFunction(() => window.__host.traces.some((e) => e.name === "plugin:ready" && String(e.plugin ?? "").startsWith("scripted-reader")), null, { timeout: 8000 }).catch(() => {});
    await page.click(`${chapter} button[data-action="try"]`);
    const stopped = await seen(`${chapter} .outcome >> text=Stopped before review`, 15000);
    const outcome = (await page.textContent(`${chapter} .outcome`).catch(() => "")) ?? "";
    check("homepage: once a model has its key, the security agent reads the plugin and stops it before its card", stopped && /notes to a server/.test(outcome) && !(await page.$(`${review} >> text=Note backup`)), outcome.replace(/\s+/g, " ").slice(0, 200));
  } finally {
    await page.evaluate(() => window.__host.command("user:remove", { app: "root", id: "scripted-reader" })).catch(() => {});
    await own.close();
  }
}
