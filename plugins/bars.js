// Draws the length of each note as bars on an OffscreenCanvas, animating in
// its own worker. Shows custom drawing with no plugin code on the main thread.

export const manifest = {
  id: "bars",
  name: "Note lengths",
  description: "Bars for the length of each note, drawn on a canvas in a worker.",
  version: "1.0.0",
  permissions: ["ui", "hook:listen:data:changed", "data:read:notes"],
  scope: "tab",
  order: 30,
};

export default async function (ctx) {
  let notes = await ctx.call("store", "list");
  let shown = notes.map(() => 0);
  let canvas;
  let frames = 0;

  ctx.on("data:changed", async () => {
    notes = await ctx.call("store", "list");
  });

  const frame = () => {
    if (!canvas) return;
    const g = canvas.getContext("2d");
    const max = Math.max(1, ...notes.map((n) => n.text.length));
    g.clearRect(0, 0, canvas.width, canvas.height);
    const h = canvas.height / Math.max(1, notes.length);
    notes.forEach((note, i) => {
      const target = (note.text.length / max) * (canvas.width - 8);
      shown[i] = (shown[i] ?? 0) + (target - (shown[i] ?? 0)) * 0.15;
      g.fillStyle = "#6b9bff";
      g.fillRect(4, i * h + 4, shown[i], Math.max(2, h - 8));
    });
    frames++;
    requestAnimationFrame(frame);
  };

  ctx.ui.onCanvas("bars", (offscreen) => {
    canvas = offscreen;
    requestAnimationFrame(frame);
  });
  ctx.ui.render("side", "bars", {
    type: "stack",
    children: [
      { type: "heading", text: "Note lengths" },
      { type: "canvas", id: "bars", width: 240, height: 120 },
    ],
  });
  setInterval(() => ctx.log(`frames drawn: ${frames}`), 2000);
}
