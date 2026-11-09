// A game on a space's server, and a debugger hearing that server as it
// happens. Ann makes a space and invites Ben; both open Glowfall together
// there. The game loop runs in the space's own kernel (together.js), each
// move goes to it as a live message (sync.live) and each frame comes back to
// both of them. Ann's debugger, in the same space, streams the server's
// trace (sync.trace) and sees the game start; Ben, who never asked, gets no
// trace on his socket at all.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/server/serve.ts";

const LOBBY = '[data-plugin="glowfall-lobby"]';
const EVENTS = '[data-plugin="debugger-space-events"]';

async function signUp(browser, address, name, errors) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto(address);
  await page.fill("#name", name);
  await page.click('#register button[type="submit"]');
  await page.waitForSelector("#in:not([hidden])", { timeout: 8000 });
  return { context, page };
}

export default async function ({ check, context, errors, URL }) {
  const browser = context.browser();

  // Outside a space, the lobby says where to play.
  const alone = await context.newPage();
  await alone.goto(`${URL}demos/glowfall-together/app.html`);
  check("Glowfall together: outside a space, the lobby says how to play in one", await alone.waitForSelector(`${LOBBY} >> text=Everyone in a space plays`, { timeout: 10000 }).then(() => true, () => false));
  await alone.close();

  const spaces = await mkdtemp(join(tmpdir(), "glowfall-together-"));
  const server = await serve({ port: 0, host: "localhost", spaces, site: "dist", kernel: ".build/server/space.js" });
  const devices = [];
  try {
    const ann = await signUp(browser, `${server.url}/account/`, "Ann", errors);
    devices.push(ann.context);
    await ann.page.fill("#space-name", "play");
    await ann.page.click('#new-space button[type="submit"]');
    await ann.page.waitForSelector('#spaces button:has-text("Invite someone")', { timeout: 8000 });
    await ann.page.click('#spaces button:has-text("Invite someone")');
    await ann.page.waitForSelector("#invite-link:not([hidden])", { timeout: 8000 });
    const ben = await signUp(browser, await ann.page.inputValue("#invite-url"), "Ben", errors);
    devices.push(ben.context);

    // Ann's debugger first, listening to the server.
    const debug = await ann.context.newPage();
    debug.on("pageerror", (e) => errors.push(`debugger: ${e.message}`));
    await debug.goto(`${server.url}/s/play/demos/debugger/app.html`);
    const live = await debug.waitForSelector(`${EVENTS} >> text=live`, { timeout: 20000 }).then(() => true, () => false);
    check("debugger: in a space, the space server events panel streams the server's trace (sync.trace)", live, (await debug.textContent(EVENTS).catch(() => "")).slice(0, 200));

    const game = `${server.url}/s/play/demos/glowfall-together/`;
    await ann.page.goto(game);
    await ben.page.goto(game);
    const both = async (page) => page.waitForFunction((s) => document.querySelectorAll(`${s} .players li`).length === 2, LOBBY, { timeout: 25000 }).then(() => true, () => false);
    check("Glowfall together: both members join the game on the space's server, and each sees the other", (await both(ann.page)) && (await both(ben.page)), (await ann.page.textContent(LOBBY).catch(() => "")).replace(/\s+/g, " ").slice(0, 200));

    // A socket of Ben's own to the space, as his device opens one: every message the space sends it, while the game starts.
    await ben.page.evaluate((url) => {
      window.__heard = [];
      const ws = new WebSocket(url);
      window.__probe = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: "hello", tab: "probe" }));
        ws.send(JSON.stringify({ t: "sync", op: "hello", since: 0 }));
      };
      ws.onmessage = (e) => window.__heard.push(String(e.data).slice(0, 200));
    }, `${server.url.replace(/^http/, "ws")}/s/play/kernel`);
    await ben.page.waitForTimeout(500);
    await ann.page.click(`${LOBBY} button[data-action="start"]`);
    const playing = (page) => page.waitForSelector(`${LOBBY} >> text=Playing`, { timeout: 10000 }).then(() => true, () => false);
    check("Glowfall together: one starts the game, and it starts for everyone", (await playing(ann.page)) && (await playing(ben.page)));

    // Ben taps the first lane: the server moves his jar, and Ann sees it there.
    const canvas = ben.page.locator('[data-plugin="glowfall-field"] canvas');
    const box = await canvas.boundingBox();
    // The field drops a tap until its first frame from the server has arrived (field.js: no state yet), which on
    // a busy machine can be after the lobby says Playing: so tap again, a few times, until Ann sees it.
    let seen = false;
    for (let tries = 0; tries < 4 && !seen; tries++) {
      await ben.page.mouse.click(box.x + box.width * 0.05, box.y + box.height * 0.6);
      seen = await ann.page.waitForFunction((s) => [...document.querySelectorAll(`${s} .players li`)].some((li) => li.dataset.you !== "true" && li.dataset.jar === "0"), LOBBY, { timeout: 3000 }).then(() => true, () => false);
    }
    check("Glowfall together: a tap on one member's screen moves their jar in the server's game, and the other member's frames show it", seen);

    const started = await debug.waitForSelector(`${EVENTS} >> text=game:started`, { timeout: 8000 }).then(() => true, () => false);
    check("debugger: the server's events arrive as they happen (the game starting on the server)", started);
    const benHeard = await ben.page.evaluate(() => window.__heard);
    check("a space's server sends its trace only to a debugger that asked: another member's socket gets none", benHeard.length > 0 && !benHeard.some((m) => m.includes('"t":"trace"') || m.includes('"op":"trace"')), `${benHeard.length} messages: ${benHeard.slice(0, 3).join(" | ")}`);

    // The referee (referee.js): Ben holds the arrow down, faster than a person taps, and his second device asks for a jar too.
    await ben.page.locator('[data-plugin="glowfall-field"] canvas').focus().catch(() => {});
    for (let i = 0; i < 40; i++) await ben.page.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowRight", { delay: 0 });
    const aside = await ann.page.waitForFunction((s) => [...document.querySelectorAll(`${s} .players li`)].some((li) => li.dataset.you !== "true" && /set aside/.test(li.textContent)), LOBBY, { timeout: 8000 }).then(() => true, () => false);
    check("Glowfall together: the referee sets aside moves faster than a person's, and every lobby shows it", aside, (await ann.page.textContent(LOBBY).catch(() => "")).replace(/\s+/g, " ").slice(0, 300));
    await ben.page.evaluate((topic) => {
      window.__probe?.send(JSON.stringify({ t: "sync", op: "live", topic, value: { type: "join" } }));
    }, "glowfall-together");
    const refused = await ben.page.waitForFunction(() => window.__heard.some((m) => m.includes("refused")), null, { timeout: 8000 }).then(() => true, () => false);
    check("Glowfall together: a member's second device is refused a second jar", refused, (await ben.page.evaluate(() => window.__heard.slice(-3).join(" | "))).slice(0, 300));
  } finally {
    for (const d of devices) await d.close().catch(() => {});
    await server.stop().catch(() => {});
    await rm(spaces, { recursive: true, force: true });
  }
}
