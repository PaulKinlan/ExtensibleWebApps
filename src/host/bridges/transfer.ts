// transfer: the browser's file chooser and downloads, for importing and
// exporting collections (../../kernel/services/transfer.ts).

/** Saves text as a file the person downloads. */
function save(name: unknown, text: unknown, type: unknown) {
  const url = URL.createObjectURL(new Blob([String(text)], { type: `${String(type)};charset=utf-8` }));
  const a = Object.assign(document.createElement("a"), { href: url, download: String(name) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

/**
 * Opens the file chooser and reads the file the person picks: `{ name, size, text }`, without
 * the text when it is over `max` bytes, or null if they close it. The browser opens it only
 * just after a click, so without one it fails at once rather than waiting for a choice that can't come.
 */
function pick(accept: unknown, max: unknown): Promise<{ name: string; size: number; text?: string } | null> {
  if (navigator.userActivation && !navigator.userActivation.isActive) return Promise.reject(new Error("A file can be chosen only right after the person clicks"));
  return new Promise((resolve, reject) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: String(accept), hidden: true });
    const done = () => input.remove();
    input.addEventListener("cancel", () => (done(), resolve(null)));
    input.addEventListener("change", async () => {
      done();
      const file = input.files?.[0];
      if (!file) return resolve(null);
      if (file.size > Number(max)) return resolve({ name: file.name, size: file.size });
      file.text().then((text) => resolve({ name: file.name, size: file.size, text }), reject);
    });
    document.body.append(input);
    try {
      input.showPicker();
    } catch {
      input.click();
    }
  });
}

export default () => ({ save, pick });
