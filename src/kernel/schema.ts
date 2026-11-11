// A small JSON Schema subset for collections: enough to check records and to
// build forms and tables from, and nothing a plugin could use to make the
// kernel do a lot of work (no `pattern`: a plugin's regular expression
// could stall the kernel). Supported: type (string, number, integer,
// boolean, array, object), properties, required, enum, minimum, maximum,
// minLength, maxLength, format (date, date-time, email, uri),
// items, title, description, default, `x-multiline` for long text, `x-ref` to
// point at another collection's records, and `x-ownership` for space records.

export interface Schema {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: "date" | "date-time" | "email" | "uri";
  "x-multiline"?: boolean;
  "x-ref"?: { collection: string; label?: string };
  "x-ownership"?: "creator" | "any";
}

/** The JSON Schema keywords collections support, for the API reference. */
export const SCHEMA_KEYWORDS: Record<string, string> = {
  type: "string, number, integer, boolean, array or object",
  title: "The label forms and tables show",
  description: "",
  default: "What a new record's form starts with",
  enum: "A fixed set of choices; forms show a menu",
  properties: "The fields of an object",
  required: "Fields that must be filled in",
  items: "The schema of each item in an array",
  minimum: "Numbers",
  maximum: "",
  minLength: "Strings",
  maxLength: "Over 200 makes a form show a text area",
  format: "date, date-time, email or uri; forms use the matching input",
  "x-multiline": "true makes a form show a text area",
  "x-ref": "{ collection, label? } links a field to another collection's records; forms show a menu and tables show the label",
  "x-ownership": "creator or any; creator lets only the member who made a record in a space change or delete it",
};

const KEYS = new Set(["type", "title", "description", "default", "enum", "properties", "required", "items", "minimum", "maximum", "minLength", "maxLength", "format", "x-multiline", "x-ref", "x-ownership"]);
const COLLECTION_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
const FORMATS: Record<string, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uri: /^https?:\/\/\S+$/,
};

/** Checks a schema from a manifest; throws with what is wrong. */
export function checkSchema(schema: unknown, path = "schema", depth = 0): asserts schema is Schema {
  if (depth > 8) throw new Error(`${path}: nested too deep`);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`${path} must be an object`);
  const s = schema as Record<string, unknown>;
  for (const key of Object.keys(s)) if (!KEYS.has(key)) throw new Error(`${path}: ${key} isn't supported`);
  if (s.type !== undefined && !TYPES.has(s.type as string)) throw new Error(`${path}: type must be one of ${[...TYPES].join(", ")}`);
  if (s.format !== undefined && (typeof s.format !== "string" || !Object.hasOwn(FORMATS, s.format))) throw new Error(`${path}: format must be one of ${Object.keys(FORMATS).join(", ")}`);
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length > 200)) throw new Error(`${path}: enum must be a list of at most 200`);
  if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((r) => typeof r !== "string"))) throw new Error(`${path}: required must be a list of names`);
  if (s.properties !== undefined) {
    if (!s.properties || typeof s.properties !== "object") throw new Error(`${path}: properties must be an object`);
    const entries = Object.entries(s.properties as Record<string, unknown>);
    if (entries.length > 100) throw new Error(`${path}: at most 100 properties`);
    for (const [name, child] of entries) checkSchema(child, `${path}.${name}`, depth + 1);
  }
  if (s.items !== undefined) checkSchema(s.items, `${path}[]`, depth + 1);
  if (s["x-ref"] !== undefined) {
    const ref = s["x-ref"] as Record<string, unknown>;
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) throw new Error(`${path}: x-ref must be { collection, label? }`);
    for (const key of Object.keys(ref)) if (key !== "collection" && key !== "label") throw new Error(`${path}: x-ref.${key} isn't supported`);
    if (typeof ref.collection !== "string" || !COLLECTION_NAME.test(ref.collection)) throw new Error(`${path}: x-ref.collection must be a collection name`);
    if (ref.label !== undefined && (typeof ref.label !== "string" || !ref.label)) throw new Error(`${path}: x-ref.label must be a field name`);
  }
  if (s["x-ownership"] !== undefined && s["x-ownership"] !== "creator" && s["x-ownership"] !== "any") {
    throw new Error(`${path}: x-ownership must be creator or any`);
  }
}

const typeOf = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

/**
 * What is wrong with `value`, as `{ path, message }`; empty if nothing. A
 * record's required field must hold something (not null or ""); with
 * `presence`, as for a tool's arguments, it only has to be there.
 */
export function validate(schema: Schema, value: unknown, path = "", presence = false): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  const at = path || "record";
  const fail = (message: string) => errors.push({ path, message });
  if (schema.type) {
    const t = typeOf(value);
    const ok = schema.type === "integer" ? Number.isInteger(value) : schema.type === "number" ? t === "number" && Number.isFinite(value) : t === schema.type;
    if (!ok) {
      fail(`${at} must be ${schema.type === "integer" ? "a whole number" : schema.type === "array" ? "a list" : `a ${schema.type}`}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) fail(`${at} must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(schema.minLength === 1 ? `${at} is required` : `${at} must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`${at} must be at most ${schema.maxLength} characters`);
    if (schema.format && value && !FORMATS[schema.format].test(value)) fail(`${at} must be ${schema.format === "uri" ? "a web address" : `a ${schema.format}`}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`${at} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`${at} must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => errors.push(...validate(schema.items!, item, `${path}[${i}]`, presence)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const empty = (v: unknown) => v === undefined || (!presence && (v === null || v === ""));
    for (const name of schema.required ?? []) if (!Object.hasOwn(record, name) || empty(record[name])) errors.push({ path: path ? `${path}.${name}` : name, message: `${schema.properties?.[name]?.title ?? name} is required` });
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      // Only absent fields skip their schema; the kernel drops cleared ones (null or "") before validating.
      if (!Object.hasOwn(record, name) || record[name] === undefined) continue;
      errors.push(...validate(child, record[name], path ? `${path}.${name}` : name, presence));
    }
  }
  return errors;
}
