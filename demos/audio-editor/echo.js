// Echo: an effect for the sound editor. The sound comes back, softer each
// time, a quarter of a second later. It is an AudioWorklet processor this
// plugin registers with the audio service, and the editor learns about it
// from this plugin's answer to sound-editor:effects. tail asks the editor
// for 1.5 seconds more at the end of a whole clip, for the echo to die away.

export const manifest = {
  id: "effect-echo",
  name: "Echo",
  description: "An echo for the sound editor.",
  version: "1.0.0",
  permissions: ["audio", "hook:intercept:sound-editor:effects"],
  services: ["audio"],
};

const PROCESSOR = `registerProcessor("effect-echo", class extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.line = new Float32Array(Math.max(1, Math.round((o.delay || 0.25) * sampleRate)));
    this.feedback = o.feedback ?? 0.45;
    this.mix = o.mix ?? 0.5;
    this.i = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0][0];
    const out = outputs[0][0];
    for (let n = 0; n < out.length; n++) {
      const dry = input ? input[n] : 0;
      const wet = this.line[this.i];
      this.line[this.i] = dry + wet * this.feedback;
      this.i = (this.i + 1) % this.line.length;
      out[n] = dry + wet * this.mix;
    }
    return true;
  }
});`;

export default async function (ctx) {
  await ctx.call("audio", "registerProcessor", "effect-echo", PROCESSOR);
  ctx.on("sound-editor:effects", ({ effects }) => ({
    effects: [...effects, { id: "echo", name: "Echo", description: "It comes back, a quarter second later", processor: "effect-echo", options: { delay: 0.25, feedback: 0.45, mix: 0.5 }, tail: 1500 }],
  }));
}
