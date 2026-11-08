// The little of "cloudflare:workers" the space kernel's entry (kernel.ts)
// uses, so it can be checked with the browser's types, as the kernel it
// starts is (tsconfig.space.json). The Worker itself is checked with the
// full Workers types (tsconfig.cloudflare.json).
declare module "cloudflare:workers" {
  export class DurableObject {
    protected ctx: { storage: { sql: unknown } };
    protected env: unknown;
    constructor(ctx: unknown, env: unknown);
  }
}
