// Developer experience tooling:
//   - `scripts/test-app.mjs` (`createTestHarness` and `extensible-app test`):
//     boots the real kernel in memory against `src/seams/memory.ts`, runs linked
//     plugins in `node:worker_threads`, renders `<template id>` views, dispatches
//     UI actions and commands, and exercises reviewed cross-plugin writes in <1 s.
//   - `scripts/types.mjs` (`npm run types`, `.extensible/types.d.ts`):
//     builds self-contained TypeScript declarations (`Manifest`, `Api`/`Ctx`,
//     `View`, `Schema` and typed `ctx.call` overloads from `docs/api.md`),
//     checked by `tsc --noEmit --strict`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeProject } from "../../scripts/create-app.mjs";
import { layoutProject, siteEntries, test as testProject } from "../../scripts/extensible-app.mjs";
import { createTestHarness } from "../../scripts/test-app.mjs";
import { generateTypes, writeProjectTypes, writeTypes } from "../../scripts/types.mjs";

const TSC = resolve(
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);

function runTsc(args) {
  const res = spawnSync(TSC, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

export default async function ({ check }) {
  // Warm bundle cache or measure cold+warm — even cold, habits + starter + review finishes well under 1 s!
  const startedAt = performance.now();

  const habits = await createTestHarness("demos/habits");
  try {
    const emptyHtml = habits.html("main");
    const added = await habits.put("habits", { name: "Morning walk" });
    await habits.act("habits", `tick:${added.id}`, true);
    const view = habits.view("main");
    const item = view?.data?.habits?.[0];
    check(
      "createTestHarness boots demos/habits in memory, adds a habit, ticks it off and updates the live template view",
      /No habits yet/.test(emptyHtml) &&
        added.ok &&
        item?.name === "Morning walk" &&
        item?.today === true &&
        item?.streak === "1 day" &&
        /1 day/.test(view?.html ?? ""),
      JSON.stringify(item),
    );

    // Cross-plugin write: reviewed once with reason and diff, then declined on the next attempt.
    const seen = [];
    const offAccept = habits.onReview((rev) => {
      seen.push({ heading: rev.heading, reason: rev.reason, adds: rev.diff.filter((d) => d.op === "add").length });
      return "accept";
    });
    const approved = await habits.put("habits", { name: "Read 20 pages" }, { as: "coach", reason: "Evening wind-down" });
    offAccept();

    const offDecline = habits.onReview("decline");
    let declinedError = "";
    try {
      await habits.put("habits", { name: "Ice bath" }, { as: "coach", reason: "Optional challenge" });
    } catch (error) {
      declinedError = error.message;
    }
    offDecline();

    const allHabits = await habits.list("habits");
    const changes = await habits.changes();
    check(
      "createTestHarness exercises reviewed cross-plugin writes (reason, diff, accept and decline)",
      approved.ok === true &&
        approved.outcome === "allowed-once" &&
        seen.length === 1 &&
        seen[0].reason === "Evening wind-down" &&
        seen[0].adds > 0 &&
        /declined/i.test(declinedError) &&
        allHabits.length === 2 &&
        Array.isArray(changes) &&
        changes.some((c) => c.plugin === "coach" && c.outcome === "allowed-once") &&
        changes.some((c) => c.plugin === "coach" && c.outcome === "rejected"),
      JSON.stringify({ approved, seen, declinedError, count: allHabits.length }),
    );

    // Plugin commands via ctx.commands.add + harness.command("<plugin>/<id>", args).
    await habits.addPlugin(`export const manifest = { id: "habit-helper", name: "Habit helper", permissions: ["data:read:habits"] };
export default (ctx) => {
  ctx.commands.add(
    { id: "count", title: "Count habits", args: { type: "object", properties: { prefix: { type: "string" } } } },
    async ({ prefix = "" }) => {
      const list = await ctx.call("data", "list", "habits");
      return list.filter((h) => h.name.startsWith(prefix)).length;
    },
  );
};`);
    const listedCommands = await habits.commands();
    const matchedCount = await habits.command("habit-helper/count", { prefix: "Morning" });
    check(
      "createTestHarness lists and runs plugin commands registered with ctx.commands.add",
      listedCommands.some((c) => c.name === "habit-helper/count") && matchedCount === 1,
      JSON.stringify({ listedCommands, matchedCount }),
    );
  } finally {
    await habits.close();
  }

  const starter = await createTestHarness("starter");
  try {
    const first = await starter.put("my-app-items", { title: "Passport" });
    const second = await starter.put("my-app-items", { title: "Charger" });
    await starter.act("my-app", `done:${second.id}`, true);
    const itemsAfterTick = starter.view("main")?.data?.items ?? [];
    const htmlAfterTick = starter.html("main");
    await starter.act("my-app", `remove:${first.id}`);
    const remaining = await starter.list("my-app-items");
    check(
      "createTestHarness boots starter in memory, adds items, ticks done and removes",
      itemsAfterTick.length === 2 &&
        itemsAfterTick[0].title === "Passport" &&
        itemsAfterTick[1].title === "Charger" &&
        itemsAfterTick[1].done === true &&
        /data-done/.test(htmlAfterTick) &&
        remaining.length === 1 &&
        remaining[0].title === "Charger",
      JSON.stringify({ itemsAfterTick, remaining }),
    );
  } finally {
    await starter.close();
  }

  const elapsedMs = Math.round(performance.now() - startedAt);
  check(
    "in-memory harness boots demos/habits and starter, runs UI events, commands and reviews in under 1s",
    elapsedMs < 1000,
    `${elapsedMs} ms`,
  );

  // ---- Project scaffolding, `extensible-app test`, NOT_SERVED exclusion & TypeScript declarations ----
  const scratch = mkdtempSync(join(tmpdir(), "dx-tooling-"));
  try {
    // 1. Standalone `starter/main.js` passes `tsc --noEmit --strict` even before `.extensible/types.d.ts` exists.
    const starterStandalone = runTsc([
      "--noEmit",
      "--strict",
      "--allowJs",
      "--checkJs",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--lib",
      "ES2022,DOM,WebWorker",
      "starter/main.js",
    ]);
    check("starter/main.js with // @ts-check passes tsc before .extensible/types.d.ts exists", starterStandalone.ok, starterStandalone.out);

    // 2. Scaffold a project and verify `package.json`, `app.test.mjs`, `NOT_SERVED` exclusion, and `extensible-app test`.
    const projectDir = join(scratch, "packing-list");
    makeProject(projectDir, { name: "Packing list", platform: `file:${resolve(".")}` });
    mkdirSync(join(projectDir, "plugins"), { recursive: true });
    writeFileSync(join(projectDir, "plugins", "extra.test.mjs"), "// nested test file\n");

    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
    const entries = siteEntries(projectDir);
    const laid = layoutProject(projectDir);
    check(
      "create-app adds npm test (`extensible-app test`) and excludes test files & jsconfig.json from the served site",
      pkg.scripts?.test === "extensible-app test" &&
        existsSync(join(projectDir, "app.test.mjs")) &&
        !("app.test.mjs" in entries) &&
        !("jsconfig.json" in entries) &&
        !existsSync(join(laid.site, "app.test.mjs")) &&
        !existsSync(join(laid.site, "jsconfig.json")) &&
        !existsSync(join(laid.site, "plugins", "extra.test.mjs")),
      JSON.stringify({ scripts: pkg.scripts, keys: Object.keys(entries) }),
    );
    rmSync(join(projectDir, "plugins"), { recursive: true, force: true });

    const testRun = await testProject(projectDir, [], { quiet: true });
    check(
      "extensible-app test runs checkApps static validation, passes starter's app.test.mjs, and writes .extensible/types.d.ts",
      testRun.ok && testRun.check.ok && testRun.tests.ran === 1 && existsSync(join(projectDir, ".extensible", "types.d.ts")),
      testRun.tests.output,
    );

    // 3. `tsc -p jsconfig.json` in the project passes with `.extensible/types.d.ts` present.
    const projectTsc = runTsc(["-p", join(projectDir, "jsconfig.json")]);
    check("project jsconfig.json passes tsc --strict with generated .extensible/types.d.ts", projectTsc.ok, projectTsc.out);

    // 4. `scripts/types.mjs` declarations: Manifest, Api/Ctx, View, Schema, typed ctx.call overloads, and kernel.json filtering.
    const typesOut = join(scratch, "types.d.ts");
    const { text: dtsText } = writeTypes(typesOut);
    const hasCoreShapes =
      dtsText.includes("export interface Manifest") &&
      dtsText.includes("export interface Api") &&
      dtsText.includes("export type Ctx = Api") &&
      dtsText.includes("export type View =") &&
      dtsText.includes("export interface Schema") &&
      dtsText.includes('call(service: "data", method: "put"') &&
      dtsText.includes('call(service: "kernel", method: "ping"');

    const samplePlugin = join(scratch, "typed-plugin.ts");
    writeFileSync(
      samplePlugin,
      `import type { Api, Ctx, Manifest, Schema, View } from "./types.js";

const itemSchema: Schema = {
  type: "object",
  required: ["title"],
  properties: { title: { type: "string", maxLength: 100 } },
};

export const manifest: Manifest = {
  id: "typed-sample",
  name: "Typed sample",
  permissions: ["ui", "data:read:books"],
  collections: { items: { title: "Items", schema: itemSchema } },
};

export default async function (ctx: Ctx) {
  const pong: "pong" = await ctx.call("kernel", "ping");
  const books = await ctx.call<{ title: string }>("data", "list", "books");
  const putRes = await ctx.call("data", "put", "items", { title: pong });
  const view: View = { type: "heading", text: String(books[0]?.title ?? putRes.id) };
  ctx.ui.render("main", "head", view);
  // @ts-expect-error unknown method on data service must fail typechecking
  await ctx.call("data", "definitelyNotAMethod");
}
void (0 as unknown as Api);
`,
    );
    const typedCheck = runTsc([
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--lib",
      "ES2022,DOM,WebWorker",
      typesOut,
      samplePlugin,
    ]);
    check(
      "scripts/types.mjs generates valid self-contained declarations (Manifest, Api/Ctx, View, Schema, typed ctx.call) verified by tsc --noEmit",
      hasCoreShapes && typedCheck.ok,
      typedCheck.out,
    );

    // Filtered project types when `kernel.json` omits modules (e.g. leaves out `bus`).
    writeFileSync(join(projectDir, "kernel.json"), JSON.stringify({ modules: ["debug", "router"] }));
    writeProjectTypes(projectDir);
    const filteredDts = readFileSync(join(projectDir, ".extensible", "types.d.ts"), "utf8");
    check(
      "writeProjectTypes omits services from kernel modules left out of a project's kernel.json",
      filteredDts.includes('service: "router"') && !filteredDts.includes('service: "bus"'),
    );

    // Static check failure stops `extensible-app test` with ok: false.
    const mainJs = readFileSync(join(projectDir, "main.js"), "utf8");
    writeFileSync(join(projectDir, "main.js"), mainJs.replace('permissions: ["ui"]', "permissions: []"));
    const brokenRun = await testProject(projectDir, [], { quiet: true });
    check(
      "extensible-app test fails when checkApps static validation finds an error",
      !brokenRun.ok && !brokenRun.check.ok && brokenRun.tests.ran === 0,
      JSON.stringify(brokenRun.check.problems),
    );
    writeFileSync(join(projectDir, "main.js"), mainJs);
    void generateTypes;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
