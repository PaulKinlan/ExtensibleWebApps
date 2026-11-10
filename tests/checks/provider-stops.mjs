// A service whose provider stops, or is off, while other plugins call it.
//
// A plugin can provide a service (src/kernel/provided.ts), and a person can turn that plugin off, or turn on
// another that provides the same service, at any moment. A call that was waiting then fails, and so does one
// made while it is off. Two things are checked:
//
// - The failure says which call wasn't answered and which plugin provides the service. It used to be the bare
//   words "plugin stopped", which named neither.
// - A plugin that leaves that failure uncaught doesn't get an error for it. Turning a plugin off isn't a
//   mistake in the plugins that use it, so the uncaught failure is a note in the trace and nothing is thrown on
//   the page. Checked with a plugin written for this, and with the Markdown editor, whose document service
//   about twenty plugins call from their buttons: six of them left it uncaught.
//
// A command is answered by one plugin too (std/commands/module.ts), so the same is checked for a command whose
// plugin stops while it runs: whoever ran it is told which command.
//
// provider-swap.mjs is the other half: a plugin that catches the failure asks again and draws.
import { watchErrors } from "../page-errors.mjs";

const clock = (id, body) => `export const manifest = {
  id: "${id}",
  name: "${id}",
  version: "1.0.0",
  permissions: ["provide:clock"],
  provides: { clock: { description: "A clock.", methods: { now: { args: "()", description: "Now." } } } },
};
export default function (ctx) {
  ctx.provide("clock", { now: () => ${body} });
}
`;

// Asks the clock twice: it catches the first call's failure and says what it was told; the second it leaves uncaught.
const asker = `export const manifest = {
  id: "clock-asker",
  name: "Clock asker",
  version: "1.0.0",
  permissions: ["clock"],
  services: ["clock"],
};
export default function (ctx) {
  ctx.call("clock", "now").then(() => ctx.log("caught nothing"), (error) => ctx.log("caught " + error.message));
  void ctx.call("clock", "now");
}
`;

// A command that never finishes, and a plugin that runs it and says how that went.
const slow = `export const manifest = { id: "slow-command", name: "Slow command", permissions: ["commands"], services: ["commands"] };
export default (ctx) => {
  ctx.commands.add({ id: "wait", title: "Wait for ever" }, () => new Promise(() => {}));
  ctx.log("slow-command added");
};`;
const runner = `export const manifest = { id: "command-runner", name: "Command runner", permissions: ["commands"], services: ["commands"] };
export default (ctx) => {
  ctx.call("commands", "run", "slow-command/wait").then(() => ctx.log("ran"), (error) => ctx.log("ran into " + error.message));
};`;

// Turns one of the app's own plugins on or off, as the plugins list does, then says so.
const switcher = (id, on) => `export const manifest = { id: "provider-switch", name: "Provider switch", scope: "tab", permissions: ["plugins:manage"] };
export default async (ctx) => {
  await ctx.call("plugins", "setEnabled", ${JSON.stringify(id)}, ${on});
  ctx.log("switched ${on ? "on" : "off"}");
};`;

export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext({ viewport: { width: 1400, height: 1000 } });
  // Errors thrown on these pages are this check's to judge; the runner's list still gets them.
  const thrown = [];
  const open = async (path, label) => {
    const page = await own.newPage();
    watchErrors(page, errors, label);
    page.on("pageerror", (e) => thrown.push(e.message));
    await page.goto(`${URL}${path}`);
    await page.waitForFunction(() => window.__host);
    return page;
  };
  const seq = (page) => page.evaluate(() => window.__host.traces.at(-1)?.seq ?? 0);
  /** The plugin logs (notes and errors) since `since`, as "<kind> <plugin id> <text>". */
  const logs = (page, since) => page.evaluate((since) => window.__host.traces.filter((e) => e.seq > since && e.name === "plugin:log").map((e) => `${e.kind} ${e.plugin?.split("@")[0]} ${e.detail}`), since);
  const logged = (page, since, text, timeout = 10000) => page.waitForFunction(([since, text]) => window.__host.traces.some((e) => e.seq > since && e.name === "plugin:log" && e.detail?.includes(text)), [since, text], { timeout }).then(() => true, () => false);

  try {
    // ---- A provider swapped while calls are waiting ----
    {
      const page = await open("demos/trip/app.html", "provider-stops");
      const app = "demos/trip";
      const command = (name, arg) => page.evaluate(([name, arg]) => window.__host.command(name, arg), [name, { app, ...arg }]);
      const ready = (since, id) => page.waitForFunction(([since, id]) => window.__host.traces.some((e) => e.seq > since && e.name === "plugin:ready" && e.plugin?.startsWith(id)), [since, id], { timeout: 10000 }).then(() => true, () => false);
      await command("user:add", { files: [{ name: "clock-never.js", data: clock("clock-never", "new Promise(() => {})") }] });
      await command("user:add", { files: [{ name: "clock-noon.js", data: clock("clock-noon", '({ time: "12:34" })') }] });
      await command("user:add", { files: [{ name: "clock-asker.js", data: asker }] });
      let since = await seq(page);
      await command("user:on", { id: "clock-never" });
      await command("user:on", { id: "clock-asker" });
      const started = await ready(since, "clock-asker");
      // Both its calls are with the clock that never answers.
      await page.waitForTimeout(500);
      since = await seq(page);
      await command("user:on", { id: "clock-noon" });
      const caught = await logged(page, since, "caught ");
      await page.waitForTimeout(500);
      const said = await logs(page, since);
      const message = "clock.now wasn't answered: “clock-never”, which provides clock, stopped";
      check("a call left waiting when its service's provider stops fails saying which call and which plugin", started && caught && said.includes(`note clock-asker caught ${message}`), said.join("; ") || `started ${started}`);
      check(
        "…and left uncaught, it is a note in the trace, not the calling plugin's error, and nothing is thrown on the page",
        said.includes(`note clock-asker ${message}`) && !said.some((line) => line.startsWith("error ")) && !thrown.length,
        [...said, ...thrown].join("; "),
      );
      for (const id of ["clock-asker", "clock-noon", "clock-never"]) await command("user:remove", { id }).catch(() => {});

      // ---- A command whose plugin stops while it runs ----
      since = await seq(page);
      await page.evaluate((source) => window.__host.command("install", source), slow);
      await logged(page, since, "slow-command added");
      await page.evaluate((source) => window.__host.command("install", source), runner);
      // The command is running, and will never answer.
      await page.waitForFunction((since) => window.__host.traces.some((e) => e.seq > since && e.name?.startsWith("command:slow-command")), since, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__host.command("uninstall", "slow-command"));
      await logged(page, since, "ran into ");
      const ran = (await logs(page, since)).filter((line) => line.includes("command-runner"));
      check("a command whose plugin stops while it runs fails saying which command", ran.includes("note command-runner ran into slow-command/wait wasn't answered: its plugin stopped"), ran.join("; "));
      await page.evaluate(() => window.__host.command("uninstall", "command-runner")).catch(() => {});
      await page.close();
    }

    // ---- The Markdown editor with its document turned off ----
    {
      thrown.length = 0;
      const page = await open("demos/markdown-editor/app.html", "provider-stops editor");
      const editor = () => page.evaluate(() => document.querySelector("ui-editor")?.value ?? "");
      const opened = await page.waitForFunction(() => document.querySelector("ui-editor")?.value?.includes("Welcome to the editor"), null, { timeout: 20000 }).then(() => true, () => false);
      // Every plugin has drawn: the outline has its headings and the status bar its counts.
      await page.waitForSelector('[data-key="outline:outline"] [data-action="jump:1"]', { timeout: 10000 }).catch(() => {});
      await page.waitForFunction(() => /\d+ words/.test(document.querySelector("footer")?.textContent ?? ""), null, { timeout: 10000 }).catch(() => {});
      const turn = async (on) => {
        const since = await seq(page);
        await page.evaluate((source) => window.__host.command("install", source), switcher("posts", on));
        const done = await logged(page, since, `switched ${on ? "on" : "off"}`);
        await page.evaluate(() => window.__host.command("uninstall", "provider-switch")).catch(() => {});
        return done;
      };
      const off = await turn(false);
      const since = await seq(page);
      // What a person can still press with Posts off. Each of these calls the document service.
      const pressed = [];
      const press = async (selector) => pressed.push(await page.click(selector, { timeout: 5000 }).then(() => true, () => false));
      await press('[data-key="outline:outline"] [data-action="jump:1"]');
      await press('[data-key="spell-check:toggle"] [data-action="toggle"]');
      await press('[data-key="front-matter:form"] [data-action="now:date"]');
      await press('[data-key="emoji:button"] [data-action="toggle"]');
      await press('[data-key^="emoji:"] [data-action="pick:0"]');
      await press('[data-key="tag-suggester:button"] [data-action="toggle"]');
      await press('[data-key="hugo-preview:button"] [data-action="toggle"]');
      // A call waits a few seconds for a provider that hasn't started yet, then gives up. All six have by now.
      const callers = ["outline", "spell-check", "front-matter", "emoji", "tag-suggester", "hugo-preview"];
      const told = (lines) => callers.filter((id) => lines.some((line) => line.startsWith(`note ${id} document.`) && line.endsWith("wasn't answered: “Posts”, which provides document, isn't running")));
      let lines = [];
      for (let waited = 0; waited < 15000 && told(lines).length < callers.length; waited += 500) {
        await page.waitForTimeout(500);
        lines = await logs(page, since);
      }
      const problems = lines.filter((line) => line.startsWith("error "));
      check(
        "with the Markdown editor's document turned off, a plugin that calls it is told which call wasn't answered and why",
        opened && off && pressed.every(Boolean) && told(lines).length === callers.length,
        `opened ${opened}, off ${off}, pressed ${pressed.join(",")}, told ${told(lines).join(",")}; ${lines.slice(0, 4).join("; ")}`,
      );
      check("…and none of them has an error for it, in the trace or thrown on the page", !problems.length && !thrown.length, [...problems, ...thrown].join("; "));

      // Turned back on, the editor opens the post again and its plugins reach it: the emoji picker's pick goes in.
      const on = await turn(true);
      const back = await page.waitForFunction(() => document.querySelector("ui-editor")?.value?.includes("Welcome to the editor"), null, { timeout: 15000 }).then(() => true, () => false);
      const before = await editor();
      if (!(await page.$('[data-key^="emoji:"] [data-action="pick:0"]'))) await page.click('[data-key="emoji:button"] [data-action="toggle"]', { timeout: 5000 }).catch(() => {});
      await page.click('[data-key^="emoji:"] [data-action="pick:0"]', { timeout: 5000 }).catch(() => {});
      const inserted = await page.waitForFunction((n) => (document.querySelector("ui-editor")?.value ?? "").length > n, before.length, { timeout: 10000 }).then(() => true, () => false);
      check("turned on again, the document answers the same plugins", on && back && inserted, `on ${on}, back ${back}, inserted ${inserted}`);
      await page.close();
    }
  } finally {
    await own.close();
  }
}
