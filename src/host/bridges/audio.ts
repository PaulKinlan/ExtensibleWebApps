// audio: plays sound from AudioWorklet processors that plugins register, and
// plays, renders, mixes, opens and saves clips (std/audio/module.ts). Web Audio
// only exists in a page, so the kernel's audio service comes here.
//
// The work is in ../audio.ts. This bridge is one the page fetches when the kernel first
// asks for it (index.ts, `later`), which is the first time a plugin makes a sound: a page
// whose plugins make none never has it.

export { default } from "../audio";
