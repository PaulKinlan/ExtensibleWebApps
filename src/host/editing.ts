// Editor events from text controls in views: what the person selects, pastes
// and drops. A plugin that edits text asks for them in its HTML, and hears
// each as an event like a click:
//
//   <textarea data-action="edit" data-live
//             data-selection-action="select"   the selection settled: { from, to, text }
//             data-paste-action="paste"        a paste: { from, to, text, html, files }
//             data-drop-action="drop">         a drop from outside: { from, to, text, html, files }
//
// (or `selectionAction`, `pasteAction` and `dropAction` on a "textarea" view).
//
// A paste or drop the plugin asked for is the plugin's to make: the host
// stops the browser putting it in, and the plugin decides what goes in the
// text (a link pasted onto a word can become [word](link)), then draws the
// control again. `from` and `to` are the selection it replaces. Each file
// comes as { name, type, size }, with its `text` if it is a text file and a
// `dataUrl` if it is an image, up to 2 MB each; larger files come without
// either. Elements that edit text (ui-editor) send the same events, with the
// same values, through `ui-action`.
//
// Drags inside one view (data-drag and data-drop, in drag.ts) are not this:
// a drop here brings something from outside the view, which the person chose
// to put in this plugin's text.

const SELECTION_WAIT_MS = 150;
const MAX_TEXT = 1_000_000;
const MAX_FILE = 2_000_000;

type TextControl = HTMLTextAreaElement | HTMLInputElement;

/** A file as a plugin gets it. */
export interface DroppedFile {
  name: string;
  type: string;
  size: number;
  text?: string;
  dataUrl?: string;
}

const isText = (type: string, name: string) => type.startsWith("text/") || /\.(md|markdown|txt|csv|json|toml|ya?ml|html?|css|js)$/i.test(name);

const dataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** The files in a paste or a drop, read as far as a plugin is given them. */
export async function readFiles(list: FileList | null | undefined): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  for (const file of [...(list ?? [])].slice(0, 20)) {
    const entry: DroppedFile = { name: file.name, type: file.type, size: file.size };
    if (file.size <= MAX_FILE) {
      if (isText(file.type, file.name)) entry.text = await file.text();
      else if (file.type.startsWith("image/")) entry.dataUrl = await dataUrl(file);
    }
    out.push(entry);
  }
  return out;
}

/** What a paste or drop carries: its text and HTML (each up to 1 MB) and its files. */
export async function transferred(data: DataTransfer | null): Promise<{ text: string; html: string; files: DroppedFile[] }> {
  return {
    text: (data?.getData("text/plain") ?? "").slice(0, MAX_TEXT),
    html: (data?.getData("text/html") ?? "").slice(0, MAX_TEXT),
    files: await readFiles(data?.files),
  };
}

const control = (e: Event, attribute: string): TextControl | undefined => {
  const target = e.target;
  if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) return undefined;
  return target.hasAttribute(attribute) ? target : undefined;
};

const range = (el: TextControl) => ({ from: el.selectionStart ?? 0, to: el.selectionEnd ?? 0 });

/**
 * After a paste or drop, the plugin puts the text in and draws the control again. A redraw leaves a focused
 * control's value alone (so typing isn't lost), and an unfocused one's caret at the end. So once the new text
 * arrives (the text before and after the replaced range kept), it goes in and the caret goes after what was put
 * in, as if the browser had pasted it.
 */
function caretAfter(el: TextControl, from: number, to: number) {
  const before = el.value;
  const head = before.slice(0, from);
  const tail = before.slice(to);
  // A textarea's redraw changes its text content, focused or not; an input's only its value, which no observer
  // sees. So look at both for a few seconds.
  const declared = () => (el instanceof HTMLTextAreaElement ? (el.textContent ?? "") : el.value);
  const shown = declared();
  const started = Date.now();
  const timer = setInterval(() => {
    const now = declared() !== shown ? declared() : el.value;
    if (now === before && Date.now() - started < 5000) return;
    clearInterval(timer);
    if (now !== before && now.startsWith(head) && now.endsWith(tail)) {
      if (el.value !== now) el.value = now;
      const caret = now.length - tail.length;
      el.setSelectionRange(caret, caret);
    }
  }, 30);
}

/**
 * Listens for editor events in one view entry; `ours` says whether an event belongs to it, `send` reports one,
 * and `flush` sends a control's typing that is still waiting for its pause, so the plugin has the text first.
 */
export function listenEditing(entry: HTMLElement, ours: (e: Event) => boolean, send: (action: string, value: unknown) => void, flush: (control: Element) => void): void {
  // The selection is sent once it settles, and only when it changed.
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  const last = new WeakMap<Element, string>();
  const selection = (e: Event) => {
    if (!ours(e)) return;
    const el = control(e, "data-selection-action");
    if (!el) return;
    clearTimeout(timers.get(el));
    timers.set(
      el,
      setTimeout(() => {
        const { from, to } = range(el);
        const key = `${from}:${to}`;
        if (last.get(el) === key) return;
        last.set(el, key);
        flush(el);
        send(el.getAttribute("data-selection-action")!, { from, to, text: el.value.slice(from, to).slice(0, MAX_TEXT) });
      }, SELECTION_WAIT_MS),
    );
  };
  for (const type of ["select", "keyup", "mouseup", "focusin"]) entry.addEventListener(type, selection);

  entry.addEventListener("paste", (e) => {
    if (!ours(e)) return;
    const el = control(e, "data-paste-action");
    if (!el) return;
    e.preventDefault();
    const action = el.getAttribute("data-paste-action")!;
    flush(el);
    const at = range(el);
    caretAfter(el, at.from, at.to);
    void transferred((e as ClipboardEvent).clipboardData).then((data) => send(action, { ...at, ...data }));
  });

  // Text dragged within the control itself is the browser's to move.
  let inner: Element | undefined;
  entry.addEventListener("dragstart", (e) => void (inner = control(e, "data-drop-action")));
  entry.addEventListener("dragend", () => void (inner = undefined));
  // Something from outside the control (a file, text from another app) dragged over one that takes drops.
  const outside = (e: DragEvent) => {
    if (inner && inner === e.target) return false;
    const types = e.dataTransfer?.types ?? [];
    return types.includes("Files") || types.includes("text/plain") || types.includes("text/uri-list");
  };
  entry.addEventListener("dragover", (e) => {
    if (!ours(e) || !control(e, "data-drop-action") || !outside(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  entry.addEventListener("drop", (e) => {
    if (!ours(e)) return;
    const el = control(e, "data-drop-action");
    if (!el || !outside(e)) return;
    e.preventDefault();
    const action = el.getAttribute("data-drop-action")!;
    flush(el);
    const at = range(el);
    caretAfter(el, at.from, at.to);
    void transferred(e.dataTransfer).then((data) => send(action, { ...at, ...data }));
  });
}
