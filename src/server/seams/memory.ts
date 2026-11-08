// Seams kept in memory: for tests, and for trying a space kernel without a
// disk. Nothing survives the process, except what `restart` hands back (the
// checks use it to stand in for a host starting again).

import { checkPath, type Change, type Email, type Files, type Job, type Message, type Records, type Schedule, type Seams, type Secrets, type Stored } from "./index.ts";

const bytes = (data: Uint8Array | string) => (typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
const copy = <T>(value: T): T => structuredClone(value);

export function memoryFiles(): Files {
  const files = new Map<string, Uint8Array>();
  return {
    async read(path) {
      const data = files.get(checkPath(path));
      return data ? new Uint8Array(data) : null;
    },
    async readText(path) {
      const data = files.get(checkPath(path));
      return data ? new TextDecoder().decode(data) : null;
    },
    async write(path, data) {
      files.set(checkPath(path), bytes(data));
    },
    async remove(path) {
      files.delete(checkPath(path));
    },
    async list(prefix) {
      return [...files.keys()].filter((p) => p.startsWith(prefix)).sort();
    },
  };
}

export function memoryRecords(): Records {
  const collections = new Map<string, Map<string, Stored>>();
  const log: Change[] = [];
  let seq = 0;
  const of = (collection: string) => collections.get(collection) ?? collections.set(collection, new Map()).get(collection)!;
  const stale = (current: Stored | undefined) => ({ ok: false as const, stale: true as const, current: current ? copy(current) : null });
  return {
    async get(collection, id) {
      const r = of(collection).get(id);
      return r ? copy(r) : null;
    },
    async list(collection) {
      return [...of(collection).values()].map(copy);
    },
    async put(collection, id, value, base) {
      const current = of(collection).get(id);
      if (base !== undefined && base !== (current?.version ?? 0)) return stale(current);
      seq++;
      of(collection).set(id, { id, version: seq, value: copy(value) });
      log.push({ seq, collection, id, ...(current && { before: copy(current.value) }), after: copy(value) });
      return { ok: true, seq };
    },
    async remove(collection, id, base) {
      const current = of(collection).get(id);
      if (!current) return { ok: false, stale: false, missing: true };
      if (base !== undefined && base !== current.version) return stale(current);
      seq++;
      of(collection).delete(id);
      log.push({ seq, collection, id, before: copy(current.value) });
      return { ok: true, seq };
    },
    async changes(since, limit = 500) {
      return log.filter((c) => c.seq > since).slice(0, limit).map(copy);
    },
  };
}

const MAX_WAIT = 2 ** 31 - 1;

/**
 * A schedule on timers. `restart()` gives a new schedule holding the same jobs, as a host would after a
 * restart. A job whose handler fails is passed to `onError` (by default, logged).
 */
export function memorySchedule(jobs = new Map<string, Job>(), onError = (name: string, error: unknown) => console.error(`Job ${name} failed:`, error)): Schedule & { restart(): Schedule } {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let handler: (name: string) => void | Promise<void> = () => {};
  let stopped = false;
  const arm = (job: Job) => {
    clearTimeout(timers.get(job.name));
    timers.set(
      job.name,
      // A timer waits at most about 24 days, so a later job wakes on the way and waits again.
      setTimeout(async () => {
        timers.delete(job.name);
        if (stopped || jobs.get(job.name) !== job) return;
        if (Date.now() < job.at) return arm(job);
        if (job.every) {
          // The next run is the first one still ahead, counted from when this one was due: a slow handler
          // doesn't drift the schedule, and a job missed many times while down runs once, not once per miss.
          const missed = Math.floor((Date.now() - job.at) / job.every) + 1;
          const next = { ...job, at: job.at + missed * job.every };
          jobs.set(job.name, next);
          arm(next);
        } else jobs.delete(job.name);
        try {
          await handler(job.name);
        } catch (error) {
          // Nothing waits on a timer, so a failing job is reported here rather than taking the host down.
          onError(job.name, error);
        }
      }, Math.min(MAX_WAIT, Math.max(0, job.at - Date.now()))),
    );
  };
  return {
    async set(job) {
      if (!job.name || !(job.at >= 0) || (job.every !== undefined && !(job.every >= 1000))) throw new Error("A job has a name, a time, and repeats at most once a second");
      const kept = copy(job);
      jobs.set(job.name, kept);
      arm(kept);
    },
    async cancel(name) {
      jobs.delete(name);
      clearTimeout(timers.get(name));
      timers.delete(name);
    },
    async list() {
      return [...jobs.values()].map(copy).sort((a, b) => a.at - b.at);
    },
    onDue(h) {
      handler = h;
      for (const job of jobs.values()) arm(job);
    },
    stop() {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
    restart() {
      this.stop();
      return memorySchedule(jobs, onError);
    },
  };
}

export function memorySecrets(values: Record<string, string> = {}): Secrets {
  return {
    async get(name) {
      return Object.hasOwn(values, name) ? values[name] : undefined;
    },
    async names() {
      return Object.keys(values).sort();
    },
  };
}

/** Email that is only written down: `sent` holds every message, for checks and for a development host. */
export function memoryEmail(): Email & { sent: Message[] } {
  const sent: Message[] = [];
  return {
    sent,
    async send(message) {
      if (!message.to?.length || message.to.some((to) => !/^[^@\s]+@[^@\s]+$/.test(to))) return { ok: false, error: "Every recipient needs an email address" };
      sent.push(copy(message));
      return { ok: true, id: `memory-${sent.length}` };
    },
  };
}

export function memorySeams(secrets: Record<string, string> = {}): Seams {
  return { files: memoryFiles(), records: memoryRecords(), schedule: memorySchedule(), secrets: memorySecrets(secrets), email: memoryEmail() };
}
