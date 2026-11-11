// Ambient types for Cloudflare Dynamic Workers, Durable Object facets and
// `getByName`, supplementing @cloudflare/workers-types/experimental until the
// published definitions catch up with workerd.

interface WorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules?: Record<string, string | BufferSource>;
  env?: Record<string, unknown>;
  globalOutbound?: Fetcher | null;
}

interface DynamicWorker {
  getEntrypoint(name?: string, options?: { props?: unknown }): Fetcher;
  getDurableObjectClass(className: string): DurableObjectClass;
}

interface WorkerLoader {
  get(id: string, getCode: () => WorkerCode | Promise<WorkerCode>): DynamicWorker;
}

interface DurableObjectFacets {
  get(
    name: string,
    getStartupOptions: () => { class: DurableObjectClass; id?: DurableObjectId | string } | Promise<{ class: DurableObjectClass; id?: DurableObjectId | string }>,
  ): Fetcher;
}

interface DurableObjectNamespace<T extends Rpc.DurableObjectBranded | undefined = undefined> {
  getByName(name: string, options?: DurableObjectNamespaceGetDurableObjectOptions): DurableObjectStub<T>;
}
