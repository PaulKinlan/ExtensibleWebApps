// The audio bridge's work (bridges/audio.ts passes its calls here), in a file of its own that a page fetches
// the first time a plugin makes a sound: most pages never do.
//
// audio: plays sound from AudioWorklet processors that plugins register, and
// plays, renders, mixes, opens and saves clips (std/audio/module.ts). Web Audio
// only exists in a page, so the kernel's audio service comes here.
//
// A clip has one channel or two (stereo), its samples interleaved. Effects
// are processors that take one channel: on a stereo clip each channel goes
// through its own copy of the chain, so every effect works on both.

import type { BridgeHost } from "./bridges/index";
import { audioProbe, audioStats } from "./audio-stats";

let audio: AudioContext | undefined;
const processors = new Map<string, { source: string; added?: Promise<void> }>();
/** Sounds asked for in a group, until they end: `cancel` takes back the ones that haven't started. */
const groups = new Map<string, Set<{ start: number; stop: () => void }>>();
let tap: AnalyserNode | undefined;

/** Keeps the processors a sound brought with it (std/audio/module.ts sends their sources), unless this tab has them. */
function learn(sources: Record<string, string> | undefined): void {
  for (const [name, source] of Object.entries(sources ?? {})) keep(name, source);
}

/**
 * Keeps a processor's latest source, for the contexts it is added to from now on (each render's offline context).
 * The live context keeps the copy it already added: an AudioWorklet can't take a name twice.
 */
function keep(name: string, source: string): void {
  const entry = processors.get(name);
  if (entry?.source !== source) processors.set(name, { source, added: entry?.added });
}

/** Adds a processor's source to a context's worklet, and lets go of the blob URL once it has loaded (or failed). */
function addModule(context: BaseAudioContext, source: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  return context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
}

export default (_host: BridgeHost) => ({
  registerProcessor(name: string, source: string) {
    keep(name, source);
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
    entry.added ??= addModule(audio, entry.source);
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
    const input = clip ? channelsOf(clip) : undefined;
    const r = clip?.rate ?? (Number(rate) || RATE);
    const count = input?.length ?? 1;
    if (!input && !source) throw new Error("render needs a clip, or a source to make one");
    const seconds = (input ? input[0].length / r : Math.min(Number(source!.ms) || 1000, 30_000) / 1000) + Math.min(Math.max(Number(tail) || 0, 0), 10_000) / 1000;
    const length = Math.max(1, Math.ceil(seconds * r));
    if (length * count > MAX_SAMPLES) throw new Error(`That would render ${(length / r).toFixed(1)} s, over the ${(MAX_SAMPLES / count / r).toFixed(1)} s a clip of ${count} channel${count > 1 ? "s" : ""} at ${r} samples a second can hold`);
    const offline = new OfflineAudioContext(count, length, r);
    await addTo(offline, [...(source ? [source.processor] : []), ...chain.map((link) => link.processor)]);
    let node: AudioNode;
    if (input) {
      const player = new AudioBufferSourceNode(offline, { buffer: bufferOf(offline, input, r) });
      player.start();
      node = through(offline, player, count, chain, 0);
      node.connect(offline.destination);
      const out = await offline.startRendering();
      return clipOf(out, r);
    } else {
      // A source plays for `ms`, then falls silent (a tail is for the chain to ring into), whatever the processor does.
      const maker = new AudioWorkletNode(offline, source!.processor, { numberOfInputs: 0, outputChannelCount: [1], processorOptions: { ...source!.options, start: 0 } });
      const gate = new GainNode(offline, { gain: 1 });
      gate.gain.setValueAtTime(0, Math.min(Number(source!.ms) || 1000, 30_000) / 1000);
      node = maker.connect(gate);
    }
    node = through(offline, node, 1, chain, 0);
    node.connect(offline.destination);
    const out = await offline.startRendering();
    return { rate: r, pcm: encode(out.getChannelData(0)) };
  },
  /**
   * Mixes clips into one, offline: each track starts `at` seconds in, at its `gain`, panned from -1 (left) to 1
   * (right), through its own chain of processors. Tracks may have different rates and channels; the mix is at
   * `rate`, stereo unless `channels` is 1.
   */
  async mix({ tracks, rate, channels = 2, tail = 0, sources }: { tracks: Track[]; rate?: number; channels?: number; tail?: number; sources?: Record<string, string> }) {
    learn(sources);
    const r = Number(rate) || tracks[0]?.clip.rate || RATE;
    const count = channels === 1 ? 1 : 2;
    const decoded = tracks.map((track) => ({ track, input: channelsOf(track.clip) }));
    const seconds = Math.max(0, ...decoded.map(({ track, input }) => Math.max(0, Number(track.at) || 0) + input[0].length / track.clip.rate)) + Math.min(Math.max(Number(tail) || 0, 0), 10_000) / 1000;
    const length = Math.max(1, Math.ceil(seconds * r));
    if (length * count > MAX_SAMPLES) throw new Error(`The mix would be ${(length / r).toFixed(1)} s, over the ${(MAX_SAMPLES / count / r).toFixed(1)} s a clip of ${count} channel${count > 1 ? "s" : ""} at ${r} samples a second can hold`);
    const offline = new OfflineAudioContext(count, length, r);
    await addTo(offline, tracks.flatMap((track) => (track.chain ?? []).map((link) => link.processor)));
    for (const { track, input } of decoded) {
      const player = new AudioBufferSourceNode(offline, { buffer: bufferOf(offline, input, track.clip.rate) });
      const gain = new GainNode(offline, { gain: Math.min(Math.max(Number(track.gain ?? 1), 0), 4) });
      let node = through(offline, player, input.length, track.chain ?? [], 0).connect(gain);
      if (count === 2) node = node.connect(new StereoPannerNode(offline, { pan: Math.min(Math.max(Number(track.pan) || 0, -1), 1) }));
      node.connect(offline.destination);
      player.start(Math.max(0, Number(track.at) || 0));
    }
    return clipOf(await offline.startRendering(), r);
  },
  /** Plays a clip, or the part of it from `from` to `to` (seconds), through a chain of processors. */
  async playClip({ clip, from = 0, to, chain = [], group, at, sources }: { clip: Clip; from?: number; to?: number; chain?: Link[]; group?: string; at?: number; sources?: Record<string, string> }) {
    learn(sources);
    audio ??= new AudioContext();
    if (audio.state === "suspended") await audio.resume();
    await addTo(audio, chain.map((link) => link.processor));
    const input = channelsOf(clip);
    const buffer = bufferOf(audio, input, clip.rate);
    const begin = Math.min(Math.max(0, Number(from) || 0), buffer.duration);
    const end = to === undefined ? buffer.duration : Math.min(Math.max(begin, Number(to)), buffer.duration);
    const now = audio.currentTime;
    const start = typeof at === "number" && Number.isFinite(at) ? Math.max(now, contextTime(audio, at)) : now;
    const player = new AudioBufferSourceNode(audio, { buffer });
    let node: AudioNode = player;
    node = through(audio, node, input.length, chain, start);
    // A chain's processors run from now; a gain keeps them quiet until the clip starts, as play() does.
    const gate = new GainNode(audio, { gain: start > now ? 0 : 1 });
    if (start > now) gate.gain.setValueAtTime(1, start);
    node.connect(gate).connect(audio.destination);
    if (audioProbe.listening) {
      tap ??= probe(audio);
      gate.connect(tap);
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
        gate.disconnect();
      },
    };
    // A chain may ring on after the clip (an echo): give it a second.
    const ending = setTimeout(sound.stop, ms + (start - now) * 1000 + (chain.length ? 1000 : 50));
    members?.add(sound);
    audioStats.played++;
    audioStats.state = audio.state;
    return { played: audioStats.played, ms, at: Date.now() + (start - now) * 1000 };
  },
  /** Opens the file chooser for a sound file and decodes it to one channel (or two) at `rate`: { name, clip, seconds }, or null if they close it. */
  open({ rate = RATE, maxSeconds = 15, channels = 1 }: { rate?: number; maxSeconds?: number; channels?: number } = {}): Promise<{ name: string; clip: Clip; seconds: number } | null> {
    if (navigator.userActivation && !navigator.userActivation.isActive) return Promise.reject(new Error("A file can be chosen only right after the person clicks"));
    const r = Math.min(Math.max(Number(rate) || RATE, 3000), 96_000);
    const count = channels === 2 ? 2 : 1;
    const most = Math.min(Math.max(Number(maxSeconds) || 15, 1), MAX_SECONDS, MAX_SAMPLES / count / r);
    return new Promise((resolve, reject) => {
      const input = Object.assign(document.createElement("input"), { type: "file", accept: "audio/*,.wav,.mp3,.ogg,.m4a,.flac", hidden: true });
      const done = () => input.remove();
      input.addEventListener("cancel", () => (done(), resolve(null)));
      input.addEventListener("change", async () => {
        done();
        const file = input.files?.[0];
        if (!file) return resolve(null);
        try {
          resolve({ name: file.name.replace(/\.[^.]+$/, ""), ...(await decodeFile(await file.arrayBuffer(), r, most, count)) });
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
    const url = URL.createObjectURL(new Blob([wav(decode(clip.pcm), clip.rate, clip.channels === 2 ? 2 : 1)], { type: "audio/wav" }));
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

type Clip = { rate: number; pcm: string; channels?: number };
type Link = { processor: string; options?: Record<string, unknown> };
type Track = { clip: Clip; at?: number; gain?: number; pan?: number; chain?: Link[] };
/** A clip's rate when nothing says: enough for a voice or a drum, at half the size of CD quality. */
const RATE = 22_050;
/**
 * The most samples a clip holds, every channel's together: std/audio/module.ts takes clips of up to 16,000,000
 * characters of base64, 2 bytes a sample. About four and a half minutes of one channel at 22,050 a second.
 */
const MAX_SAMPLES = 6_000_000;
/** The longest sound file `open` reads. */
const MAX_SECONDS = 300;

/** A clip's channels: one, or two from interleaved samples. */
function channelsOf(clip: Clip): Float32Array[] {
  const all = decode(clip.pcm);
  if (clip.channels !== 2) return [all];
  const left = new Float32Array(all.length >> 1);
  const right = new Float32Array(all.length >> 1);
  for (let i = 0; i < left.length; i++) {
    left[i] = all[i * 2];
    right[i] = all[i * 2 + 1];
  }
  return [left, right];
}

/** A rendered buffer as a clip: one channel, or two interleaved. */
function clipOf(buffer: AudioBuffer, rate: number): Clip {
  if (buffer.numberOfChannels < 2) return { rate, pcm: encode(buffer.getChannelData(0)) };
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const out = new Float32Array(left.length * 2);
  for (let i = 0; i < left.length; i++) {
    out[i * 2] = left[i];
    out[i * 2 + 1] = right[i];
  }
  return { rate, pcm: encode(out), channels: 2 };
}

function bufferOf(context: BaseAudioContext, input: Float32Array[], rate: number): AudioBuffer {
  const buffer = context.createBuffer(input.length, Math.max(1, input[0].length), rate);
  input.forEach((data, c) => buffer.copyToChannel(data, c));
  return buffer;
}

/**
 * A chain of processors after `node`. Each processor takes one channel, so with two each channel goes through a
 * copy of the chain of its own, split before it and merged after.
 */
function through(context: BaseAudioContext, node: AudioNode, count: number, chain: Link[], start: number): AudioNode {
  if (!chain.length) return node;
  const link = (from: AudioNode) => chain.reduce((n, l) => n.connect(new AudioWorkletNode(context, l.processor, { outputChannelCount: [1], processorOptions: { ...l.options, start } })), from);
  if (count < 2) return link(node);
  const split = new ChannelSplitterNode(context, { numberOfOutputs: count });
  const merge = new ChannelMergerNode(context, { numberOfInputs: count });
  node.connect(split);
  for (let c = 0; c < count; c++) {
    const gate = new GainNode(context, { channelCount: 1, channelCountMode: "explicit" });
    split.connect(gate, c);
    link(gate).connect(merge, 0, c);
  }
  return merge;
}

/** Adds the named processors to a context (each context has its own worklet scope), once each. */
const added = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();
async function addTo(context: BaseAudioContext, names: string[]): Promise<void> {
  const mine = added.get(context) ?? added.set(context, new Map()).get(context)!;
  for (const name of names) {
    const entry = processors.get(name);
    if (!entry) throw new Error(`No audio processor named ${name}`);
    // The live context shares play()'s copy, so a processor is never added to it twice.
    if (context === audio) entry.added ??= addModule(context, entry.source);
    const adding = context === audio ? entry.added! : mine.get(name) ?? mine.set(name, addModule(context, entry.source)).get(name)!;
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

/** A sound file, decoded, mixed to one channel (or two) and resampled to `rate`, at most `most` seconds of it. */
async function decodeFile(data: ArrayBuffer, rate: number, most: number, channels = 1): Promise<{ clip: Clip; seconds: number }> {
  const decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(data);
  const seconds = Math.min(decoded.duration, most);
  const offline = new OfflineAudioContext(channels, Math.max(1, Math.ceil(seconds * rate)), rate);
  const player = new AudioBufferSourceNode(offline, { buffer: decoded });
  player.connect(offline.destination);
  player.start();
  const out = await offline.startRendering();
  return { clip: clipOf(out, rate), seconds };
}

/** Samples as a WAV file: 16-bit, one channel or two (interleaved, as a clip keeps them). */
function wav(samples: Float32Array, rate: number, channels = 1): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2 * channels, true);
  view.setUint16(32, 2 * channels, true);
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
