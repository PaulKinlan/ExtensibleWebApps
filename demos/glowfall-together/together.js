// Together: the game's host, on the space's server. The game loop (std/game)
// runs here, in the space's own kernel, not in anyone's browser, so every
// member plays the same game: the same fireflies, the same rain, each with
// a jar of their own.
//
// It hears the players through live messages (sync.live, std/spaces/live.ts):
// "join", "start", and each move. A move goes to the loop as input, with the
// device it came from, for jars.js to move that player's jar. Each frame the
// loop sends (game:frame) goes back to every device playing, as a live
// message, for field.js to draw. Nothing of it is kept but the scores.
//
// runs: "server": it starts when a member opens the app in a space, and runs
// with no browser open. Outside a space there is no server, and lobby.js says so.

export const manifest = {
  id: "glowfall-together",
  name: "Glowfall together",
  description: "Runs a game of Glowfall on the space's server, for every member who joins.",
  version: "1.0.0",
  runs: "server",
  permissions: ["game", "live", "hook:listen:sync:live", "hook:listen:game:frame", "hook:listen:game:ended"],
  services: ["game", "sync"],
};

const TOPIC = "glowfall-together";
const GAME = "glowfall";
const LANES = 7;
const COLOURS = ["#ffe27a", "#9effc7", "#ff9ecb", "#9ec9ff", "#ffb37a", "#c99eff", "#7affef", "#ffffff"];
const MOVES = ["left", "right", "lane"];
/** A frame goes out on every tick; a game with nobody in it stops after this long. */
const EMPTY_MS = 20_000;

export default function (ctx) {
  /** Who is playing: device → { member, colour }. */
  const players = new Map();
  let running = false;
  let emptySince = 0;
  let last = null;

  const say = (value, device) => ctx.call("sync", "live", TOPIC, value, device).catch(() => {});
  const seat = (device, member) => {
    if (!players.has(device)) {
      // The first colour no one has.
      const taken = new Set([...players.values()].map((p) => p.n));
      const n = [...COLOURS.keys()].find((i) => !taken.has(i)) ?? players.size % COLOURS.length;
      players.set(device, { member: member ?? "", colour: COLOURS[n], n });
    }
    return players.get(device);
  };
  const roster = () => [...players].map(([device, p]) => ({ device, member: p.member, colour: p.colour, n: p.n }));

  const start = async () => {
    const state = { lanes: LANES, things: [], next: 1, team: 0, lives: 5, speed: 0.3, players: {} };
    for (const [device, p] of players) state.players[device] = { member: p.member, colour: p.colour, jar: Math.floor(LANES / 2), score: 0 };
    await ctx.call("game", "start", { game: GAME, hz: 20, state });
    running = true;
    emptySince = 0;
    await say({ type: "started", players: roster() });
  };

  ctx.on("sync:live", async ({ topic, value, member, device, gone }) => {
    if (topic !== TOPIC || !device) return;
    if (gone) {
      players.delete(device);
      if (running) await ctx.call("game", "input", { game: GAME, type: "leave", player: device }).catch(() => {});
      await say({ type: "players", players: roster() });
      if (!players.size) emptySince = Date.now();
      return;
    }
    const type = value?.type;
    if (type === "join") {
      const p = seat(device, member);
      // The new player hears which jar is theirs, and everyone hears who is in.
      await say({ type: "welcome", device, colour: p.colour, running, ...(last ? { frame: last } : {}) }, device);
      await say({ type: "players", players: roster() });
      if (running) await ctx.call("game", "input", { game: GAME, type: "join", player: device, member: p.member, colour: p.colour }).catch(() => {});
      return;
    }
    if (!players.has(device)) return;
    if (type === "start" && !running) return start();
    if (MOVES.includes(type) && running) {
      const lane = Number.isInteger(value.lane) ? value.lane : undefined;
      await ctx.call("game", "input", { game: GAME, type, player: device, ...(lane !== undefined ? { lane } : {}) }).catch(() => {});
    }
  });

  ctx.on("game:frame", ({ game, tick, hz, at, state }) => {
    if (game !== GAME || !state.players) return;
    last = { tick, hz, at, state };
    void say({ type: "frame", tick, hz, at, state });
    if (!players.size && emptySince && Date.now() - emptySince > EMPTY_MS) void ctx.call("game", "stop", { game: GAME }).catch(() => {});
  });

  ctx.on("game:ended", ({ game, reason, state }) => {
    if (game !== GAME || !state?.players) return;
    running = false;
    void say({ type: "ended", reason, state });
  });
}
