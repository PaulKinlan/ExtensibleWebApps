// The Customize panel: every app gets a small button, drawn by the platform
// outside the app's own layout, that opens a panel where the person:
//
//   - adds their own plugins to this app (pick files, paste code, or a URL
//     on this site), kept on this device and never in the app's files
//   - turns them on or off, or removes them; a new one starts off, and the
//     panel shows what it asks for and where it draws before it is turned on
//   - sees every plugin's places and how each went: drawn, waiting for a
//     review card, declined, locked by the app's author, or matching nothing
//   - lets one plugin into an area the author locked, after a warning
//   - starts inspect mode (inspect.ts), to point at a part and change it
//
// It is platform chrome, like review cards, so it is plain DOM built here,
// and plugins can't draw into it or point a place at it.

import type { Command, Opened } from "../shared/protocol";
import { fragile, type PlaceState } from "./places";

interface UserPlugin {
  file: string;
  id?: string;
  name?: string;
  description?: string;
  permissions?: string[];
  places?: Record<string, { at: string; put: string; each?: boolean }>;
  on: boolean;
  error?: string;
}

/** A plugin in the registry's index (packages/index.json). */
interface Package {
  id: string;
  name: string;
  description: string;
  href: string;
  permissions: string[];
  provides: string[];
  services: string[];
}

type Status = { plugin: string; name: string; at: string; put: string; each: boolean; state: PlaceState; matches: number };

export interface CustomizeHost {
  app: string;
  command(name: Command, arg?: unknown): Promise<unknown>;
  /** The plugins running for this app, as the kernel last said. */
  running(): Opened[];
  /** Every place in the page and how it went. */
  places(): Status[];
  /** Starts inspect mode (inspect.ts). */
  inspect?(): void;
}

const STATES: Record<PlaceState, string> = {
  drawn: "In place",
  waiting: "Waiting for you to allow it",
  declined: "You declined it",
  locked: "Locked by the app's author",
  "no match": "Matches nothing in this page",
  "bad selector": "The selector can't be read",
};

/** A small DOM helper: an element with attributes and children. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  for (const child of children) if (child) el.append(child);
  return el;
}

export function customize(host: CustomizeHost) {
  const open = h("button", { class: "customize-button", type: "button", "aria-haspopup": "dialog" }, "Customize");
  const dialog = h("dialog", { id: "customize", class: "customize", "aria-labelledby": "customize-title" });
  document.body.append(open, dialog);
  open.addEventListener("click", () => {
    dialog.showModal();
    void refresh();
  });
  dialog.addEventListener("click", (e) => {
    // A click on the backdrop closes it.
    if (e.target === dialog) dialog.close();
  });

  let message = "";
  /** True while a registry package (and what it needs) is being added, across the panel redrawing itself. */
  let addingPackage = false;
  const say = (text: string) => {
    message = text;
    void refresh();
  };

  /** Runs a panel command and says how it went; true if it worked. */
  async function run(name: Command, arg: Record<string, unknown>, done?: string): Promise<boolean> {
    const result = (await host.command(name, { app: host.app, ...arg })) as { ok?: boolean; error?: string } | boolean | undefined;
    const failed = !!result && typeof result === "object" && result.ok === false;
    say(failed ? ((result as { error?: string }).error ?? "That didn't work") : (done ?? ""));
    return !failed;
  }

  function placeRows(plugin: string, unlocked: string[]): HTMLElement | null {
    const rows = host.places().filter((p) => p.plugin === plugin);
    if (!rows.length) return null;
    return h(
      "ul",
      { class: "customize-places" },
      ...rows.map((p) => {
        const isUnlocked = unlocked.includes(p.name);
        return h(
          "li",
          { "data-place": `${p.plugin}/${p.name}`, "data-state": p.state },
          h("code", {}, `${p.put}${p.each ? " each" : ""} ${p.at}`),
          " ",
          h("span", { class: p.state === "drawn" ? "ok" : p.state === "waiting" ? "muted" : "error" }, STATES[p.state], p.each && p.matches ? ` (${p.matches})` : ""),
          fragile(p.at) ? h("span", { class: "muted" }, " · this selector leans on the page's layout, so an update to the app may break it") : null,
          p.state === "locked" ? unlockButton(p) : null,
          isUnlocked ? lockButton(p) : null,
        );
      }),
    );
  }

  function unlockButton(p: Status) {
    const button = h("button", { type: "button", "data-unlock": `${p.plugin}/${p.name}` }, "Unlock for this plugin");
    button.addEventListener("click", () => {
      const ok = confirm(`The app's author locked this part of the page (${p.at}), so plugins can't change it. Let ${p.plugin} ${p.put} there anyway?`);
      if (ok) void run("place:unlock", { plugin: p.plugin, place: p.name }, `Unlocked for ${p.plugin}`);
    });
    return button;
  }

  function lockButton(p: Status) {
    const button = h("button", { type: "button" }, "Lock again");
    button.addEventListener("click", () => void run("place:lock", { plugin: p.plugin, place: p.name }));
    return button;
  }

  function mine(list: UserPlugin[], running: Opened[]): HTMLElement {
    if (!list.length) return h("p", { class: "muted" }, "None yet. Add one below.");
    return h(
      "ul",
      { class: "customize-list" },
      ...list.map((p) => {
        const live = running.find((r) => r.id === p.id);
        const toggle = h("button", { type: "button", class: p.on ? "" : "primary", "data-toggle": p.id ?? p.file }, p.on ? "Turn off" : "Turn on");
        toggle.addEventListener("click", () => void run(p.on ? "user:off" : "user:on", { id: p.id }));
        const remove = h("button", { type: "button", "data-remove": p.id ?? p.file }, "Remove");
        remove.addEventListener("click", () => {
          if (confirm(`Remove ${p.name ?? p.file} from this app on this device?`)) void run("user:remove", { id: p.id }, "Removed");
        });
        const places = Object.entries(p.places ?? {});
        return h(
          "li",
          { "data-plugin-id": p.id ?? p.file },
          h("strong", {}, p.name ?? p.file),
          p.on ? h("span", { class: "ok" }, " on") : h("span", { class: "muted" }, " off"),
          p.description ? h("p", { class: "muted" }, p.description) : null,
          p.error ? h("p", { class: "error" }, p.error) : null,
          // Before it is on, say what it will do, since turning it on is the person's consent.
          !p.on && p.permissions ? h("p", { class: "muted" }, `Asks for: ${p.permissions.join(", ") || "nothing"}`) : null,
          !p.on && places.length ? h("p", { class: "muted" }, `Draws: ${places.map(([n, pl]) => `${pl.put} ${pl.at}`).join("; ")}`) : null,
          p.on && p.id ? placeRows(p.id, live?.unlocked ?? []) : null,
          p.id ? h("div", { class: "customize-actions" }, toggle, remove) : remove,
        );
      }),
    );
  }

  function authors(running: Opened[]): HTMLElement {
    const list = running.filter((p) => p.id && !p.user);
    if (!list.length) return h("p", { class: "muted" }, "This app links no plugins of its own.");
    return h("ul", { class: "customize-list" }, ...list.map((p) => h("li", {}, h("strong", {}, p.name ?? p.id!), placeRows(p.id!, p.unlocked ?? []))));
  }

  function adder(): HTMLElement {
    const files = h("input", { type: "file", multiple: "", accept: ".js,.html,.css,.json,.svg,.png,.jpg,.jpeg,.webp,.gif", "aria-label": "Plugin files" });
    files.addEventListener("change", async () => {
      const picked = [...(files.files ?? [])];
      if (!picked.length) return;
      const data = await Promise.all(picked.map(async (f) => ({ name: f.name, data: /\.(js|html|css|json|svg)$/.test(f.name) ? await f.text() : f })));
      await run("user:add", { files: data }, `Added ${picked.map((f) => f.name).join(", ")}. Turn it on above.`);
    });
    const code = h("textarea", { rows: "6", placeholder: "export const manifest = { … }", "aria-label": "Plugin code" });
    const paste = h("button", { type: "button" }, "Add this code");
    paste.addEventListener("click", () => {
      if (code.value.trim()) void run("user:add", { files: [{ name: "pasted.js", data: code.value }] }, "Added. Turn it on above.");
    });
    const url = h("input", { type: "text", placeholder: "/demos/trip/samples/countdown.js", "aria-label": "Plugin URL" });
    const fetchButton = h("button", { type: "button" }, "Add from URL");
    fetchButton.addEventListener("click", () => {
      if (url.value.trim()) void run("user:add", { url: url.value.trim() }, "Added. Turn it on above.");
    });
    const samples = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="plugin-sample"]')];
    return h(
      "div",
      { class: "customize-add" },
      samples.length
        ? h(
            "div",
            {},
            h("p", {}, "Samples for this app:"),
            ...samples.map((link) => {
              const b = h("button", { type: "button", "data-sample": link.getAttribute("href") ?? "" }, link.title || link.getAttribute("href") || "");
              b.addEventListener("click", () => void run("user:add", { url: link.href }, `Added ${link.title || "it"}. Turn it on above.`));
              return b;
            }),
          )
        : null,
      h("label", {}, "Pick a plugin and its files ", files),
      code,
      paste,
      h("div", { class: "customize-url" }, url, fetchButton),
    );
  }

  /**
   * The plugin registry (/packages/, built by scripts/packages.mjs): plugins this site offers but no app
   * links. Adding one adds the packages that provide the services it needs too, so it can start.
   */
  function browser(mine: UserPlugin[]): HTMLElement {
    const box = h("div", { class: "customize-registry" }, h("p", { class: "muted" }, "Loading the plugin registry…"));
    void (async () => {
      let packages: Package[] = [];
      try {
        const response = await fetch("/packages/index.json");
        if (!response.ok) throw new Error(String(response.status));
        packages = ((await response.json()) as { packages?: Package[] }).packages ?? [];
      } catch {
        return box.replaceChildren(h("p", { class: "muted" }, "This site has no plugin registry."));
      }
      const have = new Set(mine.map((p) => p.id));
      // The services this app already has, from the kernel or a running plugin: a package that needs one adds no provider for it.
      const reference = (await host.command("reference").catch(() => undefined)) as { data?: { services?: { name: string }[] } } | undefined;
      const running = new Set((reference?.data?.services ?? []).map((s) => s.name));
      const providerOf = (service: string) => (running.has(service) ? undefined : packages.find((p) => p.provides.includes(service)));
      /** The package and, first, every package that provides a service it needs and isn't here yet. */
      const withNeeds = (pkg: Package, seen = new Set<string>()): Package[] => {
        if (seen.has(pkg.id)) return [];
        seen.add(pkg.id);
        const needs = pkg.services.map(providerOf).filter((p): p is Package => !!p && !have.has(p.id));
        return [...needs.flatMap((p) => withNeeds(p, seen)), pkg];
      };
      box.replaceChildren(
        h("p", {}, "From this site's plugin registry:"),
        h(
          "ul",
          { class: "customize-list" },
          ...packages.map((pkg) => {
            const add = h("button", { type: "button", "data-package": pkg.id }, have.has(pkg.id) ? "Added" : "Add");
            if (have.has(pkg.id) || addingPackage) add.setAttribute("disabled", "");
            const adding = withNeeds(pkg);
            add.addEventListener("click", async () => {
              // One package at a time, and none added twice: adding a plugin again would turn it off.
              if (addingPackage) return;
              addingPackage = true;
              for (const button of box.querySelectorAll("button[data-package]")) button.setAttribute("disabled", "");
              try {
                const added = new Set(((await host.command("user:list", { app: host.app })) as { id?: string }[]).map((p) => p.id));
                const todo = adding.filter((p) => !added.has(p.id));
                for (const p of todo) if (!(await run("user:add", { url: p.href }))) return;
                say(`Added ${todo.map((p) => p.name).join(" and ")}. Turn ${todo.length > 1 ? "them" : "it"} on above.`);
              } finally {
                addingPackage = false;
              }
            });
            const also = adding.filter((p) => p.id !== pkg.id);
            return h(
              "li",
              {},
              h("strong", {}, pkg.name),
              pkg.description ? h("p", { class: "muted" }, pkg.description) : null,
              h("p", { class: "muted" }, `Asks for: ${pkg.permissions.join(", ") || "nothing"}${also.length ? `. Adds ${also.map((p) => p.name).join(", ")} too, which it needs.` : ""}`),
              h("div", { class: "customize-actions" }, add),
            );
          }),
        ),
      );
    })();
    return box;
  }

  function inspectButton(): HTMLElement {
    const button = h("button", { type: "button", "data-inspect-start": "" }, "Inspect the page");
    button.addEventListener("click", () => {
      dialog.close();
      host.inspect?.();
    });
    return h("p", {}, button, h("span", { class: "muted" }, " Point at any part to see which plugin drew it, then hide it or add a note beside it."));
  }

  async function refresh() {
    if (!dialog.open) return;
    const list = ((await host.command("user:list", { app: host.app })) as UserPlugin[] | undefined) ?? [];
    const running = host.running();
    const close = h("button", { type: "button", class: "customize-close" }, "Close");
    close.addEventListener("click", () => dialog.close());
    dialog.replaceChildren();
    dialog.append(
      ...[
      h("h2", { id: "customize-title" }, "Customize this app"),
      h("p", { class: "muted" }, "Your plugins are kept on this device. They can add to this page, replace parts of it or hide them, except where the app's author locked it."),
      message ? h("p", { role: "status" }, message) : null,
      host.inspect ? inspectButton() : null,
      h("h3", {}, "Your plugins"),
      mine(list, running),
      h("h3", {}, "The app's plugins"),
      authors(running),
      h("h3", {}, "Add a plugin"),
      browser(list),
      adder(),
      close,
      ].filter((n): n is HTMLElement => !!n),
    );
  }

  return { refresh: () => void refresh() };
}
