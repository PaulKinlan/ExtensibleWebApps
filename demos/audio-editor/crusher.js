// Lo-fi: an effect for the sound editor. It keeps fewer levels of loudness
// and holds each sample for a few, like an old sampler: crunchy and gritty.
// An AudioWorklet processor this plugin registers, offered to the editor
// through sound-editor:effects.

export const manifest = {
  id: "effect-crusher",
  name: "Lo-fi",
  description: "A bit crusher for the sound editor.",
  version: "1.0.0",
  permissions: ["audio", "hook:intercept:sound-editor:effects"],
  services: ["audio"],
};

const PROCESSOR = `registerProcessor("effect-crusher", class extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.levels = Math.pow(2, (o.bits || 5) - 1);
    this.hold = o.hold || 4;
    this.n = 0;
    this.held = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0][0];
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (this.n++ % this.hold === 0) this.held = Math.round((input ? input[i] : 0) * this.levels) / this.levels;
      out[i] = this.held;
    }
    return true;
  }
});`;

export default async function (ctx) {
  await ctx.call("audio", "registerProcessor", "effect-crusher", PROCESSOR);
  ctx.on("sound-editor:effects", ({ effects }) => ({
    effects: [...effects, { id: "lofi", name: "Lo-fi", description: "Fewer bits, like an old sampler", processor: "effect-crusher", options: { bits: 5, hold: 4 } }],
  }));
}
