// Dictation: speak into the post. A Dictate button in the toolbar listens
// with the browser's speech recognition (the <ui-dictation> element, which
// runs in the page), and each phrase it is sure of goes in at the cursor
// through the document service, so Undo takes it out again. Spoken
// punctuation ("comma", "full stop", "new paragraph") becomes the mark, and
// sentences start with a capital. What it is still hearing shows in the
// status bar.

export const manifest = {
  id: "dictation",
  name: "Dictation",
  description: "Type by speaking: a Dictate button that puts what you say in at the cursor, with spoken punctuation.",
  version: "1.0.0",
  order: 140,
  permissions: ["ui", "document:read", "document:write", "hook:listen:posts:open", "hook:listen:posts:close"],
  services: ["document"],
};

/** Spoken punctuation, as most dictation software understands it. */
const SPOKEN = [
  [/\s*\b(full stop|period)\b/gi, "."],
  [/\s*\bcomma\b/gi, ","],
  [/\s*\bquestion mark\b/gi, "?"],
  [/\s*\bexclamation (mark|point)\b/gi, "!"],
  [/\s*\bcolon\b/gi, ":"],
  [/\s*\bnew paragraph\b\s*/gi, "\n\n"],
  [/\s*\bnew line\b\s*/gi, "\n"],
];

/** A phrase as it goes into the post: punctuation for the spoken words, and capitals where sentences start. */
export function tidy(text, sentenceStart) {
  let out = text.trim();
  for (const [re, mark] of SPOKEN) out = out.replace(re, mark);
  out = out.replace(/^[ \t]+/gm, "");
  if (sentenceStart) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out.replace(/([.?!]\s+)(\p{Ll})/gu, (_, p, c) => p + c.toUpperCase());
}

export default async function (ctx) {
  let open = false;
  let sentenceStart = true;
  const status = (text) => ctx.ui.render("status", "listening", text ? { type: "text", text, title: "Dictation is on: press Dictate again to stop" } : null);
  const button = () => ctx.ui.views("dictation.html").render("toolbar", "button", { open });

  ctx.ui.onEvent(async (action, value) => {
    if (action !== "heard" || !value || typeof value !== "object") return;
    if (value.listening === true) {
      sentenceStart = true;
      return status("● Listening…");
    }
    if (value.listening === false) {
      status("");
      if (value.error && !["aborted", "no-speech"].includes(value.error)) {
        ctx.ui.render("notices", "dictation", { type: "text", text: value.error === "not-allowed" ? "Dictation needs the microphone: allow it in the site's settings." : `Dictation stopped: ${value.error}`, tone: "error" });
        setTimeout(() => ctx.ui.render("notices", "dictation", null), 8000);
      }
      return;
    }
    if (typeof value.text !== "string") return;
    if (!value.final) return status(`● ${value.text.length > 50 ? `…${value.text.slice(-50)}` : value.text}`);
    const words = tidy(value.text, sentenceStart);
    if (!words) return;
    // A space before the phrase if it would touch a word, and one after unless it ended a line, so the next follows on.
    const post = await ctx.call("document", "read");
    const before = post ? post.text.slice(0, post.selection.from).slice(-1) : "";
    const lead = before && !/\s/.test(before) && !/^[.,?!:\n]/.test(words) ? " " : "";
    if (await ctx.call("document", "insert", lead + (/\n$/.test(words) ? words : `${words} `))) sentenceStart = /[.?!\n]\s*$/.test(words);
    status("● Listening…");
  });

  ctx.on("posts:open", () => {
    open = true;
    button();
  });
  ctx.on("posts:close", () => {
    open = false;
    status("");
    button();
  });
  open = !!(await ctx.call("document", "read"));
  button();
}
