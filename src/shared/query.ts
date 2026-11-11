// Filtering, text search, sorting and pagination for `data.query`, loaded on
// demand by `src/kernel/records.ts` so apps that only call `list` and `get`
// never download it.

export interface QueryOptions {
  where?: Record<string, unknown>;
  search?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface QueryResult<T> {
  records: T[];
  total: number;
  hasMore: boolean;
}

const OPS = new Set(["$gt", "$gte", "$lt", "$lte", "$contains", "$in"]);
const KERNEL_FIELDS = new Set(["id", "createdAt", "updatedAt"]);

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function getField(record: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(record, path)) return record[path];
  if (!path.includes(".")) return undefined;
  let cur: unknown = record;
  for (const part of path.split(".")) {
    if (!isPlain(cur) || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function equal(a: unknown, b: unknown): boolean {
  if (b === null) return a === null || a === undefined;
  if (a === b) return true;
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function compare(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

function matchesCondition(val: unknown, cond: unknown): boolean {
  if (isPlain(cond)) {
    const keys = Object.keys(cond);
    if (keys.length > 0 && keys.some((k) => k.startsWith("$"))) {
      for (const [op, target] of Object.entries(cond)) {
        if (!OPS.has(op)) throw new Error(`Unsupported query operator ${op}`);
        if (op === "$gt") {
          const c = compare(val, target);
          if (c === null || !(c > 0)) return false;
        } else if (op === "$gte") {
          const c = compare(val, target);
          if (c === null || !(c >= 0)) return false;
        } else if (op === "$lt") {
          const c = compare(val, target);
          if (c === null || !(c < 0)) return false;
        } else if (op === "$lte") {
          const c = compare(val, target);
          if (c === null || !(c <= 0)) return false;
        } else if (op === "$contains") {
          if (Array.isArray(val)) {
            if (!val.some((item) => equal(item, target))) return false;
          } else if (typeof val === "string" && typeof target === "string") {
            if (!val.toLowerCase().includes(target.toLowerCase())) return false;
          } else {
            return false;
          }
        } else if (op === "$in") {
          if (!Array.isArray(target)) throw new Error("$in expects an array");
          if (!target.some((item) => equal(val, item))) return false;
        }
      }
      return true;
    }
  }
  return equal(val, cond);
}

function hasText(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.toLowerCase().includes(needle);
  if (Array.isArray(value)) return value.some((item) => hasText(item, needle));
  if (isPlain(value)) return Object.values(value).some((v) => hasText(v, needle));
  return false;
}

export function queryRecords<T extends Record<string, unknown>>(all: T[], raw: unknown = {}): QueryResult<T> {
  if (raw !== undefined && raw !== null && !isPlain(raw)) {
    throw new Error("data.query takes (collection, { where?, search?, sort?, limit?, offset? })");
  }
  const opts = (raw ?? {}) as QueryOptions;
  if (opts.where !== undefined && !isPlain(opts.where)) throw new Error("data.query: where must be an object");
  if (opts.search !== undefined && typeof opts.search !== "string") throw new Error("data.query: search must be a string");
  if (opts.sort !== undefined && typeof opts.sort !== "string") throw new Error("data.query: sort must be a string");
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 0)) throw new Error("data.query: limit must be a non-negative integer");
  if (opts.offset !== undefined && (!Number.isInteger(opts.offset) || opts.offset < 0)) throw new Error("data.query: offset must be a non-negative integer");

  const whereEntries = opts.where ? Object.entries(opts.where) : [];
  // Validate any operator syntax upfront even when the collection is empty.
  for (const [, cond] of whereEntries) {
    if (isPlain(cond) && Object.keys(cond).some((k) => k.startsWith("$"))) {
      for (const [op, target] of Object.entries(cond)) {
        if (!OPS.has(op)) throw new Error(`Unsupported query operator ${op}`);
        if (op === "$in" && !Array.isArray(target)) throw new Error("$in expects an array");
      }
    }
  }

  const needle = opts.search?.trim().toLowerCase() ?? "";
  const matched = all.filter((record) => {
    for (const [field, cond] of whereEntries) {
      if (!matchesCondition(getField(record, field), cond)) return false;
    }
    if (needle) {
      let hit = false;
      for (const [k, v] of Object.entries(record)) {
        if (!KERNEL_FIELDS.has(k) && hasText(v, needle)) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }
    return true;
  });

  if (opts.sort) {
    const desc = opts.sort.startsWith("-");
    const key = desc ? opts.sort.slice(1) : opts.sort;
    const dir = desc ? -1 : 1;
    const blank = (v: unknown) => v === undefined || v === null || v === "";
    matched.sort((a, b) => {
      const x = getField(a, key);
      const y = getField(b, key);
      if (x === y) return 0;
      if (blank(x)) return 1;
      if (blank(y)) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      if (typeof x === "boolean" && typeof y === "boolean") return (Number(x) - Number(y)) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
  }

  const total = matched.length;
  const start = opts.offset ?? 0;
  const records = opts.limit !== undefined ? matched.slice(start, start + opts.limit) : start > 0 ? matched.slice(start) : matched;
  const hasMore = opts.limit !== undefined && start + records.length < total;
  return { records, total, hasMore };
}
