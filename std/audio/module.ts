// The `audio` service. Sound for plugins, played by the tab that runs the plugin workers.
//
// Two kinds of sound: a processor played for a while (`play`), which is how
// the Beat pad's drums are made, and a clip: a recording, as
// { rate, pcm, channels? }, where pcm is base64 of 16-bit samples, one
// channel, or two (stereo, channels: 2) interleaved. A clip is plain JSON,
// so a plugin can keep it in a collection; one too long for that (a
// collection holds 5 MB in all) it keeps with `keep`, in the person's
// data folder, and gets back with `load`. `render` runs a clip (or a
// processor, to make one) through a chain of effects, each an AudioWorklet
// processor some plugin registered, offline, and gives back the new clip:
// so an effect is a plugin that registers a processor, and an editor
// applies any effect it is told about without knowing what it does. `mix`
// lays several clips (tracks) over each other into one. A plugin reads the
// clips another kept with `load({ name, of })` and the permission
// audio:kept:<of>: the sound editor's timeline does, for long clips.
// A kernel module (docs/layers.md): a site that lists `audio` in kernel.json has it, as `ctx.call("audio", …)`.

import { service, type ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";

/** The longest clip, in base64 characters: about four and a half minutes of one channel at 22,050 samples a second. */
const MAX_CLIP = 16_000_000;
const MAX_CHAIN = 8;
const MAX_TRACKS = 16;
/** Clips a plugin keeps with `keep`, at most. */
const MAX_KEPT = 50;
const clipArgs = "{ rate, pcm, channels? }";
const KEPT = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Checks a clip a plugin sent, so the page is never asked to decode something it shouldn't. */
function checkClip(clip: unknown): void {
  const c = clip as { rate?: unknown; pcm?: unknown; channels?: unknown } | undefined;
  if (!c || typeof c !== "object" || typeof c.pcm !== "string" || typeof c.rate !== "number") throw new Error(`A clip is ${clipArgs}: pcm is base64 of 16-bit samples`);
  if (c.rate < 3000 || c.rate > 96_000) throw new Error("A clip's rate is 3000 to 96000 samples a second");
  if (c.channels !== undefined && c.channels !== 1 && c.channels !== 2) throw new Error("A clip has 1 channel or 2 (stereo)");
  if (c.pcm.length > MAX_CLIP) throw new Error(`A clip is limited to ${MAX_CLIP} characters of base64`);
}

const PROCESSOR = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const base = (instance: string) => instance.split("@")[0];

/** The processors a play or render names: its own, its source's and its chain's. */
function processorsOf(first: Record<string, unknown>): string[] {
  const names = new Set<string>();
  if (typeof first.processor === "string") names.add(first.processor);
  const source = first.source as { processor?: unknown } | undefined;
  if (source && typeof source.processor === "string") names.add(source.processor);
  if (Array.isArray(first.chain)) for (const link of first.chain) if (link && typeof link.processor === "string") names.add(link.processor);
  if (Array.isArray(first.tracks)) for (const track of first.tracks) if (track && typeof track === "object") for (const name of processorsOf(track as Record<string, unknown>)) names.add(name);
  return [...names];
}

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { hosts, store } = kernel;
  /** Where a plugin's kept clips are, in the data folder: each its own. */
  // Under plugin-data, which a plugin's file permissions never reach (src/kernel/paths.ts), so one plugin can't read another's.
  const keptPath = (plugin: string, name?: string) => `plugin-data/audio/${base(plugin)}${name ? `/${name}.json` : ""}`;
  /** One keep at a time for each plugin, so two at once can't both pass the count. */
  const keeping = new Map<string, Promise<unknown>>();
  const oneAtATime = <T>(plugin: string, work: () => Promise<T>): Promise<T> => {
    const next = (keeping.get(base(plugin)) ?? Promise.resolve()).then(work, work);
    keeping.set(base(plugin), next.catch(() => {}));
    return next;
  };
  /** A plugin's id, named by `of`, whose kept clips another reads. */
  const ownerOf = (of: unknown) => {
    if (typeof of !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(of)) throw new Error("of is a plugin's id");
    return of;
  };
  const keptName = (name: unknown) => {
    if (typeof name !== "string" || !KEPT.test(name)) throw new Error("A kept clip's name is lowercase letters, digits and dashes, up to 64");
    return name;
  };
  /** Every processor plugins registered, by name, and the plugin that did: a name is its first plugin's. */
  const sources = new Map<string, string>();
  const owners = new Map<string, string>();
  /** The tab a tab-scoped plugin runs in, so its sound plays and its files are picked where the person is; otherwise (undefined) the tab that runs the workers. */
  const tabOf = (instance: string) => {
    const tab = instance.split("@")[1];
    return (tab && hosts.list.find((h) => h.tab === tab)) || undefined;
  };
  return {
    description: "Sound, played by the tab that runs the plugin workers. Audio runs in an AudioWorklet, never through hooks.",
    methods: {
      registerProcessor: { args: "(name, source)", returns: "true", needs: "audio", description: "Registers an AudioWorklet processor, from its source, under a name." },
      play: {
        args: "({ processor, ms?, at?, options? })",
        returns: "{ played, state }",
        needs: "audio",
        description:
          "Plays a registered processor for `ms` milliseconds (300 by default), passing `options` as its processorOptions. With `at`, a time in ms since the epoch (Date.now()), it starts then on the audio clock: ask about 100 ms ahead. The processor's options get `start`, in the audio clock's seconds; output silence until currentTime reaches it to begin on the exact sample. With `group`, a name of the plugin's own, `cancel` can take it back before it starts.",
      },
      cancel: {
        args: "({ group })",
        returns: "{ cancelled }",
        needs: "audio",
        description: "Takes back this plugin's sounds in `group` that haven't started yet, as a Stop button wants. One already sounding plays on to its end.",
      },
      stop: {
        args: "({ group })",
        returns: "{ stopped }",
        needs: "audio",
        description: "Stops every sound of this plugin's in `group`, the ones already sounding too: a clip's Stop button.",
      },
      render: {
        args: "({ clip?, source?: { processor, ms, options? }, rate?, chain?: [{ processor, options? }], tail? })",
        returns: clipArgs,
        needs: "audio",
        description:
          `Renders a clip, offline, through a chain of registered processors (effects, each given the sound before it as its input), and gives back the new clip. Without a clip, \`source\` makes one: a processor played for ms, at rate (22050 by default). tail adds that many ms of silence at the end for an echo to ring into. Each processor's options get start: 0. At most ${MAX_CHAIN} in a chain.`,
      },
      mix: {
        args: "({ tracks: [{ clip, at?, gain?, pan?, chain? }], rate?, channels?, tail? })",
        returns: clipArgs,
        needs: "audio",
        description: `Mixes clips into one, offline: each track starts at \`at\` seconds, at its gain (1 by default, up to 4), panned from -1 (left) to 1 (right), through its own chain of processors. Tracks may differ in rate and channels. The mix is stereo (channels 2) unless channels is 1, at rate (the first track's if not given). At most ${MAX_TRACKS} tracks.`,
      },
      keep: {
        args: "({ name, clip })",
        returns: "{ kept, seconds }",
        needs: "audio",
        description: `Keeps a clip in the person's data folder under a name of this plugin's own, for a clip too long for a collection (which holds 5 MB in all). Keeping a name again replaces it. At most ${MAX_KEPT} a plugin.`,
      },
      load: {
        args: "({ name, of? })",
        returns: `${clipArgs} or null`,
        needs: "audio, or audio:kept:<of>",
        description: "A clip this plugin kept, or null if there is none by that name. With `of`, a plugin's id, one that plugin kept: that needs the permission audio:kept:<of>, so a timeline can read the clips an editor keeps.",
      },
      forget: { args: "({ name })", returns: "{ forgotten }", needs: "audio", description: "Deletes a clip this plugin kept." },
      kept: { args: "({ of? }?)", returns: "[name]", needs: "audio, or audio:kept:<of>", description: "The names of the clips this plugin kept, or, with `of`, that plugin kept (audio:kept:<of>)." },
      playClip: {
        args: "({ clip, from?, to?, chain?, group?, at? })",
        returns: "{ played, ms, at }",
        needs: "audio",
        description: "Plays a clip, from and to in seconds (the whole clip if not given), through a chain of processors if given. With `group`, `stop` can end it. at is when it starts, in ms since the epoch, so a playhead can follow it.",
      },
      open: {
        args: "({ rate?, maxSeconds?, channels? })",
        returns: "{ name, clip, seconds } or null",
        needs: "audio",
        description: "Opens the file chooser for a sound file (WAV, MP3, Ogg…), decodes it to one channel (or two, with channels: 2) at rate (22050 by default) and gives it back as a clip, at most maxSeconds long (15 by default, 300 at most, and no more than a clip holds). Only right after the person clicks; null if they close it.",
      },
      save: {
        args: "({ clip, name })",
        returns: "{ saved }",
        needs: "audio",
        description: "Saves a clip as a WAV file the person downloads, named name.wav: stereo if the clip is.",
      },
    },
    // Reading another plugin's kept clips (load or kept with `of`) needs audio:kept:<that plugin>; everything else, audio.
    capability: (method, args) => {
      const of = (args[0] as { of?: unknown } | undefined)?.of;
      return (method === "load" || method === "kept") && of !== undefined ? `audio:kept:${String(of)}` : "audio";
    },
    // A group is the plugin's own: its name is kept apart from every other plugin's.
    call: async (plugin, method, args, dispatch) => {
      const [first, ...rest] = args as [Record<string, unknown> | undefined, ...unknown[]];
      // Kept clips are files in the data folder, each plugin's in its own folder: the page plays no part.
      if (method === "keep") {
        const name = keptName(first?.name);
        checkClip(first?.clip);
        return oneAtATime(plugin, async () => {
        const names = await store.listFiles(keptPath(plugin)).catch(() => [] as string[]);
        if (!names.includes(`${name}.json`) && names.filter((n) => n.endsWith(".json")).length >= MAX_KEPT) throw new Error(`A plugin keeps at most ${MAX_KEPT} clips: forget one first`);
        const { rate, pcm, channels } = first!.clip as { rate: number; pcm: string; channels?: number };
        await store.writeText(keptPath(plugin, name), JSON.stringify({ rate, pcm, ...(channels === 2 ? { channels } : {}) }));
        return { kept: name, seconds: Math.round(((pcm.length * 3) / 4 / 2 / (channels === 2 ? 2 : 1) / rate) * 100) / 100 };
        });
      }
      // Whose kept clips: this plugin's, or with `of` (checked by capability above) another's.
      const owner = (method === "load" || method === "kept") && first?.of !== undefined ? ownerOf(first.of) : plugin;
      if (method === "load") {
        const text = await store.readText(keptPath(owner, keptName(first?.name)));
        return text ? JSON.parse(text) : null;
      }
      if (method === "forget") {
        const name = keptName(first?.name);
        const had = (await store.readText(keptPath(plugin, name))) !== undefined;
        if (had) await store.removeFile(keptPath(plugin, name));
        return { forgotten: had };
      }
      if (method === "kept") return (await store.listFiles(keptPath(owner)).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
      if (method === "mix") {
        if (!first || typeof first !== "object" || !Array.isArray(first.tracks) || !first.tracks.length || first.tracks.length > MAX_TRACKS) throw new Error(`audio.mix takes { tracks: [{ clip, at?, gain?, pan?, chain? }] }, 1 to ${MAX_TRACKS} of them`);
        for (const track of first.tracks as Record<string, unknown>[]) {
          if (!track || typeof track !== "object") throw new Error("A track is { clip, at?, gain?, pan?, chain? }");
          checkClip(track.clip);
          if (track.chain !== undefined && (!Array.isArray(track.chain) || track.chain.length > MAX_CHAIN)) throw new Error(`A chain is a list of at most ${MAX_CHAIN} { processor, options }`);
        }
        if (first.tracks.reduce((n: number, t: { clip: { pcm: string } }) => n + t.clip.pcm.length, 0) > MAX_CLIP * 2) throw new Error("The tracks are too long to mix together");
      }
      if (method === "render" || method === "playClip" || method === "save") {
        if (!first || typeof first !== "object") throw new Error(`audio.${method} takes an object`);
        if (first.clip !== undefined || method !== "render") checkClip(first.clip);
        if (first.chain !== undefined && (!Array.isArray(first.chain) || first.chain.length > MAX_CHAIN)) throw new Error(`A chain is a list of at most ${MAX_CHAIN} { processor, options }`);
      }
      if (method === "registerProcessor") {
        const [name, source] = args;
        if (typeof name !== "string" || !PROCESSOR.test(name) || typeof source !== "string") throw new Error("registerProcessor takes a name (letters, digits and dashes) and the processor's source");
        const owner = owners.get(name);
        if (owner && owner !== base(plugin)) throw new Error(`The audio processor ${name} is ${owner}'s: pick another name`);
        owners.set(name, base(plugin));
        sources.set(name, source);
      }
      // The processors a sound uses go with it, so it plays in whichever tab it is asked of, though the plugin
      // that registered one runs in another (an effect, shared, used by a tab-scoped editor).
      const used = first && typeof first === "object" ? processorsOf(first) : [];
      const own = first && typeof first === "object" && "group" in first ? [{ ...first, group: `${plugin}\n${String(first.group)}` }, ...rest] : args;
      // One this module hasn't seen (registered before it was restarted) is left to the tab, which may have it.
      const known = used.filter((name) => sources.has(name));
      if (known.length) own[0] = { ...(own[0] as object), sources: Object.fromEntries(known.map((name) => [name, sources.get(name)])) };
      // A tab-scoped plugin's sounds play, and its files are chosen and saved, in its own tab: where the person is.
      return hosts.bridge("audio", method, own, dispatch, tabOf(plugin));
    },
  };
};

export default service("audio", make);
