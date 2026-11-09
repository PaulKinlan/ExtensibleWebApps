// Kernel modules keep Cordis's promise (src/kernel/modules.ts): stopping a
// module takes back everything it added (its service, commands and hooks),
// the modules that use it stop with it, and all of them come back when it
// starts again. Each module in kernel.json is restarted here, and the kernel
// must look the same afterwards.
import { readFileSync } from "node:fs";

export default async function ({ check, a }) {
  const { modules } = JSON.parse(readFileSync(new URL("../../kernel.json", import.meta.url), "utf8"));
  // What the modules add, as the kernel describes itself: its services, hooks and reserved names.
  const shape = async () => {
    const { data } = await a.evaluate(() => window.__host.command("reference"));
    return JSON.stringify({ services: data.services.map((s) => s.name).sort(), hooks: data.hooks.map((h) => h.name).sort(), reserved: data.reservedIds });
  };
  const before = await shape();
  const results = {};
  for (const name of modules) results[name] = await a.evaluate((n) => window.__host.command("restart-module", n), name);
  const failed = Object.entries(results).filter(([, r]) => !r?.ok);
  check("every kernel module can be stopped and started again", !failed.length, JSON.stringify(failed));
  const after = await shape();
  check("a restarted module gives back the same services and hooks, with none left over or twice", before === after, after === before ? "" : `${before}\n→ ${after}`);

  // agents (and outside) use tools, so restarting tools stops them first and starts them again after.
  // From the kernel's own trace buffer, which the page hears of a moment later.
  const trace = () => a.evaluate(() => window.__host.command("trace"));
  const mark = Math.max(0, ...(await trace()).map((e) => e.seq));
  const restarted = await a.evaluate(() => window.__host.command("restart-module", "tools"));
  const order = (await trace()).filter((e) => e.seq > mark && /^module:(start|stop)$/.test(e.name)).map((e) => `${e.name.slice(7)} ${e.plugin}`);
  check(
    "stopping a module stops the modules that use it, and they start again when it does",
    // Every module that uses tools (agents, outside) stops before it and starts after it, in whichever order among themselves.
    restarted?.ok &&
      order.indexOf("stop tools") > order.indexOf("stop agents") &&
      order.indexOf("start agents") > order.indexOf("start tools") &&
      order.indexOf("start tools") === order.indexOf("stop tools") + 1 &&
      order.filter((e) => e.startsWith("stop ")).length === order.filter((e) => e.startsWith("start ")).length,
    JSON.stringify(order),
  );

  // A restarted module works: debug's bench command makes hook round trips on its own bench:ping hook.
  const bench = await a.evaluate(() => window.__host.command("bench", 20));
  check("a restarted module's commands and hooks work again", bench?.n === 20 && bench.remote?.p50 >= 0, JSON.stringify(bench).slice(0, 200));

  const unknown = await a.evaluate(() => window.__host.command("restart-module", "nope"));
  check("restarting a module the site doesn't run fails", unknown?.ok === false && /No module nope/.test(unknown.error), JSON.stringify(unknown));
}
