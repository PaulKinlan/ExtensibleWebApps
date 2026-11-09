// Doodle: a canvas to draw on and an SVG chart of the strokes, from one
// template (doodle.html). The canvas is handed to this worker, so drawing
// happens here, from the `canvas:pointer` events the page sends for taps and
// drags. The chart is plain data: the template turns it into bars.
export const manifest = {
  id: "doodle",
  name: "Doodle",
  description: "A pad to draw on, and a chart of the strokes by colour.",
  permissions: ["ui"],
  // A canvas can only go to a worker its own tab started.
  scope: "tab",
};

const COLOURS = [
  { name: "Ink", hex: "#1f2a44" },
  { name: "Coral", hex: "#e4572e" },
  { name: "Leaf", hex: "#3a9d5d" },
  { name: "Sky", hex: "#2f80ed" },
];
const W = 640;
const H = 360;
const CHART = 120;

export default async function (ctx) {
  const views = ctx.ui.views("doodle.html");
  let pad = null;
  let theme = null;
  let colour = COLOURS[0];
  const counts = new Map(COLOURS.map((c) => [c.name, 0]));
  /** Each stroke's points, so the pad can be drawn again in a new theme. */
  let strokes = [];
  let current = null;

  const render = () => {
    const most = Math.max(1, ...counts.values());
    const bars = COLOURS.map((c, i) => {
      const n = counts.get(c.name);
      const h = Math.round((n / most) * (CHART - 20));
      return { ...c, n, x: 10 + i * 50, y: CHART - h, h, chosen: c === colour, pressed: String(c === colour), label: `${c.name}: ${n} stroke${n === 1 ? "" : "s"}` };
    });
    const total = strokes.length;
    views.render("main", "doodle", { colours: bars, bars, total, empty: total === 0, summary: bars.map((b) => b.label).join(", ") });
  };

  const paint = () => {
    if (!pad) return;
    const c = pad.getContext("2d");
    c.fillStyle = theme?.colors?.surface ?? "#ffffff";
    c.fillRect(0, 0, W, H);
    c.lineCap = "round";
    c.lineJoin = "round";
    c.lineWidth = 6;
    for (const s of strokes) line(c, s);
  };
  const line = (c, s) => {
    c.strokeStyle = s.hex;
    c.beginPath();
    c.moveTo(s.points[0].x, s.points[0].y);
    for (const p of s.points.slice(1)) c.lineTo(p.x, p.y);
    if (s.points.length === 1) c.lineTo(s.points[0].x + 0.1, s.points[0].y);
    c.stroke();
  };

  ctx.ui.onCanvas("pad", (canvas, t) => {
    pad = canvas;
    theme = t;
    paint();
  });
  ctx.ui.onTheme((t) => {
    theme = t;
    paint();
  });

  ctx.ui.onEvent((action, value) => {
    if (action === "colour") {
      colour = COLOURS.find((c) => c.name === value) ?? colour;
      render();
    } else if (action === "clear") {
      strokes = [];
      for (const c of COLOURS) counts.set(c.name, 0);
      paint();
      render();
    } else if (action === "canvas:pointer" && value?.canvas === "pad") {
      const p = { x: value.x, y: value.y };
      if (value.type === "down") {
        current = { hex: colour.hex, name: colour.name, points: [p] };
        strokes.push(current);
        segment(current.points);
      } else if (current) {
        current.points.push(p);
        segment(current.points.slice(-2));
        if (value.type === "up" || value.type === "cancel") {
          counts.set(current.name, counts.get(current.name) + 1);
          current = null;
          render();
        }
      }
    }
  });

  /** Draws just the newest bit of the stroke under way, so drawing keeps up with the finger. */
  const segment = (points) => {
    if (!pad) return;
    const c = pad.getContext("2d");
    c.lineCap = "round";
    c.lineJoin = "round";
    c.lineWidth = 6;
    line(c, { hex: current.hex, points });
  };

  render();
}
