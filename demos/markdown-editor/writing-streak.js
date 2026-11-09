// Writing streak: the words you write each day, and the run of days you've
// written on, in the status bar and a Streak panel with the last two weeks.

export const manifest = {
  id: "writing-streak",
  name: "Writing streak",
  description: "Counts the words you write each day and shows your streak of writing days, with a history panel.",
  version: "2.0.0",
  order: 40,
  permissions: ["ui", "document:read", "hook:listen:posts:open", "hook:listen:posts:change"],
  services: ["document"],
};

const DAY_MS = 86_400_000;
const today = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const count = (post) => (post.text.slice(post.bodyStart).match(/[\p{L}\p{N}’']+/gu) ?? []).length;

function streak(days) {
  let n = 0;
  let date = new Date();
  // Today still counts as the streak's day until it ends.
  if (!days[today(date)]) date = new Date(date.getTime() - DAY_MS);
  while (days[today(date)] > 0) {
    n++;
    date = new Date(date.getTime() - DAY_MS);
  }
  return n;
}

export default async function (ctx) {
  let days = (await ctx.storage.get("days")) ?? {};
  const seen = new Map();
  let saveTimer;

  const draw = () => {
    const n = streak(days);
    const written = days[today()] ?? 0;
    const text = n ? `🔥 ${n} day${n === 1 ? "" : "s"} · ${written.toLocaleString()} today` : written ? `${written.toLocaleString()} words today` : "";
    ctx.ui.render("status", "streak", text ? { type: "text", text, title: "Words you've written per day, in this browser" } : null);
    const last = Array.from({ length: 14 }, (_, i) => today(new Date(Date.now() - (13 - i) * DAY_MS)));
    const max = Math.max(1, ...last.map((d) => days[d] ?? 0));
    // Bar heights in tenths, so the template can pick a class: no style attributes in views.
    const bars = last.map((d) => ({ day: d, label: Number(d.slice(8)), words: days[d] ?? 0, tenth: Math.round(((days[d] ?? 0) / max) * 10) }));
    ctx.ui.views("writing-streak.html").render("panels", "streak", { streak: n, today: written.toLocaleString(), bars });
  };

  ctx.on("posts:open", (post) => seen.set(post.path, count(post)));
  ctx.on("posts:change", (post) => {
    const now = count(post);
    const before = seen.get(post.path) ?? now;
    seen.set(post.path, now);
    if (now <= before) return;
    days[today()] = (days[today()] ?? 0) + (now - before);
    // Keep about a year.
    const cutoff = today(new Date(Date.now() - 400 * DAY_MS));
    for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => ctx.storage.set("days", days), 2000);
    draw();
  });
  const post = await ctx.call("document", "read");
  if (post) seen.set(post.path, count(post));
  draw();
  setInterval(draw, 60 * 60 * 1000);
}
