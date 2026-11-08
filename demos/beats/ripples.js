// Ripples: the pattern as a radar, drawn on a canvas in this plugin's own
// worker. Six rings, one per voice; sixteen spokes, one per step; a sweeping
// arm; and a ripple each time the arm crosses a hit.
//
// It keeps time without being sent a single tick. The sequencer writes
// transport/now ({ playing, bpm, startedAt }) when it starts, stops or
// changes tempo; this plugin reads that record and the pattern, and works out
// where the arm is from the clock. Two plugins in two workers, in step,
// meeting only in data.
//
// A canvas is handed to the worker that draws on it, so the plugin is
// `scope: "tab"`: each tab draws its own. Canvas colours can't be read from
// the page's CSS tokens in a worker, so the palette is its own.

export const manifest = {
  id: "ripples",
  name: "Ripples",
  description: "The pattern as a radar, with a ripple for every hit.",
  version: "1.0.0",
  permissions: ["ui", "data:read:patterns", "data:read:transport"],
  scope: "tab",
  order: 30,
};

const TRACKS = ["kick", "snare", "clap", "hat", "bass", "bell"];
const HUES = { kick: "#ff5d8f", snare: "#ffb547", clap: "#f8f05b", hat: "#5ef0c9", bass: "#5eb4ff", bell: "#b18cff" };
const SIZE = 640; // drawn at twice the size it shows, for sharp lines

export default async function (ctx) {
  let transport = null;
  let pattern = null;
  let canvas = null;
  /** Ripples in flight: { x, y, born, hue }. */
  const ripples = [];
  let lastStep = -1;

  const load = async () => {
    transport = await ctx.call("data", "get", "transport", "now");
    pattern = transport?.pattern ? await ctx.call("data", "get", "patterns", transport.pattern) : (await ctx.call("data", "list", "patterns")).at(-1);
  };
  ctx.on("data:changed:transport", load);
  ctx.on("data:changed:patterns", load);
  await load();

  const centre = SIZE / 2;
  const radius = (ring) => 150 + ring * 26;
  const at = (ring, step) => {
    const a = (step / 16) * Math.PI * 2 - Math.PI / 2;
    return [centre + Math.cos(a) * radius(ring), centre + Math.sin(a) * radius(ring)];
  };

  const frame = () => {
    if (!canvas) return;
    const g = canvas.getContext("2d");
    const now = Date.now();
    g.clearRect(0, 0, SIZE, SIZE);

    // Where the arm is: a fraction of the bar, from the clock.
    let pos = -1;
    if (transport?.playing) {
      const sixteenth = 60_000 / (transport.bpm || 120) / 4;
      pos = (((now - transport.startedAt) / sixteenth) % 16 + 16) % 16;
    }
    const step = pos < 0 ? -1 : Math.floor(pos);

    // Rings and spokes.
    g.lineWidth = 1;
    for (let r = 0; r < TRACKS.length; r++) {
      g.strokeStyle = "rgba(255,255,255,0.07)";
      g.beginPath();
      g.arc(centre, centre, radius(r), 0, Math.PI * 2);
      g.stroke();
    }
    for (let s = 0; s < 16; s++) {
      const [x, y] = at(TRACKS.length - 0.5, s);
      g.strokeStyle = s % 4 === 0 ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.05)";
      g.beginPath();
      g.moveTo(centre, centre);
      g.lineTo(x, y);
      g.stroke();
    }

    // The arm, with a fading trail behind it.
    if (pos >= 0) {
      const a = (pos / 16) * Math.PI * 2 - Math.PI / 2;
      const trail = g.createConicGradient(a - 0.9, centre, centre);
      trail.addColorStop(0, "rgba(158,255,199,0)");
      trail.addColorStop(0.14, "rgba(158,255,199,0.18)");
      trail.addColorStop(0.1433, "rgba(158,255,199,0)");
      g.fillStyle = trail;
      g.beginPath();
      g.arc(centre, centre, radius(TRACKS.length - 0.5), 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "rgba(158,255,199,0.9)";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(centre, centre);
      g.lineTo(centre + Math.cos(a) * radius(TRACKS.length - 0.5), centre + Math.sin(a) * radius(TRACKS.length - 0.5));
      g.stroke();
    }

    // The hits, and a ripple when the arm reaches one.
    TRACKS.forEach((t, r) => {
      const cells = pattern?.tracks?.[t] ?? "";
      for (let s = 0; s < 16; s++) {
        if (cells[s] !== "x") continue;
        const [x, y] = at(r, s);
        const lit = s === step;
        g.shadowColor = HUES[t];
        g.shadowBlur = lit ? 28 : 10;
        g.fillStyle = HUES[t];
        g.globalAlpha = lit ? 1 : 0.75;
        g.beginPath();
        g.arc(x, y, lit ? 11 : 7, 0, Math.PI * 2);
        g.fill();
        if (lit && step !== lastStep) ripples.push({ x, y, born: now, hue: HUES[t] });
      }
    });
    g.globalAlpha = 1;
    g.shadowBlur = 0;
    lastStep = step;

    for (let i = ripples.length - 1; i >= 0; i--) {
      const age = (now - ripples[i].born) / 700;
      if (age >= 1) {
        ripples.splice(i, 1);
        continue;
      }
      g.strokeStyle = ripples[i].hue;
      g.globalAlpha = 1 - age;
      g.lineWidth = 3 * (1 - age) + 0.5;
      g.beginPath();
      g.arc(ripples[i].x, ripples[i].y, 10 + age * 60, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;

    // The name in the middle.
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.font = "600 22px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText(pattern?.name ?? "", centre, centre + 4);
    g.fillStyle = "rgba(255,255,255,0.4)";
    g.font = "500 18px ui-monospace, monospace";
    g.fillText(transport?.playing ? `${transport.bpm} bpm` : "stopped", centre, centre + 32);

    requestAnimationFrame(frame);
  };

  ctx.ui.onCanvas("radar", (offscreen) => {
    canvas = offscreen;
    requestAnimationFrame(frame);
  });
  ctx.ui.render("side", "radar", {
    type: "stack",
    children: [
      { type: "heading", text: "Ripples" },
      { type: "canvas", id: "radar", width: SIZE, height: SIZE },
    ],
  });
}
