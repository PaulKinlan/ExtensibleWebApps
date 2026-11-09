// Glowfall together's referee (demos/glowfall-together/referee.js), on its
// own: the plugin's function given a stand-in ctx, and fed the hooks as the
// space's server would. One jar for each member, moves at a person's pace,
// and points only for fireflies caught, whoever handed them out.
import referee from "../../demos/glowfall-together/referee.js";

export default async function ({ check }) {
  const heard = new Map();
  referee({ on: (hook, handler) => heard.set(hook, handler) });
  const join = heard.get("glowfall-together:join");
  const move = heard.get("glowfall-together:move");
  const update = heard.get("game:update");
  const started = heard.get("game:started");

  // Seats: Ann, then Ann again on a second device, then Ben.
  check("referee: a member's first device gets a seat", join({ device: "a1", member: "ann", players: [] }) === undefined);
  const twice = join({ device: "a2", member: "ann", players: [{ device: "a1", member: "ann" }] });
  check("referee: a second device of the same member is refused a seat (one jar each)", !!twice?.block, JSON.stringify(twice));
  check("referee: another member gets a seat", join({ device: "b1", member: "ben", players: [{ device: "a1", member: "ann" }] }) === undefined);

  // The game starts with both of them in it.
  const players = { a1: { member: "ann", jar: 3, score: 0 }, b1: { member: "ben", jar: 0, score: 0 } };
  started({ game: "glowfall", state: { players } });

  // Moves: a lane that isn't one, and more than a person can make in a second.
  check("referee: a lane outside the game is set aside", !!move({ device: "b1", type: "lane", lane: 99, lanes: 7 })?.block);
  const verdicts = Array.from({ length: 30 }, () => move({ device: "b1", type: "right", lanes: 7 }));
  const played = verdicts.filter((v) => !v).length;
  check("referee: of 30 moves in a moment, only a person's pace (12) are played", played === 12, `${played} played`);
  check("referee: Ann's moves aren't held back by Ben's", move({ device: "a1", type: "left", lanes: 7 }) === undefined);

  const tick = (n, state, input = []) => update({ game: "glowfall", tick: n, input, state })?.state ?? state;

  // Tick 1: a firefly low over Ann's jar. Tick 2: it's gone and Ann has a point, as catches.js would give.
  let state = tick(1, { lanes: 7, team: 0, lives: 5, things: [{ id: 1, kind: "firefly", x: 3, y: 0.85 }], players });
  state = tick(2, { ...state, team: 1, things: [], players: { ...state.players, a1: { ...state.players.a1, score: 1 } } });
  check("referee: a point for a firefly caught at a jar stands", state.players.a1.score === 1 && state.team === 1 && !state.referee.calls.length, JSON.stringify(state.referee));

  // Tick 3: some plugin hands Ben ten points, with nothing caught, and lights a lamp again.
  state = tick(3, { ...state, team: 11, lives: 5, players: { ...state.players, b1: { ...state.players.b1, score: 10 } } });
  state = tick(4, { ...state, lives: 6 });
  check("referee: points with no firefly caught are taken back", state.players.b1.score === 0, JSON.stringify(state.players.b1));
  check("referee: the team's count is put right", state.team === 1, String(state.team));
  check("referee: lights don't come back on", state.lives === 5, String(state.lives));
  check("referee: its calls go in the state, for the lobby", state.referee.calls.length >= 3 && state.referee.calls.some((c) => c.device === "b1"), JSON.stringify(state.referee.calls));
  check("referee: the moves it set aside are counted for each player", state.referee.aside.b1 === 19, JSON.stringify(state.referee.aside));

  // A jar for someone who never joined, and a jar out past the lanes.
  state = tick(5, { ...state, players: { ...state.players, x9: { member: "eve", jar: 2, score: 0 }, a1: { ...state.players.a1, jar: 12 } } });
  check("referee: a jar for no one who joined is taken away", !state.players.x9);
  check("referee: a jar outside the lanes is put back in one", state.players.a1.jar === 6, String(state.players.a1.jar));

  // A player who joins as the game goes on (the host's join input) is no stranger.
  state = tick(6, { ...state, players: { ...state.players, c1: { member: "cat", jar: 3, score: 0 } } }, [{ type: "join", player: "c1", member: "cat" }]);
  check("referee: a player who joins during the game keeps their jar", !!state.players.c1);
  await more({ check });
}

// Copilot's cases on #155: points on the very first tick, a referee turned on mid-game, and the last tick's rules.
export async function more({ check }) {
  const heard = new Map();
  referee({ on: (hook, handler) => heard.set(hook, handler) });
  const players = { a1: { member: "ann", jar: 3, score: 0 } };
  heard.get("game:started")({ game: "glowfall", state: { lanes: 7, team: 0, lives: 5, things: [], players } });
  const first = heard.get("game:update")({ game: "glowfall", tick: 1, input: [], state: { lanes: 7, team: 5, lives: 5, things: [], players: { a1: { ...players.a1, score: 5 } } } })?.state;
  check("referee: points handed out before the first tick it sees are taken back too", first?.players.a1.score === 0 && first.team === 0, JSON.stringify(first?.players));
  const last = heard.get("game:rules")({ game: "glowfall", tick: 2, input: [], state: { ...first, players: { a1: { ...first.players.a1, score: 9 } } } })?.state;
  check("referee: it judges on game:rules too, so a game's last tick is checked", last?.players.a1.score === 0);

  const late = new Map();
  referee({ on: (hook, handler) => late.set(hook, handler) });
  const running = late.get("game:update")({ game: "glowfall", tick: 40, input: [], state: { lanes: 7, team: 3, lives: 4, things: [], players: { a1: { member: "ann", jar: 2, score: 3 }, b1: { member: "ben", jar: 5, score: 0 } } } });
  const kept = running?.state?.players ?? {};
  check("referee: turned on during a game, it keeps the players already playing", !!kept.a1 && !!kept.b1, JSON.stringify(Object.keys(kept)));
}
