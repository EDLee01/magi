/**
 * Minimal syntax highlighting for terminal code blocks.
 *
 * Deliberately small: highlights keywords, strings, comments, numbers, and
 * function-like calls for the languages we see most. Anything more (proper
 * tokenizer per language) is out of scope.
 *
 * Each highlighter takes a single line and returns ANSI-colored output.
 */

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const COLOR = {
  keyword: `${ESC}38;5;141m`, // light purple
  string: `${ESC}38;5;108m`, // green-cyan
  comment: `${ESC}38;5;243m`, // gray
  number: `${ESC}38;5;180m`, // tan
  func: `${ESC}38;5;111m`, // light blue
  type: `${ESC}38;5;180m`, // amber
  punct: `${ESC}38;5;245m`, // gray
  operator: `${ESC}38;5;174m` // pink
};

const TS_JS_KEYWORDS = new Set([
  "abstract",
  "any",
  "as",
  "async",
  "await",
  "boolean",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "constructor",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "is",
  "let",
  "namespace",
  "never",
  "new",
  "null",
  "number",
  "of",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "set",
  "static",
  "string",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "unknown",
  "var",
  "void",
  "while",
  "with",
  "yield"
]);

const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield"
]);

const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "do",
  "done",
  "case",
  "esac",
  "in",
  "function",
  "return",
  "echo",
  "exit",
  "true",
  "false",
  "export",
  "set",
  "unset",
  "local",
  "readonly",
  "declare",
  "alias",
  "source",
  "cd",
  "ls",
  "pwd",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "git",
  "npm",
  "node",
  "python"
]);

const RUST_KEYWORDS = new Set([
  "as",
  "break",
  "const",
  "continue",
  "crate",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  "async",
  "await",
  "dyn"
]);

const GO_KEYWORDS = new Set([
  "break",
  "case",
  "chan",
  "const",
  "continue",
  "default",
  "defer",
  "else",
  "fallthrough",
  "for",
  "func",
  "go",
  "goto",
  "if",
  "import",
  "interface",
  "map",
  "package",
  "range",
  "return",
  "select",
  "struct",
  "switch",
  "type",
  "var",
  "true",
  "false",
  "nil"
]);

interface LangSpec {
  keywords: Set<string>;
  /** Regex matching a comment that runs to end of line. */
  lineComment?: RegExp;
  /** Block comment open/close */
  blockCommentOpen?: string;
  blockCommentClose?: string;
  /** String quote chars */
  stringQuotes?: string[];
}

const LANGS: Record<string, LangSpec> = {
  ts: {
    keywords: TS_JS_KEYWORDS,
    lineComment: /\/\/.*/,
    blockCommentOpen: "/*",
    blockCommentClose: "*/",
    stringQuotes: ['"', "'", "`"]
  },
  js: {
    keywords: TS_JS_KEYWORDS,
    lineComment: /\/\/.*/,
    blockCommentOpen: "/*",
    blockCommentClose: "*/",
    stringQuotes: ['"', "'", "`"]
  },
  tsx: {
    keywords: TS_JS_KEYWORDS,
    lineComment: /\/\/.*/,
    blockCommentOpen: "/*",
    blockCommentClose: "*/",
    stringQuotes: ['"', "'", "`"]
  },
  jsx: {
    keywords: TS_JS_KEYWORDS,
    lineComment: /\/\/.*/,
    blockCommentOpen: "/*",
    blockCommentClose: "*/",
    stringQuotes: ['"', "'", "`"]
  },
  py: { keywords: PYTHON_KEYWORDS, lineComment: /#.*/, stringQuotes: ['"', "'"] },
  python: { keywords: PYTHON_KEYWORDS, lineComment: /#.*/, stringQuotes: ['"', "'"] },
  sh: { keywords: SHELL_KEYWORDS, lineComment: /#.*/, stringQuotes: ['"', "'"] },
  bash: { keywords: SHELL_KEYWORDS, lineComment: /#.*/, stringQuotes: ['"', "'"] },
  zsh: { keywords: SHELL_KEYWORDS, lineComment: /#.*/, stringQuotes: ['"', "'"] },
  shell: { keywords: SHELL_KEYWORDS, lineComment: /#.*/, stringQuotes: ['"', "'"] },
  rs: {
    keywords: RUST_KEYWORDS,
    lineComment: /\/\/.*/,
    blockCommentOpen: "/*",
    blockCommentClose: "*/",
    stringQuotes: ['"']
  },
  rust: {
    keywords: RUST_KEYWORDS,
    lineComment: /\/\/.*/,
    blockCommentOpen: "/*",
    blockCommentClose: "*/",
    stringQuotes: ['"']
  },
  go: {
    keywords: GO_KEYWORDS,
    lineComment: /\/\/.*/,
    blockCommentOpen: "/*",
    blockCommentClose: "*/",
    stringQuotes: ['"', "`"]
  },
  json: { keywords: new Set(["true", "false", "null"]), stringQuotes: ['"'] }
};

/** Multi-line block comment state shared across lines. */
export interface HighlightState {
  inBlockComment: boolean;
}

export function createHighlightState(): HighlightState {
  return { inBlockComment: false };
}

/**
 * Highlight one line of source code. Mutates `state` to track multi-line
 * block comment state.
 */
export function highlightLine(
  line: string,
  lang: string | undefined,
  state: HighlightState
): string {
  if (!lang) return line;
  const spec = LANGS[lang.toLowerCase()];
  if (!spec) return line;

  // Tokenize: walk character by character, recognizing strings, comments,
  // numbers, identifiers (which we then check against keywords).
  let result = "";
  let i = 0;
  const len = line.length;

  // Continuation of a block comment from a prior line
  if (state.inBlockComment && spec.blockCommentClose) {
    const closeIdx = line.indexOf(spec.blockCommentClose);
    if (closeIdx === -1) {
      return COLOR.comment + line + RESET;
    }
    result += COLOR.comment + line.slice(0, closeIdx + spec.blockCommentClose.length) + RESET;
    state.inBlockComment = false;
    i = closeIdx + spec.blockCommentClose.length;
  }

  while (i < len) {
    const ch = line[i];
    const rest = line.slice(i);

    // Block comment start
    if (spec.blockCommentOpen && rest.startsWith(spec.blockCommentOpen)) {
      const close = spec.blockCommentClose!;
      const closeIdx = rest.indexOf(close, spec.blockCommentOpen.length);
      if (closeIdx === -1) {
        // Comment continues to next line
        result += COLOR.comment + rest + RESET;
        state.inBlockComment = true;
        return result;
      }
      const end = i + closeIdx + close.length;
      result += COLOR.comment + line.slice(i, end) + RESET;
      i = end;
      continue;
    }

    // Line comment
    if (spec.lineComment) {
      const commentMatch = spec.lineComment.exec(rest);
      if (commentMatch && commentMatch.index === 0) {
        result += COLOR.comment + commentMatch[0] + RESET;
        i += commentMatch[0].length;
        continue;
      }
    }

    // String
    if (spec.stringQuotes && spec.stringQuotes.includes(ch)) {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        if (line[j] === "\\" && j + 1 < len) {
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      result += COLOR.string + line.slice(i, j) + RESET;
      i = j;
      continue;
    }

    // Number
    if (/[0-9]/.test(ch) && (i === 0 || !/[A-Za-z_]/.test(line[i - 1]))) {
      const numMatch = /^[0-9_]+(\.[0-9_]+)?([eE][+-]?[0-9]+)?[a-zA-Z]*/.exec(rest);
      if (numMatch) {
        result += COLOR.number + numMatch[0] + RESET;
        i += numMatch[0].length;
        continue;
      }
    }

    // Identifier / keyword
    if (/[A-Za-z_$]/.test(ch)) {
      const idMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
      if (idMatch) {
        const word = idMatch[0];
        const next = line[i + word.length];
        if (spec.keywords.has(word)) {
          result += COLOR.keyword + word + RESET;
        } else if (next === "(") {
          result += COLOR.func + word + RESET;
        } else {
          result += word;
        }
        i += word.length;
        continue;
      }
    }

    // Default: pass through char
    result += ch;
    i += 1;
  }

  return result;
}
