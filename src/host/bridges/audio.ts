// audio: plays sound from AudioWorklet processors that plugins register. Web
// Audio only exists in a page, so the kernel's audio service comes here.

import type { BridgeHost } from "./index";

let audio: AudioContext | undefined;
const processors = new Map<string, { source: string; added?: Promise<void> }>();
/** What has played, for the tests (window.__host.audioStats). */
export const audioStats = { played: 0, state: "none" as string, ahead: 0 };

export default (_host: BridgeHost) => ({
  registerProcessor(name: string, source: string) {
    processors.set(name, { source });
    return true;
  },
  /**
   * Plays a processor for `ms`. With `at` (a time in ms since the epoch, as Date.now() or performance.timeOrigin +
   * performance.now() give it, in any worker), the sound starts then, on the audio clock: the processor gets `start`
   * (in the audio clock's seconds) to begin on the exact sample, and a gain stays at 0 until then in case it
   * doesn't. A plugin that asks a little ahead gets sample-accurate timing, whatever the message took to arrive.
   */
  async play({ processor, ms = 300, at, options = {} }: { processor: string; ms?: number; at?: number; options?: Record<string, unknown> }) {
    const entry = processors.get(processor);
    if (!entry) throw new Error(`No audio processor named ${processor}`);
    audio ??= new AudioContext();
    if (audio.state === "suspended") await audio.resume();
    entry.added ??= audio.audioWorklet.addModule(URL.createObjectURL(new Blob([entry.source], { type: "text/javascript" })));
    await entry.added;
    const now = audio.currentTime;
    const start = typeof at === "number" && Number.isFinite(at) ? Math.max(now, contextTime(audio, at)) : now;
    const node = new AudioWorkletNode(audio, processor, { processorOptions: { ...options, start } });
    const gate = new GainNode(audio, { gain: start > now ? 0 : 1 });
    if (start > now) gate.gain.setValueAtTime(1, start);
    node.connect(gate).connect(audio.destination);
    setTimeout(() => {
      node.disconnect();
      gate.disconnect();
    }, ms + (start - now) * 1000);
    audioStats.played++;
    audioStats.ahead = start - now;
    audioStats.state = audio.state;
    return { ...audioStats };
  },
});

/** The audio clock's time (seconds) at `at`, a time in ms since the epoch, by the context's own output timestamp. */
function contextTime(audio: AudioContext, at: number): number {
  const { contextTime = audio.currentTime, performanceTime = performance.now() } = audio.getOutputTimestamp();
  return contextTime + (at - (performance.timeOrigin + performanceTime)) / 1000;
}
