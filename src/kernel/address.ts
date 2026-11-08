// What counts as an email address, the same for an account's address (src/server/auth/accounts.ts) and a
// message's recipients (services/email.ts): a local part with no spaces, controls or separators, then a
// domain of hostname labels (letters, digits and inner hyphens; an international name in its xn-- form).

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const ADDRESS = new RegExp(`^[^@\\s\\x00-\\x1f\\x7f<>,;"]+@${LABEL}(?:\\.${LABEL})+$`);

/** Whether `value` is an email address, at most 254 characters. */
export const isAddress = (value: unknown): value is string => typeof value === "string" && value.length <= 254 && ADDRESS.test(value);
