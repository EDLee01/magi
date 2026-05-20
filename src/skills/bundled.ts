/**
 * Bundled built-in skills installed on first run if no user skill of the same
 * name already exists. Users can override or remove these freely — the loader
 * only writes when the destination doesn't exist.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MagiPaths } from "../paths.js";

interface BundledSkill {
  name: string;
  body: string;
}

const SKILLS: BundledSkill[] = [
  {
    name: "verify",
    body: `# Verify implementation

Verify that recent code changes actually work, with concrete evidence.

## Steps

1. Identify what changed: \`git status\` and \`git diff\` (or ask the user if not in a repo)
2. Run the project's build, in this order, picking the one that exists:
   - \`npm run build\` / \`pnpm build\` / \`yarn build\`
   - \`cargo build\`
   - \`go build ./...\`
   - \`mvn compile\` / \`gradle build\`
3. Run the test suite the same way
4. Run any linter the project has
5. For each failure, read the error and the relevant file:line. Don't summarize away the actual message.

## Output

End with a structured verdict:

\`\`\`
VERDICT: <PASS | FAIL | PARTIAL>

EVIDENCE:
- <command>: <one-line result>
- ...

ISSUES (if any):
- <file:line>: <concrete problem>
- ...

NEXT STEPS (if FAIL/PARTIAL):
- <what the user should do to unblock>
\`\`\`

## Notes

- Don't fix the issues yourself unless the user asked. The verify skill reports.
- If the build/test commands aren't obvious, look at package.json scripts, Makefile, or just \`README.md\`.
- If you cannot run anything (no internet, missing tooling), say exactly what is uncertain.
`
  },
  {
    name: "debug",
    body: `# Debug

Investigate a bug systematically, end with a minimal reproduction or root cause.

## Steps

1. **Restate the bug** in your own words. What is the observed behavior? What is expected?
2. **Find the entry point** — which command, endpoint, or user action triggers it? Use Grep for error messages, log lines, or the symptom.
3. **Read the call path** with Read. Don't skip files. Note assumptions in the code that the bug might violate.
4. **Form 2-3 hypotheses** about the cause. Rank them by likelihood.
5. **Test the top hypothesis** — add a log, run the failing case, read the output. If wrong, drop it and move to the next.
6. **Find the root cause**. State it precisely with file:line references.
7. **Propose a fix** — minimal, targeted. Show the diff.

## Anti-patterns

- Adding try/catch to swallow the error — that hides the bug, doesn't fix it.
- Patching symptoms instead of causes ("I'll just add a null check here").
- Long speculation without running anything.

## Output

\`\`\`
SYMPTOM: <one line>
ROOT CAUSE: <precise, with file:line>
FIX:
<diff or step-by-step>
\`\`\`
`
  },
  {
    name: "stuck",
    body: `# Stuck — step back

When an approach has failed twice, do NOT keep tweaking it. Step back.

## Steps

1. **State what you tried.** Two attempts, what each was, what failed.
2. **Diagnose, don't tweak.** What assumption was wrong? Read the actual error or output (don't paraphrase).
3. **Consider 3 different approaches** at a higher level. Not "the same thing with one parameter changed" — fundamentally different paths.
4. **Pick one and explain why.** What about the failure mode makes this approach more likely to work?
5. **Or: ask the user.** If you can't see a path forward, say so. Show what you've tried, what you don't understand, and ask for direction.

## Triggers

- Same error after two attempts
- Tests still failing after two "fixes"
- Build still broken after two iterations
- Realizing partway through that the design doesn't fit

## Anti-patterns

- "Let me try the exact same thing one more time"
- "I'll add another retry/fallback/null check"
- Silently switching to a different language/framework/architecture without telling the user
- Pretending a partial result is the full thing
`
  }
];

/**
 * Install bundled skills into the user's skills root if not already present.
 * Existing user skills with the same name are left untouched.
 */
export function installBundledSkills(paths: MagiPaths): { installed: string[]; skipped: string[] } {
  const installed: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(paths.skillsRoot)) {
    try {
      mkdirSync(paths.skillsRoot, { recursive: true });
    } catch {
      return { installed, skipped };
    }
  }
  for (const skill of SKILLS) {
    const dir = path.join(paths.skillsRoot, skill.name);
    const file = path.join(dir, "SKILL.md");
    if (existsSync(file)) {
      skipped.push(skill.name);
      continue;
    }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, skill.body, "utf8");
      installed.push(skill.name);
    } catch {
      // best effort; if we can't write, just skip
    }
  }
  return { installed, skipped };
}
