// audio: plays sound from AudioWorklet processors that plugins register, and
// plays, renders, opens and saves clips (std/audio/module.ts). Web Audio only
// exists in a page, so the kernel's audio service comes here.

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

/** Keeps the processors a sound brought with it (std/audio/module.ts sends their sources), unless this tab has them. */
function learn(sources: Record<string, string> | undefined): void {
  for (const [name, source] of Object.entries(sources ?? {})) if (!processors.has(name)) processors.set(name, { source });
}

export default (_host: BridgeHost) => ({
  registerProcessor(name: string, source: string) {
    // A processor already added to the audio context keeps its first source: the worklet can't take a name twice.
    if (!processors.get(name)?.added) processors.set(name, { source });
    return true;
  },
  /**
   * Plays a processor for `ms`. With `at` (a time in ms since the epoch, as Date.now() or performance.timeOrigin +
   * performance.now() give it, in any worker), the sound starts then, on the audio clock: the processor gets `start`
   * (in the audio clock's seconds) to begin on the exact sample, and a gain stays at 0 until then in case it
   * doesn't. A plugin that asks a little ahead gets sample-accurate timing, whatever the message took to arrive.
   */
  async play({ processor, ms = 300, at, group, options = {}, sources }: { processor: string; ms?: number; at?: number; group?: string; options?: Record<string, unknown>; sources?: Record<string, string> }) {
    learn(sources);
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
      tap ??= probe(audio);
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
  /** Stops every sound in `group`, the ones already sounding too. */
  stop({ group }: { group: string }) {
    const members = [...(groups.get(group) ?? [])];
    for (const sound of members) sound.stop();
    return { stopped: members.length };
  },
  /**
   * Renders a clip (or a source processor, for `ms`) through a chain of processors in an OfflineAudioContext, as fast
   * as the machine can, and gives back the new clip. Every processor is added to the offline context from the source
   * its plugin registered, so an effect sounds the same rendered as played.
   */
  async render({ clip, source, rate, chain = [], tail = 0, sources }: { clip?: Clip; source?: { processor: string; ms?: number; options?: Record<string, unknown> }; rate?: number; chain?: Link[]; tail?: number; sources?: Record<string, string> }) {
    learn(sources);
    const input = clip ? decode(clip.pcm) : undefined;
    const r = clip?.rate ?? (Number(rate) || RATE);
    if (!input && !source) throw new Error("render needs a clip, or a source to make one");
    const seconds = (input ? input.length / r : Math.min(Number(source!.ms) || 1000, 30_000) / 1000) + Math.min(Math.max(Number(tail) || 0, 0), 10_000) / 1000;
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(seconds * r)), r);
    await addTo(offline, [...(source ? [source.processor] : []), ...chain.map((link) => link.processor)]);
    let node: AudioNode;
    if (input) {
      const buffer = offline.createBuffer(1, input.length, r);
      buffer.copyToChannel(input, 0);
      const player = new AudioBufferSourceNode(offline, { buffer });
      player.start();
      node = player;
    } else {
      node = new AudioWorkletNode(offline, source!.processor, { numberOfInputs: 0, outputChannelCount: [1], processorOptions: { ...source!.options, start: 0 } });
    }
    for (const link of chain) node = node.connect(new AudioWorkletNode(offline, link.processor, { outputChannelCount: [1], processorOptions: { ...link.options, start: 0 } }));
    node.connect(offline.destination);
    const out = await offline.startRendering();
    return { rate: r, pcm: encode(out.getChannelData(0)) };
  },
  /** Plays a clip, or the part of it from `from` to `to` (seconds), through a chain of processors. */
  async playClip({ clip, from = 0, to, chain = [], group, at, sources }: { clip: Clip; from?: number; to?: number; chain?: Link[]; group?: string; at?: number; sources?: Record<string, string> }) {
    learn(sources);
    audio ??= new AudioContext();
    if (audio.state === "suspended") await audio.resume();
    await addTo(audio, chain.map((link) => link.processor));
    const samples = decode(clip.pcm);
    const buffer = audio.createBuffer(1, Math.max(1, samples.length), clip.rate);
    buffer.copyToChannel(samples, 0);
    const begin = Math.min(Math.max(0, Number(from) || 0), buffer.duration);
    const end = to === undefined ? buffer.duration : Math.min(Math.max(begin, Number(to)), buffer.duration);
    const now = audio.currentTime;
    const start = typeof at === "number" && Number.isFinite(at) ? Math.max(now, contextTime(audio, at)) : now;
    const player = new AudioBufferSourceNode(audio, { buffer });
    let node: AudioNode = player;
    for (const link of chain) node = node.connect(new AudioWorkletNode(audio, link.processor, { outputChannelCount: [1], processorOptions: { ...link.options, start } }));
    node.connect(audio.destination);
    if (audioProbe.listening) {
      tap ??= probe(audio);
      node.connect(tap);
    }
    player.start(start, begin, end - begin);
    const ms = (end - begin) * 1000;
    const members = group ? groups.get(group) ?? groups.set(group, new Set()).get(group)! : undefined;
    const sound = {
      start,
      stop: () => {
        clearTimeout(ending);
        members?.delete(sound);
        try {
          player.stop();
        } catch {}
        player.disconnect();
        node.disconnect();
      },
    };
    // A chain may ring on after the clip (an echo): give it a second.
    const ending = setTimeout(sound.stop, ms + (start - now) * 1000 + (chain.length ? 1000 : 50));
    members?.add(sound);
    audioStats.played++;
    audioStats.state = audio.state;
    return { played: audioStats.played, ms, at: Date.now() + (start - now) * 1000 };
  },
  /** Opens the file chooser for a sound file and decodes it to one channel at `rate`: { name, clip, seconds }, or null if they close it. */
  open({ rate = RATE, maxSeconds = 15 }: { rate?: number; maxSeconds?: number } = {}): Promise<{ name: string; clip: Clip; seconds: number } | null> {
    if (navigator.userActivation && !navigator.userActivation.isActive) return Promise.reject(new Error("A file can be chosen only right after the person clicks"));
    const r = Math.min(Math.max(Number(rate) || RATE, 3000), 96_000);
    const most = Math.min(Math.max(Number(maxSeconds) || 15, 1), 30);
    return new Promise((resolve, reject) => {
      const input = Object.assign(document.createElement("input"), { type: "file", accept: "audio/*,.wav,.mp3,.ogg,.m4a,.flac", hidden: true });
      const done = () => input.remove();
      input.addEventListener("cancel", () => (done(), resolve(null)));
      input.addEventListener("change", async () => {
        done();
        const file = input.files?.[0];
        if (!file) return resolve(null);
        try {
          resolve({ name: file.name.replace(/\.[^.]+$/, ""), ...(await decodeFile(await file.arrayBuffer(), r, most)) });
        } catch (error) {
          reject(new Error(`${file.name} isn't a sound this browser can read: ${error instanceof Error ? error.message : error}`));
        }
      });
      document.body.append(input);
      try {
        input.showPicker();
      } catch {
        input.click();
      }
    });
  },
  /** Saves a clip as a WAV file the person downloads. */
  save({ clip, name }: { clip: Clip; name?: string }) {
    const url = URL.createObjectURL(new Blob([wav(decode(clip.pcm), clip.rate)], { type: "audio/wav" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${String(name || "clip").replace(/[^\w -]+/g, "").trim() || "clip"}.wav` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { saved: true };
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

type Clip = { rate: number; pcm: string };
type Link = { processor: string; options?: Record<string, unknown> };
/** A clip's rate when nothing says: enough for a voice or a drum, at half the size of CD quality. */
const RATE = 22_050;

/** Adds the named processors to a context (each context has its own worklet scope), once each. */
const added = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();
async function addTo(context: BaseAudioContext, names: string[]): Promise<void> {
  const mine = added.get(context) ?? added.set(context, new Map()).get(context)!;
  for (const name of names) {
    const entry = processors.get(name);
    if (!entry) throw new Error(`No audio processor named ${name}`);
    // The live context shares play()'s copy, so a processor is never added to it twice.
    if (context === audio) entry.added ??= context.audioWorklet.addModule(URL.createObjectURL(new Blob([entry.source], { type: "text/javascript" })));
    const adding = context === audio ? entry.added! : mine.get(name) ?? mine.set(name, context.audioWorklet.addModule(URL.createObjectURL(new Blob([entry.source], { type: "text/javascript" })))).get(name)!;
    await adding;
  }
}

function probe(context: AudioContext): AnalyserNode {
  const analyser = new AnalyserNode(context, { fftSize: 256 });
  const samples = new Float32Array(analyser.fftSize);
  audioProbe.level = () => (analyser.getFloatTimeDomainData(samples), samples.reduce((peak, x) => Math.max(peak, Math.abs(x)), 0));
  return analyser;
}

/** base64 of little-endian 16-bit samples, to samples from -1 to 1. */
function decode(pcm: string): Float32Array {
  const bytes = Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Samples from -1 to 1, to base64 of little-endian 16-bit samples. */
function encode(samples: Float32Array): string {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), true);
  const bytes = new Uint8Array(view.buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** A sound file, decoded, mixed to one channel and resampled to `rate`, at most `most` seconds of it. */
async function decodeFile(data: ArrayBuffer, rate: number, most: number): Promise<{ clip: Clip; seconds: number }> {
  const decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(data);
  const seconds = Math.min(decoded.duration, most);
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(seconds * rate)), rate);
  const player = new AudioBufferSourceNode(offline, { buffer: decoded });
  player.connect(offline.destination);
  player.start();
  const out = await offline.startRendering();
  return { clip: { rate, pcm: encode(out.getChannelData(0)) }, seconds };
}

/** Samples as a WAV file: 16-bit, one channel. */
function wav(samples: Float32Array, rate: number): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), true);
  return view.buffer;
}

/** The audio clock's time (seconds) at `at`, a time in ms since the epoch, by the context's own output timestamp. */
function contextTime(audio: AudioContext, at: number): number {
  const stamp = audio.getOutputTimestamp();
  // Before the context's first output both are 0 (or missing): then the clocks as they are now are the pair.
  const fresh = !stamp.performanceTime;
  const contextTime = fresh ? audio.currentTime : (stamp.contextTime ?? audio.currentTime);
  const performanceTime = fresh ? performance.now() : stamp.performanceTime!;
  return contextTime + (at - (performance.timeOrigin + performanceTime)) / 1000;
}
