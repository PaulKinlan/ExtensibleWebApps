// Timeline: clips side by side as tracks, each of which can still be moved,
// made louder or softer, panned and muted after it is in the mix. The
// editor's "Layer another clip" mixes a clip in for good; here nothing is
// mixed until you play it or keep it, so a track that came in late or too
// loud is put right by dragging it or turning it down.
//
// A mix is a record in this plugin's own collection, sound-mixes: a name and
// its tracks, { key, clip, at, gain, pan, mute }, where clip is a record in
// the editor's sound-clips (read with data:read:sound-clips). A long clip,
// which the editor keeps with the audio service rather than in its record,
// comes from there (audio.load with `of`, which audio:kept:sound-editor
// allows). Playing renders the tracks with audio.mix, offline, then plays the
// result; "Make it a clip" puts the mix in sound-clips as a new clip for the
// editor, which the person allows once on a review card, as for any write to
// another plugin's collection.
//
// The tracks are drawn on a canvas, one lane each, with their waveforms:
// drag a track along its lane to move it. Below it, each track's level, pan,
// start and mute are controls of a plain template (timeline.html).

export const manifest = {
  id: "sound-timeline",
  name: "Timeline",
  description: "Clips laid side by side as tracks you can still move, re-level, pan and mute; plays the mix, or keeps it as a clip.",
  version: "1.0.0",
  permissions: ["ui", "audio", "commands", "data:read:sound-clips", "data:write:sound-clips", "audio:kept:sound-editor"],
  services: ["audio", "commands"],
  // Its sound plays, and its canvas is drawn, in the tab where the person is. It goes below the editor (views are 1000 unless they say).
  scope: "tab",
  order: 2000,
  collections: {
    "sound-mixes": {
      title: "Mixes",
      schema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", title: "Name" },
          tracks: {
            type: "array",
            title: "Tracks",
            items: {
              type: "object",
              required: ["key", "clip"],
              properties: {
                key: { type: "string" },
                clip: { type: "string", title: "Clip" },
                at: { type: "number", title: "Starts at (s)", minimum: 0 },
                gain: { type: "number", title: "Level", minimum: 0, maximum: 2 },
                pan: { type: "number", title: "Left to right", minimum: -1, maximum: 1 },
                mute: { type: "boolean", title: "Muted" },
              },
            },
          },
        },
      },
    },
  },
};

const W = 960;
const H = 300;
/** Where the lanes start below the ruler, and the most tracks a mix has (the audio service mixes up to 16). */
const RULER = 26;
const MOST = 8;
/** Points across a clip's waveform, whatever its length. */
const PEAKS = 400;
/** A mix short enough for a clip's record; a longer one is kept by the audio service, as the editor does. */
const INLINE = 1_000_000;
const COLOURS = ["#7c9cff", "#ff9e7a", "#6fd3a8", "#e6a1ff", "#ffd36b", "#7ad7ff", "#ff7aa8", "#b5e86b"];

export default async function (ctx) {
  const views = ctx.ui.views("timeline.html");
  let mixes = [];
  /** The mix open now: its record. */
  let mix = null;
  let clips = [];
  /** Each clip's sound and waveform, by record id, once read: { rate, pcm, channels, seconds, peaks }. */
  const sounds = new Map();
  /** The last mix rendered, and what it was rendered from, so playing it again doesn't render it again. */
  let rendered = null;
  let playing = null;
  let stopTimer;
  let status = "";
  let canvas = null;
  let theme = null;
  /** A track being dragged: its key, where the finger went down, and where the track started. */
  let drag = null;
  /** Seconds across the canvas: fixed while a track is dragged, so it doesn't run away from the finger. */
  let span = 10;

  const tracks = () => mix?.tracks ?? [];
  const lengthOf = (t) => sounds.get(t.clip)?.seconds ?? 0;
  const end = () => tracks().reduce((m, t) => Math.max(m, (t.at ?? 0) + lengthOf(t)), 0);
  const fit = () => (span = Math.max(5, Math.ceil(end() * 1.15)));
  const nameOf = (id) => clips.find((c) => c.id === id)?.name ?? "A clip that's gone";

  /** A clip's samples, by record: from its record, or for a long one from where the editor kept it. */
  const sound = async (id) => {
    if (sounds.has(id)) return sounds.get(id);
    const record = clips.find((c) => c.id === id);
    if (!record) return null;
    let clip = record.pcm ? { rate: record.rate, pcm: record.pcm, channels: record.channels } : null;
    if (!clip && record.kept) {
      const owner = record.keptBy ?? "sound-editor";
      clip = await ctx.call("audio", "load", { name: record.kept, ...(owner === manifest.id ? {} : { of: owner }) }).catch(() => null);
    }
    if (!clip?.pcm) return null;
    const channels = clip.channels === 2 ? 2 : 1;
    const bytes = Uint8Array.from(atob(clip.pcm), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const frames = Math.floor(bytes.length / 2 / channels);
    // The loudest sample in each of PEAKS stretches, either side: enough to see a clip's shape in its lane.
    const peaks = new Float32Array(PEAKS);
    const per = Math.max(1, frames / PEAKS);
    for (let p = 0; p < PEAKS; p++)
      for (let f = Math.floor(p * per), stop = Math.min(frames, Math.floor((p + 1) * per)); f < stop; f++)
        for (let c = 0; c < channels; c++) peaks[p] = Math.max(peaks[p], Math.abs(view.getInt16((f * channels + c) * 2, true) / 32768));
    const out = { rate: clip.rate, pcm: clip.pcm, channels, seconds: frames / clip.rate, peaks };
    sounds.set(id, out);
    return out;
  };

  const refresh = async () => {
    clips = (await ctx.call("data", "list", "sound-clips").catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
    mixes = (await ctx.call("data", "list", "sound-mixes")).sort((a, b) => a.name.localeCompare(b.name));
    if (mix) mix = mixes.find((m) => m.id === mix.id) ?? null;
    for (const t of tracks()) await sound(t.clip);
  };

  const draw = () => {
    const list = tracks();
    const data = {
      has: !!mix,
      name: mix?.name ?? "",
      mixes: mixes.map((m) => ({ id: m.id, name: m.name, current: m.id === mix?.id })),
      noMixes: !mixes.length,
      clips: clips.map((c) => ({ id: c.id, name: c.name })),
      noClips: !clips.length,
      full: list.length >= MOST,
      tracks: list.map((t, i) => ({
        key: t.key,
        n: i % COLOURS.length,
        name: nameOf(t.clip),
        at: (t.at ?? 0).toFixed(2),
        gain: t.gain ?? 1,
        gainShown: `${Math.round((t.gain ?? 1) * 100)}%`,
        pan: t.pan ?? 0,
        panShown: (t.pan ?? 0) === 0 ? "centre" : `${Math.round(Math.abs(t.pan) * 100)}% ${t.pan < 0 ? "left" : "right"}`,
        mute: !!t.mute,
        missing: !sounds.has(t.clip),
        seconds: lengthOf(t).toFixed(1),
      })),
      empty: !!mix && !list.length,
      length: end().toFixed(2),
      playing: !!playing,
      noTracks: !list.some((t) => !t.mute && sounds.has(t.clip)),
      status,
    };
    // Above the canvas, the mix to work on and what to add; below it, each track's controls.
    views.render("main", "timeline-head", data, { order: 2000 });
    views.render("main", "timeline-tracks", data, { order: 2002 });
    paint();
  };

  /** The canvas: a ruler of seconds, a lane for each track, each clip where it starts, and the playhead. */
  function paint() {
    if (!canvas) return;
    const g = canvas.getContext("2d");
    const colors = theme?.colors ?? {};
    const list = tracks();
    g.clearRect(0, 0, W, H);
    g.fillStyle = colors["bg-2"] ?? "#f4f4f6";
    g.fillRect(0, 0, W, H);
    const px = W / span;
    // Seconds along the top: every second, or every five on a long mix.
    const step = span > 60 ? 10 : span > 20 ? 5 : 1;
    g.font = `12px ${theme?.font ?? "system-ui, sans-serif"}`;
    g.textAlign = "left";
    for (let s = 0; s <= span; s += step) {
      g.fillStyle = colors.border ?? "#ccc";
      g.fillRect(Math.round(s * px), RULER - 6, 1, H - RULER + 6);
      g.fillStyle = colors["fg-2"] ?? "#666";
      g.fillText(`${s}s`, Math.round(s * px) + 3, 14);
    }
    const lane = (H - RULER) / Math.max(list.length, 3);
    list.forEach((t, i) => {
      const top = RULER + i * lane + 3;
      const height = lane - 6;
      const s = sounds.get(t.clip);
      const x = (t.at ?? 0) * px;
      const w = Math.max(4, (s?.seconds ?? 1) * px);
      const colour = COLOURS[i % COLOURS.length];
      g.globalAlpha = t.mute ? 0.3 : 1;
      g.fillStyle = `${colour}40`;
      g.fillRect(x, top, w, height);
      g.strokeStyle = colour;
      g.lineWidth = drag?.key === t.key ? 3 : 1.5;
      g.strokeRect(x, top, w, height);
      if (s) {
        // Its waveform, taller as the track is louder.
        g.fillStyle = colour;
        const mid = top + height / 2;
        const level = Math.min(1, (t.gain ?? 1) / 1.5);
        for (let p = 0; p < PEAKS; p++) {
          const v = s.peaks[p] * level * (height / 2 - 4);
          g.fillRect(x + (p / PEAKS) * w, mid - v, Math.max(1, w / PEAKS), Math.max(1, v * 2));
        }
      }
      g.fillStyle = colors.fg ?? "#111";
      g.fillText(`${nameOf(t.clip)}${t.mute ? " (muted)" : ""}`, x + 6, top + 14);
      g.globalAlpha = 1;
    });
    if (!list.length) {
      g.fillStyle = colors["fg-2"] ?? "#666";
      g.textAlign = "center";
      g.font = `15px ${theme?.font ?? "system-ui, sans-serif"}`;
      g.fillText(mix ? "Add a clip to make the first track" : "Make a mix to lay clips side by side", W / 2, H / 2);
    }
    if (playing) {
      const t = (Date.now() - playing.at) / 1000;
      if (t >= 0 && t <= playing.seconds) {
        g.fillStyle = colors.accent ?? "#7c3aed";
        g.fillRect(Math.round(t * px), RULER - 6, 2, H - RULER + 6);
      }
      requestAnimationFrame(paint);
    }
  }

  /** Keeps the mix as it is now. The rendered sound is stale once the tracks change. */
  const save = async () => {
    rendered = null;
    const result = await ctx.call("data", "put", "sound-mixes", mix);
    if (result?.ok) mix.id = result.id;
  };
  const track = (key) => tracks().find((t) => t.key === key);
  const change = async (key, fields, note) => {
    const t = track(key);
    if (!t) return;
    Object.assign(t, fields);
    await save();
    status = note ?? "";
    draw();
  };

  /** The tracks as the audio service mixes them: the muted ones and the ones whose sound is gone left out. */
  const mixed = async () => {
    const live = tracks().filter((t) => !t.mute && sounds.has(t.clip));
    if (!live.length) return null;
    const recipe = JSON.stringify(live.map((t) => [t.clip, t.at, t.gain, t.pan]));
    if (rendered?.recipe === recipe) return rendered.clip;
    const clip = await ctx.call("audio", "mix", {
      rate: sounds.get(live[0].clip).rate,
      tracks: live.map((t) => {
        const s = sounds.get(t.clip);
        return { clip: { rate: s.rate, pcm: s.pcm, ...(s.channels === 2 ? { channels: 2 } : {}) }, at: t.at ?? 0, gain: t.gain ?? 1, pan: t.pan ?? 0 };
      }),
    });
    rendered = { recipe, clip };
    return clip;
  };

  const play = async () => {
    await stop();
    status = "Mixing…";
    draw();
    const clip = await mixed().catch((error) => ((status = String(error.message ?? error)), null));
    if (!clip) return draw();
    const { at, ms } = await ctx.call("audio", "playClip", { clip, group: "mix" });
    playing = { at, seconds: ms / 1000 };
    stopTimer = setTimeout(() => {
      playing = null;
      draw();
    }, ms + Math.max(0, at - Date.now()) + 50);
    status = "Playing the mix";
    draw();
    return status;
  };
  async function stop() {
    clearTimeout(stopTimer);
    if (!playing) return;
    playing = null;
    await ctx.call("audio", "stop", { group: "mix" }).catch(() => {});
    status = "";
    draw();
  }

  /** The mix as a new clip in the editor's collection: the person allows the write on a review card. */
  const bounce = async () => {
    const clip = await mixed();
    if (!clip) return (status = "Nothing to mix: add a track, or unmute one"), draw(), status;
    const seconds = Math.round((clip.pcm.length * 0.75) / 2 / (clip.channels === 2 ? 2 : 1) / clip.rate * 100) / 100;
    const record = { name: mix.name, rate: clip.rate, seconds, ...(clip.channels === 2 ? { channels: 2 } : {}) };
    if (clip.pcm.length > INLINE) {
      // Too long for a record: kept by the audio service under this plugin's name, which the record says (keptBy).
      const kept = `mix-${Date.now().toString(36)}`;
      await ctx.call("audio", "keep", { name: kept, clip });
      Object.assign(record, { kept, keptBy: manifest.id });
    } else record.pcm = clip.pcm;
    status = `Asking to keep ${mix.name} as a clip…`;
    draw();
    const result = await ctx.call("data", "put", "sound-clips", record, `Keep the mix "${mix.name}" as a clip, to edit in the sound editor`).catch((error) => ({ ok: false, errors: [String(error.message ?? error)] }));
    status = result?.ok ? `Kept ${mix.name} as a clip (${seconds.toFixed(1)} s)` : `Not kept: ${result?.errors?.join?.(", ") ?? "the write was declined"}`;
    await refresh();
    draw();
    return status;
  };

  const add = async (clipId, at) => {
    if (!mix) return "Make a mix first";
    if (tracks().length >= MOST) return (status = `A mix has at most ${MOST} tracks`), draw(), status;
    if (!clips.some((c) => c.id === clipId)) return (status = "Pick a clip to add"), draw(), status;
    const s = await sound(clipId);
    mix.tracks = [...tracks(), { key: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, clip: clipId, at: Math.max(0, Number(at) || 0), gain: 1, pan: 0 }];
    fit();
    await save();
    status = s ? `Added ${nameOf(clipId)}` : `${nameOf(clipId)}'s sound isn't in this browser`;
    draw();
    return status;
  };

  const create = async () => {
    await stop();
    mix = { name: `Mix ${mixes.length + 1}`, tracks: [] };
    await save();
    await refresh();
    fit();
    status = `Made ${mix.name}`;
    draw();
  };

  let queue = Promise.resolve();
  const serial = (work) => (queue = queue.then(work, work));

  ctx.ui.onEvent((action, value) => {
    if (action === "canvas:pointer") return pointer(value);
    return serial(() => handle(action, value));
  });
  async function handle(action, value) {
    if (action === "mix:new") return create();
    if (action === "open-mix") {
      await stop();
      mix = mixes.find((m) => m.id === value) ?? null;
      for (const t of tracks()) await sound(t.clip);
      fit();
      status = "";
      return draw();
    }
    if (action === "rename-mix") {
      if (!mix || !String(value?.name ?? "").trim()) return;
      mix.name = String(value.name).trim().slice(0, 80);
      await save();
      await refresh();
      return draw();
    }
    if (action === "add-track") return add(value?.clip, value?.at);
    if (action === "play-mix") return playing ? stop() : play();
    if (action === "bounce") return bounce();
    const [verb, key, more] = action.split(":");
    const t = track(key);
    if (!t) return;
    if (verb === "track-at") return change(key, { at: Math.max(0, Math.round((Number(value) || 0) * 100) / 100) }, `Moved ${nameOf(t.clip)}`).then(fit).then(draw);
    if (verb === "nudge") return change(key, { at: Math.max(0, Math.round(((t.at ?? 0) + (more === "back" ? -0.25 : 0.25)) * 100) / 100) }, `Moved ${nameOf(t.clip)}`).then(fit).then(draw);
    if (verb === "track-gain") return change(key, { gain: Math.min(2, Math.max(0, Number(value) || 0)) });
    if (verb === "track-pan") return change(key, { pan: Math.min(1, Math.max(-1, Number(value) || 0)) });
    if (verb === "track-mute") return change(key, { mute: !t.mute }, `${nameOf(t.clip)} ${t.mute ? "back in" : "muted"}`);
    if (verb === "track-remove") {
      mix.tracks = tracks().filter((x) => x.key !== key);
      await save();
      status = `Took ${nameOf(t.clip)} out`;
      fit();
      return draw();
    }
  }

  /** A drag on the canvas: the track under the finger follows it along its lane. */
  function pointer({ type, x, y } = {}) {
    const list = tracks();
    if (!list.length) return;
    const px = W / span;
    if (type === "down") {
      const lane = (H - RULER) / Math.max(list.length, 3);
      const t = list[Math.floor((y - RULER) / lane)];
      if (!t) return;
      drag = { key: t.key, x, at: t.at ?? 0 };
      return paint();
    }
    if (!drag) return;
    const t = track(drag.key);
    if (!t) return void (drag = null);
    t.at = Math.max(0, Math.round((drag.at + (x - drag.x) / px) * 100) / 100);
    if (type === "move") return paint();
    // Let go: the new place is kept.
    drag = null;
    void serial(async () => {
      await save();
      status = `Moved ${nameOf(t.clip)} to ${t.at.toFixed(2)} s`;
      fit();
      draw();
    });
  }

  ctx.ui.onCanvas("timeline-tracks", (offscreen, t) => {
    canvas = offscreen;
    theme = t;
    paint();
  });
  ctx.ui.onTheme((t) => {
    theme = t;
    paint();
  });

  // For the palette and for agents: each thing the controls do.
  const byName = (name) => tracks().find((t) => nameOf(t.clip).toLowerCase() === String(name ?? "").toLowerCase()) ?? track(name);
  ctx.commands.add({ id: "play-mix", title: "Play or stop the mix", group: "Timeline" }, () => serial(() => (playing ? stop().then(() => "Stopped") : play())));
  ctx.commands.add({ id: "keep-mix", title: "Keep the mix as a clip", group: "Timeline" }, () => serial(bounce));
  ctx.commands.add(
    { id: "add-track", title: "Add a clip to the mix", group: "Timeline", args: { type: "object", properties: { clip: { type: "string", description: "The clip's name" }, at: { type: "number", description: "Where it starts, in seconds" } }, required: ["clip"] } },
    ({ clip, at }) => serial(() => add(clips.find((c) => c.name.toLowerCase() === String(clip).toLowerCase())?.id ?? clip, at)),
  );
  ctx.commands.add(
    { id: "move-track", title: "Move a track", group: "Timeline", args: { type: "object", properties: { track: { type: "string", description: "The track's clip name" }, at: { type: "number", description: "Where it starts, in seconds" } }, required: ["track", "at"] } },
    ({ track: name, at }) => serial(async () => {
      const t = byName(name);
      if (!t) return `No track ${name}`;
      await handle(`track-at:${t.key}`, at);
      return status;
    }),
  );
  ctx.commands.add(
    { id: "level-track", title: "Set a track's level", group: "Timeline", args: { type: "object", properties: { track: { type: "string", description: "The track's clip name" }, gain: { type: "number", description: "0 is silent, 1 as it is, 2 twice as loud" } }, required: ["track", "gain"] } },
    ({ track: name, gain }) => serial(async () => {
      const t = byName(name);
      if (!t) return `No track ${name}`;
      await handle(`track-gain:${t.key}`, gain);
      return `${nameOf(t.clip)} at ${Math.round(t.gain * 100)}%`;
    }),
  );

  // Clips change in the editor: a new one is offered, and a track whose clip changed sounds as it does now.
  ctx.on("data:changed:sound-clips", (change) => serial(async () => {
    if (change?.id) sounds.delete(change.id);
    rendered = null;
    await refresh();
    draw();
  }));

  ctx.ui.render("main", "timeline-canvas", { type: "canvas", id: "timeline-tracks", width: W, height: H, pointer: true }, 2001);
  await refresh();
  mix = mixes[0] ?? null;
  for (const t of tracks()) await sound(t.clip);
  fit();
  draw();
}
