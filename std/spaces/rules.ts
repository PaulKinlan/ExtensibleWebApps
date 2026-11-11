// A collection's rules in a space, as a plugin writes them in its manifest
// (permissions.ts says what they mean), and the one place that reads them:
// the space's server before it keeps them, and `npm run check` before anyone
// runs the app. Nothing here needs a kernel, so both can use it.

/** What a member may do in a space (src/server/auth/accounts.ts). */
export type Role = "owner" | "editor" | "reader";

export interface Rules {
  add?: "editors" | "owner";
  change?: "editors" | "author" | "owner";
  remove?: "editors" | "author" | "owner";
}

const WHO = { add: ["editors", "owner"], change: ["editors", "author", "owner"], remove: ["editors", "author", "owner"] } as const;

/** A manifest's `rules` for one collection, checked; throws with what is wrong and what it could be. */
export function checkRules(value: unknown, where: string): Rules {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: rules is an object such as { change: "author" }`);
  const out: Rules = {};
  for (const [what, who] of Object.entries(value)) {
    if (!Object.hasOwn(WHO, what)) throw new Error(`${where}: ${what} isn't a rule. The rules are add, change and remove`);
    const allowed: readonly string[] = WHO[what as keyof typeof WHO];
    if (typeof who !== "string" || !allowed.includes(who)) throw new Error(`${where}: rules.${what} is ${allowed.map((w) => `"${w}"`).join(" or ")}, not ${JSON.stringify(who)}`);
    (out as Record<string, string>)[what] = who;
  }
  return out;
}

/** Whether a member may do something to a record, as a device works it out from what the space told it (the space decides again when it hears the change). */
export function allowed(rules: Rules | undefined, doing: keyof Rules, role: Role | undefined, isAuthor: boolean): boolean {
  if (role === "reader") return false;
  if (role === "owner" || !rules) return true;
  const who = rules[doing] ?? "editors";
  return who === "editors" || (who === "author" && isAuthor);
}
