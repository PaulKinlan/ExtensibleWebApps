// Tremolo: an effect for the sound editor. The loudness rises and falls six
// times a second, a wobble like an old guitar amplifier. An AudioWorklet
// processor this plugin registers, offered through sound-editor:effects.

export const manifest = {
  id: "effect-tremolo",
  name: "Tremolo",
  description: "A tremolo for the sound editor.",
  version: "1.0.0",
  permissions: ["audio", "hook:intercept:sound-editor:effects"],
  services: ["audio"],
};

const PROCESSOR = `registerProcessor("effect-tremolo", class extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.rate = o.rate || 6;
    this.depth = o.depth ?? 0.8;
    this.t = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0][0];
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      const swing = 1 - this.depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * this.rate * (this.t++ / sampleRate)));
      out[i] = (input ? input[i] : 0) * swing;
    }
    return true;
  }
});`;

export default async function (ctx) {
  await ctx.call("audio", "registerProcessor", "effect-tremolo", PROCESSOR);
  ctx.on("sound-editor:effects", ({ effects }) => ({
    effects: [...effects, { id: "tremolo", name: "Tremolo", description: "Loudness that wobbles, six times a second", processor: "effect-tremolo", options: { rate: 6, depth: 0.8 }, knobs: { rate: { label: "Speed", min: 0.5, max: 20, step: 0.5, unit: "Hz" }, depth: { label: "Depth", min: 0, max: 1, step: 0.05 } } }],
  }));
}
