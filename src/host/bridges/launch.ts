// launch: the files the browser opened the page with (its launch queue), for
// an installed app whose manifest has file_handlers (../../../std/launch/module.ts).
// The queue is read as soon as the host starts, and kept until the kernel asks.

/** How long take() waits for the browser to hand over the files, which it does just after the page loads. */
const WAIT_MS = 3000;
/** The largest file whose text is read. */
const MAX_TEXT = 5_000_000;
const TEXT = /^text\/|^application\/(json|xml|csv|x-ndjson|ld\+json)$|\.(md|markdown|txt|csv|tsv|json|xml|ics|vcf)$/i;

type Queue = { setConsumer(consumer: (params: { files?: { kind: string; getFile(): Promise<File> }[] }) => void): void };

let handles: { getFile(): Promise<File> }[] | undefined;
let arrived: () => void = () => {};
const ready = new Promise<void>((resolve) => (arrived = resolve));

const queue = (window as { launchQueue?: Queue }).launchQueue;
queue?.setConsumer((params) => {
  handles = [...(handles ?? []), ...(params.files ?? []).filter((f) => f.kind === "file")];
  arrived();
});

/** The files opened with this page, each read once; then none. */
async function take() {
  if (!handles) await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, WAIT_MS))]);
  const taken = handles ?? [];
  handles = [];
  return Promise.all(
    taken.map(async (handle) => {
      const file = await handle.getFile();
      const text = file.size <= MAX_TEXT && (TEXT.test(file.type) || TEXT.test(file.name)) ? await file.text() : undefined;
      return { name: file.name, type: file.type, size: file.size, lastModified: file.lastModified, ...(text === undefined ? {} : { text }) };
    }),
  );
}

export default () => ({ take });
