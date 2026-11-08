// Sequencer: a sixteen-step drum machine. It owns the patterns, draws the
// pads and plays them. Every sound is synthesised in an AudioWorklet (the
// VOICES source below), which the audio service runs on the page's audio
// thread; this plugin only says "play a kick now".
//
// The clock runs here, in the plugin's worker. A little before each step it
// asks the audio service to play that step's hits `at` the step's time, so
// they land on the audio clock's exact sample however long the message took.
// On the step it draws the grid again with the playing column lit, eight
// times a second at 120 bpm. That redraw is the
// stress test: the host morphs only the cells whose attributes changed.
//
// It writes what is playing to a record of its own, `transport/now`
// ({ playing, pattern, bpm, startedAt }), so other plugins can keep time
// with it without being told each step: ripples.js draws in time from that
// record alone.
//
// Other plugins change a pattern through its commands, not its data:
// `sequencer/set-track` runs with this plugin's own rights, so euclid.js
// needs only the `commands` permission, and nobody reviews each pad.
//
// It is shared, not per tab, so two tabs hear one clock, not two.

export const manifest = {
  id: "sequencer",
  name: "Sequencer",
  description: "Sixteen steps, six voices: the pads, the clock and the sound.",
  version: "1.0.0",
  permissions: ["ui", "audio"],
  order: 10,
  collections: {
    patterns: {
      title: "Patterns",
      schema: {
        type: "object",
        required: ["name", "bpm", "tracks"],
        properties: {
          name: { type: "string", title: "Name", maxLength: 40 },
          bpm: { type: "integer", title: "Tempo", minimum: 60, maximum: 180 },
          swing: { type: "integer", title: "Swing", minimum: 0, maximum: 60 },
          tracks: {
            type: "object",
            title: "Steps",
            properties: {
              kick: { type: "string", maxLength: 16 },
              snare: { type: "string", maxLength: 16 },
              clap: { type: "string", maxLength: 16 },
              hat: { type: "string", maxLength: 16 },
              bass: { type: "string", maxLength: 16 },
              bell: { type: "string", maxLength: 16 },
            },
          },
        },
      },
    },
    transport: {
      title: "What's playing",
      schema: {
        type: "object",
        properties: {
          playing: { type: "boolean" },
          pattern: { type: "string" },
          bpm: { type: "integer" },
          swing: { type: "integer" },
          startedAt: { type: "number" },
        },
      },
    },
  },
};

const VOICES = `
const TAU = Math.PI * 2;
registerProcessor("beat-voice", class extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.voice = o.voice || "kick";
    this.freq = o.freq || 220;
    this.gain = o.gain ?? 0.8;
    // When to begin, on the audio clock (seconds): the audio service passes it, so the hit lands on its sample.
    this.start = o.start || 0;
    this.t = 0;
    this.phase = 0;
    this.phase2 = 0;
    this.lp = 0;
    this.prev = 0;
    this.length = { kick: 0.5, snare: 0.25, clap: 0.3, hat: 0.07, bass: 0.45, bell: 1.2 }[this.voice] || 0.4;
  }
  sample(dt) {
    const t = this.t;
    const noise = Math.random() * 2 - 1;
    switch (this.voice) {
      case "kick": {
        const f = 45 + 110 * Math.exp(-t * 28);
        this.phase += TAU * f * dt;
        return Math.sin(this.phase) * Math.exp(-t * 7) * 1.1;
      }
      case "snare": {
        this.phase += TAU * 185 * dt;
        return (Math.sin(this.phase) * Math.exp(-t * 30) * 0.5) + noise * Math.exp(-t * 16) * 0.55;
      }
      case "clap": {
        const burst = t < 0.03 ? (Math.floor(t / 0.01) % 2 === 0 ? 1 : 0.2) : Math.exp(-(t - 0.03) * 14);
        this.lp += (noise - this.lp) * 0.35;
        return (noise - this.lp) * burst * 0.8;
      }
      case "hat": {
        const hp = noise - this.prev;
        this.prev = noise;
        return hp * Math.exp(-t * 60) * 0.35;
      }
      case "bass": {
        this.phase += this.freq * dt;
        const saw = 2 * (this.phase % 1) - 1;
        this.lp += (saw - this.lp) * (0.04 + 0.25 * Math.exp(-t * 12));
        return this.lp * Math.exp(-t * 4) * 1.4;
      }
      case "bell": {
        this.phase += TAU * this.freq * dt;
        this.phase2 += TAU * this.freq * 2.76 * dt;
        return (Math.sin(this.phase) * 0.6 + Math.sin(this.phase2) * 0.25 * Math.exp(-t * 6)) * Math.exp(-t * 3.2) * 0.45;
      }
    }
    return 0;
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const dt = 1 / sampleRate;
    const n = out[0].length;
    for (let i = 0; i < n; i++) {
      if (currentTime + i * dt < this.start) {
        for (const channel of out) channel[i] = 0;
        continue;
      }
      const s = this.t < this.length ? this.sample(dt) * this.gain : 0;
      for (const channel of out) channel[i] = s;
      this.t += dt;
    }
    return this.t < this.length + 0.05;
  }
});
`;

/** The six voices, top to bottom, with what each row is called. */
export const TRACKS = [
  { id: "kick", name: "Kick", glyph: "●" },
  { id: "snare", name: "Snare", glyph: "◆" },
  { id: "clap", name: "Clap", glyph: "✦" },
  { id: "hat", name: "Hat", glyph: "▲" },
  { id: "bass", name: "Bass", glyph: "◢" },
  { id: "bell", name: "Bell", glyph: "◯" },
];
const STEPS = 16;
const EMPTY = ".".repeat(STEPS);
// The melodic rows pick their note from the step, in A minor pentatonic, so any pattern of pads makes a tune.
const BELL = [880, 1046.5, 1174.7, 1318.5, 1568, 1318.5, 1174.7, 1046.5];
const BASS = [55, 55, 65.4, 73.4, 55, 82.4, 73.4, 65.4];

const SAMPLE = [
  { id: "pattern-floor", name: "Four on the floor", bpm: 124, swing: 0, tracks: { kick: "x...x...x...x...", snare: "....x.......x...", clap: "............x...", hat: "..x...x...x...xx", bass: "x..x..x...x..x..", bell: "x.......x...x..." } },
  { id: "pattern-boombap", name: "Boom bap", bpm: 90, swing: 30, tracks: { kick: "x.....x...x.....", snare: "....x.......x...", clap: "................", hat: "x.x.x.x.x.x.x.x.", bass: "x.....x...x..x..", bell: "......x.......x." } },
  { id: "pattern-lofi", name: "Rainy lo-fi", bpm: 78, swing: 45, tracks: { kick: "x......x..x.....", snare: "....x.......x...", clap: "...............x", hat: "x.xxx.x.x.xxx.x.", bass: "x......x..x.....", bell: "x...x.x...x...x." } },
  { id: "pattern-break", name: "Breakbeat", bpm: 132, swing: 10, tracks: { kick: "x.x.......x.....", snare: "....x..x.x..x..x", clap: "....x.......x...", hat: "xxxxxxxxxxxxxxxx", bass: "x.x.......xx....", bell: "................" } },
];

/** A pattern's row for a track, always sixteen steps of "x" or ".". */
const row = (pattern, track) => (pattern?.tracks?.[track] ?? EMPTY).padEnd(STEPS, ".").slice(0, STEPS);

export default async function (ctx) {
  const views = ctx.ui.views("sequencer.html");
  await ctx.call("audio", "registerProcessor", "beat-voice", VOICES);

  if (!(await ctx.storage.get("seeded"))) {
    if (!(await ctx.call("data", "list", "patterns")).length) for (const p of SAMPLE) await ctx.call("data", "put", "patterns", p);
    await ctx.storage.set("seeded", true);
  }

  // The plugin's state. `step` is the playing column, or -1 when stopped.
  let patterns = [];
  let current = (await ctx.storage.get("pattern")) || SAMPLE[0].id;
  let muted = new Set((await ctx.storage.get("muted")) || []);
  let playing = false;
  let step = -1;
  let startedAt = 0;
  let timer = null;
  let last = -1; // the count of the last step sent since startedAt (it sounds up to AHEAD ms later)
  let lastDue = 0; // when that step sounds (ms since the epoch)
  const lights = new Set(); // timers that light a sent step's column when it sounds
  let hits = 0;

  const load = async () => {
    patterns = (await ctx.call("data", "list", "patterns")).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!patterns.some((p) => p.id === current)) current = patterns[0]?.id;
  };
  const pattern = () => patterns.find((p) => p.id === current);

  const draw = () => {
    const p = pattern();
    if (!p) return views.render("main", "pads", { empty: true });
    views.render("main", "pads", {
      name: p.name,
      bpm: p.bpm,
      swing: p.swing ?? 0,
      // aria-pressed wants the words "true" and "false"; a whole-hole true would leave it empty.
      pressed: String(playing),
      playing,
      step: step + 1,
      patterns: patterns.map((x) => ({ id: x.id, name: x.name, pressed: String(x.id === current) })),
      steps: Array.from({ length: STEPS }, (_, i) => ({ n: i + 1, now: i === step, beat: i % 4 === 0 })),
      tracks: TRACKS.map((t) => {
        const cells = row(p, t.id);
        return {
          ...t,
          muted: muted.has(t.id),
          pressed: String(muted.has(t.id)),
          count: [...cells].filter((c) => c === "x").length,
          cells: [...cells].map((c, i) => ({ i, n: i + 1, on: c === "x", now: i === step, beat: i % 4 === 0, hit: i === step && c === "x" })),
        };
      }),
    });
  };

  /** Writes the shared clock, so other plugins keep time. */
  const announce = () => {
    const p = pattern();
    return ctx.call("data", "put", "transport", { id: "now", playing, pattern: current, bpm: p?.bpm ?? 120, swing: p?.swing ?? 0, startedAt });
  };

  /** How long a sixteenth lasts at the pattern's tempo, in ms. */
  const sixteenth = () => 60_000 / (pattern()?.bpm ?? 120) / 4;

  /** How far ahead (ms) each step's hits are sent, so they reach the audio thread before they are due. */
  const AHEAD = 100;

  /** Sends step `i`'s hits to play at `due` on the audio clock, and lights its column when it comes. */
  const tick = (i, due) => {
    const p = pattern();
    for (const t of TRACKS) {
      if (muted.has(t.id) || row(p, t.id)[i] !== "x") continue;
      const freq = t.id === "bell" ? BELL[i % 8] : t.id === "bass" ? BASS[i % 8] : undefined;
      // In the "transport" group, so Stop can take back hits that haven't sounded yet.
      ctx.call("audio", "play", { processor: "beat-voice", ms: 1300, at: due, group: "transport", options: { voice: t.id, freq } }).catch(() => {});
      hits++;
    }
    const light = setTimeout(() => {
      lights.delete(light);
      step = i;
      draw();
    }, Math.max(0, due - Date.now()));
    lights.add(light);
  };

  /**
   * The clock. Each step is scheduled from when playing started, not from the
   * last step, so lateness doesn't add up. Swing delays every other sixteenth.
   */
  const schedule = (n) => {
    const len = sixteenth();
    const swing = ((pattern()?.swing ?? 0) / 100) * len * 0.5;
    const due = startedAt + n * len + (n % 2 ? swing : 0);
    timer = setTimeout(() => {
      if (!playing) return;
      last = n;
      lastDue = due;
      tick(n % STEPS, due);
      schedule(n + 1);
    }, Math.max(0, due - AHEAD - Date.now()));
  };

  const play = async () => {
    if (playing) return;
    playing = true;
    startedAt = Date.now() + AHEAD;
    last = -1;
    schedule(0);
    await announce();
  };
  const stop = async () => {
    playing = false;
    clearTimeout(timer);
    // Hits and columns already sent but not yet due are taken back; a sound already playing rings out.
    for (const light of lights) clearTimeout(light);
    lights.clear();
    ctx.call("audio", "cancel", { group: "transport" }).catch(() => {});
    step = -1;
    draw();
    await announce();
  };

  /**
   * When the tempo changes while playing (the slider, a command, another
   * pattern), keeps the arm where it is in the bar, and the clock other
   * plugins read in step with what is heard. Steps already sent keep their
   * time. If the last one has sounded, the time already into it carries
   * over at the new length; if it hasn't, the new tempo starts from it.
   * The next step is scheduled from there. Then tells other plugins.
   */
  const retime = (before) => {
    const len = sixteenth();
    if (!playing || before === len) return;
    const now = Date.now();
    if (last < 0) startedAt = now + AHEAD; // nothing sent yet
    else if (now < lastDue) {
      // Sent but not yet heard: that step is where the new tempo starts.
      const swing = ((pattern()?.swing ?? 0) / 100) * before * 0.5;
      startedAt = lastDue - (last % 2 ? swing : 0) - last * len;
    } else {
      const pos = Math.min(Math.max((now - startedAt) / before, last), last + 0.999);
      startedAt = now - pos * len;
    }
    clearTimeout(timer);
    schedule(last + 1);
    return announce();
  };

  // Writes go one at a time, each built on the pattern as the last one left it, so quick taps on the
  // pads can't race. Reloads after a change wait their turn too.
  let queue = Promise.resolve();
  const serial = (job) => (queue = queue.then(job, job));

  /** Saves the open pattern with `change` (or `change(pattern)`) applied. */
  const save = (change) =>
    serial(async () => {
      const p = pattern();
      if (!p) return;
      const c = typeof change === "function" ? change(p) : change;
      const { createdAt, updatedAt, ...rest } = p;
      const next = { ...rest, ...c, tracks: { ...p.tracks, ...(c.tracks ?? {}) } };
      const before = sixteenth();
      // Show it at once; the write comes back as data:changed.
      patterns = patterns.map((x) => (x.id === p.id ? { ...x, ...next } : x));
      await retime(before);
      const tried = sixteenth();
      draw();
      const result = await ctx.call("data", "put", "patterns", next);
      if (result?.ok === false) {
        // Refused: show what is really saved, and say why in the log.
        ctx.log(`pattern not saved: ${(result.errors ?? []).map((e) => e.message).join("; ")}`);
        await load();
        await retime(tried);
        draw();
      }
    });

  const setCell = (track, i, on) =>
    save((p) => {
      const cells = [...row(p, track)];
      cells[i] = on ? "x" : ".";
      return { tracks: { [track]: cells.join("") } };
    });

  ctx.on("data:changed:patterns", () =>
    serial(async () => {
      const before = sixteenth();
      await load();
      await retime(before);
      draw();
    }),
  );

  ctx.ui.onEvent(async (action, value) => {
    const [verb, a, b] = action.split(":");
    if (verb === "toggle") return playing ? stop() : play();
    if (verb === "pad") return setCell(a, Number(b), value);
    if (verb === "mute") {
      muted.has(a) ? muted.delete(a) : muted.add(a);
      await ctx.storage.set("muted", [...muted]);
      return draw();
    }
    if (verb === "bpm" || verb === "swing") {
      await save({ [verb]: Math.round(value) });
      return announce();
    }
    if (verb === "pattern") {
      const before = sixteenth();
      current = value ?? a;
      await ctx.storage.set("pattern", current);
      await retime(before);
      draw();
      return announce();
    }
    if (verb === "clear") return save({ tracks: Object.fromEntries(TRACKS.map((t) => [t.id, EMPTY])) });
    if (verb === "copy") {
      const p = pattern();
      const { id: _id, createdAt, updatedAt, ...rest } = p;
      const { id } = await ctx.call("data", "put", "patterns", { ...rest, name: `${p.name} (copy)`.slice(0, 40) });
      current = id;
      await ctx.storage.set("pattern", current);
      await serial(load);
      draw();
      return announce();
    }
  });

  // What the drum machine does, as commands: the palette lists them, Space plays, and agents and other plugins can use them.
  ctx.commands.add({ id: "play", title: "Play or stop", group: "Transport", keys: ["Space"] }, async () => {
    await (playing ? stop() : play());
    return playing ? "Playing" : "Stopped";
  });
  ctx.commands.add({ id: "faster", title: "Tempo up 5 bpm", group: "Transport", keys: ["Alt+ArrowUp"] }, async () => {
    await save((p) => ({ bpm: Math.min(180, (p.bpm ?? 120) + 5) }));
    await announce();
    return `${pattern()?.bpm} bpm`;
  });
  ctx.commands.add({ id: "slower", title: "Tempo down 5 bpm", group: "Transport", keys: ["Alt+ArrowDown"] }, async () => {
    await save((p) => ({ bpm: Math.max(60, (p.bpm ?? 120) - 5) }));
    await announce();
    return `${pattern()?.bpm} bpm`;
  });
  ctx.commands.add(
    {
      id: "set-track",
      title: "Set a row of the pattern",
      description: "Sets one voice's sixteen steps in the open pattern: a string of 'x' (hit) and '.' (rest).",
      group: "Pattern",
      args: { type: "object", required: ["track", "steps"], properties: { track: { type: "string", enum: TRACKS.map((t) => t.id) }, steps: { type: "string", maxLength: 16 } } },
    },
    async ({ track, steps }) => {
      await save({ tracks: { [track]: steps.replace(/[^x]/g, ".").padEnd(STEPS, ".") } });
      return `Set the ${track} row`;
    },
  );

  await load();
  draw();
  // Nothing is playing when the app opens, whatever the last session left in the record.
  await announce();
  setInterval(() => hits && ctx.log(`hits played: ${hits}`), 5000);
}
