# Magi

[中文说明](README.zh-CN.md)

**The coding agent that lives in your terminal — and stays on your machine.**

Magi reads your repo, edits files, runs commands, searches the web, and picks up where you left off. One session can span your laptop, a machine on the LAN, and a phone browser for approvals. Your code stays local; you bring the model.

```
$ magi
  △   Magi · 91 tools
 /✦\  cwd: ~/code/my-project
▔▔▔   model: main · claude-sonnet-4-6

  /help for commands · Ctrl+C to interrupt · /exit to quit

> refactor src/auth.ts to use the new session API
```

---

## Why Magi

Most agents either live inside an IDE or disappear when you close a tab. Magi is built for developers who live in the shell and want an agent that behaves like infrastructure: persistent, scriptable, and under your control.

| | |
|---|---|
| **Edits that stick** | `FilePatch` applies diffs with exact context matching — multi-line changes land where you expect, not as blind overwrites. |
| **Memory that compounds** | Durable Memory, session recall, and reviewable LearningDrafts — Magi remembers conventions and past decisions instead of starting cold every time. |
| **Plan, then ship** | Plan mode blocks risky edits until you approve. Good for refactors, migrations, and anything you would not trust to YOLO mode. |
| **One fleet, one agent** | Discover Magi daemons on your LAN, dispatch sub-agents to peer machines, approve tool calls from your phone — same session model everywhere. |
| **Your models, your keys** | Anthropic, OpenAI, DeepSeek, or any compatible endpoint. Route `fast` / `main` / `deep` aliases, or let `/model auto` pick by task. |

---

## What you can do

**Day-to-day coding** — fix bugs, write tests, explain unfamiliar code, run the test suite, commit with a sensible message.

**Real refactors** — rename across files, migrate an API, update types; Plan mode keeps the agent from editing until the approach is clear.

**Research & debug** — web search, fetch URLs, grep the tree, inspect git history, spawn a background agent while you keep working.

**Team & multi-machine** — compare two repos on different hosts, run checks on a build machine, get push notifications-style approvals on mobile via the LAN panel.

**Extend it** — drop in MCP servers, install skills from GitHub, author your own `SKILL.md` workflows.

---

## Quick start

```sh
git clone https://github.com/EDLee01/magi.git
cd magi
npm install && npm run build && npm link

export OPENAI_API_KEY="<your-key>"
# or: export ANTHROPIC_AUTH_TOKEN="<your-key>"
# or: export DEEPSEEK_API_KEY="<your-key>"

magi init          # writes ~/.magi-next/config.yaml
magi               # interactive TUI
magi -p "explain this repo"   # one-shot
```

No key yet? `magi init` tells you exactly which env var to set.

**First run:** `magi tutorial` — eight short sections covering models, files, memory, skills, and multi-machine setup.

---

## Under the hood (the parts that matter)

**Agent loop** — parallel tool calls, streaming, provider fallback when a model is down or rate-limited.

**91 built-in tools** — files, shell, git, web, cron, sub-agents, and more. Heavy tools load on demand via `ToolSearch` so the first turn stays fast.

**Skills** — bundled workflows (`verify`, `debug`, `stuck`, `commit-msg`, `review-pr`). Install others with `magi skill install`.

**Sessions** — SQLite-backed history. `magi sessions`, `magi resume`, `/compact` when context gets long.

**Control API** — `magi daemon start` + `magi pair` exposes a LAN web panel for mobile approval and background jobs.

**Peers** — `magi peers` finds other Magi instances; the agent dispatches to them with `target: "peer-name"`.

---

## Common commands

| Command | What it does |
|---------|--------------|
| `magi` | Interactive TUI |
| `magi -p "<prompt>"` | One-shot prompt |
| `magi init` | Provider + model setup |
| `magi doctor` | Config paths and health check |
| `magi sessions` / `magi resume <id>` | Browse and continue past work |
| `magi daemon start` | Background control API |
| `magi pair <name>` | Pair a phone or remote client |
| `magi peers` | Discover LAN daemons |
| `magi memory search <q>` | Search durable Memory |
| `magi learning list` | Review post-task LearningDrafts |
| `magi tutorial` | Guided walkthrough |

Inside the TUI: `/help`, `/model auto`, `/compact`, `/plan`.

---

## Configuration sketch

`~/.magi-next/config.yaml` — or run `magi init` and skip the yaml.

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
    deep:  anthropic:claude-opus-4-7
  router:   # used when alias = "auto"
    fast:  { family: claude, role: haiku,  contextWindow: 200000 }
    main:  { family: claude, role: sonnet, contextWindow: 200000 }
    deep:  { family: claude, role: opus,   contextWindow: 200000 }
```

Supports OpenAI, Anthropic, and DeepSeek out of the box.

---

## Phone & multi-machine (30 seconds)

```sh
# On each machine:
MAGI_CONTROL_BIND=0.0.0.0 magi daemon start

# Pair your phone:
magi pair my-phone
# → open the /panel URL on the same Wi‑Fi, enter Device ID + Token

# See peers on the LAN:
magi peers
```

Sub-agents on remote machines run through the same session and approval model as local tools.

---

## Where things live

```
~/.magi-next/
  config.yaml              # providers + models
  state/sessions.sqlite    # sessions, jobs, audit trail
  memory/                  # durable Memory files
  skills/                  # installed skills
  state/learning-drafts/  # reviewable lessons (apply to persist)
```

Override with `MAGI_CONFIG_DIR` for sandboxes or CI.

---

## Docs & deeper dives

| Doc | Contents |
|-----|----------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, sessions, tools, routing |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common errors |
| [docs/magi-next-learning-loop-v1.html](docs/magi-next-learning-loop-v1.html) | Memory + Learning Loop design |
| `magi tutorial` | Interactive onboarding |

**Developers:** `npm test`, `npm run verify`, and capability eval scripts (`test:memory-eval`, `test:patch-eval`, `report:capability`, …) live in `package.json` for regression gates.

---

## Build requirements

Node **≥ 22**. Rust optional (runner sidecar for sandbox/PTY).

```sh
npm install && npm run build && npm test
```

---

## Status

**v0.1.13** — active development. Core agent loop, routing, MCP, daemon, multi-machine dispatch, and mobile panel are implemented and tested. Beta quality; CLI and config may still change.

Bug reports: include `magi doctor` and `magi --version` output.

MIT License.
