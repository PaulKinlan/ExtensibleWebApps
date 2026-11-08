// audio: plays sound from AudioWorklet processors that plugins register. Web
// Audio only exists in a page, so the kernel's audio service comes here.

import type { BridgeHost } from "./index";

let audio: AudioContext | undefined;
const processors = new Map<string, { source: string; added?: Promise<void> }>();
/** What has played, for the tests (window.__host.audioStats). */
export const audioStats = { played: 0, state: "none" as string };

export default (_host: BridgeHost) => ({
  registerProcessor(name: string, source: string) {
    processors.set(name, { source });
    return true;
  },
  async play({ processor, ms = 300, options = {} }: { processor: string; ms?: number; options?: Record<string, unknown> }) {
    const entry = processors.get(processor);
    if (!entry) throw new Error(`No audio processor named ${processor}`);
    audio ??= new AudioContext();
    if (audio.state === "suspended") await audio.resume();
    entry.added ??= audio.audioWorklet.addModule(URL.createObjectURL(new Blob([entry.source], { type: "text/javascript" })));
    await entry.added;
    const node = new AudioWorkletNode(audio, processor, { processorOptions: options });
    node.connect(audio.destination);
    setTimeout(() => node.disconnect(), ms);
    audioStats.played++;
    audioStats.state = audio.state;
    return { ...audioStats };
  },
});
