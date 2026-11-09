// The app maker builds on the game and the sound editor without changing
// either. On /new/, the person asks for Glowfall with a magnet that pulls the
// fireflies to the jar, and for the sound editor with a robot voice. The app
// maker (a scripted model stands in for theirs) writes two small apps: each
// links the engine's own plugins from /demos/ as they are, and adds one
// plugin of its own, a game system (on game:update) and an audio effect (an
// AudioWorklet processor offered through sound-editor:effects). Then each app
// runs: the magnet moves fireflies in the running game, and the robot effect
// changes a clip.

/** The scripted model. Sent as a plugin's source, so everything it needs is inside it. */
function model(ctx) {
  const page = (title, plugins, body) =>
    [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1">',
      `  <title>${title}</title>`,
      '  <link rel="stylesheet" href="/platform/host.css">',
      '  <script type="module" src="/platform/host.js"></script>',
      ...plugins.map((href) => `  <link rel="plugin" href="${href}">`),
      "</head>",
      `<body>${body}</body>`,
      "</html>",
    ].join("\n");

  // A game system: it pulls each firefly towards the jar's lane as it falls.
  const magnet = [
    "export const manifest = {",
    '  id: "glowfall-magnet",',
    '  name: "Magnet",',
    '  description: "Pulls the fireflies towards the jar as they fall.",',
    '  version: "1.0.0",',
    '  permissions: ["hook:intercept:game:update"],',
    '  services: ["game"],',
    "};",
    "",
    "export default function (ctx) {",
    '  ctx.on("game:update", ({ game, dt, state }) => {',
    '    if (game !== "glowfall" || state.done) return;',
    "    const jar = state.jar ?? 2;",
    "    let pulled = state.pulled ?? 0;",
    "    const things = (state.things ?? []).map((t) => {",
    '      if (t.kind !== "firefly" || t.x === jar) return t;',
    "      pulled++;",
    "      const step = Math.sign(jar - t.x) * Math.min(Math.abs(jar - t.x), 1.2 * dt);",
    "      return { ...t, x: t.x + step };",
    "    });",
    "    return { state: { ...state, things, pulled } };",
    "  });",
    "}",
  ].join("\n");

  // An audio effect: ring modulation at 60 Hz, a robot's voice.
  const processor =
    'registerProcessor("effect-robot", class extends AudioWorkletProcessor { constructor() { super(); this.t = 0; } process(inputs, outputs) { const input = inputs[0][0]; const out = outputs[0][0]; for (let i = 0; i < out.length; i++) out[i] = (input ? input[i] : 0) * Math.sin(2 * Math.PI * 60 * (this.t++ / sampleRate)); return true; } });';
  const robot = [
    "export const manifest = {",
    '  id: "effect-robot",',
    '  name: "Robot voice",',
    '  description: "A robot voice effect for the sound editor.",',
    '  version: "1.0.0",',
    '  permissions: ["audio", "hook:intercept:sound-editor:effects"],',
    '  services: ["audio"],',
    "};",
    "",
    `const PROCESSOR = ${JSON.stringify(processor)};`,
    "",
    "export default async function (ctx) {",
    '  await ctx.call("audio", "registerProcessor", "effect-robot", PROCESSOR);',
    '  ctx.on("sound-editor:effects", ({ effects }) => ({',
    '    effects: [...effects, { id: "robot", name: "Robot voice", description: "Ring modulation at 60 Hz", processor: "effect-robot" }],',
    "  }));",
    "}",
  ].join("\n");

  const game = [
    { name: "app.html", text: page("Magnet Glowfall", ["/demos/glowfall/sky.js", "/demos/glowfall/jar.js", "/demos/glowfall/catch.js", "/demos/glowfall/meadow.js", "/demos/glowfall/controls.js", "magnet.js"], '\n  <header><h1>Magnet Glowfall</h1><slot name="commands"></slot></header>\n  <main><slot name="main"></slot></main>\n  <aside><slot name="side"></slot></aside>\n') },
    { name: "magnet.js", text: magnet },
  ];
  const sound = [
    { name: "app.html", text: page("Robot voices", ["/demos/audio-editor/editor.js", "/demos/audio-editor/echo.js", "robot.js"], '\n  <header><h1>Robot voices</h1><slot name="commands"></slot></header>\n  <main><slot name="main"></slot></main>\n') },
    { name: "robot.js", text: robot },
  ];

  ctx.on("llm:providers", (value) => ({ providers: [...value.providers, { id: "fake-model", name: "Scripted model", ready: true }] }));
  ctx.on("llm:complete", async (request) => {
    if (request.provider !== "fake-model") return;
    const last = request.messages.at(-1);
    const first = String(request.messages[0].content);
    const usage = { input: 10, output: 2 };
    const call = (name, args) => ({ text: "", toolCalls: [{ id: `c${request.messages.length}`, name, args }], stop: "tool", usage });
    ctx.log("model-asked " + JSON.stringify({ last: last.role === "tool" ? { name: last.name, content: String(last.content).slice(0, 600) } : null }));
    if (!request.system.startsWith("You make small web apps")) return { text: "Nothing to do.", stop: "end", usage };
    const make = (app, files, note) => {
      if (!last.name) return call("maker_save", { app, files, note });
      if (last.name === "maker_save") return call("maker_check", { app });
      return { text: `Made it: /apps/${app}/. The check said: ${String(last.content).slice(0, 300)}`, stop: "end", usage };
    };
    if (first.includes("magnet")) return make("magnet-glowfall", game, "Glowfall, with a magnet that pulls the fireflies to the jar");
    if (first.includes("robot")) return make("robot-voices", sound, "The sound editor, with a robot voice effect");
    return { text: "Nothing to do.", stop: "end", usage };
  });
}
const MODEL = `export const manifest = { id: "fake-model", name: "Scripted model", permissions: ["provide:llm"] };\nexport default ${model.toString()};`;

export default async function ({ check, openTab, context, URL }) {
  const page = await openTab(`${URL}new/`);
  const review = '[data-key^="review:"]';
  const make = '[data-key^="your-apps@"][data-key$=":make"]';
  const seen = (selector, timeout = 10000, on = page) => on.waitForSelector(selector, { timeout }).then(() => true, () => false);
  const accept = async (text) => {
    const card = await seen(`${review} >> text=${text}`, 15000);
    if (card) await page.click(`${review} >> text="Accept"`);
    return card;
  };
  const ask = async (text) => {
    await page.selectOption(`${make} select[name="app"]`, "");
    await page.fill(`${make} textarea[name="text"]`, text);
    await page.click(`${make} button[type="submit"]`);
  };
  /** What the `n`th maker_check (from 1) answered the model, once the trace of it has reached this tab. */
  const checked = (n) =>
    page
      .waitForFunction(
        (n) =>
          window.__host.traces
            .filter((e) => e.plugin === "fake-model" && e.detail?.startsWith("model-asked"))
            .map((e) => JSON.parse(e.detail.slice(12)).last)
            .filter((l) => l?.name === "maker_check")
            .map((l) => l.content)[n - 1],
        n,
        { timeout: 10000 },
      )
      .then((h) => h.jsonValue(), () => "");
  try {
    await page.waitForSelector(`${make} textarea`, { timeout: 10000 });
    // The same id as the app maker check's model, so whichever check runs second replaces the first's.
    await page.evaluate((data) => window.__host.command("user:add", { app: "new", files: [{ name: "fake-model.js", data }] }), MODEL);
    await page.evaluate(() => window.__host.command("user:on", { app: "new", id: "fake-model" }));
    await page.waitForFunction(() => window.__host.traces.some((e) => e.name === "plugin:ready" && e.plugin?.startsWith("fake-model")), null, { timeout: 10000 }).catch(() => {});

    // A game system.
    await ask("Glowfall with a magnet that pulls the fireflies to the jar");
    check("the app maker adds a game system as one new plugin beside the game's own, on one review card", await accept("with app.html, magnet.js"));
    check("…and says where the game is", await seen(`${make} >> text=Made it: /apps/magnet-glowfall/`, 30000));
    const gameCheck = await checked(1);
    check("the made game passes its checks as it runs, linking the engine's plugins as they are", /"ok":true/.test(gameCheck), gameCheck.slice(0, 300));

    const game = await context.newPage();
    await game.goto(`${URL}apps/magnet-glowfall/`);
    const ready = await seen('[data-key^="glowfall-controls"] button[data-action="start"]', 15000, game);
    if (ready) await game.click('button[data-action="start"]');
    /** The game as the kernel has it, once the magnet has pulled a firefly, or the last seen after 15 s. */
    let state = null;
    for (let tries = 0; tries < 60 && !(state?.state?.pulled > 0); tries++) {
      await new Promise((r) => setTimeout(r, 250));
      state = (await game.evaluate(() => window.__host.command("game-state")).catch(() => [])).find((g) => g.game === "glowfall") ?? null;
    }
    check("in the made game, the new system runs on the loop beside the engine's: the magnet pulls fireflies", !!state && state.state.pulled > 0 && state.by === "glowfall-controls", JSON.stringify(state ?? "no game").slice(0, 300));
    check("…and the engine's own systems still run: things fall and the jar is there", !!state && Array.isArray(state.state.things) && typeof state.state.jar === "number");
    await game.close();

    // An audio effect.
    await ask("The sound editor with a robot voice effect");
    check("the app maker adds an audio effect as one new plugin beside the editor's own, on one review card", await accept("with app.html, robot.js"));
    check("…and says where the editor is", await seen(`${make} >> text=Made it: /apps/robot-voices/`, 30000));
    const soundCheck = await checked(2);
    check("the made sound editor passes its checks as it runs", /"ok":true/.test(soundCheck), soundCheck.slice(0, 300));

    const sound = await context.newPage();
    await sound.goto(`${URL}apps/robot-voices/`);
    const offered = await seen('[data-effect="robot"]', 20000, sound);
    check("the editor offers the new effect, which it has never heard of, beside its own", offered && (await seen('[data-effect="echo"]', 5000, sound)));
    if (offered) {
      const before = await sound.locator("ui-waveform").getAttribute("peaks");
      await sound.click('[data-effect="robot"]');
      const changed = await sound
        .waitForFunction((b) => document.querySelector("ui-waveform")?.getAttribute("peaks") !== b && /Robot voice/.test(document.querySelector('[data-key^="sound-editor"] .status')?.textContent ?? ""), before, { timeout: 15000 })
        .then(() => true, () => false);
      check("applying it renders the clip through its processor, and the waveform shows the change", changed);
    }
    await sound.close();
  } finally {
    if (!page.isClosed()) await page.close();
  }
}
