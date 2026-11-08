// share: the system's share sheet (Web Share), or the clipboard where there is
// none (../../kernel/services/share.ts).

import { folder } from "../router";

type Shared = { title?: string; text?: string; url?: string };

async function send(shared: Shared) {
  // A link may be a screen of the app (book/42): it is made whole against the app's folder, which
  // stays put as the address moves between screens (the page may have no <base>, opened at app.html).
  const url = shared.url ? new URL(shared.url, new URL(folder, location.origin)).href : undefined;
  if (url && !/^https?:$/.test(new URL(url).protocol)) throw new Error("Only http and https links can be shared");
  const data = { ...shared, ...(url ? { url } : {}) };
  if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error("Sharing works only right after the person clicks");
  if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
    try {
      await navigator.share(data);
      return { ok: true, via: "share" };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return { ok: false, cancelled: true };
      if (!(error instanceof DOMException && error.name === "NotAllowedError")) throw error;
    }
  }
  await navigator.clipboard.writeText(url ?? [data.title, data.text].filter(Boolean).join("\n"));
  return { ok: true, via: "clipboard" };
}

export default () => ({ send });
