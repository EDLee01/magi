# Magi Next

A TypeScript-first AI coding agent for the terminal. Run a smart agent locally,
control it from your phone over the LAN, dispatch sub-agents to peer machines.

```
$ magi
  △   Magi · 60 tools
 /✦\  cwd: ~/code/my-project
▔▔▔   model: sonnet

  /help for commands · Ctrl+C to interrupt · /exit to quit

> refactor src/auth.ts to use the new session API
```

## Quick start

```sh
# Install (once)
npm install -g @magi/cli

# Set your provider key
export ANTHROPIC_AUTH_TOKEN="<your-key>"

# Configure (interactive)
magi init

# Use it
magi                            # Interactive TUI
magi -p "explain this repo"     # One-shot prompt
```

If you don't set a key first, `magi init` will tell you which env var to set
and bail out cleanly.

## What it does well

- **Real agent loop with parallel tool calls** — file ops, shell, git, web,
  MCP servers, sub-agents.
- **Smart routing** — `/model auto` picks haiku for simple questions,
  sonnet for code, opus for planning. Routes by 10 task kinds.
- **Plan mode** — `EnterPlanMode` for non-trivial work, ask for approval
  before implementing.
- **Cross-machine agents** — discover other Magi daemons via mDNS, dispatch
  sub-agents with `target: 'peer-name'`.
- **Mobile control** — start a daemon, scan a QR-able URL, run prompts from
  your phone.
- **Persistent memory** — durable facts written to `~/.magi-next/memdir/`
  auto-load into future sessions.
- **Skills** — bundled `verify` / `debug` / `stuck` / `commit-msg` /
  `review-pr`. Add your own by dropping a `SKILL.md` file.

## Five-minute tutorial

```sh
magi tutorial
```

Walks through 8 sections (basics, models, files, sessions, skills, memory,
multi-machine, sub-agents). Press `q` to quit early.

## Common commands

| Command                    | What it does                              |
|---------------------------|-------------------------------------------|
| `magi`                    | Start interactive TUI                     |
| `magi -p "<prompt>"`       | One-shot prompt, stream output            |
| `magi init`               | Interactive provider setup                |
| `magi doctor`             | Show config + paths                       |
| `magi sessions`           | List recent sessions                      |
| `magi resume <id>`        | Resume a session                          |
| `magi ps`                 | List recent jobs                          |
| `magi logs <job-id>`      | Show events for a job                     |
| `magi daemon start`       | Run control API in background             |
| `magi pair <name>`        | Generate a token for phone access         |
| `magi peers`              | Discover Magi daemons on the LAN          |
| `magi tutorial`           | Walkthrough                               |

Inside the TUI, type `/help` to list slash commands. Type `/help <name>` for
details on one.

## Configuration

`~/.magi-next/config.yaml`:

```yaml
providers:
  anthropic:
    type: messages-compatible
    format: anthropic-messages
    apiKeyEnv: ANTHROPIC_AUTH_TOKEN
    baseUrl: https://api.anthropic.com
    defaultModel: claude-sonnet-4-6
models:
  aliases:
    fast:   anthropic:claude-haiku-4-5
    main:   anthropic:claude-sonnet-4-6
    review: anthropic:claude-sonnet-4-6
    deep:   anthropic:claude-opus-4-7
  router:               # used when alias = "auto"
    fast:   { family: claude, role: haiku,  contextWindow: 200000, supportsVision: true }
    main:   { family: claude, role: sonnet, contextWindow: 200000, supportsVision: true }
    deep:   { family: claude, role: opus,   contextWindow: 200000, supportsVision: true }
```

Run `magi init` to generate a working config and skip the manual yaml.

## Cross-machine setup

```sh
# On each machine you want to use:
MAGI_CONTROL_BIND=0.0.0.0 magi daemon start

# On your "main" machine, see who's around:
magi peers

# Pair another machine (run on the peer to get a token):
magi pair from-peer
# → outputs a Device ID + Token

# On main, save the credentials:
magi peers add peer-2 http://192.168.1.50:8765 <device-id> <token>

# Now in the TUI, the agent can dispatch to peer-2:
> compare the auth modules in this repo and the one on peer-2
```

The agent uses the `Agent` tool with `target: "peer-2"` to dispatch
sub-agents. Multiple targets in the same response run in parallel.

## Phone access

```sh
magi pair my-phone
# → prints a URL like http://192.168.1.10:8765/panel?device=...&token=...
```

Open that URL on your phone. The web panel is mobile-optimized (touch UI,
swipeable session list, dark mode).

## Documentation

- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — common errors and fixes
- [ARCHITECTURE.md](ARCHITECTURE.md) — concepts and component map
- `magi tutorial` — interactive walkthrough

## State and isolation

Everything lives at `~/.magi-next/` by default:

```
~/.magi-next/
  config.yaml          # provider + model setup
  state/sessions.sqlite  # persisted sessions, jobs, audit, memory
  memdir/              # typed long-term memory (user/feedback/project/reference)
  skills/<name>/SKILL.md
  logs/                # daemon logs
  cache/
  plugins/
  devices/
```

Override the root with `MAGI_CONFIG_DIR=/path` for testing or sandboxing.

## Building from source

```sh
git clone <this-repo>
cd magi-next
npm install
npm run build
npm test
```

Requires Node ≥ 20.

## Status

Active development. The core (agent loop, routing, MCP, daemon, multi-machine,
mobile panel) is solid and tested. Beta-quality. We use it daily to build
itself.

Filing bugs: open a GitHub issue with output of `magi doctor` and `magi --version`.
