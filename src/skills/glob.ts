/**
 * Shared minimal glob → RegExp for skill file paths.
 *
 * Supports `*` (match within a path segment, no slash) and `**` (match across
 * segments). Everything else is literal. Used by both the installer's `--defer`
 * classification (classify.ts) and `skills materialize` (materialize.ts) so the
 * two speak the same matching language.
 */

import path from "node:path";

export function makeMatcher(pattern: string): (candidate: string) => boolean {
  const normalized = path.posix.normalize(pattern.trim());
  const regex = globToRegExp(normalized);
  return (candidate) => regex.test(candidate);
}

export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** — match across separators
        out += ".*";
        i++;
        // swallow a trailing slash after ** so `a/**/b` and `a/**` behave
        if (glob[i + 1] === "/") {
          i++;
        }
      } else {
        // * — match within a segment (no slash)
        out += "[^/]*";
      }
    } else if (/[.+?^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += "$";
  return new RegExp(out);
}
