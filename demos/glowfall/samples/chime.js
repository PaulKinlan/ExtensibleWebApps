// Chime: a person's own sound for Glowfall. A soft bell when the jar catches
// a firefly, and a low plop when the rain gets in. It listens to the frames
// the loop sends (game:frame) for a catch or splash on that tick, and plays
// its own AudioWorklet processor through the audio service. Nothing in the
// game changed for it to have sound.

export const manifest = {
  id: "glowfall-chime",
  name: "Chime",
  description: "A bell for each catch, a plop for each splash.",
  version: "1.0.0",
  permissions: ["audio", "hook:listen:game:frame"],
  services: ["audio", "game"],
};

const BELL = `registerProcessor("glowfall-bell", class extends AudioWorkletProcessor {
  constructor(o) { super(); this.f = o.processorOptions.f || 880; this.start = o.processorOptions.start || 0; this.t = 0; }
  process(_i, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (currentTime + i / sampleRate < this.start) { out[i] = 0; continue; }
      const t = this.t++ / sampleRate;
      out[i] = 0.18 * Math.exp(-t * 5) * (Math.sin(2 * Math.PI * this.f * t) + 0.4 * Math.sin(2 * Math.PI * this.f * 2.76 * t));
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return this.t / sampleRate < 0.8;
  }
});`;

export default async function (ctx) {
  await ctx.call("audio", "registerProcessor", "glowfall-bell", BELL);
  // A different note for each lane, from a pentatonic scale, so a run of catches plays a tune.
  const NOTES = [659, 784, 880, 988, 1175];
  ctx.on("game:frame", ({ game, tick, state }) => {
    if (game !== "glowfall") return;
    if (state.caught?.tick === tick) ctx.call("audio", "play", { processor: "glowfall-bell", ms: 800, options: { f: NOTES[Math.round(state.caught.x)] ?? 880 } });
    if (state.splashed?.tick === tick) ctx.call("audio", "play", { processor: "glowfall-bell", ms: 800, options: { f: 147 } });
  });
}
