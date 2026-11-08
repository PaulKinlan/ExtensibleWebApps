// Audio on time (src/host/bridges/audio.ts): a plugin asks for a sound `at` a time, a little ahead, and it is
// scheduled on the audio clock for then, with `start` passed to its processor, not played when the message lands.
export default async function ({ a, check }) {
  const source = `export const manifest = { id: "on-time", name: "On time", permissions: ["audio"] };
export default async (ctx) => {
  await ctx.call("audio", "registerProcessor", "on-time-click", \`registerProcessor("on-time-click", class extends AudioWorkletProcessor {
    constructor(options) { super(); this.start = options.processorOptions.start; this.port.postMessage(this.start); }
    process(_i, outputs) { for (const c of outputs[0]) c.fill(currentTime >= this.start ? 0.01 : 0); return currentTime < this.start + 0.05; }
  });\`);
  const now = await ctx.call("audio", "play", { processor: "on-time-click", ms: 100 });
  const later = await ctx.call("audio", "play", { processor: "on-time-click", ms: 100, at: Date.now() + 300 });
  const late = await ctx.call("audio", "play", { processor: "on-time-click", ms: 100, at: Date.now() - 5000 });
  ctx.log("on-time " + JSON.stringify({ now: now.ahead, later: later.ahead, late: late.ahead }));
};`;
  try {
    await a.evaluate((s) => window.__host.command("install", s), source);
    const detail = await a
      .waitForFunction(() => window.__host.traces.findLast((e) => e.plugin?.startsWith("on-time") && e.detail?.startsWith("on-time ")), null, { timeout: 8000 })
      .then((h) => h.jsonValue())
      .then((e) => e.detail, () => "");
    const ahead = detail ? JSON.parse(detail.slice(8)) : {};
    check(
      "a sound asked for `at` a time is scheduled on the audio clock for then; one with no time, or one already past, plays now",
      ahead.now === 0 && ahead.late === 0 && ahead.later > 0.2 && ahead.later < 0.4,
      detail,
    );
  } finally {
    await a.evaluate(() => window.__host.command("uninstall", "on-time")).catch(() => {});
  }
}
