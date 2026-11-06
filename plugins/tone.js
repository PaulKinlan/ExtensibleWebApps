// Plays a short tone. Its DSP runs in an AudioWorklet on the audio thread;
// the plugin only registers the processor and asks the host to play it.

export const manifest = {
  id: "tone",
  name: "Tone",
  description: "A button that plays a tone, to prove audio runs with no plugin code on the main thread.",
  version: "1.0.0",
  permissions: ["ui", "audio"],
  order: 20,
  settings: {
    frequency: { type: "number", title: "Pitch (Hz)", default: 440 },
    wave: { type: "string", title: "Wave", enum: ["sine", "square"], default: "sine" },
  },
};

const PROCESSOR = `
registerProcessor("tone-sine", class extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frequency = options.processorOptions?.frequency ?? 440;
    this.square = options.processorOptions?.wave === "square";
    this.phase = 0;
  }
  process(_inputs, outputs) {
    const step = (2 * Math.PI * this.frequency) / sampleRate;
    let phase = this.phase;
    for (const channel of outputs[0]) {
      phase = this.phase;
      for (let i = 0; i < channel.length; i++) {
        const s = Math.sin(phase);
        channel[i] = this.square ? 0.05 * Math.sign(s) : 0.1 * s;
        phase += step;
      }
    }
    this.phase = phase % (2 * Math.PI);
    return true;
  }
});
`;

export default async function (ctx) {
  await ctx.call("audio", "registerProcessor", "tone-sine", PROCESSOR);
  let played = 0;
  let settings = await ctx.settings.get();
  ctx.settings.onChange((next) => {
    settings = next;
    draw();
  });
  const draw = (api = ctx) =>
    api.ui.render("app.side", "tone", {
      type: "stack",
      children: [
        { type: "heading", text: "Tone" },
        { type: "button", label: `Play ${settings.frequency} Hz`, action: "play" },
        { type: "text", text: played ? `Played ${played} time${played === 1 ? "" : "s"}` : "Audio runs in an AudioWorklet.", tone: "muted" },
      ],
    });
  ctx.ui.onEvent(async (action) => {
    if (action !== "play") return;
    // Pinned to this click's trace, so what happens after the await is traced too.
    const here = ctx.traced();
    await here.call("audio", "play", { processor: "tone-sine", ms: 300, options: { frequency: settings.frequency, wave: settings.wave } });
    played++;
    here.log(`played ${played}`);
    draw(here);
  });
  draw();
}
