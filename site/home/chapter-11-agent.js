// Chapter 11, let an agent change the page. Its words are in
// chapter-11-agent.html. The builder agent (/std/agents/builder.agent.md)
// and the chat box (/std/agents/chat.js) that writes to it draw just below.
//
// The builder needs a language model, so it needs your key. Without one,
// this chapter plays a recorded run of the builder: what it was asked, each
// tool it called and what came back, at about the speed it happened. No
// model is asked during the replay. Its last step is real, though: the code
// the builder wrote goes to the same `authoring.save` it called, so you get
// the same review card, and accepting it puts Reading time on the page as
// one of your own plugins, which the switchboard, view source and the
// plugin editor all treat like any other.

export const manifest = {
  id: "chapter-11-agent",
  name: "Chapter 11: Let an agent change the page",
  description: "Explains how an agent writes a plugin for the page, with a recorded run you can replay without a key.",
  version: "1.0.0",
  permissions: ["ui", "plugins:author"],
  // authoring.save asks the tab it came from, and each tab plays its own replay.
  scope: "tab",
};

/** The plugin the recorded builder wrote, saved as it wrote it. */
const CODE = `// Reading time: how long your learning notes take to read aloud.
export const manifest = {
  id: "reading-time",
  name: "Reading time",
  description: "Shows how long your learning notes would take to read aloud.",
  version: "1.0.0",
  permissions: ["ui", "data:read:learning"],
};

const WORDS_A_MINUTE = 150;

export default function (ctx) {
  ctx.ui.live("playground", "reading-time", async (ctx) => {
    const notes = await ctx.call("data", "list", "learning");
    const words = notes.reduce((n, note) => n + (note.text.match(/[\\p{L}\\p{N}’']+/gu) ?? []).length, 0);
    const minutes = Math.max(1, Math.round(words / WORDS_A_MINUTE));
    return ctx.ui.html\`<ui-stat label="Read aloud" value="\${words ? minutes + " min" : "–"}"></ui-stat>\`;
  }, 15);
}
`;

/**
 * The recorded run, step by step: who spoke, what they called or said, and what came back. `wait` is
 * roughly how long the step took (milliseconds), shortened so the replay doesn't drag.
 */
const RUN = [
  { who: "You", text: "Show how long my notes would take to read aloud.", wait: 400 },
  { who: "Builder", call: "authoring_mine()", answer: "[] (you have no plugins of your own here yet)", wait: 900 },
  { who: "Builder", call: 'authoring_source("learning-notes")', answer: "Learning notes owns the `learning` collection. Each note is { text }, up to 2000 characters. It draws in the `playground` slot.", wait: 1200 },
  { who: "Builder", text: "I'll write a plugin that reads your notes, counts their words, and shows the minutes at 150 words a minute, beside Note stats.", wait: 1500 },
  { who: "Builder", call: "authoring_check(code)", answer: "ok. Reading time (reading-time) may: ui, draw in the page; data:read:learning, read your Learning notes, and hear when they change.", wait: 1100 },
  { who: "Builder", call: "authoring_save(code)", answer: "", wait: 600, real: true },
];

export default function (ctx) {
  const views = ctx.ui.views("chapter-11-agent.html");
  /** How far the replay has got, and how the last step went. */
  let shown = 0;
  let playing = false;
  let outcome = "";
  let tone = "";
  /** Counts replays, so a step from a replay that was started again is dropped. */
  let run = 0;

  const draw = () =>
    views.render("agent", "chapter", {
      steps: RUN.slice(0, shown).map((s, i) => ({ ...s, n: i + 1, last: s.real && !outcome, said: !!s.text, called: !!s.call })),
      started: shown > 0,
      playing,
      idle: !playing,
      code: CODE,
      outcome,
      tone,
      done: !!outcome,
    }, { order: 1 });

  const pause = (ms) => new Promise((done) => setTimeout(done, ms));

  const replay = async () => {
    const mine = ++run;
    playing = true;
    shown = 0;
    outcome = tone = "";
    draw();
    for (const step of RUN) {
      await pause(step.wait);
      if (mine !== run) return;
      shown++;
      draw();
    }
    // The real part: the code goes for review, exactly as the builder's save did.
    const saved = await ctx.call("authoring", "save", CODE).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    if (mine !== run) return;
    playing = false;
    outcome = saved.ok
      ? "You accepted it. Reading time is on the page now, under your notes, as one of your own plugins: find it on the switchboard, or read it in view source."
      : `It wasn't saved: ${saved.error ?? "you declined it"}. Nothing changed.`;
    tone = saved.ok ? "ok" : "warn";
    draw();
  };

  draw();
  ctx.ui.onEvent((action) => {
    if (action === "replay" && !playing) void replay();
  });
}
