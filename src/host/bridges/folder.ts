// folder: picking a folder on the person's disk, and letting the browser use
// it again after a reload (std/folder/module.ts). Both need a page and a
// recent click, so the kernel asks the tab the person is using.

type Permissioned = FileSystemDirectoryHandle & { requestPermission?(o: { mode: string }): Promise<PermissionState> };

export default () => ({
  /** The folder the person picks, or null if they cancel or the browser can't. */
  async pick(): Promise<FileSystemDirectoryHandle | null> {
    const picker = (window as { showDirectoryPicker?: (o: { mode: string; id?: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!picker) throw new Error("This browser can't open a folder on your disk (it has no showDirectoryPicker)");
    try {
      return await picker({ mode: "readwrite", id: "ewa-folder" });
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") return null;
      throw error;
    }
  },
  /** Asks the person to let the folder be used again; true if they do. */
  async allow(handle: unknown): Promise<boolean> {
    const folder = handle as Permissioned;
    if (!folder?.requestPermission) return true;
    return (await folder.requestPermission({ mode: "readwrite" })) === "granted";
  },
});
