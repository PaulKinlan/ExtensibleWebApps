// A person adds a language model and an in-page agent to an app that has
// neither, without touching its files: Ask the page offers the site's models
// (llm.choices) and adds the one they pick (llm.add) as their own plugin; the
// Plugin maker (std/plugin-maker.js) writes a plugin with a model and saves
// it after a review. A scripted model stands in for a vendor.
//
// It runs in a browser context of its own, on the contacts demo, which links
// no model.

/** A model that looks at the page, then saves a card, then says what it did. */
const MODEL = `export const manifest = { id: "scripted-maker-model", name: "Scripted model", permissions: ["provide:llm"] };
export default (ctx) => {
  ctx.on("llm:providers", (value) => ({ providers: [...value.providers, { id: "scripted-maker-model", name: "Scripted model", ready: true }] }));
  ctx.on("llm:complete", (request) => {
    if (request.provider !== "scripted-maker-model") return;
    const last = request.messages[request.messages.length - 1];
    const call = (name, args) => ({ text: "", stop: "tool", toolCalls: [{ id: name, name, args }], usage: { input: 1, output: 1 } });
    if (last.role === "user") return call("page_plugins", {});
    if (last.name === "page_plugins") {
      const told = JSON.parse(last.content).map((p) => p.id).includes("people") ? "people" : "nothing";
      return call("save_plugin", { code: 'export const manifest = { id: "hello-card", name: "Hello card", permissions: ["ui"], places: { hello: { at: "main", put: "prepend" } } };\\nexport default (ctx) => ctx.ui.render("hello", "card", ctx.ui.html\`<ui-card class="hello-card"><p>Hello from ' + told + '</p></ui-card>\`);' });
    }
    return { text: "I saved Hello card. " + last.content.slice(0, 40), stop: "end", usage: { input: 1, output: 1 } };
  });
};`;

export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const app = "demos/contacts";
  await page.goto(`${URL}${app}/app.html`);
  await page.waitForFunction(() => window.__host);
  const command = (name, args) => page.evaluate(([name, args]) => window.__host.command(name, args), [name, { app, ...args }]);
  const seen = (selector, timeout = 10000) => page.waitForSelector(selector, { state: "attached", timeout }).then(() => true, () => false);
  const review = '[data-key^="review:"]';
  /** Accepts the review card that says `what`. The button, not text=Accept: the code on the card may say "accept" too. */
  const accept = async (what) => {
    await page.waitForSelector(`${review} >> text=${what}`, { timeout: 15000 });
    await page.click(`${review} button:has-text("Accept")`);
    await page.waitForSelector(review, { state: "detached", timeout: 10000 }).catch(() => {});
  };
  /** Adds a registry package from Customize, and turns it on. */
  const addFromRegistry = async (id, name) => {
    await page.click("ui-panel .launch");
    await page.click(`[data-package="${id}"]`);
    await accept(`adds ${name}`);
    await page.click(`[data-toggle="${id}"]`);
    await page.waitForSelector(`[data-toggle="${id}"]:has-text("Turn off")`, { timeout: 10000 });
    await page.click("ui-panel .close, ui-panel [data-action='panel']").catch(() => page.keyboard.press("Escape"));
  };
  try {
    const choices = await page.evaluate(() => fetch("/packages/index.json").then((r) => r.json())).then((index) => index.packages.filter((p) => p.permissions.includes("provide:llm")).map((p) => p.id));
    check("the site's registry offers its language models", ["llm-anthropic", "llm-gemini", "llm-openai", "llm-openai-compatible"].every((id) => choices.includes(id)), choices.join());

    // Ask the page, on an app with no model, offers to add one instead of saying to edit app.html.
    await addFromRegistry("ask-the-page", "Ask the page");
    const ask = '[data-key^="ask-the-page@"]';
    const offered = await seen(`${ask} [data-action="model:llm-anthropic"]`);
    check("Ask the page, with no model, offers the site's models to add", offered && !(await page.isVisible(`${ask} >> text=link rel`)), offered ? "" : ((await page.textContent(ask).catch(() => "")) ?? "").slice(0, 300));
    await page.click(`${ask} [data-action="model:llm-anthropic"]`);
    await accept("adds Claude (Anthropic)");
    check("picking one adds it as the person's own plugin, turned on, and Ask the page can use it", await seen(`${ask} option[value="llm-anthropic"]`));
    const mine = await command("user:list", {});
    check("the model is the person's, on this device, not in the app's files", mine.some((p) => p.id === "llm-anthropic" && p.on));

    // The plugin maker writes a plugin with a model and saves it after a review.
    await command("user:add", { files: [{ name: "scripted-maker-model.js", data: MODEL }] });
    await command("user:on", { id: "scripted-maker-model" });
    await addFromRegistry("plugin-maker", "Plugin maker");
    const maker = '[data-key^="plugin-maker@"]';
    await page.waitForSelector(`${maker} option[value="scripted-maker-model"]`, { state: "attached", timeout: 10000 });
    await page.selectOption(`${maker} select`, "scripted-maker-model");
    await page.fill(`${maker} input[name="text"]`, "Say hello at the top");
    await page.click(`${maker} button[type="submit"]`);
    const reviewed = await page.waitForSelector(`${review} >> text=adds Hello card`, { timeout: 15000 }).then(() => true, () => false);
    check("the plugin maker reads the page's plugins, writes a plugin, and shows it on a review card first", reviewed);
    await accept("adds Hello card");
    const shown = await page.waitForSelector(".hello-card >> text=Hello from people", { timeout: 10000 }).then(() => true, () => false);
    check("once accepted, the plugin it wrote runs on the page", shown);
    check("the plugin maker says what it saved", await seen(`${maker} >> text=I saved Hello card`));
  } finally {
    for (const id of ["hello-card", "plugin-maker", "scripted-maker-model", "llm-anthropic", "ask-the-page"]) await command("user:remove", { id }).catch(() => {});
    await own.close();
  }
}
