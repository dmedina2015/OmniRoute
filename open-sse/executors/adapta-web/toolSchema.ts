/**
 * Read the tool declarations the CLIENT sent and answer questions about them.
 *
 * A provider adapter must not guess how a client named its tools or its arguments:
 * OpenCode asks for `read`/`path`, another client may ask for `read_file`/`file_path`.
 * Everything the adapter needs is already in `body.tools[].function`, so the mapping is
 * derived from the request instead of hardcoded.
 */

export interface ToolSpec {
  /** Name exactly as declared — the name the response must use. */
  name: string;
  description?: string;
  required: string[];
  properties: Record<string, { type?: string }>;
}

interface RawTool {
  function?: {
    name?: string;
    description?: string;
    parameters?: {
      required?: unknown;
      properties?: unknown;
    };
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readToolSpecs(tools: unknown): ToolSpec[] {
  if (!Array.isArray(tools)) return [];
  const specs: ToolSpec[] = [];
  for (const raw of tools as RawTool[]) {
    const fn = raw?.function;
    if (!fn?.name) continue;
    const params = asRecord(fn.parameters);
    const required = Array.isArray(params?.required)
      ? params.required.filter((r): r is string => typeof r === "string")
      : [];
    const propertiesRaw = asRecord(params?.properties) ?? {};
    const properties: Record<string, { type?: string }> = {};
    for (const [key, value] of Object.entries(propertiesRaw)) {
      const prop = asRecord(value);
      properties[key] = { type: typeof prop?.type === "string" ? prop.type : undefined };
    }
    specs.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : undefined,
      required,
      properties,
    });
  }
  return specs;
}

/** Normalize a name for fuzzy matching: `read_file` / `readFile` / `Read` -> `readfile`. */
export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Find a declared tool whose name matches one of `candidates`. */
export function findToolSpec(specs: ToolSpec[], ...candidates: string[]): ToolSpec | null {
  for (const candidate of candidates) {
    const target = normalizeToolName(candidate);
    const exact = specs.find((s) => normalizeToolName(s.name) === target);
    if (exact) return exact;
  }
  return null;
}

/**
 * Resolve the declared argument name for a logical field.
 *
 * Only names the client actually declared are returned, so the adapter can never send
 * an argument the tool does not accept (the bug that made `read` fail: the client
 * declares `path`, the adapter used to send `filePath`).
 */
export function resolveArgName(spec: ToolSpec, candidates: readonly string[]): string | null {
  const declared = Object.keys(spec.properties);
  for (const candidate of candidates) {
    const target = normalizeToolName(candidate);
    const match = declared.find((d) => normalizeToolName(d) === target);
    if (match) return match;
  }
  return null;
}

/** True when every required argument of the spec is present in `args`. */
export function satisfiesRequired(spec: ToolSpec, args: Record<string, unknown>): boolean {
  return spec.required.every((key) => {
    const value = args[key];
    return value !== undefined && value !== null && value !== "";
  });
}
