// Activities: owns the log of runs, rides, hikes and swims, and draws it as a
// feed of cards, newest first, with a form to log a new one. Each card shows
// its route (an SVG file next to the template: a plugin's own files load
// without the network permission), the kind, and big numbers.
//
// Every distance on a card is its own element with data-km="…", so other
// plugins can find distances by selector. The Miles sample in Customize
// replaces each one with miles, without this plugin knowing.
//
// The sample log is a year of activity, generated from a fixed seed so the
// same "random" year appears every time, with ids so it is only added once.

export const manifest = {
  id: "activities",
  name: "Activities",
  description: "The log: a feed of activity cards, and a form to add one.",
  version: "1.0.0",
  permissions: ["ui"],
  order: 10,
  collections: {
    activities: {
      title: "Activities",
      schema: {
        type: "object",
        required: ["title", "kind", "date", "km", "minutes"],
        properties: {
          title: { type: "string", title: "Title", maxLength: 80 },
          kind: { type: "string", title: "Kind", enum: ["run", "ride", "hike", "swim"], default: "run" },
          date: { type: "string", title: "Date", format: "date" },
          km: { type: "number", title: "Distance (km)", minimum: 0, maximum: 1000 },
          minutes: { type: "integer", title: "Time (minutes)", minimum: 1, maximum: 6000 },
          climb: { type: "integer", title: "Climb (m)", minimum: 0, maximum: 10000 },
          feel: { type: "string", title: "How it felt", enum: ["rough", "ok", "good", "great"], default: "good" },
          route: { type: "integer", title: "Route picture", minimum: 1, maximum: 6 },
          notes: { type: "string", title: "Notes", "x-multiline": true, maxLength: 2000 },
        },
      },
    },
  },
};

export const KINDS = {
  run: { name: "Run", glyph: "🏃" },
  ride: { name: "Ride", glyph: "🚴" },
  hike: { name: "Hike", glyph: "🥾" },
  swim: { name: "Swim", glyph: "🏊" },
};
const FEELS = { rough: "😮‍💨", ok: "🙂", good: "😊", great: "🤩" };

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A small seeded random number generator (mulberry32), so the sample year is the same every time. */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A year of sample activities, ending today: more often in summer, a long ride most weekends. */
export function sampleYear(today = new Date()) {
  const rand = random(2026);
  const out = [];
  const titles = {
    run: ["Morning loop", "River path", "Tempo by the canal", "Easy shakeout", "Hill repeats", "Park run", "Long run"],
    ride: ["Coffee ride", "Coast road", "Gravel lanes", "Commute, the long way", "Up the big hill"],
    hike: ["Ridge walk", "Woods and waterfall", "Sunrise summit"],
    swim: ["Lido lengths", "Lake swim", "Pool, steady"],
  };
  for (let back = 364; back >= 0; back--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const summer = 0.5 + 0.35 * Math.sin(((day.getMonth() - 2) / 12) * Math.PI * 2);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    if (rand() > summer * (weekend ? 1.1 : 0.55)) continue;
    const roll = rand();
    const kind = weekend ? (roll < 0.45 ? "ride" : roll < 0.7 ? "hike" : "run") : roll < 0.65 ? "run" : roll < 0.85 ? "swim" : "ride";
    const km = { run: 4 + rand() * (weekend ? 18 : 8), ride: 18 + rand() * (weekend ? 70 : 25), hike: 6 + rand() * 14, swim: 1 + rand() * 2.5 }[kind];
    const pace = { run: 4.6 + rand() * 1.4, ride: 1.9 + rand() * 0.9, hike: 11 + rand() * 5, swim: 18 + rand() * 6 }[kind]; // minutes per km
    const list = titles[kind];
    out.push({
      id: `sample-${iso(day)}`,
      title: list[Math.floor(rand() * list.length)],
      kind,
      date: iso(day),
      km: Math.round(km * 10) / 10,
      minutes: Math.max(10, Math.round(km * pace)),
      climb: kind === "swim" ? 0 : Math.round(rand() * km * (kind === "hike" ? 60 : kind === "ride" ? 12 : 9)),
      feel: ["ok", "good", "good", "great", "rough"][Math.floor(rand() * 5)],
      route: 1 + Math.floor(rand() * 6),
    });
  }
  return out;
}

/** "5:12 /km" for runs and hikes, "1:54 /100m" for swims, "28.4 km/h" for rides. */
export function pace({ kind, km, minutes }) {
  if (!km) return "";
  if (kind === "ride") return `${((km / minutes) * 60).toFixed(1)} km/h`;
  const per = kind === "swim" ? minutes / (km * 10) : minutes / km;
  const m = Math.floor(per);
  return `${m}:${String(Math.round((per - m) * 60)).padStart(2, "0")} ${kind === "swim" ? "/100m" : "/km"}`;
}

const duration = (minutes) => (minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`);

export default async function (ctx) {
  const views = ctx.ui.views("activities.html");

  if (!(await ctx.storage.get("seeded"))) {
    if (!(await ctx.call("data", "list", "activities")).length) for (const a of sampleYear()) await ctx.call("data", "put", "activities", a);
    await ctx.storage.set("seeded", true);
  }

  let shown = 8;
  let kind = "all";

  const feed = views.live("main", "feed", async (api) => {
    const all = (await api.call("data", "list", "activities")).sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
    const list = kind === "all" ? all : all.filter((a) => a.kind === kind);
    return {
      kinds: [{ id: "all", name: "Everything", on: String(kind === "all") }, ...Object.entries(KINDS).map(([id, k]) => ({ id, name: `${k.glyph} ${k.name}`, on: String(kind === id) }))],
      more: list.length > shown,
      count: list.length,
      items: list.slice(0, shown).map((a) => ({
        ...a,
        ...KINDS[a.kind],
        feelGlyph: FEELS[a.feel] ?? "",
        when: new Date(`${a.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }),
        time: duration(a.minutes),
        pace: pace(a),
        km: a.km.toFixed(1),
        route: `routes/route-${a.route ?? 1}.svg`,
      })),
    };
  });

  ctx.ui.onEvent((action, value) => {
    if (action === "more") shown += 8;
    if (action === "kind") {
      kind = value;
      shown = 8;
    }
    feed.refresh();
  });

  ctx.commands.add({ id: "show-runs", title: "Show only runs", group: "Log" }, () => {
    kind = "run";
    feed.refresh();
  });
  ctx.commands.add({ id: "show-all", title: "Show everything", group: "Log" }, () => {
    kind = "all";
    feed.refresh();
  });
}
