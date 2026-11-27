import { findToolSpec, readToolSpecs, resolveArgName, satisfiesRequired } from "./toolSchema.ts";

/**
 * Reading a tool call back out of an Adapta reply.
 *
 * The contract asks for one idiomatic command per block, but live models drift: they
 * omit the language tag, forget the closing fence, embed a heredoc whose body contains
 * ```, or leave the native DSML closing tags of the model they are proxying. Every case
 * below was observed in live traffic; the parser recovers the command instead of handing
 * markup to the client's shell.
 */

/** Any DSML tag, in the three bar variants the proxied models emit. */
const DSML_ANY_TAG_RE =
  /<\/?(?:｜｜DSML｜｜|｜DSML｜|\|DSML\|)\s*(?:function_calls|calls|invoke|parameter)\b[^>]*>/gi;

/**
 * Remove DSML tags that survived the shared normalizer.
 *
 * A reply that closes the protocol without opening it (the usual "forgot the fence"
 * case) leaves orphan `</…parameter>` / `</…invoke>` lines behind. Capturing to the end
 * of the text then puts those tags INSIDE the command and the client runs markup.
 */
export function stripDsmlResidue(text: string): string {
  if (typeof text !== "string" || !text) return text;
  if (!/DSML/i.test(text)) return text;
  return text.replace(DSML_ANY_TAG_RE, "");
}

const BASH_OPEN_RE = /```(?:bash|sh|shell|zsh)[^\S\n]*\n/;
const ANY_FENCE_OPEN_RE = /```[^\S\n]*\n/;

function countFences(text: string): number {
  return (text.match(/```/g) || []).length;
}

/**
 * Extract the shell command from a reply, or null when there is none.
 *
 * Order matters: a tagged block is preferred, then the largest untagged block (a
 * heredoc body may itself contain fences), and finally an unclosed block — only when
 * the fence count is odd, so a stray closing fence is never mistaken for an opening one.
 */
export function extractCommand(text: string): string | null {
  if (typeof text !== "string") return null;
  const clean = stripDsmlResidue(text);

  // Tagged, closed. Greedy to the LAST closing fence so a heredoc survives.
  const tagged = /```(?:bash|sh|shell|zsh)\s*\n([\s\S]*)```/.exec(clean);
  if (tagged && tagged[1].trim()) return tagged[1].trim();

  // Tagged, unclosed.
  if (BASH_OPEN_RE.test(clean) && countFences(clean) % 2 === 1) {
    const open = /```(?:bash|sh|shell|zsh)\s*\n([\s\S]+)/.exec(clean);
    if (open && open[1].trim()) return open[1].trim();
  }

  // Untagged, closed: take the largest block.
  const fences: string[] = [];
  const fenceRe = /```\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(clean)) !== null) {
    if (m[1].trim()) fences.push(m[1].trim());
  }
  if (fences.length > 0) {
    const best = fences.sort((a, b) => b.length - a.length)[0];
    if (!best.startsWith("{") && !best.startsWith("[") && !best.startsWith("<")) return best;
  }

  // Untagged, unclosed.
  if (ANY_FENCE_OPEN_RE.test(clean) && countFences(clean) % 2 === 1) {
    const open = /```\s*\n([\s\S]+)/.exec(clean);
    const body = open?.[1]?.trim();
    if (body && !body.startsWith("{") && !body.startsWith("[") && !body.startsWith("<")) {
      return body;
    }
  }

  return null;
}

// ── Command -> declared tool ──────────────────────────────────────────────────

const PATH_ARGS = ["path", "filePath", "file_path", "filename", "file"] as const;
const CONTENT_ARGS = ["content", "text", "data"] as const;
const PATTERN_ARGS = ["pattern", "query", "regex"] as const;
const OLD_ARGS = ["oldString", "old_string", "oldText", "search"] as const;
const NEW_ARGS = ["newString", "new_string", "newText", "replace"] as const;

function unquote(value: string): string {
  return value.replace(/^(['"])([\s\S]*)\1$/, "$2");
}

/** Build the argument object for a tool, using only names the client declared. */
function buildArgs(
  spec: NonNullable<ReturnType<typeof findToolSpec>>,
  fields: Record<string, string | undefined>
): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  for (const [logical, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const argsFor: Record<string, readonly string[]> = {
      path: PATH_ARGS,
      content: CONTENT_ARGS,
      pattern: PATTERN_ARGS,
      old: OLD_ARGS,
      new: NEW_ARGS,
    };
    const candidates = argsFor[logical];
    if (!candidates) continue;
    const name = resolveArgName(spec, candidates);
    // A declared field we cannot name is a mapping we must not guess: fall back to shell.
    if (!name) return null;
    args[name] = value;
  }
  return satisfiesRequired(spec, args) ? args : null;
}

/**
 * Map a single-purpose shell command onto the specific tool the client declared.
 *
 * Every argument name is resolved from the client's own schema, so this works for any
 * client naming (`path` or `filePath`, `oldString` or `old_string`, …) and can never
 * emit a call the tool rejects.
 *
 * Deliberately conservative: compound commands (pipes, chaining, subshells, several
 * redirects) stay shell, because rewriting part of a compound command would change what
 * was asked for.
 */
export function classifyBashCommand(
  command: string,
  tools: unknown
): { name: string; args: Record<string, unknown> } | null {
  const cmd = command.trim();
  if (!cmd || /[|&;`$()]/.test(cmd)) return null;
  if ((cmd.match(/>/g) || []).length > 1 || cmd.includes(">>")) return null;

  const specs = readToolSpecs(tools);
  const asCall = (
    spec: ReturnType<typeof findToolSpec>,
    fields: Record<string, string | undefined>
  ) => {
    if (!spec) return null;
    const args = buildArgs(spec, fields);
    return args ? { name: spec.name, args } : null;
  };

  const readSpec = findToolSpec(specs, "read", "readfile", "view", "open");
  const writeSpec = findToolSpec(specs, "write", "writefile", "create");
  const grepSpec = findToolSpec(specs, "grep", "search", "ripgrep");
  const globSpec = findToolSpec(specs, "glob", "list", "ls", "find");
  const editSpec = findToolSpec(specs, "edit", "replace", "patch");

  const cat = /^cat\s+([^\s|&;]+)$/.exec(cmd);
  if (cat) return asCall(readSpec, { path: unquote(cat[1]) });

  const head = /^(?:head|tail)\s+(?:-n\s*)?(\d+)?\s*([^\s|&;]+)$/.exec(cmd);
  if (head && head[2]) return asCall(readSpec, { path: unquote(head[2]) });

  const sedRead = /^sed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s+([^\s|&;]+)$/.exec(cmd);
  if (sedRead) return asCall(readSpec, { path: unquote(sedRead[3]) });

  const write = /^(?:printf|echo)\s+(['"])([\s\S]*)\1\s*>\s*(\S+)$/.exec(cmd);
  if (write) return asCall(writeSpec, { path: unquote(write[3]), content: write[2] });

  const grep = /^(?:grep|rg)\s+(?:-[a-zA-Z]+\s+)*(['"]?)([^'"]+)\1\s+([^\s|&;]+)$/.exec(cmd);
  if (grep) return asCall(grepSpec, { pattern: grep[2], path: unquote(grep[3]) });

  const glob = /^(?:ls|find)\s+(?!-[a-zA-Z])([^\s|&;]+)$/.exec(cmd);
  if (glob) return asCall(globSpec, { pattern: unquote(glob[1]) });

  const edit = /^sed\s+-i\s+(['"]?)s\/([^/]*)\/([^/]*)\/\1\s+(\S+)$/.exec(cmd);
  if (edit) return asCall(editSpec, { path: unquote(edit[4]), old: edit[2], new: edit[3] });

  return null;
}

/** The tool a command should fall back to when nothing maps: the client's shell tool. */
export function shellToolName(tools: unknown): string | null {
  const spec = findToolSpec(readToolSpecs(tools), "bash", "shell", "terminal", "exec");
  return spec?.name ?? null;
}
