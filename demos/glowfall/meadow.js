// Meadow: draws the game, on a canvas in this plugin's own worker. The game
// ticks 20 times a second (std/game), but this draws at the screen's rate:
// it keeps the last two frames the loop sent (game:frame) and draws each
// falling thing between where it was and where it is, so the motion is
// smooth however slow the ticks.
//
// A canvas is handed to the worker that draws on it, so this is
// `scope: "tab"`: every tab with the game open draws its own. The colours of
// the sky and the jar come from the page's theme (ctx.ui.onCanvas gives them,
// ctx.ui.onTheme gives them again when they change); the fireflies glow
// their own colour in any theme.
//
// It is also where a finger steers: the canvas is drawn with `pointer`, so
// a tap or drag on it comes here (canvas:pointer, in the canvas's own
// pixels), and the lane under the finger goes to the loop as input, the
// same input jar.js already moves the jar for: { type: "lane", lane }.

export const manifest = {
  id: "glowfall-meadow",
  name: "Meadow",
  description: "Draws the night meadow, the jar and everything falling, on a canvas, and steers the jar to where you tap or drag.",
  version: "1.0.0",
  permissions: ["ui", "game", "hook:listen:game:frame"],
  services: ["game"],
  scope: "tab",
  order: 10,
};

const W = 720;
const H = 960;
const GLOW = "#ffe27a";
const RAIN = "#7cc4ff";
/** Where the jar's rim is, as catch.js has it. */
const RIM = 0.88;

export default function (ctx) {
  let canvas = null;
  let theme = null;
  /** The last two frames: { at, tick, hz, state }. */
  let prev = null;
  let last = null;
  /** Where the jar is drawn: it slides to its lane rather than jumping. */
  let jarShown;
  const stars = Array.from({ length: 60 }, (_, i) => ({ x: (i * 97.13) % 1, y: ((i * 61.7) % 1) * 0.55, r: 0.6 + ((i * 13) % 5) / 4 }));

  ctx.on("game:frame", (frame) => {
    if (frame.game !== "glowfall") return;
    // A game started again: the tick count starts again too, so nothing is drawn from the old one.
    prev = last && frame.tick > last.tick ? last : null;
    last = frame;
  });

  const lane = (x, lanes) => ((x + 0.5) / lanes) * W;
  const ease = (a, b, t) => a + (b - a) * t;

  const draw = () => {
    if (!canvas) return;
    const g = canvas.getContext("2d");
    const now = Date.now();
    const colors = theme?.colors ?? {};
    const state = last?.state ?? {};
    const lanes = state.lanes ?? 5;
    // How far between the last two ticks we are: 0 at the older, 1 at the newer.
    const t = last && prev ? Math.min(1, Math.max(0, (now - last.at) / (1000 / (last.hz || 20)))) : 1;
    const before = new Map((prev?.state.things ?? []).map((thing) => [thing.id, thing]));

    // The night sky, darker at the top, whatever the theme; the theme tints it.
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#070a1c");
    sky.addColorStop(0.7, colors["bg-2"] && theme.scheme === "dark" ? colors["bg-2"] : "#14204a");
    sky.addColorStop(1, "#1d3b2a");
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    for (const s of stars) {
      g.globalAlpha = 0.35 + 0.35 * Math.sin(now / 900 + s.x * 40);
      g.fillStyle = "#ffffff";
      g.beginPath();
      g.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    // The lanes, faintly.
    g.strokeStyle = "rgba(255,255,255,0.05)";
    g.lineWidth = 2;
    for (let i = 1; i < lanes; i++) {
      g.beginPath();
      g.moveTo((i / lanes) * W, 0);
      g.lineTo((i / lanes) * W, H * RIM);
      g.stroke();
    }

    // The grass.
    g.fillStyle = "#0d2417";
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 24) g.lineTo(x, H * 0.95 - 10 * Math.sin(x / 37) - (x % 48 ? 0 : 14));
    g.lineTo(W, H);
    g.fill();

    // What falls, between where it was and where it is.
    for (const thing of state.things ?? []) {
      const was = before.get(thing.id) ?? thing;
      const x = lane(ease(was.x, thing.x, t), lanes);
      const y = ease(was.y, thing.y, t) * H;
      if (thing.kind === "firefly") {
        const wobble = Math.sin(now / 180 + thing.seed * 20) * 10;
        const glow = g.createRadialGradient(x + wobble, y, 0, x + wobble, y, 34);
        glow.addColorStop(0, "rgba(255,226,122,0.95)");
        glow.addColorStop(0.25, "rgba(255,226,122,0.4)");
        glow.addColorStop(1, "rgba(255,226,122,0)");
        g.fillStyle = glow;
        g.beginPath();
        g.arc(x + wobble, y, 34, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = GLOW;
        g.beginPath();
        g.arc(x + wobble, y, 6, 0, Math.PI * 2);
        g.fill();
      } else {
        g.fillStyle = RAIN;
        g.beginPath();
        g.moveTo(x, y - 18);
        g.quadraticCurveTo(x + 12, y + 2, x, y + 10);
        g.quadraticCurveTo(x - 12, y + 2, x, y - 18);
        g.fill();
      }
    }

    // The jar, which slides to its lane rather than jumping.
    const jarX = lane(state.jar ?? Math.floor(lanes / 2), lanes);
    jarShown = jarShown === undefined ? jarX : ease(jarShown, jarX, 0.35);
    const shown = jarShown;
    const jarW = (W / lanes) * 0.62;
    const top = H * RIM;
    const flash = state.caught && last && last.tick - state.caught.tick < 6 ? 1 - (last.tick - state.caught.tick) / 6 : 0;
    const light = Math.min(1, (state.score ?? 0) / 30);
    g.fillStyle = `rgba(255,226,122,${0.12 + light * 0.4 + flash * 0.4})`;
    g.fillRect(shown - jarW / 2, top, jarW, H * 0.1);
    g.strokeStyle = colors.fg || "#e8ecff";
    g.lineWidth = 4;
    g.strokeRect(shown - jarW / 2, top, jarW, H * 0.1);
    g.fillStyle = colors.accent || "#9effc7";
    g.fillRect(shown - jarW / 2 - 6, top - 8, jarW + 12, 10);

    // The score and the lights left.
    g.fillStyle = "#f4f1ff";
    g.font = "700 40px system-ui, sans-serif";
    g.textAlign = "left";
    g.fillText(String(state.score ?? 0), 28, 60);
    for (let i = 0; i < 3; i++) {
      g.fillStyle = i < (state.lives ?? 3) ? GLOW : "rgba(255,255,255,0.15)";
      g.beginPath();
      g.arc(W - 40 - i * 34, 46, 11, 0, Math.PI * 2);
      g.fill();
    }

    // Before the first game, and after the last.
    if (!last || state.done) {
      g.fillStyle = "rgba(5,8,20,0.6)";
      g.fillRect(0, 0, W, H);
      g.fillStyle = "#f4f1ff";
      g.textAlign = "center";
      g.font = "700 56px system-ui, sans-serif";
      g.fillText(state.done ? "Lights out" : "Glowfall", W / 2, H * 0.4);
      g.font = "500 28px system-ui, sans-serif";
      g.fillStyle = "rgba(244,241,255,0.75)";
      g.fillText(state.done ? `${state.score} fireflies caught` : "Catch the fireflies. Dodge the rain.", W / 2, H * 0.4 + 52);
      g.fillText("Press Start (or Enter)", W / 2, H * 0.4 + 96);
      g.fillText("Then tap or drag where the jar should go", W / 2, H * 0.4 + 136);
    }
    requestAnimationFrame(draw);
  };

  ctx.ui.onCanvas("meadow", (offscreen, given) => {
    canvas = offscreen;
    theme = given ?? null;
    requestAnimationFrame(draw);
  });
  ctx.ui.onTheme((given) => (theme = given));
  // A tap or drag: the jar goes to the lane under the finger. Only a change of lane is sent, so a drag along one lane sends nothing more.
  let sent = null;
  ctx.ui.onEvent((action, value) => {
    if (action !== "canvas:pointer" || value?.canvas !== "meadow") return;
    const state = last?.state;
    if (!state || state.done) return;
    if (value.type === "up" || value.type === "cancel") return void (sent = null);
    const lanes = state.lanes ?? 5;
    const lane = Math.min(lanes - 1, Math.max(0, Math.floor((value.x / W) * lanes)));
    if (lane === sent && value.type === "move") return;
    sent = lane;
    // No game running (it ended a moment ago), or paused: the loop says no, and that's fine.
    ctx.call("game", "input", { game: "glowfall", type: "lane", lane }).catch(() => {});
  });
  ctx.ui.render("main", "meadow", { type: "canvas", id: "meadow", width: W, height: H, pointer: true });
}
