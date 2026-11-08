// The `schedule` service: work a plugin wants done later, once or again and
// again, with the `schedule` permission.
// Found by name: this file is src/kernel/services/schedule.ts, so it is `ctx.call("schedule", …)`.
//
//   ctx.schedule.every("digest", 60 * 60 * 1000, async () => { … });
//   ctx.schedule.at("reminder", Date.parse("2026-12-01T09:00:00Z"), async () => { … });
//
// That is two messages (src/sandbox/runtime.ts): a listener on
// `schedule:<name>`, which the kernel names after the plugin
// (`schedule:<plugin> <name>`, remote.ts) so no other plugin can answer it,
// and `every` or `at` here, which keeps the job.
//
// Jobs are kept in the kernel's folder (schedule/jobs.json), so on a space's
// server they outlive a restart: one that came due while the space was
// stopped runs once when it starts again, and a repeating one doesn't run
// once per miss. A host that puts a space to sleep (Cloudflare) is asked to
// wake it for the earliest job (`wake` in env.ts). In a browser a job runs
// only while the kernel does.
//
// Setting a job that's already there with the same timing keeps it as it is,
// so a plugin that sets its jobs each time it starts doesn't push them back.

import { env } from "../env";
import { scheduleHook, type ServiceProvider } from "../remote";
import { memorySchedule } from "../../seams/memory.ts";
import type { Job } from "../../seams/index.ts";
import { record } from "../trace";
import type { Kernel } from "./index";

const FILE = "schedule/jobs.json";
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
/** The shortest repeat: a minute on a server would do, but a second keeps checks quick. */
const MIN_EVERY = 1000;
const MAX_JOBS = 20;
/** How long a job that comes due waits for its plugin to start and listen (a space just woken). */
const WAIT_FOR_PLUGIN = 15_000;

const base = (instance: string) => instance.split("@")[0];
/** The kernel's name for a plugin's job. */
const jobName = (plugin: string, name: string) => `${plugin} ${name}`;

export default ({ root, store, remote }: Kernel): ServiceProvider => {
  const jobs = new Map<string, Job>();
  const timers = memorySchedule(jobs, (name, error) => record({ kind: "error", name: "schedule:failed", detail: `${name}: ${error instanceof Error ? error.message : error}` }));

  /** Tells the host when to wake the space next, and keeps the jobs. */
  const saved = async () => {
    await store.writeJson(FILE, [...jobs.values()]);
    const next = [...jobs.values()].reduce<number | undefined>((soonest, job) => (soonest === undefined || job.at < soonest ? job.at : soonest), undefined);
    env().wake?.(next);
  };

  // Read once the folder is open; jobs that came due meanwhile run now.
  const loaded = store.readJson<Job[]>(FILE, []).then((list) => {
    for (const job of Array.isArray(list) ? list : []) if (job && typeof job.name === "string" && typeof job.at === "number") jobs.set(job.name, job);
    timers.onDue(due);
    env().wake?.([...jobs.values()].reduce<number | undefined>((s, j) => (s === undefined || j.at < s ? j.at : s), undefined));
  });

  async function due(name: string): Promise<void> {
    const [plugin, job] = name.split(" ");
    // Its plugin is gone: so is the job.
    if (!remote.installed.has(plugin)) {
      jobs.delete(name);
      return void (await saved());
    }
    const hook = scheduleHook(plugin, job);
    const listening = () => [...remote.live.values()].some((live) => base(live.instance) === plugin && live.heard.includes(hook));
    for (let waited = 0; !listening() && waited < WAIT_FOR_PLUGIN; waited += 250) await new Promise((r) => setTimeout(r, 250));
    await saved();
    if (!listening()) return void record({ kind: "error", name: "schedule:missed", plugin, detail: `${job}: the plugin isn't listening for it` });
    const trace = `job-${Math.random().toString(36).slice(2, 8)}`;
    record({ kind: "lifecycle", name: "schedule:run", plugin, trace, detail: job });
    await root.bail({ trace }, hook);
  }

  async function set(instance: string, name: unknown, at: number, every?: number): Promise<true> {
    if (typeof name !== "string" || !NAME.test(name)) throw new Error("A job's name is lowercase letters, digits and dashes, starting with a letter");
    await loaded;
    const plugin = base(instance);
    const key = jobName(plugin, name);
    const had = jobs.get(key);
    // Set again with the same timing (as a plugin does each time it starts): left as it is.
    if (had && (every !== undefined ? had.every === every : had.every === undefined && had.at === at)) return true;
    if (!had && [...jobs.keys()].filter((k) => k.startsWith(`${plugin} `)).length >= MAX_JOBS) throw new Error(`A plugin can keep at most ${MAX_JOBS} jobs`);
    await timers.set({ name: key, at, ...(every !== undefined ? { every } : {}) });
    await saved();
    return true;
  }

  return {
    description: "Schedule: work a plugin wants done later, once or every so often. On a space's server a job wakes the space, even after a restart.",
    methods: {
      every: {
        args: "(name, ms)",
        returns: "true",
        description: `Runs the caller's job \`name\` every \`ms\` milliseconds (at least ${MIN_EVERY}), first one interval from now. Use \`ctx.schedule.every(name, ms, handler)\`, which also listens for it.`,
      },
      at: {
        args: "(name, when)",
        returns: "true",
        description: "Runs the caller's job `name` once, at `when` (ms since 1970). Use `ctx.schedule.at(name, when, handler)`.",
      },
      cancel: { args: "(name)", returns: "true", description: "Stops one of the caller's jobs and forgets it." },
      list: { args: "()", returns: "[{ name, at, every? }]", description: "The caller's jobs, soonest first." },
    },
    capability: () => "schedule",
    call: async (instance, method, args) => {
      if (method === "every") {
        const ms = Number(args[1]);
        if (!Number.isFinite(ms) || ms < MIN_EVERY) throw new Error(`A job repeats at most once every ${MIN_EVERY} ms`);
        return set(instance, args[0], Date.now() + ms, Math.round(ms));
      }
      if (method === "at") {
        const when = Number(args[1]);
        if (!Number.isFinite(when)) throw new Error("A job's time is ms since 1970, such as Date.parse(\"2026-12-01T09:00:00Z\")");
        return set(instance, args[0], when);
      }
      await loaded;
      const plugin = base(instance);
      if (method === "cancel") {
        const key = jobName(plugin, String(args[0]));
        if (jobs.has(key)) {
          await timers.cancel(key);
          await saved();
        }
        return true;
      }
      if (method === "list") return (await timers.list()).filter((j) => j.name.startsWith(`${plugin} `)).map((j) => ({ ...j, name: j.name.slice(plugin.length + 1) }));
      throw new Error(`schedule has no method ${method}`);
    },
  };
};
