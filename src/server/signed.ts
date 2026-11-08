// What a server tells a space's kernel about each client: which member of
// the space it is. The server checked the client's session before it joined,
// so only the server may say; a client that claims to be someone is ignored.

/** A client's message as the kernel should hear it: a hello says which member it is, and nothing else may. */
export function signed(message: unknown, member: string): unknown {
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const { member: _claimed, ...rest } = message as Record<string, unknown>;
    return rest.t === "hello" ? { ...rest, member } : rest;
  }
  return message;
}
