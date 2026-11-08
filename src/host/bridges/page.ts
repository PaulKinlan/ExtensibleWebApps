// page: whether a place a plugin names is on this page (places.ts).

import type { BridgeHost } from "./index";

export default ({ places, declared }: BridgeHost) => ({
  matches: (selector: unknown, mode: unknown) => places.matches(String(selector), String(mode)),
  slots: (plugin: unknown, name: unknown) => declared(String(plugin), String(name)),
});
