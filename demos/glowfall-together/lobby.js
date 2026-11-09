// Lobby: who is playing, the scores, and the Start button. It joins the game
// on the space's server as soon as the page is in a space (a live message,
// "join", which also starts this device hearing the game's frames), and
// shows each player by the name on their account (sync.members). Outside a
// space there's no server to play on, so it says how to get to one.
//
// With the referee on (referee.js), the state carries its calls: what it
// put right, and how many of each player's moves it set aside. The lobby
// shows them, and why a seat was refused.

export const manifest = {
  id: "glowfall-lobby",
  name: "Lobby",
  description: "Joins the game on the space's server, starts it, and shows who is playing and the scores.",
  version: "1.0.0",
  permissions: ["ui", "live", "members", "sync", "hook:listen:sync:live", "hook:listen:members:changed", "hook:listen:sync:changed"],
  services: ["sync"],
  scope: "tab",
  order: 20,
};

const TOPIC = "glowfall-together";

export default async function (ctx) {
  const views = ctx.ui.views("lobby.html");
  let inSpace = false;
  let joined = false;
  let me = null;
  let running = false;
  let players = [];
  let state = null;
  let names = new Map();
  let note = "";
  let lastDrawn = 0;
  let refused = false;

  /** A player's name, from their device. */
  const who = (device) => (device === me ? "You" : (names.get(players.find((p) => p.device === device)?.member) ?? "A player"));

  const draw = () => {
    lastDrawn = Date.now();
    const scores = state?.players ?? {};
    const referee = state?.referee;
    views.render("side", "lobby", {
      away: !inSpace,
      inSpace,
      joined,
      waiting: inSpace && !joined && !refused,
      refused,
      running,
      idle: joined && !running,
      note,
      team: state?.team ?? 0,
      lives: state?.lives ?? 5,
      players: players.map((p) => ({ key: p.device, name: names.get(p.member) ?? "A member", n: p.n ?? 0, you: p.device === me, score: scores[p.device]?.score ?? 0, jar: scores[p.device]?.jar ?? "", aside: referee?.aside?.[p.device] ?? 0 })),
      refereed: !!referee,
      calls: (referee?.calls ?? []).map((c, i) => ({ key: `${c.tick}-${i}`, text: `${c.device ? `${who(c.device)}: ` : ""}${c.what}` })).reverse(),
      quiet: !!referee && !referee.calls?.length,
    });
  };

  ctx.on("sync:live", ({ topic, value }) => {
    if (topic !== TOPIC || !value) return;
    if (value.type === "welcome") {
      me = value.device;
      joined = true;
      running = !!value.running;
    } else if (value.type === "refused") {
      // The referee (or another plugin on the host's join hook) said no to a seat.
      joined = false;
      refused = true;
      note = `No seat: ${value.reason}.`;
    } else if (value.type === "players") players = value.players ?? [];
    else if (value.type === "started") {
      running = true;
      note = "";
      players = value.players ?? players;
    } else if (value.type === "ended") {
      running = false;
      state = value.state;
      note = `Lights out: ${value.reason}.`;
    } else if (value.type === "frame") {
      state = value.state;
      // Twenty frames a second come; the scores need redrawing only now and then.
      if (Date.now() - lastDrawn < 500) return;
    }
    draw();
  });
  ctx.on("members:changed", async () => {
    names = new Map(((await ctx.call("sync", "members").catch(() => null))?.members ?? []).map((m) => [m.id, m.name]));
    draw();
  });

  // A dropped connection loses this device's seat: the space gives a new connection a new id, and it hears the
  // game only once it says something again. So it joins again when it's back.
  let connected = true;
  ctx.on("sync:changed", async () => {
    const state = await ctx.call("sync", "state").catch(() => null);
    const now = !!state?.connected;
    if (now === connected) return;
    connected = now;
    if (!now) {
      joined = false;
      note = "Lost the space's server: joining again when it's back.";
      draw();
    } else if (inSpace && !joined && (await join())) {
      note = "";
      draw();
    }
  });

  ctx.ui.onEvent(async (action) => {
    if (action === "start") await ctx.call("sync", "live", TOPIC, { type: "start" }).catch((e) => ((note = e.message), draw()));
    if (action === "join") {
      refused = false;
      note = "";
      draw();
      await join();
    }
  });

  const join = async () => {
    try {
      await ctx.call("sync", "live", TOPIC, { type: "join" });
      return true;
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
      draw();
      return false;
    }
  };

  const members = await ctx.call("sync", "members").catch(() => ({ space: null, members: [] }));
  inSpace = !!members.space;
  names = new Map((members.members ?? []).map((m) => [m.id, m.name]));
  draw();
  if (!inSpace) return;
  // The page may still be connecting to its space: try for a while.
  for (let tries = 0; tries < 20 && !joined && !refused; tries++) {
    if (await join()) {
      note = "";
      for (let wait = 0; wait < 10 && !joined && !refused; wait++) await new Promise((r) => setTimeout(r, 200));
    } else await new Promise((r) => setTimeout(r, 1000));
  }
  draw();
}
