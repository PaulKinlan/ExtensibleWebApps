// browser-model: the language model some browsers carry themselves (Chrome's
// Prompt API, `LanguageModel`), for std/browser-model/module.ts. The API lives
// in pages and not in workers, where the kernel and every plugin run, so the
// kernel asks a tab. Nothing leaves the device, and there is no key.
//
// Where the browser has the API but not yet the model, the first request
// starts the download (several GB, once for the whole browser; the browser
// allows that only just after a click) and says so, with how far it has got,
// in place of an answer. The page's script doesn't carry this file: it is
// fetched the first time the kernel asks for it (./index.ts).

type Turn = { role: "system" | "user" | "assistant"; content: string };
type State = "unavailable" | "downloadable" | "downloading" | "available";

/** The languages asked for, which the API wants named: the platform's prompts are English. */
const EXPECT = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };

const api = () => (globalThis as { LanguageModel?: any }).LanguageModel;

/** How much of the model has come down, 0 to 1, while this page waits for it. */
let progress = 0;
let downloading: Promise<unknown> | undefined;

async function state(): Promise<State> {
  const model = api();
  if (typeof model?.availability !== "function" || typeof model?.create !== "function") return "unavailable";
  try {
    const answer = await model.availability(EXPECT);
    return ["downloadable", "downloading", "available"].includes(answer) ? answer : "unavailable";
  } catch {
    return "unavailable";
  }
}

const percent = () => (progress > 0 ? ` (${Math.round(progress * 100)}% so far)` : "");

/** Why the last download stopped, to say once. */
let failed = "";

/** Starts the model's download, once, and keeps how far it has got. */
function download() {
  downloading ??= Promise.resolve()
    .then(() =>
      api().create({
        ...EXPECT,
        monitor(monitor: EventTarget) {
          monitor.addEventListener("downloadprogress", (event) => (progress = Number((event as ProgressEvent).loaded) || 0));
        },
      }),
    )
    .then(
      (session: { destroy?: () => void }) => session?.destroy?.(),
      (error: unknown) => (failed = error instanceof Error ? error.message : String(error)),
    )
    .finally(() => (downloading = undefined));
}

export default () => ({
  /** Whether this browser has a model of its own, and how much of a download under way has arrived. */
  async state() {
    return { state: await state(), progress };
  },
  /** Asks the model. `turns` ends with the person's; `schema` (JSON Schema) holds the answer to that shape. */
  async prompt(request: { system?: string; turns: Turn[]; schema?: unknown }) {
    const now = await state();
    if (now === "unavailable") throw new Error("This browser has no built-in model. It needs a recent Chrome on a computer (not a phone) with enough memory and disk space. Pick another model, or add one from Customize.");
    if (now !== "available") {
      if (failed) {
        const why = failed;
        failed = "";
        throw new Error(`Chrome couldn't download its built-in model (${why}). It needs about 22 GB of free disk space and a connection that isn't metered. Ask again to try once more, or pick another model.`);
      }
      if (now === "downloadable" && !downloading && navigator.userActivation && !navigator.userActivation.isActive) {
        throw new Error("Chrome has to download its built-in model before it can answer (several GB, once). Ask again to start the download: the browser only allows it right after a click.");
      }
      download();
      throw new Error(`Chrome is downloading its built-in model${percent()}. It is several GB and happens once for the whole browser. Ask again in a few minutes, or pick another model.`);
    }
    const turns = request.turns.slice();
    const last = turns.pop();
    if (!last) throw new Error("There is nothing to ask");
    const session = await api().create({ ...EXPECT, initialPrompts: [...(request.system ? [{ role: "system", content: request.system }] : []), ...turns] });
    try {
      const usage = () => Number(session.contextUsage ?? session.inputUsage) || 0;
      const measure = session.measureContextUsage ?? session.measureInputUsage;
      const before = usage();
      const asked = Number(await Promise.resolve(measure?.call(session, [last])).catch(() => 0)) || 0;
      const text = await session.prompt([last], request.schema ? { responseConstraint: request.schema } : undefined);
      // What the session holds after the answer is the request and the answer together.
      return { text: String(text ?? ""), input: before + asked, output: Math.max(0, usage() - before - asked) };
    } catch (error) {
      if (error instanceof DOMException && error.name === "QuotaExceededError") throw new Error("That is more than Chrome's built-in model can read at once. Ask something shorter, or pick a larger model.");
      if (error instanceof DOMException && error.name === "NotSupportedError") throw new Error("Chrome's built-in model can't answer in that language yet. Ask in English, or pick another model.");
      throw error;
    } finally {
      session.destroy?.();
    }
  },
});
