// The files seam on a browser folder handle: the origin private file system,
// or a folder the person picked. The browser kernel keeps its folder through
// this, so it reads and writes the same way a space kernel does on a server.

import { checkPath, type Files } from "./index.ts";

const gone = (error: unknown) => {
  const name = (error as DOMException)?.name;
  // Missing, or a folder where a file was expected (or the other way round): either way, nothing is there.
  return name === "NotFoundError" || name === "TypeMismatchError";
};

export function opfsFiles(root: FileSystemDirectoryHandle): Files {
  /** The folder a path is in, and the file's name. */
  const locate = async (path: string, create: boolean) => {
    const parts = checkPath(path).split("/");
    const name = parts.pop()!;
    let folder = root;
    for (const part of parts) folder = await folder.getDirectoryHandle(part, { create });
    return { folder, name };
  };
  const file = async (path: string): Promise<File | null> => {
    try {
      const { folder, name } = await locate(path, false);
      return await (await folder.getFileHandle(name)).getFile();
    } catch (error) {
      if (gone(error)) return null;
      throw error;
    }
  };
  return {
    async read(path) {
      const f = await file(path);
      return f ? new Uint8Array(await f.arrayBuffer()) : null;
    },
    async readText(path) {
      return (await file(path))?.text() ?? null;
    },
    async write(path, data) {
      const { folder, name } = await locate(path, true);
      const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
      await writable.write(data as FileSystemWriteChunkType);
      await writable.close();
    },
    async remove(path) {
      try {
        const { folder, name } = await locate(path, false);
        await folder.removeEntry(name);
      } catch (error) {
        if (!gone(error)) throw error;
      }
    },
    async list(prefix) {
      const all: string[] = [];
      const walk = async (folder: FileSystemDirectoryHandle, at: string) => {
        for await (const [name, handle] of (folder as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
          const path = at ? `${at}/${name}` : name;
          if (handle.kind === "directory") {
            // Only go into folders the prefix could be in.
            if (prefix.startsWith(`${path}/`) || `${path}/`.startsWith(prefix)) await walk(handle as FileSystemDirectoryHandle, path);
          } else if (path.startsWith(prefix)) all.push(path);
        }
      };
      await walk(root, "");
      return all.sort();
    },
  };
}
