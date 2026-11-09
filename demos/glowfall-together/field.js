// Field: the shared meadow, drawn on a canvas in this tab's own worker. The
// game runs on the space's server (together.js); its frames come here as
// live messages (sync:live), twenty a second, and this draws between the
// last two, as Glowfall's meadow does. Every player's jar is there, in their
// colour; yours has a ring.
//
// A tap or drag on the canvas (it is drawn with `pointer`) sends the lane
// under the finger to the space, and the arrow keys a lane left or right:
// sync.live, which the space's server hears with the device it came from.

export const manifest = {
  id: "glowfall-field",
  name: "Field",
  description: "Draws the game everyone in the space plays, and sends your moves to it.",
  version: "1.0.0",
  permissions: ["ui", "live", "commands", "hook:listen:sync:live"],
  services: ["sync", "commands"],
  scope: "tab",
  order: 10,
};

const TOPIC = "glowfall-together";
const W = 840;
const H = 960;
const RIM = 0.88;

export default function (ctx) {
  let canvas = null;
  let prev = null;
  let last = null;
  let me = null;
  /** Where each jar is drawn: they slide to their lanes. */
  const shown = new Map();
  const stars = Array.from({ length: 70 }, (_, i) => ({ x: (i * 97.13) % 1, y: ((i * 61.7) % 1) * 0.55, r: 0.6 + ((i * 13) % 5) / 4 }));

  ctx.on("sync:live", ({ topic, value }) => {
    if (topic !== TOPIC || !value) return;
    if (value.type === "welcome") me = value.device;
    const frame = value.type === "frame" ? value : value.type === "welcome" ? value.frame : value.type === "ended" ? { ...(last ?? {}), state: value.state } : null;
    if (!frame?.state) return;
    prev = last && frame.tick > last.tick ? last : null;
    last = frame;
  });

  const lane = (x, lanes) => ((x + 0.5) / lanes) * W;
  const ease = (a, b, t) => a + (b - a) * t;
  const move = (value) => ctx.call("sync", "live", TOPIC, value).catch(() => {});

  const draw = () => {
    if (!canvas) return;
    const g = canvas.getContext("2d");
    const now = Date.now();
    const state = last?.state ?? {};
    const lanes = state.lanes ?? 7;
    const t = last && prev ? Math.min(1, Math.max(0, (now - last.at) / (1000 / (last.hz || 20)))) : 1;
    const before = new Map((prev?.state.things ?? []).map((thing) => [thing.id, thing]));

    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#070a1c");
    sky.addColorStop(0.7, "#14204a");
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
    g.fillStyle = "#0d2417";
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 24) g.lineTo(x, H * 0.95 - 10 * Math.sin(x / 37) - (x % 48 ? 0 : 14));
    g.lineTo(W, H);
    g.fill();

    for (const thing of state.things ?? []) {
      const was = before.get(thing.id) ?? thing;
      const x = lane(ease(was.x, thing.x, t), lanes);
      const y = ease(was.y, thing.y, t) * H;
      if (thing.kind === "firefly") {
        const glow = g.createRadialGradient(x, y, 0, x, y, 30);
        glow.addColorStop(0, "rgba(255,226,122,0.95)");
        glow.addColorStop(1, "rgba(255,226,122,0)");
        g.fillStyle = glow;
        g.beginPath();
        g.arc(x, y, 30, 0, Math.PI * 2);
        g.fill();
      } else {
        g.fillStyle = "#7cc4ff";
        g.beginPath();
        g.moveTo(x, y - 16);
        g.quadraticCurveTo(x + 11, y + 2, x, y + 9);
        g.quadraticCurveTo(x - 11, y + 2, x, y - 16);
        g.fill();
      }
    }

    // Every player's jar, in their colour, side by side when they share a lane.
    const jarW = (W / lanes) * 0.62;
    const top = H * RIM;
    const players = Object.entries(state.players ?? {});
    const sharing = new Map();
    for (const [id, p] of players) {
      const at = lane(p.jar, lanes);
      const n = sharing.get(p.jar) ?? 0;
      sharing.set(p.jar, n + 1);
      const x = ease(shown.get(id) ?? at, at, 0.35);
      shown.set(id, x);
      const y = top + n * 10;
      g.fillStyle = `${p.colour}33`;
      g.fillRect(x - jarW / 2, y, jarW, H * 0.08);
      g.strokeStyle = p.colour;
      g.lineWidth = id === me ? 6 : 3;
      g.strokeRect(x - jarW / 2, y, jarW, H * 0.08);
      if (id === me) {
        g.fillStyle = p.colour;
        g.beginPath();
        g.moveTo(x, y - 22);
        g.lineTo(x - 10, y - 36);
        g.lineTo(x + 10, y - 36);
        g.fill();
      }
    }

    g.fillStyle = "#f4f1ff";
    g.font = "700 40px system-ui, sans-serif";
    g.textAlign = "left";
    g.fillText(String(state.team ?? 0), 28, 60);
    for (let i = 0; i < 5; i++) {
      g.fillStyle = i < (state.lives ?? 5) ? "#ffe27a" : "rgba(255,255,255,0.15)";
      g.beginPath();
      g.arc(W - 40 - i * 34, 46, 11, 0, Math.PI * 2);
      g.fill();
    }
    if (!last || state.done) {
      g.fillStyle = "rgba(5,8,20,0.6)";
      g.fillRect(0, 0, W, H);
      g.fillStyle = "#f4f1ff";
      g.textAlign = "center";
      g.font = "700 52px system-ui, sans-serif";
      g.fillText(state.done ? "Lights out" : "Glowfall together", W / 2, H * 0.4);
      g.font = "500 26px system-ui, sans-serif";
      g.fillStyle = "rgba(244,241,255,0.75)";
      g.fillText(state.done ? `${state.team} fireflies caught together` : "Everyone in the space, one sky.", W / 2, H * 0.4 + 50);
      g.fillText("Press Start, then tap or drag to steer", W / 2, H * 0.4 + 92);
    }
    requestAnimationFrame(draw);
  };

  let sent = null;
  ctx.ui.onEvent((action, value) => {
    if (action !== "canvas:pointer" || value?.canvas !== "field") return;
    const state = last?.state;
    if (!state || state.done) return;
    if (value.type === "up" || value.type === "cancel") return void (sent = null);
    const lanes = state.lanes ?? 7;
    const target = Math.min(lanes - 1, Math.max(0, Math.floor((value.x / W) * lanes)));
    if (target === sent && value.type === "move") return;
    sent = target;
    move({ type: "lane", lane: target });
  });
  ctx.commands.add({ id: "left", title: "Jar left", group: "Glowfall together", keys: ["ArrowLeft"] }, () => move({ type: "left" }));
  ctx.commands.add({ id: "right", title: "Jar right", group: "Glowfall together", keys: ["ArrowRight"] }, () => move({ type: "right" }));

  ctx.ui.onCanvas("field", (offscreen) => {
    canvas = offscreen;
    requestAnimationFrame(draw);
  });
  ctx.ui.render("main", "field", { type: "canvas", id: "field", width: W, height: H, pointer: true });
}
