# Architecture

A short tour of how Magi Next is put together. Read this if you want to
extend it, write a custom tool, or understand a debug message.

## Components at a glance

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  TUI (readline) │ ─── │  HEADLESS RUNNER │ ─── │  PROVIDER ROUTE │ ─── (HTTP) ─── Anthropic / OpenAI / etc.
│   • slash cmds  │     │   • runs the     │     │  • alias resolve│
│   • streaming   │     │     agent loop   │     │  • fallback     │
└─────────────────┘     └────────┬─────────┘     └─────────────────┘
                                 │
                          ┌──────┴──────┐
                          │             │
                  ┌───────▼─────┐ ┌─────▼──────┐
                  │ AGENT LOOP  │ │ TOOL LAYER │
                  │ (query.ts)  │ │ ~60 tools  │
                  └─────────────┘ └────────────┘
                          │
              ┌───────────┼────────────┬────────────┐
              ▼           ▼            ▼            ▼
        ┌────────┐  ┌─────────┐  ┌──────────┐  ┌─────────┐
        │SESSION │  │  MEMDIR │  │   MCP    │  │  PEERS  │
        │ STORE  │  │ memory  │  │ servers  │  │ control │
        │(sqlite)│  │ files   │  │  (auth+  │  │ daemons │
        └────────┘  └─────────┘  │ resources│  └─────────┘
                                 │ /prompts)│
                                 └──────────┘
```

## Concepts

### Session

A single conversation. Persisted to `~/.magi-next/state/sessions.sqlite`.
Has a list of messages (user / assistant / tool). Sessions are durable;
restarting `magi` doesn't lose them. Identified by a UUID.

### Job

One end-to-end "model call + tool loop" within a session. When you submit a
prompt, a job is created. Audit events and usage tokens link back to jobs.
You can list with `magi ps` or `/tasks`.

### Provider, model, alias

- **Provider** is an API endpoint (anthropic, openai, deepseek). Configured
  in `providers:` of `config.yaml`.
- **Model** is the actual string the provider accepts (`claude-sonnet-4-6`).
- **Alias** is your name for it (`fast`, `main`, `deep`). Set in
  `models.aliases`.

The router resolves aliases to (provider, model). Aliases support fallback
chains. The special alias `auto` runs the smart-routing logic.

### Tool

Functions the model can call. Implemented in `src/tools/`. Each tool has:
- A JSON Schema for inputs (sent to the model)
- `isReadOnly` / `isDestructive` / `isConcurrencySafe` flags
- An optional `checkPermissions` for custom approval rules

The agent loop invokes tools in parallel when safe. Tool results become
`tool` messages in the conversation.

### Skill

A user- or bundled-defined workflow stored as
`~/.magi-next/skills/<name>/SKILL.md`. Invoked by the user typing
`/<name>` or by the model calling the `Skill` tool. The skill body is
injected as a prompt.

### Memdir

Long-term memory: typed markdown files at `~/.magi-next/memdir/<file>.md`.
Each has YAML frontmatter (`name`, `description`, `type`). Types: `user`,
`feedback`, `project`, `reference`. The agent loop searches memdir for
relevance on every turn and prepends the index + top matches to the
context.

### Peer

Another Magi daemon discoverable via mDNS or saved in the local
credentials store. Used as a `target` for the Agent tool to dispatch
sub-agents to.

## Key directories

| Path                            | What it holds                                |
|---------------------------------|----------------------------------------------|
| `src/agent/query.ts`            | Core agent loop (provider call + tool loop)  |
| `src/agent/query-engine.ts`     | Session-aware wrapper, hooks, memory         |
| `src/agent/system-prompt.ts`    | The base system prompt                       |
| `src/tools/registry.ts`         | All ~60 built-in tools                       |
| `src/tools/<name>.ts`           | Individual tool implementations              |
| `src/providers/`                | Anthropic / OpenAI / format-proxy adapters   |
| `src/routing/model-router.ts`   | Smart routing (10 task kinds, scoring)       |
| `src/control/`                  | Daemon, mDNS, pairing, peer client           |
| `src/commands/`                 | Slash commands (one file per command)        |
| `src/web/panel.ts`              | Mobile web panel HTML/JS                     |
| `src/session-store.ts`          | SQLite schema and CRUD                       |
| `src/memdir.ts`                 | Memdir read/write/index                      |
| `src/skills/`                   | Skill loader + bundled skills                |
| `src/mcp/`                      | MCP client, OAuth, transport                 |

## Data flow: a typical prompt

1. User types in TUI → `tui.ts:runInteractiveTerminal`
2. Submitted prompt → `runHeadlessPrompt` (`headless.ts`)
3. If `auto` model, `routeAuto` picks an alias → resolved to provider+model
4. `QueryEngine.submitMessage` builds the message context:
   - System prompt
   - Memdir index + relevant memories
   - Recent session messages (with auto-compaction)
5. Loop in `runAgentQuery`:
   a. Provider streams text + tool calls
   b. Tool calls dispatch through `executeRegisteredTools` (parallel where safe)
   c. Tool results become messages
   d. Repeat until model emits no tools
6. Final assistant message saved, audit + usage recorded

## Hooks

User-configurable shell commands or model calls that run on lifecycle
events: `pre_tool_use`, `post_tool_use`, `session_start`, `session_end`,
`subagent_start`, `subagent_stop`, `pre_compact`, `post_compact`,
`permission_request`, `permission_denied`, etc. See `src/config.ts`
`HookEvent` for the full list.

## Routing logic

`src/routing/model-router.ts`:
1. `classifyTask(prompt, context)` produces one of: quick / coding /
   reasoning / vision / long_context / review / planning / extraction /
   tool_heavy / agent.
2. `scoreCandidate(capabilities, kind)` adds points for family + role +
   context window matching the task.
3. Best score wins. Telemetry written to audit log.

Plan mode and high-token-context override the classification.

## Cross-machine dispatch

`Agent({ target: "peer-name" })`:
1. `resolvePeerByName` checks saved creds first, then mDNS.
2. `dispatchToPeer` (`peer-client.ts`) uses the control HTTP API:
   - `POST /sessions` to create
   - `POST /sessions/{id}/messages` to submit prompt
   - Poll `GET /jobs/{id}` until done
   - Fetch `GET /jobs/{id}/events`, aggregate `agent.text.delta`
3. Returns the assistant text to the parent agent loop.

Multiple `Agent` calls in the same response run in parallel because the
tool's `isConcurrencySafe` is `true`.

## Testing

```sh
npm test
```

~33 test files, ~390 tests. Vitest. No external services — all tests use
mocked fetches and temp directories.

## Build

```sh
npm run build       # tsc → dist/
```

ESM only. Node ≥ 20. Three runtime deps: `better-sqlite3`, `ws`, `yaml`.
