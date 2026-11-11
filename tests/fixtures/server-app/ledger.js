// The browser's side of the roles checks (tests/server/roles.mjs): two
// collections with rules, which the space's server reads from this manifest
// and enforces. It runs there too (and does nothing), so the checks can try
// to write as it from a member's client, which the server never lets through.

export const manifest = {
  id: "ledger",
  name: "Ledger",
  description: "Entries only their author changes, and a notice board only the owner posts to.",
  version: "1.0.0",
  runs: "both",
  permissions: [],
  collections: {
    "ledger-entries": {
      title: "Ledger",
      schema: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 200 } } },
      rules: { change: "author", remove: "author" },
    },
    notices: {
      title: "Notices",
      schema: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 200 } } },
      rules: { add: "owner", remove: "owner" },
    },
    muddle: {
      title: "Muddle",
      schema: { type: "object", properties: { text: { type: "string", maxLength: 200 } } },
      rules: { change: "everyone" },
    },
  },
};

export default function () {}
