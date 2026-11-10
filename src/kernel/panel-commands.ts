// The Customize panel's commands, as the page sends them (window.__host.command): the person's own plugins
// for an app (`user:list`, `user:add`, `user:on`, `user:off`, `user:remove`, `user:share`, `user:unshare`) and
// the places they let plugins into (`place:ask`, `place:move`, `place:unlock`, `place:lock`). An app opens
// without any of this, so it is a file of its own, fetched the first time one of them is run (kernel.ts).

import { asMove, type MovesStore } from "./moves";
import type { SpaceSeam } from "./modules";
import type { RemotePlugins, ServiceProvider } from "./remote";
import { allowed, type Reviews } from "./review";
import { EVERYWHERE, checkApp, type UserPlugins } from "./user-plugins";

export function panelCommands({
  userAdded,
  moved,
  reviews,
  remote,
  services,
  reopen,
  space,
}: {
  userAdded: UserPlugins;
  moved: MovesStore;
  reviews: Reviews;
  remote: RemotePlugins;
  services: Record<string, ServiceProvider>;
  /** Opens an app again in every tab that has it open. */
  reopen(app: string): Promise<void>;
  /** What a space lends the kernel, in a kernel for one. */
  space(): SpaceSeam | undefined;
}) {
  /** The apps a change to one of the person's plugins reaches: this one, or all of them for one they use in every app. */
  const keptFor = async (app: string, id: string) => ((await userAdded.list(app)).some((p) => p.id === id && p.everywhere) ? EVERYWHERE : app);

  /** One command, by name: answers what the page hears back. */
  return async function customize(name: string, arg: unknown): Promise<unknown> {
    const a = (arg ?? {}) as Record<string, unknown>;
    const app = checkApp(a.app);
    const id = typeof a.id === "string" ? a.id : typeof a.plugin === "string" ? a.plugin : "";
    switch (name) {
      case "user:list":
      {
        const sharing = space()?.sharing;
        return sharing ? sharing.mark(app, await userAdded.list(app)) : userAdded.list(app);
      }
      case "user:share":
      case "user:unshare": {
        const sharing = space()?.sharing;
        if (!sharing) return { ok: false, error: "Only a plugin in a space can be shared with it" };
        return { ok: await (name === "user:share" ? sharing.share(app, id) : sharing.unshare(app, id)) };
      }
      case "user:add": {
        const added = typeof a.url === "string" ? await userAdded.addFromUrl(app, a.url) : await userAdded.add(app, a.files as { name: string; data: Blob | string }[]);
        // Adding a plugin again turns it off: stop the copy that was running.
        await reopen(app);
        return added;
      }
      case "user:on":
      case "user:off":
        // As in Customize (authoring.ts): the person's plugins that provide what it needs come on with it.
        await (name === "user:on" ? userAdded.onWithNeeds(app, id, (service) => Object.hasOwn(services, service), (service, not) => Object.hasOwn(services, service) && remote.providers.get(service) !== not) : userAdded.offWithDependents(app, id, (service, not) => Object.hasOwn(services, service) && remote.providers.get(service) !== not));
        await reopen(await keptFor(app, id));
        return true;
      case "user:remove": {
        const where = await keptFor(app, id);
        const removed = await userAdded.remove(app, id);
        await reopen(where);
        return removed;
      }
      case "place:ask": {
        const outcome = await reviews.ask(
          {
            plugin: id,
            instance: id,
            name: remote.installed.get(id)?.manifest.name ?? id,
            place: `place:${app}#${String(a.place)}`,
            target: String(a.target ?? "the page").slice(0, 120),
            before: "",
            after: "",
            reason: String(a.what ?? "").slice(0, 300),
            kind: "place",
          },
          {},
        );
        return allowed(outcome);
      }
      case "place:move": {
        // The person moved a view in the page's arrange mode (src/host/arrange.ts), or put it back with `to` null.
        const to = a.to === null ? null : asMove(a.to);
        if (to === undefined) return { ok: false, error: "A move is { at, put } with put before, after, prepend or append" };
        await moved.set(app, id, String(a.place), to);
        await reopen(app);
        return { ok: true };
      }
      case "place:unlock":
      case "place:lock": {
        const place = `unlock:${app}#${String(a.place)}`;
        if (name === "place:unlock") await reviews.grant(id, place);
        else await reviews.forget(id, place);
        await reopen(app);
        return true;
      }
    }
    return undefined;
  }
}
