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
- TUI startup identity, slash command dispatch, `/` suggestion menu behavior,
  bounded status/pending-approval rendering, prompt editing/history, and
  bracketed paste placeholder/restore behavior, plus picker Tab completion and
  arrow-key selection for model and permission mode changes.
- Searchable `-r` TTY resume picker, non-TTY resume session list, and
  interactive `/resume <query>` picker search/cancel behavior, with a bounded
  narrow-width visual contract for session picker rows, scroll state, and
  footer.
- CLI `--tools`, `--allowed-tools`, and `--disallowed-tools` schema filtering
  plus execution-time denial.
- Stream-json structured event parity for core lifecycle plus less common
  request, usage, message delta, approval, user-message, hook, and query-done
  events.
- MCP list/call approval basics.
- Control API pairing, auth, jobs, approvals, SSE, agents.
- Multi-agent queue and write conflict detection.
- Context budget and compaction.
- Rust runner JSON-RPC, process run, timeout, PTY smoke, file apply audit.
- Plugin manifest, local marketplace, skill loader, web panel endpoints.
- Complex task harness H1-H10: isolated business fixtures with deterministic
  checks, stream-json capture, SQLite session/audit evidence, forbidden path
  checks, archived diffs, multi-agent conflict, Bash approval, and provider
  retry/fallback coverage.

Not yet fully covered:

- Full PTY resume picker snapshot polish beyond bounded row/scroll/footer
  contracts.
- Broader TUI keyboard navigation polish beyond prompt editing/history/paste
  and picker Tab/arrow flows.
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

Current status: implemented and black-box gated for the required discovery
surface. `/help` lists the required groups, slash search exposes
`/context`, `/rules`, `/run`, `/plugins`, `/skills`, and `/agents`, and the
prompt reader preserves alias submissions such as `/skills`.

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
searchable session picker; in non-TTY it prints a stable session list. The
visual contract gate opens the real TTY picker at narrow width and verifies
bounded lines, selected-row marker, scroll position, filter prompt, footer,
clipping, and selected session resume.

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

Current status: implemented and black-box gated for the core flow. `/resume`
opens the same searchable interactive picker in the TUI; `/resume <query>`
pre-filters by the provided query, Enter resumes the selected session, no-match
renders the empty state, and Esc returns without resuming.

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

Current status: implemented and black-box gated for picker item data and search
fields. Coverage verifies typed title search, cwd-detail filtering with multiple
matches, exclusion of a nonmatching cwd session, and partial session id resume.

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

Current status: implemented and black-box gated. The harness verifies
JSONL-only output, user/assistant message events, tool started/completed
events, preserved raw agent events, completed status, and structured extended
events for request start, usage, message delta, approval request, user message,
hooks, and query done.

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

Current status: implemented and black-box gated for core CLI/File/Bash paths.
`default`, `acceptEdits`, `dontAsk`, `bypassPermissions`, and `plan` compose
with CLI allow/deny rules. `dontAsk` denies non-read-only tools without writing,
`acceptEdits` allows ordinary edits, and dangerous Bash is denied unless
`bypassPermissions` plus `MAGI_APPROVE_DANGEROUS_COMMANDS=1` are both present.
The dangerous Bash matrix is gated across `default`, `acceptEdits`, `dontAsk`,
`plan`, and both bypass-without-env and bypass-with-explicit-env paths, with
stream-json tool evidence and sentinel preservation checks.
Long-tail MCP/browser permission parity should keep using the same policy model
as those tools mature.

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

Current implementation: `npm run test:complex-harness` runs H1-H10 against the
built CLI with isolated `MAGI_CONFIG_DIR` roots, mock providers, stream-json
capture, SQLite session/audit inspection, file-diff validation, and archives
under `.magi-reports/harness/`.

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

Current status: implemented and gated by `npm run test:complex-harness`.

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

Current status: implemented and gated by `npm run test:complex-harness`.
The H2 fixture drives a real CLI multi-file change across CLI parsing, store
behavior, README usage, and tests. The harness verifies baseline and final
tests, `--dry-run` no-write behavior, exact four-file diff, forbidden path
protection, stream-json lifecycle, and SQLite session/audit persistence.

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

Current status: implemented and gated by `npm run test:complex-harness`.
The H3 fixture captures baseline public output, extracts duplicate CSV number
parsing into `src/parse.js`, updates sales and inventory modules with
`FilePatch`, reruns tests, verifies public output preservation, checks duplicate
parsing removal, enforces the exact three-file diff, blocks forbidden paths, and
records stream-json plus SQLite session/audit evidence.

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

Current status: implemented and gated by `npm run test:complex-harness`.
The H4 fixture uses a medium config-loader repo with a hidden zero-value
validation bug. The harness requires file discovery with `Glob`, validation
error search with `Grep`, loader/validator/test/doc reads before editing,
baseline failure reproduction, a single-file validator patch, final focused
tests, exact one-file diff enforcement, forbidden path protection, and SQLite
session/audit evidence.

#### H5. Permission boundary

Fixture: repo plus outside sentinel file.

Prompt:

```text
Update the project config. Do not touch files outside this repo.
```

Checks:

- Sentinel file unchanged.
- Audit contains denied outside access if attempted.

Current status: implemented and gated by `npm run test:complex-harness`.
The H5 fixture drives a project config update while the mock provider first
attempts a `FileWrite` to `../outside-sentinel.txt`. The harness verifies the
write is rejected by the workspace boundary, the outside sentinel remains
unchanged, the rejection reason is persisted in SQLite audit metadata, the
agent continues with a narrow in-repo `FilePatch`, final focused tests pass,
and forbidden project paths stay unchanged.

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

Current status: implemented and gated by `npm run test:complex-harness`.
The H6 fixture runs a two-pass invoice task in one isolated workspace. The
first pass reproduces the failing test, reads source/tests, writes an
investigation report, and stops before patching source. The second pass uses
`-c` to continue the most recent cwd session, verifies the same session id is
reused, reads the prior investigation report, patches the source, reruns the
focused test, and checks final diff/forbidden paths plus SQLite session/audit
evidence.

#### H7. Stream-json automation

Prompt:

```text
Create a file and report the path.
```

Checks:

- All output is valid NDJSON.
- Events include tool start/completion.
- File exists.

Current status: implemented and gated by `npm run test:complex-harness`.
The H7 fixture drives a small external automation scenario through
`--output-format stream-json`. The harness verifies stdout is valid NDJSON
only, stderr is empty, the stream starts with `session.started`, includes user
message plus `FileWrite` start/completion and raw agent tool events, ends with
`session.completed`, writes exactly `output/automation-result.txt`, preserves
forbidden paths, runs `checks.sh`, and persists SQLite session/audit evidence.

#### H8. Multi-agent conflict

Prompt:

```text
Spawn two workers to edit disjoint files, then attempt same-file conflict.
```

Checks:

- Disjoint writes allowed.
- Same file conflict rejected.
- Audit records conflict.

Current status: implemented and gated by `npm run test:complex-harness`.
The H8 fixture drives Magi through the real `magi agents` CLI from an outer
agent run. It creates two worker tasks with disjoint write claims, starts and
completes both, attempts a third worker claiming the same `src/left.txt` path,
verifies the conflict is rejected, writes a concise report, and then checks the
shared SQLite state for exactly two completed worker tasks and two surviving
disjoint write claims.

#### H9. Bash approval control

Prompt:

```text
Validate Bash approval details through a real Control API job.
```

Checks:

- Read-only Bash runs without approval.
- Non-read-only Bash enters an active approval.
- Pending approval exposes command, cwd, and timeout.
- Control API approval resolves the interaction and the Bash command completes.

Current status: implemented and gated by `npm run test:complex-harness`.
The H9 fixture drives an outer Magi run that starts a real `magi serve`
Control API, creates a background job in default permission mode, verifies
`pwd` runs without approval, verifies `npm test` waits on a Bash approval with
`command`, `cwd`, and `timeout_ms` evidence, resolves the approval through the
Control API, and checks persisted audit events plus the final report.

#### H10. Provider retry and fallback

Prompt:

```text
Verify provider retry and fallback resilience.
```

Checks:

- Primary provider produces retryable server failures.
- Scheduled retry diagnostics are emitted as `provider.retry`, not `session.error`.
- Configured fallback provider recovers the task.
- SQLite audit records retry and fallback routing evidence.

Current status: implemented and gated by `npm run test:complex-harness`.
The H10 fixture drives the built CLI through `--output-format stream-json`
against a mock primary provider that returns retryable server errors before the
configured `backup/mock-backup` route recovers. The harness verifies two
scheduled `provider.retry` diagnostics, one `provider.fallback`, no
`session.error`, exact report-file output, and SQLite `agent.provider.retry` /
`agent.provider.fallback` audit evidence.

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

Current status: implemented for startup and gated by `npm run test:blackbox`.
The black-box TUI visual contract verifies the text hat glyphs, startup
identity line, cwd/model/help hint, and line-width bounds after ANSI stripping.

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

Current status: partial and gated for the highest-risk stable surfaces. The
black-box visual contract verifies startup, slash suggestion filtering/footer,
and status rendering with a pending approval plus transcript line-width bounds.
The black-box TUI keyboard input gate also drives the real interactive prompt
path with Home/Delete/End/Left/LF/Enter editing and verifies that the provider
receives the corrected multiline prompt. The TUI prompt history gate recalls a
previous prompt with Up, edits it, and verifies that the revised prompt reaches
the provider. The TUI bracketed paste gate verifies that a pasted multiline
block renders as a placeholder in the edit surface while the provider receives
the restored full prompt. The TUI stateful picker gate exercises `/model` and
`/permissions mode`, then verifies that the selected model alias routes the next
provider call and the selected plan mode blocks a write. The TUI picker keyboard
gate uses Tab completion for the model picker and arrow-key navigation for the
permission picker, then verifies the routed provider call and plan-mode write
denial. The TUI approval picker gate verifies a pending FileWrite approval,
hotkey denial, model-visible denial result, and unchanged workspace. Full PTY
transcript snapshots for every interactive state remain future coverage.

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

1. Real provider-driven tool loop for non-trivial code changes.
2. Broader visual regression coverage across full PTY transcripts.
3. Full PTY resume picker snapshot polish beyond bounded row/scroll/footer
   contracts.
4. Broader TUI keyboard navigation polish beyond prompt editing/history/paste
   and picker Tab/arrow flows.

Recommended next implementation phase:

- Expand full PTY transcript snapshot coverage.
- Tighten remaining TUI keyboard navigation contracts.
- Keep real-provider tool-loop checks opt-in until credentials and upstream
  variability can be isolated from default CI.
