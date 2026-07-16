# Magi

[中文](README.zh-CN.md)

**Building the most flexible and extensible open-source AI agent.**

Magi is an open-source coding agent that runs in your terminal, and a deeply customizable agent runtime.

Unlike closed coding agents whose capabilities and execution model are largely fixed by the product, Magi lets developers compose their own models, tools, Skills, Harnesses, and Memory. Persistent sessions and multi-machine execution allow the same task to continue across a local computer, other machines on the LAN, and a phone browser used for approvals.

```text
$ magi
  △   Magi · 91 tools
 /✦\  cwd: ~/code/my-project
▔▔▔   model: main · claude-sonnet-4-6

  /help for commands · Ctrl+C to interrupt · /exit to quit

> refactor src/auth.ts to use the new session API
```

## Why Magi

Codex, Claude Code, and other coding agents can already understand repositories, edit files, run commands, and debug software.

For developers building on top of an agent, however, the important questions are often different:

- Can the model be replaced or routed by task?
- Can the toolset be reorganized?
- Can domain workflows be installed and reused?
- Can permissions and execution constraints be defined?
- Can knowledge persist across sessions?
- Can tasks be dispatched across machines?
- Can the same runtime support agents outside software development?

In closed coding-agent products, the underlying execution model, capability structure, and extension boundaries are primarily defined by the product itself.

Magi opens these layers so developers can do more than use an agent: they can recompose one.

## Positioning

Magi works out of the box as a terminal coding agent.

It is also a runtime for building, operating, and delivering other agents.

A research agent, teaching agent, data-analysis agent, or operations agent usually differs from a coding agent in more than its model. It may require different:

- Tools
- Workflows
- Permissions
- Completion criteria
- Long-term knowledge
- Model-routing policies
- Execution environments

Magi separates these concerns into components that can be replaced and combined without rebuilding session management, tool execution, memory, approvals, and task orchestration from scratch.

## A Composable Agent Runtime

### Model

Magi is not tied to a single model provider.

It supports:

- OpenAI
- Anthropic
- DeepSeek
- OpenAI-compatible endpoints
- Anthropic-compatible endpoints
- Custom endpoints

Models can be assigned to aliases such as:

- `fast`
- `main`
- `deep`

Inside the TUI, use:

```text
/model auto
```

to let the runtime route a task to an appropriate model.

Provider fallback can switch models when an endpoint is unavailable, rate-limited, or fails.

### Tool

Tools give an agent access to its environment.

Magi includes 91 built-in tools covering:

- Files
- Shell
- Git
- Web search
- URL fetching
- Scheduled tasks
- Session management
- Memory retrieval
- Sub-agents
- Multi-machine dispatch

The entire toolset is not loaded into every turn.

`ToolSearch` discovers and loads tools on demand, reducing context usage and avoiding a fixed, monolithic tool surface.

Developers can also add custom tools or connect MCP servers.

### Skill

A Skill packages a reusable workflow or domain procedure.

Unlike an individual tool, a Skill can define:

- The steps required to complete a task
- Which tools should be used
- How results should be verified
- How failures should be handled
- What conditions define completion

Bundled Skills include:

- `verify`
- `debug`
- `stuck`
- `commit-msg`
- `review-pr`

Install another Skill with:

```bash
magi skill install <github-repository>
```

Developers can author their own workflows in `SKILL.md`.

Skills can be installed, combined, and distributed independently of Magi Core.

### Harness

A Harness defines how an agent behaves and what it is allowed to do.

It can control:

- System instructions
- Tool permissions
- Approval rules
- Execution constraints
- Completion criteria
- Failure handling
- Capabilities available at each stage

The same runtime can load different Harnesses and behave as different agents.

A coding agent, research agent, and teaching agent can share the same runtime while using different tools, Skills, permissions, and operating rules.

### Memory

Magi Memory preserves information beyond the current context window.

The memory system includes:

- Durable Memory
- Session history
- Context recall
- LearningDrafts
- Human-reviewed persistence

After a task, Magi can generate a LearningDraft containing:

- Project conventions
- Previous decisions
- Failure causes
- Debugging lessons
- Reusable procedures

LearningDrafts do not automatically modify long-term memory. They can be reviewed before being applied.

```bash
magi memory search "<query>"
magi learning list
```

### Planning

Magi can separate planning from execution.

In Plan Mode, the agent can:

1. Analyze the task
2. Inspect relevant files
3. Define the scope of changes
4. Produce an implementation plan
5. Wait for approval
6. Begin execution

Risky edits and commands can remain blocked until the plan is approved.

Plan Mode is useful for:

- Large refactors
- API migrations
- Database migrations
- Cross-module changes
- Production-related operations

Inside the TUI:

```text
/plan
```

### Runtime

The runtime coordinates all of these components.

It handles:

- The agent loop
- Session state
- Streaming output
- Parallel tool calls
- Model routing
- Provider fallback
- Tool approvals
- Sub-agent orchestration
- Multi-machine dispatch
- State persistence

A new agent can reuse the runtime while replacing its Model, Tools, Skills, Harness, and Memory configuration.

## Default Form: A Terminal Coding Agent

Magi can be used directly for day-to-day development.

### Code Understanding and Editing

Magi can:

- Read and search a repository
- Modify one or many files
- Perform cross-file refactors
- Update types
- Fix bugs
- Write tests
- Explain unfamiliar code
- Generate commit messages

File changes are applied through `FilePatch`.

Patches use exact context matching instead of blindly overwriting whole files.

### Command Execution

Magi can run:

- Shell commands
- Git commands
- Tests
- Build commands
- Project scripts
- Custom tools

Sensitive operations can be restricted by approval policies.

### Research and Debugging

Magi can:

- Search the web
- Read webpages
- Fetch URLs
- Search the repository tree
- Inspect Git history
- Spawn sub-agents for parallel investigation

### Sessions

Magi stores session history in SQLite.

```bash
magi sessions
magi resume <id>
```

When the context becomes long, use:

```text
/compact
```

to compress the active context while preserving important task state.

## Multi-Machine Execution

Magi can discover other Magi instances on the LAN and dispatch tasks to them.

```bash
magi peers
```

An agent can target a remote node:

```json
{
  "target": "peer-name"
}
```

A single task can therefore continue across devices:

- Analyze code on a local machine
- Run tests on a build server
- Execute long-running work on another host
- Approve sensitive operations from a phone browser

Remote execution uses the same:

- Session model
- Permission model
- Approval mechanism
- Audit trail

## Mobile Approval and Control API

Start the background control service:

```bash
magi daemon start
```

Pair a phone or remote client:

```bash
magi pair <name>
```

The Control API can be used to:

- Approve tool calls from a phone
- Inspect task status
- Manage background jobs
- Access the active session
- Connect remote clients

Start a Magi daemon on each machine:

```bash
MAGI_CONTROL_BIND=0.0.0.0 magi daemon start
```

Pair a phone:

```bash
magi pair my-phone
```

Then:

1. Connect the phone and Magi host to the same LAN
2. Open the `/panel` URL shown in the terminal
3. Enter the Device ID and Token
4. Complete pairing

## What Can Be Built with Magi

The default distribution is a coding agent, but the runtime is not limited to software development.

By replacing and combining Tools, Skills, Harnesses, and Memory, developers can build:

- Research agents
- Teaching agents
- Data-analysis agents
- Operations agents
- Software-testing agents
- Internal automation systems
- Domain-specific workflow products

These agents can share the same underlying capabilities:

- Session management
- Tool execution
- Planning
- Permission approvals
- Long-term memory
- Model routing
- Multi-machine orchestration

The main differences live in the upper-layer composition rather than in a newly implemented runtime.

## Quick Start

### 1. Install

```bash
git clone https://github.com/EDLee01/magi.git
cd magi

npm install
npm run build
npm link
```

### 2. Configure an API Key

OpenAI:

```bash
export OPENAI_API_KEY="<your-key>"
```

Anthropic:

```bash
export ANTHROPIC_AUTH_TOKEN="<your-key>"
```

DeepSeek:

```bash
export DEEPSEEK_API_KEY="<your-key>"
```

### 3. Initialize

```bash
magi init
```

This creates:

```text
~/.magi-next/config.yaml
```

When an API key is missing, `magi init` identifies the environment variable required by the selected provider.

### 4. Run

```bash
magi
```

Run a one-shot task:

```bash
magi -p "explain this repo"
```

Start the interactive tutorial:

```bash
magi tutorial
```

The tutorial contains eight short sections covering models, files, memory, Skills, and multi-machine setup.

## Common Commands

| Command | Description |
|---|---|
| `magi` | Start the interactive TUI |
| `magi -p "<prompt>"` | Run a one-shot task |
| `magi init` | Configure providers and models |
| `magi doctor` | Inspect configuration and runtime health |
| `magi sessions` | Browse previous sessions |
| `magi resume <id>` | Resume a session |
| `magi daemon start` | Start the Control API |
| `magi pair <name>` | Pair a phone or remote client |
| `magi peers` | Discover Magi instances on the LAN |
| `magi memory search <query>` | Search Durable Memory |
| `magi learning list` | Review LearningDrafts |
| `magi skill install` | Install a Skill |
| `magi tutorial` | Start the guided tutorial |

Common TUI commands:

```text
/help
/model auto
/compact
/plan
```

## Configuration Example

The default configuration file is:

```text
~/.magi-next/config.yaml
```

Example:

```yaml
providers:
  anthropic:
    type: messages-compatible
    format: anthropic-messages
    apiKeyEnv: ANTHROPIC_AUTH_TOKEN
    baseUrl: https://api.anthropic.com

models:
  aliases:
    fast: anthropic:claude-haiku-4-5
    main: anthropic:claude-sonnet-4-6
    deep: anthropic:claude-opus-4-7

  router:
    fast:
      family: claude
      role: haiku
      contextWindow: 200000

    main:
      family: claude
      role: sonnet
      contextWindow: 200000

    deep:
      family: claude
      role: opus
      contextWindow: 200000
```

You can also run:

```bash
magi init
```

and use the setup wizard.

## Data Locations

```text
~/.magi-next/
  config.yaml
  state/
    sessions.sqlite
    learning-drafts/
  memory/
  skills/
```

`~/.magi-next/config.yaml`

Stores provider and model configuration.

`~/.magi-next/state/sessions.sqlite`

Stores sessions, tasks, background jobs, and audit records.

`~/.magi-next/memory/`

Stores Durable Memory.

`~/.magi-next/skills/`

Stores installed Skills.

`~/.magi-next/state/learning-drafts/`

Stores LearningDrafts awaiting review.

Override the configuration directory with:

```bash
export MAGI_CONFIG_DIR=/path/to/custom-directory
```

This is useful for sandboxes, tests, CI, and multi-instance deployments.

## Architecture Overview

```text
User
  │
  ▼
TUI / CLI / Control API
  │
  ▼
Agent Runtime
  ├── Model Router
  ├── Agent Loop
  ├── Plan Mode
  ├── Session Manager
  ├── Memory
  ├── ToolSearch
  ├── Skill Loader
  ├── Harness
  ├── Approval System
  └── Peer Dispatcher
        │
        ├── Local Tools
        ├── MCP Servers
        ├── Sub-agents
        └── Remote Magi Peers
```

The agent loop supports:

- Streaming output
- Parallel tool calls
- Provider fallback
- Sub-agent orchestration
- Tool-call approval
- Persistent session state

## Documentation

| Document | Contents |
|---|---|
| `ARCHITECTURE.md` | Components, sessions, tools, and model routing |
| `TROUBLESHOOTING.md` | Common errors and diagnostics |
| `docs/magi-next-learning-loop-v1.html` | Memory and Learning Loop design |
| `magi tutorial` | Interactive onboarding |

## Development and Testing

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Run the full verification suite:

```bash
npm run verify
```

Capability and regression scripts are defined in `package.json`, including:

```text
test:memory-eval
test:patch-eval
report:capability
```

These scripts cover:

- Memory
- FilePatch
- Agent Runtime
- Tool execution
- Capability regression

## Build Requirements

- Node.js ≥ 22
- Rust: optional

Rust is used by the runner sidecar for sandbox and PTY capabilities.

```bash
npm install
npm run build
npm test
```

## Status

Current version:

```text
v0.1.13
```

Magi is under active development.

Implemented and tested capabilities include:

- Agent loop
- Multi-model routing
- Provider fallback
- MCP
- ToolSearch
- Skills
- Memory
- Learning Loop
- Plan Mode
- Daemon
- Multi-machine dispatch
- Mobile control panel

The project is currently beta quality. CLI behavior, configuration formats, and some interfaces may change.

When reporting a bug, include the output of:

```bash
magi doctor
magi --version
```

## Open Source and Extension

Magi Core is released under the MIT License.

Developers can use Magi to:

- Implement new Tools
- Author new Skills
- Configure new Harnesses
- Connect new models
- Connect MCP servers
- Build domain-specific agents
- Build internal automation systems
- Develop independent products and services

Magi does not prescribe one fixed form of agent. It provides a runtime that can be recomposed.

## License

MIT License
