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

/**
 * Drop a language label the model repeated INSIDE the block.
 *
 * Observed live: the reply was "```bash\nbash\nls /tmp/*.txt\n```" — the model copied
 * the fence tag into the command, so the "command" started with the word bash and
 * matched nothing. Only an exact first-line label is removed.
 */
/**
 * Cut at a fence that was glued to the next block.
 *
 * The greedy capture exists so a heredoc may contain fences; it also swallowed a
 * second block when the model wrote two of them back to back and the closing fence ran
 * straight into the next opening one ("... | sort" then six backticks then "bash").
 * Only that adjacent-fence shape is cut, so a real heredoc survives.
 */
function cutAtGluedFence(command: string): string {
  return command.split(/`{6,}(?:bash|sh|shell|zsh)?\s*\r?\n/)[0].trim();
}

function stripLanguageLabel(command: string): string {
  return command.replace(/^(?:bash|sh|shell|zsh)[ \t]*\r?\n/, "").trim();
}

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
  if (tagged && tagged[1].trim()) return stripLanguageLabel(cutAtGluedFence(tagged[1]));

  // Tagged, unclosed.
  if (BASH_OPEN_RE.test(clean) && countFences(clean) % 2 === 1) {
    const open = /```(?:bash|sh|shell|zsh)\s*\n([\s\S]+)/.exec(clean);
    if (open && open[1].trim()) return stripLanguageLabel(open[1]);
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
    if (!best.startsWith("{") && !best.startsWith("[") && !best.startsWith("<"))
      return stripLanguageLabel(best);
  }

  // Untagged, unclosed.
  if (ANY_FENCE_OPEN_RE.test(clean) && countFences(clean) % 2 === 1) {
    const open = /```\s*\n([\s\S]+)/.exec(clean);
    const body = open?.[1]?.trim();
    if (body && !body.startsWith("{") && !body.startsWith("[") && !body.startsWith("<")) {
      return stripLanguageLabel(body);
    }
  }

  return null;
}

// ── Command -> declared tool ──────────────────────────────────────────────────

const PATH_ARGS = ["path", "filePath", "file_path", "filename", "file"] as const;
const CONTENT_ARGS = ["content", "text", "data"] as const;
const PATTERN_ARGS = ["pattern", "query", "regex"] as const;
const INCLUDE_ARGS = ["include", "glob", "filePattern"] as const;
const OLD_ARGS = ["oldString", "old_string", "oldText", "search"] as const;
const NEW_ARGS = ["newString", "new_string", "newText", "replace"] as const;

const OPTIONAL_FIELDS = new Set(["include"]);

/**
 * True when a shell operator appears OUTSIDE quotes.
 *
 * The previous check ran on the raw string, so a quoted pattern containing "(" or "|"
 * ("grep -n \"round(float\" file") was treated as a compound command and fell back to
 * shell — every real search degraded to shell for that reason.
 */
function hasOperatorOutsideQuotes(input: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "`" || ch === "(" || ch === ")") return true;
    if (ch === "&" && input[i + 1] === "&") return true;
    if (ch === "$" && input[i + 1] === "(") return true;
  }
  return false;
}

/**
 * Split a command into tokens, honouring single/double quotes.
 *
 * Needed because a flag may appear AFTER the pattern ("grep -n 'bem' -r dir"), which a
 * single "flags first" regex cannot express.
 */
function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

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
      include: INCLUDE_ARGS,
      old: OLD_ARGS,
      new: NEW_ARGS,
    };
    const candidates = argsFor[logical];
    if (!candidates) continue;
    const name = resolveArgName(spec, candidates);
    if (!name) {
      // Optional extras (e.g. --include) are dropped when the client has no such
      // argument; a required one we cannot name means we must not guess.
      if (OPTIONAL_FIELDS.has(logical)) continue;
      return null;
    }
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
  // Operators are judged on the FIRST line only: a heredoc body legitimately contains
  // "(" and ")" (python code), and those are content, not subshells.
  const firstLine = cmd.split(/\r?\n/)[0];
  if (!cmd || hasOperatorOutsideQuotes(firstLine)) return null;
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

  const cat = /^cat\s+(?:-\S+\s+)*([^\s|&;]+)$/.exec(cmd);
  if (cat) return asCall(readSpec, { path: unquote(cat[1]) });

  // Heredoc write: cat > file <<'EOF' ... EOF  (the usual way a model writes a file).
  const heredocWrite =
    /^cat\s*>\s*([^\s]+)\s*<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2\s*\n([\s\S]*?)\n\3\s*$/.exec(
      cmd
    );
  if (heredocWrite) {
    return asCall(writeSpec, { path: unquote(heredocWrite[1]), content: heredocWrite[4] });
  }

  const nlRead = /^nl\s+(?:-\S+\s+)*([^\s|&;]+)$/.exec(cmd);
  if (nlRead) return asCall(readSpec, { path: unquote(nlRead[1]) });
  const batRead = /^bat\s+(?:-\S+\s+)*([^\s|&;]+)$/.exec(cmd);
  if (batRead) return asCall(readSpec, { path: unquote(batRead[1]) });

  const head = /^(?:head|tail)\s+(?:-n\s*)?(\d+)?\s*([^\s|&;]+)$/.exec(cmd);
  if (head && head[2]) return asCall(readSpec, { path: unquote(head[2]) });

  const sedRead = /^sed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s+([^\s|&;]+)$/.exec(cmd);
  if (sedRead) return asCall(readSpec, { path: unquote(sedRead[3]) });

  const write = /^(?:printf|echo)\s+(['"])([\s\S]*)\1\s*>\s*(\S+)$/.exec(cmd);
  if (write) return asCall(writeSpec, { path: unquote(write[3]), content: write[2] });

  // Flags may be short (-rn, -i) or long with an optional value (--include='*'),
  // which is what models actually write: "grep -rn --include='*' -i 'bem' <dir>".
  // grep/rg: parse by tokens so flags work in any position — models write both
  // "grep -rn --include='*' 'bem' <dir>" and "grep -n 'bem' -r <dir>".
  const tokens = splitArgs(cmd);
  if (tokens[0] === "grep" || tokens[0] === "rg") {
    const rest = tokens.slice(1);
    const flags = rest.filter((t) => t.startsWith("-"));
    const positional = rest.filter((t) => !t.startsWith("-"));
    if (positional.length >= 1) {
      const includeFlag = flags.find((f) => f.startsWith("--include="));
      const include = includeFlag ? includeFlag.slice("--include=".length) : undefined;
      return asCall(grepSpec, {
        pattern: positional[0],
        path: positional[1] ? unquote(positional[1]) : undefined,
        include,
      });
    }
  }

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

/**
 * Commands the adapter is willing to execute as a shell call.
 *
 * Observed loop: asked to show a file, the model pasted the file's TEXT inside a
 * ```bash block. The parser turned it into `shell({command: "Olá, tudo bem?"})`; the
 * client ran it, failed, and the model repeated — fifteen identical calls in one
 * session. A block is only a command if its first token actually is one.
 */
const SHELL_COMMANDS = new Set(
  `ls cat echo printf cd pwd mkdir rmdir rm cp mv ln touch chmod chown chgrp stat file realpath
   readlink basename dirname find grep egrep fgrep rg sed awk gawk cut tr sort uniq wc head tail
   tee xargs split csplit paste join column diff patch cmp md5sum sha1sum sha256sum shasum base64
   openssl tar gzip gunzip bzip2 xz zip unzip 7z git gh npm npx pnpm yarn bun node deno tsc tsx
   python python2 python3 pip pip3 uv poetry go cargo rustc javac java mvn gradle dotnet php ruby
   gem rake perl make cmake ninja docker podman kubectl helm terraform ansible curl wget ssh scp
   rsync nc telnet ping traceroute dig nslookup host ss netstat ps top htop kill pkill killall df
   du free env printenv export unset set source shopt alias which type command test true false
   sleep time date uname whoami id groups sudo su systemctl service journalctl apt apt-get dnf
   yum pacman apk brew snap flatpak jq yq watch nohup timeout seq expr bc tree less more vi vim
   nano code open xdg-open`
    .split(/\s+/)
    .filter(Boolean)
);

/** True when a fenced block plausibly is a shell command and not pasted file content. */
export function looksLikeShellCommand(command: string): boolean {
  const firstLine = command.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) return false;
  // Absolute/relative path execution: /usr/bin/x, ./script.sh, ~/bin/y
  if (/^(?:\.{0,2}\/|~\/)/.test(firstLine)) return true;
  // Env-assignment prefix: FOO=bar cmd ...
  const withoutEnv = firstLine.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, "");
  const first = withoutEnv.split(/\s+/)[0] ?? "";
  return SHELL_COMMANDS.has(first);
}
