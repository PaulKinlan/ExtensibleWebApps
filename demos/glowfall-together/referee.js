// Referee: keeps Glowfall together fair, on the space's server. The game
// already runs there, not in anyone's browser, so a player can only send
// moves; the referee watches what they send, and checks what the game's
// other plugins do with the score.
//
// At the door, on the host's own hooks (together.js):
//   glowfall-together:join   one jar for each member: a second device of
//                            the same member's is refused a seat
//   glowfall-together:move   at most MOST moves a second from a device,
//                            and a lane must be one of the game's; the rest
//                            are set aside, not played
//
// On the game loop, twice a tick (game:update and game:rules), it compares
// the state with the one it saw last. Whatever every other system did in between is in
// that difference, whichever order they ran in, so it doesn't matter where
// the referee sits among them; judging on game:rules too (it is linked after
// catches.js) checks a game's last tick, which has no update after it:
//   - a player's score goes up only by fireflies that were near their jar
//     and are gone now; the team's only by fireflies gone;
//   - no score goes down, and the lights don't come back on;
//   - a jar is in one of the lanes, and only a seated player has one.
// What breaks a rule is put back as it was, and the call goes in the state
// as `referee`, so every player's lobby shows it. A plugin someone adds to
// the space that hands out points (samples/... or one of their own) is
// caught the same way as a player who sends too much.
//
// It knows the rules of catching from what the state shows, not from
// catches.js: change the rules and this may need to change with them.

export const manifest = {
  id: "glowfall-referee",
  name: "Referee",
  description: "One jar for each member, moves no faster than a person's, and scores only for fireflies caught.",
  version: "1.0.0",
  runs: "server",
  permissions: [
    "hook:intercept:game:update",
    "hook:intercept:game:rules",
    "hook:intercept:glowfall-together:join",
    "hook:intercept:glowfall-together:move",
    "hook:listen:game:started",
  ],
  services: ["game"],
};

/** Moves a device may make in a second: faster than anyone taps, slower than a script. */
const MOST = 12;
/** How near a jar's lane a firefly must be, as it goes, to count as caught by it. */
const NEAR = 0.5;
/** How far down a firefly has fallen when it can be caught (the rim is at 0.88). */
const LOW = 0.6;
/** The calls kept to show. */
const SHOWN = 6;

export default function (ctx) {
  /** Each device's moves in the last second: when they came. */
  const recent = new Map();
  /** Moves set aside, by device. */
  const aside = new Map();
  /** The devices given a seat, and whose they are. */
  const seated = new Map();
  /** The calls made, newest last: { tick, device, what }. */
  let calls = [];
  /** The state as the referee left it on the last tick. */
  let before = null;

  const call = (tick, device, what) => {
    calls = [...calls, { tick, device, what }].slice(-SHOWN);
  };
  const setAside = (device, why) => {
    aside.set(device, (aside.get(device) ?? 0) + 1);
    return { block: why };
  };

  ctx.on("glowfall-together:join", ({ device, member, players }) => {
    const other = member ? players.find((p) => p.member === member && p.device !== device) : undefined;
    if (other) return { block: "You already have a jar in this game, on another device: one each" };
    seated.set(device, member);
    return undefined;
  });

  ctx.on("glowfall-together:move", ({ device, type, lane, lanes }) => {
    if (type === "lane" && !(Number.isInteger(lane) && lane >= 0 && lane < lanes)) return setAside(device, "That isn't a lane");
    const now = Date.now();
    const times = (recent.get(device) ?? []).filter((t) => now - t < 1000);
    if (times.length >= MOST) {
      recent.set(device, times);
      return setAside(device, `More than ${MOST} moves a second`);
    }
    times.push(now);
    recent.set(device, times);
    return undefined;
  });

  /** Whoever is playing when the referee first sees a game (a new one, or one under way when it was turned on) has a seat. */
  const seatAll = (state) => {
    for (const [device, p] of Object.entries(state?.players ?? {})) if (!seated.has(device)) seated.set(device, p?.member ?? "");
  };

  // A new game: its starting state is what the first tick is judged against.
  ctx.on("game:started", ({ game, state }) => {
    if (game !== "glowfall") return;
    calls = [];
    aside.clear();
    seatAll(state);
    before = state?.players ? state : null;
  });

  const judge = ({ game, tick, input = [], state }) => {
    if (game !== "glowfall" || !state.players) return;
    if (!before) seatAll(state);
    // A join on this tick is a seat the host gave: jars.js seats it, so it is no surprise next tick.
    for (const move of input) if (move.type === "join" && typeof move.player === "string" && !seated.has(move.player)) seated.set(move.player, String(move.member ?? ""));
    const lanes = state.lanes ?? 7;
    const players = { ...state.players };
    let { team = 0, lives = 5 } = state;
    let changed = false;

    for (const [device, p] of Object.entries(players)) {
      if (!seated.has(device)) {
        delete players[device];
        call(tick, device, "a jar for no one who joined was taken away");
        changed = true;
        continue;
      }
      if (!(Number.isInteger(p.jar) && p.jar >= 0 && p.jar < lanes)) {
        players[device] = { ...p, jar: Math.min(lanes - 1, Math.max(0, Math.round(Number(p.jar) || 0))) };
        call(tick, device, "a jar outside the lanes was put back in one");
        changed = true;
      }
    }

    if (before && !state.done) {
      const now = new Set((state.things ?? []).map((t) => t.id));
      // The fireflies that were low enough to catch a tick ago, and are gone.
      const gone = (before.things ?? []).filter((t) => t.kind === "firefly" && t.y >= LOW && !now.has(t.id));
      let gains = 0;
      for (const [device, p] of Object.entries(players)) {
        const was = before.players?.[device];
        if (!was) continue;
        const near = gone.filter((t) => Math.abs(t.x - p.jar) < NEAR || Math.abs(t.x - was.jar) < NEAR).length;
        const score = p.score ?? 0;
        const had = was.score ?? 0;
        if (score < had) {
          players[device] = { ...players[device], score: had };
          call(tick, device, "a score went down; it was put back");
          changed = true;
        } else if (score - had > near) {
          players[device] = { ...players[device], score: had + near };
          call(tick, device, `${score - had - near} point${score - had - near === 1 ? "" : "s"} with no firefly caught were taken back`);
          changed = true;
        }
        gains += (players[device].score ?? 0) - had;
      }
      const most = Math.min(gone.length, Math.max(gains, 0));
      const wasTeam = before.team ?? 0;
      if (team < wasTeam || team - wasTeam > gone.length) {
        team = wasTeam + most;
        call(tick, "", "the team's count didn't match the fireflies caught; it was put right");
        changed = true;
      }
      const wasLives = before.lives ?? 5;
      if (lives > wasLives) {
        lives = wasLives;
        call(tick, "", "lights came back on; they were put out again");
        changed = true;
      }
    }

    const referee = { calls, aside: Object.fromEntries(aside) };
    const next = { ...state, players, team, lives, referee };
    before = next;
    if (!changed && JSON.stringify(state.referee) === JSON.stringify(referee)) return;
    return { state: next };
  };
  ctx.on("game:update", judge);
  ctx.on("game:rules", judge);
}
