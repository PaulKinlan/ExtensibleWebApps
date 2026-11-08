// Surveys: the builder, in the browser. It owns the `surveys` collection: a
// title, the questions (one a line), whether it's taking answers, and who
// gets a daily digest. It draws the surveys with what has come in, read live
// from `answers`, which collect.js owns and writes on the space's server.
//
// A question is a line of text. Put the choices after a colon, split by |,
// and it becomes a multiple choice:
//
//   What should we call it?
//   How did you hear about us: Friend | Search | Somewhere else
//
// Collecting answers needs a server: open the app in a space
// (/s/<space>/demos/survey/) and each survey gets a public address anyone can
// answer at, signed in or not. Outside a space the builder still works, and
// says where to go.
//
// Share link hands a survey's public address to the system's share sheet (the
// share service), or copies it where there is none, as the reading list does.

export const manifest = {
  id: "surveys",
  name: "Surveys",
  description: "Build surveys, share a link anyone can answer, and see the answers come in.",
  version: "1.0.0",
  permissions: ["ui", "data:read:answers", "sync", "share"],
  order: 10,
  collections: {
    surveys: {
      title: "Surveys",
      schema: {
        type: "object",
        required: ["title", "questions"],
        properties: {
          title: { type: "string", title: "Title", maxLength: 120 },
          questions: { type: "string", title: "Questions, one a line", description: "Choices go after a colon, split by |: “Pick one: Tea | Coffee”", "x-multiline": true, maxLength: 4000 },
          open: { type: "boolean", title: "Taking answers", default: true },
          notify: { type: "string", format: "email", title: "Email a daily digest to" },
        },
      },
    },
  },
};

// A sample, with an id of its own, so devices sharing a space add it once.
const SAMPLE = {
  id: "sample-launch",
  title: "How was the launch party?",
  questions: "How was it overall: Great | Good | Not for me\nWhat should we do differently next time?\nWould you come again: Yes | Maybe | No",
  open: true,
};

export default async function (ctx) {
  const views = ctx.ui.views("surveys.html");
  let editing = null;
  /** What the last Share link did, for the survey it was pressed on. */
  let shared = { id: null, text: "" };
  if (!(await ctx.storage.get("seeded"))) {
    if (!(await ctx.call("data", "list", "surveys")).length) await ctx.call("data", "put", "surveys", SAMPLE);
    await ctx.storage.set("seeded", true);
  }

  const list = views.live("main", "surveys", async (ctx) => {
    const [surveys, answers, sync] = await Promise.all([ctx.call("data", "list", "surveys"), ctx.call("data", "list", "answers"), ctx.call("sync", "state")]);
    return {
      editing,
      space: sync.space ?? null,
      surveys: surveys
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((s) => {
          const mine = answers.filter((a) => a.survey === s.id);
          return {
            id: s.id,
            title: s.title,
            open: s.open !== false,
            closed: s.open === false,
            notify: s.notify ?? "",
            count: mine.length,
            shared: shared.id === s.id ? shared.text : "",
            // Relative to the app's page, so in a space it is the space's public address.
            link: `answer?survey=${encodeURIComponent(s.id)}`,
            questions: parse(s.questions).map((q) => summarise(q, mine)),
          };
        }),
    };
  });

  ctx.ui.onEvent(async (action, value) => {
    if (action === "edit") editing = value;
    if (action === "done" || action === "saved") editing = null;
    if (action === "share") {
      const survey = await ctx.call("data", "get", "surveys", value);
      if (!survey) return;
      // Relative, like the card's link: the share service makes it whole against the app's folder, in the space.
      const result = await ctx.call("share", "send", { title: survey.title, text: `Answer “${survey.title}”`, url: `answer?survey=${encodeURIComponent(survey.id)}` }).catch((error) => ({ ok: false, error: error.message }));
      shared = { id: survey.id, text: result.ok ? (result.via === "clipboard" ? "Link copied." : "Shared.") : result.cancelled ? "" : result.error };
    }
    if (action === "toggle") {
      const survey = await ctx.call("data", "get", "surveys", value);
      if (survey) await ctx.call("data", "put", "surveys", { ...survey, open: survey.open === false });
    }
    list.refresh();
  });
}

/** The questions, from the text: one a line, with choices after a colon split by |. Ids are q1, q2…, by line. collect.js reads them the same way. */
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

/** What a question's answers add up to: a count for each choice, or the latest few words people wrote. */
function summarise(question, answers) {
  const given = answers.map((a) => answerTo(question, a)).filter((v) => typeof v === "string" && v.trim());
  if (question.choices) {
    const counts = question.choices.map((choice) => ({ choice, n: given.filter((v) => v === choice).length }));
    return { label: question.label, most: Math.max(1, ...counts.map((c) => c.n)), choices: counts };
  }
  // Answers come most recent first: the newest five.
  return { label: question.label, said: given.slice(0, 5) };
}

/**
 * An answer's value for a question, found by the question's words (collect.js keeps them with each answer), so
 * questions added, moved or reworded after people answered don't take someone else's answers. An answer kept
 * without them is read by the question's place.
 */
function answerTo(question, answer) {
  if (!answer.asked) return answer.values?.[question.id];
  const id = Object.keys(answer.asked).find((k) => answer.asked[k] === question.label);
  return id ? answer.values?.[id] : undefined;
}
