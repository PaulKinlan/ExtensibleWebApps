// Collect: the survey's public side, on the space's server only. It owns the
// `answers` collection and answers two public routes:
//
//   GET  answer?survey=<id>   the survey as a plain HTML form
//   POST answer?survey=<id>   takes the answers, then says thank you
//
// So in a space called "team", /s/team/demos/survey/answer?survey=<id> is a
// page anyone can open and answer, signed in or not, with no app open
// anywhere. What they send comes to every member's device as a change by
// plugin:collect, and the builder's results move.
//
// Once a day it emails each survey's `notify` address how many answers came
// in since the last digest, if any did.
//
// The page is built here, as a string, and the host shows it with no script
// and nothing loaded from elsewhere. Everything a person typed (titles,
// questions) is escaped before it goes in.

export const manifest = {
  id: "collect",
  name: "Survey answers",
  description: "Serves each survey as a public form on the space's server, keeps the answers, and emails a daily digest.",
  version: "1.0.0",
  runs: "server",
  permissions: ["routes", "schedule", "email", "data:read:surveys"],
  collections: {
    answers: {
      title: "Answers",
      schema: {
        type: "object",
        required: ["survey", "values"],
        properties: {
          survey: { type: "string", title: "Survey" },
          values: { type: "object", title: "Answers, by question" },
          asked: { type: "object", title: "Each question's words, as it was answered" },
        },
      },
    },
  },
};

const MAX_ANSWERS = 1000;
const MAX_TEXT = 2000;
const DAY = 24 * 60 * 60 * 1000;

export default async function (ctx) {
  /** Answers are counted and kept one at a time, so two at once can't both take a survey's last place. */
  let keeping = Promise.resolve();
  const inTurn = (work) => {
    const turn = keeping.then(work);
    keeping = turn.catch(() => {});
    return turn;
  };
  const survey = async (id) => (typeof id === "string" && id ? await ctx.call("data", "get", "surveys", id) : null);

  ctx.routes.add("GET", "answer", async ({ query }) => {
    const s = await survey(query?.survey);
    if (!s) return { status: 404, html: page("Not found", "<p>There's no survey at this address.</p>") };
    if (s.open === false) return { html: page(s.title, "<p>This survey isn't taking answers any more. Thank you for looking.</p>") };
    const fields = parse(s.questions)
      .map((q) =>
        q.choices
          ? `<fieldset><legend>${esc(q.label)}</legend>${q.choices.map((c) => `<label><input type="radio" name="${q.id}" value="${esc(c)}"> ${esc(c)}</label>`).join("")}</fieldset>`
          : `<label>${esc(q.label)}<textarea name="${q.id}" rows="3" maxlength="${MAX_TEXT}"></textarea></label>`,
      )
      .join("");
    return { html: page(s.title, `<form method="post" action="answer?survey=${encodeURIComponent(s.id)}">${fields}<button type="submit">Send</button></form>`) };
  });

  ctx.routes.add("POST", "answer", async ({ query, form }) => {
    const s = await survey(query?.survey);
    if (!s || s.open === false) return { status: 404, html: page("Not taking answers", "<p>This survey isn't taking answers.</p>") };
    // Only the questions the survey asks, and for a choice only one of its choices.
    // Each answer keeps the words of the question it answers, so a survey edited later still shows it under that question.
    const values = {};
    const asked = {};
    for (const q of parse(s.questions)) {
      const given = typeof form?.[q.id] === "string" ? form[q.id].trim().slice(0, MAX_TEXT) : "";
      if (given && (!q.choices || q.choices.includes(given))) {
        values[q.id] = given;
        asked[q.id] = q.label;
      }
    }
    if (!Object.keys(values).length) return { status: 400, html: page(s.title, `<p>Nothing was answered. <a href="answer?survey=${encodeURIComponent(s.id)}">Try again</a>.</p>`) };
    const saved = await inTurn(async () => {
      const count = (await ctx.call("data", "list", "answers")).filter((a) => a.survey === s.id).length;
      if (count >= MAX_ANSWERS) return { full: true };
      return ctx.call("data", "put", "answers", { survey: s.id, values, asked });
    });
    if (saved.full) return { status: 429, html: page(s.title, "<p>This survey has all the answers it can take.</p>") };
    if (!saved.ok) return { status: 500, html: page(s.title, "<p>Your answers couldn't be kept. Please try again.</p>") };
    return { html: page("Thank you", `<p>Your answers to “${esc(s.title)}” are in.</p>`) };
  });

  // The digest: once a day, to each survey's notify address, if anything came in since its last one. Each survey
  // keeps its own place, which moves on only once its email is sent, so one that couldn't go is tried again.
  ctx.schedule.every("digest", DAY, async () => {
    const saved = (await ctx.storage.get("digested")) ?? {};
    // Once a single time for every survey.
    const digested = typeof saved === "number" ? {} : { ...saved };
    const since = (id) => digested[id] ?? (typeof saved === "number" ? saved : 0);
    const now = Date.now();
    const answers = await ctx.call("data", "list", "answers");
    for (const s of await ctx.call("data", "list", "surveys")) {
      const n = answers.filter((a) => a.survey === s.id && Date.parse(a.createdAt) > since(s.id)).length;
      if (!n || !s.notify) continue;
      try {
        await ctx.call("email", "send", { to: s.notify, subject: `${n} new answer${n === 1 ? "" : "s"} to “${s.title.replace(/[\r\n]+/g, " ")}”`, text: `${n} people answered “${s.title}” since the last digest. Open the survey app in your space to see them.` });
        digested[s.id] = now;
      } catch (error) {
        ctx.log(`Digest for ${s.title}: ${error?.message ?? error}`, "error");
      }
    }
    await ctx.storage.set("digested", digested);
  });
}

/** The questions, from the survey's text. The same as surveys.js reads them: each plugin is one file. */
function parse(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((line, i) => {
      const at = line.lastIndexOf(":");
      const choices = at > 0 && line.includes("|", at) ? line.slice(at + 1).split("|").map((c) => c.trim()).filter(Boolean) : null;
      return { id: `q${i + 1}`, label: choices ? line.slice(0, at).trim() : line, ...(choices?.length ? { choices } : {}) };
    });
}

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** A whole page: the platform's styles, and a little of its own. */
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<link rel="stylesheet" href="/platform/host.css">
<style>body{display:block;max-width:36rem;margin:0 auto;padding:24px 16px}form{display:grid;gap:16px}fieldset{display:grid;gap:6px;border:1px solid var(--border);border-radius:var(--radius);padding:12px}label{display:grid;gap:6px}fieldset label{display:flex;gap:8px;align-items:center}textarea{font:inherit}button{justify-self:start}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}
