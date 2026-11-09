// Telephone: a person's own effect for the sound editor. It cuts the lows
// and the highs, as a phone line does, and adds a little grit. Adding it
// changes nothing in the editor: it is one more answer to the editor's
// sound-editor:effects hook, and one more processor in the audio service.

export const manifest = {
  id: "effect-telephone",
  name: "Telephone",
  description: "Sounds like it's on the phone.",
  version: "1.0.0",
  permissions: ["audio", "hook:intercept:sound-editor:effects"],
  services: ["audio"],
};

const PROCESSOR = `registerProcessor("effect-telephone", class extends AudioWorkletProcessor {
  constructor() { super(); this.low = 0; this.high = 0; this.last = 0; }
  process(inputs, outputs) {
    const input = inputs[0][0];
    const out = outputs[0][0];
    // One pole each way: keep what is above 300 Hz and below 3400 Hz.
    const a = Math.exp(-2 * Math.PI * 3400 / sampleRate);
    const b = Math.exp(-2 * Math.PI * 300 / sampleRate);
    for (let i = 0; i < out.length; i++) {
      const x = input ? input[i] : 0;
      this.low = (1 - a) * x + a * this.low;
      this.high = b * (this.high + this.low - this.last);
      this.last = this.low;
      out[i] = Math.tanh(this.high * 2.5) * 0.8;
    }
    return true;
  }
});`;

export default async function (ctx) {
  await ctx.call("audio", "registerProcessor", "effect-telephone", PROCESSOR);
  ctx.on("sound-editor:effects", ({ effects }) => ({
    effects: [...effects, { id: "telephone", name: "Telephone", description: "Thin and crackly, like a phone line", processor: "effect-telephone" }],
  }));
}
