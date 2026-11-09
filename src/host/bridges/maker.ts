// maker: a folder on the person's disk for an app they made (std/maker/module.ts).
// Saving writes a copy of the app's files into a folder they pick; opening
// reads an app's files from one. Picking a folder needs a page and a recent
// click, so the kernel asks the tab the person clicked in. The kernel checks
// what comes back: which files an app may have, and a review before any save.

type Entry = FileSystemHandle & { getFile?(): Promise<File> };
type Folder = FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, Entry]> };
type Picker = (o: { mode: string; id?: string }) => Promise<Folder>;

/** The folder the person picks, or null if they cancel. */
async function choose(mode: "read" | "readwrite"): Promise<Folder | null> {
  const picker = (window as { showDirectoryPicker?: Picker }).showDirectoryPicker;
  if (!picker) throw new Error("This browser can't open a folder on your disk (it has no showDirectoryPicker): try Chrome or Edge on a computer");
  if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error("A folder can be picked only right after the person clicks");
  try {
    return await picker({ mode, id: "ewa-made-app" });
  } catch (error) {
    if ((error as DOMException)?.name === "AbortError") return null;
    throw error;
  }
}

export default () => ({
  /** Writes each file into a folder the person picks, replacing a file there with the same name. */
  async write(files: unknown): Promise<{ folder: string; written: string[] } | null> {
    const list = Array.isArray(files) ? (files as { name: string; text: string }[]) : [];
    const folder = await choose("readwrite");
    if (!folder) return null;
    const written: string[] = [];
    for (const { name, text } of list) {
      // Names the kernel checked; never a path.
      if (typeof name !== "string" || name.includes("/") || name.includes("\\") || name.startsWith(".")) continue;
      const file = await folder.getFileHandle(name, { create: true });
      const out = await file.createWritable();
      await out.write(String(text));
      await out.close();
      written.push(name);
    }
    return { folder: folder.name, written };
  },

  /** The text files at the top of a folder the person picks, each at most `max` characters; at most `count` of them. */
  async read(max: unknown, count: unknown): Promise<{ folder: string; files: { name: string; text: string }[]; skipped: string[] } | null> {
    const folder = await choose("read");
    if (!folder) return null;
    const files: { name: string; text: string }[] = [];
    const skipped: string[] = [];
    for await (const [name, entry] of folder.entries()) {
      if (entry.kind !== "file" || !entry.getFile || !/\.(html|js|css|md)$/i.test(name)) continue;
      const file = await entry.getFile();
      if (file.size > Number(max) || files.length >= Number(count)) {
        skipped.push(name);
        continue;
      }
      files.push({ name, text: await file.text() });
    }
    return { folder: folder.name, files, skipped };
  },
});
