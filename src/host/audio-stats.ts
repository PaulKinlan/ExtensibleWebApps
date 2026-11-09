// What the audio bridge (audio.ts) has played, kept apart from it so a page can show the tests these
// (window.__host) without fetching the bridge's code before a plugin makes a sound.

/** What has played, for the tests (window.__host.audioStats). */
export const audioStats = { played: 0, state: "none" as string, ahead: 0, start: 0 };

/**
 * For the tests: how loud what the plugins play is now (the peak of the latest samples), and the `start` each
 * processor said it got. Not on audioStats, which goes back to plugins.
 */
export const audioProbe = { listening: false, level: () => 0, starts: [] as number[] };
