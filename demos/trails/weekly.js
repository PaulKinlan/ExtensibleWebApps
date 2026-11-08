// Weekly: the last twelve weeks as a stacked bar chart, a colour per kind,
// drawn on a canvas in this plugin's worker. It reads the log and draws
// again when it changes; bars grow into place over half a second.
//
// A worker can't read the page's CSS, so the canvas comes with the page's
// theme (its colours resolved, its font), and the theme comes again when it
// changes: gridlines and labels follow it, light or dark, and so does a theme
// like samples/forest.js. The bar colours are mid-tones that read on both.

export const manifest = {
  id: "weekly",
  name: "Weekly distance",
  description: "Twelve weeks of distance, stacked by kind, on a canvas.",
  version: "1.0.0",
  permissions: ["ui", "data:read:activities"],
  scope: "tab",
  order: 30,
};

const KINDS = [
  ["run", "#f97316"],
  ["ride", "#0ea5e9"],
  ["hike", "#16a34a"],
  ["swim", "#8b5cf6"],
];
const W = 1200;
const H = 440;
const WEEKS = 12;

/** Monday of the week holding `d`, at midnight. */
const monday = (d) => {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
};

export default async function (ctx) {
  let canvas = null;
  /** The page's theme, from the canvas: { scheme, colors, font }. */
  let theme = null;
  let weeks = [];
  let shown = [];
  let started = 0;
  let animating = false;

  /** Starts the grow animation, or restarts its clock if one is already running: never two at once. */
  const animate = () => {
    started = performance.now();
    if (!canvas || animating) return;
    animating = true;
    requestAnimationFrame(frame);
  };

  /** The chart as words, for people who can't see it: each week's total, oldest first, and this week by kind. */
  const describe = () => {
    if (!weeks.length) return "";
    const total = (w) => Math.round(Object.values(w.km).reduce((a, b) => a + b, 0));
    const now = weeks.at(-1);
    const kinds = Object.entries(now.km).filter(([, km]) => km > 0).map(([k, km]) => `${k} ${Math.round(km)}`);
    return `This week ${total(now)} km${kinds.length ? ` (${kinds.join(", ")})` : ""}. Weeks before, oldest first: ${weeks.slice(0, -1).map((w) => `${w.label} ${total(w)} km`).join(", ")}.`;
  };
  const draw = () =>
    ctx.ui.render("weeks", "weekly", {
      type: "stack",
      children: [
        { type: "heading", text: "Twelve weeks" },
        { type: "canvas", id: "weeks", width: W, height: H },
        { type: "text", text: "Kilometres a week: runs, rides, hikes and swims, stacked.", tone: "muted" },
        { type: "text", text: describe(), tone: "muted" },
      ],
    });

  const load = async () => {
    const first = monday(new Date());
    first.setDate(first.getDate() - 7 * (WEEKS - 1));
    // Built in a local list and swapped in at the end: loads can overlap while the log is filling.
    const next = Array.from({ length: WEEKS }, (_, i) => {
      const d = new Date(first);
      d.setDate(d.getDate() + i * 7);
      return { start: d, label: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }), km: { run: 0, ride: 0, hike: 0, swim: 0 } };
    });
    for (const a of await ctx.call("data", "list", "activities")) {
      const i = Math.floor((new Date(`${a.date}T12:00:00`) - first) / (7 * 86_400_000));
      if (i >= 0 && i < WEEKS && next[i].km[a.kind] !== undefined) next[i].km[a.kind] += a.km;
    }
    weeks = next;
    draw();
    animate();
  };

  const frame = (now) => {
    const g = canvas.getContext("2d");
    const grow = Math.min(1, (now - started) / 500);
    const ease = 1 - (1 - grow) ** 3;
    g.clearRect(0, 0, W, H);
    const pad = { l: 64, r: 16, t: 24, b: 48 };
    const totals = weeks.map((w) => Object.values(w.km).reduce((a, b) => a + b, 0));
    const top = Math.max(50, Math.ceil(Math.max(...totals) / 50) * 50);
    const y = (km) => H - pad.b - (km / top) * (H - pad.t - pad.b);

    // Gridlines and their labels.
    g.font = `500 20px ${theme?.font ?? "system-ui, sans-serif"}`;
    g.textAlign = "right";
    g.textBaseline = "middle";
    for (let km = 0; km <= top; km += top / 4) {
      g.strokeStyle = theme?.colors.border ?? "rgba(128,128,128,0.18)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(pad.l, y(km));
      g.lineTo(W - pad.r, y(km));
      g.stroke();
      g.fillStyle = theme?.colors["fg-2"] ?? "rgba(128,128,128,0.9)";
      g.fillText(`${Math.round(km)}`, pad.l - 12, y(km));
    }

    // The bars: one column per week, each kind stacked, the top one rounded.
    const slot = (W - pad.l - pad.r) / WEEKS;
    const bar = slot * 0.62;
    weeks.forEach((w, i) => {
      const x = pad.l + i * slot + (slot - bar) / 2;
      let base = 0;
      const layers = KINDS.filter(([k]) => w.km[k] > 0);
      layers.forEach(([k, colour], j) => {
        const km = w.km[k] * ease;
        const y0 = y(base);
        const y1 = y(base + km);
        g.fillStyle = colour;
        g.beginPath();
        g.roundRect(x, y1, bar, y0 - y1, j === layers.length - 1 ? [10, 10, 0, 0] : 0);
        g.fill();
        base += km;
      });
      if (i === WEEKS - 1) {
        g.fillStyle = theme?.colors["fg-2"] ?? "rgba(128,128,128,0.9)";
        g.textAlign = "center";
        g.textBaseline = "bottom";
        g.fillText(`${Math.round(totals[i])} km`, x + bar / 2, y(base) - 8);
      }
      if (i % 2 === WEEKS % 2 || i === WEEKS - 1) {
        g.fillStyle = theme?.colors["fg-2"] ?? "rgba(128,128,128,0.9)";
        g.textAlign = "center";
        g.textBaseline = "top";
        g.fillText(i === WEEKS - 1 ? "This week" : w.label, x + bar / 2, H - pad.b + 14);
      }
    });
    if (grow < 1) requestAnimationFrame(frame);
    else animating = false;
  };

  ctx.on("data:changed:activities", load);
  ctx.ui.onCanvas("weeks", (offscreen, given) => {
    canvas = offscreen;
    theme = given;
    animate();
  });
  // A new theme draws the chart again as it stands, without growing the bars.
  ctx.ui.onTheme((given) => {
    theme = given;
    if (!canvas || animating) return;
    started = performance.now() - 500;
    animating = true;
    requestAnimationFrame(frame);
  });
  await load();
  // "This week" moves on with the calendar: load again at each local midnight.
  const atMidnight = () => {
    const now = new Date();
    setTimeout(() => {
      load();
      atMidnight();
    }, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now + 1000);
  };
  atMidnight();
}
