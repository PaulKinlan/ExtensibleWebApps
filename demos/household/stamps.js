// Stamps: on the space's server only, it makes sure that who a record says
// did something is who did it. groceries.js and chores.js stamp an item or a
// chore with the member id of whoever added it, got it or did it, but a
// device writes that field itself, so a member's device could put someone
// else's id there. The space knows which member each change really comes
// from (`by`, which a device can't choose), and this refuses a change that
// sets a stamp to anyone else. A stamp left as it was is fine: changing an
// item Ann added doesn't make it yours.
//
// Outside a space there is no server, and one person on the device.

export const manifest = {
  id: "stamps",
  name: "Honest stamps",
  description: "Refuses a change that signs it with someone else's name.",
  version: "1.0.0",
  runs: "server",
  permissions: ["data:read:groceries", "data:read:chores", "hook:intercept:data:beforeWrite:groceries", "hook:intercept:data:beforeWrite:chores"],
};

const STAMPS = { groceries: ["addedBy", "gotBy"], chores: ["doneBy"] };

export default function (ctx) {
  for (const [collection, fields] of Object.entries(STAMPS)) {
    ctx.on(`data:beforeWrite:${collection}`, ({ before, after, by }) => {
      // Only a member's device has a `by` to check against; the space's own plugins write as themselves.
      if (!after || !by || by.startsWith("plugin:")) return undefined;
      for (const field of fields) {
        const stamp = after[field];
        if (stamp !== undefined && stamp !== before?.[field] && stamp !== by) return { block: `A change can only be signed by the member who makes it (${field})` };
      }
      return undefined;
    });
  }
}
