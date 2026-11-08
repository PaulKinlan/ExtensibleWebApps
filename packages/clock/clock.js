// Clock: a plugin that provides a service, the `clock` service, which no site
// builds in. Any plugin with the `clock` permission calls it:
//
//   const { time } = await ctx.call("clock", "now", "Asia/Tokyo");
//
// It is in the plugin registry (/packages/), so a person adds it to any app
// from Customize, and so does any plugin there that needs it (world-clock).

export const manifest = {
  id: "clock",
  name: "Clock",
  description: "Provides the clock service: the time now in any time zone.",
  version: "1.0.0",
  permissions: ["provide:clock"],
  provides: {
    clock: {
      description: "The time now, in any time zone, as a person would read it.",
      methods: {
        now: { args: "(timeZone?)", returns: "{ time, date, timeZone }", description: "The time and date now in an IANA time zone such as Europe/London (this device's own if not given).", params: [{ name: "timeZone", schema: { type: "string" }, optional: true }] },
      },
    },
  },
};

export default function (ctx) {
  ctx.provide("clock", {
    now(timeZone) {
      const zone = typeof timeZone === "string" && timeZone ? timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
      const at = new Date();
      // An unknown zone throws a RangeError, which fails the call with its message.
      return {
        time: at.toLocaleTimeString("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit" }),
        date: at.toLocaleDateString("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short" }),
        timeZone: zone,
      };
    },
  });
}
