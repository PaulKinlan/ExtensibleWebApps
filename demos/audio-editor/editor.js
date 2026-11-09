// The sound editor: a clip drawn as its waveform (<ui-waveform>), where you
// pick a part by dragging, play it, cut, trim, fade, reverse, and run it
// through effects. Clips are kept in the sound-clips collection.
//
// The editor knows none of the effects. Each is a plugin beside it that
// registers an AudioWorklet processor with the audio service and answers this
// plugin's own hook, sound-editor:effects, with its name and processor. To
// apply one, the editor asks the audio service to render the picked part
// through that processor (audio.render, offline and faster than real time)
// and puts the result back. So a new effect is a new plugin: echo.js,
// crusher.js and tremolo.js here, and any a person adds.
//
// A clip is { rate, pcm, channels? }: pcm is base64 of 16-bit samples, one
// channel or two (stereo), the audio service's format. The edits that need no
// effect (cut, fade, reverse…) are done here, on each channel's samples, in
// this worker.
//
// An effect can say what can be tuned (knobs: { delay: { label, min, max,
// step } }, beside its options); the editor draws a slider for each and
// renders with the values set. Another clip can be laid over this one, as a
// second track, starting where you say, louder or softer, to the left or
// right (audio.mix): the result is stereo. A clip too long for the collection (it holds
// 5 MB in all) is kept by the audio service in the person's data folder
// (audio.keep), and its record says where (kept).
//
// A clip, long or short, can also go to the app's folder as a WAV file
// (sounds/<name>.wav, through the folder service): a folder the person
// picks on their disk, or until they do, a private one in the browser.
// Whatever is in sounds/ opens again from there, on any device that has the
// folder, which a clip kept in the browser's data can't.

export const manifest = {
  id: "sound-editor",
  name: "Sound editor",
  description: "A clip's waveform to pick parts of, play, edit and run through effects.",
  version: "1.0.0",
  permissions: ["ui", "audio", "commands", "plugins:read", "audio:kept:sound-timeline", "folder:read", "folder:write", "folder:choose"],
  services: ["audio", "commands", "folder"],
  // A tab of its own: its sound plays, and files are opened and saved, where the person is; each tab keeps its own undo.
  scope: "tab",
  hooks: {
    effects: {
      mode: "waterfall",
      timeoutMs: 1000,
      args: "{ effects: [{ id, name, processor, description?, options?, knobs?, tail? }] }",
      description: "The effects the editor offers. An effect plugin adds itself: its processor (registered with audio.registerProcessor), the options it is given, knobs (for each option the person may tune, { label, min, max, step? }: the editor draws a slider, and passes the value set in options), and tail, the ms an echo needs to ring on after the clip.",
    },
  },
  collections: {
    "sound-clips": {
      title: "Sound clips",
      schema: {
        type: "object",
        required: ["name", "rate"],
        properties: {
          name: { type: "string", title: "Name" },
          rate: { type: "integer", minimum: 3000, maximum: 96000 },
          // The samples, or, for a long clip, the name the audio service kept them under (audio.keep).
          pcm: { type: "string" },
          kept: { type: "string" },
          // Which plugin kept them, if not this one: the timeline keeps a long mix it made into a clip (timeline.js).
          keptBy: { type: "string" },
          channels: { type: "integer", minimum: 1, maximum: 2 },
          seconds: { type: "number", title: "Length (s)" },
        },
      },
    },
  },
};

const RATE = 22050;
/** Columns in the waveform: enough to see the shape on a wide screen. */
const COLUMNS = 480;
const UNDO = 20;
/** A clip longer than this, in base64, is kept by the audio service rather than in the collection, which holds 5 MB in all. */
const INLINE = 1_000_000;
/** The longest sound file it opens, in seconds. */
const LONGEST = 300;
/** Where in the app's folder the sounds go. */
const SOUNDS = "sounds";

export default async function (ctx) {
  const views = ctx.ui.views("editor.html");
  /** The clip being edited: its record, and its samples. */
  let clip = null;
  /** Each channel's samples: one, or two for stereo. */
  let chans = [new Float32Array(0)];
  let sel = { from: 0, to: 0 };
  let playing = null;
  let effects = [];
  /** What the person set on each effect's knobs, by effect and option. */
  const tuned = {};
  let status = "";
  let undo = [];
  let redo = [];
  let stopTimer;
  /** The app's folder: its name, whether the person picked it, whether it can be used now, and the sounds in it. */
  let folder = { name: "", picked: false, allowed: true, sounds: [] };

  // Samples to and from the audio service's base64 16-bit format. Both scale by 32768, so a clip decoded and
  // encoded again is the same clip, sample for sample: undo gives back exactly what was there.
  const decode1 = (pcm) => {
    const bytes = Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const out = new Float32Array(bytes.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
    return out;
  };
  /** A clip's channels, from interleaved samples if it has two. */
  const decode = (pcm, channels = 1) => {
    const all = decode1(pcm);
    if (channels !== 2) return [all];
    const left = new Float32Array(all.length >> 1);
    const right = new Float32Array(all.length >> 1);
    for (let i = 0; i < left.length; i++) {
      left[i] = all[2 * i];
      right[i] = all[2 * i + 1];
    }
    return [left, right];
  };
  /** Channels to base64, interleaved if there are two. */
  const encode = (list) => {
    if (list.length < 2) return encode1(list[0]);
    const out = new Float32Array(list[0].length * 2);
    for (let i = 0; i < list[0].length; i++) {
      out[2 * i] = list[0][i];
      out[2 * i + 1] = list[1][i];
    }
    return encode1(out);
  };
  const encode1 = (data) => {
    const view = new DataView(new ArrayBuffer(data.length * 2));
    for (let i = 0; i < data.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(data[i] * 32768))), true);
    const bytes = new Uint8Array(view.buffer);
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const rate = () => clip?.rate ?? RATE;
  const frames = () => chans[0].length;
  const seconds = () => frames() / rate();
  const at = (s) => Math.max(0, Math.min(frames(), Math.round(s * rate())));
  const picked = () => sel.to > sel.from;
  /** The part an edit works on: the picked part, or the whole clip. */
  const range = () => (picked() ? [at(sel.from), at(sel.to)] : [0, frames()]);
  /** The clip as the audio service takes it. */
  const asClip = (list = chans) => ({ rate: rate(), pcm: encode(list), ...(list.length === 2 ? { channels: 2 } : {}) });

  /** A low and a high for each column, from -100 to 100. */
  const peaks = () => {
    if (!frames()) return "";
    const out = [];
    const per = frames() / COLUMNS;
    for (let c = 0; c < COLUMNS; c++) {
      let low = 0;
      let high = 0;
      for (const samples of chans)
        for (let i = Math.floor(c * per), end = Math.min(samples.length, Math.floor((c + 1) * per) || 1); i < end; i++) {
          if (samples[i] < low) low = samples[i];
          if (samples[i] > high) high = samples[i];
        }
      out.push(Math.round(low * 100), Math.round(high * 100));
    }
    return out.join(",");
  };

  const draw = async () => {
    const clips = (await ctx.call("data", "list", "sound-clips")).sort((a, b) => a.name.localeCompare(b.name));
    views.render("main", "editor", {
      has: !!clip,
      noClip: !clip,
      name: clip?.name ?? "",
      others: clips.filter((c) => c.id !== clip?.id).map((c) => ({ id: c.id, name: c.name })),
      noOthers: clips.length < 2,
      layerAt: sel.from.toFixed(2),
      clips: clips.map((c) => ({ id: c.id, name: c.name, seconds: (c.seconds ?? 0).toFixed(1), current: c.id === clip?.id, stereo: c.channels === 2 })),
      stereo: chans.length === 2,
      kept: !!clip?.kept,
      peaks: peaks(),
      duration: seconds().toFixed(3),
      length: seconds().toFixed(2),
      select: `${sel.from},${sel.to}`,
      picked: picked(),
      part: picked() ? `${sel.from.toFixed(2)} to ${sel.to.toFixed(2)} s` : "the whole clip",
      playing: playing ? `${playing.at},${playing.from},${playing.to}` : "",
      isPlaying: !!playing,
      effects,
      noEffects: !effects.length,
      noUndo: !undo.length,
      noRedo: !redo.length,
      noPart: !picked(),
      folderName: folder.name || "the app's folder",
      folderPicked: folder.picked,
      folderBlocked: !folder.allowed,
      folderSounds: folder.sounds.map((path) => ({ path, name: path.slice(SOUNDS.length + 1, -4) })),
      noFolderSounds: !folder.sounds.length,
      status,
    });
  };

  /** Asks the effect plugins what they offer. */
  const collect = async () => {
    const answer = await ctx.hooks.call("effects", { effects: [] }).catch(() => null);
    const list = Array.isArray(answer?.effects) ? answer.effects : [];
    effects = list
      .filter((e) => e && typeof e.id === "string" && typeof e.processor === "string")
      .map((e) => {
        const options = e.options && typeof e.options === "object" ? e.options : {};
        // Each knob tunes one of the options, from min to max; what the person set stays when the effects are asked again.
        const knobs = Object.entries(e.knobs && typeof e.knobs === "object" ? e.knobs : {})
          .filter(([key, k]) => k && Number.isFinite(Number(k.min)) && Number.isFinite(Number(k.max)) && Number(k.max) > Number(k.min) && Number.isFinite(Number(options[key])))
          .slice(0, 8)
          .map(([key, k]) => {
            const value = tuned[e.id]?.[key] ?? Number(options[key]);
            const step = Number(k.step) > 0 ? Number(k.step) : (Number(k.max) - Number(k.min)) / 100;
            return { key, label: String(k.label || key), min: Number(k.min), max: Number(k.max), step, value, shown: `${+value.toFixed(3)}${k.unit ? ` ${k.unit}` : ""}`, action: `knob:${e.id}:${key}` };
          });
        return { id: e.id, name: String(e.name || e.id), description: String(e.description || ""), processor: e.processor, options, knobs, tunable: knobs.length > 0, tail: Number(e.tail) || 0 };
      });
  };
  /** An effect's options, with what the person set on its knobs. */
  const optionsOf = (effect) => ({ ...effect.options, ...Object.fromEntries(effect.knobs.map((k) => [k.key, k.value])) });

  /** Keeps the clip as it is now, and marks it as one step to undo. */
  const save = async (next, note) => {
    if (clip) {
      undo.push({ pcm: encode(chans), channels: chans.length, rate: clip.rate, sel });
      if (undo.length > UNDO) undo.shift();
      redo = [];
    }
    await keep(next);
    status = note;
  };
  /** Keeps the clip as `next` (a list of channels, or one channel's samples). */
  const keep = async (next) => {
    const list = Array.isArray(next) ? next : [next];
    const pcm = encode(list);
    // What is edited is what is kept: 16-bit samples, not the finer numbers an edit worked out.
    chans = decode(pcm, list.length);
    clip = { ...clip, pcm, channels: list.length, seconds: Math.round(seconds() * 100) / 100 };
    await put();
  };
  /**
   * Writes the clip to the collection, and notes the id a new one gets. A long one's samples go to the audio
   * service's keeping (audio.keep), under a name the record holds, so the collection only holds the short ones.
   */
  const put = async () => {
    const { id, name, rate, pcm, seconds, channels } = clip;
    let kept;
    if (pcm.length > INLINE) {
      // A clip another plugin kept is copied into this one's keeping once it is edited: the other's stays as it was.
      kept = (!clip.keptBy && clip.kept) || `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      await ctx.call("audio", "keep", { name: kept, clip: { rate, pcm, ...(channels === 2 ? { channels } : {}) } });
    }
    const record = { ...(id ? { id } : {}), name, rate, ...(kept ? { kept } : { pcm }), ...(channels === 2 ? { channels } : {}), seconds };
    const result = await ctx.call("data", "put", "sound-clips", record);
    if (!result?.ok) throw new Error(`The clip wasn't kept: ${JSON.stringify(result?.errors ?? result)}`);
    // A clip that got short enough to go in its record: the kept samples go only once the record holds them.
    if (!kept && clip.kept && !clip.keptBy) await ctx.call("audio", "forget", { name: clip.kept }).catch(() => {});
    clip.id = result.id;
    clip.kept = kept;
    delete clip.keptBy;
  };

  const load = async (record) => {
    await stop();
    clip = record ? { ...record } : null;
    if (record?.kept && !record.pcm) {
      const kept = await ctx.call("audio", "load", { name: record.kept, ...(record.keptBy ? { of: record.keptBy } : {}) });
      clip.pcm = kept?.pcm ?? "";
      if (!kept) status = `${record.name}'s sound isn't in this browser's data folder`;
    }
    chans = clip?.pcm ? decode(clip.pcm, clip.channels) : [new Float32Array(0)];
    sel = { from: 0, to: 0 };
    undo = [];
    redo = [];
  };

  /** What the app's folder is, and the sounds in it. */
  const lookInFolder = async () => {
    try {
      const about = await ctx.call("folder", "about");
      const sounds = about.allowed ? (await ctx.call("folder", "list", SOUNDS)).filter((p) => /\.wav$/i.test(p)) : [];
      folder = { name: about.name ?? "", picked: !!about.picked, allowed: !!about.allowed, sounds };
    } catch (error) {
      folder = { ...folder, allowed: false, sounds: [] };
    }
  };

  /** The clip as a WAV file's bytes, in a data: URL: 16-bit samples, one channel or two. */
  const wav = () => {
    const samples = atob(encode(chans));
    const channels = chans.length;
    const header = new DataView(new ArrayBuffer(44));
    const text = (at, s) => [...s].forEach((c, i) => header.setUint8(at + i, c.charCodeAt(0)));
    text(0, "RIFF");
    header.setUint32(4, 36 + samples.length, true);
    text(8, "WAVE");
    text(12, "fmt ");
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, channels, true);
    header.setUint32(24, rate(), true);
    header.setUint32(28, rate() * channels * 2, true);
    header.setUint16(32, channels * 2, true);
    header.setUint16(34, 16, true);
    text(36, "data");
    header.setUint32(40, samples.length, true);
    return `data:audio/wav;base64,${btoa(String.fromCharCode(...new Uint8Array(header.buffer)) + samples)}`;
  };

  /** A WAV file's clip, from a data: URL: 16-bit PCM, one channel or two, as this editor saves them. */
  const fromWav = (url) => {
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const tag = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("That isn't a WAV file");
    let format = null;
    for (let at = 12; at + 8 <= bytes.length; ) {
      const size = view.getUint32(at + 4, true);
      if (tag(at) === "fmt ") format = { code: view.getUint16(at + 8, true), channels: view.getUint16(at + 10, true), rate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
      if (tag(at) === "data") {
        if (!format || format.code !== 1 || format.bits !== 16 || format.channels > 2) throw new Error("Only 16-bit WAV opens from the folder: use Open a sound file… for others");
        const data = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
        let text = "";
        for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
        return { rate: format.rate, channels: format.channels, pcm: btoa(text) };
      }
      at += 8 + size + (size % 2);
    }
    throw new Error("That WAV file has no sound in it");
  };

  /** A clip's name as a file name: no characters a disk refuses. */
  const fileName = (name) => name.replace(/[\u0000-\u001f/\\:*?"<>|]+/g, "-").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 80) || "clip";

  const saveToFolder = async () => {
    if (!clip) return "No clip";
    const path = `${SOUNDS}/${fileName(clip.name)}.wav`;
    try {
      await ctx.call("folder", "writeData", path, wav());
      status = `Saved to ${folder.picked ? folder.name : "the private folder"}: ${path}`;
    } catch (error) {
      status = `Not saved: ${error instanceof Error ? error.message : error}`;
    }
    await lookInFolder();
    await draw();
    return status;
  };

  const openFromFolder = async (path) => {
    if (!folder.sounds.includes(path)) return (status = "Pick a sound in the folder"), draw(), status;
    try {
      const url = await ctx.call("folder", "readData", path);
      if (!url) throw new Error(`${path} is gone`);
      const opened = fromWav(url);
      if (opened.rate < 3000 || opened.rate > 96000) throw new Error("Its sample rate is outside 3,000 to 96,000");
      await load(null);
      clip = { name: path.slice(SOUNDS.length + 1, -4), rate: opened.rate };
      await keep(decode(opened.pcm, opened.channels));
      status = `Opened ${path} from ${folder.picked ? folder.name : "the private folder"}`;
    } catch (error) {
      status = `Not opened: ${error instanceof Error ? error.message : error}`;
    }
    await draw();
    return status;
  };

  // Clips to start from, made here: a plucked phrase (Karplus-Strong strings) and a drum loop.
  const makers = {
    pluck() {
      const notes = [220, 262, 330, 392, 330, 262, 294, 220];
      const out = new Float32Array(RATE * 4);
      notes.forEach((f, n) => {
        const period = Math.round(RATE / f);
        const ring = Float32Array.from({ length: period }, () => Math.random() * 2 - 1);
        const start = n * RATE * 0.5;
        for (let i = 0; i < RATE * 0.9 && start + i < out.length; i++) {
          const k = i % period;
          const v = ring[k];
          ring[k] = 0.996 * 0.5 * (v + ring[(k + 1) % period]);
          out[start + i] += v * 0.45;
        }
      });
      return out;
    },
    drums() {
      const out = new Float32Array(RATE * 4);
      const beat = RATE / 2;
      for (let b = 0; b < 8; b++) {
        const start = b * beat;
        for (let i = 0; i < RATE * 0.35 && start + i < out.length; i++) {
          const t = i / RATE;
          // A kick on every beat, and a snare's noise on two and four.
          out[start + i] += 0.8 * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 9);
          if (b % 2) out[start + i] += 0.35 * (Math.random() * 2 - 1) * Math.exp(-t * 20);
        }
        for (let i = 0, off = Math.round(start + beat / 2); i < RATE * 0.05; i++) out[off + i] += 0.15 * (Math.random() * 2 - 1) * Math.exp(-(i / RATE) * 80);
      }
      return out;
    },
  };
  const create = async (kind) => {
    await load(null);
    clip = { name: kind === "drums" ? "Drum loop" : "Plucked phrase", rate: RATE };
    await keep(makers[kind]());
    status = `Made ${clip.name}`;
  };

  // The edits.
  const edits = {
    // Neither leaves an empty clip: there would be nothing to keep, or to pick from.
    cut: () => (picked() && at(sel.to) - at(sel.from) < frames() ? [chans.map((samples) => concat(samples.subarray(0, at(sel.from)), samples.subarray(at(sel.to)))), "Cut"] : null),
    trim: () => (picked() && at(sel.to) > at(sel.from) ? [chans.map((samples) => samples.slice(at(sel.from), at(sel.to))), "Trimmed to the part picked"] : null),
    silence: () => change((part) => part.fill(0), "Silenced"),
    reverse: () => change((part) => part.reverse(), "Reversed"),
    fadein: () => change((part) => part.forEach((v, i) => (part[i] = v * (i / part.length))), "Faded in"),
    fadeout: () => change((part) => part.forEach((v, i) => (part[i] = v * (1 - i / part.length))), "Faded out"),
    louder: () => change((part) => part.forEach((v, i) => (part[i] = v * 1.4)), "Louder"),
    quieter: () => change((part) => part.forEach((v, i) => (part[i] = v * 0.7)), "Quieter"),
    normalize: () =>
      change((part) => {
        // Every channel by the same amount, so stereo keeps its balance.
        const peak = part.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
        if (peak > 0) part.forEach((v, i) => (part[i] = (v / peak) * 0.98));
      }, "Normalised", true),
  };
  const concat = (a, b) => {
    const out = new Float32Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  };
  /**
   * Changes the part picked (or the whole clip) in a copy of each channel, and gives back [the new channels, the
   * note]. `together` runs fn once over the channels side by side (as one array), for an edit that must treat them alike.
   */
  const change = (fn, note, together = false) => {
    const [a, b] = range();
    const next = chans.map((samples) => samples.slice());
    if (together && next.length > 1) {
      const both = concat(next[0].subarray(a, b), next[1].subarray(a, b));
      fn(both);
      next[0].set(both.subarray(0, b - a), a);
      next[1].set(both.subarray(b - a), a);
    } else for (const samples of next) fn(samples.subarray(a, b));
    return [next, picked() ? `${note}: ${sel.from.toFixed(2)} to ${sel.to.toFixed(2)} s` : note];
  };
  const edit = async (name) => {
    if (!clip) return "No clip";
    const done = edits[name]?.();
    if (!done) return name === "cut" && picked() ? "That's the whole clip: make a new one instead" : "Pick a part first";
    await save(done[0], done[1]);
    if (name === "cut" || name === "trim") sel = { from: name === "cut" ? sel.from : 0, to: name === "cut" ? sel.from : 0 };
    await draw();
    return done[1];
  };

  /** Runs the picked part (or the whole clip) through an effect, in the audio service, and puts it back. */
  const apply = async (id) => {
    const effect = effects.find((e) => e.id === id);
    if (!clip || !effect) return "No such effect";
    const [a, b] = range();
    const whole = a === 0 && b === frames();
    // What it applies to is fixed now: a pick made while it renders doesn't move where the result goes.
    const note = `${effect.name}${whole ? "" : `: ${sel.from.toFixed(2)} to ${sel.to.toFixed(2)} s`}`;
    const before = chans;
    status = `Applying ${effect.name}…`;
    await draw();
    const part = asClip(chans.map((samples) => samples.subarray(a, b)));
    const rendered = await ctx.call("audio", "render", { clip: part, chain: [{ processor: effect.processor, options: optionsOf(effect) }], tail: whole ? effect.tail : 0 });
    const out = decode(rendered.pcm, rendered.channels);
    // Edits run one at a time (serial), so nothing else changed the clip meanwhile; this is a check that stays true.
    if (chans !== before) return "The clip changed while the effect ran";
    // The whole clip may grow, for an echo's tail; a part keeps its length, so what follows stays in time.
    const next = whole
      ? out
      : chans.map((samples, c) => {
          const copy = samples.slice();
          copy.set((out[c] ?? out[0]).subarray(0, b - a), a);
          return copy;
        });
    await save(next, note);
    await draw();
    return status;
  };

  /**
   * Lays another clip over this one, as a second track: it starts `at` seconds in, at `gain`, panned from -1 (left)
   * to 1 (right). The audio service mixes the two (audio.mix), in stereo, and the mix replaces the clip, as one step to undo.
   */
  const layer = async (form) => {
    if (!clip) return "No clip";
    const records = await ctx.call("data", "list", "sound-clips");
    const other = records.find((r) => r.id === form?.clip);
    if (!other) return (status = "Pick a clip to lay over this one"), draw();
    const otherPcm = other.kept && !other.pcm ? (await ctx.call("audio", "load", { name: other.kept, ...(other.keptBy ? { of: other.keptBy } : {}) }))?.pcm : other.pcm;
    if (!otherPcm) return (status = `${other.name}'s sound isn't here`), draw();
    const at = Math.max(0, Number(form.at) || 0);
    const gain = Math.min(2, Math.max(0, Number(form.gain ?? 1)));
    const pan = Math.min(1, Math.max(-1, Number(form.pan) || 0));
    status = `Mixing in ${other.name}…`;
    await draw();
    const mixed = await ctx.call("audio", "mix", {
      rate: rate(),
      tracks: [
        { clip: asClip() },
        { clip: { rate: other.rate, pcm: otherPcm, ...(other.channels === 2 ? { channels: 2 } : {}) }, at, gain, pan },
      ],
    });
    await save(decode(mixed.pcm, mixed.channels), `Mixed in ${other.name} at ${at.toFixed(2)} s`);
    await draw();
    return status;
  };

  const play = async (part = picked()) => {
    if (!clip) return;
    await stop();
    const from = part ? sel.from : 0;
    const to = part ? sel.to : seconds();
    const { at: started, ms } = await ctx.call("audio", "playClip", { clip: { rate: rate(), pcm: clip.pcm, ...(chans.length === 2 ? { channels: 2 } : {}) }, from, to, group: "play" });
    playing = { at: started, from, to };
    stopTimer = setTimeout(() => {
      playing = null;
      draw();
    }, ms + Math.max(0, started - Date.now()) + 50);
    await draw();
    return "Playing";
  };
  async function stop() {
    clearTimeout(stopTimer);
    if (!playing) return;
    playing = null;
    await ctx.call("audio", "stop", { group: "play" }).catch(() => {});
    await draw();
  }

  const back = async (from, to, note) => {
    const step = from.pop();
    if (!step) return "Nothing to " + note.toLowerCase();
    to.push({ pcm: encode(chans), channels: chans.length, rate: clip.rate, sel });
    clip = { ...clip, rate: step.rate };
    sel = step.sel;
    await keep(decode(step.pcm, step.channels));
    status = note;
    await draw();
    return note;
  };

  /**
   * Whatever changes the clip runs one at a time, in the order asked: an effect still rendering when the person
   * undoes, or opens another clip, finishes first, so its result never lands on the wrong clip or over a newer edit.
   */
  let queue = Promise.resolve();
  const serial = (work) => (queue = queue.then(work, work));
  const CHANGES = /^(undo|redo|new:|open-clip|open-file|rename|edit:|effect:|mono|layer|folder-open)/;

  ctx.ui.onEvent(async (action, value) => (CHANGES.test(action) ? serial(() => handle(action, value)) : handle(action, value)));
  async function handle(action, value) {
    if (action === "select") {
      sel = { from: Number(value?.from) || 0, to: Number(value?.to) || 0 };
      return draw();
    }
    if (action === "play") return playing ? stop() : play();
    if (action === "play-part") return play(true);
    if (action === "stop") return stop();
    if (action === "undo") return back(undo, redo, "Undone");
    if (action === "redo") return back(redo, undo, "Redone");
    if (action.startsWith("new:")) return create(action.slice(4)).then(draw);
    if (action === "open-clip") {
      const records = await ctx.call("data", "list", "sound-clips");
      await load(records.find((r) => r.id === value) ?? null);
      return draw();
    }
    if (action === "open-file") {
      // Opened in stereo; a file whose two sides are the same is kept as one channel.
      const opened = await ctx.call("audio", "open", { rate: RATE, channels: 2, maxSeconds: LONGEST }).catch((error) => ((status = String(error.message ?? error)), null));
      if (opened) {
        await load(null);
        clip = { name: opened.name, rate: opened.clip.rate };
        const list = decode(opened.clip.pcm, opened.clip.channels);
        await keep(list.length === 2 && list[0].every((v, i) => v === list[1][i]) ? [list[0]] : list);
        status = `Opened ${opened.name}${chans.length === 2 ? ", in stereo" : ""}`;
      }
      return draw();
    }
    if (action === "save-file") {
      if (clip) await ctx.call("audio", "save", { clip: asClip(), name: clip.name });
      return;
    }
    if (action === "layer") return layer(value);
    if (action === "folder-save") return saveToFolder();
    if (action === "folder-open") return openFromFolder(value?.path);
    if (action === "folder-pick" || action === "folder-allow") {
      await ctx.call("folder", action === "folder-pick" ? "choose" : "allow").catch((error) => (status = String(error.message ?? error)));
      await lookInFolder();
      return draw();
    }
    if (action === "mono") {
      if (!clip || chans.length < 2) return;
      const mixed = chans[0].map((v, i) => (v + chans[1][i]) / 2);
      await save([mixed], "Mixed down to one channel");
      return draw();
    }
    if (action.startsWith("knob:")) {
      const [, id, key] = action.split(":");
      const effect = effects.find((e) => e.id === id);
      const knob = effect?.knobs.find((k) => k.key === key);
      const set = Number(value);
      if (!knob || !Number.isFinite(set)) return;
      knob.value = Math.min(knob.max, Math.max(knob.min, set));
      (tuned[id] ??= {})[key] = knob.value;
      await collect();
      return draw();
    }
    if (action === "rename") {
      if (!clip || !String(value?.name ?? "").trim()) return;
      clip = { ...clip, name: String(value.name).trim().slice(0, 80) };
      await put();
      return draw();
    }
    if (action.startsWith("edit:")) return edit(action.slice(5));
    if (action.startsWith("effect:")) return apply(action.slice(7));
  }

  ctx.commands.add({ id: "play", title: "Play or stop", group: "Sound", keys: ["Space"] }, async () => (await (playing ? stop() : play())) ?? "Stopped");
  ctx.commands.add({ id: "undo", title: "Undo the last edit", group: "Sound", keys: ["Mod+Z"] }, () => serial(() => back(undo, redo, "Undone")));
  ctx.commands.add({ id: "redo", title: "Redo", group: "Sound", keys: ["Mod+Shift+Z"] }, () => serial(() => back(redo, undo, "Redone")));
  ctx.commands.add({ id: "cut", title: "Cut the part picked", group: "Sound", keys: ["Mod+X"] }, () => serial(() => edit("cut")));
  ctx.commands.add({ id: "trim", title: "Trim to the part picked", group: "Sound", keys: ["Mod+T"] }, () => serial(() => edit("trim")));
  ctx.commands.add({ id: "reverse", title: "Reverse", group: "Sound" }, () => serial(() => edit("reverse")));
  ctx.commands.add({ id: "normalize", title: "Normalise", group: "Sound" }, () => serial(() => edit("normalize")));
  ctx.commands.add({ id: "apply-effect", title: "Apply an effect", group: "Sound", args: { type: "object", properties: { effect: { type: "string", description: "The effect's id, as sound-editor:effects lists it" } }, required: ["effect"] } }, ({ effect }) => serial(() => apply(effect)));
  ctx.commands.add(
    { id: "tune-effect", title: "Tune an effect", group: "Sound", args: { type: "object", properties: { effect: { type: "string", description: "The effect's id" }, knob: { type: "string", description: "The option to tune, as the effect's knobs name it" }, value: { type: "number" } }, required: ["effect", "knob", "value"] } },
    async ({ effect, knob, value }) => {
      await handle(`knob:${effect}:${knob}`, value);
      return `${effect} ${knob}: ${tuned[effect]?.[knob] ?? "not a knob"}`;
    },
  );

  // An effect plugin turned on or added later is offered once it has started, which takes a moment after it is
  // installed; so are the app's own effects that started after this one.
  const recollect = () => {
    for (const ms of [300, 1500]) setTimeout(() => collect().then(draw), ms);
  };
  ctx.on("plugins:changed", recollect);
  // A clip added or changed elsewhere (the timeline keeping a mix, another tab) is in the clip list at once.
  ctx.on("data:changed:sound-clips", () => serial(() => draw()));
  recollect();

  ctx.commands.add({ id: "save-to-folder", title: "Save the clip to the folder", group: "Sound" }, () => serial(saveToFolder));

  // Start with the first clip there is, or make one.
  await collect();
  await lookInFolder();
  const clips = await ctx.call("data", "list", "sound-clips");
  if (clips.length) await load(clips.sort((a, b) => a.name.localeCompare(b.name))[0]);
  else await create("pluck");
  await draw();
}
