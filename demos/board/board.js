// Board: owns the cards and draws them two ways. At the app's own address it
// draws the board, a column per stage; at card/<id> it draws one card as an
// editor, so a card has an address to bookmark or send. Which one shows is
// the router's business: this plugin reads router.current() and draws what
// the address says.
//
// What makes it a showcase is what it leaves for others. Each card on the
// board has a room, <slot name="board.card.badges">, carrying the card's id,
// due date and stage as data-* attributes; due.js and checklist.js fill it
// without this plugin knowing they exist. The card screen has a bigger room,
// board.card.detail, where checklist.js draws the whole checklist. And every
// column and card says what it is (data-column, data-priority,
// data-assignee), so a transform such as wip.js or a person's own "Focus"
// plugin can find them by selector.
//
// Everything on the card screen is a plain control with data-action: radio
// buttons styled as segmented controls, checkboxes styled as chips. Each
// change saves at once; there is no Save button to forget.
//
// A screen belongs to one tab, so this plugin is `scope: "tab"`: each tab's
// copy draws what its own address says.

export const manifest = {
  id: "board",
  name: "Board",
  description: "The cards, as a board of columns, and each card on its own screen.",
  version: "1.0.0",
  permissions: ["ui", "router"],
  scope: "tab",
  order: 10,
  collections: {
    cards: {
      title: "Cards",
      schema: {
        type: "object",
        required: ["title", "column"],
        properties: {
          title: { type: "string", title: "Title", maxLength: 140 },
          column: { type: "string", title: "Stage", enum: ["ideas", "next", "doing", "review", "done"], default: "ideas" },
          labels: { type: "array", title: "Labels", items: { type: "string", enum: ["design", "build", "research", "bug", "words"] } },
          assignee: { type: "string", title: "Who", enum: ["Mei", "Kofi", "Ines", "Rafa", "Sam"] },
          priority: { type: "string", title: "Priority", enum: ["low", "normal", "high", "urgent"], default: "normal" },
          due: { type: "string", title: "Due", format: "date" },
          points: { type: "integer", title: "Points", minimum: 0, maximum: 13 },
          cover: { type: "string", title: "Cover", enum: ["none", "dawn", "lagoon", "meadow", "ember", "dusk"], default: "none" },
          notes: { type: "string", title: "Notes", "x-multiline": true, maxLength: 4000 },
          rank: { type: "number", title: "Order in its column" },
        },
      },
    },
  },
};

/** The stages, in board order. `hint` is what the empty column says. */
export const COLUMNS = [
  { id: "ideas", title: "Ideas", hint: "Anything worth doing, someday." },
  { id: "next", title: "Up next", hint: "Ready to pick up." },
  { id: "doing", title: "In progress", hint: "Nothing in flight." },
  { id: "review", title: "Review", hint: "Nothing waiting on a look." },
  { id: "done", title: "Shipped", hint: "Ship something!" },
];
const PEOPLE = ["Mei", "Kofi", "Ines", "Rafa", "Sam"];
const LABELS = ["design", "build", "research", "bug", "words"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const COVERS = ["none", "dawn", "lagoon", "meadow", "ember", "dusk"];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** The date `n` days from today, as YYYY-MM-DD. */
const inDays = (n) => iso(new Date(Date.now() + n * 86_400_000));

// A small team redesigning a weather app. Fixed ids, so checklist.js can seed steps for them.
const SAMPLE = () => [
  { id: "card-moodboard", title: "Moodboard for the new onboarding", column: "ideas", labels: ["design"], assignee: "Mei", cover: "dusk", points: 2, rank: 1 },
  { id: "card-interviews", title: "Interview five people who work night shifts", column: "ideas", labels: ["research"], assignee: "Kofi", points: 5, rank: 2, notes: "What do they check first when they wake up at 6pm?" },
  { id: "card-invite", title: "Beta invite email", column: "ideas", labels: ["words"], assignee: "Sam", points: 1, rank: 3 },
  { id: "card-offline", title: "Offline mode for the radar map", column: "next", labels: ["build"], assignee: "Rafa", priority: "high", due: inDays(5), points: 8, rank: 1, cover: "lagoon" },
  { id: "card-contrast", title: "Dark mode contrast audit", column: "next", labels: ["design", "bug"], assignee: "Ines", due: inDays(9), points: 3, rank: 2 },
  { id: "card-charts", title: "Screen reader pass on the rain charts", column: "next", labels: ["build", "research"], assignee: "Ines", points: 3, rank: 3 },
  { id: "card-icons", title: "Animated weather icons", column: "doing", labels: ["design", "build"], assignee: "Mei", priority: "urgent", due: inDays(1), points: 5, rank: 1, cover: "ember", notes: "Sun, cloud, rain, snow, fog. Keep each under 2 seconds and respect reduced motion." },
  { id: "card-sync", title: "Rewrite the sync conflict message", column: "doing", labels: ["words"], assignee: "Sam", due: inDays(3), points: 2, rank: 2 },
  { id: "card-rotate", title: "Crash when rotating on the forecast screen", column: "review", labels: ["bug", "build"], assignee: "Rafa", priority: "urgent", due: inDays(-1), points: 3, rank: 1 },
  { id: "card-pricing", title: "Pricing page, first draft", column: "review", labels: ["words", "design"], assignee: "Sam", points: 3, rank: 2, cover: "meadow" },
  { id: "card-widget", title: "Lock screen widget", column: "done", labels: ["build", "design"], assignee: "Kofi", points: 8, rank: 1, cover: "dawn" },
  { id: "card-alerts", title: "Storm alerts that wake you only when it matters", column: "done", labels: ["build"], assignee: "Rafa", priority: "high", points: 5, rank: 2 },
];

/** "Mei" → "M"; the avatar's letter. */
const initial = (name) => (name ? name[0] : "?");

/** The address's screen: { card: id } on card/<id>, or {} on the board. */
function screen(path) {
  const [, name, id] = path.split("/");
  if (name !== "card" || !id) return {};
  try {
    return { card: decodeURIComponent(id) };
  } catch {
    return { card: "" };
  }
}

/** A card as the board template wants it. */
function forBoard(card) {
  return {
    ...card,
    initial: initial(card.assignee),
    labels: (card.labels ?? []).map((name) => ({ name })),
    loud: card.priority === "high" || card.priority === "urgent",
    first: card.column === COLUMNS[0].id,
    last: card.column === COLUMNS.at(-1).id,
    cover: card.cover && card.cover !== "none" ? card.cover : "",
  };
}

export default async function (ctx) {
  const views = ctx.ui.views("board.html");

  if (!(await ctx.storage.get("seeded"))) {
    if (!(await ctx.call("data", "list", "cards")).length) for (const card of SAMPLE()) await ctx.call("data", "put", "cards", card);
    await ctx.storage.set("seeded", true);
  }

  /** On the card screen, whether Delete has been pressed once and waits for a second press. */
  let confirming = false;

  const all = async (api) => (await api.call("data", "list", "cards")).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt)));

  // The board, drawn only on the app's own address.
  const board = views.live("main", "board", async (api) => {
    const { path } = await api.call("router", "current");
    if (screen(path).card !== undefined) return { shown: false };
    const cards = await all(api);
    return {
      shown: true,
      columns: COLUMNS.map((column) => {
        const list = cards.filter((c) => c.column === column.id);
        return {
          ...column,
          count: list.length,
          points: list.reduce((sum, c) => sum + (c.points ?? 0), 0),
          cards: list.map(forBoard),
        };
      }),
    };
  });

  // One card, on card/<id>.
  const card = views.live("main", "card", async (api) => {
    const { path } = await api.call("router", "current");
    const id = screen(path).card;
    if (id === undefined) return { shown: false };
    const c = id && (await api.call("data", "get", "cards", id));
    if (!c) return { shown: true, missing: true };
    const has = new Set(c.labels ?? []);
    const option = (value, current) => ({ value, on: value === current, key: `${value}` });
    return {
      shown: true,
      card: {
        ...c,
        cover: c.cover && c.cover !== "none" ? c.cover : "",
        initial: initial(c.assignee),
        stage: COLUMNS.find((col) => col.id === c.column)?.title,
      },
      columns: COLUMNS.map((col) => ({ ...option(col.id, c.column), title: col.title })),
      priorities: PRIORITIES.map((p) => option(p, c.priority ?? "normal")),
      people: PEOPLE.map((p) => ({ ...option(p, c.assignee), initial: initial(p) })),
      labels: LABELS.map((l) => ({ name: l, on: has.has(l) })),
      covers: COVERS.map((cover) => option(cover, c.cover ?? "none")),
      confirming,
    };
  });

  ctx.on("router:changed", () => {
    confirming = false;
    board.refresh();
    card.refresh();
  });

  const current = async () => screen((await ctx.call("router", "current")).path).card;

  /** Saves `fields` onto card `id`. */
  const update = async (id, fields) => {
    const c = await ctx.call("data", "get", "cards", id);
    if (!c) return;
    const { createdAt, updatedAt, ...rest } = c;
    const next = { ...rest, ...fields };
    for (const [k, v] of Object.entries(next)) if (v === "" || v === null || Number.isNaN(v)) delete next[k];
    await ctx.call("data", "put", "cards", next);
  };

  /** Adds a card to the end of a column. */
  const add = async (column, title) => {
    title = String(title ?? "").trim();
    if (!title) return null;
    const cards = await all(ctx);
    const rank = Math.max(0, ...cards.filter((c) => c.column === column).map((c) => c.rank ?? 0)) + 1;
    return (await ctx.call("data", "put", "cards", { title, column, rank, priority: "normal", cover: "none" })).id;
  };

  /** Moves a card one stage left (-1) or right (+1), to the end of that column. */
  const move = async (id, step) => {
    const c = await ctx.call("data", "get", "cards", id);
    if (!c) return;
    const at = COLUMNS.findIndex((col) => col.id === c.column);
    const to = COLUMNS[Math.min(COLUMNS.length - 1, Math.max(0, at + step))].id;
    if (to === c.column) return;
    const rank = Math.max(0, ...(await all(ctx)).filter((x) => x.column === to).map((x) => x.rank ?? 0)) + 1;
    await update(id, { column: to, rank });
  };

  ctx.ui.onEvent(async (action, value) => {
    const [verb, arg] = action.split(":");
    // On the board.
    if (verb === "add") return void add(arg, value?.title);
    if (verb === "move") {
      const [id, step] = String(value).split("|");
      return void move(id, Number(step));
    }
    // On the card screen: every control names the field it sets.
    const id = await current();
    if (!id) return;
    if (verb === "set") {
      if (arg === "points") value = value === "" || Number.isNaN(value) ? "" : Math.round(value);
      return void update(id, { [arg]: value });
    }
    if (verb === "label") {
      const c = await ctx.call("data", "get", "cards", id);
      const labels = new Set(c?.labels ?? []);
      value ? labels.add(arg) : labels.delete(arg);
      return void update(id, { labels: LABELS.filter((l) => labels.has(l)) });
    }
    if (verb === "delete") {
      if (!confirming) {
        confirming = true;
        return void card.refresh();
      }
      confirming = false;
      await ctx.call("data", "delete", "cards", id);
      return void ctx.call("router", "go", "./");
    }
    if (verb === "keep") {
      confirming = false;
      card.refresh();
    }
  });

  // What the board does, named once: the palette lists them, their keys run them, and agents use them as tools.
  ctx.commands.add({ id: "new", title: "New card in Ideas", group: "Board", keys: ["Alt+N"] }, async () => {
    const id = await add("ideas", "Untitled card");
    await ctx.call("router", "go", `card/${encodeURIComponent(id)}`);
    return "Added a card to Ideas";
  });
  ctx.commands.add({ id: "show-board", title: "Show the whole board", group: "Board", keys: ["Alt+B"] }, async () => {
    await ctx.call("router", "go", "./");
  });
  ctx.commands.add({ id: "advance", title: "Move this card to the next stage", group: "Board", keys: ["Alt+ArrowRight"] }, async () => {
    const id = await current();
    if (!id) return "Open a card first";
    await move(id, 1);
    return "Moved it on";
  });
  ctx.commands.add(
    {
      id: "add",
      title: "Add a card",
      description: "Adds a card with this title to a stage of the board.",
      group: "Board",
      args: { type: "object", required: ["title"], properties: { title: { type: "string", maxLength: 140 }, column: { type: "string", enum: COLUMNS.map((c) => c.id) } } },
    },
    async ({ title, column = "ideas" }) => {
      await add(column, title);
      return `Added "${title}"`;
    },
  );
}
