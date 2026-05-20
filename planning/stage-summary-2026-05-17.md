# Magi Next Stage Summary - 2026-05-17

This is a checkpoint summary for the current Magi Next clean-room implementation stage.

## Hard Constraints Kept

- Clean-room boundary preserved: no implementation dependency on `/home/claude-user/magi`, `~/.claude`, or legacy state.
- CLI entrypoint remains `magi`; no `magi-agent` binary is published.
- Runtime config/state roots remain under `~/.magi-next/`.
- Primary environment variables use `MAGI_*`; `CLAUDE_*` only appears in negative isolation tests and clean-room guardrails.
- Features added in this stage were verified with type checks, focused tests, full verification, clean-room scan, and placeholder scan.

## Latest Verified State

Last full verification run:

```sh
npm run verify
```

Result:

- 18 test files passed.
- 222 tests passed after adding live Control API SSE event streaming, richer durable event views, layered memory retrieval, active approval/question control flow, readline-level TUI live event consumption, H6-H8 TUI transcript/control affordances, H7-H10 Git branch/mutation tools, MAGI runtime `.env` loading, H10-H12 streaming/cancellation hardening, and H12-H14 workspace diagnostics.
- 41 focused QueryEngine/Control API/TUI/session-store event tests passed after the live event-streaming work.
- 73 focused memory/config/query/isolation tests passed after the layered memory upgrade.
- 62 focused QueryEngine/Control API/TUI/isolation tests passed after active approval/question control flow.
- 52 focused QueryEngine/Control API/TUI/session-store tests passed after TUI live event consumption.
- 55 focused QueryEngine/Control API/TUI/session-store tests passed after H6-H8 TUI transcript and controls.
- 65 focused Git-tool/agent/isolation tests passed after H7-H10 Git branch/mutation tools.
- 70 focused provider-routing/QueryEngine/Control API/TUI tests passed after H10-H12 streaming/cancellation hardening.
- 87 focused tool-registry/QueryEngine/CLI/isolation tests passed after H12-H14 workspace diagnostics.
- `tsc --noEmit` passed.
- `tsc -p tsconfig.build.json` passed.
- Rust runner build passed.
- Secret scan passed.
- License scan passed for 174 packages.
- SBOM generated with 174 components.
- Clean-room scan on implementation paths only hit expected guardrail/negative-test references.
- Placeholder/fake scan on `src/tools`, `src/agent`, `src/control`, and relevant tests had no hits.

## Completed

### H1 Agent Loop Foundation

- `runAgentQuery` supports multi-turn model/tool loops.
- Tool results are returned to the model as tool-result messages.
- Fallback route switching handles retryable provider errors.
- Tool approval events are surfaced.
- Provider streaming is supported through OpenAI-compatible SSE and Anthropic Messages-compatible SSE adapters.
- Streaming text deltas flow through the normal agent events and durable `agent.text.delta` audit path.
- Running queries accept `AbortSignal`; cancelled runs are persisted as `jobs.status = cancelled` and `agent.query.cancelled`.
- MCP dynamic tools run through the same loop.
- QueryEngine persists user messages, assistant messages, tool messages, jobs, usage, audit events, and context compaction events.

### H2 Context Foundation

- Auto-compaction is implemented.
- Compaction can use an explicit model route.
- Prior context summaries are injected back into session context.
- Compaction hooks are integrated.
- Layered memory is implemented for this stage:
  - User memory remains at `~/.magi-next/memory.md`.
  - Project memory remains under `~/.magi-next/state/project-memory/`.
  - Session memory is added under `~/.magi-next/state/session-memory/`.
  - QueryEngine retrieves relevant user/project/session memory with deterministic keyword ranking and injects it as `[Relevant memory]` system context.
  - Explicit memory writes are supported through `remember ...` / `记住...` prompts only; ordinary chat is not inferred into memory.
  - Duplicate memory entries are skipped.
  - Same-scope key/value conflicts are detected, skipped, and audited.
  - CLI supports `magi memory view/search/append` across user/project/session scopes.
  - Memory config supports `enabled`, `autoWrite`, `maxResults`, and `scopes`.

### H3 Tool System

Current built-in tools: 30.

- `FileRead`
- `FileWrite`
- `FileEdit`
- `Glob`
- `Grep`
- `Bash`
- `GitSummary`
- `GitStatus`
- `GitDiff`
- `GitLog`
- `GitShow`
- `GitBranchList`
- `GitBranchCreate`
- `GitCheckout`
- `GitStage`
- `WebFetch`
- `WebSearch`
- `AskUserQuestion`
- `SendUserMessage`
- `Brief`
- `CronCreate`
- `CronUpdate`
- `CronDelete`
- `CronList`
- `TodoWrite`
- `ToolSearch`
- `WorkspaceDiagnostics`
- `Config`
- `Skill`
- `LSP`

Tool details completed:

- File, search, shell, git summary, web fetch, user question/message, cron, tool search, config, skill, and LSP tools are registered in the shared registry.
- `TodoWrite` is complete for this stage:
  - Replaces the full session todo list.
  - Validates todo shape, required fields, unique ids, status values, priority values, and unknown fields.
  - Persists under Magi Next state at `~/.magi-next/state/todos.json`.
  - Returns current todo state as the model-visible tool result.
  - QueryEngine records dedicated `agent.todo.updated` audit metadata.
  - Tests cover schema/validation, agent loop tool_result, persistence/audit, and isolation.
- `WebSearch` is complete for the first real provider boundary:
  - Uses explicit HTTP JSON search-provider configuration.
  - Validates query, domain filters, max results, provider response shape, result URLs, and `MAGI_*` API-key env boundaries.
  - Returns compact sourced results to the model.
  - Agent loop returns WebSearch tool_result to the model.
  - Defaults to mainland China usage: `locale: zh-CN`, `market: CN`, `mainlandBoost: true`.
  - Sends `locale` and `market` to the configured provider.
  - Boosts `.cn` and Chinese-title/snippet results without hard-blocking global results.
  - Supports user/config override through `locale`, `market`, `mainlandBoost`, `allowed_domains`, and `blocked_domains`.
- Richer Git tools are complete for the first read-only tool boundary:
  - `GitStatus` returns short/branch-aware working tree status.
  - `GitDiff` returns unstaged or staged diffs, supports stat/name-only/path/context options.
  - `GitLog` returns recent commits with max-count and path filtering.
  - `GitShow` returns commit/object output for simple revisions with output size limits.
  - Path filters are constrained to the current workspace.
  - Tests cover repository behavior, non-repository errors, path safety, agent loop tool_result, and legacy-root isolation.
- H7-H10 Git branch/mutation tools are complete for the current safe mutation boundary:
  - `GitBranchList` lists local or all branches and remains read-only/concurrency-safe.
  - `GitBranchCreate` creates a branch and can optionally check it out.
  - `GitCheckout` checks out an existing branch or creates and checks out a new branch.
  - `GitStage` stages or unstages explicit workspace paths.
  - Branch names are validated with conservative local checks plus `git check-ref-format --branch`.
  - Stage/unstage paths are constrained to the current workspace.
  - Mutation tools require approval in default permission mode through the existing approval path.
  - Agent loop returns approved Git mutation tool results to the model through the normal tool-result path.
  - No commit, reset, branch delete, force checkout, or destructive history mutation was added in this slice.
- H12-H14 workspace diagnostics are complete for the current read-only boundary:
  - `WorkspaceDiagnostics` summarizes manifests, package manager, package scripts, language counts, framework/runtime signals, suggested commands, Git branch/status/diff stat, and warnings.
  - `magi workspace diagnose [path]` and `magi workspace diagnostics [path]` expose the same implementation through the CLI.
  - Text and JSON output are supported.
  - Suggested commands are reported but not executed.
  - Workspace scanning ignores `.claude`, `.magi-next`, `.git`, dependency/build/cache folders, and stays under the requested workspace path.
  - Agent loop returns diagnostics tool results to the model through the normal tool-result path.
  - Tests cover schema/registration, CLI output, agent loop tool_result, Git status reporting, and legacy-root isolation.

### H4 Hooks Expansion

- Hook event schema covers tool, session/query, permission, subagent/task, lifecycle/config/file, notification, setup, and stop events.
- Hook matcher supports tool selectors plus context equality and broad glob matching.
- QueryEngine emits/audits prompt submit, permission request/denied, provider fallback notification, config change, hook results, and compaction events.
- CLI and Control API task flows trigger task/subagent lifecycle hooks around the current task queue foundation.
- Control API now exposes durable event views from audit rows:
  - `GET /events.json`
  - `GET /events`
  - `GET /sessions/:id/events`
  - `GET /jobs/:id/events`
- `GET /events` is now a real SSE stream foundation:
  - Replays recent durable audit events first.
  - Keeps the connection open.
  - Publishes new audit events from running jobs through `SessionStore` subscribers.
  - Supports `sessionId`, `jobId`, `after`, and `limit` filters.
- `SessionStore` now has a live audit-event subscription boundary plus filtered recent event queries.
- Durable event views now expose a unified model with `eventName`, `category`, `status`, `message`, and raw metadata.
- QueryEngine now persists a fuller execution trace for request start, assistant text/message events, usage, loop done, tool events, hooks, approval/question/message, todo, config, provider fallback, compaction, and errors.
- TUI `/status` and `magi resume <session-id>` show recent event summaries from the same durable event formatter.
- Interactive TUI prompt execution now subscribes to live audit events through `SessionStore.subscribeAuditEvents`, creates or reuses a real session before each prompt, and filters live output to that session.
- Readline-level TUI now prints live execution lines for query lifecycle, local plans, provider requests, tool start/result, local file/search/shell/git tool events, hooks, approval/question waits and resolutions, todo/config updates, provider fallback, compaction, explicit memory write states, and user messages.
- H6-H8 TUI transcript and controls are complete for the current readline boundary:
  - durable audit events can be formatted into a compact transcript/status view,
  - `magi resume <session-id>` includes the transcript/status summary,
  - `/status` shows active session/model context and pending interactions,
  - `/model` has minimal picker affordances with numbered alias selection,
  - `/resume` has minimal picker affordances with numbered session selection, exact ids, and unique search matches,
  - interactive TUI runs use the same active interaction registry as Control API jobs,
  - pending approvals and AskUserQuestion prompts are displayed from durable pending audit metadata and resolve the real live interaction.
- This TUI work deliberately keeps the durable audit path as the only UI-visible event source; no parallel transcript store was added.

### H10-H12 Streaming And Cancellation Hardening

- Provider request IR now carries an optional `AbortSignal`.
- OpenAI-compatible providers support SSE streaming for chat/responses routes.
- Messages-compatible providers support SSE streaming for OpenAI-chat-compatible and Anthropic Messages-compatible formats.
- Stream-capable adapters still accept normal JSON responses for compatibility with non-streaming gateways.
- Agent loop consumes streamed text deltas without duplicating final assistant text.
- QueryEngine persists streamed deltas through durable audit events, so Control API SSE and TUI continue to use the same event source.
- Control API supports background model jobs through `POST /jobs` with `background: true` or `async: true`.
- Control API supports cancelling running background jobs through `POST /jobs/:id/cancel`.
- Background job cancellation aborts the provider request, marks the durable job as `cancelled`, and records `agent.query.cancelled`.
- OpenAPI and panel client include the running-job cancel endpoint.
- TUI transcript/status formatting includes cancelled query entries.

### Active Approval and Question Control Flow

- Running `QueryEngine` jobs can register active approval/question interactions.
- `approvalResolver` can now genuinely wait for a Control API decision instead of returning immediately.
- `AskUserQuestion` can now genuinely wait for a Control API answer.
- Control API exposes live interaction routes:
  - `GET /jobs/:id/interactions`
  - `POST /jobs/:id/approvals/:toolUseId`
  - `POST /jobs/:id/approvals/:toolUseId/cancel`
  - `POST /jobs/:id/questions/:toolUseId`
  - `POST /jobs/:id/questions/:toolUseId/cancel`
- Durable audit events cover pending/resolved/timeout/cancelled approval and question states.
- `GET /events` SSE publishes pending and resolved interaction states through the durable audit path.
- TUI `/status` and `magi resume <session-id>` show pending approval/question snapshots.
- OpenAPI and panel client expose the new interaction endpoints.
- Control jobs default to approval-aware `permissionMode: default`, with explicit request override still available.

### H5 MCP Foundation

- MCP transport abstraction supports stdio, HTTP, SSE, and WebSocket.
- Connection manager deduplicates and reuses initialized clients.
- MCP tool registry exposes dynamic tools to the normal agent loop.
- MCP resources are exposed through `ListMcpResources` and `ReadMcpResource`.
- Auth-required MCP errors surface as retryable tool results.
- MCP approval flow is integrated with normal approval events.

### Config, Isolation, and Supply Chain

- Default config includes mainland-oriented WebSearch defaults.
- `Config` tool can read/update allowlisted Magi Next config keys and validates writes through the normal loader.
- Isolation tests cover config roots, legacy path avoidance, Cron state, TodoWrite state, Config/Skill roots, and forbidden binary exposure.
- Secret scan, license scan, and SBOM generation are part of `npm run verify`.

## Not Done Yet

### H1 Agent Loop Gaps

- Provider streaming is now wired through the agent loop for OpenAI-compatible and Anthropic Messages-compatible SSE, but terminal display remains compact/readline-level.
- Control API background job cancellation is implemented; synchronous HTTP job cancellation, tool-level process cancellation, and TUI keyboard interrupt handling still need hardening.
- Tool execution scheduling is still simple.
- Transcript/event streaming uses durable audit events, but richer client rendering is still needed.

### H2 Memory and Context Gaps

- Memory retrieval ranking is deterministic keyword scoring only; no embeddings or semantic index yet.
- Conflict handling detects same-scope key/value conflicts but does not offer interactive resolution yet.
- Automatic memory write policy is intentionally explicit-only; richer policy hooks and approval flows are not implemented yet.
- Memory compaction/aging and cross-project retrieval are not implemented yet.

### H3 Tool Gaps

- Target remains 60+ tools; current built-ins are 30.
- High-value missing tool areas:
  - GitHub and PR tools.
  - Notebook/Jupyter tools.
  - Structured output tool.
  - Remote trigger tools.
  - Multi-modal image/file metadata tools.
  - Browser-style web tool remains feature-gated/not implemented.

### H4 Hook/TUI Gaps

- Hook status is now surfaced in readline-level live TUI output and compact transcript/status summaries, but richer full-screen UI is still missing.
- More event sources can be wired as new features land.
- Real sub-agent execution is not implemented yet, so agent hook handling is still limited by the task-queue foundation.

### H5 MCP Gaps

- Lifecycle recovery and reconnect behavior need hardening.
- Resource subscription/list-change handling is missing.
- Roots and richer capability negotiation are incomplete.
- OAuth/auth flow beyond retryable auth-required results is not implemented.

### TUI Gaps

- Current TUI is still readline-level, with live audit-event output, compact transcript/status summaries, minimal session/model pickers, and interactive approval/question prompts.
- Missing full-screen transcript UI, streaming renderer, file mention picker, overlays, task list, memory viewer, richer hook status display, and a proper AskUserQuestion component beyond readline prompts.

### Sub-Agent Gaps

- Current task queue is a foundation only.
- Real sub-agent execution, coordinator mode, worktree isolation, background execution, result merge/review flow, and write-claim enforcement are still missing.

### Runner/Sandbox Gaps

- Rust runner exists, but process isolation and PTY behavior remain basic.
- Stronger process tree management, timeout behavior, patch approval, filesystem policy, and durable job execution are still needed.

### Control API/Web Panel Gaps

- Control API has useful CRUD/admin endpoints, real SSE event streaming, and approval/question response endpoints wired into running jobs.
- Missing richer web panel and mobile/control-client flows.

## Recommended Next Work

### H14-H16: Structured Output And More Useful Tools

- Add a structured-output result tool/contract for machine-readable agent outputs.
- Add high-value collaboration tools such as GitHub issue/PR read-only flows before mutation flows.
- Keep visible state on the durable audit-event path.

## Current Caveat

`/home/claude-user/magi-next` is currently not a Git repository, so `git status` and `git diff` cannot provide a source-control summary from inside this directory. Verification was done through project commands and scans instead.
