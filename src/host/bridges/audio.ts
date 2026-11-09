// audio: plays sound from AudioWorklet processors that plugins register, and
// plays, renders, mixes, opens and saves clips (std/audio/module.ts). Web Audio
// only exists in a page, so the kernel's audio service comes here.
//
// The work is in ../audio.ts, which the page fetches the first time a plugin
// makes a sound: a page whose plugins make none never has it.

import type { BridgeHost } from "./index";

type Audio = Record<string, (...args: any[]) => unknown>;

export default (host: BridgeHost): Audio => {
  let made: Promise<Audio> | undefined;
  const audio = () => (made ??= import("../audio").then((file) => file.default(host) as Audio));
  return new Proxy({} as Audio, {
    get:
      (_target, method: string) =>
      async (...args: unknown[]) => {
        const all = await audio();
        if (!Object.hasOwn(all, method)) throw new Error(`The host has no audio.${method}`);
        return all[method](...args);
      },
  });
};
