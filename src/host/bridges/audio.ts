// audio: plays sound from AudioWorklet processors that plugins register. Web
// Audio only exists in a page, so the kernel's audio service comes here.

import type { BridgeHost } from "./index";

let audio: AudioContext | undefined;
const processors = new Map<string, { source: string; added?: Promise<void> }>();
/** Sounds asked for in a group, until they end: `cancel` takes back the ones that haven't started. */
const groups = new Map<string, Set<{ start: number; stop: () => void }>>();
/** What has played, for the tests (window.__host.audioStats). */
export const audioStats = { played: 0, state: "none" as string, ahead: 0, start: 0 };

/**
 * For the tests: how loud what the plugins play is now (the peak of the latest samples), and the `start` each
 * processor said it got. Not on audioStats, which goes back to plugins.
 */
export const audioProbe = { listening: false, level: () => 0, starts: [] as number[] };
let tap: AnalyserNode | undefined;

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
  async play({ processor, ms = 300, at, group, options = {} }: { processor: string; ms?: number; at?: number; group?: string; options?: Record<string, unknown> }) {
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
    if (audioProbe.listening) {
      if (!tap) {
        const analyser = new AnalyserNode(audio, { fftSize: 256 });
        const samples = new Float32Array(analyser.fftSize);
        audioProbe.level = () => (analyser.getFloatTimeDomainData(samples), samples.reduce((peak, x) => Math.max(peak, Math.abs(x)), 0));
        tap = analyser;
      }
      gate.connect(tap);
      node.port.onmessage = (event) => audioProbe.starts.push(event.data);
    }
    const members = group ? groups.get(group) ?? groups.set(group, new Set()).get(group)! : undefined;
    const sound = {
      start,
      stop: () => {
        clearTimeout(ending);
        members?.delete(sound);
        node.disconnect();
        gate.disconnect();
      },
    };
    const ending = setTimeout(sound.stop, ms + (start - now) * 1000);
    members?.add(sound);
    audioStats.played++;
    audioStats.ahead = start - now;
    audioStats.start = start;
    audioStats.state = audio.state;
    return { ...audioStats };
  },
  /** Takes back the sounds in `group` that haven't started yet. One already sounding plays on to its end. */
  cancel({ group }: { group: string }) {
    const now = audio?.currentTime ?? 0;
    let cancelled = 0;
    for (const sound of groups.get(group) ?? [])
      if (sound.start > now) {
        sound.stop();
        cancelled++;
      }
    return { cancelled };
  },
});

/** The audio clock's time (seconds) at `at`, a time in ms since the epoch, by the context's own output timestamp. */
function contextTime(audio: AudioContext, at: number): number {
  const stamp = audio.getOutputTimestamp();
  // Before the context's first output both are 0 (or missing): then the clocks as they are now are the pair.
  const fresh = !stamp.performanceTime;
  const contextTime = fresh ? audio.currentTime : (stamp.contextTime ?? audio.currentTime);
  const performanceTime = fresh ? performance.now() : stamp.performanceTime!;
  return contextTime + (at - (performance.timeOrigin + performanceTime)) / 1000;
}
