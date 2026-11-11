// Collection queries (`data.query`), Durable SQLite `Records` seam + optional
// `collections` seam delegation, schema `x-ref` and `x-ownership` extensions,
// and `<ui-form>` / `<ui-table>` `x-ref`, `filterable` and `page-size` upgrades.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { durableRecords } from "../../src/seams/durable.ts";
import { memoryFiles, memoryRecords } from "../../src/seams/memory.ts";
import { measure, TALLEST_CONTROL } from "./layout-sanity.mjs";
import { watchErrors } from "../page-errors.mjs";

/** Bundles TypeScript kernel/shared modules with extensionless imports for Node ESM, as outside-file.mjs does. */
async function loadKernelParts() {
  const root = fileURLToPath(new globalThis.URL("../..", import.meta.url));
  const entry = `
    export { Context } from "cordis";
    export { Store } from "./src/kernel/store.ts";
    export { Hosts } from "./src/kernel/hosts.ts";
    export { RemotePlugins } from "./src/kernel/remote.ts";
    export { collections } from "./src/kernel/records.ts";
    export { checkSchema, SCHEMA_KEYWORDS } from "./src/kernel/schema.ts";
    export { COMPONENTS } from "./src/shared/html.ts";
  `;
  const out = await build({ stdin: { contents: entry, resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", mainFields: ["module", "main"], logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}

const durableSql = (file) => {
  const db = new DatabaseSync(file);
  const bind = (b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b);
  return {
    close: () => db.close(),
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      const rows = /^\s*select/i.test(query) ? statement.all(...bindings.map(bind)) : (statement.run(...bindings.map(bind)), []);
      return { toArray: () => rows };
    },
  };
};

export default async function ({ check, context, URL: siteUrl, errors }) {
  const { Context, Store, Hosts, RemotePlugins, collections, checkSchema, SCHEMA_KEYWORDS, COMPONENTS } = await loadKernelParts();
  // 1. Durable SQLite Records seam conformance (versioning, copy isolation, change log, restart).
  const dir = await mkdtemp(join(tmpdir(), "durable-records-"));
  const sql1 = durableSql(join(dir, "space.sqlite"));
  try {
    const rec = durableRecords(sql1);
    const first = await rec.put("books", "b1", { title: "Dune" }, 0);
    const staleCreate = await rec.put("books", "b1", { title: "Dune 2" }, 0);
    const updated = await rec.put("books", "b1", { title: "Dune Messiah" }, first.ok ? first.seq : -1);
    await rec.put("books", "b2", { title: "Emma" });
    const got = await rec.get("books", "b1");
    if (got) got.value.title = "mutated";
    const fresh = await rec.get("books", "b1");
    const staleDel = await rec.remove("books", "b2", 1);
    const okDel = await rec.remove("books", "b2");
    const missingDel = await rec.remove("books", "b2");
    const log = await rec.changes(0);
    sql1.close();

    const sql2 = durableSql(join(dir, "space.sqlite"));
    const reopened = durableRecords(sql2);
    const survived = await reopened.get("books", "b1");
    const survivedLog = await reopened.changes(0);
    sql2.close();

    check(
      "durableRecords stores versioned records, isolates copies, logs changes in order, and survives reopen",
      first.ok &&
        !staleCreate.ok &&
        staleCreate.stale &&
        updated.ok &&
        fresh?.value.title === "Dune Messiah" &&
        !staleDel.ok &&
        staleDel.stale &&
        okDel.ok &&
        !missingDel.ok &&
        missingDel.missing &&
        log.length === 4 &&
        survived?.value.title === "Dune Messiah" &&
        survivedLog.length === 4,
      JSON.stringify({ first, staleCreate, updated, fresh, staleDel, okDel, missingDel, survived }),
    );
  } finally {
    try {
      sql1.close();
    } catch {}
    await rm(dir, { recursive: true, force: true });
  }

  // 2. collections(...) optional Records seam delegation + legacy collections/<name>.json migration.
  {
    const files = memoryFiles();
    await files.write(
      "collections/notes.json",
      JSON.stringify({ n1: { id: "n1", title: "Legacy note", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } }),
    );
    const root = new Context();
    const store = new Store(root);
    store.use(files);
    const hosts = new Hosts();
    const services = {};
    const remote = new RemotePlugins(root, hosts, services);
    const seam = memoryRecords();
    const cols = collections(root, store, hosts, remote, async () => "allowed-once", seam);
    await cols.ready;
    const manifest = {
      id: "notes-owner",
      name: "Notes",
      permissions: [],
      collections: { notes: { title: "Notes", schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } } } },
    };
    remote.installed.set("notes-owner", { id: "notes-owner", source: "", manifest, caps: new Set(), origin: "app", enabled: true });
    cols.register(manifest);
    const migrated = await cols.records("notes");
    const written = await cols.write("notes-owner", "notes", "n2", { title: "Seam note" }, "", {});
    const seamRows = await seam.list("notes");
    await cols.write("notes-owner", "notes", "n1", null, "", {});
    const afterDelete = await seam.list("notes");
    check(
      "collections delegates storage to an injected Records seam while migrating existing collections/<name>.json records",
      migrated.length === 1 &&
        migrated[0].title === "Legacy note" &&
        written.ok &&
        seamRows.length === 2 &&
        afterDelete.length === 1 &&
        afterDelete[0].id === "n2",
      JSON.stringify({ migrated, written, seamRows, afterDelete }),
    );
  }

  // 3. Schema extensions (`x-ref` and `x-ownership`) + html.ts component attribute docs.
  {
    const refuses = (fn) => {
      try {
        fn();
        return false;
      } catch {
        return true;
      }
    };
    let validOk = false;
    try {
      checkSchema({
        type: "object",
        "x-ownership": "creator",
        properties: {
          authorId: { type: "string", "x-ref": { collection: "authors", label: "name" } },
          reviewerId: { type: "string", "x-ref": { collection: "authors" } },
        },
      });
      validOk = true;
    } catch {}
    check(
      "schema supports x-ref and x-ownership keywords and rejects malformed definitions",
      validOk &&
        "x-ref" in SCHEMA_KEYWORDS &&
        "x-ownership" in SCHEMA_KEYWORDS &&
        refuses(() => checkSchema({ type: "string", "x-ref": { collection: "Bad_Name!" } })) &&
        refuses(() => checkSchema({ type: "string", "x-ref": { collection: "authors", extra: true } })) &&
        refuses(() => checkSchema({ type: "object", "x-ownership": "nobody" })),
    );
    check(
      "ui-table documents filterable and page-size in COMPONENTS['ui-table'].attributes",
      COMPONENTS["ui-table"].attributes.includes("filterable") && COMPONENTS["ui-table"].attributes.includes("page-size"),
      COMPONENTS["ui-table"].attributes,
    );
  }

  // 4. End-to-end browser checks: data.query, tools integration, x-ref in ui-form & ui-table, filterable & page-size.
  const own = await context.browser().newContext({ viewport: { width: 1280, height: 800 } });
  const page = await own.newPage();
  watchErrors(page, errors, "data-query-xref");
  await page.goto(`${siteUrl}workbench/`);
  await page.waitForFunction(() => window.__host, null, { timeout: 10000 });

  const install = (src) => page.evaluate((source) => window.__host.command("install", source), src);
  const uninstall = (id) => page.evaluate((pluginId) => window.__host.command("uninstall", pluginId), id);
  const pluginLog = (id, prefix) =>
    page
      .waitForFunction(([i, p]) => window.__host.traces.findLast((e) => e.plugin === i && e.detail?.startsWith(p)), [id, prefix], { timeout: 8000 })
      .then((h) => h.jsonValue())
      .then((e) => e.detail);

  try {
    // 4a. data.query: equality, $gt/$gte/$lt/$lte, $contains, $in, search, sort, limit/offset, tools, and gate denial.
    await install(`export const manifest = {
      id: "dq-catalog",
      name: "Catalog",
      permissions: ["ui"],
      collections: {
        dqitems: {
          title: "Catalog",
          schema: {
            type: "object",
            required: ["title", "year"],
            "x-ownership": "any",
            properties: {
              title: { type: "string", title: "Title" },
              author: { type: "string", title: "Author" },
              genre: { type: "string" },
              year: { type: "integer", title: "Year" },
              tags: { type: "array", items: { type: "string" } }
            }
          }
        }
      }
    };
    export default async (ctx) => {
      const seed = [
        { title: "Dune", author: "Frank Herbert", genre: "sci-fi", year: 1965, tags: ["hugo", "nebula"] },
        { title: "The Left Hand of Darkness", author: "Ursula K. Le Guin", genre: "sci-fi", year: 1969, tags: ["hugo", "nebula"] },
        { title: "A Wizard of Earthsea", author: "Ursula K. Le Guin", genre: "fantasy", year: 1968, tags: ["classic"] },
        { title: "Kindred", author: "Octavia E. Butler", genre: "sci-fi", year: 1979, tags: ["classic"] },
        { title: "Middlemarch", author: "George Eliot", genre: "classic", year: 1871, tags: ["victorian"] }
      ];
      for (const item of seed) await ctx.call("data", "put", "dqitems", item);

      const eq = await ctx.call("data", "query", "dqitems", { where: { genre: "fantasy" } });
      const range = await ctx.call("data", "query", "dqitems", { where: { year: { $gte: 1965, $lt: 1975 } }, sort: "year" });
      const gtLte = await ctx.call("data", "query", "dqitems", { where: { year: { $gt: 1871, $lte: 1968 } }, sort: "-year" });
      const containsStr = await ctx.call("data", "query", "dqitems", { where: { title: { $contains: "darkness" } } });
      const containsArr = await ctx.call("data", "query", "dqitems", { where: { tags: { $contains: "nebula" } }, sort: "title" });
      const inOp = await ctx.call("data", "query", "dqitems", { where: { genre: { $in: ["fantasy", "classic"] } }, sort: "year" });
      const searched = await ctx.call("data", "query", "dqitems", { search: "LE GUIN", sort: "title" });
      const page1 = await ctx.call("data", "query", "dqitems", { sort: "year", limit: 2, offset: 0 });
      const page3 = await ctx.call("data", "query", "dqitems", { sort: "year", limit: 2, offset: 4 });
      const tools = await ctx.call("tools", "list");
      const viaTool = await ctx.call("tools", "call", "data_query_dqitems", { query: { where: { author: "George Eliot" } } });

      ctx.log("dq-results " + JSON.stringify({
        eq: eq.records.map((r) => r.title),
        range: range.records.map((r) => r.year),
        gtLte: gtLte.records.map((r) => r.year),
        containsStr: containsStr.records.map((r) => r.title),
        containsArr: containsArr.records.map((r) => r.title),
        inOp: inOp.records.map((r) => r.title),
        searched: searched.records.map((r) => r.title),
        page1: { titles: page1.records.map((r) => r.title), total: page1.total, hasMore: page1.hasMore },
        page3: { titles: page3.records.map((r) => r.title), total: page3.total, hasMore: page3.hasMore },
        hasTool: tools.some((t) => t.name === "data_query_dqitems"),
        viaTool: viaTool.records.map((r) => r.title)
      }));

      ctx.ui.render("main", "table", '<ui-table collection="dqitems" columns="title,author,year" sort="year" filterable page-size="2"></ui-table>');
    };`);

    const dqRaw = await pluginLog("dq-catalog", "dq-results ");
    const dq = JSON.parse(dqRaw.slice("dq-results ".length));
    check(
      "data.query filters with equality, $gt, $gte, $lt, $lte, $contains and $in",
      JSON.stringify(dq.eq) === '["A Wizard of Earthsea"]' &&
        JSON.stringify(dq.range) === "[1965,1968,1969]" &&
        JSON.stringify(dq.gtLte) === "[1968,1965]" &&
        JSON.stringify(dq.containsStr) === '["The Left Hand of Darkness"]' &&
        JSON.stringify(dq.containsArr) === '["Dune","The Left Hand of Darkness"]' &&
        JSON.stringify(dq.inOp) === '["Middlemarch","A Wizard of Earthsea"]',
      JSON.stringify(dq),
    );
    check(
      "data.query supports case-insensitive search, sort, limit/offset pagination, and tools.call",
      JSON.stringify(dq.searched) === '["A Wizard of Earthsea","The Left Hand of Darkness"]' &&
        JSON.stringify(dq.page1) === '{"titles":["Middlemarch","Dune"],"total":5,"hasMore":true}' &&
        JSON.stringify(dq.page3) === '{"titles":["Kindred"],"total":5,"hasMore":false}' &&
        dq.hasTool === true &&
        JSON.stringify(dq.viaTool) === '["Middlemarch"]',
      JSON.stringify(dq),
    );

    // Permission check on data.query
    await install(`export const manifest = { id: "dq-denied", name: "Denied", permissions: [] };
    export default async (ctx) => {
      try {
        await ctx.call("data", "query", "dqitems", {});
        ctx.log("dq-denied allowed");
      } catch (e) {
        ctx.log("dq-denied " + e.message);
      }
    };`);
    const deniedMsg = await pluginLog("dq-denied", "dq-denied ");
    check("data.query requires data:read:<collection>", deniedMsg === "dq-denied Missing capability data:read:dqitems", deniedMsg);

    // 4b. <ui-table filterable page-size="2"> client-side search, pagination, and DESIGN.md layout sanity.
    const tableHost = 'main [data-key="dq-catalog:table"] ui-table';
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.shadowRoot?.querySelectorAll("tbody tr").length === 2,
      tableHost,
      { timeout: 8000 },
    );

    const readTableState = () =>
      page.evaluate((sel) => {
        const root = document.querySelector(sel)?.shadowRoot;
        const rows = [...(root?.querySelectorAll("tbody tr") ?? [])].map((tr) =>
          [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim()),
        );
        const count = root?.querySelector(".page-count")?.textContent?.trim() ?? null;
        const buttons = [...(root?.querySelectorAll("button.pager-btn") ?? [])];
        const prevDisabled = buttons[0]?.disabled ?? null;
        const nextDisabled = buttons[1]?.disabled ?? null;
        const hasSearch = !!root?.querySelector('input[type="search"]');
        return { rows, count, prevDisabled, nextDisabled, hasSearch };
      }, tableHost);

    const p1 = await readTableState();
    check(
      "ui-table with page-size=2 shows the first page, 1–2 of 5 count, and disables Previous",
      p1.hasSearch &&
        p1.count === "1–2 of 5" &&
        p1.prevDisabled === true &&
        p1.nextDisabled === false &&
        JSON.stringify(p1.rows.map((r) => r[0])) === '["Middlemarch","Dune"]',
      JSON.stringify(p1),
    );

    // Layout sanity on filterable + paginated ui-table at desktop (1280px) and phone (390px)
    const desktopFindings = await page.evaluate(measure, TALLEST_CONTROL);
    await page.setViewportSize({ width: 390, height: 844 });
    const phoneFindings = await page.evaluate(measure, TALLEST_CONTROL);
    await page.setViewportSize({ width: 1280, height: 800 });
    check(
      "filterable paginated ui-table passes DESIGN.md layout rules at desktop and 390px phone width",
      desktopFindings.length === 0 && phoneFindings.length === 0,
      JSON.stringify({ desktopFindings, phoneFindings }),
    );

    // Navigate pages: Next -> 3–4 of 5, Next -> 5–5 of 5, Previous -> 3–4 of 5
    await page.evaluate((sel) => document.querySelector(sel)?.shadowRoot?.querySelectorAll("button.pager-btn")[1]?.click(), tableHost);
    const p2 = await readTableState();
    await page.evaluate((sel) => document.querySelector(sel)?.shadowRoot?.querySelectorAll("button.pager-btn")[1]?.click(), tableHost);
    const p3 = await readTableState();
    await page.evaluate((sel) => document.querySelector(sel)?.shadowRoot?.querySelectorAll("button.pager-btn")[0]?.click(), tableHost);
    const backToP2 = await readTableState();
    check(
      "ui-table Next and Previous buttons paginate rows and update X–Y of Z bounds",
      p2.count === "3–4 of 5" &&
        p2.prevDisabled === false &&
        p2.nextDisabled === false &&
        JSON.stringify(p2.rows.map((r) => r[0])) === '["A Wizard of Earthsea","The Left Hand of Darkness"]' &&
        p3.count === "5–5 of 5" &&
        p3.prevDisabled === false &&
        p3.nextDisabled === true &&
        JSON.stringify(p3.rows.map((r) => r[0])) === '["Kindred"]' &&
        backToP2.count === "3–4 of 5",
      JSON.stringify({ p2, p3, backToP2 }),
    );

    // Filter rows via <input type="search"> and verify focus stays in the search input
    const filteredState = await page.evaluate((sel) => {
      const root = document.querySelector(sel).shadowRoot;
      const input = root.querySelector('input[type="search"]');
      input.focus();
      input.value = "le guin";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return {
        stillFocused: root.activeElement === input,
        titles: [...root.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td")?.textContent?.trim()),
        pagerShown: !!root.querySelector(".pager"),
      };
    }, tableHost);
    check(
      "ui-table filterable search input filters rows client-side while preserving focus and hiding pager when <= page-size",
      filteredState.stillFocused &&
        !filteredState.pagerShown &&
        JSON.stringify(filteredState.titles) === '["A Wizard of Earthsea","The Left Hand of Darkness"]',
      JSON.stringify(filteredState),
    );

    // 4c. x-ref in <ui-form> and <ui-table> WITH and WITHOUT data:read:<refCollection>.
    await install(`export const manifest = {
      id: "xref-authors-owner",
      name: "Authors",
      permissions: [],
      collections: {
        xrefauthors: {
          title: "Authors",
          schema: {
            type: "object",
            required: ["fullName"],
            properties: { fullName: { type: "string", title: "Full name" } }
          }
        }
      }
    };
    export default async (ctx) => {
      await ctx.call("data", "put", "xrefauthors", { id: "a-leguin", fullName: "Ursula K. Le Guin" });
      await ctx.call("data", "put", "xrefauthors", { id: "a-herbert", fullName: "Frank Herbert" });
      ctx.commands.add({ id: "add-butler", title: "Add Butler" }, () =>
        ctx.call("data", "put", "xrefauthors", { id: "a-butler", fullName: "Octavia E. Butler" }),
      );
      ctx.log("xref-authors seeded");
    };`);
    await pluginLog("xref-authors-owner", "xref-authors seeded");

    // Plugin WITH data:read:xrefauthors
    await install(`export const manifest = {
      id: "xref-books-reader",
      name: "Books with Author Ref",
      permissions: ["ui", "data:read:xrefauthors"],
      collections: {
        xrefbooks: {
          title: "Books",
          schema: {
            type: "object",
            required: ["title", "authorId"],
            properties: {
              title: { type: "string", title: "Title" },
              authorId: { type: "string", title: "Author", "x-ref": { collection: "xrefauthors", label: "fullName" } },
              editorId: { type: "string", title: "Editor", "x-ref": { collection: "xrefauthors", label: "fullName" } }
            }
          }
        }
      }
    };
    export default (ctx) => {
      ctx.ui.render("main", "xref-ok", '<ui-form collection="xrefbooks" action="saved-book"></ui-form><ui-table collection="xrefbooks" columns="title,authorId"></ui-table>');
      ctx.ui.onEvent(async (action, id) => {
        if (action === "saved-book") ctx.log("xref-saved " + JSON.stringify(await ctx.call("data", "get", "xrefbooks", id)));
      });
    };`);

    const okView = 'main [data-key="xref-books-reader:xref-ok"]';
    await page.waitForFunction(
      (sel) => document.querySelector(`${sel} ui-form`)?.shadowRoot?.querySelector('select[name="authorId"] option[value="a-leguin"]'),
      okView,
      { timeout: 8000 },
    );

    const selectInfo = await page.evaluate((sel) => {
      const formRoot = document.querySelector(`${sel} ui-form`).shadowRoot;
      const reqOpts = [...formRoot.querySelectorAll('select[name="authorId"] option')].map((o) => ({ value: o.value, text: o.textContent }));
      const optOpts = [...formRoot.querySelectorAll('select[name="editorId"] option')].map((o) => ({ value: o.value, text: o.textContent }));
      return { reqOpts, optOpts };
    }, okView);
    check(
      "ui-form renders <select> for x-ref fields when readable, omitting empty option only when required",
      selectInfo.reqOpts.length === 2 &&
        selectInfo.reqOpts.some((o) => o.value === "a-leguin" && o.text === "Ursula K. Le Guin") &&
        selectInfo.optOpts.length === 3 &&
        selectInfo.optOpts[0].value === "",
      JSON.stringify(selectInfo),
    );

    // Submit form selecting a-leguin and verify stored id + resolved label in ui-table
    await page.evaluate((sel) => {
      const formRoot = document.querySelector(`${sel} ui-form`).shadowRoot;
      const titleInput = formRoot.querySelector('input[name="title"]');
      titleInput.value = "The Dispossessed";
      const select = formRoot.querySelector('select[name="authorId"]');
      select.value = "a-leguin";
      formRoot.querySelector("form").requestSubmit();
    }, okView);

    const savedBook = JSON.parse((await pluginLog("xref-books-reader", "xref-saved ")).slice("xref-saved ".length));
    await page.waitForFunction(
      (sel) => document.querySelector(`${sel} ui-table`)?.shadowRoot?.textContent?.includes("Ursula K. Le Guin"),
      okView,
      { timeout: 8000 },
    );
    const resolvedCells = await page.evaluate((sel) => {
      const tr = document.querySelector(`${sel} ui-table`).shadowRoot.querySelector("tbody tr");
      return [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim());
    }, okView);
    check(
      "saving ui-form with x-ref stores the referenced record id while ui-table displays the resolved label",
      savedBook.authorId === "a-leguin" && JSON.stringify(resolvedCells) === '["The Dispossessed","Ursula K. Le Guin"]',
      JSON.stringify({ savedBook, resolvedCells }),
    );

    // Live update when referenced collection changes + default title/name/id fallback when label is omitted
    await install(`export const manifest = {
      id: "xref-trigger",
      name: "Trigger",
      permissions: ["commands"]
    };
    export default async (ctx) => {
      await ctx.call("commands", "run", "xref-authors-owner/add-butler");
      ctx.log("xref-butler added");
    };`);
    await pluginLog("xref-trigger", "xref-butler added");
    await page.waitForFunction(
      (sel) => document.querySelector(`${sel} ui-form`)?.shadowRoot?.querySelector('select[name="authorId"] option[value="a-butler"]')?.textContent === "Octavia E. Butler",
      okView,
      { timeout: 8000 },
    );
    check("ui-form updates x-ref <select> options live when records are added to the referenced collection", true);

    // Plugin WITHOUT data:read:xrefauthors -> graceful fallback to plain text input and raw id!
    await install(`export const manifest = {
      id: "xref-books-blind",
      name: "Books without Author Read",
      permissions: ["ui"],
      collections: {
        xrefbooksblind: {
          title: "Blind Books",
          schema: {
            type: "object",
            required: ["title", "authorId"],
            properties: {
              title: { type: "string", title: "Title" },
              authorId: { type: "string", title: "Author", "x-ref": { collection: "xrefauthors", label: "fullName" } }
            }
          }
        }
      }
    };
    export default async (ctx) => {
      await ctx.call("data", "put", "xrefbooksblind", { title: "Dune", authorId: "a-herbert" });
      ctx.ui.render("main", "xref-blind", '<ui-form collection="xrefbooksblind"></ui-form><ui-table collection="xrefbooksblind" columns="title,authorId"></ui-table>');
    };`);

    const blindView = 'main [data-key="xref-books-blind:xref-blind"]';
    await page.waitForFunction(
      (sel) =>
        document.querySelector(`${sel} ui-form`)?.shadowRoot?.querySelector('[name="authorId"]') &&
        document.querySelector(`${sel} ui-table`)?.shadowRoot?.querySelector("tbody tr"),
      blindView,
      { timeout: 8000 },
    );
    const blindInfo = await page.evaluate((sel) => {
      const control = document.querySelector(`${sel} ui-form`).shadowRoot.querySelector('[name="authorId"]');
      const cells = [...document.querySelector(`${sel} ui-table`).shadowRoot.querySelectorAll("tbody tr td")].map((td) => td.textContent?.trim());
      return { tag: control?.tagName.toLowerCase(), type: control?.getAttribute("type"), cells };
    }, blindView);
    check(
      "without data:read:<refCollection>, ui-form falls back to <input type='text'> and ui-table shows the raw id",
      blindInfo.tag === "input" && blindInfo.type === "text" && JSON.stringify(blindInfo.cells) === '["Dune","a-herbert"]',
      JSON.stringify(blindInfo),
    );
  } finally {
    for (const id of ["xref-books-blind", "xref-trigger", "xref-books-reader", "xref-authors-owner", "dq-denied", "dq-catalog"]) {
      await uninstall(id).catch(() => {});
    }
    await own.close();
  }
}
