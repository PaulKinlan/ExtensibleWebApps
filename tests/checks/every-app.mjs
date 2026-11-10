// What a person adds once follows them to every app (src/kernel/user-plugins.ts):
// a plugin of theirs can be used in every app they open on this device, on or
// off in all of them at once, and brought back to one app. A language model
// added from an app (llm.add) is kept that way, so the model and its key are
// added once. With no key anywhere, "Not now" on one model's key card moves
// to the next model, and a picker (in the chat and in the app maker) says
// which model answers, in every app.
//
// It runs in a browser context of its own, so it starts with none of the
// person's plugins and no keys.

import { watchErrors } from "../page-errors.mjs";

/** A model that asks for its own key, as the vendors' plugins do, and says which model answered. */
const model = (id, name) => `export const manifest = { id: "${id}", name: "${name}", permissions: ["provide:llm", "secret:${id}"] };
export default (ctx) => {
  const ready = async () => (await ctx.call("secrets", "has", "${id}")).set;
  ctx.on("llm:providers", async (value) => ({ providers: [...value.providers, { id: "${id}", name: "${name}", ready: await ready() }] }));
  ctx.on("llm:complete", async (request) => {
    if (request.provider !== "${id}") return undefined;
    if (!(await ready()) && !(await ctx.call("secrets", "request", "${id}", { hosts: ["example.com"], label: "${name} key" })).set) return { error: "No ${name} key was given", declined: true };
    return { text: "${id} answered", stop: "end", model: "scripted", usage: { input: 1, output: 1 } };
  });
};`;

/** Asks a model, naming none, each time its app opens. */
const ASKER = `export const manifest = { id: "every-asker", name: "Every asker", permissions: ["llm"], services: ["llm"] };
export default async (ctx) => {
  // The models start beside it.
  for (let i = 0; i < 40 && (await ctx.call("llm", "providers")).filter((p) => p.id.startsWith("every-model-")).length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  await ctx.call("llm", "complete", { messages: [{ role: "user", content: "hello" }] }).catch(() => {});
};`;

const EVERYWHERE = "_everywhere";

export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  watchErrors(page, errors, "every-app");
  const command = (name, args) => page.evaluate(([name, args]) => window.__host.command(name, args), [name, args]);
  const open = async (app, hash = "") => {
    await page.goto(`${URL}${app}/app.html${hash}`);
    if (hash) await page.reload();
    await page.waitForFunction(() => window.__host);
  };
  const review = '[data-key^="review:"]';
  const accept = async (what) => {
    const shown = await page.waitForSelector(`${review} >> text=${what}`, { timeout: 15000 }).then(() => true, () => false);
    await page.click(`${review} button:has-text("Accept")`, { timeout: 5000 }).catch(() => {});
    await page.waitForSelector(review, { state: "detached", timeout: 10000 }).catch(() => {});
    return shown;
  };
  const status = () => page.evaluate(() => document.querySelector("ui-panel [role=status]")?.textContent ?? "");
  const said = (pattern) => page.waitForFunction((source) => new RegExp(source).test(document.querySelector("ui-panel [role=status]")?.textContent ?? ""), pattern.source, { timeout: 20000 }).then(status, status);
  const list = (app) => command("user:list", { app });
  const answeredBy = (id, after = 0) =>
    page.waitForFunction(([id, after]) => window.__host.traces.filter((e) => e.name === "llm:complete" && e.plugin === "every-asker" && e.kind === "call").slice(after).some((e) => (e.detail ?? "").startsWith(`${id} `)), [id, after], { timeout: 20000 }).then(() => true, () => false);
  const keyCard = (name) => `[data-key^="secrets:"]:has-text("${name} key")`;

  try {
    // One of the person's plugins, used in every app.
    await open("demos/invoice", "#add=world-clock");
    await accept("adds Clock");
    await accept("adds World clock");
    await said(/^Added /);
    const button = await page.textContent('[data-reach="world-clock"]').catch(() => "");
    for (const [id, name] of [["clock", "Clock"], ["world-clock", "World clock"]]) {
      await page.click(`[data-reach="${id}"]`);
      const asked = await accept(`uses ${name} in every app`);
      const told = await said(new RegExp(`${name} is now in every app`));
      if (id === "world-clock") check("\"Use in every app\" on one of the person's plugins asks with a review, then says it is in every app", button === "Use in every app" && asked && /World clock is now in every app you open/.test(told), `${button}: ${told}`);
    }
    const pill = await page.evaluate(() => [...document.querySelectorAll(".entry")].find((e) => e.querySelector('[data-reach="world-clock"]'))?.textContent.replace(/\s+/g, " ") ?? "");
    check("Customize says the plugin is the person's in every app, and offers to keep it for this app only", /Yours, in every app/.test(pill) && /Only this app/.test(pill), pill.slice(0, 200));

    await open("demos/trip");
    const drew = await page.waitForFunction(() => /\d\d:\d\d/.test(document.querySelector(".world-clock strong")?.textContent ?? ""), null, { timeout: 15000 }).then(() => true, () => false);
    const there = await list("demos/trip");
    check("a plugin used in every app runs in another app the person opens, with what it needs", drew && there.some((p) => p.id === "world-clock" && p.on && p.everywhere) && there.some((p) => p.id === "clock" && p.on && p.everywhere), JSON.stringify(there.map((p) => [p.id, p.on, !!p.everywhere])));

    // Off in one app is off in all of them: it is one plugin, kept once.
    await command("user:off", { app: "demos/trip", id: "world-clock" });
    const off = (await list("demos/invoice")).find((p) => p.id === "world-clock");
    check("turning it off in one app turns it off in every app", !!off && !off.on && off.everywhere === true, JSON.stringify(off));
    await command("user:on", { app: "demos/trip", id: "world-clock" });

    // Back to one app, with another app open in a second tab and running it too.
    const tab2 = await own.newPage();
    watchErrors(tab2, errors, "every-app (second tab)");
    await tab2.goto(`${URL}demos/invoice/app.html`);
    const clock = () => /\d\d:\d\d/.test(document.querySelector(".world-clock strong")?.textContent ?? "");
    const both = (await tab2.waitForFunction(clock, null, { timeout: 15000 }).then(() => true, () => false)) && (await page.waitForFunction(clock, null, { timeout: 15000 }).then(() => true, () => false));
    await page.click("ui-panel .launch");
    await page.click('[data-reach="world-clock"]');
    const back = await said(/World clock is now only in this app/);
    const here = (await list("demos/trip")).find((p) => p.id === "world-clock");
    const gone = !(await list("demos/invoice")).some((p) => p.id === "world-clock");
    check("\"Only this app\" keeps it for this app, on as it was, and takes it out of the others", /only in this app/.test(back) && !!here && here.on && !here.everywhere && gone, `${back} ${JSON.stringify(here)} gone:${gone}`);
    // The move changed where the plugin is kept while both tabs ran it: the app that keeps it still runs it, and the other lets it go.
    const stays = await page.waitForFunction(clock, null, { timeout: 15000 }).then(() => true, () => false);
    const leaves = await tab2.waitForSelector(".world-clock", { state: "detached", timeout: 15000 }).then(() => true, () => false);
    check("with two apps open and running it, the one that keeps it goes on showing it and the other stops", both && stays && leaves, `${both} ${stays} ${leaves}`);
    await tab2.close();
    for (const app of ["demos/trip", "demos/invoice"]) for (const id of ["world-clock", "clock"]) await command("user:remove", { app, id }).catch(() => {});

    // A model added from an app is kept for every app.
    await open("demos/contacts");
    await page.click("ui-panel .launch");
    await page.click('[data-package="ask-the-page"]');
    await accept("adds Ask the page");
    const ask = '[data-key^="ask-the-page@"]';
    await page.waitForSelector(`${ask} [data-action="model:llm-anthropic"]`, { state: "attached", timeout: 15000 }).catch(() => {});
    await page.click(`${ask} [data-action="model:llm-anthropic"]`).catch(() => {});
    const forAll = await accept("adds Claude (Anthropic), for every app");
    await page.waitForSelector(`${ask} option[value="llm-anthropic"]`, { state: "attached", timeout: 15000 }).catch(() => {});
    const elsewhere = (await list("demos/trip")).find((p) => p.id === "llm-anthropic");
    check("a model added from one app is added for every app, and its review says so", forAll && !!elsewhere && elsewhere.on && elsewhere.everywhere === true, JSON.stringify(elsewhere));
    await command("user:remove", { app: "demos/contacts", id: "llm-anthropic" });
    await command("user:remove", { app: "demos/contacts", id: "ask-the-page" });

    // With no key anywhere, "Not now" on the first model's card moves to the next model.
    for (const [id, name] of [["every-model-a", "Model A"], ["every-model-b", "Model B"]]) await command("user:add", { app: EVERYWHERE, files: [{ name: `${id}.js`, data: model(id, name) }] });
    await command("user:add", { app: EVERYWHERE, files: [{ name: "every-asker.js", data: ASKER }] });
    for (const id of ["every-model-a", "every-model-b"]) await command("user:on", { app: EVERYWHERE, id });
    await command("user:on", { app: EVERYWHERE, id: "every-asker" });
    await open("demos/contacts");
    // Whichever model is listed first asks first: the models start beside each other.
    const names = { "every-model-a": "Model A", "every-model-b": "Model B" };
    await page.waitForSelector('[data-key^="secrets:"]', { timeout: 15000 }).catch(() => {});
    const declined = (await page.isVisible(keyCard("Model A"))) ? "every-model-a" : "every-model-b";
    const keyed = declined === "every-model-a" ? "every-model-b" : "every-model-a";
    const first = await page.isVisible(keyCard(names[declined]));
    await page.click(`${keyCard(names[declined])} button:has-text("Not now")`).catch(() => {});
    const second = await page.waitForSelector(keyCard(names[keyed]), { timeout: 15000 }).then(() => true, () => false);
    await page.fill(`${keyCard(names[keyed])} input[type=password]`, "a-key-for-it").catch(() => {});
    await page.click(`${keyCard(names[keyed])} button:has-text("Save")`).catch(() => {});
    check("with no key anywhere, \"Not now\" on one model's key card moves on to the next model, which answers once it has its key", first && second && (await answeredBy(keyed)), `${first} ${second}, declined ${declined}`);

    // In another app: the same models, and the key given once.
    await open("demos/trip");
    const followed = await answeredBy(keyed);
    const cards = await page.locator('[data-key^="secrets:"]').count();
    check("in another app the same model answers with the key given once: nothing asks again", followed && cards === 0, `${followed}, ${cards} cards`);

    // The picker, where a person writes to a model: the chat, and the app maker. The pick holds in every app.
    await open("demos/assistant");
    const chat = '[data-key^="chat@"]';
    const picker = `${chat} select[data-action="model"]`;
    const offered = await page.waitForFunction(([picker, keyed]) => document.querySelector(picker)?.options.length >= 3 && document.querySelector(picker).value === keyed, [picker, keyed], { timeout: 15000 }).then(() => true, () => false);
    const options = await page.evaluate((picker) => [...(document.querySelector(picker)?.options ?? [])].map((o) => `${o.value}:${o.textContent}${o.selected ? ":picked" : ""}`), picker);
    check("the chat offers the app's models to pick from, says which ask for a key, and shows the one that answers now", offered && options.includes(`${keyed}:${names[keyed]}:picked`) && options.includes(`${declined}:${names[declined]} (asks for your key)`), options.join(" | "));
    await page.selectOption(picker, declined).catch(() => {});
    // The pick is kept by the kernel: opening the app again shows it, once it has been saved.
    await page.waitForTimeout(500);
    await open("demos/assistant");
    const held = await page.waitForFunction(([picker, declined]) => document.querySelector(picker)?.value === declined, [picker, declined], { timeout: 15000 }).then(() => true, () => false);
    check("the pick is kept: the chat shows it when the app opens again", held);
    await open("new");
    const maker = 'select[data-action="model"]';
    const kept = await page.waitForFunction(([maker, declined]) => document.querySelector(maker)?.value === declined, [maker, declined], { timeout: 15000 }).then(() => true, () => false);
    check("the model picked in one app is the one picked in the app maker too", kept, await page.evaluate((maker) => [...(document.querySelector(maker)?.options ?? [])].map((o) => `${o.value}${o.selected ? ":picked" : ""}`).join(" | "), maker).catch(() => ""));
    // The asker, opened with the app maker's page, asks the picked model: its key card says so.
    const asksPicked = await page.waitForSelector(keyCard(names[declined]), { timeout: 15000 }).then(() => true, () => false);
    check("a request that names no model goes to the one the person picked, not the first with a key", asksPicked);
    await page.click(`${keyCard(names[declined])} button:has-text("Not now")`).catch(() => {});
  } finally {
    for (const id of ["every-asker", "every-model-a", "every-model-b", "llm-anthropic", "world-clock", "clock"]) await command("user:remove", { app: EVERYWHERE, id }).catch(() => {});
    await own.close();
  }
}
