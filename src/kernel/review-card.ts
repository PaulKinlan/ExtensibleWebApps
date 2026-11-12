// The cards change review shows (review.ts): a write as a diff with the
// plugin's reason, a change to a place in the page, and whether an agent may
// act for the person. A file of its own, fetched the first time the person is
// asked about anything: most visits to most apps never ask, so the cards and
// the line diff stay out of the kernel every app downloads.

import type { View } from "../shared/protocol";
import { diffLines, trim } from "./diff";
import { ACTS_AS, placeLabel, type Request } from "./review";

/** A change to a place in the page: what will appear or disappear there, with no diff. */
const placeCard = (id: string, r: Request): View => ({
  type: "stack",
  children: [
    { type: "heading", text: `${r.name} wants to change ${r.target}` },
    { type: "text", text: `${r.reason} The app's author asked to review changes here.`, tone: "muted" },
    {
      type: "stack",
      direction: "row",
      children: [
        { type: "button", label: "Allow", action: `accept:${id}`, primary: true },
        { type: "button", label: "Always allow here", action: `always:${id}` },
        { type: "button", label: "Decline", action: `decline:${id}` },
      ],
    },
  ],
});

/** Asks whether an agent may act for the person: for this run, always, or not. */
const actsAsCard = (id: string, r: Request): View => ({
  type: "stack",
  children: [
    { type: "heading", text: `Let ${r.name} act for you?` },
    { type: "text", text: `${r.reason} Its changes will be logged as yours, made through ${r.name}. You still review each one, and it can do only what its own permissions allow.`, tone: "muted" },
    {
      type: "stack",
      direction: "row",
      children: [
        { type: "button", label: "This time", action: `accept:${id}`, primary: true },
        { type: "button", label: "Always", action: `always:${id}` },
        { type: "button", label: "Not now", action: `decline:${id}` },
      ],
    },
  ],
});

/** The card for a request. `forPerson`: an agent acting for the person asked (review.ts). */
export const card = (id: string, r: Request, forPerson: boolean): View =>
  r.place === ACTS_AS
    ? actsAsCard(id, r)
    : r.kind === "place"
    ? placeCard(id, r)
    : {
        type: "stack",
        children: [
          { type: "heading", text: forPerson ? `${r.name}, acting for you, wants to change ${r.target}` : `${r.name} wants to change ${r.target}` },
          ...(forPerson ? [{ type: "text" as const, text: `If you accept, this is logged as your change, made through ${r.name}.` }] : []),
          { type: "text", text: r.reason ? `Reason: ${r.reason}` : "No reason given.", tone: "muted" },
          { type: "diff", lines: trim(diffLines(r.before, r.after)) },
          {
            type: "stack",
            direction: "row",
            children: [
              { type: "button", label: "Accept", action: `accept:${id}`, primary: true },
              ...(r.once ? [] : [{ type: "button" as const, label: `Always allow in ${placeLabel(r.place)}`, action: `always:${id}` }]),
              { type: "button", label: "Decline", action: `decline:${id}` },
            ],
          },
        ],
      };
