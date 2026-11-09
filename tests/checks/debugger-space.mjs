// The debugger looking inside a space's server (demos/debugger/space.js,
// std/spaces/reflect.ts), in a real browser: someone signs in, makes a
// space and opens Surveys in it, so the space's server runs Surveys'
// server plugin (collect). Then they open the debugger in the same space,
// and its Space server panel shows that kernel: the plugin running there
// with its routes, and their own device connected. Outside a space, the
// panel says how to get there, and sync.reflect refuses.
import { watchErrors } from "../page-errors.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

const PANEL = '[data-plugin="debugger-space"]';

export default async function ({ check, context, errors }) {
  const browser = context.browser();
  const spaces = await mkdtemp(join(tmpdir(), "debugger-space-"));
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" });
  const own = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await own.newPage();
    watchErrors(page, errors, "debugger-space");
    const cdp = await own.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });

    // Outside a space, the panel says where to open it.
    await page.goto(`${server.url}/demos/debugger/app.html`);
    const away = await page.waitForSelector(`${PANEL} >> text=open this debugger in a space`, { timeout: 15000 }).then(() => true, () => false);
    check("debugger: outside a space, the space server panel says how to look inside one", away);

    await page.goto(`${server.url}/account/`);
    await page.fill('form[data-action="register"] input[name="name"]', "Dee");
    await page.click('form[data-action="register"] button[type="submit"]');
    await page.waitForSelector(".signed-in", { timeout: 8000 });
    await page.fill('form[data-action="make"] input[name="name"]', "lab");
    await page.click('form[data-action="make"] button[type="submit"]');
    await page.waitForSelector(".space-list >> text=lab", { timeout: 8000 });

    // Surveys in the space: its server plugin starts on the space's server.
    await page.goto(`${server.url}/s/lab/demos/survey/`);
    await page.waitForSelector('[data-plugin="surveys"]', { timeout: 15000 });

    // A plugin of her own for Surveys, shared with the space: the space keeps it and never runs it.
    const command = (name, arg) => page.evaluate(([n, a]) => window.__host.command(n, a), [name, arg]);
    const note = 'export const manifest = { id: "poll-note", name: "Poll note", description: "A note", permissions: [] };\nexport default () => {};';
    await command("user:add", { app: "demos/survey", files: [{ name: "poll-note.js", data: note }] });
    const sharedOk = await command("user:share", { app: "demos/survey", id: "poll-note" }).catch((e) => ({ error: String(e) }));

    // The debugger, in the same space, in a second tab.
    const debug = await own.newPage();
    watchErrors(debug, errors, "debugger-space");
    await debug.goto(`${server.url}/s/lab/demos/debugger/app.html`);
    const collect = `${PANEL} li.plugin[key="collect"]`;
    const shown = await debug.waitForSelector(collect, { timeout: 20000 }).then(() => true, () => false);
    const text = shown ? (await debug.textContent(collect)).replace(/\s+/g, " ") : await debug.textContent(PANEL).catch(() => "");
    check("debugger: in a space, the space server panel shows the plugin running on its server, with what it was granted and its routes", shown && /runs here/.test(text) && /running/.test(text) && /routes/.test(text), text.slice(0, 300));
    check("debugger: and the member's devices connected to it, by account name", await debug.waitForSelector(`${PANEL} .devices >> text=Dee`, { timeout: 5000 }).then(() => true, () => false));

    await debug.click(`${collect} button[data-action="code:collect"]`);
    const code = await debug.waitForFunction((s) => /runs: "server"/.test(document.querySelector(`${s} ui-code`)?.value ?? document.querySelector(`${s} ui-code`)?.textContent ?? ""), collect, { timeout: 5000 }).then(() => true, () => false);
    check("debugger: it reads a server plugin's code from the space", code);

    // The shared plugin is listed as kept, not run, and its code reads from the space too.
    const kept = `${PANEL} li.plugin[key="poll-note"]`;
    await debug.click(`${PANEL} button[data-action="refresh"]`);
    const listed = await debug.waitForSelector(`${kept} >> text=kept, not run`, { timeout: 10000 }).then(() => true, () => false);
    if (listed) await debug.click(`${kept} button[data-action="code:poll-note"]`);
    const read = listed && (await debug.waitForFunction((s) => /poll-note/.test(document.querySelector(`${s} ui-code`)?.value ?? document.querySelector(`${s} ui-code`)?.textContent ?? ""), kept, { timeout: 5000 }).then(() => true, () => false));
    check("debugger: plugins members share are listed as kept and not run, with their code", listed && read, JSON.stringify(sharedOk));

  } finally {
    await own.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true });
  }
}
