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
// A clip is { rate, pcm }: pcm is base64 of 16-bit samples, one channel, the
// audio service's format. The edits that need no effect (cut, fade, reverse…)
// are done here, on the samples, in this worker.

export const manifest = {
  id: "sound-editor",
  name: "Sound editor",
  description: "A clip's waveform to pick parts of, play, edit and run through effects.",
  version: "1.0.0",
  permissions: ["ui", "audio", "commands", "plugins:read"],
  services: ["audio", "commands"],
  // A tab of its own: its sound plays, and files are opened and saved, where the person is; each tab keeps its own undo.
  scope: "tab",
  hooks: {
    effects: {
      mode: "waterfall",
      timeoutMs: 1000,
      args: "{ effects: [{ id, name, processor, description?, options?, tail? }] }",
      description: "The effects the editor offers. An effect plugin adds itself: its processor (registered with audio.registerProcessor), the options it is given, and tail, the ms an echo needs to ring on after the clip.",
    },
  },
  collections: {
    "sound-clips": {
      title: "Sound clips",
      schema: {
        type: "object",
        required: ["name", "rate", "pcm"],
        properties: {
          name: { type: "string", title: "Name" },
          rate: { type: "integer", minimum: 3000, maximum: 96000 },
          pcm: { type: "string" },
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

export default async function (ctx) {
  const views = ctx.ui.views("editor.html");
  /** The clip being edited: its record, and its samples. */
  let clip = null;
  let samples = new Float32Array(0);
  let sel = { from: 0, to: 0 };
  let playing = null;
  let effects = [];
  let status = "";
  let undo = [];
  let redo = [];
  let stopTimer;

  // Samples to and from the audio service's base64 16-bit format. Both scale by 32768, so a clip decoded and
  // encoded again is the same clip, sample for sample: undo gives back exactly what was there.
  const decode = (pcm) => {
    const bytes = Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const out = new Float32Array(bytes.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
    return out;
  };
  const encode = (data) => {
    const view = new DataView(new ArrayBuffer(data.length * 2));
    for (let i = 0; i < data.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(data[i] * 32768))), true);
    const bytes = new Uint8Array(view.buffer);
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const rate = () => clip?.rate ?? RATE;
  const seconds = () => samples.length / rate();
  const at = (s) => Math.max(0, Math.min(samples.length, Math.round(s * rate())));
  const picked = () => sel.to > sel.from;
  /** The part an edit works on: the picked part, or the whole clip. */
  const range = () => (picked() ? [at(sel.from), at(sel.to)] : [0, samples.length]);

  /** A low and a high for each column, from -100 to 100. */
  const peaks = () => {
    if (!samples.length) return "";
    const out = [];
    const per = samples.length / COLUMNS;
    for (let c = 0; c < COLUMNS; c++) {
      let low = 0;
      let high = 0;
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
      clips: clips.map((c) => ({ id: c.id, name: c.name, seconds: (c.seconds ?? 0).toFixed(1), current: c.id === clip?.id })),
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
      status,
    });
  };

  /** Asks the effect plugins what they offer. */
  const collect = async () => {
    const answer = await ctx.hooks.call("effects", { effects: [] }).catch(() => null);
    const list = Array.isArray(answer?.effects) ? answer.effects : [];
    effects = list.filter((e) => e && typeof e.id === "string" && typeof e.processor === "string").map((e) => ({ id: e.id, name: String(e.name || e.id), description: String(e.description || ""), processor: e.processor, options: e.options ?? {}, tail: Number(e.tail) || 0 }));
  };

  /** Keeps the clip as it is now, and marks it as one step to undo. */
  const save = async (next, note) => {
    if (clip) {
      undo.push({ pcm: clip.pcm, rate: clip.rate, sel });
      if (undo.length > UNDO) undo.shift();
      redo = [];
    }
    await keep(next);
    status = note;
  };
  const keep = async (next) => {
    const pcm = encode(next);
    // What is edited is what is kept: 16-bit samples, not the finer numbers an edit worked out.
    samples = decode(pcm);
    clip = { ...clip, pcm, seconds: Math.round(seconds() * 100) / 100 };
    await put();
  };
  /** Writes the clip to the collection, and notes the id a new one gets. */
  const put = async () => {
    const { id, name, rate, pcm, seconds } = clip;
    const result = await ctx.call("data", "put", "sound-clips", { ...(id ? { id } : {}), name, rate, pcm, seconds });
    if (!result?.ok) throw new Error(`The clip wasn't kept: ${JSON.stringify(result?.errors ?? result)}`);
    clip.id = result.id;
  };

  const load = async (record) => {
    await stop();
    clip = record;
    samples = record ? decode(record.pcm) : new Float32Array(0);
    sel = { from: 0, to: 0 };
    undo = [];
    redo = [];
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
        for (let i = 0; i < RATE * 0.05; i++) out[start + beat / 2 + i] += 0.15 * (Math.random() * 2 - 1) * Math.exp(-(i / RATE) * 80);
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
    cut: () => (picked() ? [concat(samples.subarray(0, at(sel.from)), samples.subarray(at(sel.to))), "Cut"] : null),
    trim: () => (picked() ? [samples.slice(at(sel.from), at(sel.to)), "Trimmed to the part picked"] : null),
    silence: () => change((part) => part.fill(0), "Silenced"),
    reverse: () => change((part) => part.reverse(), "Reversed"),
    fadein: () => change((part) => part.forEach((v, i) => (part[i] = v * (i / part.length))), "Faded in"),
    fadeout: () => change((part) => part.forEach((v, i) => (part[i] = v * (1 - i / part.length))), "Faded out"),
    louder: () => change((part) => part.forEach((v, i) => (part[i] = v * 1.4)), "Louder"),
    quieter: () => change((part) => part.forEach((v, i) => (part[i] = v * 0.7)), "Quieter"),
    normalize: () =>
      change((part) => {
        const peak = part.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
        if (peak > 0) part.forEach((v, i) => (part[i] = (v / peak) * 0.98));
      }, "Normalised"),
  };
  const concat = (a, b) => {
    const out = new Float32Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  };
  /** Changes the part picked (or the whole clip) in a copy, and gives back [the new samples, the note]. */
  const change = (fn, note) => {
    const next = samples.slice();
    const [a, b] = range();
    fn(next.subarray(a, b));
    return [next, picked() ? `${note}: ${sel.from.toFixed(2)} to ${sel.to.toFixed(2)} s` : note];
  };
  const edit = async (name) => {
    if (!clip) return "No clip";
    const done = edits[name]?.();
    if (!done) return "Pick a part first";
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
    const whole = a === 0 && b === samples.length;
    status = `Applying ${effect.name}…`;
    await draw();
    const part = { rate: rate(), pcm: encode(samples.subarray(a, b)) };
    const out = decode((await ctx.call("audio", "render", { clip: part, chain: [{ processor: effect.processor, options: effect.options }], tail: whole ? effect.tail : 0 })).pcm);
    // The whole clip may grow, for an echo's tail; a part keeps its length, so what follows stays in time.
    const next = whole ? out : samples.slice();
    if (!whole) next.set(out.subarray(0, b - a), a);
    await save(next, `${effect.name}${whole ? "" : `: ${sel.from.toFixed(2)} to ${sel.to.toFixed(2)} s`}`);
    await draw();
    return status;
  };

  const play = async (part = picked()) => {
    if (!clip) return;
    await stop();
    const from = part ? sel.from : 0;
    const to = part ? sel.to : seconds();
    const { at: started, ms } = await ctx.call("audio", "playClip", { clip: { rate: rate(), pcm: clip.pcm }, from, to, group: "play" });
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
    to.push({ pcm: clip.pcm, rate: clip.rate, sel });
    clip = { ...clip, rate: step.rate };
    sel = step.sel;
    await keep(decode(step.pcm));
    status = note;
    await draw();
    return note;
  };

  ctx.ui.onEvent(async (action, value) => {
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
      const opened = await ctx.call("audio", "open", { rate: RATE }).catch((error) => ((status = String(error.message ?? error)), null));
      if (opened) {
        await load(null);
        clip = { name: opened.name, rate: opened.clip.rate };
        await keep(decode(opened.clip.pcm));
        status = `Opened ${opened.name}`;
      }
      return draw();
    }
    if (action === "save-file") {
      if (clip) await ctx.call("audio", "save", { clip: { rate: rate(), pcm: clip.pcm }, name: clip.name });
      return;
    }
    if (action === "rename") {
      if (!clip || !String(value?.name ?? "").trim()) return;
      clip = { ...clip, name: String(value.name).trim().slice(0, 80) };
      await put();
      return draw();
    }
    if (action.startsWith("edit:")) return edit(action.slice(5));
    if (action.startsWith("effect:")) return apply(action.slice(7));
  });

  ctx.commands.add({ id: "play", title: "Play or stop", group: "Sound", keys: ["Space"] }, async () => (await (playing ? stop() : play())) ?? "Stopped");
  ctx.commands.add({ id: "undo", title: "Undo the last edit", group: "Sound", keys: ["Mod+Z"] }, () => back(undo, redo, "Undone"));
  ctx.commands.add({ id: "redo", title: "Redo", group: "Sound", keys: ["Mod+Shift+Z"] }, () => back(redo, undo, "Redone"));
  ctx.commands.add({ id: "cut", title: "Cut the part picked", group: "Sound", keys: ["Mod+X"] }, () => edit("cut"));
  ctx.commands.add({ id: "trim", title: "Trim to the part picked", group: "Sound", keys: ["Mod+T"] }, () => edit("trim"));
  ctx.commands.add({ id: "reverse", title: "Reverse", group: "Sound" }, () => edit("reverse"));
  ctx.commands.add({ id: "normalize", title: "Normalise", group: "Sound" }, () => edit("normalize"));
  ctx.commands.add({ id: "apply-effect", title: "Apply an effect", group: "Sound", args: { type: "object", properties: { effect: { type: "string", description: "The effect's id, as sound-editor:effects lists it" } }, required: ["effect"] } }, ({ effect }) => apply(effect));

  // An effect plugin turned on or added later is offered once it has started, which takes a moment after it is
  // installed; so are the app's own effects that started after this one.
  const recollect = () => {
    for (const ms of [300, 1500]) setTimeout(() => collect().then(draw), ms);
  };
  ctx.on("plugins:changed", recollect);
  recollect();

  // Start with the first clip there is, or make one.
  await collect();
  const clips = await ctx.call("data", "list", "sound-clips");
  if (clips.length) await load(clips.sort((a, b) => a.name.localeCompare(b.name))[0]);
  else await create("pluck");
  await draw();
}
