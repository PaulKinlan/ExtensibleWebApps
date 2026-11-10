// "Write it for me" in Customize's Make tab: the tab offers the plugin maker
// (std/plugin-maker.js), and once it is on the page it draws in the tab's own
// slot (customize.make), so a person describes a plugin where they make
// plugins. What it writes is reviewed and saved like any other. A scripted
// model stands in for a vendor.
//
// It runs in a browser context of its own, on the contacts demo.

import { watchErrors } from "../page-errors.mjs";

/** A model that looks at the page, then saves a card, then says what it did. */
const MODEL = `export const manifest = { id: "written-for-me-model", name: "Scripted model", permissions: ["provide:llm"] };
export default (ctx) => {
  ctx.on("llm:providers", (value) => ({ providers: [...value.providers, { id: "written-for-me-model", name: "Scripted model", ready: true }] }));
  ctx.on("llm:complete", (request) => {
    if (request.provider !== "written-for-me-model") return;
    const last = request.messages[request.messages.length - 1];
    const call = (name, args) => ({ text: "", stop: "tool", toolCalls: [{ id: name, name, args }], usage: { input: 1, output: 1 } });
    if (last.role === "user") return call("page_plugins", {});
    if (last.name === "page_plugins") {
      const told = JSON.parse(last.content).map((p) => p.id).includes("people") ? "people" : "nothing";
      return call("save_plugin", { code: 'export const manifest = { id: "written-card", name: "Written card", permissions: ["ui"], places: { hello: { at: "main", put: "prepend" } } };\\nexport default (ctx) => ctx.ui.render("hello", "card", ctx.ui.html\`<ui-card class="written-card"><p>Hello from ' + told + '</p></ui-card>\`);' });
    }
    return { text: "I saved Written card. " + last.content.slice(0, 40), stop: "end", usage: { input: 1, output: 1 } };
  });
};`;

export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  watchErrors(page, errors, "write-it-for-me");
  const app = "demos/contacts";
  await page.goto(`${URL}${app}/app.html`);
  await page.waitForFunction(() => window.__host);
  const command = (name, args) => page.evaluate(([name, args]) => window.__host.command(name, args), [name, { app, ...args }]);
  const review = '[data-key^="review:"]';
  const accept = async (what) => {
    const shown = await page.waitForSelector(`${review} >> text=${what}`, { timeout: 15000 }).then(() => true, () => false);
    await page.click(`${review} button:has-text("Accept")`, { timeout: 5000 }).catch(() => {});
    await page.waitForSelector(review, { state: "detached", timeout: 10000 }).catch(() => {});
    return shown;
  };
  try {
    await command("user:add", { files: [{ name: "written-for-me-model.js", data: MODEL }] });
    await command("user:on", { id: "written-for-me-model" });
    await page.reload();
    await page.waitForFunction(() => window.__host);
    await page.click("ui-panel .launch");
    await page.click('[data-tab="make"]');
    const offered = await page.waitForSelector("ui-panel [data-add-maker]", { timeout: 10000 }).then(() => true, () => false);
    check("Make offers to have the plugin written, beside the starters", offered && (await page.isVisible('ui-panel [data-starter]')));
    await page.click("ui-panel [data-add-maker]");
    const asked = await accept("adds Plugin maker");
    // In the tab's slot, inside the panel.
    const maker = 'ui-panel slot[name="customize.make"] .maker';
    const inTab = await page.waitForSelector(`${maker} input[name="text"]`, { timeout: 15000 }).then(() => true, () => false);
    await page.click('[data-tab="make"]').catch(() => {});
    const visible = inTab && (await page.waitForSelector(`${maker} input[name="text"]`, { state: "visible", timeout: 10000 }).then(() => true, () => false));
    const gone = !(await page.locator("ui-panel [data-add-maker]").count());
    check("\"Write it for me\" adds the plugin maker after its review, and it draws in the Make tab", asked && visible && gone, `${asked} ${inTab} ${visible} ${gone}`);

    await page.fill(`${maker} input[name="text"]`, "Say hello at the top");
    await page.click(`${maker} button[type="submit"]`);
    const reviewed = await accept("adds Written card");
    const shown = await page.waitForSelector(".written-card >> text=Hello from people", { timeout: 15000 }).then(() => true, () => false);
    check("what the person describes there is written, shown on a review card, and runs once accepted", reviewed && shown, `${reviewed} ${shown}`);
    const told = await page.waitForSelector(`${maker} >> text=I saved Written card`, { timeout: 10000 }).then(() => true, () => false);
    check("the Make tab says what was saved, with the panel still open", told && (await page.isVisible(maker)));
  } finally {
    for (const id of ["written-card", "plugin-maker", "written-for-me-model"]) await command("user:remove", { id }).catch(() => {});
    await own.close();
  }
}
