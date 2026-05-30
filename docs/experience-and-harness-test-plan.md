# Magi Next Experience and Harness Test Plan

Date: 2026-05-16
Scope: clean-room black-box compatibility testing and Magi Next product validation.

This document is a test plan, not a claim that all items already pass. Legacy
`magi-agent` may be observed only as a black box through public commands and TTY
interaction. Do not read or copy legacy source, prompts, tests, private docs,
or file structure.

## Current Status

Already covered by automated tests:

- `magi --version`, `doctor`, `config`, `-p`, bare prompt headless execution,
  session creation and resume basics.
- Isolation from `~/.claude`, legacy paths, `CLAUDE_*` primary config, and `magi-agent` binary.
- Provider routing, model aliases, fallback routing.
- File read/search/write, shell guardrails, git summary.
- SQLite sessions, jobs, audit, usage.
- TUI basic startup, slash command dispatch, and `/` suggestion menu behavior.
- Searchable `-r` TTY resume picker and non-TTY resume session list.
- CLI `--tools`, `--allowed-tools`, and `--disallowed-tools` schema filtering
  plus execution-time denial.
- MCP list/call approval basics.
- Control API pairing, auth, jobs, approvals, SSE, agents.
- Multi-agent queue and write conflict detection.
- Context budget and compaction.
- Rust runner JSON-RPC, process run, timeout, PTY smoke, file apply audit.
- Plugin manifest, local marketplace, skill loader, web panel endpoints.

Not yet fully covered:

- Richer `/resume` picker edge cases and visual polish.
- TUI keyboard navigation polish.
- Broader stream-json parity for less common event types.
- Full dangerous-tool semantics across every permission mode.
- Complex multi-step task harness with objective scoring.
- Long-running coding task recovery after interruption.
- Real provider-driven tool loop for non-trivial code changes.

## Clean-room Rules for Testing

- Allowed: run `magi-agent --help`, `magi-agent --version`, and interactive
  black-box sessions in throwaway directories.
- Allowed: record observable behavior categories, state transitions, key names,
  and interaction patterns.
- Not allowed: reading `/home/claude-user/magi` source, tests, prompts, docs,
  package internals, or private config/state.
- Not allowed: copying legacy UI text verbatim beyond short command names and
  generic option names needed for compatibility.
- Not allowed: enabling forbidden paths in Magi Next: Claude Web/OAuth, Claude
  in Chrome, Anthropic remote bridge, official Claude plugin marketplace, or
  publishing a `magi-agent` binary.

## Test Environment

Use isolated roots for Magi Next:

```bash
export MAGI_CONFIG_DIR="$(mktemp -d /tmp/magi-next-test-XXXXXX)"
```

Use throwaway workspaces for behavioral tests:

```bash
workspace="$(mktemp -d /tmp/magi-workspace-XXXXXX)"
cd "$workspace"
```

For legacy black-box tests, use a separate throwaway workspace and avoid
mutating project repositories.

## A. Entry and Help Experience

### A1. Default Interactive Start

Legacy black-box:

```bash
cd "$workspace"
magi-agent
```

Observe:

- Startup banner or identity marker.
- Whether model/provider/status is visible.
- Where input cursor appears.
- Whether empty workspace trust or permission prompts appear.
- How Ctrl+C and Ctrl+D behave.

Magi Next target:

```bash
cd "$workspace"
MAGI_CONFIG_DIR="$tmp_root" magi
```

Acceptance:

- Starts an interactive TUI without stack traces.
- Shows Magi identity with the chosen text hat glyph.
- Shows cwd, session, model/provider, permission mode in `/status`.
- Ctrl+C does not corrupt terminal state.

Current status: partial. Basic TUI exists; identity and visual hierarchy need work.

### A2. Direct Prompt Argument

Commands:

```bash
magi-agent "create a short status"
MAGI_CONFIG_DIR="$tmp_root" magi "create a short status"
```

Acceptance:

- Magi Next supports bare prompt argument or intentionally documents why it
  only enters interactive mode.
- If bare prompt runs headless, output format follows normal text rules.

Current status: implemented and black-box gated. Bare prompt arguments run
through the headless prompt path and are covered by `npm run test:blackbox` plus
the capability report.

### A3. Help Shape

Commands:

```bash
magi-agent --help
magi --help
```

Acceptance:

- Help is grouped by Options and Commands.
- Compatibility-shaped options are present, even if some are marked unsupported.
- Forbidden options are not implemented silently.

Current status: implemented and black-box gated. Help is grouped into Usage,
Options, Commands, and Compatibility notes; compatibility-shaped options are
listed explicitly, and unsupported legacy paths are documented rather than
silently enabled.

## B. Slash Command Discovery

### B1. `/` Suggestion Menu

Legacy black-box:

Run `magi-agent`, type `/`, wait one second.

Record:

- Whether a menu opens immediately.
- Layout: list, grouping, description, shortcut hints.
- Highlighted row behavior.
- How filtering changes as `/r`, `/re`, `/resume` are typed.
- Behavior of Up/Down, Tab, Enter, Esc, Backspace.

Magi Next target:

Run `magi`, type `/`.

Acceptance:

- A suggestion menu appears after `/`.
- Each command has a short description.
- Typing filters results.
- Up/Down moves selection.
- Enter inserts or executes the selected command.
- Esc closes the menu and keeps input intact.
- Unknown slash commands produce a concise error.

Current status: implemented and black-box gated for prompt-reader behavior. The
menu renders on `/`, filters typed prefixes, supports arrow selection, and
submits the selected command with Enter. Full interactive TUI polish remains
tracked separately.

### B2. Slash Command Coverage

Required command groups:

- Session: `/resume`, `/sessions`, `/status`
- Model: `/model`
- Context: `/context`, `/compact`
- Memory/rules: `/memory`, `/rules`
- Tools: `/review`, `/run`, `/diff`
- Extensions: `/mcp`, `/plugins`, `/skills`
- Agents: `/agents`
- Help: `/help`

Acceptance:

- `/help` lists groups.
- `/status` shows live configuration.
- Commands are discoverable through `/` search.

Current status: partial. Some command handlers exist; menu and coverage incomplete.

## C. Resume Search and Picker

### C1. `-r` Without Value

Legacy black-box:

Create several sessions, then run:

```bash
magi-agent -r
```

Observe:

- Does it open a picker?
- Which fields are shown: title, cwd, time, branch, model?
- Search prompt behavior.
- Keyboard navigation.

Magi Next target:

```bash
MAGI_CONFIG_DIR="$tmp_root" magi -r
```

Acceptance:

- Without value, opens a searchable picker in TTY.
- In non-TTY, prints a session list with stable columns and exits nonzero or
  provides an actionable instruction.

Current status: implemented and black-box gated. In a TTY, `magi -r` opens the
searchable session picker; in non-TTY it prints a stable session list.

### C2. `/resume` Search

Interactive test:

1. Start `magi`.
2. Type `/resume`.
3. Type a substring from an existing session title.
4. Use Down/Up and Enter.

Acceptance:

- Search filters by title, cwd, and session id.
- Shows no-results state.
- Enter resumes selected session.
- Esc returns to previous input.

Current status: partially implemented. `/resume` with no args opens the same
interactive picker in the TUI; richer no-results and escape-path coverage remain
future polish.

### C3. Session Picker Data

Fixtures:

- Session A: title `fix parser`, cwd `repo-a`
- Session B: title `review auth`, cwd `repo-b`
- Session C: title `write docs`, cwd `repo-a`

Acceptance:

- Picker sorts by updated time descending.
- Search `repo-a` shows A and C.
- Search `auth` shows B.
- Search by partial session id works.

Current status: implemented for picker item data and search fields; black-box
coverage verifies selecting a session by typed title query.

## D. Output Protocol

### D1. Text Output

Command:

```bash
magi -p "write a short status"
```

Acceptance:

- No development-stage wording such as bootstrap disclaimers.
- If provider is not configured, output says exactly what is missing.
- Includes session id only when useful or requested by verbose/json mode.

Current status: implemented and black-box gated. Default text output prints the
final assistant message only; `--verbose` prints session/job/state metadata for
automation or debugging. Missing-provider text output stays actionable without
development-stage disclaimers.

### D2. JSON Output

Command:

```bash
magi --output-format json -p "write a short status"
```

Acceptance:

- Single valid JSON object.
- Contains `sessionId`, `jobId`, `status`, `message`, `usage`, `model`.
- Errors return JSON if requested.

Current status: implemented and black-box gated for successful provider output plus JSON usage
errors. Success output is one JSON object with session/job ids, status, final message,
provider/model, and normalized usage.

### D3. Stream JSON Output

Command:

```bash
magi --output-format stream-json -p "create file x.txt with content ok"
```

Required event sequence:

```json
{"type":"session.started","sessionId":"..."}
{"type":"message.created","role":"user","content":"..."}
{"type":"tool.started","tool":"file.write","input":{"path":"x.txt"}}
{"type":"tool.completed","tool":"file.write","result":{"path":"x.txt"}}
{"type":"message.created","role":"assistant","content":"..."}
{"type":"session.completed","sessionId":"...","status":"completed"}
```

Acceptance:

- One JSON object per line.
- No non-JSON text mixed into stream.
- Error event is valid JSON.

Current status: implemented for the main headless lifecycle and black-box
gated. The harness verifies JSONL-only output, user/assistant message events,
tool started/completed events, preserved raw agent events, and completed status.
Broader parity for less common event types remains future coverage.

## E. Permission and Tool Policy

### E1. Tool Allow/Deny

Commands:

```bash
magi --tools Read,Search -p "read file package.json"
magi --disallowed-tools Bash -p "run command \"pwd\""
magi --allowed-tools "Bash(git:*)" -p "run command \"git status\""
```

Acceptance:

- Tool availability is enforced before execution.
- Denied tool attempts produce a clear message.
- Audit records include policy decision.

Current status: implemented and black-box gated for CLI allow/deny rules. Tool
schemas are filtered before provider calls, and hidden or denied tools are still
blocked if the model requests them manually. Scoped selectors such as
`Bash(git:*)` are enforced at execution time.

### E2. Permission Modes

Modes:

- `default`
- `acceptEdits`
- `dontAsk`
- `bypassPermissions`
- `plan`

Acceptance:

- `plan` does not write files or run shell commands.
- `acceptEdits` auto-approves file edits but not dangerous shell.
- `bypassPermissions` requires explicit dangerous flag and audit.
- Dangerous shell remains blocked unless mode and flags allow it.

Current status: partially implemented. `default`, `acceptEdits`,
`bypassPermissions`, and `plan` exist, and CLI allow/deny rules compose with
them. Dangerous-tool semantics and exhaustive per-tool mode coverage still need
the unified policy pass.

## F. Complex Task Harness

The harness tests whether Magi can complete realistic coding work, not just
single-command demos.

### Harness Structure

Each task fixture must include:

- `task.md`: user request.
- `repo/`: isolated project fixture.
- `checks.sh`: deterministic validation.
- `expected.json`: expected observable outcomes.
- `limits.json`: max time, max command count, max file changes.
- `forbidden.txt`: paths or patterns that must not be touched.

Harness runner responsibilities:

1. Create a fresh copy of `repo/`.
2. Run Magi with controlled env and isolated `MAGI_CONFIG_DIR`.
3. Capture stdout, stderr, stream-json events, session db, audit db, and file diffs.
4. Run `checks.sh`.
5. Score outcome.
6. Archive logs under `~/.magi-next/logs/harness/` or test temp dir.

### Scoring

Each task gets:

- `pass`: all checks pass and no forbidden changes.
- `partial`: some checks pass but manual review needed.
- `fail`: checks fail, tool crashes, or forbidden changes occur.

Metrics:

- Wall time.
- Tool calls.
- Files read/written.
- Commands run.
- Approval prompts.
- Audit event count.
- Session replay completeness.
- Final diff size.

### Harness Task Set

#### H1. Single-file bug fix

Fixture: small TypeScript function with failing test.

Prompt:

```text
Fix the failing test without changing the public API.
```

Checks:

- `npm test` passes.
- Only expected source file changed.
- No dependency install.

Current status: not implemented.

#### H2. Multi-file feature

Fixture: CLI parser and tests.

Prompt:

```text
Add --dry-run support and update tests.
```

Checks:

- Tests pass.
- Help text includes `--dry-run`.
- Dry run writes no files.

Current status: not implemented.

#### H3. Refactor with behavior preservation

Fixture: duplicated utilities.

Prompt:

```text
Refactor duplicate parsing logic while keeping behavior unchanged.
```

Checks:

- Snapshot tests pass.
- Public output unchanged.
- Diff under threshold.

Current status: not implemented.

#### H4. Repository investigation

Fixture: medium repo with hidden bug.

Prompt:

```text
Find why the config loader rejects a valid config and fix it.
```

Checks:

- Correct failing test passes.
- No broad rewrites.
- Session includes search/read evidence.

Current status: not implemented.

#### H5. Permission boundary

Fixture: repo plus outside sentinel file.

Prompt:

```text
Update the project config. Do not touch files outside this repo.
```

Checks:

- Sentinel file unchanged.
- Audit contains denied outside access if attempted.

Current status: partially covered by tool tests, not harnessed.

#### H6. Resume after interruption

Fixture: task requiring multiple steps.

Procedure:

1. Start task.
2. Interrupt after first tool call.
3. Resume with `-c` or `-r`.
4. Complete task.

Checks:

- Same or forked session behavior matches option.
- Context summary preserves required facts.
- Final checks pass.

Current status: not implemented.

#### H7. Stream-json automation

Prompt:

```text
Create a file and report the path.
```

Checks:

- All output is valid NDJSON.
- Events include tool start/completion.
- File exists.

Current status: not implemented.

#### H8. Multi-agent conflict

Prompt:

```text
Spawn two workers to edit disjoint files, then attempt same-file conflict.
```

Checks:

- Disjoint writes allowed.
- Same file conflict rejected.
- Audit records conflict.

Current status: unit-level partial, no end-to-end harness.

## G. Visual and Interaction Quality

### G1. Text Hat Identity

Chosen direction:

```text
  △
 /✦\
▔▔▔
```

Acceptance:

- Appears on startup.
- Does not break narrow terminal width.
- Does not appear in machine-readable JSON output.
- Can be disabled in bare/non-interactive mode.

Current status: preview only.

### G2. Visual Regression

Use PTY transcript snapshots for:

- Startup screen.
- `/` menu.
- `/resume` picker.
- `/status`.
- Permission prompt.
- Error state.

Acceptance:

- Snapshots are stable after ANSI stripping.
- Color is additive; text remains understandable without color.

Current status: not implemented.

## H. Provider-backed Real Task Tests

These tests require real configured provider credentials and must be marked
integration tests, not unit tests.

### H1. Provider availability

Command:

```bash
magi --model main -p "Reply with exactly: ok"
```

Acceptance:

- Returns exactly `ok` or a clear provider error.
- Records usage.

Current status: manually tested earlier for configured aliases, not automated.

### H2. Agentic edit

Command:

```bash
magi --model main -p "Create hello.txt with content ok"
```

Acceptance:

- Uses tool path, not just prose.
- Writes file.
- Records audit.

Current status: local deterministic path exists; provider tool loop incomplete.

## I. Automation Commands to Add

Proposed package scripts:

```json
{
  "test:experience": "vitest run tests/experience.test.ts",
  "test:harness": "tsx tests/harness/run-harness.ts",
  "test:harness:quick": "tsx tests/harness/run-harness.ts --quick",
  "test:integration": "tsx tests/integration/provider-smoke.ts"
}
```

Required artifacts:

- `tests/experience/pty-driver.ts`
- `tests/experience/slash-menu.test.ts`
- `tests/experience/resume-picker.test.ts`
- `tests/harness/run-harness.ts`
- `tests/harness/fixtures/*`
- `docs/experience-and-harness-results.md`

## J. Gap Summary

Highest priority gaps:

1. Slash suggestion UI.
2. Searchable resume picker.
3. Stream-json event protocol.
4. Unified tool permission policy.
5. Complex coding task harness.
6. Provider-backed multi-step tool loop.
7. TUI identity and visual polish.

Recommended next implementation phase:

- H323-H328: PTY driver and snapshot test infrastructure.
- H329-H336: Slash suggestion menu and tests.
- H337-H344: Searchable session picker and tests.
- H345-H352: Stream-json event protocol.
- H353-H364: Tool permission policy.
- H365-H378: Complex task harness fixtures and scorer.
