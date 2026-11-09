// The `game` service: a game loop, with every rule of the game in plugins.
//
// A game is a state, a plain object the game's plugins agree on, and a clock.
// The service keeps both. Many times a second (20 by default) it runs one
// tick, in three steps, each a hook:
//
//   game:update   waterfall   systems move things on: what falls, what the
//                             player steers, what spawns. Each gets
//                             { game, tick, dt, time, input, state } and
//                             answers { state } with its changes made; the
//                             next system sees them.
//   game:rules    waterfall   systems that judge what happened, once
//                             everything has moved: catches, collisions,
//                             scores. Answering { over: "why" } ends the game.
//   game:frame    emit        the state as it is now, for whatever draws it.
//                             A plugin with `scope: "tab"` draws it on an
//                             OffscreenCanvas in its own worker, at the
//                             screen's rate, between the last two frames.
//
// So a system is a plugin that listens to game:update or game:rules, with
// hook:intercept:game:update (or :rules), and a game gets a new rule by
// linking one more plugin: the loop, and the other systems, don't change.
// What the person presses comes as `input` on the next tick
// (ctx.call("game", "input", { type: "left" })), in the order it came.
//
// The ticks are quiet hooks (src/kernel/hooks.ts): they aren't traced, or a
// running game would push everything else out of the trace. game:started
// and game:ended are traced as usual.
//
// Each game is kept by name ("main" unless a plugin names one), and stops
// when the plugin that started it does. A tick that takes longer than its
// time is skipped rather than queued, so a slow system slows the game down
// rather than piling up behind it; `late` counts them.
//
// A kernel module (docs/layers.md): a site that lists `game` in kernel.json has it, as `ctx.call("game", …)`.

import type { ServiceProvider } from "../../src/kernel/remote";
import { record } from "../../src/kernel/trace";
import { service, type ModuleKernel } from "../../src/kernel/modules";

/** Ticks a second: the default, and the bounds. */
const HZ = 20;
const MIN_HZ = 1;
const MAX_HZ = 60;
const MAX_GAMES = 4;
/** Inputs kept for one tick: more are dropped, oldest first. */
const MAX_INPUT = 32;
/** How large a game's state may grow, in characters of JSON: it goes to every system on every tick. */
const MAX_STATE = 200_000;
/** How long one system has to answer a tick before it is skipped for that tick. */
const SYSTEM_MS = 250;
const NAME = /^[a-z][a-z0-9-]{0,63}$/;

type Input = { type: string; [key: string]: unknown };
type Game = {
  name: string;
  /** The plugin instance that started it: the game stops when it does. */
  owner: string;
  hz: number;
  tick: number;
  /** Seconds of game time, ticks times their length. Paused time doesn't count. */
  time: number;
  state: Record<string, unknown>;
  input: Input[];
  paused: boolean;
  /** A tick under way: the next one waits for it rather than running beside it. */
  busy: boolean;
  /** Ticks skipped because the one before was still running. */
  late: number;
  timer?: ReturnType<typeof setInterval>;
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const base = (instance: string) => instance.split("@")[0];

const make = (kernel: ModuleKernel): ServiceProvider => {
  const { root, remote } = kernel;
  const tickArgs = "{ game, tick, dt, time, input: [{ type, … }], state }";
  kernel.hook("game:update", {
    mode: "waterfall",
    quiet: true,
    timeoutMs: SYSTEM_MS,
    onFailure: "open",
    args: tickArgs,
    description: "Each tick of a game (std/game), first: systems move things on. dt is the tick's length in seconds; input is what the person pressed since the last tick. Answer { state } with your changes; the next system sees them.",
  });
  kernel.hook("game:rules", {
    mode: "waterfall",
    quiet: true,
    timeoutMs: SYSTEM_MS,
    onFailure: "open",
    args: tickArgs,
    description: "Each tick, after game:update: systems that judge what happened (catches, collisions, scores). Answer { state } with your changes, and { over: reason } to end the game.",
  });
  kernel.hook("game:frame", {
    mode: "emit",
    quiet: true,
    args: "{ game, tick, hz, at, state }",
    description: "Each tick, last: the state to draw. at is when the tick ran (Date.now()); a plugin that draws on a canvas goes between the last two frames for smooth movement.",
  });
  kernel.hook("game:started", { mode: "emit", args: "{ game, hz, state }", description: "A game started (game.start), or started again." });
  kernel.hook("game:ended", { mode: "emit", args: "{ game, tick, reason, state }", description: "A game ended: a system answered { over }, its plugin called game.stop, or the plugin that started it stopped." });

  const games = new Map<string, Game>();

  function end(game: Game, reason: string) {
    clearInterval(game.timer);
    game.timer = undefined;
    if (games.get(game.name) !== game) return;
    games.delete(game.name);
    root.emit({}, "game:ended", { game: game.name, tick: game.tick, reason, state: game.state });
    record({ kind: "note", name: "game:ended", plugin: game.owner, detail: `${game.name} at tick ${game.tick}: ${reason}` });
  }
  kernel.cleanup(() => {
    for (const game of games.values()) clearInterval(game.timer);
    games.clear();
  });

  /** One tick: update, rules, frame. */
  async function tick(game: Game) {
    if (game.paused) return;
    if (game.busy) return void game.late++;
    // The plugin that runs the game went (its tab closed, it was turned off): so does the game.
    if (!remote.live.has(game.owner)) return end(game, "its plugin stopped");
    game.busy = true;
    try {
      const dt = 1 / game.hz;
      const input = game.input;
      game.input = [];
      game.tick++;
      game.time += dt;
      const step = (state: Record<string, unknown>) => ({ game: game.name, tick: game.tick, dt, time: game.time, input, state });
      let value: Record<string, unknown> = step(game.state);
      for (const phase of ["game:update", "game:rules"]) {
        const result = await root.waterfall({}, phase, value, () => value);
        // A listener that answers { block } stops this tick's step; the state stays as it was before it.
        if (isObject(result) && "block" in result) break;
        if (!isObject(value.state)) value.state = game.state;
        if (value.over !== undefined) break;
        value = { ...step(value.state as Record<string, unknown>), ...(value.over !== undefined ? { over: value.over } : {}) };
      }
      if (games.get(game.name) !== game) return;
      const state = value.state as Record<string, unknown>;
      if (JSON.stringify(state).length > MAX_STATE) return end(game, `its state grew over ${MAX_STATE} characters of JSON`);
      game.state = state;
      root.emit({}, "game:frame", { game: game.name, tick: game.tick, hz: game.hz, at: Date.now(), state });
      if (value.over !== undefined) end(game, String(value.over || "over"));
    } catch (error) {
      record({ kind: "error", name: "game:tick", plugin: game.owner, detail: `${game.name}: ${error instanceof Error ? error.message : error}` });
    } finally {
      game.busy = false;
    }
  }

  const nameOf = (options: unknown): string => {
    const name = isObject(options) && options.game !== undefined ? options.game : "main";
    if (typeof name !== "string" || !NAME.test(name)) throw new Error(`${String(name)} isn't a game's name: use lowercase letters, digits and dashes`);
    return name;
  };
  const find = (options: unknown) => {
    const game = games.get(nameOf(options));
    if (!game) throw new Error(`No game named ${nameOf(options)} is running: start it with game.start`);
    return game;
  };
  const snapshot = (game: Game) => ({ game: game.name, running: true, paused: game.paused, tick: game.tick, time: game.time, hz: game.hz, late: game.late, by: base(game.owner), state: game.state });

  // For the tests and developer tools: every game as it is now.
  kernel.command("game-state", () => [...games.values()].map(snapshot));

  return {
    description:
      "A game loop. The game's state is a plain object its plugins agree on; each tick runs game:update, then game:rules (systems answer { state } with their changes), then game:frame for whatever draws it. A new rule is a plugin that listens to one of them.",
    methods: {
      start: {
        args: "({ game?, hz?, state? })",
        returns: "{ game, hz }",
        needs: "game",
        description: `Starts a game with a state (an object, {} if not given), ticking hz times a second (${HZ} by default, ${MIN_HZ} to ${MAX_HZ}). A game of that name already running starts again from this state. The game is named "main" unless given one, and stops when this plugin does.`,
      },
      stop: { args: "({ game? })", returns: "{ stopped }", needs: "game", description: "Ends a game, as a system's { over } would: game:ended goes out with the reason \"stopped\"." },
      pause: { args: "({ game?, paused? })", returns: "{ paused }", needs: "game", description: "Pauses a game (paused true, the default) or carries on (false). Paused, it doesn't tick, and its time stands still." },
      input: {
        args: "({ game?, type, … })",
        returns: "{ queued }",
        needs: "game",
        description: `What the person pressed: it goes to the systems on the next tick, in input, with the plugin that sent it as \`from\`. At most ${MAX_INPUT} wait for one tick.`,
      },
      state: { args: "({ game? })", returns: "{ game, running, paused, tick, time, hz, late, by, state } or { running: false }", needs: "game", description: "A game as it is now." },
    },
    capability: () => "game",
    call: (plugin, method, args) => {
      const options = args[0];
      if (method === "start") {
        const name = nameOf(options);
        const o = isObject(options) ? options : {};
        const hz = o.hz === undefined ? HZ : Number(o.hz);
        if (!Number.isFinite(hz) || hz < MIN_HZ || hz > MAX_HZ) throw new Error(`hz is ${MIN_HZ} to ${MAX_HZ}`);
        const state = o.state === undefined ? {} : o.state;
        if (!isObject(state)) throw new Error("A game's state is an object");
        if (JSON.stringify(state).length > MAX_STATE) throw new Error(`A game's state is limited to ${MAX_STATE} characters of JSON`);
        const old = games.get(name);
        if (old) {
          clearInterval(old.timer);
          games.delete(name);
        }
        if (games.size >= MAX_GAMES) throw new Error(`At most ${MAX_GAMES} games run at once`);
        const game: Game = { name, owner: plugin, hz, tick: 0, time: 0, state, input: [], paused: false, busy: false, late: 0 };
        games.set(name, game);
        game.timer = setInterval(() => void tick(game), 1000 / hz);
        root.emit({}, "game:started", { game: name, hz, state });
        record({ kind: "note", name: "game:started", plugin, detail: `${name} at ${hz} ticks a second` });
        return { game: name, hz };
      }
      if (method === "state") {
        const game = games.get(nameOf(options));
        return game ? snapshot(game) : { game: nameOf(options), running: false };
      }
      const game = find(options);
      if (method === "stop") {
        end(game, "stopped");
        return { stopped: true };
      }
      if (method === "pause") {
        game.paused = !isObject(options) || options.paused !== false;
        return { paused: game.paused };
      }
      if (method === "input") {
        if (!isObject(options) || typeof options.type !== "string" || !options.type) throw new Error("An input has a type: { type: \"left\" }");
        const { game: _name, ...input } = options;
        if (JSON.stringify(input).length > 1000) throw new Error("An input is limited to 1000 characters of JSON");
        game.input.push({ ...input, type: options.type, from: base(plugin) });
        if (game.input.length > MAX_INPUT) game.input.shift();
        return { queued: game.input.length };
      }
      throw new Error(`game.${method} is not a method`);
    },
  };
};

export default service("game", make);
