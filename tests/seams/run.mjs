// Conformance checks for the seams (src/seams/): every provider must
// pass the same ones, so a space can move from one host to another. Run with
// `npm run test:seams`; the main test run calls it too (tests/checks/seams.mjs).
//
// Each provider below makes a fresh set of seams; `restart` makes the set a
// host would have after starting again, to check what survives.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryEmail, memoryFiles, memoryRecords, memorySchedule, memorySecrets } from "../../src/seams/memory.ts";
import { nodeFiles, nodeOutbox, nodeRecords, nodeSchedule, nodeSecrets } from "../../src/seams/node.ts";
import { durableFiles } from "../../src/seams/durable.ts";
import { DatabaseSync } from "node:sqlite";

/** A Durable Object's `ctx.storage.sql`, on Node's SQLite: the same statements, the same rows. */
const durableSql = (file) => {
  const db = new DatabaseSync(file);
  const bind = (b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b);
  // As in a Durable Object, the statement runs at once; toArray gives its rows.
  return {
    close: () => db.close(),
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      const rows = /^\s*select/i.test(query) ? statement.all(...bindings.map(bind)) : (statement.run(...bindings.map(bind)), []);
      return { toArray: () => rows };
    },
  };
};

// A job that fails is reported, and the host keeps going: the checks count reports instead of logging them.
const failures = [];
const quietly = (jobs) => memorySchedule(jobs, (name) => failures.push(name));

const providers = {
  memory: async () => {
    const files = memoryFiles();
    const records = memoryRecords();
    const schedule = quietly();
    return {
      seams: { files, records, schedule, secrets: memorySecrets({ OPENAI_KEY: "sk-test", QUOTED: "a b" }), email: memoryEmail() },
      // In memory, a restart keeps what a host's storage would keep.
      restart: async () => ({ files, records, schedule: schedule.restart() }),
      done: async () => schedule.stop(),
    };
  },
  // Cloudflare's files: a Durable Object's SQLite database. The other seams there come later (step 4).
  durable: async () => {
    const dir = await mkdtemp(join(tmpdir(), "seams-do-"));
    // Each start opens the database again, as a Durable Object coming back would; each is closed at the end.
    const opened = [];
    const files = () => durableFiles(opened[opened.push(durableSql(join(dir, "space.sqlite"))) - 1]);
    const schedule = quietly();
    const records = memoryRecords();
    return {
      seams: { files: files(), records, schedule, secrets: memorySecrets({ OPENAI_KEY: "sk-test", QUOTED: "a b" }), email: memoryEmail() },
      restart: async () => ({ files: files(), records, schedule: schedule.restart() }),
      done: async () => {
        schedule.stop();
        for (const sql of opened) sql.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  },
  node: async () => {
    const dir = await mkdtemp(join(tmpdir(), "seams-"));
    await writeFile(join(dir, ".env"), '# keys\nOPENAI_KEY=sk-test\nQUOTED="a b"\n');
    let schedule = await nodeSchedule(join(dir, "schedule.json"), (name) => failures.push(name));
    const open = () => ({ files: nodeFiles(join(dir, "files")), records: nodeRecords(join(dir, "records.sqlite")) });
    return {
      seams: { ...open(), schedule, secrets: await nodeSecrets(join(dir, ".env")), email: nodeOutbox(join(dir, "outbox")) },
      restart: async () => {
        schedule.stop();
        schedule = await nodeSchedule(join(dir, "schedule.json"), (name) => failures.push(name));
        return { ...open(), schedule };
      },
      done: async () => {
        schedule.stop();
        await rm(dir, { recursive: true, force: true });
      },
      // A link inside the folder to a folder outside it.
      link: async () => {
        await mkdir(join(dir, "elsewhere"), { recursive: true });
        await writeFile(join(dir, "elsewhere", "private.txt"), "private");
        await symlink(join(dir, "elsewhere"), join(dir, "files", "linked"));
        return "linked/private.txt";
      },
      // A schedule file that is there but can't be read as one.
      corrupt: async () => {
        await writeFile(join(dir, "broken.json"), "{ not json");
        return nodeSchedule(join(dir, "broken.json")).then(() => false, () => true);
      },
    };
  },
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function suite(name, make) {
  const { seams, restart, done, link, corrupt } = await make();
  const { files, records, schedule, secrets, email } = seams;
  const check = (what, ok, detail = "") => results.push({ provider: name, what, ok: !!ok, detail });
  const refuses = async (fn) => fn().then(() => false, () => true);
  try {
    // Files
    await files.write("plugins/notes.js", "export const manifest = {};");
    await files.write("plugins/img/tram.svg", new Uint8Array([60, 115, 118, 103]));
    await files.write("settings.json", "{}");
    check("files: what is written reads back, as text and bytes", (await files.readText("plugins/notes.js")) === "export const manifest = {};" && (await files.read("plugins/img/tram.svg"))?.length === 4);
    check("files: list gives every path under a folder, sorted", JSON.stringify(await files.list("plugins/")) === JSON.stringify(["plugins/img/tram.svg", "plugins/notes.js"]), JSON.stringify(await files.list("plugins/")));
    await files.remove("settings.json");
    await files.remove("never-was.json");
    check("files: a removed or missing file reads as null", (await files.readText("settings.json")) === null && (await files.read("nope/x")) === null);
    if (link) {
      const linked = await link();
      check("files: a link inside the folder can't lead out of it", (await refuses(() => files.readText(linked))) && (await refuses(() => files.write(linked, "x"))) && !(await files.list("")).includes(linked));
    }
    check("files: paths can't leave the folder", (await refuses(() => files.write("../escape.txt", "x"))) && (await refuses(() => files.read("/etc/passwd"))) && (await refuses(() => files.readText("a//b"))));

    // Records
    const first = await records.put("books", "b1", { title: "Dune" }, 0);
    const again = await records.put("books", "b1", { title: "Dune (again)" }, 0);
    check("records: a put based on version 0 creates, and a second one is stale", first.ok && again.ok === false && again.stale && again.current?.value.title === "Dune", JSON.stringify({ first, again }));
    const edit = await records.put("books", "b1", { title: "Dune Messiah" }, first.seq);
    const late = await records.put("books", "b1", { title: "Children of Dune" }, first.seq);
    check("records: a put based on the current version wins; one based on an older version is refused", edit.ok && late.ok === false && late.stale && late.current?.version === edit.seq);
    await records.put("books", "b2", { title: "Emma" });
    const got = await records.get("books", "b1");
    const listed = await records.list("books");
    check("records: get and list return the record, its version and its fields", got?.version === edit.seq && got.value.title === "Dune Messiah" && listed.length === 2, JSON.stringify(listed));
    got.value.title = "changed by the caller";
    check("records: what comes back is a copy", (await records.get("books", "b1")).value.title === "Dune Messiah");
    const removedStale = await records.remove("books", "b2", 1);
    const removed = await records.remove("books", "b2");
    const missing = await records.remove("books", "b2");
    check("records: remove checks the version, removes, and says when there was nothing", removedStale.ok === false && removedStale.stale && removed.ok && missing.ok === false && missing.missing, JSON.stringify({ removedStale, removed, missing }));
    const all = await records.changes(0);
    const after = await records.changes(edit.seq);
    check(
      "records: the change log holds every accepted change in order, and catches up from any point",
      all.length === 4 && all.every((c, i) => i === 0 || c.seq > all[i - 1].seq) && all[1].before?.title === "Dune" && all[3].after === undefined && after.length === 2 && after[0].id === "b2",
      JSON.stringify(all),
    );
    check("records: collections are separate", (await records.get("films", "b1")) === null && (await records.list("films")).length === 0);

    // Schedule
    const heard = [];
    schedule.onDue((name) => void heard.push(name));
    await schedule.set({ name: "soon", at: Date.now() + 50 });
    await schedule.set({ name: "later", at: Date.now() + 60_000, every: 3_600_000 });
    await schedule.set({ name: "gone", at: Date.now() + 50 });
    await schedule.cancel("gone");
    await wait(200);
    check("schedule: a job runs when it comes due, once; a cancelled one doesn't", JSON.stringify(heard) === JSON.stringify(["soon"]), JSON.stringify(heard));
    check("schedule: a job that ran once is gone; a repeating one stays", JSON.stringify((await schedule.list()).map((j) => j.name)) === JSON.stringify(["later"]));
    check("schedule: a job repeats at most once a second", await refuses(() => schedule.set({ name: "busy", at: Date.now(), every: 10 })));

    // A failing job is reported, and doesn't stop the others.
    schedule.onDue((name) => {
      heard.push(name);
      if (name === "fails") throw new Error("broken job");
    });
    await schedule.set({ name: "fails", at: Date.now() });
    await schedule.set({ name: "after", at: Date.now() + 30 });
    await wait(120);
    check("schedule: a job that fails is reported, and the next still runs", heard.includes("fails") && heard.includes("after") && failures.includes("fails"), JSON.stringify({ heard, failures }));
    // A wait longer than a timer can hold (about 24 days) waits, rather than running at once.
    await schedule.set({ name: "next-month", at: Date.now() + 30 * 86_400_000 });
    await wait(60);
    check("schedule: a job a month away doesn't run now", !heard.includes("next-month"));
    await schedule.cancel("next-month");

    // What survives a restart: the host stops, a job comes due while it's down, and it starts again.
    await schedule.set({ name: "missed", at: Date.now() + 50 });
    await schedule.set({ name: "hourly", at: Date.now() + 50, every: 1000 });
    schedule.stop();
    await wait(2300);
    const back = await restart();
    const heardAfter = [];
    back.schedule.onDue((name) => void heardAfter.push(name));
    // Both missed jobs run as the host starts again; a slow machine (CI) can take longer than a moment, so wait for
    // them, but not as long as "hourly"'s next time (a second), which would run it twice.
    for (let waited = 0; waited < 900 && !(heardAfter.includes("missed") && heardAfter.includes("hourly")); waited += 20) await wait(20);
    const hourly = (await back.schedule.list()).find((j) => j.name === "hourly");
    check("restart: a repeating job missed several times runs once, then waits for its next time", heardAfter.filter((n) => n === "hourly").length === 1 && hourly?.at > Date.now(), JSON.stringify({ heardAfter, hourly }));
    await back.schedule.cancel("hourly");
    check("restart: files, records and jobs survive, and a job due while down still runs", (await back.files.readText("plugins/notes.js")) !== null && (await back.records.get("books", "b1"))?.value.title === "Dune Messiah" && (await back.records.changes(0)).length === 4 && heardAfter.includes("missed") && (await back.schedule.list()).some((j) => j.name === "later"), JSON.stringify(heardAfter));
    back.schedule.stop();
    if (corrupt) check("restart: a schedule file that can't be read stops the host, rather than starting with no jobs", await corrupt());

    // Secrets and email
    check("secrets: reads values, quoted or not, and lists their names", (await secrets.get("OPENAI_KEY")) === "sk-test" && (await secrets.get("QUOTED")) === "a b" && (await secrets.get("NOPE")) === undefined && (await secrets.names()).includes("OPENAI_KEY"));
    const sent = await email.send({ to: ["paul@example.com"], subject: "Weekly digest", text: "3 new answers" });
    const bad = await email.send({ to: ["not an address"], subject: "x", text: "x" });
    check("email: sends to addresses, and refuses what isn't one", sent.ok && typeof sent.id === "string" && bad.ok === false, JSON.stringify({ sent, bad }));
  } catch (error) {
    check("the checks ran to the end", false, error?.stack ?? String(error));
  } finally {
    await done();
  }
}

for (const [name, make] of Object.entries(providers)) await suite(name, make);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.provider}: ${r.what}${r.detail && !r.ok ? `  (${r.detail})` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} seam checks passed`);
process.exit(failed ? 1 : 0);
