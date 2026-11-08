// Audio on time (src/host/bridges/audio.ts): a plugin asks for a sound `at` a time, a little ahead, and it is
// scheduled on the audio clock for then, with `start` passed to its processor, not played when the message lands.
// What is heard is measured too (window.__host.audioProbe), with a processor that ignores `start`: the gate keeps
// it silent until then. And a sound in a group can be taken back before it starts.
export default async function ({ a, check }) {
  const source = `export const manifest = { id: "on-time", name: "On time", permissions: ["audio"] };
export default async (ctx) => {
  await ctx.call("audio", "registerProcessor", "on-time-click", \`registerProcessor("on-time-click", class extends AudioWorkletProcessor {
    constructor(options) { super(); this.start = options.processorOptions.start; this.port.postMessage(this.start); }
    process(_i, outputs) { for (const c of outputs[0]) c.fill(currentTime >= this.start ? 0.01 : 0); return currentTime < this.start + 0.05; }
  });\`);
  // Loud from its first sample, whatever start it is given.
  await ctx.call("audio", "registerProcessor", "on-time-rude", \`registerProcessor("on-time-rude", class extends AudioWorkletProcessor {
    constructor(options) { super(); this.port.postMessage(options.processorOptions.start); }
    process(_i, outputs) { for (const c of outputs[0]) c.fill(0.5); return true; }
  });\`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = await ctx.call("audio", "play", { processor: "on-time-click", ms: 100 });
  const later = await ctx.call("audio", "play", { processor: "on-time-click", ms: 100, at: Date.now() + 300 });
  const late = await ctx.call("audio", "play", { processor: "on-time-click", ms: 100, at: Date.now() - 5000 });
  ctx.log("on-time " + JSON.stringify({ now: now.ahead, later: later.ahead, late: late.ahead, start: later.start }));
  await wait(500); // the clicks end
  await ctx.call("audio", "play", { processor: "on-time-rude", ms: 500, at: Date.now() + 400 });
  ctx.log("on-time-rude {}");
  await wait(1500); // it ends
  await ctx.call("audio", "play", { processor: "on-time-rude", ms: 500, at: Date.now() + 400, group: "g" });
  const { cancelled } = await ctx.call("audio", "cancel", { group: "g" });
  ctx.log("on-time-cancel " + JSON.stringify({ cancelled }));
};`;
  const said = (prefix) =>
    a
      .waitForFunction((p) => window.__host.traces.findLast((e) => e.plugin?.startsWith("on-time") && e.detail?.startsWith(p)), prefix, { timeout: 8000, polling: 10 })
      .then((h) => h.jsonValue())
      .then((e) => JSON.parse(e.detail.slice(prefix.length) || "null"), () => undefined);
  const level = () => a.evaluate(() => window.__host.audioProbe.level());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await a.evaluate(() => (window.__host.audioProbe.listening = true));
    await a.evaluate((s) => window.__host.command("install", s), source);
    const ahead = (await said("on-time ")) ?? {};
    const starts = await a.evaluate(() => window.__host.audioProbe.starts.slice());
    check(
      "a sound asked for `at` a time is scheduled on the audio clock for then, and its processor gets that start; one with no time, or one already past, plays now",
      ahead.now === 0 && ahead.late === 0 && ahead.later > 0.2 && ahead.later < 0.4 && starts.includes(ahead.start),
      JSON.stringify({ ahead, starts }),
    );

    await said("on-time-rude ");
    const before = await level();
    await sleep(500);
    const after = await level();
    check("a processor that ignores `start` is still silent until then, and heard after", before === 0 && after > 0.4, JSON.stringify({ before, after }));

    const cancel = await said("on-time-cancel ");
    await sleep(600);
    const quiet = await level();
    check("a sound in a group that hasn't started is taken back by cancel, and never heard", cancel?.cancelled === 1 && quiet === 0, JSON.stringify({ cancel, quiet }));
  } finally {
    await a.evaluate(() => window.__host.command("uninstall", "on-time")).catch(() => {});
    await a.evaluate(() => (window.__host.audioProbe.listening = false)).catch(() => {});
  }
}
