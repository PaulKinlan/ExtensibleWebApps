// The `audio` service. Sound for plugins, played by the tab that runs the plugin workers.
//
// Two kinds of sound: a processor played for a while (`play`), which is how
// the Beat pad's drums are made, and a clip: a recording, as
// { rate, pcm }, where pcm is base64 of 16-bit samples, one channel. A clip
// is plain JSON, so a plugin can keep it in a collection. `render` runs a
// clip (or a processor, to make one) through a chain of effects, each an
// AudioWorklet processor some plugin registered, offline, and gives back the
// new clip: so an effect is a plugin that registers a processor, and an
// editor applies any effect it is told about without knowing what it does.
// A kernel module (docs/layers.md): a site that lists `audio` in kernel.json has it, as `ctx.call("audio", …)`.

import { service, type ModuleKernel } from "../../src/kernel/modules";
import type { ServiceProvider } from "../../src/kernel/remote";

/** The longest clip, in base64 characters: about 30 seconds at 22,050 samples a second. */
const MAX_CLIP = 2_000_000;
const MAX_CHAIN = 8;
const clipArgs = "{ rate, pcm }";

/** Checks a clip a plugin sent, so the page is never asked to decode something it shouldn't. */
function checkClip(clip: unknown): void {
  const c = clip as { rate?: unknown; pcm?: unknown } | undefined;
  if (!c || typeof c !== "object" || typeof c.pcm !== "string" || typeof c.rate !== "number") throw new Error(`A clip is ${clipArgs}: pcm is base64 of 16-bit samples`);
  if (c.rate < 3000 || c.rate > 96_000) throw new Error("A clip's rate is 3000 to 96000 samples a second");
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
  return [...names];
}

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { hosts } = kernel;
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
      playClip: {
        args: "({ clip, from?, to?, chain?, group?, at? })",
        returns: "{ played, ms, at }",
        needs: "audio",
        description: "Plays a clip, from and to in seconds (the whole clip if not given), through a chain of processors if given. With `group`, `stop` can end it. at is when it starts, in ms since the epoch, so a playhead can follow it.",
      },
      open: {
        args: "({ rate?, maxSeconds? })",
        returns: "{ name, clip, seconds } or null",
        needs: "audio",
        description: "Opens the file chooser for a sound file (WAV, MP3, Ogg…), decodes it to one channel at rate (22050 by default) and gives it back as a clip, at most maxSeconds long (15 by default, 30 at most). Only right after the person clicks; null if they close it.",
      },
      save: {
        args: "({ clip, name })",
        returns: "{ saved }",
        needs: "audio",
        description: "Saves a clip as a WAV file the person downloads, named name.wav.",
      },
    },
    capability: () => "audio",
    // A group is the plugin's own: its name is kept apart from every other plugin's.
    call: (plugin, method, args, dispatch) => {
      const [first, ...rest] = args as [Record<string, unknown> | undefined, ...unknown[]];
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
