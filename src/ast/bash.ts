import path from "node:path";

export type ShellOperator = "|" | "||" | "&&" | ";" | "&" | "\n";

export interface ShellWord {
  readonly text: string;
  readonly quoted: boolean;
}

export interface SimpleCommand {
  readonly envAssignments: readonly string[];
  readonly words: readonly ShellWord[];
  readonly operatorAfter: ShellOperator | null;
  readonly depth: number;
  readonly shellCOrigin?: number;
  readonly hasRedirection?: boolean;
}

export interface UnwrappedCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly rejectedFlag: string | null;
  readonly rawWords: readonly string[];
}

export interface GitCommitInvocation {
  readonly amend: boolean;
  readonly noEdit: boolean;
  readonly args: readonly string[];
}

export interface ParsedShellScript {
  readonly commands: readonly SimpleCommand[];
  readonly unwrapped: readonly UnwrappedCommand[];
  readonly gitCommits: readonly GitCommitInvocation[];
  readonly malformed: boolean;
}

const MAX_COMMAND_BYTES = 262_144;
const MAX_SUBSTITUTION_DEPTH = 12;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

const PREFIXES = new Set([
  "if",
  "elif",
  "then",
  "else",
  "do",
  "while",
  "until",
  "!",
  "time",
  "command",
  "builtin",
  "nohup",
]);

const GROUP_ENDS = new Set(["fi", "done", "esac", "}"]);

const SHELLS = new Set(["sh", "bash", "zsh"]);

const NON_EXECUTION_FLAGS = new Set([
  "-h",
  "--help",
  "-V",
  "--version",
  "--dry-run",
  "--collect-only",
]);

const UV_TOOL_FLAGS = new Set([
  "--offline",
  "--no-cache",
  "--isolated",
  "--no-env-file",
]);

const UV_TOOL_OPTIONS = new Set([
  "--from",
  "-w",
  "--with",
  "--python",
  "-c",
  "--constraints",
]);

const UV_RUN_FLAGS = new Set([
  "--offline",
  "--no-sync",
  "--no-project",
  "--isolated",
  "--locked",
  "--frozen",
  "--no-dev",
  "--no-env-file",
]);

const UV_RUN_OPTIONS = new Set(["--with", "--python", "--package"]);
const GIT_OPTIONS = new Set(["-c", "-C", "--git-dir", "--work-tree"]);

const ANSI_ESCAPES = new Map([
  ["a", "\u0007"],
  ["b", "\b"],
  ["e", "\u001B"],
  ["E", "\u001B"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"'],
  ["?", "?"],
]);

const quotedNonAssignments = new WeakSet<ShellWord>();

const isAssignment = (word: ShellWord | undefined): boolean =>
  word !== undefined &&
  !quotedNonAssignments.has(word) &&
  ASSIGNMENT.test(word.text);

const skipOptions = (
  words: readonly string[],
  start: number,
  flags: Set<string>,
  options: Set<string>
): number => {
  let index = start;

  while (index < words.length) {
    const word = words[index] ?? "";
    const equals = word.indexOf("=");

    if (word === "--") {
      return index + 1;
    }

    if (flags.has(word)) {
      index += 1;
    } else if (options.has(word)) {
      index += 2;
    } else if (equals > 0 && options.has(word.slice(0, equals))) {
      index += 1;
    } else {
      break;
    }
  }

  return index;
};

export const skipShellFlags = (args: readonly string[]): number => {
  let index = 0;

  while (index < args.length) {
    const arg = args[index];

    if (
      arg === undefined ||
      arg === "-c" ||
      !arg.startsWith("-") ||
      arg === "-"
    ) {
      break;
    }

    index += 1;

    if (arg === "--") {
      break;
    }
  }

  return index;
};

const normalizeExecutable = (word: string): string =>
  path.posix.basename(word).replace(/(?:===?|!=|<=?|>=?|~=|@).+$/u, "");

const skipEnvOptions = (rawWords: readonly string[], start: number): number => {
  let index = start;

  while (index < rawWords.length) {
    const option = rawWords[index] ?? "";

    if (option === "-i" || ASSIGNMENT.test(option)) {
      index += 1;
    } else if (option === "-u") {
      index += 2;
    } else {
      break;
    }
  }

  return index;
};

const skipCommandPrefixes = (
  cmd: SimpleCommand,
  rawWords: readonly string[]
): number => {
  let index = 0;

  while (index < rawWords.length) {
    const word = rawWords[index] ?? "";

    if (
      (PREFIXES.has(word) && cmd.words[index]?.quoted !== true) ||
      isAssignment(cmd.words[index])
    ) {
      index += 1;
    } else if (path.posix.basename(word) === "env") {
      index = skipEnvOptions(rawWords, index + 1);
    } else {
      break;
    }
  }

  return index;
};

const skipPythonModuleWrapper = (
  rawWords: readonly string[],
  start: number
): number => {
  if (
    !/^python(?:\d+(?:\.\d+)?)?$/u.test(
      path.posix.basename(rawWords[start] ?? "")
    )
  ) {
    return start;
  }

  let flag = start + 1;

  while (/^-[BEsSuO]+$/u.test(rawWords[flag] ?? "")) {
    flag += 1;
  }

  return rawWords[flag] === "-m" ? flag + 1 : start;
};

export const unwrapSimpleCommand = (
  cmd: SimpleCommand
): UnwrappedCommand | null => {
  const rawWords = cmd.words.map(({ text }) => text);
  let index = skipCommandPrefixes(cmd, rawWords);
  const wrapper = path.posix.basename(rawWords[index] ?? "");

  if (wrapper === "uvx") {
    index = skipOptions(rawWords, index + 1, UV_TOOL_FLAGS, UV_TOOL_OPTIONS);
  } else if (
    wrapper === "uv" &&
    rawWords[index + 1] === "tool" &&
    rawWords[index + 2] === "run"
  ) {
    index = skipOptions(rawWords, index + 3, UV_TOOL_FLAGS, UV_TOOL_OPTIONS);
  } else if (wrapper === "uv" && rawWords[index + 1] === "run") {
    index = skipOptions(rawWords, index + 2, UV_RUN_FLAGS, UV_RUN_OPTIONS);
  }

  index = skipPythonModuleWrapper(rawWords, index);
  const executable = normalizeExecutable(rawWords[index] ?? "");

  if (!executable) {
    return null;
  }

  const args = rawWords.slice(index + 1);

  return {
    executable,
    args,
    rejectedFlag: args.find((arg) => NON_EXECUTION_FLAGS.has(arg)) ?? null,
    rawWords,
  };
};

const parseShortCommitFlags = (arg: string): "abort" | "consumeNext" | "ok" => {
  for (let short = 1; short < arg.length; short += 1) {
    const option = arg.charAt(short);

    if (option === "h" || option === "V") {
      return "abort";
    }

    if ("mFCct".includes(option)) {
      return short + 1 === arg.length ? "consumeNext" : "ok";
    }

    if (option === "S") {
      return "ok";
    }
  }

  return "ok";
};

export const extractGitCommit = ({
  executable,
  args,
}: UnwrappedCommand): GitCommitInvocation | null => {
  if (executable !== "git") {
    return null;
  }

  let index = 0;

  while (index < args.length) {
    const option = args[index] ?? "";

    if (GIT_OPTIONS.has(option)) {
      index += 2;
    } else if (
      option === "--no-pager" ||
      /^--(?:git-dir|work-tree)=/u.test(option)
    ) {
      index += 1;
    } else {
      break;
    }
  }

  if (args[index] !== "commit") {
    return null;
  }

  const commitArgs = args.slice(index + 1);
  let amend = false;
  let noEdit = false;

  for (let flag = 0; flag < commitArgs.length; flag += 1) {
    const arg = commitArgs[flag] ?? "";

    if (arg === "--") {
      break;
    }

    if (NON_EXECUTION_FLAGS.has(arg)) {
      return null;
    }

    if (arg === "--amend") {
      amend = true;
    }

    if (arg === "--no-edit") {
      noEdit = true;
    }

    if (
      /^--(?:message|file|reuse-message|reedit-message|template|author|date|fixup|squash|trailer|pathspec-from-file)$/u.test(
        arg
      )
    ) {
      flag += 1;
    } else if (/^-[^-]/u.test(arg)) {
      const status = parseShortCommitFlags(arg);

      if (status === "abort") {
        return null;
      }

      if (status === "consumeNext") {
        flag += 1;
      }
    }
  }

  return { amend, noEdit, args: commitArgs };
};

interface Heredoc {
  readonly delimiter: string;
  readonly stripLeadingTabs: boolean;
  readonly quoted: boolean;
}

const escapeDigitPattern = (char: string): RegExp | null => {
  if (char === "x") {
    return /^[\da-f]{1,2}/iu;
  }

  if (char === "u") {
    return /^[\da-f]{1,4}/iu;
  }

  if (char === "U") {
    return /^[\da-f]{1,8}/iu;
  }

  return /^[0-7]$/u.test(char) ? /^[0-7]{0,2}/u : null;
};

interface ShellAnalysis {
  malformed: boolean;
  readonly commands: SimpleCommand[];
  readonly unwrapped: UnwrappedCommand[];
  readonly gitCommits: GitCommitInvocation[];
}

const shellOperator = (text: string): ShellOperator | null => {
  if (text.startsWith("||")) {
    return "||";
  }

  if (text.startsWith("&&")) {
    return "&&";
  }

  const char = text.charAt(0);

  return char === "|" || char === ";" || char === "&" || char === "\n"
    ? char
    : null;
};

class ShellScanner {
  private index = 0;
  private readonly shellPayloads = new WeakMap<ShellWord, string | null>();
  private readonly source: string;
  private readonly result: ShellAnalysis;
  private readonly shellCOrigin: number | undefined;

  constructor(source: string, result: ShellAnalysis, shellCOrigin?: number) {
    this.source = source;
    this.result = result;
    this.shellCOrigin = shellCOrigin;
  }

  private char(): string {
    return this.source.charAt(this.index);
  }

  private starts(text: string): boolean {
    return this.source.startsWith(text, this.index);
  }

  private ansiEscape(): string {
    const char = this.char();

    this.index += 1;

    const simple = ANSI_ESCAPES.get(char);

    if (simple !== undefined) {
      return simple;
    }

    if (char === "\n") {
      return "";
    }

    const tail = this.source.slice(this.index);
    const pattern = escapeDigitPattern(char);
    const digits = pattern?.exec(tail)?.[0];

    if (digits !== undefined) {
      this.index += digits.length;

      const octal = /^[0-7]$/u.test(char);

      const code = octal
        ? Number.parseInt(char + digits, 8)
        : Number.parseInt(digits, 16);

      return String.fromCodePoint(
        octal ? code % 256 : Math.min(code, 0x10_ff_ff)
      );
    }

    if (char === "c" && this.char()) {
      const upper = this.char().toUpperCase().codePointAt(0) ?? 0;
      const code = upper >= 64 ? upper - 64 : upper + 64;

      this.index += 1;

      return String.fromCodePoint(code);
    }

    return `\\${char}`;
  }

  private substitution(depth: number, groups: number): void {
    if (depth >= MAX_SUBSTITUTION_DEPTH) {
      this.result.malformed = true;

      return;
    }

    if (this.starts("$(")) {
      this.index += 2;
      this.scan(depth + 1, groups, true);

      return;
    }

    this.index += 1;

    const payload: string[] = [];

    while (this.char() && this.char() !== "`") {
      if (
        this.char() === "\\" &&
        "\\$`\n".includes(this.source.charAt(this.index + 1))
      ) {
        this.index += 1;

        if (this.char() !== "\n") {
          payload.push(this.char());
        }
      } else {
        payload.push(this.char());
      }

      this.index += 1;
    }

    if (!this.char()) {
      this.result.malformed = true;

      return;
    }

    this.index += 1;
    new ShellScanner(payload.join(""), this.result).scan(depth + 1, groups);
  }

  private arithmetic(depth: number, groups: number): void {
    if (depth >= MAX_SUBSTITUTION_DEPTH) {
      this.result.malformed = true;

      return;
    }

    let parentheses = 2;

    this.index += this.starts("$((") ? 3 : 2;

    while (this.char() && !this.result.malformed) {
      if ((this.starts("$(") && !this.starts("$((")) || this.char() === "`") {
        this.substitution(depth, groups);
      } else if (this.char() === "'" || this.char() === '"') {
        this.word(depth + 1, groups, false, true);
      } else {
        const char = this.char();

        this.index += 1;

        if (char === "(") {
          parentheses += 1;
        }

        if (char === ")") {
          parentheses -= 1;
        }

        if (char === "\\" && this.char()) {
          this.index += 1;
        }

        if (parentheses === 0) {
          return;
        }
      }
    }

    this.result.malformed = true;
  }

  private consumeWordEscape(quote: string, parts: string[]): boolean {
    this.index += 1;

    const next = this.char();

    if (!next) {
      this.result.malformed = true;

      return false;
    }

    if (quote === "$'") {
      parts.push(this.ansiEscape());

      return false;
    }

    if (quote === '"' && !'"\\$`\n'.includes(next)) {
      parts.push("\\");

      return false;
    }

    this.index += 1;

    if (next !== "\n") {
      parts.push(next);

      return true;
    }

    return false;
  }

  private consumeWordSubstitution(
    depth: number,
    groups: number,
    parts: string[],
    arithmeticParts: Set<number>
  ): boolean {
    const start = this.index;
    let isDynamic = false;

    if (this.starts("$((")) {
      this.arithmetic(depth, groups);
      arithmeticParts.add(parts.length);
    } else {
      this.substitution(depth, groups);
      isDynamic = true;
    }

    parts.push(this.source.slice(start, this.index));

    return isDynamic;
  }

  private isDynamicDollar(delimiter: boolean, char: string): boolean {
    return (
      !delimiter &&
      char === "$" &&
      /[A-Za-z_0-9{*@#?$!-]/u.test(this.source.charAt(this.index + 1))
    );
  }

  private finalizeWord(
    parts: readonly string[],
    quoted: boolean,
    dynamic: boolean,
    assignment: boolean,
    arithmeticParts: ReadonlySet<number>
  ): ShellWord {
    const word = { text: parts.join(""), quoted };

    if (dynamic) {
      this.shellPayloads.set(word, null);
    } else if (arithmeticParts.size) {
      this.shellPayloads.set(
        word,
        parts
          .map((part, index) => (arithmeticParts.has(index) ? "0" : part))
          .join("")
      );
    }

    if (!assignment && ASSIGNMENT.test(word.text)) {
      quotedNonAssignments.add(word);
    }

    return word;
  }

  private isSubstitutionStart(delimiter: boolean, char: string): boolean {
    return !delimiter && (this.starts("$(") || char === "`");
  }

  private quoteStart(quote: string, char: string): string | null {
    if (quote) {
      return null;
    }

    if (this.starts("$'")) {
      return "$'";
    }

    if (char === "'" || char === '"') {
      return char;
    }

    return null;
  }

  private word(
    depth: number,
    groups: number,
    delimiter = false,
    quoteOnly = false
  ): ShellWord {
    const parts: string[] = [];
    const arithmeticParts = new Set<number>();
    let quote = "";
    let quoted = false;
    let dynamic = false;
    let assignment = false;
    let assignmentPrefix = true;

    const consumePlainChar = (char: string): void => {
      if (this.isDynamicDollar(delimiter, char)) {
        dynamic = true;
      }

      if (assignmentPrefix) {
        assignment ||= char === "=" && parts.length > 0;
        assignmentPrefix = (parts.length ? /[A-Za-z_0-9]/u : /[A-Za-z_]/u).test(
          char
        );
      }

      parts.push(char);
      this.index += 1;
    };

    while (this.char() && !this.result.malformed) {
      const char = this.char();

      if (quote && char === quote.at(-1)) {
        quote = "";
        this.index += 1;

        if (quoteOnly) {
          break;
        }
      } else if (char === "\\" && quote !== "'") {
        if (this.consumeWordEscape(quote, parts)) {
          quoted = true;
          assignmentPrefix = false;
        }
      } else if (quote === "'" || quote === "$'") {
        parts.push(char);
        this.index += 1;
      } else {
        const openedQuote = this.quoteStart(quote, char);

        if (openedQuote !== null) {
          quote = openedQuote;
          quoted = true;
          assignmentPrefix = false;
          this.index += quote.length;
        } else if (this.isSubstitutionStart(delimiter, char)) {
          if (
            this.consumeWordSubstitution(depth, groups, parts, arithmeticParts)
          ) {
            dynamic = true;
          }

          assignmentPrefix = false;
        } else if (quote === "" && /[\t \n;|&()<>]/u.test(char)) {
          break;
        } else {
          consumePlainChar(char);
        }
      }
    }

    if (quote) {
      this.result.malformed = true;
    }

    return this.finalizeWord(
      parts,
      quoted,
      dynamic,
      assignment,
      arithmeticParts
    );
  }

  private consumeHeredocs(heredocs: Heredoc[]): void {
    for (const { delimiter, stripLeadingTabs, quoted } of heredocs) {
      let matched = false;
      const continued: string[] = [];

      while (this.index < this.source.length) {
        const newline = this.source.indexOf("\n", this.index);
        const end = newline === -1 ? this.source.length : newline;
        const physicalLine = this.source.slice(this.index, end);

        const line =
          stripLeadingTabs && !continued.length
            ? physicalLine.replace(/^\t+/u, "")
            : physicalLine;

        this.index = newline === -1 ? end : end + 1;

        if (
          !quoted &&
          newline !== -1 &&
          /(?:^|[^\\])(?:\\\\)*\\$/u.test(line)
        ) {
          continued.push(line.slice(0, -1));
          continue;
        }

        continued.push(line);

        if (continued.join("") === delimiter) {
          matched = true;
          break;
        }

        continued.length = 0;
      }

      if (!matched) {
        this.result.malformed = true;
      }
    }

    heredocs.length = 0;
  }

  private inspectNestedShell(
    cmd: SimpleCommand,
    unwrapped: UnwrappedCommand,
    commandIndex: number,
    depth: number,
    nesting: number
  ): void {
    if (!SHELLS.has(unwrapped.executable)) {
      return;
    }

    const argIndex = skipShellFlags(unwrapped.args);
    const first = unwrapped.args[argIndex];
    const payload = unwrapped.args[argIndex + 1];

    if (first === "-c" && payload !== undefined) {
      const noExec = unwrapped.args
        .slice(0, argIndex)
        .some(
          (flag) =>
            flag === "--noexec" ||
            flag === "--dump-strings" ||
            (/^-[A-Za-z]+$/u.test(flag) &&
              (flag.includes("n") || flag.includes("D")))
        );

      if (noExec) {
        return;
      }

      const word =
        cmd.words[cmd.words.length - unwrapped.args.length + argIndex + 1];

      const masked = word ? this.shellPayloads.get(word) : undefined;

      if (masked === null || depth >= MAX_SUBSTITUTION_DEPTH) {
        this.result.malformed = true;
      } else {
        new ShellScanner(masked ?? payload, this.result, commandIndex).scan(
          depth + 1,
          nesting
        );
      }
    } else if (first?.endsWith(".sh") === true && !first.startsWith("-")) {
      this.result.unwrapped.push({
        ...unwrapped,
        executable: normalizeExecutable(first),
        args: unwrapped.args.slice(argIndex + 1),
      });
    }
  }

  private emit(
    words: ShellWord[],
    operatorAfter: ShellOperator | null,
    depth: number,
    nesting: number,
    hasRedirection: boolean
  ): void {
    let index = 0;

    while (isAssignment(words[index])) {
      index += 1;
    }

    if (!words.length && !hasRedirection) {
      return;
    }

    const head = words[index];

    if (head && !head.quoted && GROUP_ENDS.has(head.text)) {
      return;
    }

    let cmd: SimpleCommand = {
      envAssignments: words.slice(0, index).map(({ text }) => text),
      words: words.slice(index),
      operatorAfter,
      depth: depth + nesting,
    };

    if (hasRedirection) {
      cmd = { ...cmd, hasRedirection: true };
    }

    if (nesting === 0 && this.shellCOrigin !== undefined) {
      cmd = { ...cmd, shellCOrigin: this.shellCOrigin };
    }

    const commandIndex = this.result.commands.length;
    this.result.commands.push(cmd);

    const unwrapped = unwrapSimpleCommand(cmd);

    if (!unwrapped) {
      return;
    }

    this.result.unwrapped.push(unwrapped);

    const commit = extractGitCommit(unwrapped);

    if (commit) {
      this.result.gitCommits.push(commit);
    }

    this.inspectNestedShell(cmd, unwrapped, commandIndex, depth, nesting);
  }

  private consumeRedirection(
    redirect: string,
    depth: number,
    groups: number,
    heredocs: Heredoc[]
  ): void {
    const heredoc = /(?:^|\d)<<-?$/u.test(redirect);

    this.index += redirect.length;

    while (this.char() === " " || this.char() === "\t" || this.starts("\\\n")) {
      this.index += this.char() === "\\" ? 2 : 1;
    }

    const start = this.index;

    const word = this.char() === "#" ? null : this.word(depth, groups, heredoc);

    if (!word || start === this.index) {
      this.result.malformed = true;
    }

    if (word && heredoc) {
      heredocs.push({
        delimiter: word.text,
        stripLeadingTabs: redirect.endsWith("-"),
        quoted: word.quoted,
      });
    }
  }

  private skipSpacesOrComment(): boolean {
    const char = this.char();

    if (char === " " || char === "\t" || this.starts("\\\n")) {
      this.index += char === "\\" ? 2 : 1;

      return true;
    }

    if (char === "#") {
      const newline = this.source.indexOf("\n", this.index);
      this.index = newline === -1 ? this.source.length : newline;

      return true;
    }

    return false;
  }

  private matchRedirection(redirection: RegExp): string | undefined {
    if (!/[\d<>&]/u.test(this.char())) {
      return undefined;
    }

    redirection.lastIndex = this.index;

    return redirection.exec(this.source)?.[0];
  }

  scan(depth = 0, nesting = 0, substitution = false): void {
    const heredocs: Heredoc[] = [];
    const redirection = /(?:\d*|&)(?:<<<|<<-|<<|<>|<&|>&|>\||>>|<|>)/uy;
    let words: ShellWord[] = [];
    let hasRedirection = false;
    let groups = 0;
    let closed = !substitution;

    while (this.char() && !this.result.malformed) {
      if (this.skipSpacesOrComment()) {
        continue;
      }

      const char = this.char();

      const operator = this.starts("&>")
        ? null
        : shellOperator(this.source.slice(this.index, this.index + 2));

      const redirect = this.matchRedirection(redirection);

      if (operator !== null) {
        this.index += operator.length;
        this.emit(words, operator, depth, nesting + groups, hasRedirection);
        words = [];
        hasRedirection = false;

        if (operator === "\n") {
          this.consumeHeredocs(heredocs);
        }
      } else if (this.starts("((")) {
        this.arithmetic(depth, nesting + groups);
      } else if (char === "(" || char === ")") {
        this.emit(words, null, depth, nesting + groups, hasRedirection);
        words = [];
        hasRedirection = false;
        this.index += 1;

        if (char === "(") {
          groups += 1;
        } else if (groups > 0) {
          groups -= 1;
        } else {
          closed = substitution;
          break;
        }
      } else if (redirect === undefined) {
        words.push(this.word(depth, nesting + groups));
      } else {
        hasRedirection = true;
        this.consumeRedirection(redirect, depth, nesting + groups, heredocs);
      }
    }

    if (!closed || groups || heredocs.length) {
      this.result.malformed = true;
    }

    if (!this.result.malformed) {
      this.emit(words, null, depth, nesting + groups, hasRedirection);
    }
  }
}

export const parseShellScript = (command: string): ParsedShellScript => {
  const result: ShellAnalysis = {
    commands: [],
    unwrapped: [],
    gitCommits: [],
    malformed: false,
  };

  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) {
    result.malformed = true;
  } else {
    new ShellScanner(command, result).scan();
  }

  return result;
};
