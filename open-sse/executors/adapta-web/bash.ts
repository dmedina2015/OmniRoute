/**
 * Reading a tool call back out of an Adapta reply.
 *
 * The contract asks for one fenced `bash` block, but live models drift: they omit the
 * language tag, forget the closing fence, embed a heredoc whose body contains ```,
 * or leave the native DSML closing tags of the model they are proxying. Every case
 * below was observed in live traffic; the parser recovers the command instead of
 * handing markup to the client's shell.
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

interface ToolDef {
  function?: { name?: string };
}

function requestedNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return (tools as ToolDef[])
    .map((t) => t?.function?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

function findTool(tools: unknown, name: string): string | null {
  const target = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    requestedNames(tools).find((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "") === target) ?? null
  );
}

/**
 * Map a simple shell command to the specific tool the client declared (read, write,
 * grep, glob, edit) instead of the generic shell tool.
 *
 * Deliberately conservative: anything with pipes, chaining, subshells, backticks or
 * several redirects stays a shell command, because rewriting a compound command as a
 * single "read" or "write" would change what the user asked for.
 */
export function classifyBashCommand(
  command: string,
  tools: unknown
): { name: string; args: Record<string, unknown> } | null {
  const cmd = command.trim();
  if (!cmd || /[|&;`$()]/.test(cmd)) return null;
  if ((cmd.match(/>/g) || []).length > 1 || cmd.includes(">>")) return null;

  const read = /^(?:cat|head|tail|less)\s+(\S+)$/.exec(cmd);
  const readTool = findTool(tools, "read");
  if (read && readTool) {
    const start = /-n\s+(\d+)$/.exec(cmd)?.[1];
    return {
      name: readTool,
      args: {
        filePath: read[1].replace(/^['"]|['"]$/g, ""),
        ...(start ? { limit: Number(start) } : {}),
      },
    };
  }

  const write = /^(?:printf|echo)\s+(['"])([\s\S]*)\1\s*>\s*(\S+)$/.exec(cmd);
  const writeTool = findTool(tools, "write");
  if (write && writeTool) {
    return {
      name: writeTool,
      args: { filePath: write[3].replace(/^['"]|['"]$/g, ""), content: write[2] },
    };
  }

  const grep = /^(?:grep|rg)\s+(?:-n\s+)?(['"]?)([^'"]+)\1\s+(\S+)$/.exec(cmd);
  const grepTool = findTool(tools, "grep");
  if (grep && grepTool) {
    return {
      name: grepTool,
      args: { pattern: grep[2], path: grep[3].replace(/^['"]|['"]$/g, "") },
    };
  }

  const glob = /^(?:ls|find)\s+(\S+)$/.exec(cmd);
  const globTool = findTool(tools, "glob");
  if (glob && globTool && !cmd.startsWith("ls -la")) {
    return { name: globTool, args: { pattern: glob[1].replace(/^['"]|['"]$/g, "") } };
  }

  const edit = /^sed\s+-i\s+(['"]?)s\/([^/]*)\/([^/]*)\/\1\s+(\S+)$/.exec(cmd);
  const editTool = findTool(tools, "edit");
  if (edit && editTool) {
    return {
      name: editTool,
      args: {
        filePath: edit[4].replace(/^['"]|['"]$/g, ""),
        oldString: edit[2],
        newString: edit[3],
      },
    };
  }

  return null;
}

/** The tool the command should be delivered as: a specific one when it maps, else the shell. */
export function shellToolName(tools: unknown): string | null {
  return (
    findTool(tools, "bash") ??
    findTool(tools, "shell") ??
    findTool(tools, "terminal") ??
    findTool(tools, "exec")
  );
}
