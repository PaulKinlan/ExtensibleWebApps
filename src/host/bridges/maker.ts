// maker: a folder on the person's disk for an app they made (std/maker/module.ts).
// Saving writes a copy of the app's files into a folder they pick; opening
// reads an app's files from one. Picking a folder needs a page and a recent
// click, so the kernel asks the tab the person clicked in. The kernel checks
// what comes back: which files an app may have, and a review before any save.
//
// In a space, `own` reads the apps the person made outside it (/new/, kept in
// their own data folder, beside the space's), so one can be copied in.

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
  /**
   * The person's own made apps (made/apps/ in their data folder, not a space's), from a page in a space: with no
   * name, each app's name and page; with one, the files at the top of its folder, each at most `max` characters.
   * The kernel checks names and files again.
   */
  async own(name: unknown, max: unknown): Promise<{ name: string; page?: string; text?: string }[]> {
    const out: { name: string; page?: string; text?: string }[] = [];
    try {
      let apps = (await navigator.storage.getDirectory()) as Folder;
      for (const part of ["made", "apps"]) apps = (await apps.getDirectoryHandle(part)) as Folder;
      for await (const [app, entry] of apps.entries()) {
        if (entry.kind !== "directory" || (name !== undefined && app !== name)) continue;
        for await (const [file, f] of (entry as Folder).entries()) {
          const got = f.getFile && (await f.getFile());
          if (!got || got.size > Number(max)) continue;
          if (name !== undefined) out.push({ name: file, text: await got.text() });
          else if (file === "app.html") out.push({ name: app, page: await got.text() });
        }
      }
    } catch {}
    return out;
  },

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
