// A plugin whose service call is waiting when the provider is swapped.
//
// The World clock asks the clock service for the time. When a person turns on
// another clock, the first one stops, and a call it hadn't answered fails with
// "plugin stopped". The World clock must take that as "ask again", not let it
// go uncaught: uncaught, it was the "plugin stopped" error that failed main's
// checks now and then (the swap in maker-for-real.mjs sometimes landed while
// the World clock's first call was waiting).
//
// Here the first clock never answers, so the call is always waiting when the
// swap happens.
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

export default async function ({ check, context, URL, errors }) {
  const own = await context.browser().newContext();
  const page = await own.newPage();
  watchErrors(page, errors, "provider-swap");
  try {
    await page.goto(`${URL}demos/trip/app.html`);
    await page.waitForFunction(() => window.__host);
    const app = "demos/trip";
    const command = (name, arg) => page.evaluate(([name, arg]) => window.__host.command(name, arg), [name, { app, ...arg }]);
    const seq = () => page.evaluate(() => window.__host.traces.at(-1)?.seq ?? 0);
    const ready = (since, id) => page.waitForFunction(([since, id]) => window.__host.traces.some((e) => e.seq > since && e.name === "plugin:ready" && e.plugin?.startsWith(id)), [since, id], { timeout: 10000 }).then(() => true, () => false);

    await command("user:add", { files: [{ name: "clock-never.js", data: clock("clock-never", "new Promise(() => {})") }] });
    await command("user:add", { files: [{ name: "clock-noon.js", data: clock("clock-noon", '({ time: "12:34", date: "Mon 1 Jan", timeZone: "UTC" })') }] });
    await command("user:add", { url: "/packages/world-clock/world-clock.js" });
    let since = await seq();
    await command("user:on", { id: "clock-never" });
    await command("user:on", { id: "world-clock" });
    const started = await ready(since, "world-clock");
    // Its first call is with the clock that never answers.
    await page.waitForTimeout(500);

    since = await seq();
    await command("user:on", { id: "clock-noon" });
    const swapped = await ready(since, "clock-noon");
    const drew = await page.waitForSelector('.world-clock strong >> text="12:34"', { timeout: 8000 }).then(() => true, () => false);
    const uncaught = await page.evaluate((since) => window.__host.traces.filter((e) => e.seq > since && e.name === "plugin:log" && e.kind === "error" && e.plugin?.startsWith("world-clock")).map((e) => e.detail), since);
    check("a plugin whose call was waiting when its service's provider was swapped asks the new one", started && swapped && drew, `started ${started}, swapped ${swapped}, drew ${drew}`);
    check("…and the failed call isn't left uncaught", !uncaught.length, uncaught.join("; "));
    for (const id of ["world-clock", "clock-noon", "clock-never"]) await command("user:remove", { id }).catch(() => {});
  } finally {
    await own.close();
  }
}
